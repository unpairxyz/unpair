//! The transit wallet for hosted swaps.
//!
//! Runs only when the operator gives this server a seed. The wallet lives on
//! one dedicated thread with its own runtime. Every `interval` it syncs and
//! shields anything that landed on a transparent address it issued (refunds
//! of a failed second hop come back that way). Payouts for the second hop
//! are built on request, on a blocking thread, so proving never stalls the
//! network streams.

use std::collections::{BTreeSet, VecDeque};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;
use unpair_zcash::keys::{landing_at_exact, orchard_only_at, Landing, Seed, UnifiedFullViewingKey};
use unpair_zcash::lightwalletd::{default_endpoints, Connector, Pool};
use unpair_zcash::send::upgrade_notice;
use unpair_zcash::wallet::{warm_proving_key, Balance, ShieldPolicy, ShieldWallet};
use unpair_zcash::Zatoshis;
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::config::{HostedConfig, WalletNetwork};

/// A fresh landing for one swap.
#[derive(Clone, Serialize)]
pub struct LandingInfo {
    /// Orchard-only unified address. A route that pays Ironwood directly pays
    /// this and the value lands shielded with no transparent step.
    pub shielded: String,
    /// Transparent receiver at the same index. Used as the refund address of
    /// the second hop; the shield cycle sweeps it back into Ironwood.
    pub transparent: String,
    pub index: u32,
}

#[derive(Clone, Serialize, Default)]
pub struct BalanceInfo {
    pub ironwood_spendable: u64,
    pub ironwood_notes: u64,
    pub ironwood_total: u64,
    pub unshielded: u64,
    pub other_pools: u64,
}

