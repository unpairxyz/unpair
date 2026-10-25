/**
 * Well-known 1Click asset ids. Taken from GET /v0/tokens on 2026-10-25.
 * Always confirm against a live token list before quoting; ids can change.
 */
export const ASSETS = {
  ZEC: "nep141:zec.omft.near",
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  ETH_ARB: "nep141:arb.omft.near",
  ETH_BASE: "nep141:base.omft.near",
  USDC_ETH: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  USDC_ARB: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  USDC_BASE: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  USDC_SOL: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
} as const;

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
