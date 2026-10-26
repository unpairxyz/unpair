/**
 * ZIP 317 fee for hop two, kept back from the spendable balance.
 *
 * Hop two spends n Ironwood notes, pays one transparent output and takes
 * Ironwood change. The fee is 5,000 zat per logical action: one for the
 * transparent output, and max(n, 2) for the shielded side, since shielded
 * actions are padded to two. One more action is kept as margin for a note
 * that lands between the quote and the proof. The floor is the old fixed
 * reserve, so a wallet that reports no count behaves as before.
 */
const ZIP317_MARGINAL_ZAT = 5_000n;
export const HOP2_FEE_RESERVE_FLOOR_ZAT = 20_000n;

export function hop2FeeReserveZat(spendableNotes: number): bigint {
  const notes = Number.isFinite(spendableNotes) && spendableNotes > 0 ? Math.floor(spendableNotes) : 1;
  const actions = 1n + BigInt(Math.max(notes, 2));
  const reserve = ZIP317_MARGINAL_ZAT * (actions + 1n);
  return reserve > HOP2_FEE_RESERVE_FLOOR_ZAT ? reserve : HOP2_FEE_RESERVE_FLOOR_ZAT;
}
