//! "Check on your phone": the page may park a signed quote here under an
//! unguessable id, so a second device can load the same quote and draw the
//! same mark. Opt-in per quote, in memory only, gone after the deposit
//! deadline or [`MAX_TTL_SECS`], whichever is first. Nothing is written to disk.

use std::collections::HashMap;
use std::sync::Mutex;

use rand::RngExt;
use serde_json::Value;

/// Longest a parked quote lives, in seconds.
pub const MAX_TTL_SECS: u64 = 24 * 3600;
/// Most quotes parked at once. Past this, new ones are refused.
pub const MAX_ENTRIES: usize = 10_000;
/// Largest body accepted, in bytes.
pub const MAX_BYTES: usize = 16 * 1024;
/// Most bytes held at once, over every parked quote.
pub const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

struct Entry {
    body: Value,
    bytes: usize,
    expires_unix: u64,
}

#[derive(Default)]
pub struct Handoff {
    entries: Mutex<HashMap<String, Entry>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutError {
    TooLarge,
    Full,
}

impl Handoff {
    /// Park a quote. Returns the id and when it expires.
    pub fn put(&self, body: Value, now: u64, ttl_secs: u64) -> Result<(String, u64), PutError> {
        let bytes = body.to_string().len();
        if bytes > MAX_BYTES {
            return Err(PutError::TooLarge);
        }
        let mut map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, e| e.expires_unix > now);
        let held: usize = map.values().map(|e| e.bytes).sum();
        if map.len() >= MAX_ENTRIES || held + bytes > MAX_TOTAL_BYTES {
            return Err(PutError::Full);
        }
        let id = hex::encode(rand::rng().random::<[u8; 16]>());
        let expires_unix = now.saturating_add(ttl_secs.clamp(60, MAX_TTL_SECS));
        map.insert(
            id.clone(),
            Entry {
                body,
                bytes,
                expires_unix,
            },
        );
        Ok((id, expires_unix))
    }

    pub fn get(&self, id: &str, now: u64) -> Option<(Value, u64)> {
        let map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        map.get(id)
            .filter(|e| e.expires_unix > now)
            .map(|e| (e.body.clone(), e.expires_unix))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn put_get_expire() {
        let h = Handoff::default();
        let (id, exp) = h.put(json!({"quote": 1}), 1_000, 600).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(exp, 1_600);
        assert_eq!(h.get(&id, 1_500).unwrap().0, json!({"quote": 1}));
        assert!(h.get(&id, 1_600).is_none());
        assert!(h.get("nope", 1_000).is_none());
    }

    #[test]
    fn ttl_is_clamped_and_size_capped() {
        let h = Handoff::default();
        let (_, exp) = h.put(json!({}), 0, 10_000_000).unwrap();
        assert_eq!(exp, MAX_TTL_SECS);
        let big = json!({ "x": "y".repeat(MAX_BYTES) });
        assert_eq!(h.put(big, 0, 60).unwrap_err(), PutError::TooLarge);
    }

    #[test]
    fn total_bytes_are_capped() {
        let h = Handoff::default();
        let body = json!({ "x": "y".repeat(MAX_BYTES - 16) });
        let fits = MAX_TOTAL_BYTES / body.to_string().len();
        for _ in 0..fits {
            h.put(body.clone(), 0, 60).unwrap();
        }
        assert_eq!(h.put(body, 0, 60).unwrap_err(), PutError::Full);
        // expired entries free their bytes
        assert!(h.put(json!({"q": 1}), MAX_TTL_SECS + 1, 60).is_ok());
    }
}
