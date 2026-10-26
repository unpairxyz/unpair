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
    /// Hosted swaps: the server holds a Zcash transit key between the hops.
    /// Off unless a seed file is given.
    pub hosted: Option<HostedConfig>,
    /// Bearer token for the operator report. Required when hosted is on.
    pub operator_token: Option<String>,
    /// Requests per minute one client address may make to the endpoints that
    /// cost something (quote, hosted swap, screen, handoff). Zero turns it off.
    pub rate_limit_per_min: u32,
}

/// Default per-swap cap, 1 ZEC in zatoshis.
pub const HOSTED_DEFAULT_MAX_ZAT: u64 = 100_000_000;

#[derive(Clone, Debug)]
pub struct HostedConfig {
    /// File with the BIP 39 phrase of the transit wallet.
    pub seed_file: PathBuf,
    /// Directory for the wallet database and the swap store.
    pub data_dir: PathBuf,
    pub network: WalletNetwork,
    pub lightwalletd: Vec<String>,
    /// Block height the wallet starts scanning from. Default: the tip at first start.
    pub birthday_height: Option<u32>,
    /// How often the wallet syncs and the swap driver runs.
    pub interval: Duration,
    /// Largest ZEC amount one swap may carry, in zatoshis.
    pub max_zat: u64,
    /// Most swaps in flight at once.
    pub max_open: u32,
    /// Quiet mode cuts hop two into standard sizes at separate times.
    pub split: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletNetwork {
    Main,
    Test,
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
    /// Refuse requests with no country header. Default true. Set it false only
    /// for local development, where no proxy adds the header.
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
            require_header: bool_var("UNPAIR_GEOFENCE_REQUIRE_HEADER", true)?,
        };

        let hosted = match var("UNPAIR_WALLET_SEED_FILE") {
            None => None,
            Some(seed_file) => Some(HostedConfig {
                seed_file: PathBuf::from(seed_file),
                data_dir: PathBuf::from(
                    var("UNPAIR_WALLET_DIR").unwrap_or_else(|| "wallet".into()),
                ),
                network: match var("UNPAIR_ZCASH_NETWORK")
                    .unwrap_or_else(|| "main".into())
                    .as_str()
                {
                    "main" => WalletNetwork::Main,
                    "test" => WalletNetwork::Test,
                    other => {
                        return Err(ConfigError::Invalid(
                            "UNPAIR_ZCASH_NETWORK".into(),
                            format!("expected main or test, got {other}"),
                        ))
                    }
                },
                lightwalletd: list("UNPAIR_LIGHTWALLETD", ""),
                birthday_height: match var("UNPAIR_WALLET_BIRTHDAY") {
                    None => None,
                    Some(h) => Some(h.parse().map_err(|e| {
                        ConfigError::Invalid("UNPAIR_WALLET_BIRTHDAY".into(), format!("{e}"))
                    })?),
                },
                interval: Duration::from_secs(
                    var("UNPAIR_WALLET_INTERVAL_SECS")
                        .unwrap_or_else(|| "60".into())
                        .parse()
                        .map_err(|e| {
                            ConfigError::Invalid(
                                "UNPAIR_WALLET_INTERVAL_SECS".into(),
                                format!("{e}"),
                            )
                        })?,
                ),
                max_zat: var("UNPAIR_HOSTED_MAX_ZAT")
                    .unwrap_or_else(|| HOSTED_DEFAULT_MAX_ZAT.to_string())
                    .parse()
                    .map_err(|e| {
                        ConfigError::Invalid("UNPAIR_HOSTED_MAX_ZAT".into(), format!("{e}"))
                    })?,
                max_open: var("UNPAIR_HOSTED_MAX_OPEN")
                    .unwrap_or_else(|| "20".into())
                    .parse()
                    .map_err(|e| {
                        ConfigError::Invalid("UNPAIR_HOSTED_MAX_OPEN".into(), format!("{e}"))
                    })?,
                split: var("UNPAIR_HOSTED_SPLIT")
                    .map(|v| v != "false" && v != "0")
                    .unwrap_or(true),
            }),
        };
        let operator_token = var("UNPAIR_OPERATOR_TOKEN");
        let rate_limit_per_min: u32 = var("UNPAIR_RATE_LIMIT_PER_MIN")
            .unwrap_or_else(|| "20".into())
            .parse()
            .map_err(|e| {
                ConfigError::Invalid("UNPAIR_RATE_LIMIT_PER_MIN".into(), format!("{e}"))
            })?;
        if hosted.is_some() && operator_token.as_deref().is_none_or(|t| t.len() < 24) {
            return Err(ConfigError::Invalid(
                "UNPAIR_OPERATOR_TOKEN".into(),
                "required when the wallet is on; at least 24 characters".into(),
            ));
        }

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
            hosted,
            operator_token,
            rate_limit_per_min,
        })
    }
}
