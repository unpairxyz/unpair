/**
 * User-facing privacy options. Pure data and checks, no React.
 *
 * Every option here is a choice the user makes on their own device. None of
 * them adds a party to trust. Routes that are not available are listed with
 * the reason, so the user can see what is coming and why it is off.
 */
import type { RouteId } from "@unpair/sdk";

/** Where the ZEC lands. */
export type WalletChoice = "own" | "unpair_app" | "hosted";

export interface WalletInfo {
  id: WalletChoice;
  title: string;
  text: string;
  /** Who can spend the ZEC once it has landed. */
  custody: "you" | "unpair";
  /** Can be chosen today. */
  available: boolean;
  /** Why it is off. Empty when it is on. */
  note: string;
}

/**
 * Landing choices in the order the page lists them. Only choices where the
 * user keeps the key are on. A hosted landing would make Unpair a custodian
 * and the one party that can see both ends, so it stays off until that is
 * decided and reviewed. It is listed so the trade-off is visible.
 */
export const WALLET_CHOICES: readonly WalletInfo[] = [
  {
    id: "own",
    title: "My own Zcash wallet",
    text: "Paste a fresh address from Zodl, Zingo, Zkool or any Zcash wallet. A shielded-only unified address is paid straight into the pool. A transparent address is shielded by your wallet on receipt. Unpair never holds the funds. The payout and its address are readable on chain for this one payment, so the link breaks when you later spend from your wallet.",
    custody: "you",
    available: true,
    note: "",
  },
  {
    id: "unpair_app",
    title: "The Unpair app",
    text: "The app makes a fresh landing address for every swap and shields it for you. The key stays on your device. Use the app itself for this swap; this page cannot see its key.",
    custody: "you",
    available: true,
    note: "",
  },
  {
    id: "hosted",
    title: "A wallet Unpair holds for you",
    text: "Unpair would receive the payout into its own shielded wallet and pay your address later, at a time of your choosing. Your address would never appear on NEAR or in the bridge output. In return you would trust Unpair with your funds, its logs and its solvency, and Unpair would be the one party able to link both ends.",
    custody: "unpair",
    available: false,
    note: "Not offered. It would make Unpair a custodian, which needs a decision and a legal review first.",
  },
];

export const WALLET_COPY: Record<WalletChoice, { title: string; text: string }> = Object.fromEntries(
  WALLET_CHOICES.map((w) => [w.id, { title: w.title, text: w.text }]),
) as Record<WalletChoice, { title: string; text: string }>;

export function walletInfo(id: WalletChoice): WalletInfo {
  const w = WALLET_CHOICES.find((x) => x.id === id);
  if (!w) throw new Error(`unknown wallet choice ${id}`);
  return w;
}

export const DEFAULT_WALLET: WalletChoice = "own";

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
    note: "Pays a shielded-only unified address straight into Ironwood, or a transparent address that your wallet shields.",
  },
  {
    id: "maya",
    name: "Maya Protocol",
    trusted: "Maya Protocol while the swap is in flight",
    payout: "shielded",
    available: false,
    note: "Pays Sapling, a pool about ten times smaller than Ironwood. Was exploited and halted from 18 August to 1 October 2026. Every deposit needs a memo, so it needs a connected wallet. Off on this page.",
  },
  {
    id: "thorchain",
    name: "THORChain",
    trusted: "THORChain while the swap is in flight",
    payout: "transparent",
    available: false,
    note: "Its ZEC pool is a few dozen ZEC deep and pays transparent only. Off until it is deep enough.",
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
