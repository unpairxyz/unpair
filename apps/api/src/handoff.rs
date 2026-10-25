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

struct Entry {
    body: Value,
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
        if body.to_string().len() > MAX_BYTES {
            return Err(PutError::TooLarge);
        }
        let mut map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, e| e.expires_unix > now);
        if map.len() >= MAX_ENTRIES {
            return Err(PutError::Full);
        }
        let id = hex::encode(rand::rng().random::<[u8; 16]>());
        let expires_unix = now + ttl_secs.clamp(60, MAX_TTL_SECS);
        map.insert(id.clone(), Entry { body, expires_unix });
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
}
