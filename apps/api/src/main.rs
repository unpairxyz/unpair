mod config;
mod driver;
mod error;
mod handoff;
mod hosted;
mod oneclick;
mod routes;
mod screening;
mod sign;
mod wallet_worker;

use std::sync::Arc;

use config::Config;
use routes::AppState;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")),
        )
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = Config::from_env()?;
    let screener = screening::Screener::from_config(&cfg.screening)?;
    let signer = match cfg.signing_seed {
        Some(seed) => sign::QuoteSigner::from_seed(seed),
        None => {
            tracing::warn!(
                "UNPAIR_SIGNING_SEED not set; using a random signing key that changes on restart"
            );
            sign::QuoteSigner::random()
        }
    };
    tracing::info!(pubkey = %signer.public_key_hex(), "quote signing key");
    let oneclick = oneclick::OneClick::new(cfg.oneclick_url.clone(), cfg.oneclick_jwt.clone())?;

    let hosted = match &cfg.hosted {
        None => None,
        Some(h) => {
            let wallet = wallet_worker::start(h.clone())?;
            let store = hosted::Store::open(&h.data_dir.join("swaps.sqlite"))?;
            tracing::info!(
                max_zat = h.max_zat,
                max_open = h.max_open,
                "hosted swaps on"
            );
            Some(routes::Hosted {
                wallet,
                store,
                config: h.clone(),
            })
        }
    };

    let state = Arc::new(AppState {
        bind: cfg.bind,
        config: cfg,
        screener,
        signer,
        oneclick,
        hosted,
        handoff: handoff::Handoff::default(),
        started_at: std::time::Instant::now(),
    });

    if let Some(h) = state.hosted.as_ref() {
        driver::spawn(state.clone(), h.config.interval);
    }

    let app = routes::router(state.clone());
    let listener = tokio::net::TcpListener::bind(state.bind).await?;
    tracing::info!(addr = %state.bind, screening = state.screener.mode(), "unpair-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
