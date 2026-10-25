//! Hosted swaps: the server holds a Zcash transit key between the two hops.
//!
//! One swap is one note in and one spend out. Hop one is a 1Click swap from
//! the user's asset to ZEC, paid to a fresh Orchard-only address of the
//! transit wallet, so it lands shielded with no transparent step. After a
//! release delay the driver runs hop two: a 1Click swap from ZEC to the
//! asset and address the user chose, paid from Ironwood notes.
//!
//! The server sees both ends of a hosted swap. The store keeps what a
//! refund or a support question needs and nothing more; finished swaps are
//! deleted after [`RETENTION_SECS`].

use std::path::Path;
use std::sync::Mutex;

use rand::RngExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiError;

/// 1Click asset id of ZEC on Zcash.
pub const ZEC_ASSET: &str = "nep141:zec.omft.near";

/// Smallest hop-one payout we accept, 0.001 ZEC. Below this the second hop
/// is mostly fee.
pub const MIN_ZAT: u64 = 100_000;

/// Zatoshis kept back for the hop-two network fee. ZIP 317 for up to three
/// notes in and two outputs. Whatever the real fee leaves over stays as change
/// in the transit wallet.
pub const HOP2_FEE_RESERVE_ZAT: u64 = 20_000;

/// Release delay in quiet mode. Exponential with this mean, capped.
pub const RELEASE_MEAN_BLOCKS: f64 = 144.0;
pub const RELEASE_MAX_BLOCKS: u64 = 576;
pub const SECONDS_PER_BLOCK: u64 = 75;

/// How long hop one may wait for the deposit. 1Click's own deadline is
/// shorter for most assets; this is the outer bound the driver enforces.
pub const DEPOSIT_WINDOW_SECS: u64 = 60 * 60;

/// Finished swaps are deleted this long after their last change.
pub const RETENTION_SECS: u64 = 7 * 24 * 3600;

/// Retries of hop two before a swap needs the operator.
pub const MAX_ATTEMPTS: u32 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Waiting for the user's deposit on the origin chain.
    WaitingForDeposit,
    /// 1Click saw the deposit and is filling hop one.
    RoutingIn,
    /// ZEC is in the transit wallet. Hop two runs at `release_at`.
    InPool,
    /// Hop two paid 1Click and it is filling the swap.
    RoutingOut,
    /// Delivered to the user's address.
    Done,
    /// Hop one did not complete. 1Click returned the deposit.
    Refunded,
    /// No deposit before the deadline.
    Expired,
    /// Hop two could not be completed by the driver. The ZEC is in the
    /// transit wallet and the operator must act.
    Failed,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::WaitingForDeposit => "waiting_for_deposit",
            State::RoutingIn => "routing_in",
            State::InPool => "in_pool",
            State::RoutingOut => "routing_out",
            State::Done => "done",
            State::Refunded => "refunded",
            State::Expired => "expired",
            State::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<State> {
        Some(match s {
            "waiting_for_deposit" => State::WaitingForDeposit,
            "routing_in" => State::RoutingIn,
            "in_pool" => State::InPool,
            "routing_out" => State::RoutingOut,
            "done" => State::Done,
            "refunded" => State::Refunded,
            "expired" => State::Expired,
            "failed" => State::Failed,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Fast,
    Quiet,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Fast => "fast",
            Mode::Quiet => "quiet",
        }
    }
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "fast" => Some(Mode::Fast),
            "quiet" => Some(Mode::Quiet),
            _ => None,
        }
    }
}

