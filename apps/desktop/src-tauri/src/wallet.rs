//! The wallet runs on one dedicated thread with its own runtime, so the non-Send
//! wallet types never cross into Tauri's executor. Every `interval` it syncs,
//! shields whatever landed on the addresses it issued, and broadcasts.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;
use unpair_zcash::keys::{encode_transparent, Seed};
use unpair_zcash::lightwalletd::{default_endpoints, Connector, Pool};
use unpair_zcash::send::upgrade_notice;
use unpair_zcash::wallet::{warm_proving_key, Balance, ShieldPolicy, ShieldWallet};
use unpair_zcash::Zatoshis;
use zcash_protocol::consensus::{BlockHeight, Network};

#[derive(Clone, Serialize)]
pub struct LandingInfo {
    pub transparent: String,
    pub unified: String,
    pub index: u32,
}

#[derive(Clone, Serialize, Default)]
pub struct BalanceInfo {
    pub ironwood_spendable: u64,
    pub ironwood_total: u64,
    pub unshielded: u64,
    pub other_pools: u64,
}

impl From<Balance> for BalanceInfo {
    fn from(b: Balance) -> Self {
        Self {
            ironwood_spendable: b.ironwood_spendable,
            ironwood_total: b.ironwood_total,
            unshielded: b.unshielded,
            other_pools: b.orchard_total + b.sapling_total,
        }
    }
}

#[derive(Clone, Serialize, Default)]
pub struct ProvingInfo {
    pub ready: bool,
    pub build_secs: Option<f64>,
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
}

#[derive(Clone, Serialize, Default)]
pub struct Report {
    /// Every landing address this wallet has ever issued.
    pub landings: Vec<String>,
    /// Shield transactions broadcast since the app started.
    pub shield_txids: Vec<String>,
    /// Hop-two payouts broadcast since the app started.
    pub payout_txids: Vec<String>,
    pub balance: BalanceInfo,
    pub proving: ProvingInfo,
    pub upgrade: Option<UpgradeInfo>,
    pub synced_height: Option<u32>,
    pub last_error: Option<String>,
    pub cycles: u64,
    pub syncing: bool,
}

pub struct WalletConfig {
    pub phrase: String,
    pub data_dir: PathBuf,
    pub network: Network,
    pub birthday_height: Option<u32>,
    pub interval: Duration,
    pub lightwalletd: Vec<String>,
}

type PayRequest = (String, u64, oneshot::Sender<Result<PayoutInfo, String>>);

enum Cmd {
    NextLanding(oneshot::Sender<Result<LandingInfo, String>>),
    Report(oneshot::Sender<Report>),
    SyncNow(oneshot::Sender<Report>),
    Pay {
        to: String,
        amount: u64,
        reply: oneshot::Sender<Result<PayoutInfo, String>>,
    },
}

#[derive(Clone)]
pub struct WalletHandle {
    tx: mpsc::Sender<Cmd>,
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

    pub async fn report(&self) -> Result<Report, String> {
        self.ask(Cmd::Report).await
    }

    pub async fn sync_now(&self) -> Result<Report, String> {
        self.ask(Cmd::SyncNow).await
    }

    pub async fn pay(&self, to: String, amount: u64) -> Result<PayoutInfo, String> {
        self.ask(|reply| Cmd::Pay { to, amount, reply }).await?
    }
}

/// Start the wallet thread. Returns once the wallet is open, with the height it
/// starts from, or the reason it could not open.
pub fn start(cfg: WalletConfig) -> Result<(WalletHandle, u32), String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

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
                    Ok((wallet, pool, height)) => {
                        let _ = ready_tx.send(Ok(height));
                        run(wallet, &pool, cfg.interval, rx).await;
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            });
        })
        .map_err(|e| format!("spawn: {e}"))?;

    let height = ready_rx
        .recv()
        .map_err(|_| "wallet thread exited before it was ready".to_string())??;
    Ok((WalletHandle { tx }, height))
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

async fn open(cfg: &WalletConfig) -> Result<(ShieldWallet, Pool<impl Connector>, u32), String> {
    let seed = Seed::from_phrase(cfg.phrase.trim()).map_err(|e| e.to_string())?;
    let endpoints = if cfg.lightwalletd.is_empty() {
        default_endpoints(cfg.network)
    } else {
        cfg.lightwalletd.clone()
    };
    let pool = Pool::new(endpoints, connector(&cfg.data_dir).await?).map_err(|e| e.to_string())?;
    let (tip, _) = pool.checked_tip().await.map_err(|e| e.to_string())?;
    let birth = match cfg.birthday_height {
        Some(h) if BlockHeight::from(h) < tip => BlockHeight::from(h),
        _ => tip,
    };
    let birthday = pool.tree_state(birth).await.map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("data dir: {e}"))?;
    let db_path = cfg.data_dir.join(match cfg.network {
        Network::MainNetwork => "wallet-main.sqlite",
        Network::TestNetwork => "wallet-test.sqlite",
    });
    let wallet = ShieldWallet::open(
        cfg.network,
        &db_path,
        &seed,
        birthday,
        ShieldPolicy::default(),
    )
    .map_err(|e| e.to_string())?;
    tracing::info!(height = u32::from(birth), "wallet open");
    Ok((wallet, pool, u32::from(birth)))
}

