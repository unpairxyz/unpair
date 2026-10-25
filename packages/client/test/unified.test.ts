import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bech32mDecode, decodeUnified, isExpired } from "../src/unified.js";

// From github.com/zcash/zcash-test-vectors, test-vectors/json/unified_address_r2.json.
type Row = [string | null, string | null, string | null, string | null, number | null, number | null, string, string, number, number];
const R2: Row[] = (JSON.parse(readFileSync(new URL("./fixtures/unified_address_r2.json", import.meta.url), "utf8")) as unknown[]).filter(
  (r): r is Row => Array.isArray(r) && r.length === 10,
);

// Addresses derived in Rust from the BIP-39 test phrase "abandon ... art" at
// diversifier index 0 (packages/zcash/examples/landing.rs).
const T_AND_O = "u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g";
const ORCHARD_ONLY = "u1gsqvqxx6lmmqg05uvx57gjdg5j3a54nxw09z4vq4z0yp7dfdcjrqk5wq64quwzrufmujd5e8xu5jn7cyewjaptxc8lsqwa2lk559u4cd";
const ORCHARD_ONLY_1 = "u1fqdx7vv7zam7y73vufrmp5w64rdw37c7yxlynffl2rf7leq4atcunzen42y789n82yh74v764ehx2wu7yjn0gthkdfju2mudtcjqm893";

describe("unified addresses", () => {
  it("decodes bech32m", () => {
    expect(bech32mDecode(ORCHARD_ONLY)?.hrp).toBe("u");
    expect(bech32mDecode(ORCHARD_ONLY.slice(0, -1) + "x")).toBeNull();
  });

  it("sees a transparent plus Sapling plus Orchard address", () => {
    const u = decodeUnified(T_AND_O);
    expect(u?.network).toBe("mainnet");
    expect(u?.receivers).toEqual({ p2pkh: true, p2sh: false, sapling: true, orchard: true, unknown: [] });
  });

  it("sees an Orchard-only address", () => {
    for (const a of [ORCHARD_ONLY, ORCHARD_ONLY_1]) {
      const u = decodeUnified(a);
      expect(u?.receivers).toEqual({ p2pkh: false, p2sh: false, sapling: false, orchard: true, unknown: [] });
    }
  });

  it("decodes every ZIP 316 revision 2 vector", () => {
    expect(R2.length).toBe(60);
    for (const [p2pkh, p2sh, sapling, orchard, height, time, addr] of R2) {
      const u = decodeUnified(addr);
      expect(u, addr).not.toBeNull();
      expect(u?.revision).toBe(2);
      expect(u?.network).toBe("mainnet");
      expect(u?.receivers.p2pkh).toBe(p2pkh !== null);
      expect(u?.receivers.p2sh).toBe(p2sh !== null);
      expect(u?.receivers.sapling).toBe(sapling !== null);
      expect(u?.receivers.orchard).toBe(orchard !== null);
      expect(u?.expiryHeight).toBe(height);
      expect(u?.expiryTime).toBe(time);
      if (addr.startsWith("zu")) expect(u?.receivers.p2pkh || u?.receivers.p2sh).toBe(false);
    }
  });

  it("judges expiry from time, and from height when known", () => {
    const withTime = R2.find((r) => r[5] !== null)!;
    const u = decodeUnified(withTime[6])!;
    expect(isExpired(u, { unixSeconds: u.expiryTime! + 1 })).toBe(true);
    expect(isExpired(u, { unixSeconds: u.expiryTime! - 1 })).toBe(u.expiryHeight !== null ? false : false);
    const withHeight = R2.find((r) => r[4] !== null && r[5] === null)!;
    const h = decodeUnified(withHeight[6])!;
    expect(isExpired(h, { unixSeconds: 0 })).toBe(false);
    expect(isExpired(h, { unixSeconds: 0, height: h.expiryHeight! + 1 })).toBe(true);
  });

  it("refuses junk and typos", () => {
    expect(decodeUnified("u1hello")).toBeNull();
    expect(decodeUnified(T_AND_O.replace("u16sw", "u16sx"))).toBeNull();
    expect(decodeUnified("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F")).toBeNull();
  });
});
