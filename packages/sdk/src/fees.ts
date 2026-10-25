/**
 * Fee rules.
 *
 * Every fee is shown before the trade and capped in code. The cap is a
 * constant, not a config value, so a deployment cannot raise it quietly.
 *
 * 1Click split rules (docs.near-intents.org, fee-config, read 2026-10-25):
 * - With an API key and no appFees: 1Click charges 20 bps (1 bp on
 *   USDC, USDT, DAI pairs and same-asset routes).
 * - With an API key and appFees: the fee is split 50/50. 1Click's half has
 *   a 20 bps floor (1 bp on stable and same-asset routes). The partner's
 *   half rounds up.
 * - Without an API key the docs say the partner keeps the whole fee and
 *   1Click adds 25 bps on top. Live dry quotes on 2026-10-25 without a key
 *   did not do that: they echoed the same 50/50 split with the 20 bps floor
 *   (fee 5 -> 3 + 20, fee 50 -> 25 + 25, fee 100 -> 50 + 50, fee 0 -> 20),
 *   and the output moved by exactly those totals. The estimate below follows
 *   the observed behaviour. After a quote, use `feeFromQuoteResponse` to
 *   show the exact split 1Click echoed; that is the number the user pays.
 * - The combined total cannot exceed 500 bps. ANY_INPUT quotes cannot carry
 *   appFees.
 */

export const BPS_DENOMINATOR = 10_000n;

/** Hard cap on the fee Unpair asks for, in basis points. 1%. */
export const FEE_CAP_BPS = 100;

/** Default fee Unpair asks for, in basis points. 0.5%. */
export const DEFAULT_FEE_BPS = 50;

/**
 * Documented surcharge when the request has no API key. Not observed in
 * live quotes on 2026-10-25. Kept for reference and for the docs table.
 */
export const ONECLICK_DOCUMENTED_UNAUTHENTICATED_BPS = 25;

/** 1Click's floor for its own half when the request has an API key. */
export const ONECLICK_MIN_BPS = 20;

/** 1Click's floor on stablecoin pairs and same-asset routes. */
export const ONECLICK_MIN_STABLE_BPS = 1;

/** 1Click rejects quotes whose combined fee passes this. */
export const ONECLICK_COMBINED_CAP_BPS = 500;

export interface FeeConfig {
  /** NEAR account or EVM-style address that receives the partner fee. */
  recipient: string;
  /** Fee asked for, in basis points. Integer, 0 to FEE_CAP_BPS. */
  feeBps: number;
}

export interface FeeContext {
  /**
   * True when the request carries a 1Click API key. Kept in the breakdown
   * for display. It does not change the estimate today; see the note at
   * the top of this file.
   */
  hasApiKey: boolean;
  /** True for USDC, USDT, DAI pairs and same-asset cross-chain routes. */
  stableRoute?: boolean;
}

export interface FeeBreakdown {
  /** Basis points Unpair receives. */
  partnerBps: number;
  /** Basis points 1Click receives. */
  oneClickBps: number;
  /** Basis points charged to the user, taken from the input amount. */
  totalBps: number;
  /** The fee that was requested before the split. */
  requestedBps: number;
  hasApiKey: boolean;
  stableRoute: boolean;
}

export class FeeError extends Error {
  override readonly name = "FeeError";
}

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps)) throw new FeeError(`fee must be an integer number of basis points, got ${feeBps}`);
  if (feeBps < 0) throw new FeeError(`fee cannot be negative, got ${feeBps}`);
  if (feeBps > FEE_CAP_BPS) throw new FeeError(`fee ${feeBps} bps is above the cap of ${FEE_CAP_BPS} bps`);
}

export function assertFeeConfig(config: FeeConfig): void {
  if (typeof config.recipient !== "string" || config.recipient.trim() === "") {
    throw new FeeError("fee recipient is required");
  }
  assertFeeBps(config.feeBps);
}

/** What the user pays and who gets it, under 1Click's split rules. */
export function oneClickFeeBreakdown(requestedBps: number, context: FeeContext): FeeBreakdown {
  assertFeeBps(requestedBps);
  const stableRoute = context.stableRoute ?? false;

  const floor = stableRoute ? ONECLICK_MIN_STABLE_BPS : ONECLICK_MIN_BPS;
  const partnerBps = Math.ceil(requestedBps / 2);
  const oneClickBps = Math.max(requestedBps - partnerBps, floor);

  const totalBps = partnerBps + oneClickBps;
  if (totalBps > ONECLICK_COMBINED_CAP_BPS) {
    throw new FeeError(`combined fee ${totalBps} bps is above 1Click's cap of ${ONECLICK_COMBINED_CAP_BPS} bps`);
  }
  return { partnerBps, oneClickBps, totalBps, requestedBps, hasApiKey: context.hasApiKey, stableRoute };
}

/** Fee taken from an exact input amount. Floors, as 1Click does. */
export function feeFromInput(amountIn: bigint, totalBps: number): { fee: bigint; netIn: bigint } {
  assertBigint(amountIn);
  const fee = (amountIn * BigInt(totalBps)) / BPS_DENOMINATOR;
  return { fee, netIn: amountIn - fee };
}

/** Gross input needed so that `requiredIn` is left after the fee. Ceils, as 1Click does. */
export function grossInputForRequired(requiredIn: bigint, totalBps: number): { grossIn: bigint; fee: bigint } {
  assertBigint(requiredIn);
  const keep = BPS_DENOMINATOR - BigInt(totalBps);
  const grossIn = (requiredIn * BPS_DENOMINATOR + keep - 1n) / keep;
  return { grossIn, fee: grossIn - requiredIn };
}

/** Basis points as a percent string, for example 50 -> "0.5%". */
export function bpsToPercent(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0+$/, "")}%`;
}

/**
 * The fee in plain words, for the quote screen. No em dashes.
 * Example: "Fee 0.5% of the amount you send. Unpair keeps 0.25%, the
 * route operator keeps 0.25%."
 */
export function describeFee(b: FeeBreakdown, operator = "the route operator"): string {
  return `Fee ${bpsToPercent(b.totalBps)} of the amount you send. Unpair keeps ${bpsToPercent(b.partnerBps)}, ${operator} keeps ${bpsToPercent(b.oneClickBps)}.`;
}

export interface EchoedAppFee {
  recipient: string;
  fee: number;
}

/**
 * The exact split from the `appFees` 1Click echoes in a quote response.
 * Entries for `partnerRecipient` are Unpair's; every other entry is the
 * operator's. This is the number to show once a quote exists.
 */
export function feeFromEchoedAppFees(
  appFees: readonly EchoedAppFee[] | undefined,
  partnerRecipient: string | null,
  context: FeeContext,
): FeeBreakdown {
  let partnerBps = 0;
  let oneClickBps = 0;
  for (const f of appFees ?? []) {
    if (partnerRecipient !== null && f.recipient === partnerRecipient) partnerBps += f.fee;
    else oneClickBps += f.fee;
  }
  return {
    partnerBps,
    oneClickBps,
    totalBps: partnerBps + oneClickBps,
    requestedBps: partnerBps,
    hasApiKey: context.hasApiKey,
    stableRoute: context.stableRoute ?? false,
  };
}

function assertBigint(v: bigint): void {
  if (typeof v !== "bigint" || v < 0n) throw new FeeError("amount must be a non-negative bigint in base units");
}