impl From<Balance> for BalanceInfo {
    fn from(b: Balance) -> Self {
        Self {
            ironwood_spendable: b.ironwood_spendable,
            ironwood_notes: b.ironwood_notes,
            ironwood_total: b.ironwood_total,
            unshielded: b.unshielded,
            other_pools: b.orchard_total + b.sapling_total,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct UpgradeInfo {
    pub name: &'static str,
    pub height: u32,
    pub blocks_left: u32,
    pub eta_unix: u64,
    pub sending_paused: bool,
}

#[derive(Clone, Serialize)]
pub struct PayoutInfo {
    pub txid: String,
    pub fee: u64,
    /// Set when the transaction was built and stored but the broadcast call
    /// failed. It may still be on the chain; the driver keeps the txid.
    pub broadcast_error: Option<String>,
}

/// Operator view. No addresses, no swap data.
#[derive(Clone, Serialize, Default)]
pub struct Report {
    pub balance: BalanceInfo,
    pub proving_ready: bool,
    pub upgrade: Option<UpgradeInfo>,
    pub synced_height: Option<u32>,
    pub shield_txids: Vec<String>,
    pub payout_txids: Vec<String>,
    pub last_error: Option<String>,
    pub cycles: u64,
}

type PayRequest = (String, u64, oneshot::Sender<Result<PayoutInfo, String>>);

enum Cmd {
    NextLanding(oneshot::Sender<Result<LandingInfo, String>>),
    Report(oneshot::Sender<Report>),
    Pay {
        to: String,
        amount: u64,
        reply: oneshot::Sender<Result<PayoutInfo, String>>,
    },
}

/// Landings the worker derives ahead while it is idle, so a new swap takes
/// one at once instead of waiting behind a scan or a proof.
const PREPARED_LANDINGS: usize = 3;

#[derive(Clone)]
pub struct WalletHandle {
    tx: mpsc::Sender<Cmd>,
    /// The viewing key: an address at a known index is derived here, with
    /// no round trip to the worker.
    ufvk: UnifiedFullViewingKey,
    net: Network,
    prepared: Arc<Mutex<VecDeque<LandingInfo>>>,
}

impl WalletHandle {
    async fn ask<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(make(tx))
            .map_err(|_| "wallet thread is gone".to_string())?;
        rx.await
            .map_err(|_| "wallet thread dropped the request".to_string())
    }

    pub async fn next_landing(&self) -> Result<LandingInfo, String> {
        self.ask(Cmd::NextLanding).await?
    }

    /// The landing at `index`: one handed out before for a swap that never
    /// got its deposit, or the stand-in of a dry estimate. Derived from the
    /// viewing key right here, so it never waits for the worker.
    pub fn landing_at(&self, index: u32) -> Result<LandingInfo, String> {
        let l = landing_at_exact(&self.ufvk, index).map_err(|e| e.to_string())?;
        landing_info(&self.ufvk, l, &self.net)
    }

    /// A fresh landing the worker prepared ahead, if one is waiting.
    pub fn take_prepared(&self) -> Option<LandingInfo> {
        self.prepared.lock().ok()?.pop_front()
    }

    pub async fn report(&self) -> Result<Report, String> {
        self.ask(Cmd::Report).await
    }

    /// Hop two: pay `amount` zatoshis to the transparent address `to` from
    /// Ironwood notes only, and broadcast.
    pub async fn pay(&self, to: String, amount: u64) -> Result<PayoutInfo, String> {
        self.ask(|reply| Cmd::Pay { to, amount, reply }).await?
    }
}

fn network(n: WalletNetwork) -> Network {
    match n {
        WalletNetwork::Main => Network::MainNetwork,
        WalletNetwork::Test => Network::TestNetwork,
    }
}

/// Start the wallet thread. Returns once the wallet is open, or the reason it
/// could not open.
pub fn start(cfg: HostedConfig) -> Result<WalletHandle, String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(UnifiedFullViewingKey, Network), String>>();
    let prepared: Arc<Mutex<VecDeque<LandingInfo>>> = Arc::new(Mutex::new(VecDeque::new()));
    let queue = prepared.clone();

    std::thread::Builder::new()
        .name("unpair-wallet".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("runtime: {e}")));
                    return;
                }
            };
            rt.block_on(async move {
                match open(&cfg).await {
                    Ok((wallet, pool)) => {
                        let _ = ready_tx.send(Ok((wallet.ufvk().clone(), wallet.network())));
                        run(wallet, &pool, cfg.interval, rx, queue).await;
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            });
        })
        .map_err(|e| format!("spawn: {e}"))?;

    let (ufvk, net) = ready_rx
        .recv()
        .map_err(|_| "wallet thread exited before it was ready".to_string())??;
    Ok(WalletHandle {
        tx,
        ufvk,
        net,
        prepared,
    })
}

#[cfg(not(feature = "tor"))]
async fn connector(_data_dir: &std::path::Path) -> Result<impl Connector, String> {
    Ok(unpair_zcash::lightwalletd::ClearnetConnector::default())
}

#[cfg(feature = "tor")]
async fn connector(data_dir: &std::path::Path) -> Result<impl Connector, String> {
    let dir = data_dir.join("tor");
    std::fs::create_dir_all(&dir).map_err(|e| format!("tor dir: {e}"))?;
    unpair_zcash::tor::TorLightwalletd::new(&dir)
        .await
        .map_err(|e| e.to_string())
}

async fn open(cfg: &HostedConfig) -> Result<(ShieldWallet, Pool<impl Connector>), String> {
    let net = network(cfg.network);
    let phrase =
        std::fs::read_to_string(&cfg.seed_file).map_err(|e| format!("read seed file: {e}"))?;
    let seed = Seed::from_phrase(phrase.trim()).map_err(|e| e.to_string())?;
    let endpoints = if cfg.lightwalletd.is_empty() {
        default_endpoints(net)
    } else {
        cfg.lightwalletd.clone()
    };
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("data dir: {e}"))?;
    let pool = Pool::new(endpoints, connector(&cfg.data_dir).await?).map_err(|e| e.to_string())?;
    let (tip, _) = pool.checked_tip().await.map_err(|e| e.to_string())?;
    let birth = match cfg.birthday_height {
        Some(h) if BlockHeight::from(h) < tip => BlockHeight::from(h),
        _ => tip,
    };
    let birthday = pool.tree_state(birth).await.map_err(|e| e.to_string())?;
    let db_path = cfg.data_dir.join(match cfg.network {
        WalletNetwork::Main => "wallet-main.sqlite",
        WalletNetwork::Test => "wallet-test.sqlite",
    });
    let wallet = ShieldWallet::open(net, &db_path, &seed, birthday, ShieldPolicy::default())
        .map_err(|e| e.to_string())?;
    tracing::info!(height = u32::from(birth), "transit wallet open");
    Ok((wallet, pool))
}

