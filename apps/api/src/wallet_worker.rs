//! Self-host shielding worker.
//!
//! Only runs when the operator gives this server a seed. The wallet lives on
//! one dedicated thread with its own runtime, so the non-Send wallet types never
//! cross into the axum executor. Every `interval` it syncs, shields whatever
//! landed on the addresses it issued, and broadcasts. The hosted unpair.xyz
//! instance runs without this; users bring their own shielding wallet.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;
use unpair_zcash::keys::Seed;
use unpair_zcash::lightwalletd::{default_endpoints, ClearnetConnector, Pool};
use unpair_zcash::wallet::{ShieldPolicy, ShieldWallet};
use zcash_protocol::consensus::Network;

use crate::config::{WalletConfig, WalletNetwork};
use crate::error::ApiError;

#[derive(Clone, Serialize)]
pub struct LandingInfo {
    pub transparent: String,
    pub unified: String,
    pub index: u32,
}

#[derive(Clone, Serialize, Default)]
pub struct Report {
    pub issued: Vec<LandingInfo>,
    pub shield_txids: Vec<String>,
    pub last_sync_height: Option<u32>,
    pub last_error: Option<String>,
    pub cycles: u64,
}

enum Cmd {
    NextLanding(oneshot::Sender<Result<LandingInfo, String>>),
    Report(oneshot::Sender<Report>),
}

#[derive(Clone)]
pub struct WalletHandle {
    tx: mpsc::Sender<Cmd>,
}

impl WalletHandle {
    pub async fn next_landing(&self) -> Result<LandingInfo, ApiError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Cmd::NextLanding(tx))
            .map_err(|_| ApiError::Internal("wallet thread is gone".into()))?;
        rx.await
            .map_err(|_| ApiError::Internal("wallet thread dropped the request".into()))?
            .map_err(ApiError::Internal)
    }

    pub async fn report(&self) -> Result<Report, ApiError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Report(tx))
            .map_err(|_| ApiError::Internal("wallet thread is gone".into()))?;
        rx.await
            .map_err(|_| ApiError::Internal("wallet thread dropped the request".into()))
    }
}

fn network(n: WalletNetwork) -> Network {
    match n {
        WalletNetwork::Main => Network::MainNetwork,
        WalletNetwork::Test => Network::TestNetwork,
    }
}

/// Start the worker thread. Returns once the wallet is open and synced to the tip
/// or fails with the reason.
pub fn start(cfg: WalletConfig) -> Result<WalletHandle, String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

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
                    Ok((mut wallet, pool)) => {
                        let _ = ready_tx.send(Ok(()));
                        run(&mut wallet, &pool, cfg.interval, rx).await;
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            });
        })
        .map_err(|e| format!("spawn: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "wallet thread exited before it was ready".to_string())??;
    Ok(WalletHandle { tx })
}

async fn open(cfg: &WalletConfig) -> Result<(ShieldWallet, Pool<ClearnetConnector>), String> {
    let net = network(cfg.network);
    let phrase =
        std::fs::read_to_string(&cfg.seed_file).map_err(|e| format!("read seed file: {e}"))?;
    let seed = Seed::from_phrase(phrase.trim()).map_err(|e| e.to_string())?;
    let endpoints = if cfg.lightwalletd.is_empty() {
        default_endpoints(net)
    } else {
        cfg.lightwalletd.clone()
    };
    let pool = Pool::new(endpoints, ClearnetConnector::default()).map_err(|e| e.to_string())?;
    let (tip, _) = pool.checked_tip().await.map_err(|e| e.to_string())?;
    let birthday = pool.tree_state(tip).await.map_err(|e| e.to_string())?;
    let mut wallet =
        ShieldWallet::open(net, &cfg.db_path, &seed, birthday, ShieldPolicy::default())
            .map_err(|e| e.to_string())?;
    if let Some(dir) = &cfg.params_dir {
        wallet = wallet.with_params_dir(dir.clone());
    }
    tracing::info!(height = u32::from(tip), "wallet open");
    Ok((wallet, pool))
}

async fn run(
    wallet: &mut ShieldWallet,
    pool: &Pool<ClearnetConnector>,
    interval: Duration,
    rx: mpsc::Receiver<Cmd>,
) {
    let net = wallet.network();
    let mut report = Report::default();
    let mut issued: BTreeMap<u32, LandingInfo> = BTreeMap::new();
    let mut next_cycle = tokio::time::Instant::now();
    loop {
        // Serve commands until the next cycle is due.
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::NextLanding(reply) => {
                    let res = wallet.next_landing().map(|l| {
                        let info = LandingInfo {
                            transparent: l.transparent_string(&net),
                            unified: l.unified_string(&net),
                            index: index_u32(&l.index),
                        };
                        issued.insert(info.index, info.clone());
                        info
                    });
                    let _ = reply.send(res.map_err(|e| e.to_string()));
                }
                Cmd::Report(reply) => {
                    report.issued = issued.values().cloned().collect();
                    let _ = reply.send(report.clone());
                }
            }
        }
        if tokio::time::Instant::now() >= next_cycle {
            report.cycles += 1;
            match cycle(wallet, pool).await {
                Ok((height, txids)) => {
                    report.last_sync_height = Some(height);
                    report.last_error = None;
                    report.shield_txids.extend(txids);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "shield cycle failed");
                    report.last_error = Some(e);
                }
            }
            next_cycle = tokio::time::Instant::now() + interval;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn cycle(
    wallet: &mut ShieldWallet,
    pool: &Pool<ClearnetConnector>,
) -> Result<(u32, Vec<String>), String> {
    let tip = wallet.sync(pool).await.map_err(|e| e.to_string())?;
    let from = wallet.known_landings().map_err(|e| e.to_string())?;
    if from.is_empty() {
        return Ok((u32::from(tip), vec![]));
    }
    match wallet.shield(&from) {
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

fn index_u32(j: &zip32::DiversifierIndex) -> u32 {
    u32::try_from(*j).unwrap_or(u32::MAX)
}
