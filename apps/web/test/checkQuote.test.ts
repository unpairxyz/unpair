import { describe, expect, it } from "vitest";
import type { QuoteInput, QuoteResponse } from "@unpair/sdk";
import { checkQuote, config } from "../src/core";

const request: QuoteInput = {
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:zec.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  amount: "2000000",
  refundTo: "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs",
  refundType: "ORIGIN_CHAIN",
  recipient: "1nc1nerator11111111111111111111111111111111",
  recipientType: "DESTINATION_CHAIN",
};

const ours = config.fee?.recipient ?? "unpair.near";
function answer(over: Record<string, unknown> = {}, fees = [{ recipient: ours, fee: 25 }, { recipient: "1click", fee: 25 }], depositAddress: string | undefined = "t1Route") {
  return {
    quoteRequest: { ...request, deadline: "2026-11-06T12:00:00Z", dry: false, appFees: fees, ...over },
    quote: { amountIn: "2000000", amountOut: "26000000", ...(depositAddress ? { depositAddress } : {}) },
  } as unknown as QuoteResponse;
}

describe("checkQuote, the check before the page pays an unsigned quote", () => {
  it("passes a quote that echoes the request with the usual fee", () => {
    expect(checkQuote(request, answer())).toBeNull();
  });
  it("refuses a quote for another address, asset or amount", () => {
    expect(checkQuote(request, answer({ recipient: "AttackerSo1ana111111111111111111111111111111" }))).toMatch(/does not match/);
    expect(checkQuote(request, answer({ destinationAsset: "nep141:sol.omft.near" }))).toMatch(/does not match/);
    expect(checkQuote(request, answer({ amount: "1" }))).toMatch(/does not match/);
    expect(checkQuote(request, answer({ refundTo: "t1Other" }))).toMatch(/does not match/);
  });
  it("refuses a fee above ours plus 1Click's documented surcharge", () => {
    expect(checkQuote(request, answer({}, [{ recipient: ours, fee: 50 }, { recipient: "1click", fee: 100 }]))).toMatch(/higher fee/);
  });
  it("refuses a real quote with no address to pay", () => {
    expect(checkQuote(request, answer({}, undefined, ""))).toMatch(/no address/);
  });
});
