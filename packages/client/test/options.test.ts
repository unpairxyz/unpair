import { describe, expect, it } from "vitest";
import { DEFAULT_ADVANCED, DEFAULT_ROUTE, ROUTES, TOR_HINT, WAIT_COPY, WALLET_COPY, checkAdvanced, routeInfo } from "../src/options.js";

describe("options", () => {
  it("defaults to 1Click and lists it as available", () => {
    expect(routeInfo(DEFAULT_ROUTE).available).toBe(true);
    expect(ROUTES[0]?.id).toBe("oneclick");
  });

  it("keeps unavailable routes listed with a reason", () => {
    for (const r of ROUTES) {
      if (!r.available) expect(r.note.length).toBeGreaterThan(10);
    }
    expect(routeInfo("thorchain").available).toBe(false);
    expect(routeInfo("maya").payout).toBe("shielded");
  });

  it("checks slippage", () => {
    expect(checkAdvanced(DEFAULT_ADVANCED)).toEqual(DEFAULT_ADVANCED);
    expect(() => checkAdvanced({ ...DEFAULT_ADVANCED, slippageBps: 999 })).toThrow();
  });

  it("has no em dashes in copy", () => {
    const all = [
      ...Object.values(WALLET_COPY).flatMap((c) => [c.title, c.text]),
      ...ROUTES.flatMap((r) => [r.name, r.trusted, r.note]),
      ...Object.values(WAIT_COPY),
      TOR_HINT,
    ];
    for (const s of all) expect(s).not.toContain("—");
  });
});