/// Everything the server keeps about one hosted swap.
#[derive(Clone, Debug)]
pub struct Swap {
    pub id: String,
    pub created_unix: u64,
    pub updated_unix: u64,
    pub mode: Mode,
    pub state: State,
    pub landing_index: u32,
    pub landing_shielded: String,
    pub landing_transparent: String,
    pub origin_asset: String,
    pub destination_asset: String,
    pub destination_address: String,
    pub refund_to: String,
    pub slippage_bps: u32,
    pub hop1_deposit_address: String,
    pub hop1_deposit_memo: Option<String>,
    pub hop1_amount_in: String,
    pub hop1_deadline_unix: u64,
    pub hop1_quote: Value,
    pub zec_received: Option<u64>,
    pub release_at_unix: Option<u64>,
    pub hop2_amount_in: Option<u64>,
    pub hop2_deposit_address: Option<String>,
    pub hop2_quote: Option<Value>,
    pub hop2_txid: Option<String>,
    pub delivered_amount: Option<String>,
    pub delivered_tx: Option<String>,
    pub attempts: u32,
    /// Plain words for the user when something needs their attention.
    pub note: Option<String>,
    /// Last internal error, for the operator report. Never shown to users.
    pub last_error: Option<String>,
}

/// What the user's page may see.
#[derive(Serialize)]
pub struct SwapView {
    pub id: String,
    pub state: State,
    pub mode: Mode,
    pub created_unix: u64,
    pub updated_unix: u64,
    pub origin_asset: String,
    pub destination_asset: String,
    pub destination_address: String,
    pub deposit_address: String,
    pub deposit_memo: Option<String>,
    pub amount_in: String,
    pub deposit_deadline_unix: u64,
    pub zec_received: Option<u64>,
    pub release_at_unix: Option<u64>,
    pub hop2_amount_in: Option<u64>,
    pub hop2_txid: Option<String>,
    pub delivered_amount: Option<String>,
    pub delivered_tx: Option<String>,
    pub note: Option<String>,
}

impl Swap {
    pub fn view(&self) -> SwapView {
        SwapView {
            id: self.id.clone(),
            state: self.state,
            mode: self.mode,
            created_unix: self.created_unix,
            updated_unix: self.updated_unix,
            origin_asset: self.origin_asset.clone(),
            destination_asset: self.destination_asset.clone(),
            destination_address: self.destination_address.clone(),
            deposit_address: self.hop1_deposit_address.clone(),
            deposit_memo: self.hop1_deposit_memo.clone(),
            amount_in: self.hop1_amount_in.clone(),
            deposit_deadline_unix: self.hop1_deadline_unix,
            zec_received: self.zec_received,
            release_at_unix: self.release_at_unix,
            hop2_amount_in: self.hop2_amount_in,
            hop2_txid: self.hop2_txid.clone(),
            delivered_amount: self.delivered_amount.clone(),
            delivered_tx: self.delivered_tx.clone(),
            note: self.note.clone(),
        }
    }
}

/// Unguessable swap id: 16 random bytes, hex.
pub fn new_id() -> String {
    let bytes: [u8; 16] = rand::rng().random();
    hex::encode(bytes)
}

/// Delay before hop two, in seconds. Fast mode releases at once. Quiet mode
/// draws an exponential delay with a mean of about 3 hours, capped at 12.
pub fn release_delay_secs(mode: Mode) -> u64 {
    match mode {
        Mode::Fast => 0,
        Mode::Quiet => {
            let u: f64 = rand::rng().random();
            let raw: f64 = -RELEASE_MEAN_BLOCKS * (1.0_f64 - u).ln();
            let blocks = (raw.ceil() as u64).clamp(1, RELEASE_MAX_BLOCKS);
            blocks * SECONDS_PER_BLOCK
        }
    }
}

