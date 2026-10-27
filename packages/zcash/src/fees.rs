//! ZIP-317 fee estimates for the shielding step.
//!
//! The wallet library computes the exact fee when it builds the transaction.
//! These helpers give the same number up front so the UI can show it before
//! anything moves. Formula (ZIP 317): fee = marginal_fee * max(grace_actions,
//! logical_actions), with logical_actions = max(ceil(tin_bytes / 150),
//! ceil(tout_bytes / 34)) + max(sapling_spends, sapling_outputs) + shielded_actions.
//! Ironwood actions are priced like Orchard actions.

use zcash_primitives::transaction::fees::zip317::{
    GRACE_ACTIONS, MARGINAL_FEE, P2PKH_STANDARD_INPUT_SIZE, P2PKH_STANDARD_OUTPUT_SIZE,
};
use zcash_protocol::value::Zatoshis;

/// Orchard and Ironwood bundles carry at least two actions. A shield has one real output.
pub const MIN_ORCHARD_ACTIONS: usize = 2;

/// Fee for a transaction that spends `transparent_inputs` P2PKH outputs, creates
/// `transparent_outputs` P2PKH outputs and `orchard_outputs` Orchard-protocol notes
/// (Orchard or Ironwood) with no shielded spends.
pub fn zip317_fee(
    transparent_inputs: usize,
    transparent_outputs: usize,
    orchard_outputs: usize,
) -> Zatoshis {
    let tin = transparent_inputs * P2PKH_STANDARD_INPUT_SIZE;
    let tout = transparent_outputs * P2PKH_STANDARD_OUTPUT_SIZE;
    let transparent_actions = tin
        .div_ceil(P2PKH_STANDARD_INPUT_SIZE)
        .max(tout.div_ceil(P2PKH_STANDARD_OUTPUT_SIZE));
    let orchard_actions = if orchard_outputs == 0 {
        0
    } else {
        orchard_outputs.max(MIN_ORCHARD_ACTIONS)
    };
    let logical = transparent_actions + orchard_actions;
    let actions = logical.max(GRACE_ACTIONS) as u64;
    Zatoshis::from_u64(MARGINAL_FEE.into_u64() * actions).expect("fee fits")
}

/// Fee to shield `utxos` transparent outputs into one Ironwood note.
pub fn shield_fee(utxos: usize) -> Zatoshis {
    zip317_fee(utxos, 0, 1)
}

/// Fee for a payout that spends `notes` Ironwood notes to one transparent
/// output with one Ironwood change note. Ironwood actions carry one spend and
/// one output each, so actions = max(spends, outputs), at least two.
pub fn payout_fee(notes: usize) -> Zatoshis {
    let ironwood_actions = notes.max(1).max(MIN_ORCHARD_ACTIONS);
    let logical = 1 + ironwood_actions;
    let actions = logical.max(GRACE_ACTIONS) as u64;
    Zatoshis::from_u64(MARGINAL_FEE.into_u64() * actions).expect("fee fits")
}

/// The smallest hop-two reserve, in zatoshis: the fee for a one note payout
/// plus one margin action. The page uses it before a wallet exists.
pub const HOP2_RESERVE_FLOOR_ZAT: u64 = 20_000;

/// What a wallet keeps back from its spendable balance before quoting hop
/// two: [`payout_fee`] for `notes` plus one more action, in case a note lands
/// between the quote and the proof. Never below [`HOP2_RESERVE_FLOOR_ZAT`].
pub fn hop2_reserve(notes: usize) -> Zatoshis {
    let reserve = payout_fee(notes.max(1)).into_u64() + MARGINAL_FEE.into_u64();
    Zatoshis::from_u64(reserve.max(HOP2_RESERVE_FLOOR_ZAT)).expect("fee fits")
}

/// Zatoshis as a decimal ZEC string with trailing zeros removed.
pub fn format_zec(amount: Zatoshis) -> String {
    let units = amount.into_u64();
    let whole = units / 100_000_000;
    let frac = units % 100_000_000;
    if frac == 0 {
        return format!("{whole} ZEC");
    }
    let frac = format!("{frac:08}");
    format!("{whole}.{} ZEC", frac.trim_end_matches('0'))
}

/// Plain words for the UI. No em dashes.
pub fn describe_shield_fee(utxos: usize) -> String {
    format!(
        "Network fee to shield: {}. Unpair takes nothing on this step.",
        format_zec(shield_fee(utxos))
    )
}

/// Plain words for the UI. No em dashes.
pub fn describe_payout_fee(notes: usize) -> String {
    format!(
        "Network fee to send from the shielded pool: {}. Unpair takes nothing on this step.",
        format_zec(payout_fee(notes))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payout_fee_matches_zip317() {
        assert_eq!(payout_fee(1).into_u64(), 15_000);
        assert_eq!(payout_fee(2).into_u64(), 15_000);
        assert_eq!(payout_fee(3).into_u64(), 20_000);
        assert!(describe_payout_fee(1).contains("0.00015 ZEC"));
    }

    #[test]
    fn hop2_reserve_is_the_payout_fee_plus_one_action() {
        assert_eq!(hop2_reserve(0).into_u64(), HOP2_RESERVE_FLOOR_ZAT);
        assert_eq!(hop2_reserve(1).into_u64(), 20_000);
        assert_eq!(hop2_reserve(2).into_u64(), 20_000);
        assert_eq!(hop2_reserve(3).into_u64(), 25_000);
        assert_eq!(hop2_reserve(10).into_u64(), 60_000);
    }

    #[test]
    fn one_utxo_shield_costs_15000_zats() {
        assert_eq!(shield_fee(1).into_u64(), 15_000);
    }

    #[test]
    fn more_inputs_cost_more() {
        assert_eq!(shield_fee(2).into_u64(), 20_000);
        assert_eq!(shield_fee(5).into_u64(), 35_000);
    }

    #[test]
    fn grace_floor_applies() {
        assert_eq!(zip317_fee(1, 1, 0).into_u64(), 10_000);
        assert_eq!(zip317_fee(0, 0, 0).into_u64(), 10_000);
    }

    #[test]
    fn formats_zec() {
        assert_eq!(format_zec(Zatoshis::const_from_u64(15_000)), "0.00015 ZEC");
        assert_eq!(format_zec(Zatoshis::const_from_u64(100_000_000)), "1 ZEC");
        assert_eq!(format_zec(Zatoshis::const_from_u64(250_000_000)), "2.5 ZEC");
    }

    #[test]
    fn words_have_no_em_dash() {
        assert_eq!(
            describe_shield_fee(1),
            "Network fee to shield: 0.00015 ZEC. Unpair takes nothing on this step."
        );
        assert!(!describe_shield_fee(3).contains('\u{2014}'));
    }
}