async fn run<C: Connector>(
    wallet: ShieldWallet,
    pool: &Pool<C>,
    interval: Duration,
    rx: mpsc::Receiver<Cmd>,
    prepared: Arc<Mutex<VecDeque<LandingInfo>>>,
) {
    let net = wallet.network();
    let mut slot = Some(wallet);
    let mut report = Report::default();
    let mut warm = Some(tokio::task::spawn_blocking(warm_proving_key));
    let mut shields: BTreeSet<String> = BTreeSet::new();
    let mut payouts: BTreeSet<String> = BTreeSet::new();
    let mut next_cycle = tokio::time::Instant::now();
    loop {
        if let Some(h) = warm.as_mut() {
            if h.is_finished() {
                let took = warm.take().expect("checked").await.ok();
                report.proving_ready = took.is_some();
                if let Some(d) = took {
                    tracing::info!(secs = d.as_secs_f64(), "proving key ready");
                }
            }
        }
        let mut pay_requests: Vec<PayRequest> = Vec::new();
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::NextLanding(reply) => {
                    let _ = reply.send(next_landing(slot.as_mut(), &net));
                }
                Cmd::Report(reply) => {
                    fill(&mut report, slot.as_ref(), &shields, &payouts);
                    let _ = reply.send(report.clone());
                }
                Cmd::Pay { to, amount, reply } => pay_requests.push((to, amount, reply)),
            }
        }
        // landings ahead, while nothing else is running
        loop {
            let short = prepared
                .lock()
                .map(|q| q.len() < PREPARED_LANDINGS)
                .unwrap_or(false);
            if !short {
                break;
            }
            match next_landing(slot.as_mut(), &net) {
                Ok(l) => {
                    if let Ok(mut q) = prepared.lock() {
                        q.push_back(l);
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "could not prepare a landing");
                    break;
                }
            }
        }
        for (to, amount, reply) in pay_requests {
            let res = pay(&mut slot, pool, to, amount).await;
            if let Ok(p) = &res {
                payouts.insert(p.txid.clone());
            }
            let _ = reply.send(res);
        }
        if tokio::time::Instant::now() >= next_cycle {
            report.cycles += 1;
            match cycle(&mut slot, pool).await {
                Ok((height, Ok(sent))) => {
                    report.synced_height = Some(height);
                    report.last_error = None;
                    shields.extend(sent);
                }
                Ok((height, Err(e))) => {
                    report.synced_height = Some(height);
                    tracing::warn!(error = %e, "shield step failed");
                    report.last_error = Some(e);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "sync failed");
                    report.last_error = Some(e);
                }
            }
            next_cycle = tokio::time::Instant::now() + interval;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn next_landing(wallet: Option<&mut ShieldWallet>, net: &Network) -> Result<LandingInfo, String> {
    let w = wallet.ok_or_else(|| "wallet is busy".to_string())?;
    let l = w.next_landing().map_err(|e| e.to_string())?;
    landing_info(w.ufvk(), l, net)
}

fn landing_info(
    ufvk: &UnifiedFullViewingKey,
    l: Landing,
    net: &Network,
) -> Result<LandingInfo, String> {
    let (shielded, index) = orchard_only_at(ufvk, l.index).map_err(|e| e.to_string())?;
    if index != l.index {
        return Err("shielded and transparent receivers are at different indexes".into());
    }
    Ok(LandingInfo {
        shielded: shielded.encode(net),
        transparent: l.transparent_string(net),
        index: u32::try_from(l.index).unwrap_or(u32::MAX),
    })
}

