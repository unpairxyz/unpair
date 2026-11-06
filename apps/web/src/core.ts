/**
 * What every view of the page shares: the configuration, the route and API
 * clients, the screened quote, and small helpers. No React components here.
 */
import { useEffect, useRef, useState } from "react";
import { ONECLICK_DOCUMENTED_UNAUTHENTICATED_BPS, OneClickClient, OneClickError, clearnetTransport, type QuoteInput, type QuoteResponse } from "@unpair/sdk";
import { ApiClient, ApiError, screenPrivately, verifySignedQuote, type SignedQuote } from "@unpair/client";
import { loadConfig } from "./config";

export const config = loadConfig();
export const client = new OneClickClient({
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  fee: config.fee,
  transport: clearnetTransport(),
});
export const api = config.apiUrl ? new ApiClient(config.apiUrl) : null;
if (api && !config.apiPubkey) {
  console.warn("VITE_API_URL is set without VITE_API_PUBKEY; signed quotes cannot be verified and will be refused.");
}

export const SLIPPAGE_BPS = [50, 100, 200] as const;
export const fmt = (v: number, d = 6) => v.toLocaleString("en-US", { maximumFractionDigits: d });
export const feeFraction = config.fee ? config.fee.feeBps / 10_000 : 0;
export const feePercent = `${(feeFraction * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof OneClickError) {
    const body = e.body as { message?: string } | null;
    const msg = body && typeof body.message === "string" ? body.message : e.message;
    if (/refundTo/i.test(msg)) return "The route did not accept the refund address. Check it and try again.";
    if (/recipient/i.test(msg)) return "The route did not accept the destination address. Check it and try again.";
    if (/amount/i.test(msg)) return `The route did not accept the amount: ${msg}`;
    return `The route said: ${msg}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Screen both addresses and get a signed quote through the API when configured, else ask 1Click directly. */
export async function screenAndQuote(request: QuoteInput, chains: [string, string]): Promise<{ quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null } | { refused: string }> {
  if (api) {
    for (const [address, chain] of [
      [request.refundTo, chains[0]],
      [request.recipient, chains[1]],
    ] as const) {
      const v = await api.screen(address, chain);
      if (!v.allowed) return { refused: v.reason ?? "This address cannot be served." };
    }
    const signed = await api.quote({ ...request, deadline: request.deadline instanceof Date ? request.deadline.toISOString() : String(request.deadline), dry: false });
    if (!config.apiPubkey) return { refused: "This page has no pinned API key, so it cannot verify the quote. Set VITE_API_PUBKEY." };
    const verified = await verifySignedQuote(signed, config.apiPubkey);
    if (!verified) return { refused: "The quote did not verify against the pinned API key. Do not pay it." };
    return { quote: signed.quote, signed, verified: true };
  }
  const quote = await client.quote(request);
  return { quote, signed: null, verified: null };
}

/**
 * Quote a hop that pays the final destination without telling the Unpair API where it goes. The addresses
 * are screened here against the API's hashed list, and the quote and its status come from the route itself.
 * The API gets neither the destination nor the route's deposit address. Our routing fee is in the quote all the same.
 * No server signs this quote, so it is checked here before anything is paid.
 */
export async function quotePrivately(request: QuoteInput, addresses: readonly (readonly [address: string, chain: string])[]): Promise<{ quote: QuoteResponse } | { refused: string }> {
  if (api) {
    const v = await screenPrivately(api, addresses);
    if (!v.allowed) return { refused: v.reason };
  }
  const quote = await client.quote(request);
  const problem = checkQuote(request, quote);
  return problem ? { refused: problem } : { quote };
}

/** What is wrong with a route's quote for `request`, or null. The quote must echo the request and keep the fee under the cap. */
export function checkQuote(request: QuoteInput, quote: QuoteResponse): string | null {
  const echo = quote.quoteRequest;
  for (const k of ["originAsset", "destinationAsset", "amount", "recipient", "refundTo"] as const) {
    if (echo[k] !== request[k]) return "The route's quote does not match what you asked for. Nothing was paid. Try again.";
  }
  // our fee, plus at most the surcharge 1Click documents for a call without a partner key
  const fee = client.feeFromQuoteResponse(quote).breakdown;
  const bound = (config.fee?.feeBps ?? 0) + ONECLICK_DOCUMENTED_UNAUTHENTICATED_BPS;
  if (fee && fee.totalBps > bound) return "The route asked a higher fee than this page expects. Nothing was paid. Try again later.";
  if (!request.dry && !quote.quote.depositAddress) return "The route gave no address to pay.";
  return null;
}

export function usePoll<T>(fn: (() => Promise<T>) | null, stop: boolean, everyMs = 7_000): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!fn || stop) return;
    let alive = true;
    const tick = async () => {
      try {
        const v = await fn();
        if (alive) {
          setValue(v);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer.current = window.setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [fn, stop, everyMs]);
  return { value, error };
}

export function markSeed(signed: SignedQuote | null, quote: QuoteResponse): string {
  return signed ? signed.signature.slice(0, 16) : (quote.quote.depositAddress ?? "").slice(0, 16);
}

export function shortCode(seed: string): string {
  const s = seed.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
