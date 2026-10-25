/**
 * Route interface. A route is one operator that can fill a swap: 1Click,
 * THORChain, Maya. The web app and the two-hop quiet mode talk to routes
 * through this interface and never to an operator directly.
 */

import type { OneClickClient, QuoteInput } from "./oneclick/client.js";
import type { SwapStatus } from "./oneclick/types.js";

export type RouteId = "oneclick" | "thorchain" | "maya";

/** Unpair's swap states. These are the words the UI shows. "landed" means the
 * ZEC reached the landing address; the wallet then moves it into the shielded pool. */
export type UnpairState =
  | "quote"
  | "waiting_for_deposit"
  | "routing"
  | "landed"
  | "refunded"
  | "failed";

export const UNPAIR_STATE_LABELS: Record<UnpairState, string> = {
  quote: "Quote",
  waiting_for_deposit: "Waiting for deposit",
  routing: "Routing",
  landed: "Shielded",
  refunded: "Refunded",
  failed: "Failed",
};

export interface RouteQuote {
  routeId: RouteId;
  originAsset: string;
  destinationAsset: string;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  /** Total fee charged to the user, in basis points. */
  totalFeeBps: number;
  /** Seconds. */
  timeEstimateSec: number;
  depositAddress: string | null;
  depositMemo: string | null;
  deadline: Date | null;
  /** The operator's response, kept verbatim for signatures and support. */
  raw: unknown;
}

export interface RouteStatus {
  routeId: RouteId;
  state: UnpairState;
  /** Operator's own status string, for logs. */
  operatorStatus: string;
  amountOut: bigint | null;
  refundedAmount: bigint | null;
  refundReason: string | null;
  updatedAt: Date;
  raw: unknown;
}

export interface Route {
  readonly id: RouteId;
  quote(input: QuoteInput): Promise<RouteQuote>;
  status(depositAddress: string, depositMemo?: string): Promise<RouteStatus>;
}

export function oneClickStatusToState(s: SwapStatus): UnpairState {
  switch (s) {
    case "PENDING_DEPOSIT":
      return "waiting_for_deposit";
    case "KNOWN_DEPOSIT_TX":
    case "INCOMPLETE_DEPOSIT":
    case "PROCESSING":
      return "routing";
    case "SUCCESS":
      return "landed";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
  }
}

/** 1Click as a Route. */
export class OneClickRoute implements Route {
  readonly id: RouteId = "oneclick";

  constructor(
    private readonly client: OneClickClient,
    private readonly totalFeeBps: (input: QuoteInput) => number,
  ) {}

  async quote(input: QuoteInput): Promise<RouteQuote> {
    const res = await this.client.quote(input);
    const q = res.quote;
    return {
      routeId: this.id,
      originAsset: res.quoteRequest.originAsset,
      destinationAsset: res.quoteRequest.destinationAsset,
      amountIn: BigInt(q.amountIn),
      amountOut: BigInt(q.amountOut),
      minAmountOut: BigInt(q.minAmountOut),
      totalFeeBps: this.totalFeeBps(input),
      timeEstimateSec: q.timeEstimate,
      depositAddress: q.depositAddress ?? null,
      depositMemo: q.depositMemo ?? null,
      deadline: q.deadline ? new Date(q.deadline) : null,
      raw: res,
    };
  }

  async status(depositAddress: string, depositMemo?: string): Promise<RouteStatus> {
    const s = await this.client.status(depositAddress, depositMemo);
    const d = s.swapDetails;
    return {
      routeId: this.id,
      state: oneClickStatusToState(s.status),
      operatorStatus: s.status,
      amountOut: d.amountOut ? BigInt(d.amountOut) : null,
      refundedAmount: d.refundedAmount ? BigInt(d.refundedAmount) : null,
      refundReason: d.refundReason ?? null,
      updatedAt: new Date(s.updatedAt),
      raw: s,
    };
  }
}
