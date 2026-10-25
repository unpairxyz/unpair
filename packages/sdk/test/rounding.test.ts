import { describe, expect, it } from "vitest";
import { RoundingError, formatUnits, parseUnits, roundDownCoarse, roundDownSignificant } from "../src/rounding.js";

const zec = (s: string) => parseUnits(s, 8);

describe("roundDownSignificant", () => {
  it("keeps one significant digit by default", () => {
    expect(roundDownSignificant(zec("4.93")).amount).toBe(zec("4"));
    expect(roundDownSignificant(zec("0.37")).amount).toBe(zec("0.3"));
    expect(roundDownSignificant(zec("123.4")).amount).toBe(zec("100"));
  });
  it("returns the remainder and step", () => {
    const r = roundDownSignificant(zec("4.93"));
    expect(r.remainder).toBe(zec("0.93"));
    expect(r.step).toBe(zec("1"));
    expect(r.amount + r.remainder).toBe(zec("4.93"));
  });
  it("supports more digits", () => {
    expect(roundDownSignificant(zec("4.937"), 2).amount).toBe(zec("4.9"));
  });
  it("rejects amounts below the minimum", () => {
    expect(() => roundDownSignificant(0n)).toThrow(RoundingError);
    expect(() => roundDownSignificant(zec("0.001"), 1, { minUnits: zec("0.01") })).toThrow(RoundingError);
  });
});

describe("roundDownCoarse", () => {
  it("rounds to 1, 2, 5 per decade", () => {
    expect(roundDownCoarse(zec("4.93")).amount).toBe(zec("2"));
    expect(roundDownCoarse(zec("0.37")).amount).toBe(zec("0.2"));
    expect(roundDownCoarse(zec("7")).amount).toBe(zec("5"));
    expect(roundDownCoarse(zec("1")).amount).toBe(zec("1"));
    expect(roundDownCoarse(zec("50")).amount).toBe(zec("50"));
    expect(roundDownCoarse(zec("0.19")).amount).toBe(zec("0.1"));
  });
  it("never rounds above the input", () => {
    for (const s of ["0.11", "0.2", "0.49", "0.5", "0.99", "1", "1.99", "2", "4.99", "5", "9.99"]) {
      const r = roundDownCoarse(zec(s));
      expect(r.amount <= zec(s)).toBe(true);
      expect(r.amount + r.remainder).toBe(zec(s));
    }
  });
});

describe("units", () => {
  it("round-trips", () => {
    expect(formatUnits(zec("4.93"), 8)).toBe("4.93");
    expect(formatUnits(0n, 8)).toBe("0");
    expect(formatUnits(parseUnits("0.00000001", 8), 8)).toBe("0.00000001");
    expect(formatUnits(123n, 0)).toBe("123");
  });
  it("rejects too many decimals", () => {
    expect(() => parseUnits("1.123456789", 8)).toThrow(RoundingError);
    expect(() => parseUnits("abc", 8)).toThrow(RoundingError);
  });
});
