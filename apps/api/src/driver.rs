//! Moves hosted swaps forward. Runs on the main runtime every interval, reads
//! the open swaps from the store, asks 1Click and the transit wallet what
//! happened, and writes the new state back.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::hosted::{
    parse_rfc3339, release_delay_secs, status_facts, State, Swap, DEPOSIT_WINDOW_SECS,
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
            if now > swap.hop1_deadline_unix + DEPOSIT_WINDOW_SECS {
                swap.state = State::Expired;
                swap.note = Some("No deposit arrived before the deadline. A deposit sent after it is returned by the route to the refund address.".into());
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
            swap.hop2_amount_in = Some(received - HOP2_FEE_RESERVE_ZAT);
            swap.release_at_unix = Some(now + release_delay_secs(swap.mode));
            swap.state = State::InPool;
        }
        "REFUNDED" => {
            swap.state = State::Refunded;
            swap.note = Some("The route did not complete the first hop and returned the deposit to the refund address.".into());
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

/// Quote hop two, pay it from Ironwood, tell 1Click the txid.
async fn hop_two(state: &AppState, swap: &mut Swap, now: u64) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
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
    swap.attempts += 1;

    // Is the wallet able to pay? Spendable must cover this and every other
    // swap that is due, so one swap cannot spend another's note.
    let report = match hosted.wallet.report().await {
        Ok(r) => r,
        Err(e) => {
            swap.last_error = Some(format!("wallet report: {e}"));
            return;
        }
    };
    if report.upgrade.as_ref().is_some_and(|u| u.sending_paused) {
        swap.last_error = Some("sending paused for the network upgrade".into());
        swap.attempts -= 1;
        return;
    }
    let committed = hosted.store.committed_zat().unwrap_or(0);
    if report.balance.ironwood_spendable < committed.max(amount) {
        swap.last_error = Some(format!(
            "spendable {} below committed {}",
            report.balance.ironwood_spendable, committed
        ));
        swap.attempts -= 1;
        return;
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
        "deadline": crate::hosted::rfc3339(now + HOP2_DEADLINE_SECS),
        "depositMode": "SIMPLE",
    });
    // The routing fee was taken on hop one. Hop two carries none.
    let quote = match state.oneclick.quote(body, None::<Vec<AppFee>>).await {
        Ok(q) => q,
        Err(e) => {
            swap.last_error = Some(format!("hop two quote: {e}"));
            return;
        }
    };
    let Some(deposit) = quote
        .get("quote")
        .and_then(|q| q.get("depositAddress"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        swap.last_error = Some("hop two quote without a deposit address".into());
        return;
    };
    if !deposit.starts_with("t1") && !deposit.starts_with("t3") {
        swap.last_error = Some("hop two deposit address is not transparent".into());
        return;
    }
    let deadline = quote
        .get("quote")
        .and_then(|q| q.get("deadline"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339)
        .unwrap_or(now + HOP2_DEADLINE_SECS);
    if deadline < now + 10 * 60 {
        swap.last_error = Some("hop two deadline too close to prove in time".into());
        return;
    }
    swap.hop2_quote = Some(quote);
    swap.hop2_deposit_address = Some(deposit.clone());

    let paid = match hosted.wallet.pay(deposit.clone(), amount).await {
        Ok(p) => p,
        Err(e) => {
            swap.last_error = Some(format!("hop two payout: {e}"));
            return;
        }
    };
    swap.hop2_txid = Some(paid.txid.clone());
    swap.state = State::RoutingOut;
    swap.last_error = None;
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
            // cycle sweeps it. Try again later from the pool.
            swap.state = State::InPool;
            swap.release_at_unix = Some(now + RETRY_DELAY_SECS);
            swap.hop2_deposit_address = None;
            swap.hop2_txid = None;
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
