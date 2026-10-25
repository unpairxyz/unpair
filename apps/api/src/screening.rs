//! Screening before execution.
//!
//! Two checks run on every quote: the geofence on the caller's country and
//! the address screen on the refund and destination addresses. A flagged
//! flow gets no quote, so no fee is ever taken from it. Results are logged
//! without the caller's IP.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};

use crate::config::{GeofenceConfig, ScreeningConfig};
use crate::error::ApiError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub allowed: bool,
    /// Plain words. Shown to the user when not allowed.
    pub reason: Option<String>,
    /// Which check produced the verdict.
    pub source: &'static str,
}

impl Verdict {
    fn allow(source: &'static str) -> Self {
        Self {
            allowed: true,
            reason: None,
            source,
        }
    }
    fn deny(source: &'static str, reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.into()),
            source,
        }
    }
}

/// Country check from a trusted edge header.
pub fn geofence(cfg: &GeofenceConfig, headers: &HeaderMap) -> Verdict {
    let country = headers
        .get(cfg.country_header.as_str())
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_uppercase());
    match country {
        Some(c) if cfg.blocked_countries.iter().any(|b| b == &c) => {
            Verdict::deny("geofence", "Unpair is not available in your region.")
        }
        Some(_) => Verdict::allow("geofence"),
        None if cfg.require_header => Verdict::deny(
            "geofence",
            "Region could not be determined. Try again later.",
        ),
        None => Verdict::allow("geofence"),
    }
}

#[derive(Clone)]
pub enum Screener {
    Off,
    Denylist(HashSet<String>),
    Http {
        client: reqwest::Client,
        url: String,
        api_key_header: String,
        api_key: String,
    },
}

#[derive(Serialize)]
struct HttpRequestBody<'a> {
    address: &'a str,
    chain: &'a str,
}

#[derive(Deserialize)]
struct HttpResponseBody {
    allowed: bool,
    #[serde(default)]
    reason: Option<String>,
}

impl Screener {
    pub fn from_config(cfg: &ScreeningConfig) -> Result<Self, std::io::Error> {
        Ok(match cfg {
            ScreeningConfig::Off => {
                tracing::warn!(
                    "screening is OFF; every address is allowed. Do not run this in production."
                );
                Screener::Off
            }
            ScreeningConfig::Denylist { path } => Screener::Denylist(load_denylist(path)?),
            ScreeningConfig::Http {
                url,
                api_key_header,
                api_key,
                timeout,
            } => Screener::Http {
                client: {
                    let _ = rustls::crypto::ring::default_provider().install_default();
                    reqwest::Client::builder()
                        .timeout(*timeout)
                        .build()
                        .map_err(std::io::Error::other)?
                },
                url: url.clone(),
                api_key_header: api_key_header.clone(),
                api_key: api_key.clone(),
            },
        })
    }

    pub fn mode(&self) -> &'static str {
        match self {
            Screener::Off => "off",
            Screener::Denylist(_) => "denylist",
            Screener::Http { .. } => "http",
        }
    }

    /// Screen one address. `chain` is the 1Click blockchain id, for example `eth` or `zec`.
    pub async fn screen(&self, address: &str, chain: &str) -> Result<Verdict, ApiError> {
        let address = address.trim();
        if address.is_empty() {
            return Err(ApiError::BadRequest("address is required".into()));
        }
        match self {
            Screener::Off => Ok(Verdict::allow("off")),
            Screener::Denylist(set) => Ok(if set.contains(&address.to_lowercase()) {
                Verdict::deny("denylist", "This address cannot be used with Unpair.")
            } else {
                Verdict::allow("denylist")
            }),
            Screener::Http {
                client,
                url,
                api_key_header,
                api_key,
            } => {
                let mut req = client.post(url).json(&HttpRequestBody { address, chain });
                if !api_key.is_empty() {
                    req = req.header(api_key_header.as_str(), api_key.as_str());
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| ApiError::ScreeningUnavailable(e.to_string()))?;
                if !resp.status().is_success() {
                    return Err(ApiError::ScreeningUnavailable(format!(
                        "status {}",
                        resp.status()
                    )));
                }
                let body: HttpResponseBody = resp
                    .json()
                    .await
                    .map_err(|e| ApiError::ScreeningUnavailable(e.to_string()))?;
                Ok(if body.allowed {
                    Verdict::allow("http")
                } else {
                    Verdict::deny(
                        "http",
                        body.reason
                            .unwrap_or_else(|| "This address cannot be used with Unpair.".into()),
                    )
                })
            }
        }
    }
}

fn load_denylist(path: &Path) -> Result<HashSet<String>, std::io::Error> {
    let text = std::fs::read_to_string(path)?;
    let set: HashSet<String> = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or("").trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();
    tracing::info!(entries = set.len(), path = %path.display(), "loaded denylist");
    Ok(set)
}

#[allow(dead_code)]
pub fn default_timeout() -> Duration {
    Duration::from_secs(4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn geo(require: bool) -> GeofenceConfig {
        GeofenceConfig {
            blocked_countries: vec!["CU".into(), "IR".into(), "KP".into(), "SY".into()],
            country_header: "cf-ipcountry".into(),
            require_header: require,
        }
    }

    #[test]
    fn geofence_blocks_listed_countries_only() {
        let mut h = HeaderMap::new();
        h.insert("cf-ipcountry", HeaderValue::from_static("ir"));
        assert!(!geofence(&geo(false), &h).allowed);
        h.insert("cf-ipcountry", HeaderValue::from_static("DE"));
        assert!(geofence(&geo(false), &h).allowed);
    }

    #[test]
    fn geofence_missing_header_follows_policy() {
        let h = HeaderMap::new();
        assert!(geofence(&geo(false), &h).allowed);
        assert!(!geofence(&geo(true), &h).allowed);
    }

    #[tokio::test]
    async fn denylist_matches_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("deny.txt");
        std::fs::write(&p, "# comment\n0xABCDEF0000000000000000000000000000000001  # sanctioned\n\nt1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F\n").unwrap();
        let s = Screener::from_config(&ScreeningConfig::Denylist { path: p }).unwrap();
        assert!(
            !s.screen("0xabcdef0000000000000000000000000000000001", "eth")
                .await
                .unwrap()
                .allowed
        );
        assert!(
            s.screen("0xabcdef0000000000000000000000000000000002", "eth")
                .await
                .unwrap()
                .allowed
        );
        assert!(
            !s.screen(" t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F ", "zec")
                .await
                .unwrap()
                .allowed
        );
        assert!(matches!(
            s.screen("", "eth").await,
            Err(ApiError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn off_allows_everything() {
        let s = Screener::from_config(&ScreeningConfig::Off).unwrap();
        assert!(s.screen("anything", "eth").await.unwrap().allowed);
        assert_eq!(s.mode(), "off");
    }
}
