import { describe, expect, it } from "vitest";
import {
  FEE_CAP_BPS,
  FeeError,
  bpsToPercent,
  describeFee,
  feeFromEchoedAppFees,
  feeFromInput,
  grossInputForRequired,
  oneClickFeeBreakdown,
} from "../src/fees.js";

describe("oneClickFeeBreakdown", () => {
  it("matches the docs examples with an API key", () => {
    expect(oneClickFeeBreakdown(5, { hasApiKey: true })).toMatchObject({ partnerBps: 3, oneClickBps: 20, totalBps: 23 });
    expect(oneClickFeeBreakdown(21, { hasApiKey: true })).toMatchObject({ partnerBps: 11, oneClickBps: 20, totalBps: 31 });
    expect(oneClickFeeBreakdown(40, { hasApiKey: true })).toMatchObject({ partnerBps: 20, oneClickBps: 20, totalBps: 40 });
    expect(oneClickFeeBreakdown(50, { hasApiKey: true })).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
  });

  it("charges 20 bps with a key and no fee, 1 bp on stable routes", () => {
    expect(oneClickFeeBreakdown(0, { hasApiKey: true })).toMatchObject({ partnerBps: 0, oneClickBps: 20, totalBps: 20 });
    expect(oneClickFeeBreakdown(0, { hasApiKey: true, stableRoute: true })).toMatchObject({ oneClickBps: 1, totalBps: 1 });
    expect(oneClickFeeBreakdown(10, { hasApiKey: true, stableRoute: true })).toMatchObject({ partnerBps: 5, oneClickBps: 5, totalBps: 10 });
  });

  it("matches live behaviour without an API key (2026-10-25 dry quotes)", () => {
    expect(oneClickFeeBreakdown(0, { hasApiKey: false })).toMatchObject({ partnerBps: 0, oneClickBps: 20, totalBps: 20 });
    expect(oneClickFeeBreakdown(5, { hasApiKey: false })).toMatchObject({ partnerBps: 3, oneClickBps: 20, totalBps: 23 });
    expect(oneClickFeeBreakdown(50, { hasApiKey: false })).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
    expect(oneClickFeeBreakdown(100, { hasApiKey: false })).toMatchObject({ partnerBps: 50, oneClickBps: 50, totalBps: 100 });
  });

  it("reads the exact split from echoed appFees", () => {
    const echoed = [
      { recipient: "unpair.near", fee: 25 },
      { recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 25 },
    ];
    expect(feeFromEchoedAppFees(echoed, "unpair.near", { hasApiKey: false })).toMatchObject({ partnerBps: 25, oneClickBps: 25, totalBps: 50 });
    expect(feeFromEchoedAppFees([{ recipient: "x", fee: 20 }], null, { hasApiKey: true })).toMatchObject({ partnerBps: 0, oneClickBps: 20, totalBps: 20 });
    expect(feeFromEchoedAppFees(undefined, "unpair.near", { hasApiKey: true })).toMatchObject({ totalBps: 0 });
  });

  it("refuses fees above the code cap", () => {
    expect(() => oneClickFeeBreakdown(FEE_CAP_BPS + 1, { hasApiKey: true })).toThrow(FeeError);
    expect(() => oneClickFeeBreakdown(-1, { hasApiKey: true })).toThrow(FeeError);
    expect(() => oneClickFeeBreakdown(2.5, { hasApiKey: true })).toThrow(FeeError);
  });
});

describe("fee amounts", () => {
  it("floors the fee on exact input, as in the docs", () => {
    expect(feeFromInput(1_000_000n, 100)).toEqual({ fee: 10_000n, netIn: 990_000n });
  });
  it("ceils the gross input on exact output, as in the docs", () => {
    expect(grossInputForRequired(500_000n, 100)).toEqual({ grossIn: 505_051n, fee: 5_051n });
  });
});

describe("words", () => {
  it("formats bps", () => {
    expect(bpsToPercent(50)).toBe("0.5%");
    expect(bpsToPercent(100)).toBe("1%");
    expect(bpsToPercent(23)).toBe("0.23%");
    expect(bpsToPercent(1)).toBe("0.01%");
  });
  it("describes the fee without an em dash", () => {
    const text = describeFee(oneClickFeeBreakdown(50, { hasApiKey: true }), "1Click");
    expect(text).toBe("Fee 0.5% of the amount you send. Unpair keeps 0.25%, 1Click keeps 0.25%.");
    expect(text).not.toContain("—");
  });
});
