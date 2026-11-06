import { describe, expect, it, vi } from "vitest";
import { ApiClient, type ScreenList, type ScreenVerdict } from "../src/api.js";
import { LIST_HASH, addressHash, screenPrivately } from "../src/screening.js";

// The server's test in apps/api/src/screening.rs has the same vectors.
describe("addressHash matches the server", () => {
  it("hashes the trimmed, lower-case address", () => {
    expect(addressHash("0xabc")).toBe("eb4b9e8905923468a20ce3dc86bcdefef67f743a8156f44ca52e548e62e2c8f0");
    expect(addressHash(" 0xABC ")).toBe(addressHash("0xabc"));
    expect(addressHash("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F")).toBe("52680b61dbf16729d6c9a0f97e86b9556613f79564a6d70a22d887cace87f52e");
  });
});

function apiWith(list: ScreenList, screen = vi.fn(async (_address: string): Promise<ScreenVerdict> => ({ allowed: true, reason: null }))) {
  const api = new ApiClient("https://api.test");
  vi.spyOn(api, "screenList").mockResolvedValue(list);
  vi.spyOn(api, "screen").mockImplementation(screen);
  return { api, screen };
}

const listed = "0xListed0000000000000000000000000000000001";

describe("screenPrivately", () => {
  it("checks on the page and never sends the address", async () => {
    const { api, screen } = apiWith({ allowed: true, reason: null, hash: LIST_HASH, entries: [addressHash(listed)] });
    expect(await screenPrivately(api, [["0xfine", "base"]])).toEqual({ allowed: true, sent: false });
    expect(await screenPrivately(api, [["0xfine", "base"], [listed.toUpperCase(), "eth"]])).toEqual({ allowed: false, reason: "This address cannot be used with Unpair." });
    expect(screen).not.toHaveBeenCalled();
  });

  it("stops in a region Unpair does not serve", async () => {
    const { api } = apiWith({ allowed: false, reason: "Unpair is not available in your region.", hash: LIST_HASH, entries: [] });
    expect(await screenPrivately(api, [["0xfine", "base"]])).toEqual({ allowed: false, reason: "Unpair is not available in your region." });
  });

  it("asks per address, and says so, when the server has no list", async () => {
    const screen = vi.fn(async (a: string): Promise<ScreenVerdict> => ({ allowed: a !== "0xbad", reason: a === "0xbad" ? "No." : null }));
    const { api } = apiWith({ allowed: true, reason: null, hash: LIST_HASH, entries: null }, screen);
    expect(await screenPrivately(api, [["0xfine", "base"]])).toEqual({ allowed: true, sent: true });
    expect(await screenPrivately(api, [["0xbad", "base"]])).toEqual({ allowed: false, reason: "No." });
  });

  it("refuses a list made another way", async () => {
    const { api } = apiWith({ allowed: true, reason: null, hash: "md5(address)", entries: [] });
    expect((await screenPrivately(api, [["0xfine", "base"]])).allowed).toBe(false);
  });
});