fn fill(
    report: &mut Report,
    wallet: Option<&ShieldWallet>,
    shields: &BTreeSet<String>,
    payouts: &BTreeSet<String>,
) {
    if let Some(wallet) = wallet {
        let net = wallet.network();
        if let Ok(b) = wallet.balance() {
            report.balance = b.into();
        }
        report.upgrade = report.synced_height.and_then(|h| {
            upgrade_notice(&net, BlockHeight::from(h), now_unix()).map(|u| UpgradeInfo {
                name: u.name,
                height: u.height,
                blocks_left: u.blocks_left,
                eta_unix: u.eta_unix,
                sending_paused: u.sending_paused,
            })
        });
    }
    report.shield_txids = shields.iter().cloned().collect();
    report.payout_txids = payouts.iter().cloned().collect();
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn pay<C: Connector>(
    slot: &mut Option<ShieldWallet>,
    pool: &Pool<C>,
    to: String,
    amount: u64,
) -> Result<PayoutInfo, String> {
    let amount = Zatoshis::from_u64(amount).map_err(|_| "amount out of range".to_string())?;
    {
        let wallet = slot.as_mut().ok_or("wallet is busy")?;
        wallet.sync(pool).await.map_err(|e| e.to_string())?;
    }
    let mut w = slot.take().ok_or("wallet is busy")?;
    let (w, built) = tokio::task::spawn_blocking(move || {
        let r = w.pay_transparent(&to, amount);
        (w, r)
    })
    .await
    .map_err(|e| format!("proving thread: {e}"))?;
    *slot = Some(w);
    let payout = built.map_err(|e| e.to_string())?;
    // The transaction is built and stored at this point. A failed broadcast
    // keeps the txid: the node may have taken it before the reply was lost.
    let broadcast_error = match pool.send_raw_transaction(payout.raw.clone()).await {
        Ok(_) => {
            tracing::info!(txid = %payout.txid, "payout broadcast");
            None
        }
        Err(e) => {
            tracing::warn!(txid = %payout.txid, error = %e, "payout built, broadcast failed");
            Some(e.to_string())
        }
    };
    Ok(PayoutInfo {
        txid: payout.txid.to_string(),
        fee: payout.fee.into_u64(),
        broadcast_error,
    })
}

/// Sync, then shield whatever landed on transparent receivers. The outer
/// error is a sync failure; the inner one a shield failure after a good sync.
async fn cycle<C: Connector>(
    slot: &mut Option<ShieldWallet>,
    pool: &Pool<C>,
) -> Result<(u32, Result<Vec<String>, String>), String> {
    let wallet = slot.as_mut().ok_or("wallet is busy")?;
    let tip = u32::from(wallet.sync(pool).await.map_err(|e| e.to_string())?);
    let from = wallet.known_landings().map_err(|e| e.to_string())?;
    if from.is_empty() {
        return Ok((tip, Ok(vec![])));
    }
    let mut w = slot.take().ok_or("wallet is busy")?;
    let (w, shielded) = tokio::task::spawn_blocking(move || {
        let r = w.shield(&from);
        (w, r)
    })
    .await
    .map_err(|e| format!("proving thread: {e}"))?;
    *slot = Some(w);
    let txs = match shielded {
        Ok(txs) => txs,
        Err(unpair_zcash::Error::NothingToShield) => return Ok((tip, Ok(vec![]))),
        // A wallet with nothing scanned yet cannot select inputs. There is
        // nothing to shield until a block has been scanned.
        Err(unpair_zcash::Error::Shield(t))
            if t.contains("ScanRequired") || t.contains("SyncRequired") =>
        {
            return Ok((tip, Ok(vec![])))
        }
        Err(e) => return Ok((tip, Err(e.to_string()))),
    };
    let mut sent = Vec::new();
    for (txid, raw) in txs {
        if let Err(e) = pool.send_raw_transaction(raw).await {
            return Ok((tip, Err(e.to_string())));
        }
        tracing::info!(%txid, "shield broadcast");
        sent.push(txid.to_string());
    }
    Ok((tip, Ok(sent)))
}