/// RFC 3339 UTC timestamp for a unix time, for 1Click deadlines.
pub fn rfc3339(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Parse the RFC 3339 deadline 1Click returns, to unix seconds. Fractional
/// seconds and `Z` only, which is what the API sends.
pub fn parse_rfc3339(s: &str) -> Option<u64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let m: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    let time = time.split('.').next()?;
    let mut t = time.split(':');
    let hh: u64 = t.next()?.parse().ok()?;
    let mm: u64 = t.next()?.parse().ok()?;
    let ss: u64 = t.next()?.parse().ok()?;
    // days-from-civil
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// The swap store. SQLite, one table, behind a mutex: every call is short.
pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS swaps (
    id TEXT PRIMARY KEY,
    created_unix INTEGER NOT NULL,
    updated_unix INTEGER NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    landing_index INTEGER NOT NULL,
    landing_shielded TEXT NOT NULL,
    landing_transparent TEXT NOT NULL,
    origin_asset TEXT NOT NULL,
    destination_asset TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    refund_to TEXT NOT NULL,
    slippage_bps INTEGER NOT NULL,
    hop1_deposit_address TEXT NOT NULL,
    hop1_deposit_memo TEXT,
    hop1_amount_in TEXT NOT NULL,
    hop1_deadline_unix INTEGER NOT NULL,
    hop1_quote TEXT NOT NULL,
    zec_received INTEGER,
    release_at_unix INTEGER,
    hop2_amount_in INTEGER,
    hop2_deposit_address TEXT,
    hop2_quote TEXT,
    hop2_txid TEXT,
    delivered_amount TEXT,
    delivered_tx TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS swaps_state ON swaps(state);
";

const COLUMNS: &str = "id, created_unix, updated_unix, mode, state, landing_index, landing_shielded, landing_transparent, origin_asset, destination_asset, destination_address, refund_to, slippage_bps, hop1_deposit_address, hop1_deposit_memo, hop1_amount_in, hop1_deadline_unix, hop1_quote, zec_received, release_at_unix, hop2_amount_in, hop2_deposit_address, hop2_quote, hop2_txid, delivered_amount, delivered_tx, attempts, note, last_error";

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(format!("swap store: {e}"))
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, ApiError> {
        let conn = Connection::open(path).map_err(internal)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(internal)?;
        conn.execute_batch(SCHEMA).map_err(internal)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, ApiError> {
        let conn = Connection::open_in_memory().map_err(internal)?;
        conn.execute_batch(SCHEMA).map_err(internal)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn insert(&self, s: &Swap) -> Result<(), ApiError> {
        let conn = self.lock();
        conn.execute(
            &format!("INSERT INTO swaps ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)"),
            params![
                s.id,
                s.created_unix as i64,
                s.updated_unix as i64,
                s.mode.as_str(),
                s.state.as_str(),
                s.landing_index,
                s.landing_shielded,
                s.landing_transparent,
                s.origin_asset,
                s.destination_asset,
                s.destination_address,
                s.refund_to,
                s.slippage_bps,
                s.hop1_deposit_address,
                s.hop1_deposit_memo,
                s.hop1_amount_in,
                s.hop1_deadline_unix as i64,
                s.hop1_quote.to_string(),
                s.zec_received.map(|v| v as i64),
                s.release_at_unix.map(|v| v as i64),
                s.hop2_amount_in.map(|v| v as i64),
                s.hop2_deposit_address,
                s.hop2_quote.as_ref().map(|q| q.to_string()),
                s.hop2_txid,
                s.delivered_amount,
                s.delivered_tx,
                s.attempts,
                s.note,
                s.last_error,
            ],
        )
        .map_err(internal)?;
        Ok(())
    }

    pub fn update(&self, s: &Swap) -> Result<(), ApiError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE swaps SET updated_unix=?2, state=?3, zec_received=?4, release_at_unix=?5, hop2_amount_in=?6, hop2_deposit_address=?7, hop2_quote=?8, hop2_txid=?9, delivered_amount=?10, delivered_tx=?11, attempts=?12, note=?13, last_error=?14 WHERE id=?1",
            params![
                s.id,
                s.updated_unix as i64,
                s.state.as_str(),
                s.zec_received.map(|v| v as i64),
                s.release_at_unix.map(|v| v as i64),
                s.hop2_amount_in.map(|v| v as i64),
                s.hop2_deposit_address,
                s.hop2_quote.as_ref().map(|q| q.to_string()),
                s.hop2_txid,
                s.delivered_amount,
                s.delivered_tx,
                s.attempts,
                s.note,
                s.last_error,
            ],
        )
        .map_err(internal)?;
        if n == 0 {
            return Err(ApiError::NotFound);
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Swap>, ApiError> {
        let conn = self.lock();
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM swaps WHERE id=?1"),
            params![id],
            row_to_swap,
        )
        .optional()
        .map_err(internal)
    }

    /// Swaps that are not in a final state, oldest first.
    pub fn open_swaps(&self) -> Result<Vec<Swap>, ApiError> {
        let conn = self.lock();
        let mut st = conn
            .prepare(&format!("SELECT {COLUMNS} FROM swaps WHERE state IN ('waiting_for_deposit','routing_in','in_pool','routing_out') ORDER BY created_unix"))
            .map_err(internal)?;
        let rows = st.query_map([], row_to_swap).map_err(internal)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(internal)
    }

    pub fn count_open(&self) -> Result<u32, ApiError> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM swaps WHERE state IN ('waiting_for_deposit','routing_in','in_pool','routing_out')",
            [],
            |r| r.get::<_, u32>(0),
        )
        .map_err(internal)
    }

    pub fn count_by_state(&self) -> Result<Vec<(String, u32)>, ApiError> {
        let conn = self.lock();
        let mut st = conn
            .prepare("SELECT state, COUNT(*) FROM swaps GROUP BY state ORDER BY state")
            .map_err(internal)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))
            .map_err(internal)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(internal)
    }

    /// Delete finished swaps older than the retention window. Returns how many.
    pub fn prune(&self, now: u64) -> Result<usize, ApiError> {
        let conn = self.lock();
        let cutoff = now.saturating_sub(RETENTION_SECS) as i64;
        conn.execute(
            "DELETE FROM swaps WHERE state IN ('done','refunded','expired') AND updated_unix < ?1",
            params![cutoff],
        )
        .map_err(internal)
    }

    /// Sum of ZEC the wallet must still pay out, in zatoshis.
    pub fn committed_zat(&self) -> Result<u64, ApiError> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COALESCE(SUM(hop2_amount_in), 0) FROM swaps WHERE state='in_pool' AND hop2_amount_in IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u64)
        .map_err(internal)
    }
}

