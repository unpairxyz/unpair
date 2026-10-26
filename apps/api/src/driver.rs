//! Moves hosted swaps forward. Runs on the main runtime every interval, reads
//! the open swaps from the store, asks 1Click and the transit wallet what
//! happened, and writes the new state back.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ApiError;
use crate::hosted::{
    parse_rfc3339, release_delay_secs, split_amount, status_facts, Mode, Part, PartState, State,
    Swap, DEPOSIT_WINDOW_SECS, HOP2_FEE_RESERVE_ZAT, MAX_ATTEMPTS, MIN_ZAT, ZEC_ASSET,
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
/// Reads the swap's own columns, which the driver mirrors from the last part.
pub fn payout_unresolved(swap: &Swap) -> bool {
    swap.hop2_paying_unix.is_some() && swap.hop2_txid.is_none()
}

/// The same question for one part.
pub fn part_unresolved(part: &Part) -> bool {
    part.paying_unix.is_some() && part.txid.is_none()
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
        State::InPool | State::RoutingOut => drive_parts(state, swap, now).await,
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
            // Cut hop two into parts, each with its own release time. A tick
            // that already made them (and then failed to store the swap)
            // finds them again instead of making more.
            let parts = match hosted.store.parts_of(&swap.id) {
                Ok(p) if !p.is_empty() => p,
                Ok(_) => {
                    let quiet = swap.mode == Mode::Quiet && hosted.config.split;
                    let split = split_amount(received.min(hosted.config.max_zat), quiet);
                    let parts: Vec<Part> = split
                        .parts
                        .iter()
                        .enumerate()
                        .map(|(i, &amount)| Part {
                            swap_id: swap.id.clone(),
                            idx: i as u32,
                            amount_zat: amount,
                            release_at_unix: now.saturating_add(release_delay_secs(swap.mode)),
                            deposit_address: None,
                            quote: None,
                            paying_unix: None,
                            txid: None,
                            state: PartState::Waiting,
                            delivered_amount: None,
                            delivered_tx: None,
                            attempts: 0,
                            last_error: None,
                            updated_unix: now,
                        })
                        .collect();
                    if let Err(e) = hosted.store.insert_parts(&parts) {
                        swap.last_error = Some(format!("store parts: {e}"));
                        return;
                    }
                    swap.dust_zat = Some(split.dust_zat);
                    parts
                }
                Err(e) => {
                    swap.last_error = Some(format!("read parts: {e}"));
                    return;
                }
            };
            swap.hop2_amount_in = Some(parts.iter().map(|p| p.amount_zat).sum());
            swap.release_at_unix = parts.iter().map(|p| p.release_at_unix).min();
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

/// Try again later. Passing faults do not count as attempts.
fn back_off(part: &mut Part, now: u64, error: String) {
    back_off_for(part, now, error, TRANSIENT_BACKOFF_SECS);
}

/// A short wait for a note that is only waiting for confirmations: the next
/// tick looks again, so a landing moves on within a minute of being spendable.
const CONFIRMING_BACKOFF_SECS: u64 = 60;

fn back_off_for(part: &mut Part, now: u64, error: String, secs: u64) {
    part.last_error = Some(error);
    part.release_at_unix = now.saturating_add(secs);
}

/// Move every part of a swap forward: poll the ones the route is filling,
/// pay the ones whose release time came, then set the swap's state from
/// the parts. The swap's own hop-two columns mirror the last part touched,
/// for the page and the operator.
async fn drive_parts(state: &AppState, swap: &mut Swap, now: u64) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
    let mut parts = match hosted.store.parts_of(&swap.id) {
        Ok(p) => p,
        Err(e) => {
            swap.last_error = Some(format!("read parts: {e}"));
            return;
        }
    };
    if parts.is_empty() {
        swap.state = State::Failed;
        swap.last_error = Some("in pool without parts".into());
        swap.note = Some("The second hop could not be started. The ZEC is safe in the transit wallet. Contact the operator with your swap id.".into());
        return;
    }
    for part in parts.iter_mut() {
        let before = (part.state, part.txid.clone(), part.release_at_unix);
        match part.state {
            PartState::Routing => part_status(state, part, now).await,
            PartState::Waiting if part.release_at_unix <= now => {
                pay_part(state, swap, part, now).await
            }
            _ => {}
        }
        if (part.state, part.txid.clone(), part.release_at_unix) != before
            || part.last_error.is_some()
        {
            part.updated_unix = now_unix();
            if let Err(e) = hosted.store.update_part(part) {
                tracing::error!(id = %swap.id, idx = part.idx, error = %e, "could not store part");
            }
        }
    }

    let delivered = parts.iter().filter(|p| p.state == PartState::Done).count();
    let failed = parts
        .iter()
        .filter(|p| p.state == PartState::Failed)
        .count();
    let paid = parts.iter().filter(|p| p.txid.is_some()).count();
    swap.hop2_txid = parts.iter().rev().find_map(|p| p.txid.clone());
    swap.hop2_deposit_address = parts.iter().rev().find_map(|p| p.deposit_address.clone());
    swap.hop2_paying_unix = parts.iter().rev().find_map(|p| p.paying_unix);
    swap.attempts = parts.iter().map(|p| p.attempts).max().unwrap_or(0);
    swap.last_error = parts.iter().rev().find_map(|p| p.last_error.clone());
    swap.release_at_unix = parts
        .iter()
        .filter(|p| p.state == PartState::Waiting)
        .map(|p| p.release_at_unix)
        .min()
        .or(swap.release_at_unix);
    if failed > 0 {
        swap.state = State::Failed;
        let unresolved = parts.iter().any(part_unresolved);
        swap.note = Some(if unresolved {
            UNRESOLVED_NOTE.to_string()
        } else if parts.len() == 1 {
            "The second hop could not be completed. The ZEC is safe in the transit wallet. Contact the operator with your swap id.".to_string()
        } else {
            format!(
                "{delivered} of {} parts were delivered. The rest could not be sent on and the ZEC is safe in the transit wallet. Contact the operator with your swap id.",
                parts.len()
            )
        });
    } else if delivered == parts.len() {
        swap.state = State::Done;
        let last = parts.last().expect("checked");
        swap.delivered_tx = last.delivered_tx.clone();
        swap.delivered_amount = if parts.len() == 1 {
            last.delivered_amount.clone()
        } else {
            None
        };
    } else if paid > 0 {
        swap.state = State::RoutingOut;
    } else {
        swap.state = State::InPool;
    }
}

/// Quote one part, pay it from Ironwood, tell 1Click the txid.
async fn pay_part(state: &AppState, swap: &Swap, part: &mut Part, now: u64) {
    let Some(hosted) = state.hosted.as_ref() else {
        return;
    };
    if part_unresolved(part) {
        tracing::warn!(id = %swap.id, idx = part.idx, "payout with no txid; needs the operator");
        part.state = PartState::Failed;
        return;
    }
    if part.attempts >= MAX_ATTEMPTS {
        part.state = PartState::Failed;
        return;
    }
    let amount = part.amount_zat;

    // Is the wallet able to pay? Spendable must cover this and every other
    // part that is still unpaid, so one swap cannot spend another's note.
    let report = match hosted.wallet.report().await {
        Ok(r) => r,
        Err(e) => return back_off(part, now, format!("wallet report: {e}")),
    };
    if report.upgrade.as_ref().is_some_and(|u| u.sending_paused) {
        return back_off(part, now, "sending paused for the network upgrade".into());
    }
    let committed = hosted.store.committed_zat().unwrap_or(0);
    if report.balance.ironwood_spendable < committed.max(amount) {
        tracing::warn!(
            id = %swap.id,
            idx = part.idx,
            amount,
            committed,
            spendable = report.balance.ironwood_spendable,
            "payout held: spendable below what is committed"
        );
        return back_off_for(
            part,
            now,
            format!(
                "spendable {} below committed {}",
                report.balance.ironwood_spendable, committed
            ),
            CONFIRMING_BACKOFF_SECS,
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
            part.attempts += 1;
            part.last_error = Some(format!("hop two quote: {m}"));
            part.release_at_unix = now.saturating_add(RETRY_DELAY_SECS);
            return;
        }
        Err(e) => return back_off(part, now, format!("hop two quote: {e}")),
    };
    let Some(deposit) = quote
        .get("quote")
        .and_then(|q| q.get("depositAddress"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return back_off(part, now, "hop two quote without a deposit address".into());
    };
    if !deposit.starts_with("t1") && !deposit.starts_with("t3") {
        return back_off(
            part,
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
            part,
            now,
            "hop two deadline too close to prove in time".into(),
        );
    }
    part.quote = Some(quote);
    part.deposit_address = Some(deposit.clone());

    // The attempt is on disk before the wallet sees it. If the process dies
    // between the broadcast and the next write, the marker without a txid
    // stops the driver from paying this part twice.
    part.paying_unix = Some(now);
    part.updated_unix = now;
    if let Err(e) = hosted.store.update_part(part) {
        part.paying_unix = None;
        tracing::error!(id = %swap.id, idx = part.idx, error = %e, "could not record the payout attempt; not paying");
        return back_off(part, now, format!("record payout attempt: {e}"));
    }

    let paid = match hosted.wallet.pay(deposit.clone(), amount).await {
        Ok(p) => p,
        Err(e) => {
            // The transaction may have been broadcast before the error.
            tracing::warn!(id = %swap.id, idx = part.idx, error = %e, "payout failed with an unknown result");
            part.state = PartState::Failed;
            part.last_error = Some(format!("hop two payout: {e}"));
            return;
        }
    };
    part.txid = Some(paid.txid.clone());
    part.state = PartState::Routing;
    part.last_error = None;
    if let Some(e) = &paid.broadcast_error {
        // Built and stored, broadcast unsure. The route's status decides:
        // it either sees the transaction or reports nothing, and a REFUNDED
        // or FAILED status brings the part back to waiting as before.
        tracing::warn!(id = %swap.id, idx = part.idx, txid = %paid.txid, error = %e, "broadcast unsure");
        part.last_error = Some(format!("hop two broadcast: {e}"));
    }
    part.updated_unix = now_unix();
    if let Err(e) = hosted.store.update_part(part) {
        tracing::error!(id = %swap.id, idx = part.idx, error = %e, "could not store the payout txid");
    }
    if let Err(e) = state.oneclick.submit_deposit(&paid.txid, &deposit).await {
        // 1Click finds the deposit on its own; this only speeds it up.
        part.last_error = Some(format!("deposit submit: {e}"));
    }
}

async fn part_status(state: &AppState, part: &mut Part, now: u64) {
    let Some(deposit) = part.deposit_address.clone() else {
        part.state = PartState::Waiting;
        return;
    };
    let status = match state.oneclick.status(&deposit, None).await {
        Ok(v) => v,
        Err(e) => {
            part.last_error = Some(format!("hop two status: {e}"));
            return;
        }
    };
    let facts = status_facts(&status);
    part.last_error = None;
    match facts.status.as_str() {
        "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" => {
            // Still filling. If the payout never confirmed and the deadline
            // passed, the route returns it and the next poll sees REFUNDED.
        }
        "SUCCESS" => {
            part.delivered_amount = facts.amount_out_formatted;
            part.delivered_tx = facts.destination_tx;
            part.state = PartState::Done;
        }
        "REFUNDED" | "FAILED" => {
            // The ZEC comes back to our transparent receiver; the shield
            // cycle sweeps it. Try again later from the pool. This is a real
            // attempt that did not work.
            part.attempts += 1;
            part.state = PartState::Waiting;
            part.release_at_unix = now.saturating_add(RETRY_DELAY_SECS);
            part.deposit_address = None;
            part.txid = None;
            part.paying_unix = None;
            part.last_error = Some(format!("hop two {}", facts.status.to_lowercase()));
        }
        other => {
            part.last_error = Some(format!("unknown 1Click status {other}"));
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
    fn a_part_with_a_marker_and_no_txid_is_unresolved() {
        let mut p = Part {
            swap_id: "s".into(),
            idx: 0,
            amount_zat: 1,
            release_at_unix: 0,
            deposit_address: None,
            quote: None,
            paying_unix: Some(1),
            txid: None,
            state: PartState::Waiting,
            delivered_amount: None,
            delivered_tx: None,
            attempts: 0,
            last_error: None,
            updated_unix: 0,
        };
        assert!(part_unresolved(&p));
        p.txid = Some("t".into());
        assert!(!part_unresolved(&p));
    }

    #[test]
    fn the_basis_is_capped_before_the_cut() {
        let s = split_amount(493_020_000u64.min(100_000_000), false);
        assert_eq!(s.parts, vec![99_980_000]);
        let s = split_amount(493_020_000u64.min(100_000_000), true);
        assert!(s.parts.iter().sum::<u64>() <= 100_000_000);
    }
}
