//! Moves hosted swaps forward. Runs on the main runtime every interval, reads
//! the open swaps from the store, asks 1Click and the transit wallet what
//! happened, and writes the new state back.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ApiError;
use crate::hosted::{
    parse_rfc3339, release_delay_secs, status_facts, Mode, State, Swap, DEPOSIT_WINDOW_SECS,
    HOP2_FEE_RESERVE_ZAT, MAX_ATTEMPTS, MIN_ZAT, ZEC_ASSET,
};
use crate::oneclick::AppFee;
use crate::routes::AppState;
use crate::wallet_worker::now_unix;

/// Hop two quotes get this long for the deposit. The payout is broadcast
/// right after the quote, so it only needs to cover proving and a confirmation.
const HOP2_DEADLINE_SECS: u64 = 45 * 60;

/// Wait before hop two is retried after 1Click returned or failed it. The
/// refund comes to a transparent address and the shield cycle must sweep it.
const RETRY_DELAY_SECS: u64 = 30 * 60;

/// Wait before hop two is tried again after a passing fault: the route or
/// the wallet not answering, a quote too close to its deadline. These do not
/// count as attempts.
const TRANSIENT_BACKOFF_SECS: u64 = 5 * 60;

const UNRESOLVED_NOTE: &str = "A payout for the second hop was started and its result is not known. The operator must check the transit wallet before anything else is paid. Contact the operator with your swap id.";

/// A hop-two payout was handed to the wallet and no txid came back. The
/// transaction may or may not be on the chain; only the operator can tell.
pub fn payout_unresolved(swap: &Swap) -> bool {
    swap.hop2_paying_unix.is_some() && swap.hop2_txid.is_none()
}

pub fn spawn(state: Arc<AppState>, interval: Duration) {
    tokio::spawn(async move {
        loop {
            tick(&state).await;
            tokio::time::sleep(interval).await;
        }
    });
}

async fn tick(state: &AppState) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
    let now = now_unix();
    let swaps = match hosted.store.open_swaps() {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "could not list open swaps");
            return;
        }
    };
    for mut swap in swaps {
        let before = swap.state;
        advance(state, &mut swap, now).await;
        swap.updated_unix = now_unix();
        if let Err(e) = hosted.store.update(&swap) {
            tracing::error!(id = %swap.id, error = %e, "could not store swap");
        }
        if swap.state != before {
            tracing::info!(id = %swap.id, from = before.as_str(), to = swap.state.as_str(), "swap moved");
        }
    }
    match hosted.store.prune(now) {
        Ok(n) if n > 0 => tracing::info!(count = n, "pruned finished swaps"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "prune failed"),
    }
}

async fn advance(state: &AppState, swap: &mut Swap, now: u64) {
    match swap.state {
        State::WaitingForDeposit | State::RoutingIn => hop_one(state, swap, now).await,
        State::InPool => {
            if swap.release_at_unix.is_some_and(|t| t <= now) {
                hop_two(state, swap, now).await;
            }
        }
        State::RoutingOut => hop_two_status(state, swap, now).await,
        _ => {}
    }
}

/// Poll hop one. The deposit address is the key 1Click tracks the swap by.
async fn hop_one(state: &AppState, swap: &mut Swap, now: u64) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
    let status = match state
        .oneclick
        .status(
            &swap.hop1_deposit_address,
            swap.hop1_deposit_memo.as_deref(),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            swap.last_error = Some(format!("hop one status: {e}"));
            return;
        }
    };
    let facts = status_facts(&status);
    swap.last_error = None;
    match facts.status.as_str() {
        "PENDING_DEPOSIT" => {
            if now > swap.hop1_deadline_unix.saturating_add(DEPOSIT_WINDOW_SECS) {
                swap.state = State::Expired;
                swap.note = Some("No deposit arrived before the deadline. A deposit sent after it is returned by the route to the refund address.".into());
                release_landing(hosted, swap);
            }
        }
        "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" => {
            swap.state = State::RoutingIn;
        }
        "SUCCESS" => {
            let Some(received) = facts.amount_out else {
                swap.last_error = Some("hop one succeeded without an amount".into());
                return;
            };
            swap.zec_received = Some(received);
            if received < MIN_ZAT + HOP2_FEE_RESERVE_ZAT {
                swap.state = State::Failed;
                swap.note = Some("The ZEC that arrived is too small to send on. Contact the operator with your swap id.".into());
                return;
            }
            swap.hop2_amount_in = Some(hop2_amount(received, swap.mode, hosted.config.max_zat));
            swap.release_at_unix = Some(now.saturating_add(release_delay_secs(swap.mode)));
            swap.state = State::InPool;
        }
        "REFUNDED" => {
            swap.state = State::Refunded;
            swap.note = Some("The route did not complete the first hop and returned the deposit to the refund address.".into());
            release_landing(hosted, swap);
        }
        "FAILED" => {
            swap.state = State::Failed;
            swap.note = Some("The route reported an error on the first hop. Check the refund address for your deposit.".into());
        }
        other => {
            swap.last_error = Some(format!("unknown 1Click status {other}"));
        }
    }
}

