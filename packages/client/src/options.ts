/**
 * User-facing privacy options. Pure data and checks, no React.
 *
 * Every option here is a choice the user makes on their own device. None of
 * them adds a party to trust. Routes that are not available are listed with
 * the reason, so the user can see what is coming and why it is off.
 */
import type { RouteId } from "@unpair/sdk";

/** Where the ZEC lands. */
export type WalletChoice = "own" | "unpair_app";

export const WALLET_COPY: Record<WalletChoice, { title: string; text: string }> = {
  own: {
    title: "My own Zcash wallet",
    text: "Paste a fresh transparent address from a wallet that shields on receipt, such as Zodl, Zingo or Zkool. Your wallet moves the ZEC into the shielded pool.",
  },
  unpair_app: {
    title: "The Unpair app",
    text: "The app makes a fresh landing address for every swap and shields it for you. Use the app itself for this swap; this page cannot see its key.",
  },
};

export interface RouteInfo {
  id: RouteId;
  name: string;
  /** Who holds the funds while the swap is in flight. */
  trusted: string;
  /** How the ZEC leg is paid. */
  payout: "transparent" | "shielded";
  /** Can be chosen today. */
  available: boolean;
  /** Why it is off, or a note when it is on. */
  note: string;
}

/**
 * Routes in the order the page lists them. 1Click is the default. The others
 * stay off until they are checked and built; the note says why.
 */
export const ROUTES: readonly RouteInfo[] = [
  {
    id: "oneclick",
    name: "NEAR Intents",
    trusted: "NEAR Intents while the swap is in flight",
    payout: "transparent",
    available: true,
    note: "Pays a transparent Zcash address. Your wallet shields it on receipt.",
  },
  {
    id: "maya",
    name: "Maya Protocol",
    trusted: "Maya Protocol while the swap is in flight",
    payout: "shielded",
    available: false,
    note: "Can pay a shielded address directly, with no transparent step. Off until its state after the August 2026 exploit is checked.",
  },
  {
    id: "thorchain",
    name: "THORChain",
    trusted: "THORChain while the swap is in flight",
    payout: "transparent",
    available: false,
    note: "Does not carry ZEC, so it cannot do the Zcash leg.",
  },
];

export function routeInfo(id: RouteId): RouteInfo {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown route ${id}`);
  return r;
}

export const DEFAULT_ROUTE: RouteId = "oneclick";

/** Slippage choices in basis points. The route refuses to fill below the quote minus this. */
export const SLIPPAGE_CHOICES_BPS: readonly number[] = [50, 100, 200];
export const DEFAULT_SLIPPAGE_BPS = 100;

/** How the user times the second hop in quiet mode. */
export type WaitChoice = "suggested" | "own";

export interface AdvancedOptions {
  /** Round the amount to the 1, 2, 5 grid in quiet mode. On by default. */
  round: boolean;
  slippageBps: number;
  wait: WaitChoice;
}

export const DEFAULT_ADVANCED: AdvancedOptions = { round: true, slippageBps: DEFAULT_SLIPPAGE_BPS, wait: "suggested" };

export function checkAdvanced(a: AdvancedOptions): AdvancedOptions {
  if (!SLIPPAGE_CHOICES_BPS.includes(a.slippageBps)) {
    throw new Error(`slippage must be one of ${SLIPPAGE_CHOICES_BPS.join(", ")} bps`);
  }
  return a;
}

export const WAIT_COPY: Record<WaitChoice, string> = {
  suggested: "The page suggests a random wait before you send out, usually about 3 hours and never more than 12.",
  own: "You choose when to send out. Longer and less regular is better.",
};

export const TOR_HINT = "For the best network privacy open this page in Tor Browser. The page itself never sees your IP; the route operator and your wallet's server do.";
