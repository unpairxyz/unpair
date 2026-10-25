/**
 * Client for unpair-api. Optional: without VITE_API_URL the page talks to
 * 1Click directly. With it, the page screens addresses first and gets a
 * quote the server signed. The signature is checked here against the pinned
 * public key, so a clone site cannot hand out a forged quote.
 */
import { verifyAsync } from "@noble/ed25519";
import type { QuoteRequest, QuoteResponse, StatusResponse } from "@unpair/sdk";

export interface ApiConfig {
  fee_recipient: string;
  fee_bps: number;
  fee_cap_bps: number;
  screening: "off" | "denylist" | "http";
  geofence: string[];
  quote_signing_pubkey: string;
  oneclick_keyed: boolean;
  /** Present when this server holds a transit key for hosted swaps. */
  hosted: HostedInfo | null;
}

export interface HostedInfo {
  /** Largest ZEC amount one swap may carry, in zatoshis. */
  max_zat: number;
  open: number;
  max_open: number;
  hop2_fee_reserve_zat: number;
  min_zat: number;
}

export type HostedState = "waiting_for_deposit" | "routing_in" | "in_pool" | "routing_out" | "done" | "refunded" | "expired" | "failed";

/** What the server shows the page about one hosted swap. */
export interface HostedSwap {
  id: string;
  state: HostedState;
  mode: "fast" | "quiet";
  created_unix: number;
  updated_unix: number;
  origin_asset: string;
  destination_asset: string;
  destination_address: string;
  deposit_address: string;
  deposit_memo: string | null;
  /** Base units of the origin asset. */
  amount_in: string;
  deposit_deadline_unix: number;
  zec_received: number | null;
  release_at_unix: number | null;
  hop2_amount_in: number | null;
  hop2_txid: string | null;
  delivered_amount: string | null;
  delivered_tx: string | null;
  note: string | null;
}

export interface HostedCreateRequest {
  mode: "fast" | "quiet";
  originAsset: string;
  /** Base units of the origin asset. */
  amount: string;
  destinationAsset: string;
  recipient: string;
  refundTo: string;
  slippageTolerance?: number;
}

export interface HostedCreated {
  swap: HostedSwap;
  quote: SignedQuote;
}

export interface SignedQuote {
  quote: QuoteResponse;
  fee_recipient: string;
  fee_bps: number;
  signature: string;
  public_key_hex: string;
}

export interface ScreenVerdict {
  allowed: boolean;
  reason: string | null;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Same bytes as the server's canonical JSON: sorted keys, no spaces. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function signedMessage(feeRecipient: string, feeBps: number, quote: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ v: 1, fee_recipient: feeRecipient, fee_bps: feeBps, quote }));
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when `signed` was produced by the key `pinnedPubkeyHex`. */
export async function verifySignedQuote(signed: SignedQuote, pinnedPubkeyHex: string): Promise<boolean> {
  try {
    if (signed.public_key_hex.toLowerCase() !== pinnedPubkeyHex.toLowerCase()) return false;
    const msg = signedMessage(signed.fee_recipient, signed.fee_bps, signed.quote);
    return await verifyAsync(base64ToBytes(signed.signature), msg, hexToBytes(pinnedPubkeyHex));
  } catch {
    return false;
  }
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (i, o) => fetch(i, o),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; message?: string };
      throw new ApiError(e.message ?? `request failed with ${res.status}`, e.error ?? "http", res.status);
    }
    return json as T;
  }

  config(): Promise<ApiConfig> {
    return this.call("GET", "/v1/config");
  }

  screen(address: string, chain: string): Promise<ScreenVerdict> {
    return this.call("POST", "/v1/screen", { address, chain });
  }

  quote(request: Omit<QuoteRequest, "appFees">): Promise<SignedQuote> {
    return this.call("POST", "/v1/quote", request);
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = depositMemo ? `?depositMemo=${encodeURIComponent(depositMemo)}` : "";
    return this.call("GET", `/v1/status/${encodeURIComponent(depositAddress)}${q}`);
  }

  /** Start a hosted swap. The server screens, takes a fresh landing and quotes hop one. */
  createHostedSwap(request: HostedCreateRequest): Promise<HostedCreated> {
    return this.call("POST", "/v1/hosted/swaps", request);
  }

  hostedSwap(id: string): Promise<HostedSwap> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new ApiError("not a swap id", "bad_id", 0);
    return this.call("GET", `/v1/hosted/swaps/${id}`);
  }
}
