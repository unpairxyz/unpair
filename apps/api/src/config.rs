//! Configuration from environment variables. Every value has a safe default
//! except the ones that must be a deliberate choice.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::error::ConfigError;

/// Hard cap on the routing fee, in basis points. Mirrors the SDK.
pub const FEE_CAP_BPS: u32 = 100;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    /// Origins allowed to call this API from a browser.
    pub allowed_origins: Vec<String>,
    pub fee_recipient: String,
    pub fee_bps: u32,
    /// Partner JWT for 1Click. Optional; without it 1Click uses its public schedule.
    pub oneclick_jwt: Option<String>,
    pub oneclick_url: String,
    /// Ed25519 seed, 32 bytes hex. Generated at start if absent (then quotes are
    /// signed with a key that changes on restart, which is only fine for dev).
    pub signing_seed: Option<[u8; 32]>,
    pub screening: ScreeningConfig,
    pub geofence: GeofenceConfig,
}

#[derive(Clone, Debug)]
pub enum ScreeningConfig {
    /// Allow everything. Logs a warning at start. Dev only.
    Off,
    /// A text file with one address per line. Case-insensitive match.
    Denylist { path: PathBuf },
    /// POST {address, chain} to a URL; expect {"allowed": bool, "reason": string?}.
    Http {
        url: String,
        api_key_header: String,
        api_key: String,
        timeout: Duration,
    },
}

#[derive(Clone, Debug)]
pub struct GeofenceConfig {
    /// ISO 3166-1 alpha-2 codes that are refused.
    pub blocked_countries: Vec<String>,
    /// Header that carries the country, for example `cf-ipcountry` behind Cloudflare.
    pub country_header: String,
    /// Refuse requests with no country header. Default true in production.
    pub require_header: bool,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn list(name: &str, default: &str) -> Vec<String> {
    var(name)
        .unwrap_or_else(|| default.to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn bool_var(name: &str, default: bool) -> Result<bool, ConfigError> {
    match var(name).as_deref() {
        None => Ok(default),
        Some("1") | Some("true") | Some("yes") => Ok(true),
        Some("0") | Some("false") | Some("no") => Ok(false),
        Some(other) => Err(ConfigError::Invalid(
            name.into(),
            format!("expected true or false, got {other}"),
        )),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let bind: SocketAddr = var("UNPAIR_BIND")
            .unwrap_or_else(|| "127.0.0.1:8787".into())
            .parse()
            .map_err(|e| ConfigError::Invalid("UNPAIR_BIND".into(), format!("{e}")))?;

        let fee_bps: u32 = var("UNPAIR_FEE_BPS")
            .unwrap_or_else(|| "50".into())
            .parse()
            .map_err(|e| ConfigError::Invalid("UNPAIR_FEE_BPS".into(), format!("{e}")))?;
        if fee_bps > FEE_CAP_BPS {
            return Err(ConfigError::Invalid(
                "UNPAIR_FEE_BPS".into(),
                format!("{fee_bps} is above the cap of {FEE_CAP_BPS}"),
            ));
        }

        let signing_seed = match var("UNPAIR_SIGNING_SEED") {
            None => None,
            Some(h) => {
                let bytes = hex::decode(&h).map_err(|e| {
                    ConfigError::Invalid("UNPAIR_SIGNING_SEED".into(), format!("{e}"))
                })?;
                let arr: [u8; 32] = bytes.try_into().map_err(|_| {
                    ConfigError::Invalid(
                        "UNPAIR_SIGNING_SEED".into(),
                        "must be 32 bytes hex".into(),
                    )
                })?;
                Some(arr)
            }
        };

        let screening = match var("UNPAIR_SCREENING")
            .unwrap_or_else(|| "off".into())
            .as_str()
        {
            "off" => ScreeningConfig::Off,
            "denylist" => ScreeningConfig::Denylist {
                path: var("UNPAIR_SCREENING_DENYLIST")
                    .map(PathBuf::from)
                    .ok_or(ConfigError::Missing("UNPAIR_SCREENING_DENYLIST"))?,
            },
            "http" => ScreeningConfig::Http {
                url: var("UNPAIR_SCREENING_URL")
                    .ok_or(ConfigError::Missing("UNPAIR_SCREENING_URL"))?,
                api_key_header: var("UNPAIR_SCREENING_KEY_HEADER")
                    .unwrap_or_else(|| "authorization".into()),
                api_key: var("UNPAIR_SCREENING_KEY").unwrap_or_default(),
                timeout: Duration::from_millis(
                    var("UNPAIR_SCREENING_TIMEOUT_MS")
                        .unwrap_or_else(|| "4000".into())
                        .parse()
                        .map_err(|e| {
                            ConfigError::Invalid(
                                "UNPAIR_SCREENING_TIMEOUT_MS".into(),
                                format!("{e}"),
                            )
                        })?,
                ),
            },
            other => {
                return Err(ConfigError::Invalid(
                    "UNPAIR_SCREENING".into(),
                    format!("expected off, denylist or http, got {other}"),
                ))
            }
        };

        let geofence = GeofenceConfig {
            blocked_countries: list("UNPAIR_GEOFENCE", "CU,IR,KP,SY")
                .into_iter()
                .map(|c| c.to_uppercase())
                .collect(),
            country_header: var("UNPAIR_COUNTRY_HEADER")
                .unwrap_or_else(|| "cf-ipcountry".into())
                .to_lowercase(),
            require_header: bool_var("UNPAIR_GEOFENCE_REQUIRE_HEADER", false)?,
        };

        Ok(Config {
            bind,
            allowed_origins: list(
                "UNPAIR_ALLOWED_ORIGINS",
                "https://unpair.xyz,http://localhost:5173,http://localhost:4173",
            ),
            fee_recipient: var("UNPAIR_FEE_RECIPIENT").unwrap_or_else(|| "unpair.near".into()),
            fee_bps,
            oneclick_jwt: var("UNPAIR_ONECLICK_JWT"),
            oneclick_url: var("UNPAIR_ONECLICK_URL")
                .unwrap_or_else(|| "https://1click.chaindefuser.com".into()),
            signing_seed,
            screening,
            geofence,
        })
    }
}
