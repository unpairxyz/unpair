import { describe, expect, it } from "vitest";
import { parseRecovery, recoveryFileName } from "../src/wallet/browserWallet";

const phrase = Array(24).fill("abandon").join(" ");
const good = { unpair: 1, network: "main", phrase, birthday: 3_530_385, created: "2026-10-25T20:00:00.000Z", plan: { destinationAsset: "nep141:eth.omft.near", recipient: "0xabc", mode: "quiet", slippageBps: 100 } };

describe("recovery file", () => {
  it("reads a good file and keeps the plan", () => {
    const r = parseRecovery(JSON.stringify(good), "main");
    expect(r.birthday).toBe(3_530_385);
    expect(r.phrase.split(" ")).toHaveLength(24);
    expect(r.plan?.mode).toBe("quiet");
  });

  it("drops a plan it cannot use", () => {
    const r = parseRecovery(JSON.stringify({ ...good, plan: { recipient: "0xabc" } }), "main");
    expect(r.plan).toBeUndefined();
  });

  it("refuses the wrong network, a short phrase, and other files", () => {
    expect(() => parseRecovery(JSON.stringify(good), "test")).toThrow(/mainnet/);
    expect(() => parseRecovery(JSON.stringify({ ...good, phrase: "a b c" }), "main")).toThrow(/24 word/);
    expect(() => parseRecovery(JSON.stringify({ ...good, birthday: -1 }), "main")).toThrow(/birthday/);
    expect(() => parseRecovery("{}", "main")).toThrow(/not an Unpair/);
    expect(() => parseRecovery("not json", "main")).toThrow(/not a recovery/);
  });

  it("names the file by the day", () => {
    expect(recoveryFileName(new Date("2026-10-25T23:59:00Z"))).toBe("unpair-recovery-2026-10-25.json");
  });
});
