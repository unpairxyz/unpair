import { describe, expect, it } from "vitest";
import { DEFAULT_ADVANCED, DEFAULT_ROUTE, DEFAULT_WALLET, ROUTES, TOR_HINT, WAIT_COPY, WALLET_CHOICES, WALLET_COPY, checkAdvanced, routeInfo, walletInfo } from "../src/options.js";

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

  it("says plainly what the hosted choice costs", () => {
    expect(walletInfo(DEFAULT_WALLET).custody).toBe("you");
    const hosted = walletInfo("hosted");
    expect(hosted.custody).toBe("unpair");
    expect(hosted.text).toMatch(/sees both ends/);
    expect(hosted.text).toMatch(/holds your funds/);
    expect(hosted.note.length).toBeGreaterThan(10);
    for (const w of WALLET_CHOICES) expect(w.available).toBe(true);
    expect(WALLET_COPY.own.title).toBe(walletInfo("own").title);
  });

  it("checks slippage", () => {
    expect(checkAdvanced(DEFAULT_ADVANCED)).toEqual(DEFAULT_ADVANCED);
    expect(() => checkAdvanced({ ...DEFAULT_ADVANCED, slippageBps: 999 })).toThrow();
  });

  it("has no em dashes in copy", () => {
    const all = [
      ...WALLET_CHOICES.flatMap((w) => [w.title, w.text, w.note]),
      ...ROUTES.flatMap((r) => [r.name, r.trusted, r.note]),
      ...Object.values(WAIT_COPY),
      TOR_HINT,
    ];
    for (const s of all) expect(s).not.toContain("—");
  });
});
