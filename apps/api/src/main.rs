mod config;
mod driver;
mod error;
mod handoff;
mod hosted;
mod oneclick;
mod ratelimit;
mod routes;
mod screening;
mod sign;
mod tokens;
mod wallet_worker;

use std::sync::Arc;

use config::Config;
use routes::AppState;
use tracing_subscriber::EnvFilter;

/// `unpair-api new-seed <file>`: write a fresh 24 word phrase for the hosted
/// wallet to `file`, readable by its owner only, and print the current
/// mainnet height to use as `UNPAIR_WALLET_BIRTHDAY`. The phrase is never
/// printed. Refuses to overwrite.
async fn new_seed(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let (phrase, _seed) = unpair_zcash::keys::Seed::generate();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o400);
    }
    let mut file = options.open(path)?;
    writeln!(file, "{phrase}")?;
    println!("wrote a new 24 word phrase to {path}, readable by its owner only");
    println!("back it up on paper now; everything the hosted wallet ever holds is under it");
    let pool = unpair_zcash::lightwalletd::Pool::new(
        unpair_zcash::lightwalletd::default_endpoints(unpair_zcash::Network::MainNetwork),
        unpair_zcash::lightwalletd::ClearnetConnector::default(),
    )?;
    match pool.checked_tip().await {
        Ok((tip, _)) => println!("UNPAIR_WALLET_BIRTHDAY={}", u32::from(tip)),
        Err(e) => println!(
            "could not read the mainnet height ({e}); set UNPAIR_WALLET_BIRTHDAY to today's height"
        ),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("new-seed") {
        let path = args.get(2).ok_or("usage: unpair-api new-seed <file>")?;
        return new_seed(path).await;
    }
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
                stand_in: tokio::sync::OnceCell::new(),
            })
        }
    };

    let cfg_limit = cfg.rate_limit_per_min;
    let state = Arc::new(AppState {
        bind: cfg.bind,
        config: cfg,
        screener,
        signer,
        oneclick,
        hosted,
        handoff: handoff::Handoff::default(),
        tokens: tokens::TokenCache::default(),
        limit: ratelimit::RateLimit::new(cfg_limit),
        started_at: std::time::Instant::now(),
    });

    if let Some(h) = state.hosted.as_ref() {
        driver::spawn(state.clone(), h.config.interval);
        // the estimate's stand-in landing, read while the worker is still idle
        let warm = state.clone();
        tokio::spawn(async move {
            if let Some(h) = warm.hosted.as_ref() {
                if let Err(e) = h.stand_in().await {
                    tracing::info!(error = %e, "stand-in landing not read yet");
                }
            }
        });
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
