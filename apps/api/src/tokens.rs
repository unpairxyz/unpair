//! The route's token list, served from here so the page never has to call
//! the route itself. Refreshed at most every ten minutes; a stale copy is
//! served when the route is not reachable, so the page always loads.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::oneclick::OneClick;

/// How long a copy is served before the route is asked again.
pub const FRESH_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct TokenCache {
    inner: Mutex<Option<(Instant, Value)>>,
}

impl TokenCache {
    /// The token list: cached, refreshed when older than `FRESH_FOR`, stale
    /// when the route does not answer, and an error only when there is
    /// nothing to serve at all.
    pub async fn get(&self, oneclick: &OneClick) -> Result<Value, String> {
        let cached = self.inner.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some((at, v)) = &cached {
            if at.elapsed() < FRESH_FOR {
                return Ok(v.clone());
            }
        }
        match oneclick.tokens().await {
            Ok(v) => {
                *self.inner.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((Instant::now(), v.clone()));
                Ok(v)
            }
            Err(e) => match cached {
                Some((_, v)) => {
                    tracing::warn!(error = %e, "token list refresh failed; serving the last copy");
                    Ok(v)
                }
                None => Err(e),
            },
        }
    }
}