fn row_to_swap(r: &rusqlite::Row<'_>) -> rusqlite::Result<Swap> {
    let bad = |what: &str| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(format!("bad {what}"))),
        )
    };
    let mode: String = r.get(3)?;
    let state: String = r.get(4)?;
    let hop1_quote: String = r.get(17)?;
    let hop2_quote: Option<String> = r.get(22)?;
    Ok(Swap {
        id: r.get(0)?,
        created_unix: r.get::<_, i64>(1)? as u64,
        updated_unix: r.get::<_, i64>(2)? as u64,
        mode: Mode::parse(&mode).ok_or_else(|| bad("mode"))?,
        state: State::parse(&state).ok_or_else(|| bad("state"))?,
        landing_index: r.get(5)?,
        landing_shielded: r.get(6)?,
        landing_transparent: r.get(7)?,
        origin_asset: r.get(8)?,
        destination_asset: r.get(9)?,
        destination_address: r.get(10)?,
        refund_to: r.get(11)?,
        slippage_bps: r.get(12)?,
        hop1_deposit_address: r.get(13)?,
        hop1_deposit_memo: r.get(14)?,
        hop1_amount_in: r.get(15)?,
        hop1_deadline_unix: r.get::<_, i64>(16)? as u64,
        hop1_quote: serde_json::from_str(&hop1_quote).map_err(|_| bad("hop1_quote"))?,
        zec_received: r.get::<_, Option<i64>>(18)?.map(|v| v as u64),
        release_at_unix: r.get::<_, Option<i64>>(19)?.map(|v| v as u64),
        hop2_amount_in: r.get::<_, Option<i64>>(20)?.map(|v| v as u64),
        hop2_deposit_address: r.get(21)?,
        hop2_quote: match hop2_quote {
            Some(q) => Some(serde_json::from_str(&q).map_err(|_| bad("hop2_quote"))?),
            None => None,
        },
        hop2_txid: r.get(23)?,
        delivered_amount: r.get(24)?,
        delivered_tx: r.get(25)?,
        attempts: r.get(26)?,
        note: r.get(27)?,
        last_error: r.get(28)?,
    })
}

/// Fields of a 1Click status response the driver reads.
pub struct StatusFacts {
    pub status: String,
    pub amount_out: Option<u64>,
    pub amount_out_formatted: Option<String>,
    pub destination_tx: Option<String>,
}

