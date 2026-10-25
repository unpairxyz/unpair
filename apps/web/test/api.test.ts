import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, canonicalJson, signedMessage, verifySignedQuote, type SignedQuote } from "../src/lib/api";

// Printed by `cargo test -p unpair-api print_cross_language_vector -- --nocapture`.
const VECTOR_PUBKEY = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const VECTOR_SIG = "MCyiyZ/RsjSl+b/Ws7A7SOLuH0Jbj9d6gFAlVcpVZqIIrwHp7Sguap7Xq3MnfO/cs3n97NulF1emnCiZIsTCBA==";
const VECTOR_MSG =
  '{"fee_bps":50,"fee_recipient":"unpair.near","quote":{"correlationId":"c1","quote":{"amountIn":"1000000000","amountInUsd":"999.545000000000","amountOut":"83847628","timeEstimate":160},"quoteRequest":{"amount":"1000000000","appFees":[{"fee":25,"recipient":"unpair.near"},{"fee":25,"recipient":"x"}],"dry":true,"slippageTolerance":100,"swapType":"EXACT_INPUT"},"signature":"sig","timestamp":"2026-10-25T12:00:00.000Z"},"v":1}';
const quote = {
  correlationId: "c1",
  timestamp: "2026-10-25T12:00:00.000Z",
  signature: "sig",
  quoteRequest: { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, amount: "1000000000", appFees: [{ recipient: "unpair.near", fee: 25 }, { recipient: "x", fee: 25 }] },
  quote: { amountIn: "1000000000", amountOut: "83847628", timeEstimate: 160, amountInUsd: "999.545000000000" },
};
const signed = { quote, fee_recipient: "unpair.near", fee_bps: 50, signature: VECTOR_SIG, public_key_hex: VECTOR_PUBKEY } as unknown as SignedQuote;

describe("canonical json matches the server", () => {
  it("produces the same bytes as Rust", () => {
    expect(new TextDecoder().decode(signedMessage("unpair.near", 50, quote))).toBe(VECTOR_MSG);
  });
  it("sorts nested keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 2, y: 3 }], c: "x", u: undefined } })).toBe('{"a":{"c":"x","d":[1,{"y":3,"z":2}]},"b":1}');
  });
});

describe("verifySignedQuote", () => {
  it("accepts the Rust-produced signature", async () => {
    expect(await verifySignedQuote(signed, VECTOR_PUBKEY)).toBe(true);
  });
  it("rejects a changed fee, recipient, quote or key", async () => {
    expect(await verifySignedQuote({ ...signed, fee_bps: 51 }, VECTOR_PUBKEY)).toBe(false);
    expect(await verifySignedQuote({ ...signed, fee_recipient: "clone.near" }, VECTOR_PUBKEY)).toBe(false);
    expect(await verifySignedQuote({ ...signed, quote: { ...quote, quote: { ...quote.quote, amountOut: "1" } } as never }, VECTOR_PUBKEY)).toBe(false);
    expect(await verifySignedQuote(signed, "00".repeat(32))).toBe(false);
    expect(await verifySignedQuote({ ...signed, public_key_hex: "00".repeat(32) }, VECTOR_PUBKEY)).toBe(false);
  });
});

describe("ApiClient", () => {
  it("surfaces server errors with code and message", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden", message: "not allowed: nope" }), { status: 403 }));
    const c = new ApiClient("http://api.test/", f as unknown as typeof fetch);
    await expect(c.screen("x", "eth")).rejects.toMatchObject({ name: "ApiError", code: "forbidden", httpStatus: 403, message: "not allowed: nope" });
    expect((f.mock.calls[0] as [string])[0]).toBe("http://api.test/v1/screen");
  });
  it("encodes status paths", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const c = new ApiClient("http://api.test", f as unknown as typeof fetch);
    await c.status("0xdep", "m 1");
    expect((f.mock.calls[0] as [string])[0]).toBe("http://api.test/v1/status/0xdep?depositMemo=m%201");
  });
  it("throws ApiError type", () => {
    expect(new ApiError("m", "c", 500)).toBeInstanceOf(Error);
  });
});
