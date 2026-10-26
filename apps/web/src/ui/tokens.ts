import type { TokenInfo } from "@unpair/sdk";
import { chainName } from "@unpair/client";

// Chains that @unpair/client's CHAIN_NAMES does not name yet.
const MORE_NAMES: Record<string, string> = {
  zec: "Zcash", dash: "Dash", plasma: "Plasma", hood: "Robinhood Chain", abs: "Abstract", adi: "ADI",
  hypercore: "Hyperliquid", fogo: "Fogo", movement: "Movement", aleo: "Aleo", qtc: "QTC",
};
export const chainLabel = (chain: string): string => MORE_NAMES[chain] ?? chainName(chain);

// Icons are self-hosted so the page makes no third-party requests.
// scripts/fetch-icons.mjs fills public/icons/ at build time. A missing icon shows a monogram.
const ICON_BASE = ((import.meta.env.VITE_ICON_BASE as string | undefined)?.trim() || `${import.meta.env.BASE_URL}icons`).replace(/\/$/, "");

// Bump when icon files are added or replaced, so caches on the way fetch them again.
const ICON_VERSION = "2";
// File names match scripts/fetch-icons.mjs fileOf: anything outside [a-z0-9-] becomes a dash.
const iconFile = (id: string): string => `${ICON_BASE}/${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.png?v=${ICON_VERSION}`;
export const tokenIcon = (t: TokenInfo): string | null => (t.coingeckoId ? iconFile(t.coingeckoId) : null);
export const chainIcon = (chain: string): string => iconFile(`chain-${chain}`);

/** The token is the chain's own coin, so a chain badge adds nothing. */
const NATIVE: Record<string, string> = {
  ETH: "eth", BTC: "btc", SOL: "sol", ZEC: "zec", BNB: "bsc", TRX: "tron", TON: "ton", XRP: "xrp", DOGE: "doge", LTC: "ltc",
  NEAR: "near", SUI: "sui", APT: "aptos", ADA: "cardano", XLM: "stellar", AVAX: "avax", POL: "pol", BCH: "bch", DASH: "dash",
};
export const isNative = (t: TokenInfo): boolean => NATIVE[t.symbol] === t.blockchain;

// 1Click gives no ranking, so popular symbols and chains come first by hand.
const POPULAR_SYMBOLS = ["USDC", "USDT", "ETH", "BTC", "SOL", "ZEC", "BNB", "TRX", "WBTC", "DAI", "XRP", "DOGE", "TON", "NEAR", "SUI", "LTC", "ADA"];
export const POPULAR_CHAINS = ["eth", "base", "arb", "sol", "btc", "zec", "bsc", "tron", "near"];
const rankOf = (list: string[], v: string): number => {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
};

export function sortTokens(tokens: TokenInfo[]): TokenInfo[] {
  return [...tokens].sort(
    (a, b) =>
      rankOf(POPULAR_SYMBOLS, a.symbol) - rankOf(POPULAR_SYMBOLS, b.symbol) ||
      Number(isNative(b)) - Number(isNative(a)) ||
      rankOf(POPULAR_CHAINS, a.blockchain) - rankOf(POPULAR_CHAINS, b.blockchain) ||
      a.symbol.localeCompare(b.symbol),
  );
}

export function sortChains(chains: Iterable<string>): string[] {
  return [...new Set(chains)].sort((a, b) => rankOf(POPULAR_CHAINS, a) - rankOf(POPULAR_CHAINS, b) || chainLabel(a).localeCompare(chainLabel(b)));
}

export function searchTokens(tokens: TokenInfo[], query: string, chain: string | null): TokenInfo[] {
  const q = query.trim().toLowerCase();
  const rows = sortTokens(tokens.filter((t) => !chain || t.blockchain === chain));
  if (!q) return rows;
  const score = (t: TokenInfo) => {
    const s = t.symbol.toLowerCase();
    return s === q ? 0 : s.startsWith(q) ? 1 : 2;
  };
  return rows
    .filter((t) => t.symbol.toLowerCase().includes(q) || chainLabel(t.blockchain).toLowerCase().includes(q) || t.blockchain.includes(q))
    .sort((a, b) => score(a) - score(b));
}

export function formatPrice(usd: number): string {
  if (!usd) return "";
  return "$" + usd.toLocaleString("en-US", { maximumFractionDigits: usd >= 1 ? 2 : 6 });
}

/** Short label for a monogram icon. */
export const monogram = (s: string, n = s.length > 4 ? 2 : 3): string => s.replace(/[^A-Za-z0-9]/g, "").slice(0, n).toUpperCase();

// Recent picks, newest first, kept in this browser only. Storage can be off (private mode), so every access is guarded.
const RECENT_KEY = "unpair-recent-tokens";
const RECENT_MAX = 8;

export function recentTokens(tokens: TokenInfo[]): TokenInfo[] {
  let ids: string[] = [];
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === "string");
  } catch {
    ids = [];
  }
  const byId = new Map(tokens.map((t) => [t.assetId, t]));
  return ids.map((id) => byId.get(id)).filter((t): t is TokenInfo => Boolean(t));
}

export function rememberToken(t: TokenInfo): void {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== t.assetId) : [];
    localStorage.setItem(RECENT_KEY, JSON.stringify([t.assetId, ...ids].slice(0, RECENT_MAX)));
  } catch {
    // no storage: the pick still works, it is only not remembered
  }
}

const STARTERS: [string, string][] = [["USDC", "base"], ["ETH", "eth"], ["SOL", "sol"], ["BTC", "btc"]];

/** Four quick picks for a leg: recent tokens first, then USDC, ETH, SOL and BTC. The current token is left out. */
export function quickPicks(tokens: TokenInfo[], current: string | null, n = 4): TokenInfo[] {
  const out: TokenInfo[] = [];
  const add = (t: TokenInfo | undefined) => {
    if (t && t.assetId !== current && !out.some((o) => o.assetId === t.assetId)) out.push(t);
  };
  for (const t of recentTokens(tokens)) add(t);
  for (const [sym, chain] of STARTERS) add(tokens.find((t) => t.symbol === sym && t.blockchain === chain));
  return out.slice(0, n);
}
