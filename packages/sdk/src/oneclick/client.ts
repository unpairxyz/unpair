import { clearnetTransport, type Transport } from "../transport.js";
import {
  assertFeeConfig,
  describeFee,
  feeFromEchoedAppFees,
  oneClickFeeBreakdown,
  type FeeBreakdown,
  type FeeConfig,
} from "../fees.js";
import { isStableRoute } from "./assets.js";
import {
  FINAL_SWAP_STATUSES,
  ONECLICK_BASE_URL,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type SubmitDepositRequest,
  type TokenInfo,
} from "./types.js";

export interface OneClickClientOptions {
  /** Default https://1click.chaindefuser.com */
  baseUrl?: string;
  /** Partner JWT. Without it 1Click adds 25 bps to every quote. */
  apiKey?: string;
  /** Default: clearnet. Pass a Tor or Nym transport in production. */
  transport?: Transport;
  /** Unpair's routing fee. null means no appFees are sent. */
  fee?: FeeConfig | null;
  /** Clock, for tests. */
  now?: () => Date;
  /** Default deadline offset when the caller gives none. Default 10 minutes. */
  defaultDeadlineMs?: number;
}

/** A quote request without the fields the client fills in. */
export type QuoteInput = Omit<QuoteRequest, "appFees" | "deadline" | "dry"> & {
  deadline?: string | Date;
  dry?: boolean;
};

export interface FeePreview {
  breakdown: FeeBreakdown | null;
  /** Plain words for the quote screen. */
  text: string;
  /** What is sent to 1Click. */
  appFees: QuoteRequest["appFees"];
}

export interface WaitOptions {
  /** Poll interval. Default 5000 ms. */
  intervalMs?: number;
  /** Give up after this long. Default 2 hours. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (status: StatusResponse) => void;
}

export class OneClickError extends Error {
  override readonly name = "OneClickError";
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly transport: Transport;
  private readonly fee: FeeConfig | null;
  private readonly now: () => Date;
  private readonly defaultDeadlineMs: number;

  constructor(options: OneClickClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ONECLICK_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? clearnetTransport();
    this.fee = options.fee ?? null;
    if (this.fee) assertFeeConfig(this.fee);
    this.now = options.now ?? (() => new Date());
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 10 * 60_000;
  }

  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async getTokens(): Promise<TokenInfo[]> {
    return this.request<TokenInfo[]>("GET", "/v0/tokens");
  }

  /**
   * Fee that a quote for these assets will carry. Call this before
   * `quote` and show the text to the user.
   */
  previewFee(origin: { symbol: string }, destination: { symbol: string }, swapType: QuoteRequest["swapType"]): FeePreview {
    if (!this.fee || this.fee.feeBps === 0 || swapType === "ANY_INPUT") {
      const breakdown = oneClickFeeBreakdown(0, { hasApiKey: this.hasApiKey, stableRoute: isStableRoute(origin, destination) });
      return {
        breakdown,
        text: describeFee(breakdown, "1Click"),
        appFees: undefined,
      };
    }
    const breakdown = oneClickFeeBreakdown(this.fee.feeBps, {
      hasApiKey: this.hasApiKey,
      stableRoute: isStableRoute(origin, destination),
    });
    return {
      breakdown,
      text: describeFee(breakdown, "1Click"),
      appFees: [{ recipient: this.fee.recipient, fee: this.fee.feeBps }],
    };
  }

  /**
   * The exact fee 1Click applied to a quote, read from the appFees it
   * echoed. Show this after the quote and before the deposit.
   */
  feeFromQuoteResponse(res: QuoteResponse, context: { stableRoute?: boolean } = {}): FeePreview {
    const breakdown = feeFromEchoedAppFees(res.quoteRequest.appFees, this.fee?.recipient ?? null, {
      hasApiKey: this.hasApiKey,
      ...(context.stableRoute !== undefined ? { stableRoute: context.stableRoute } : {}),
    });
    return { breakdown, text: describeFee(breakdown, "1Click"), appFees: res.quoteRequest.appFees };
  }

  /**
   * Request a quote. Adds Unpair's appFees unless the swap is ANY_INPUT.
   * A `dry` quote has no deposit address and commits nothing.
   */
  async quote(input: QuoteInput): Promise<QuoteResponse> {
    const { deadline, dry, ...rest } = input;
    const request: QuoteRequest = {
      ...rest,
      dry: dry ?? false,
      deadline: this.resolveDeadline(deadline),
    };
    if (this.fee && this.fee.feeBps > 0 && request.swapType !== "ANY_INPUT") {
      request.appFees = [{ recipient: this.fee.recipient, fee: this.fee.feeBps }];
    }
    validateQuoteRequest(request);
    return this.request<QuoteResponse>("POST", "/v0/quote", request);
  }

  /** Same as `quote` with `dry: true`. */
  dryQuote(input: Omit<QuoteInput, "dry">): Promise<QuoteResponse> {
    return this.quote({ ...input, dry: true });
  }

  /** Tell 1Click about a deposit so it does not wait for its own indexer. */
  async submitDeposit(req: SubmitDepositRequest): Promise<StatusResponse> {
    return this.request<StatusResponse>("POST", "/v0/deposit/submit", req);
  }

  async status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const params = new URLSearchParams({ depositAddress });
    if (depositMemo) params.set("depositMemo", depositMemo);
    return this.request<StatusResponse>("GET", `/v0/status?${params.toString()}`);
  }

  /** Poll until the swap reaches SUCCESS, REFUNDED or FAILED. */
  async waitForFinalStatus(depositAddress: string, depositMemo?: string, options: WaitOptions = {}): Promise<StatusResponse> {
    const intervalMs = options.intervalMs ?? 5_000;
    const timeoutMs = options.timeoutMs ?? 2 * 3_600_000;
    const started = this.now().getTime();
    for (;;) {
      options.signal?.throwIfAborted();
      const s = await this.status(depositAddress, depositMemo);
      options.onUpdate?.(s);
      if (FINAL_SWAP_STATUSES.has(s.status)) return s;
      if (this.now().getTime() - started > timeoutMs) {
        throw new OneClickError(`swap at ${depositAddress} not final after ${timeoutMs} ms`, null, s);
      }
      await sleep(intervalMs, options.signal);
    }
  }

  private resolveDeadline(deadline: string | Date | undefined): string {
    if (deadline === undefined) return new Date(this.now().getTime() + this.defaultDeadlineMs).toISOString();
    if (deadline instanceof Date) return deadline.toISOString();
    return deadline;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await this.transport.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new OneClickError(`1Click request failed: ${(err as Error).message}`, null, null);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      throw new OneClickError(`1Click ${method} ${path} returned ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }
}

/** Reject requests 1Click would reject, before they leave the device. */
export function validateQuoteRequest(req: QuoteRequest): void {
  if (!/^\d+$/.test(req.amount)) throw new OneClickError("amount must be an integer string in base units", null, null);
  if (!Number.isInteger(req.slippageTolerance) || req.slippageTolerance < 0) {
    throw new OneClickError("slippageTolerance must be a non-negative integer in basis points", null, null);
  }
  if (req.swapType === "ANY_INPUT" && req.appFees && req.appFees.length > 0) {
    throw new OneClickError("ANY_INPUT quotes cannot carry appFees", null, null);
  }
  if (Number.isNaN(Date.parse(req.deadline))) throw new OneClickError("deadline must be an ISO date-time", null, null);
  for (const f of req.appFees ?? []) {
    if (!Number.isInteger(f.fee) || f.fee < 0) throw new OneClickError("appFees.fee must be a non-negative integer", null, null);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
