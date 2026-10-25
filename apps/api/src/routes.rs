//! HTTP routes.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::error::ApiError;
use crate::oneclick::{addresses_to_screen, AppFee, OneClick};
use crate::screening::{geofence, Screener, Verdict};
use crate::sign::QuoteSigner;

pub struct AppState {
    pub bind: std::net::SocketAddr,
    pub config: Config,
    pub screener: Screener,
    pub signer: QuoteSigner,
    pub oneclick: OneClick,
    pub started_at: std::time::Instant,
}

pub type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Router::new()
        .route("/health", get(health))
        .route("/v1/config", get(config))
        .route("/v1/pubkey", get(pubkey))
        .route("/v1/screen", post(screen))
        .route("/v1/quote", post(quote))
        .route("/v1/status/{deposit_address}", get(status))
        .layer(cors)
        .layer(RequestBodyLimitLayer::new(32 * 1024))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(45),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    uptime_secs: u64,
}

async fn health(State(s): State<Shared>) -> Json<Health> {
    Json(Health {
        ok: true,
        uptime_secs: s.started_at.elapsed().as_secs(),
    })
}

#[derive(Serialize)]
struct PublicConfig {
    fee_recipient: String,
    fee_bps: u32,
    fee_cap_bps: u32,
    screening: &'static str,
    geofence: Vec<String>,
    quote_signing_pubkey: String,
    oneclick_keyed: bool,
    modes: [&'static str; 2],
}

async fn config(State(s): State<Shared>) -> Json<PublicConfig> {
    let c = &s.config;
    Json(PublicConfig {
        fee_recipient: c.fee_recipient.clone(),
        fee_bps: c.fee_bps,
        fee_cap_bps: crate::config::FEE_CAP_BPS,
        screening: s.screener.mode(),
        geofence: c.geofence.blocked_countries.clone(),
        quote_signing_pubkey: s.signer.public_key_hex(),
        oneclick_keyed: s.oneclick.has_key(),
        modes: ["fast", "quiet"],
    })
}

#[derive(Serialize)]
struct Pubkey {
    algorithm: &'static str,
    public_key_hex: String,
}

async fn pubkey(State(s): State<Shared>) -> Json<Pubkey> {
    Json(Pubkey {
        algorithm: "ed25519",
        public_key_hex: s.signer.public_key_hex(),
    })
}

#[derive(Deserialize)]
pub struct ScreenRequest {
    pub address: String,
    pub chain: String,
}

#[derive(Serialize)]
pub struct ScreenResponse {
    pub allowed: bool,
    pub reason: Option<String>,
}

async fn screen(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<ScreenRequest>,
) -> Result<Json<ScreenResponse>, ApiError> {
    let geo = geofence(&s.config.geofence, &headers);
    if !geo.allowed {
        return Ok(Json(ScreenResponse {
            allowed: false,
            reason: geo.reason,
        }));
    }
    let v = s.screener.screen(&req.address, &req.chain).await?;
    log_verdict(&v, &req.chain);
    Ok(Json(ScreenResponse {
        allowed: v.allowed,
        reason: v.reason,
    }))
}

fn log_verdict(v: &Verdict, chain: &str) {
    if !v.allowed {
        tracing::info!(source = v.source, chain, "address refused by screening");
    }
}

#[derive(Serialize)]
pub struct SignedQuote {
    pub quote: Value,
    pub fee_recipient: String,
    pub fee_bps: u32,
    pub signature: String,
    pub public_key_hex: String,
}

/// Screen, forward to 1Click with the server's fee, sign the result.
async fn quote(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<SignedQuote>, ApiError> {
    let geo = geofence(&s.config.geofence, &headers);
    if !geo.allowed {
        return Err(ApiError::Forbidden(geo.reason.unwrap_or_default()));
    }
    for (address, chain) in addresses_to_screen(&body)? {
        let v = s.screener.screen(&address, &chain).await?;
        log_verdict(&v, &chain);
        if !v.allowed {
            return Err(ApiError::Forbidden(v.reason.unwrap_or_default()));
        }
    }
    let swap_type = body.get("swapType").and_then(|v| v.as_str()).unwrap_or("");
    let fees = if s.config.fee_bps > 0 && swap_type != "ANY_INPUT" {
        Some(vec![AppFee {
            recipient: s.config.fee_recipient.clone(),
            fee: s.config.fee_bps,
        }])
    } else {
        None
    };
    let quote = s.oneclick.quote(body, fees).await?;
    let signature = s
        .signer
        .sign(&s.config.fee_recipient, s.config.fee_bps, &quote);
    Ok(Json(SignedQuote {
        quote,
        fee_recipient: s.config.fee_recipient.clone(),
        fee_bps: s.config.fee_bps,
        signature,
        public_key_hex: s.signer.public_key_hex(),
    }))
}

#[derive(Deserialize)]
pub struct StatusQuery {
    #[serde(rename = "depositMemo")]
    pub deposit_memo: Option<String>,
}

async fn status(
    State(s): State<Shared>,
    Path(deposit_address): Path<String>,
    Query(q): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    if deposit_address.len() > 128 {
        return Err(ApiError::BadRequest("deposit address too long".into()));
    }
    Ok(Json(
        s.oneclick
            .status(&deposit_address, q.deposit_memo.as_deref())
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::config::{GeofenceConfig, ScreeningConfig};

    fn test_config() -> Config {
        Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            allowed_origins: vec!["https://unpair.xyz".into()],
            fee_recipient: "unpair.near".into(),
            fee_bps: 50,
            oneclick_jwt: None,
            oneclick_url: "http://127.0.0.1:9".into(),
            signing_seed: Some([3u8; 32]),
            screening: ScreeningConfig::Off,
            geofence: GeofenceConfig {
                blocked_countries: vec!["KP".into()],
                country_header: "cf-ipcountry".into(),
                require_header: false,
            },
        }
    }

    fn build_app(cfg: Config) -> Router {
        let state = Arc::new(AppState {
            bind: cfg.bind,
            screener: Screener::Off,
            signer: QuoteSigner::from_seed(cfg.signing_seed.unwrap()),
            oneclick: OneClick::new(cfg.oneclick_url.clone(), None).unwrap(),
            started_at: std::time::Instant::now(),
            config: cfg,
        });
        router(state)
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_and_config() {
        let app = build_app(test_config());
        let r = app
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let r = app
            .oneshot(Request::get("/v1/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let j = body_json(r).await;
        assert_eq!(j["fee_bps"], 50);
        assert_eq!(j["fee_cap_bps"], 100);
        assert_eq!(j["screening"], "off");
        assert_eq!(
            j["quote_signing_pubkey"],
            QuoteSigner::from_seed([3u8; 32]).public_key_hex()
        );
    }

    #[tokio::test]
    async fn screen_applies_geofence_then_screener() {
        let app = build_app(test_config());
        let req = Request::post("/v1/screen")
            .header("content-type", "application/json")
            .header("cf-ipcountry", "KP")
            .body(Body::from(r#"{"address":"0xabc","chain":"eth"}"#))
            .unwrap();
        let j = body_json(app.clone().oneshot(req).await.unwrap()).await;
        assert_eq!(j["allowed"], false);
        assert_eq!(j["reason"], "Unpair is not available in your region.");

        let req = Request::post("/v1/screen")
            .header("content-type", "application/json")
            .header("cf-ipcountry", "DE")
            .body(Body::from(r#"{"address":"0xabc","chain":"eth"}"#))
            .unwrap();
        let j = body_json(app.oneshot(req).await.unwrap()).await;
        assert_eq!(j["allowed"], true);
    }

    #[tokio::test]
    async fn quote_is_refused_in_blocked_region_before_any_upstream_call() {
        let app = build_app(test_config());
        let req = Request::post("/v1/quote")
            .header("content-type", "application/json")
            .header("cf-ipcountry", "kp")
            .body(Body::from(r#"{"refundTo":"a","recipient":"b"}"#))
            .unwrap();
        let r = app.oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn quote_requires_addresses() {
        let app = build_app(test_config());
        let req = Request::post("/v1/quote")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"recipient":"b"}"#))
            .unwrap();
        let r = app.oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let j = body_json(r).await;
        assert_eq!(j["message"], "refundTo is required");
    }

    #[tokio::test]
    async fn cors_only_for_allowed_origins() {
        let app = build_app(test_config());
        let r = app
            .clone()
            .oneshot(
                Request::get("/health")
                    .header("origin", "https://unpair.xyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r.headers().get("access-control-allow-origin").unwrap(),
            "https://unpair.xyz"
        );
        let r = app
            .oneshot(
                Request::get("/health")
                    .header("origin", "https://clone.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(r.headers().get("access-control-allow-origin").is_none());
    }
}
