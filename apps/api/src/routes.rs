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

use crate::config::{Config, HostedConfig};
use crate::driver::check_destination;
use crate::error::ApiError;
use crate::handoff::{Handoff, PutError};
use crate::hosted::{self, new_id, parse_rfc3339, Mode, State as SwapState, Store, Swap, SwapView};
use crate::oneclick::{addresses_to_screen, chain_of_asset, AppFee, OneClick};
use crate::screening::{geofence, Screener, Verdict};
use crate::sign::QuoteSigner;
use crate::wallet_worker::{now_unix, Report, WalletHandle};

/// The hosted swap service, present when the operator gave this server a seed.
pub struct Hosted {
    pub wallet: WalletHandle,
    pub store: Store,
    pub config: HostedConfig,
}

pub struct AppState {
    pub bind: std::net::SocketAddr,
    pub config: Config,
    pub screener: Screener,
    pub signer: QuoteSigner,
    pub oneclick: OneClick,
    pub hosted: Option<Hosted>,
    pub handoff: Handoff,
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
        .route("/v1/hosted/swaps", post(hosted_create))
        .route("/v1/hosted/swaps/{id}", get(hosted_get))
        .route("/v1/hosted/report", get(hosted_report))
        .route("/v1/handoff", post(handoff_put))
        .route("/v1/handoff/{id}", get(handoff_get))
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
    hosted: Option<HostedPublic>,
}

