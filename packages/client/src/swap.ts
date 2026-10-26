/**
 * Swap model for the page. Pure functions and types; no React here.
 */
import type { HostedState } from "./api.js";
import {
  oneClickStatusToState,
  parseUnits,
  roundDownCoarse,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
  type UnpairState,
} from "@unpair/sdk";

export type Mode = "fast" | "quiet";

export interface AmountPlan {
  /** What the user types, in base units. */
  requested: bigint;
  /** What is sent to the route, in base units. Rounded in quiet mode. */
  send: bigint;
  /** Left in the source wallet in quiet mode. */
  heldBack: bigint;
}

/** Parse the amount field and apply the quiet-mode grid. */
export function planAmount(input: string, token: TokenInfo, mode: Mode, round = true): AmountPlan | { error: string } {
  let requested: bigint;
  try {
    requested = parseUnits(input, token.decimals);
  } catch {
    return { error: `Enter an amount of ${token.symbol} with at most ${token.decimals} decimals.` };
  }
  if (requested <= 0n) return { error: "Enter an amount above zero." };
  if (mode === "fast" || !round) return { requested, send: requested, heldBack: 0n };
  const r = roundDownCoarse(requested);
  return { requested, send: r.amount, heldBack: r.remainder };
}

export const STATE_COPY: Record<UnpairState, { label: string; text: string }> = {
  quote: { label: "Quote", text: "Check the numbers, then send the deposit." },
  waiting_for_deposit: { label: "Waiting for deposit", text: "Send exactly the amount shown to the deposit address before the deadline." },
  routing: { label: "Routing", text: "Deposit seen. The route is filling your swap." },
  landed: { label: "Landed", text: "ZEC arrived at your Zcash address. Your wallet moves it into the shielded pool from here." },
  refunded: { label: "Refunded", text: "The swap did not complete. Funds went back to your refund address." },
  failed: { label: "Failed", text: "The route reported an error. Nothing was taken. Check the refund address for your deposit." },
};

/** Words for the states when ZEC leaves the pool instead of entering it. */
export const SEND_OUT_COPY: Partial<Record<UnpairState, { label: string; text: string }>> = {
  quote: { label: "Quote", text: "Check the numbers, then pay the route from your shielded wallet." },
  waiting_for_deposit: { label: "Waiting for your payment", text: "Send exactly the amount shown from your Zcash wallet to the route's address before the deadline." },
  routing: { label: "Routing", text: "Payment seen. The route is filling your swap." },
  landed: { label: "Delivered", text: "The route paid your destination address." },
};

export function stateOf(status: StatusResponse | null): UnpairState {
  return status ? oneClickStatusToState(status.status) : "waiting_for_deposit";
}

export function depositDeadline(q: QuoteResponse): Date | null {
  const d = q.quote.deadline ?? q.quoteRequest.deadline;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t);
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

/** Which of the four panels (Deposit seen, Into the pool, In the pool, Out) a hosted state lights, 0 to 3, or -1 before the deposit. */
export function hostedStage(state: HostedState): number {
  switch (state) {
    case "waiting_for_deposit":
      return -1;
    case "routing_in":
      return 1;
    case "in_pool":
      return 2;
    case "routing_out":
      return 3;
    case "done":
      return 4;
    case "refunded":
    case "expired":
    case "failed":
      return -1;
  }
}

export const HOSTED_COPY: Record<HostedState, { label: string; text: string }> = {
  waiting_for_deposit: { label: "Waiting for deposit", text: "Send exactly the amount shown to the deposit address before the deadline. You can close this tab and come back with the link." },
  routing_in: { label: "Into the pool", text: "Deposit seen. The route is turning it into ZEC and paying Unpair's transit wallet, straight into the shielded pool." },
  in_pool: { label: "In the pool", text: "Your ZEC sits shielded in Unpair's transit wallet. It needs ten confirmations, about 12 minutes, then the server sends it on from a fresh source at the release time, in standard sizes in quiet mode." },
  routing_out: { label: "Out", text: "The second hop is paid from the pool. The route is delivering your asset, part by part in quiet mode." },
  done: { label: "Delivered", text: "Your asset arrived at your address. On chain, nothing links it to your deposit. Unpair's server saw both ends; it keeps this record for seven days, then deletes it." },
  refunded: { label: "Refunded", text: "The first hop did not complete. The route returned your deposit to the refund address." },
  expired: { label: "Expired", text: "No deposit arrived before the deadline. A deposit sent after it is returned by the route to the refund address." },
  failed: { label: "Needs attention", text: "Something stopped the swap. The server kept the swap id and the details; contact the operator with the id." },
};

export function isHostedFinal(state: HostedState): boolean {
  return state === "done" || state === "refunded" || state === "expired" || state === "failed";
}
