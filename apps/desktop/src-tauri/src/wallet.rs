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
use unpair_zcash::wallet::{ShieldPolicy, ShieldWallet};
use zcash_protocol::consensus::{BlockHeight, Network};

#[derive(Clone, Serialize)]
pub struct LandingInfo {
    pub transparent: String,
    pub unified: String,
    pub index: u32,
}

#[derive(Clone, Serialize, Default)]
pub struct Report {
    /// Every landing address this wallet has ever issued.
    pub landings: Vec<String>,
    /// Shield transactions broadcast since the app started.
    pub shield_txids: Vec<String>,
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

enum Cmd {
    NextLanding(oneshot::Sender<Result<LandingInfo, String>>),
    Report(oneshot::Sender<Report>),
    SyncNow(oneshot::Sender<Report>),
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
    let mut txids: BTreeSet<String> = BTreeSet::new();
    let mut next_cycle = tokio::time::Instant::now();
    loop {
        let mut sync_requests: Vec<oneshot::Sender<Report>> = Vec::new();
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
                    fill(&mut report, slot.as_ref(), &txids);
                    let _ = reply.send(report.clone());
                }
                Cmd::SyncNow(reply) => sync_requests.push(reply),
            }
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
            fill(&mut report, slot.as_ref(), &txids);
            for reply in sync_requests {
                let _ = reply.send(report.clone());
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn fill(report: &mut Report, wallet: Option<&ShieldWallet>, txids: &BTreeSet<String>) {
    if let Some(wallet) = wallet {
        let net = wallet.network();
        report.landings = wallet
            .known_landings()
            .map(|v| v.iter().map(|a| encode_transparent(&net, a)).collect())
            .unwrap_or_default();
    }
    report.shield_txids = txids.iter().cloned().collect();
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