#[derive(Serialize)]
struct HostedPublic {
    /// Largest ZEC amount one swap may carry, in zatoshis.
    max_zat: u64,
    /// Swaps in flight and the cap.
    open: u32,
    max_open: u32,
    /// Zatoshis kept back for the hop-two network fee.
    hop2_fee_reserve_zat: u64,
    min_zat: u64,
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
        hosted: s.hosted.as_ref().map(|h| HostedPublic {
            max_zat: h.config.max_zat,
            open: h.store.count_open().unwrap_or(0),
            max_open: h.config.max_open,
            hop2_fee_reserve_zat: hosted::HOP2_FEE_RESERVE_ZAT,
            min_zat: hosted::MIN_ZAT,
        }),
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

#[derive(Deserialize)]
pub struct HostedCreate {
    pub mode: Mode,
    #[serde(rename = "originAsset")]
    pub origin_asset: String,
    /// Amount in the origin asset's base units.
    pub amount: String,
    #[serde(rename = "destinationAsset")]
    pub destination_asset: String,
    /// Where the destination asset arrives.
    pub recipient: String,
    /// Where the deposit returns if hop one fails, on the origin chain.
    #[serde(rename = "refundTo")]
    pub refund_to: String,
    #[serde(rename = "slippageTolerance")]
    pub slippage_bps: Option<u32>,
}

#[derive(Serialize)]
pub struct HostedCreated {
    pub swap: SwapView,
    /// Hop one, signed like `/v1/quote`.
    pub quote: SignedQuote,
}

fn hosted_of(s: &AppState) -> Result<&Hosted, ApiError> {
    s.hosted.as_ref().ok_or(ApiError::HostedOff)
}

/// Start a hosted swap: screen, take a fresh landing, quote hop one to it.
async fn hosted_create(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<HostedCreate>,
) -> Result<Json<HostedCreated>, ApiError> {
    let h = hosted_of(&s)?;
    let geo = geofence(&s.config.geofence, &headers);
    if !geo.allowed {
        return Err(ApiError::Forbidden(geo.reason.unwrap_or_default()));
    }
    // The same asset in and out is fine: hop one and hop two are different
    // route legs with ZEC between them, and only the link is gone.
    check_destination(&req.destination_asset)?;
    if req.amount.is_empty() || !req.amount.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::BadRequest(
            "amount must be a whole number of base units".into(),
        ));
    }
    let slippage = req.slippage_bps.unwrap_or(100);
    if !(1..=500).contains(&slippage) {
        return Err(ApiError::BadRequest(
            "slippage must be from 1 to 500 bps".into(),
        ));
    }
    let refund_to = req.refund_to.trim().to_string();
    let recipient = req.recipient.trim().to_string();
    if refund_to.is_empty() || recipient.is_empty() {
        return Err(ApiError::BadRequest(
            "refundTo and recipient are required".into(),
        ));
    }
    let open = h.store.count_open()?;
    if open >= h.config.max_open {
        return Err(ApiError::BadRequest(
            "The hosted service is at its limit of swaps in flight. Try again later or use your own wallet.".into(),
        ));
    }
    let targets = [
        (
            refund_to.clone(),
            chain_of_asset(&req.origin_asset).unwrap_or_else(|| "unknown".into()),
        ),
        (
            recipient.clone(),
            chain_of_asset(&req.destination_asset).unwrap_or_else(|| "unknown".into()),
        ),
    ];
    for (address, chain) in &targets {
        let v = s.screener.screen(address, chain).await?;
        log_verdict(&v, chain);
        if !v.allowed {
            return Err(ApiError::Forbidden(v.reason.unwrap_or_default()));
        }
    }

    // A landing handed out before and never paid serves first, so swaps that
    // never got a deposit do not use up the wallet's address gap.
    let landing = match h.store.take_free_landing()? {
        Some(index) => h.wallet.landing_at(index).await,
        None => h.wallet.next_landing().await,
    }
    .map_err(ApiError::Internal)?;
    let now = now_unix();
    let body = serde_json::json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": slippage,
        "originAsset": req.origin_asset,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": hosted::ZEC_ASSET,
        "amount": req.amount,
        "refundTo": refund_to,
        "refundType": "ORIGIN_CHAIN",
        "recipient": landing.shielded,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": hosted::rfc3339(now.saturating_add(hosted::DEPOSIT_WINDOW_SECS)),
    });
    let fees = if s.config.fee_bps > 0 {
        Some(vec![AppFee {
            recipient: s.config.fee_recipient.clone(),
            fee: s.config.fee_bps,
        }])
    } else {
        None
    };
    let quote = match s.oneclick.quote(body, fees).await {
        Ok(q) => q,
        Err(e) => {
            // Nothing will land on this address: hand it to the next swap.
            let _ = h.store.release_landing(landing.index);
            return Err(e);
        }
    };
    let q = quote.get("quote").cloned().unwrap_or(Value::Null);
    let str_of = |k: &str| q.get(k).and_then(Value::as_str).map(str::to_string);
    let amount_out: u64 = str_of("amountOut")
        .and_then(|a| a.parse().ok())
        .ok_or_else(|| ApiError::Upstream("quote without amountOut".into()))?;
    if amount_out > h.config.max_zat {
        return Err(ApiError::BadRequest(format!(
            "Hosted swaps carry at most {} ZEC each. Send less, or use your own wallet.",
            zec(h.config.max_zat)
        )));
    }
    if amount_out < hosted::MIN_ZAT + hosted::HOP2_FEE_RESERVE_ZAT {
        return Err(ApiError::BadRequest(format!(
            "This swap would land less than {} ZEC, too little to send on. Send more.",
            zec(hosted::MIN_ZAT + hosted::HOP2_FEE_RESERVE_ZAT)
        )));
    }
    let deposit_address = str_of("depositAddress")
        .ok_or_else(|| ApiError::Upstream("quote without a deposit address".into()))?;
    let deadline = str_of("deadline")
        .and_then(|d| parse_rfc3339(&d))
        .unwrap_or(now.saturating_add(hosted::DEPOSIT_WINDOW_SECS));
    let signature = s
        .signer
        .sign(&s.config.fee_recipient, s.config.fee_bps, &quote);

    let swap = Swap {
        id: new_id(),
        created_unix: now,
        updated_unix: now,
        mode: req.mode,
        state: SwapState::WaitingForDeposit,
        landing_index: landing.index,
        landing_shielded: landing.shielded.clone(),
        landing_transparent: landing.transparent.clone(),
        origin_asset: req.origin_asset.clone(),
        destination_asset: req.destination_asset.clone(),
        destination_address: recipient,
        refund_to,
        slippage_bps: slippage,
        hop1_deposit_address: deposit_address,
        hop1_deposit_memo: str_of("depositMemo"),
        hop1_amount_in: str_of("amountIn").unwrap_or_else(|| req.amount.clone()),
        hop1_deadline_unix: deadline,
        hop1_quote: quote.clone(),
        zec_received: None,
        release_at_unix: None,
        hop2_amount_in: None,
        hop2_deposit_address: None,
        hop2_quote: None,
        hop2_txid: None,
        delivered_amount: None,
        delivered_tx: None,
        attempts: 0,
        note: None,
        last_error: None,
        hop2_paying_unix: None,
    };
    if !h.store.insert_if_below(&swap, h.config.max_open)? {
        let _ = h.store.release_landing(landing.index);
        return Err(ApiError::BadRequest(
            "The hosted service is at its limit of swaps in flight. Try again later or use your own wallet.".into(),
        ));
    }
    tracing::info!(id = %swap.id, mode = swap.mode.as_str(), "hosted swap created");
    Ok(Json(HostedCreated {
        swap: swap.view(),
        quote: SignedQuote {
            quote,
            fee_recipient: s.config.fee_recipient.clone(),
            fee_bps: s.config.fee_bps,
            signature,
            public_key_hex: s.signer.public_key_hex(),
        },
    }))
}

