import { describe, expect, it, vi } from "vitest";
import { OneClickClient, OneClickError } from "../src/oneclick/client.js";
import { ASSETS } from "../src/oneclick/assets.js";
import { customTransport } from "../src/transport.js";
import { OneClickRoute, oneClickStatusToState } from "../src/route.js";
import type { QuoteResponse, StatusResponse } from "../src/oneclick/types.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>, opts: Partial<ConstructorParameters<typeof OneClickClient>[0]> = {}) {
  return new OneClickClient({
    transport: customTransport(fetchMock as unknown as typeof fetch),
    fee: { recipient: "unpair.near", feeBps: 50 },
    now: () => NOW,
    ...opts,
  });
}

const baseInput = {
  swapType: "EXACT_INPUT" as const,
  slippageTolerance: 100,
  originAsset: ASSETS.ETH,
  depositType: "ORIGIN_CHAIN" as const,
  destinationAsset: ASSETS.ZEC,
  amount: "1000000000000000000",
  refundTo: "0x0000000000000000000000000000000000000001",
  refundType: "ORIGIN_CHAIN" as const,
  recipient: "t1dummyTransparentAddressForTest00000",
  recipientType: "DESTINATION_CHAIN" as const,
};

const quoteResponse: QuoteResponse = {
  correlationId: "c1",
  timestamp: NOW.toISOString(),
  signature: "sig",
  quoteRequest: { ...baseInput, dry: false, deadline: "2026-10-25T12:10:00.000Z" },
  quote: {
    amountIn: "1000000000000000000",
    amountInFormatted: "1",
    amountInUsd: "3000",
    minAmountIn: "1000000000000000000",
    amountOut: "6000000000",
    amountOutFormatted: "60",
    amountOutUsd: "2985",
    minAmountOut: "5940000000",
    timeEstimate: 120,
    depositAddress: "0xdeposit",
    deadline: "2026-10-25T12:10:00.000Z",
  },
};

describe("OneClickClient.quote", () => {
  it("adds appFees, a default deadline and the auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(quoteResponse));
    const client = makeClient(fetchMock, { apiKey: "jwt" });
    const res = await client.quote(baseInput);
    expect(res.quote.depositAddress).toBe("0xdeposit");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt");
    const body = JSON.parse(init.body as string);
    expect(body.appFees).toEqual([{ recipient: "unpair.near", fee: 50 }]);
    expect(body.dry).toBe(false);
    expect(body.deadline).toBe("2026-10-25T12:10:00.000Z");
  });

  it("drops appFees on ANY_INPUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(quoteResponse));
    const client = makeClient(fetchMock);
    await client.quote({ ...baseInput, swapType: "ANY_INPUT" });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.appFees).toBeUndefined();
  });

  it("sends no auth header without a key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(quoteResponse));
    await makeClient(fetchMock).dryQuote(baseInput);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string).dry).toBe(true);
  });

  it("rejects a bad amount before any network call", async () => {
    const fetchMock = vi.fn();
    await expect(makeClient(fetchMock).quote({ ...baseInput, amount: "1.5" })).rejects.toThrow(OneClickError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a fee above the cap at construction", () => {
    expect(() => makeClient(vi.fn(), { fee: { recipient: "unpair.near", feeBps: 101 } })).toThrow();
  });

  it("surfaces HTTP errors with the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "no route" }, 400));
    await expect(makeClient(fetchMock).quote(baseInput)).rejects.toMatchObject({
      name: "OneClickError",
      httpStatus: 400,
      body: { message: "no route" },
    });
  });
});

describe("OneClickClient.previewFee", () => {
  it("shows the split with a key", () => {
    const p = makeClient(vi.fn(), { apiKey: "jwt" }).previewFee({ symbol: "ETH" }, { symbol: "ZEC" }, "EXACT_INPUT");
    expect(p.breakdown).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
    expect(p.text).toBe("Fee 0.5% of the amount you send. Unpair keeps 0.25%, 1Click keeps 0.25%.");
    expect(p.appFees).toEqual([{ recipient: "unpair.near", fee: 50 }]);
  });
  it("estimates the same split without a key", () => {
    const p = makeClient(vi.fn()).previewFee({ symbol: "ETH" }, { symbol: "ZEC" }, "EXACT_INPUT");
    expect(p.breakdown).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
  });
  it("reads the exact fee back from a quote response", () => {
    const res = {
      ...quoteResponse,
      quoteRequest: { ...quoteResponse.quoteRequest, appFees: [{ recipient: "unpair.near", fee: 25 }, { recipient: "1click", fee: 25 }] },
    };
    const p = makeClient(vi.fn()).feeFromQuoteResponse(res);
    expect(p.breakdown).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
    expect(p.text).toBe("Fee 0.5% of the amount you send. Unpair keeps 0.25%, 1Click keeps 0.25%.");
  });
  it("shows no partner fee on ANY_INPUT", () => {
    const p = makeClient(vi.fn(), { apiKey: "jwt" }).previewFee({ symbol: "USDC" }, { symbol: "USDT" }, "ANY_INPUT");
    expect(p.breakdown).toMatchObject({ partnerBps: 0, oneClickBps: 1, totalBps: 1 });
    expect(p.appFees).toBeUndefined();
  });
});

describe("status and route mapping", () => {
  const statusResponse: StatusResponse = {
    correlationId: "c1",
    quoteResponse,
    status: "SUCCESS",
    updatedAt: NOW.toISOString(),
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [{ hash: "abc", explorerUrl: "https://x" }],
      amountOut: "6000000000",
    },
  };

  it("maps 1Click statuses to Unpair states", () => {
    expect(oneClickStatusToState("PENDING_DEPOSIT")).toBe("waiting_for_deposit");
    expect(oneClickStatusToState("KNOWN_DEPOSIT_TX")).toBe("routing");
    expect(oneClickStatusToState("INCOMPLETE_DEPOSIT")).toBe("routing");
    expect(oneClickStatusToState("PROCESSING")).toBe("routing");
    expect(oneClickStatusToState("SUCCESS")).toBe("landed");
    expect(oneClickStatusToState("REFUNDED")).toBe("refunded");
    expect(oneClickStatusToState("FAILED")).toBe("failed");
  });

  it("queries status with the deposit address and memo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(statusResponse));
    const s = await makeClient(fetchMock).status("0xdeposit", "m1");
    expect(s.status).toBe("SUCCESS");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=0xdeposit&depositMemo=m1");
  });

  it("waits for a final status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...statusResponse, status: "PENDING_DEPOSIT" }))
      .mockResolvedValueOnce(jsonResponse({ ...statusResponse, status: "PROCESSING" }))
      .mockResolvedValueOnce(jsonResponse(statusResponse));
    const seen: string[] = [];
    const s = await makeClient(fetchMock).waitForFinalStatus("0xdeposit", undefined, {
      intervalMs: 1,
      onUpdate: (u) => seen.push(u.status),
    });
    expect(s.status).toBe("SUCCESS");
    expect(seen).toEqual(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]);
  });

  it("wraps 1Click as a Route", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(quoteResponse)).mockResolvedValueOnce(jsonResponse(statusResponse));
    const client = makeClient(fetchMock, { apiKey: "jwt" });
    const route = new OneClickRoute(client, () => 50);
    const q = await route.quote(baseInput);
    expect(q).toMatchObject({ routeId: "oneclick", amountOut: 6_000_000_000n, depositAddress: "0xdeposit", totalFeeBps: 50 });
    const s = await route.status("0xdeposit");
    expect(s).toMatchObject({ state: "landed", amountOut: 6_000_000_000n, operatorStatus: "SUCCESS" });
  });
});
