/**
 * The hop-two fee reserve before a wallet exists: the crate's
 * `fees::hop2_reserve(1)`, the ZIP 317 fee for a one note payout plus one
 * margin action. Once a wallet is open, `Balance.hop2_reserve` carries the
 * live number for the notes it holds, computed by the same Rust code.
 */
export const HOP2_FEE_RESERVE_FLOOR_ZAT = 20_000n;
