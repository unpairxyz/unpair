/**
 * Swap model for the page. Pure functions and types; no React here.
 */
import {
  describeReleaseWindow,
  formatUnits,
  oneClickStatusToState,
  parseUnits,
  roundDownCoarse,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
  type UnpairState,
} from "@unpair/sdk";

export type Mode = "fast" | "quiet";

export const MODE_COPY: Record<Mode, { title: string; text: string }> = {
  fast: {
    title: "Fast",
    text: "One hop. Your exact amount lands at your Zcash address in a few minutes.",
  },
  quiet: {
    title: "Quiet",
    text: "Rounded amount, so your payout looks like everyone else's. " + describeReleaseWindow() + " The second hop runs from your shielded wallet.",
  },
};

export interface AmountPlan {
  /** What the user types, in base units. */
  requested: bigint;
  /** What is sent to the route, in base units. Rounded in quiet mode. */
  send: bigint;
  /** Left in the source wallet in quiet mode. */
  heldBack: bigint;
}

/** Parse the amount field and apply the quiet-mode grid. */
export function planAmount(input: string, token: TokenInfo, mode: Mode): AmountPlan | { error: string } {
  let requested: bigint;
  try {
    requested = parseUnits(input, token.decimals);
  } catch {
    return { error: `Enter an amount of ${token.symbol} with at most ${token.decimals} decimals.` };
  }
  if (requested <= 0n) return { error: "Enter an amount above zero." };
  if (mode === "fast") return { requested, send: requested, heldBack: 0n };
  const r = roundDownCoarse(requested);
  return { requested, send: r.amount, heldBack: r.remainder };
}

export function describePlan(plan: AmountPlan, token: TokenInfo, mode: Mode): string {
  if (mode === "fast" || plan.heldBack === 0n) return `You send ${formatUnits(plan.send, token.decimals)} ${token.symbol}.`;
  return `Quiet mode rounds ${formatUnits(plan.requested, token.decimals)} down to ${formatUnits(plan.send, token.decimals)} ${token.symbol}. The rest stays in your wallet.`;
}

export const STATE_COPY: Record<UnpairState, { label: string; text: string }> = {
  quote: { label: "Quote", text: "Check the numbers, then send the deposit." },
  waiting_for_deposit: { label: "Waiting for deposit", text: "Send exactly the amount shown to the deposit address before the deadline." },
  routing: { label: "Routing", text: "Deposit seen. The route is filling your swap." },
  landed: { label: "Landed", text: "ZEC arrived at your Zcash address. Your wallet moves it into the shielded pool from here." },
  refunded: { label: "Refunded", text: "The swap did not complete. Funds went back to your refund address." },
  failed: { label: "Failed", text: "The route reported an error. Nothing was taken. Check the refund address for your deposit." },
};

export function stateOf(status: StatusResponse | null): UnpairState {
  return status ? oneClickStatusToState(status.status) : "waiting_for_deposit";
}

export function depositDeadline(q: QuoteResponse): Date | null {
  const d = q.quote.deadline ?? q.quoteRequest.deadline;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t);
}

export function groupByChain(tokens: TokenInfo[]): Map<string, TokenInfo[]> {
  const m = new Map<string, TokenInfo[]>();
  for (const t of tokens) {
    if (t.blockchain === "zec") continue;
    const list = m.get(t.blockchain) ?? [];
    list.push(t);
    m.set(t.blockchain, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  gnosis: "Gnosis",
  sol: "Solana",
  btc: "Bitcoin",
  ltc: "Litecoin",
  doge: "Dogecoin",
  bch: "Bitcoin Cash",
  near: "NEAR",
  ton: "TON",
  tron: "Tron",
  xrp: "XRP Ledger",
  sui: "Sui",
  aptos: "Aptos",
  stellar: "Stellar",
  cardano: "Cardano",
  starknet: "Starknet",
  monad: "Monad",
  bera: "Berachain",
  scroll: "Scroll",
  xlayer: "X Layer",
};

export function chainName(id: string): string {
  return CHAIN_NAMES[id] ?? id.toUpperCase();
}
