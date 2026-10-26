import { describe, expect, it } from "vitest";
import { HOP2_FEE_RESERVE_FLOOR_ZAT, hop2FeeReserveZat } from "../src/wallet/fees";

describe("hop2FeeReserveZat", () => {
  it("keeps the old floor for one or two notes", () => {
    expect(hop2FeeReserveZat(1)).toBe(20_000n);
    expect(hop2FeeReserveZat(2)).toBe(20_000n);
    expect(hop2FeeReserveZat(0)).toBe(HOP2_FEE_RESERVE_FLOOR_ZAT);
    expect(hop2FeeReserveZat(Number.NaN)).toBe(HOP2_FEE_RESERVE_FLOOR_ZAT);
  });
  it("adds one action per extra note", () => {
    expect(hop2FeeReserveZat(3)).toBe(25_000n);
    expect(hop2FeeReserveZat(4)).toBe(30_000n);
    expect(hop2FeeReserveZat(10)).toBe(60_000n);
  });
});
