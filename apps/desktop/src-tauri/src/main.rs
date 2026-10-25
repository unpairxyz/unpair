//! The Unpair app. The key lives here, on the user's device, and nowhere else.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod settings;
mod wallet;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, State};
use tracing_subscriber::EnvFilter;
use unpair_zcash::keys::Seed;
use zcash_protocol::consensus::Network;

use settings::Settings;
use wallet::{LandingInfo, PayoutInfo, Report, WalletConfig, WalletHandle};

struct AppState {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    wallet: Mutex<Option<WalletHandle>>,
    open_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct Status {
    has_seed: bool,
    backed_up: bool,
    running: bool,
    network: String,
    birthday_height: Option<u32>,
    open_error: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn network_of(s: &Settings) -> Result<Network, String> {
    match s.network.as_str() {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => Err(format!("unknown network {other}")),
    }
}

fn status_of(state: &AppState) -> Result<Status, String> {
    let s = lock(&state.settings).clone();
    Ok(Status {
        has_seed: keychain::load_phrase()?.is_some(),
        backed_up: s.backed_up,
        running: lock(&state.wallet).is_some(),
        network: s.network,
        birthday_height: s.birthday_height,
        open_error: lock(&state.open_error).clone(),
    })
}

/// Open the wallet from the phrase in the keychain and start syncing.
async fn open_wallet(state: &AppState, phrase: String) -> Result<Status, String> {
    if lock(&state.wallet).is_some() {
        return status_of(state);
    }
    let s = lock(&state.settings).clone();
    let cfg = WalletConfig {
        phrase,
        data_dir: state.data_dir.clone(),
        network: network_of(&s)?,
        birthday_height: s.birthday_height,
        interval: Duration::from_secs(90),
        lightwalletd: std::env::var("UNPAIR_LIGHTWALLETD")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(|e| e.trim().to_string())
                    .filter(|e| !e.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
    };
    let started = tauri::async_runtime::spawn_blocking(move || wallet::start(cfg))
        .await
        .map_err(|e| format!("wallet task: {e}"))?;
    match started {
        Ok((handle, height)) => {
            *lock(&state.wallet) = Some(handle);
            *lock(&state.open_error) = None;
            let mut s = lock(&state.settings);
            if s.birthday_height.is_none() {
                s.birthday_height = Some(height);
                settings::save(&state.data_dir, &s)?;
            }
        }
        Err(e) => {
            *lock(&state.open_error) = Some(e.clone());
            return Err(e);
        }
    }
    status_of(state)
}

#[tauri::command]
fn wallet_status(state: State<'_, AppState>) -> Result<Status, String> {
    status_of(&state)
}

/// Start the wallet if a seed exists. Called once when the window opens.
#[tauri::command]
async fn wallet_open(state: State<'_, AppState>) -> Result<Status, String> {
    match keychain::load_phrase()? {
        Some(phrase) => open_wallet(&state, phrase).await,
        None => status_of(&state),
    }
}

#[derive(Serialize)]
struct Created {
    phrase: String,
}

/// Make a new seed on this device. Refuses if one already exists.
#[tauri::command]
async fn wallet_create(state: State<'_, AppState>) -> Result<Created, String> {
    if keychain::load_phrase()?.is_some() {
        return Err("this device already has a wallet".into());
    }
    let (phrase, _) = Seed::generate();
    keychain::store_phrase(&phrase)?;
    {
        let mut s = lock(&state.settings);
        s.backed_up = false;
        s.birthday_height = None;
        settings::save(&state.data_dir, &s)?;
    }
    open_wallet(&state, phrase.clone()).await?;
    Ok(Created { phrase })
}

/// Restore from a 24 word phrase. `birthday_height` bounds the rescan.
#[tauri::command]
async fn wallet_restore(
    state: State<'_, AppState>,
    phrase: String,
    birthday_height: Option<u32>,
) -> Result<Status, String> {
    if keychain::load_phrase()?.is_some() {
        return Err("this device already has a wallet".into());
    }
    let phrase = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    Seed::from_phrase(&phrase).map_err(|e| e.to_string())?;
    keychain::store_phrase(&phrase)?;
    {
        let mut s = lock(&state.settings);
        s.backed_up = true;
        s.birthday_height = birthday_height;
        settings::save(&state.data_dir, &s)?;
    }
    open_wallet(&state, phrase).await
}

#[tauri::command]
fn wallet_reveal_phrase() -> Result<String, String> {
    keychain::load_phrase()?.ok_or_else(|| "no wallet on this device".into())
}

#[tauri::command]
fn wallet_confirm_backup(state: State<'_, AppState>) -> Result<Status, String> {
    {
        let mut s = lock(&state.settings);
        s.backed_up = true;
        settings::save(&state.data_dir, &s)?;
    }
    status_of(&state)
}

fn handle(state: &AppState) -> Result<WalletHandle, String> {
    lock(&state.wallet)
        .clone()
        .ok_or_else(|| "the wallet is not open".to_string())
}

/// A fresh landing address. Refused until the phrase is backed up, because a
/// swap into ZEC makes this app the user's wallet.
#[tauri::command]
async fn wallet_next_landing(state: State<'_, AppState>) -> Result<LandingInfo, String> {
    if !lock(&state.settings).backed_up {
        return Err("write down the recovery phrase before receiving ZEC".into());
    }
    handle(&state)?.next_landing().await
}

#[tauri::command]
async fn wallet_report(state: State<'_, AppState>) -> Result<Report, String> {
    handle(&state)?.report().await
}

#[tauri::command]
async fn wallet_sync_now(state: State<'_, AppState>) -> Result<Report, String> {
    handle(&state)?.sync_now().await
}

/// Hop two. Pay `amount_zats` from this wallet's Ironwood notes to a transparent
/// address, normally a route's deposit address. The fee is the ZIP 317 fee.
#[tauri::command]
async fn wallet_pay(
    state: State<'_, AppState>,
    to: String,
    amount_zats: u64,
) -> Result<PayoutInfo, String> {
    handle(&state)?.pay(to, amount_zats).await
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    // One TLS crypto provider for the whole process, before any connection.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let settings = settings::load(&data_dir)?;
            app.manage(AppState {
                data_dir,
                settings: Mutex::new(settings),
                wallet: Mutex::new(None),
                open_error: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            wallet_status,
            wallet_open,
            wallet_create,
            wallet_restore,
            wallet_reveal_phrase,
            wallet_confirm_backup,
            wallet_next_landing,
            wallet_report,
            wallet_sync_now,
            wallet_pay,
        ])
        .run(tauri::generate_context!())
        .expect("unpair-desktop failed to start");
}
