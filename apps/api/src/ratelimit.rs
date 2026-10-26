//! A small per-client rate limit for the endpoints that cost something:
//! a 1Click quote under the partner key, a landing address, a screening
//! call, a parked quote. Fixed one-minute windows, in memory, bounded.

use std::collections::HashMap;
use std::sync::Mutex;

/// Seconds in one window.
const WINDOW_SECS: u64 = 60;
/// Most keys kept. Above this the oldest windows are dropped first.
const MAX_KEYS: usize = 50_000;

pub struct RateLimit {
    per_window: u32,
    inner: Mutex<HashMap<String, (u64, u32)>>,
}

impl RateLimit {
    /// `per_window` requests per key per minute. Zero turns the limit off.
    pub fn new(per_window: u32) -> Self {
        Self {
            per_window,
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// True when `key` may make one more request at `now`.
    pub fn allow(&self, key: &str, now: u64) -> bool {
        if self.per_window == 0 {
            return true;
        }
        let window = now / WINDOW_SECS;
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_KEYS {
            map.retain(|_, (w, _)| *w == window);
            if map.len() >= MAX_KEYS {
                map.clear();
            }
        }
        let entry = map.entry(key.to_string()).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        if entry.1 >= self.per_window {
            return false;
        }
        entry.1 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_per_key_and_window() {
        let l = RateLimit::new(2);
        assert!(l.allow("a", 100));
        assert!(l.allow("a", 101));
        assert!(!l.allow("a", 102));
        assert!(l.allow("b", 102));
        // next window
        assert!(l.allow("a", 160));
    }

    #[test]
    fn zero_is_off() {
        let l = RateLimit::new(0);
        for _ in 0..1000 {
            assert!(l.allow("a", 1));
        }
    }

    #[test]
    fn stays_bounded() {
        let l = RateLimit::new(1);
        for i in 0..(MAX_KEYS + 10) {
            assert!(l.allow(&format!("k{i}"), 1));
        }
        assert!(l.inner.lock().unwrap().len() <= MAX_KEYS);
    }
}
