/**
 * Amount rounding for quiet mode.
 *
 * A shielded payout that matches a public deposit to the last unit is a
 * link. Rounding the released amount to a shared grid puts many users on
 * the same values. Anonymity comes from collision, not noise.
 *
 * Both functions round down and return the remainder. The remainder stays
 * in the user's shielded wallet. Nothing is burned or kept by Unpair.
 */

export interface RoundedAmount {
  /** The rounded value, in base units. */
  amount: bigint;
  /** What was cut off, in base units. Stays with the user. */
  remainder: bigint;
  /** The grid step the value sits on, in base units. */
  step: bigint;
}

export class RoundingError extends Error {
  override readonly name = "RoundingError";
}

export interface RoundOptions {
  /**
   * Smallest amount allowed, in base units. Below this the amount cannot be
   * rounded to a useful grid. Default 1.
   */
  minUnits?: bigint;
}

/**
 * Round down to `significantDigits` significant digits.
 * With 1 digit: 4.93 ZEC -> 4 ZEC, 0.37 ZEC -> 0.3 ZEC, 123.4 ZEC -> 100 ZEC.
 * Nine values per decade. Loses at most 90% of a decade in the worst case
 * and about 5% on average at 1 digit.
 */
export function roundDownSignificant(amount: bigint, significantDigits = 1, options: RoundOptions = {}): RoundedAmount {
  assertAmount(amount, options);
  if (!Number.isInteger(significantDigits) || significantDigits < 1) {
    throw new RoundingError("significantDigits must be an integer of 1 or more");
  }
  const digits = amount.toString().length;
  const dropped = Math.max(0, digits - significantDigits);
  const step = 10n ** BigInt(dropped);
  const rounded = (amount / step) * step;
  return { amount: rounded, remainder: amount - rounded, step };
}

/** Mantissas of the coarse grid: 1, 2, 5 in every decade. */
export const COARSE_MANTISSAS: readonly bigint[] = [1n, 2n, 5n];

/**
 * Round down to the largest value of the form m * 10^k with m in {1, 2, 5}.
 * 4.93 ZEC -> 2 ZEC, 0.37 ZEC -> 0.2 ZEC, 7 ZEC -> 5 ZEC.
 * Three values per decade. Far more collisions, far more value left behind
 * (up to 60%). Use when the user accepts a smaller release to look like
 * everyone else.
 */
export function roundDownCoarse(amount: bigint, options: RoundOptions = {}): RoundedAmount {
  assertAmount(amount, options);
  const digits = amount.toString().length;
  const decade = 10n ** BigInt(digits - 1);
  let best = decade;
  for (const m of COARSE_MANTISSAS) {
    const candidate = m * decade;
    if (candidate <= amount && candidate > best) best = candidate;
  }
  return { amount: best, remainder: amount - best, step: best };
}

/** Format base units as a decimal string, for display. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RoundingError("decimals must be a non-negative integer");
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals === 0 ? "" : s.slice(s.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Parse a decimal string into base units. Throws on too many decimals. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new RoundingError(`not a decimal number: ${value}`);
  const [, sign, whole = "0", frac = ""] = match;
  if (frac.length > decimals) throw new RoundingError(`too many decimals in ${value}, max ${decimals}`);
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  return sign ? -units : units;
}

function assertAmount(amount: bigint, options: RoundOptions): void {
  if (typeof amount !== "bigint") throw new RoundingError("amount must be a bigint in base units");
  const min = options.minUnits ?? 1n;
  if (amount < min) throw new RoundingError(`amount ${amount} is below the minimum of ${min} base units`);
}