pub fn status_facts(v: &Value) -> StatusFacts {
    let details = v.get("swapDetails");
    let s = |k: &str| {
        details
            .and_then(|d| d.get(k))
            .and_then(|x| x.as_str())
            .map(str::to_string)
    };
    StatusFacts {
        status: v
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        amount_out: s("amountOut").and_then(|a| a.parse().ok()),
        amount_out_formatted: s("amountOutFormatted"),
        destination_tx: details
            .and_then(|d| d.get("destinationChainTxHashes"))
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|t| t.get("hash"))
            .and_then(|h| h.as_str())
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Swap {
        Swap {
            id: new_id(),
            created_unix: 1_000,
            updated_unix: 1_000,
            mode: Mode::Quiet,
            state: State::WaitingForDeposit,
            landing_index: 3,
            landing_shielded: "u1abc".into(),
            landing_transparent: "t1abc".into(),
            origin_asset: "nep141:base-0x1.omft.near".into(),
            destination_asset: "nep141:eth.omft.near".into(),
            destination_address: "0xdest".into(),
            refund_to: "0xrefund".into(),
            slippage_bps: 100,
            hop1_deposit_address: "0xdeposit".into(),
            hop1_deposit_memo: None,
            hop1_amount_in: "8000000".into(),
            hop1_deadline_unix: 4_000,
            hop1_quote: serde_json::json!({"quote": {"amountOut": "1000000"}}),
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
        }
    }

    #[test]
    fn store_round_trip_and_open_list() {
        let store = Store::open_in_memory().unwrap();
        let mut s = sample();
        store.insert(&s).unwrap();
        assert_eq!(store.count_open().unwrap(), 1);
        let got = store.get(&s.id).unwrap().unwrap();
        assert_eq!(got.hop1_quote["quote"]["amountOut"], "1000000");
        assert_eq!(got.landing_index, 3);
        s.state = State::InPool;
        s.zec_received = Some(1_000_000);
        s.hop2_amount_in = Some(980_000);
        s.release_at_unix = Some(9_000);
        store.update(&s).unwrap();
        assert_eq!(store.committed_zat().unwrap(), 980_000);
        s.state = State::Done;
        s.updated_unix = 10;
        store.update(&s).unwrap();
        assert_eq!(store.count_open().unwrap(), 0);
        assert_eq!(store.prune(RETENTION_SECS + 100).unwrap(), 1);
        assert!(store.get(&s.id).unwrap().is_none());
    }

    #[test]
    fn ids_are_long_and_random() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn release_delay_is_bounded() {
        assert_eq!(release_delay_secs(Mode::Fast), 0);
        for _ in 0..1000 {
            let d = release_delay_secs(Mode::Quiet);
            assert!(d >= SECONDS_PER_BLOCK);
            assert!(d <= RELEASE_MAX_BLOCKS * SECONDS_PER_BLOCK);
        }
    }

    #[test]
    fn rfc3339_round_trip() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_793_000_000), "2026-10-26T07:33:20Z");
        assert_eq!(parse_rfc3339("2026-10-26T07:33:20Z"), Some(1_793_000_000));
        assert_eq!(
            parse_rfc3339("2026-10-26T07:33:20.123Z"),
            Some(1_793_000_000)
        );
        for t in [1u64, 951_782_400, 1_709_164_800, 4_102_444_800] {
            assert_eq!(parse_rfc3339(&rfc3339(t)), Some(t));
        }
        assert_eq!(parse_rfc3339("nonsense"), None);
    }

    #[test]
    fn reads_status_facts() {
        let v = serde_json::json!({
            "status": "SUCCESS",
            "swapDetails": {"amountOut": "626890", "amountOutFormatted": "0.0062689", "destinationChainTxHashes": [{"hash": "abc", "explorerUrl": ""}]}
        });
        let f = status_facts(&v);
        assert_eq!(f.status, "SUCCESS");
        assert_eq!(f.amount_out, Some(626_890));
        assert_eq!(f.destination_tx.as_deref(), Some("abc"));
        let f = status_facts(&serde_json::json!({"status": "PENDING_DEPOSIT"}));
        assert_eq!(f.amount_out, None);
    }
}