fn zec(zat: u64) -> String {
    let whole = zat / 100_000_000;
    let frac = zat % 100_000_000;
    let s = format!("{whole}.{frac:08}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

async fn hosted_get(
    State(s): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<SwapView>, ApiError> {
    let h = hosted_of(&s)?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::NotFound);
    }
    let swap = h.store.get(&id)?.ok_or(ApiError::NotFound)?;
    Ok(Json(swap.view()))
}

#[derive(Serialize)]
pub struct OperatorReport {
    pub wallet: Report,
    pub swaps: Vec<(String, u32)>,
    pub committed_zat: u64,
    pub max_zat: u64,
    pub max_open: u32,
}

/// Operator view: wallet balance and swap counts. Bearer token required.
async fn hosted_report(
    State(s): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<OperatorReport>, ApiError> {
    let h = hosted_of(&s)?;
    let expected = s
        .config
        .operator_token
        .as_deref()
        .ok_or(ApiError::Unauthorized)?;
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !constant_time_eq(given.as_bytes(), expected.as_bytes()) {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(OperatorReport {
        wallet: h.wallet.report().await.map_err(ApiError::Internal)?,
        swaps: h.store.count_by_state()?,
        committed_zat: h.store.committed_zat()?,
        max_zat: h.config.max_zat,
        max_open: h.config.max_open,
    }))
}

#[derive(Deserialize)]
pub struct HandoffPut {
    /// The signed quote as `/v1/quote` returned it.
    pub quote: Value,
    /// Seconds to keep it. Clamped to one minute and one day.
    pub ttl_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct HandoffCreated {
    pub id: String,
    pub expires_unix: u64,
}

#[derive(Serialize)]
pub struct HandoffView {
    pub quote: Value,
    pub expires_unix: u64,
}

/// Park a signed quote so another device can load it by id. Opt-in, in memory.
async fn handoff_put(
    State(s): State<Shared>,
    Json(req): Json<HandoffPut>,
) -> Result<Json<HandoffCreated>, ApiError> {
    if !req.quote.is_object() {
        return Err(ApiError::BadRequest("quote must be an object".into()));
    }
    // Only quotes this server signed are parked, so the store cannot carry
    // anything else and a parked quote is one the mark can be checked against.
    let text = |k: &str| req.quote.get(k).and_then(Value::as_str);
    let signed = match (
        text("public_key_hex"),
        text("signature"),
        text("fee_recipient"),
        req.quote.get("fee_bps").and_then(Value::as_u64),
        req.quote.get("quote"),
    ) {
        (Some(pk), Some(sig), Some(recipient), Some(bps), Some(inner)) => {
            pk == s.signer.public_key_hex()
                && u32::try_from(bps)
                    .is_ok_and(|bps| QuoteSigner::verify(pk, sig, recipient, bps, inner))
        }
        _ => false,
    };
    if !signed {
        return Err(ApiError::BadRequest(
            "quote is not signed by this server".into(),
        ));
    }
    let (id, expires_unix) = s
        .handoff
        .put(req.quote, now_unix(), req.ttl_secs.unwrap_or(2 * 3600))
        .map_err(|e| match e {
            PutError::TooLarge => ApiError::BadRequest("quote too large".into()),
            PutError::Full => ApiError::Upstream("handoff store is full".into()),
        })?;
    Ok(Json(HandoffCreated { id, expires_unix }))
}

async fn handoff_get(
    State(s): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<HandoffView>, ApiError> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::NotFound);
    }
    let (quote, expires_unix) = s.handoff.get(&id, now_unix()).ok_or(ApiError::NotFound)?;
    Ok(Json(HandoffView {
        quote,
        expires_unix,
    }))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
            hosted: None,
            operator_token: None,
        }
    }

    fn build_app(cfg: Config) -> Router {
        let state = Arc::new(AppState {
            bind: cfg.bind,
            screener: Screener::Off,
            signer: QuoteSigner::from_seed(cfg.signing_seed.unwrap()),
            oneclick: OneClick::new(cfg.oneclick_url.clone(), None).unwrap(),
            hosted: None,
            handoff: Handoff::default(),
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

    #[tokio::test]
    async fn hosted_routes_are_off_without_a_seed() {
        let app = build_app(test_config());
        let r = app
            .clone()
            .oneshot(
                Request::get("/v1/hosted/swaps/00000000000000000000000000000000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let j = body_json(r).await;
        assert_eq!(j["error"], "hosted_off");
        let r = app
            .oneshot(Request::get("/v1/config").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let j = body_json(r).await;
        assert!(j["hosted"].is_null());
    }

    #[tokio::test]
    async fn handoff_refuses_an_unsigned_quote() {
        let app = build_app(test_config());
        let req = Request::post("/v1/handoff")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"quote":{"signature":"abc"},"ttl_secs":600}"#,
            ))
            .unwrap();
        let r = app.oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn handoff_round_trip() {
        let app = build_app(test_config());
        let signer = QuoteSigner::from_seed([3u8; 32]);
        let inner = serde_json::json!({"quote": {"amountOut": "1"}});
        let signed = serde_json::json!({
            "quote": inner,
            "fee_recipient": "unpair.near",
            "fee_bps": 50,
            "signature": signer.sign("unpair.near", 50, &inner),
            "public_key_hex": signer.public_key_hex(),
        });
        let body = serde_json::json!({"quote": signed, "ttl_secs": 600}).to_string();
        let req = Request::post("/v1/handoff")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let r = app.clone().oneshot(req).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let j = body_json(r).await;
        let id = j["id"].as_str().unwrap().to_string();
        assert_eq!(id.len(), 32);
        let r = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/handoff/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let j = body_json(r).await;
        assert_eq!(j["quote"]["public_key_hex"], signer.public_key_hex());
        let r = app
            .oneshot(Request::get("/v1/handoff/zz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn zec_formatting() {
        assert_eq!(zec(100_000_000), "1");
        assert_eq!(zec(120_000), "0.0012");
        assert_eq!(zec(0), "0");
    }
}
