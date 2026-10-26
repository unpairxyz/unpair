import { describe, expect, it } from "vitest";
import type { TokenInfo } from "@unpair/sdk";
import { HOSTED_COPY, STATE_COPY, hostedStage, isHostedFinal, planAmount } from "../src/swap.js";

const eth: TokenInfo = { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: 3000, priceUpdatedAt: "" };

describe("planAmount", () => {
  it("keeps the exact amount in fast mode", () => {
    const p = planAmount("0.493", eth, "fast");
    expect(p).toEqual({ requested: 493_000_000_000_000_000n, send: 493_000_000_000_000_000n, heldBack: 0n });
  });
  it("rounds to the coarse grid in quiet mode", () => {
    const p = planAmount("0.493", eth, "quiet");
    expect(p).toEqual({ requested: 493_000_000_000_000_000n, send: 200_000_000_000_000_000n, heldBack: 293_000_000_000_000_000n });
  });
  it("rejects bad input", () => {
    expect(planAmount("abc", eth, "fast")).toHaveProperty("error");
    expect(planAmount("0", eth, "fast")).toHaveProperty("error");
    expect(planAmount("1.1234567890123456789", eth, "fast")).toHaveProperty("error");
  });
});

describe("copy", () => {
  it("has no em dashes anywhere", () => {
    const all = Object.values(STATE_COPY).flatMap((s) => [s.label, s.text]);
    for (const s of all) expect(s).not.toContain("—");
  });
});

describe("hosted", () => {
  it("maps hosted states onto the four panels", () => {
    expect(hostedStage("waiting_for_deposit")).toBe(-1);
    expect(hostedStage("routing_in")).toBe(1);
    expect(hostedStage("in_pool")).toBe(2);
    expect(hostedStage("routing_out")).toBe(3);
    expect(hostedStage("done")).toBe(4);
    expect(isHostedFinal("done")).toBe(true);
    expect(isHostedFinal("in_pool")).toBe(false);
    for (const c of Object.values(HOSTED_COPY)) {
      expect(c.text).not.toContain("\u2014");
      expect(c.text).not.toMatch(/hold nothing/i);
    }
    expect(HOSTED_COPY.done.text).toMatch(/saw both ends/);
  });
});
