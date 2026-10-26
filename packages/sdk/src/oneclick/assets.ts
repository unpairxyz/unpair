/** Asset facts the fee rules need. Asset ids come from the live token list. */

export const ZEC_DECIMALS = 8;

/** Symbols that 1Click charges 1 bp on when paired with each other. */
export const STABLE_SYMBOLS: ReadonlySet<string> = new Set(["USDC", "USDT", "DAI"]);

export interface AssetLike {
  symbol: string;
}

/**
 * True when 1Click's reduced 1 bp floor applies: both sides are USDC, USDT
 * or DAI, or both sides are the same asset on different chains.
 */
export function isStableRoute(origin: AssetLike, destination: AssetLike): boolean {
  const a = origin.symbol.toUpperCase();
  const b = destination.symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(a) && STABLE_SYMBOLS.has(b)) return true;
  return a === b;
}