/// A landing that never received anything may serve the next swap.
fn release_landing(hosted: &crate::routes::Hosted, swap: &Swap) {
    if let Err(e) = hosted.store.release_landing(swap.landing_index) {
        tracing::warn!(id = %swap.id, error = %e, "could not release the landing");
    }
}

/// What hop two pays, from what hop one delivered. The reserve covers the
/// network fee. Nothing above the per-swap cap is ever sent on. The amount is
/// not rounded here: a remainder would stay in the transit wallet, and that
/// is a fee the user was never shown. Quiet mode on this path is the random
/// delay; the denomination split that breaks amount matching is still to come.
fn hop2_amount(received: u64, _mode: Mode, max_zat: u64) -> u64 {
    received.min(max_zat).saturating_sub(HOP2_FEE_RESERVE_ZAT)
}

/// Try again later. Passing faults do not count as attempts.
fn back_off(swap: &mut Swap, now: u64, error: String) {
    swap.last_error = Some(error);
    swap.release_at_unix = Some(now.saturating_add(TRANSIENT_BACKOFF_SECS));
}

/// Quote hop two, pay it from Ironwood, tell 1Click the txid.
async fn hop_two(state: &AppState, swap: &mut Swap, now: u64) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
    if payout_unresolved(swap) {
        tracing::warn!(id = %swap.id, "hop two payout with no txid; needs the operator");
        swap.state = State::Failed;
        swap.note = Some(UNRESOLVED_NOTE.into());
        return;
    }
    let Some(amount) = swap.hop2_amount_in else {
        swap.state = State::Failed;
        swap.last_error = Some("in pool without a hop two amount".into());
        return;
    };
    if swap.attempts >= MAX_ATTEMPTS {
        swap.state = State::Failed;
        swap.note = Some("The second hop could not be completed. The ZEC is safe in the transit wallet. Contact the operator with your swap id.".into());
        return;
    }

    // Is the wallet able to pay? Spendable must cover this and every other
    // swap that is due, so one swap cannot spend another's note.
    let report = match hosted.wallet.report().await {
        Ok(r) => r,
        Err(e) => return back_off(swap, now, format!("wallet report: {e}")),
    };
    if report.upgrade.as_ref().is_some_and(|u| u.sending_paused) {
        return back_off(swap, now, "sending paused for the network upgrade".into());
    }
    let committed = hosted.store.committed_zat().unwrap_or(0);
    if report.balance.ironwood_spendable < committed.max(amount) {
        tracing::warn!(
            id = %swap.id,
            amount,
            committed,
            spendable = report.balance.ironwood_spendable,
            "hop two held: spendable below what is committed"
        );
        return back_off(
            swap,
            now,
            format!(
                "spendable {} below committed {}",
                report.balance.ironwood_spendable, committed
            ),
        );
    }

    let body = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": swap.slippage_bps,
        "originAsset": ZEC_ASSET,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": swap.destination_asset,
        "amount": amount.to_string(),
        "refundTo": swap.landing_transparent,
        "refundType": "ORIGIN_CHAIN",
        "recipient": swap.destination_address,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": crate::hosted::rfc3339(now.saturating_add(HOP2_DEADLINE_SECS)),
        "depositMode": "SIMPLE",
    });
    // The routing fee was taken on hop one. Hop two carries none.
    let quote = match state.oneclick.quote(body, None::<Vec<AppFee>>).await {
        Ok(q) => q,
        // The route refused this quote: that counts. Not reaching it does not.
        Err(ApiError::BadRequest(m)) => {
            swap.attempts += 1;
            swap.last_error = Some(format!("hop two quote: {m}"));
            swap.release_at_unix = Some(now.saturating_add(RETRY_DELAY_SECS));
            return;
        }
        Err(e) => return back_off(swap, now, format!("hop two quote: {e}")),
    };
    let Some(deposit) = quote
        .get("quote")
        .and_then(|q| q.get("depositAddress"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return back_off(swap, now, "hop two quote without a deposit address".into());
    };
    if !deposit.starts_with("t1") && !deposit.starts_with("t3") {
        return back_off(
            swap,
            now,
            "hop two deposit address is not transparent".into(),
        );
    }
    let deadline = quote
        .get("quote")
        .and_then(|q| q.get("deadline"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339)
        .unwrap_or(now.saturating_add(HOP2_DEADLINE_SECS));
    if deadline < now.saturating_add(10 * 60) {
        return back_off(
            swap,
            now,
            "hop two deadline too close to prove in time".into(),
        );
    }
    swap.hop2_quote = Some(quote);
    swap.hop2_deposit_address = Some(deposit.clone());

    // The attempt is on disk before the wallet sees it. If the process dies
    // between the broadcast and the next write, the marker without a txid
    // stops the driver from paying this swap twice.
    swap.hop2_paying_unix = Some(now);
    swap.updated_unix = now;
    if let Err(e) = hosted.store.update(swap) {
        swap.hop2_paying_unix = None;
        tracing::error!(id = %swap.id, error = %e, "could not record the payout attempt; not paying");
        return back_off(swap, now, format!("record payout attempt: {e}"));
    }

    let paid = match hosted.wallet.pay(deposit.clone(), amount).await {
        Ok(p) => p,
        Err(e) => {
            // The transaction may have been broadcast before the error.
            tracing::warn!(id = %swap.id, error = %e, "hop two payout failed with an unknown result");
            swap.state = State::Failed;
            swap.note = Some(UNRESOLVED_NOTE.into());
            swap.last_error = Some(format!("hop two payout: {e}"));
            return;
        }
    };
    swap.hop2_txid = Some(paid.txid.clone());
    swap.state = State::RoutingOut;
    swap.last_error = None;
    if let Some(e) = &paid.broadcast_error {
        // Built and stored, broadcast unsure. The route's status decides:
        // it either sees the transaction or reports nothing, and a REFUNDED
        // or FAILED status brings the swap back to the pool as before.
        tracing::warn!(id = %swap.id, txid = %paid.txid, error = %e, "hop two broadcast unsure");
        swap.last_error = Some(format!("hop two broadcast: {e}"));
        swap.note = Some("The payout was built but its broadcast did not confirm. The server keeps watching the route.".into());
    }
    swap.updated_unix = now_unix();
    if let Err(e) = hosted.store.update(swap) {
        tracing::error!(id = %swap.id, error = %e, "could not store the payout txid");
    }
    if let Err(e) = state.oneclick.submit_deposit(&paid.txid, &deposit).await {
        // 1Click finds the deposit on its own; this only speeds it up.
        swap.last_error = Some(format!("deposit submit: {e}"));
    }
}

async fn hop_two_status(state: &AppState, swap: &mut Swap, now: u64) {
    let Some(deposit) = swap.hop2_deposit_address.clone() else {
        swap.state = State::InPool;
        return;
    };
    let status = match state.oneclick.status(&deposit, None).await {
        Ok(v) => v,
        Err(e) => {
            swap.last_error = Some(format!("hop two status: {e}"));
            return;
        }
    };
    let facts = status_facts(&status);
    swap.last_error = None;
    match facts.status.as_str() {
        "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" => {
            // Still filling. If the payout never confirmed and the deadline
            // passed, the route returns it and the next poll sees REFUNDED.
        }
        "SUCCESS" => {
            swap.delivered_amount = facts.amount_out_formatted;
            swap.delivered_tx = facts.destination_tx;
            swap.state = State::Done;
        }
        "REFUNDED" | "FAILED" => {
            // The ZEC comes back to our transparent receiver; the shield
            // cycle sweeps it. Try again later from the pool. This is a real
            // attempt that did not work.
            swap.attempts += 1;
            swap.state = State::InPool;
            swap.release_at_unix = Some(now.saturating_add(RETRY_DELAY_SECS));
            swap.hop2_deposit_address = None;
            swap.hop2_txid = None;
            swap.hop2_paying_unix = None;
            swap.last_error = Some(format!("hop two {}", facts.status.to_lowercase()));
        }
        other => {
            swap.last_error = Some(format!("unknown 1Click status {other}"));
        }
    }
}

/// Which 1Click asset the user may receive. ZEC is refused here: for ZEC
/// into their own wallet, users take the non-custodial path.
pub fn check_destination(asset: &str) -> Result<(), crate::error::ApiError> {
    if asset == ZEC_ASSET {
        return Err(crate::error::ApiError::BadRequest(
            "Hosted swaps deliver an asset other than ZEC. To receive ZEC, use your own wallet."
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hop_two_amount_is_capped_and_never_rounded() {
        let max = 100_000_000;
        assert_eq!(hop2_amount(1_000_000, Mode::Fast, max), 980_000);
        assert_eq!(hop2_amount(1_000_000, Mode::Quiet, max), 980_000);
        assert_eq!(hop2_amount(493_020_000, Mode::Fast, max), 99_980_000);
        assert_eq!(hop2_amount(493_020_000, Mode::Quiet, max), 99_980_000);
        assert_eq!(hop2_amount(10_000, Mode::Fast, max), 0);
    }
}