async fn run<C: Connector>(
    wallet: ShieldWallet,
    pool: &Pool<C>,
    interval: Duration,
    rx: mpsc::Receiver<Cmd>,
) {
    let net = wallet.network();
    let mut slot = Some(wallet);
    let mut report = Report::default();
    // Build the Ironwood proving key once, off this runtime, so the first send
    // does not pay for it. About two seconds in a release build.
    let mut warm = Some(tokio::task::spawn_blocking(warm_proving_key));
    let mut txids: BTreeSet<String> = BTreeSet::new();
    let mut payouts: BTreeSet<String> = BTreeSet::new();
    let mut next_cycle = tokio::time::Instant::now();
    loop {
        if let Some(h) = warm.as_mut() {
            if h.is_finished() {
                let took = warm.take().expect("checked").await.ok();
                report.proving = ProvingInfo {
                    ready: took.is_some(),
                    build_secs: took.map(|d| d.as_secs_f64()),
                };
                if let Some(d) = took {
                    tracing::info!(secs = d.as_secs_f64(), "proving key ready");
                }
            }
        }
        let mut sync_requests: Vec<oneshot::Sender<Report>> = Vec::new();
        let mut pay_requests: Vec<PayRequest> = Vec::new();
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::NextLanding(reply) => {
                    let res = slot
                        .as_mut()
                        .ok_or_else(|| "wallet is busy".to_string())
                        .and_then(|w| w.next_landing().map_err(|e| e.to_string()));
                    let res = res.map(|l| LandingInfo {
                        transparent: l.transparent_string(&net),
                        unified: l.unified_string(&net),
                        index: u32::try_from(l.index).unwrap_or(u32::MAX),
                    });
                    let _ = reply.send(res);
                }
                Cmd::Report(reply) => {
                    fill(&mut report, slot.as_ref(), &txids, &payouts);
                    let _ = reply.send(report.clone());
                }
                Cmd::SyncNow(reply) => sync_requests.push(reply),
                Cmd::Pay { to, amount, reply } => pay_requests.push((to, amount, reply)),
            }
        }
        for (to, amount, reply) in pay_requests {
            let res = pay(&mut slot, pool, to, amount).await;
            if let Ok(p) = &res {
                payouts.insert(p.txid.clone());
            }
            let _ = reply.send(res);
        }
        if !sync_requests.is_empty() || tokio::time::Instant::now() >= next_cycle {
            report.cycles += 1;
            report.syncing = true;
            match cycle(&mut slot, pool).await {
                Ok((height, sent)) => {
                    report.synced_height = Some(height);
                    report.last_error = None;
                    txids.extend(sent);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "shield cycle failed");
                    report.last_error = Some(e);
                }
            }
            report.syncing = false;
            next_cycle = tokio::time::Instant::now() + interval;
            fill(&mut report, slot.as_ref(), &txids, &payouts);
            for reply in sync_requests {
                let _ = reply.send(report.clone());
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn fill(
    report: &mut Report,
    wallet: Option<&ShieldWallet>,
    txids: &BTreeSet<String>,
    payouts: &BTreeSet<String>,
) {
    if let Some(wallet) = wallet {
        let net = wallet.network();
        report.landings = wallet
            .known_landings()
            .map(|v| v.iter().map(|a| encode_transparent(&net, a)).collect())
            .unwrap_or_default();
        if let Ok(b) = wallet.balance() {
            report.balance = b.into();
        }
        report.upgrade = report.synced_height.and_then(|h| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            upgrade_notice(&net, BlockHeight::from(h), now).map(|u| UpgradeInfo {
                name: u.name,
                height: u.height,
                blocks_left: u.blocks_left,
                eta_unix: u.eta_unix,
                sending_paused: u.sending_paused,
            })
        });
    }
    report.shield_txids = txids.iter().cloned().collect();
    report.payout_txids = payouts.iter().cloned().collect();
}

/// Hop two: sync, build the Ironwood-only payment on a blocking thread, broadcast.
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
    pool.send_raw_transaction(payout.raw.clone())
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(txid = %payout.txid, "payout broadcast");
    Ok(PayoutInfo {
        txid: payout.txid.to_string(),
        fee: payout.fee.into_u64(),
    })
}

async fn cycle<C: Connector>(
    slot: &mut Option<ShieldWallet>,
    pool: &Pool<C>,
) -> Result<(u32, Vec<String>), String> {
    let wallet = slot.as_mut().ok_or("wallet is busy")?;
    let tip = wallet.sync(pool).await.map_err(|e| e.to_string())?;
    let from = wallet.known_landings().map_err(|e| e.to_string())?;
    if from.is_empty() {
        return Ok((u32::from(tip), vec![]));
    }
    // Proving takes seconds of CPU. It runs on a blocking thread so this
    // runtime keeps serving network streams, Tor circuits and commands.
    let mut w = slot.take().ok_or("wallet is busy")?;
    let (w, shielded) = tokio::task::spawn_blocking(move || {
        let r = w.shield(&from);
        (w, r)
    })
    .await
    .map_err(|e| format!("proving thread: {e}"))?;
    *slot = Some(w);
    match shielded {
        Ok(txs) => {
            let mut sent = Vec::new();
            for (txid, raw) in txs {
                pool.send_raw_transaction(raw)
                    .await
                    .map_err(|e| e.to_string())?;
                tracing::info!(%txid, "shield broadcast");
                sent.push(txid.to_string());
            }
            Ok((u32::from(tip), sent))
        }
        Err(unpair_zcash::Error::NothingToShield) => Ok((u32::from(tip), vec![])),
        Err(e) => Err(e.to_string()),
    }
}
