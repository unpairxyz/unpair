import { describe, expect, it } from "vitest";
import { checkZcashAddress, describeCheck, describeRefundCheck } from "../src/zcashAddress.js";

describe("checkZcashAddress", () => {
  it("accepts a mainnet t1 address", async () => {
    const c = await checkZcashAddress("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F");
    expect(c).toEqual({ kind: "transparent", network: "mainnet", p2sh: false });
    expect(describeCheck(c).ok).toBe(true);
  });
  it("rejects a typo via checksum", async () => {
    const c = await checkZcashAddress("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3G");
    expect(c.kind).toBe("invalid");
  });
  it("accepts a unified address with a transparent receiver as a transparent landing", async () => {
    const u = await checkZcashAddress("u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g");
    expect(u.kind).toBe("unified");
    const v = describeCheck(u);
    expect(v.ok).toBe(true);
    expect(v.landing).toBe("transparent");
  });
  it("accepts an Orchard-only unified address as a shielded landing", async () => {
    const u = await checkZcashAddress("u1gsqvqxx6lmmqg05uvx57gjdg5j3a54nxw09z4vq4z0yp7dfdcjrqk5wq64quwzrufmujd5e8xu5jn7cyewjaptxc8lsqwa2lk559u4cd");
    const v = describeCheck(u);
    expect(v.ok).toBe(true);
    expect(v.landing).toBe("shielded");
    expect(v.text).toContain("fresh address");
  });
  it("refuses sapling and broken unified addresses", async () => {
    const z = await checkZcashAddress("zs1abc");
    expect(z.kind).toBe("sapling");
    expect(describeCheck(z).ok).toBe(false);
    const bad = await checkZcashAddress("u1gsqvqxx6lmmqg05uvx57gjdg5j3a54nxw09z4vq4z0yp7dfdcjrqk5wq64quwzrufmujd5e8xu5jn7cyewjaptxc8lsqwa2lk559u4cx");
    expect(bad.kind).toBe("invalid");
  });
  it("rejects garbage and empty input", async () => {
    expect((await checkZcashAddress("")).kind).toBe("invalid");
    expect((await checkZcashAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).kind).toBe("invalid");
    expect((await checkZcashAddress("t1OOOO")).kind).toBe("invalid");
  });

  it("describes refunds with the payout rule", async () => {
    const shielded = describeRefundCheck(await checkZcashAddress("u1gsqvqxx6lmmqg05uvx57gjdg5j3a54nxw09z4vq4z0yp7dfdcjrqk5wq64quwzrufmujd5e8xu5jn7cyewjaptxc8lsqwa2lk559u4cd"));
    expect(shielded.ok).toBe(true);
    expect(shielded.landing).toBe("shielded");
    expect(shielded.text).toMatch(/straight into the shielded pool/);
    const open = describeRefundCheck(await checkZcashAddress("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F"));
    expect(open.ok).toBe(true);
    expect(open.landing).toBe("transparent");
    const bad = describeRefundCheck(await checkZcashAddress("zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly"));
    expect(bad.ok).toBe(false);
    for (const v of [shielded, open, bad]) expect(v.text).not.toContain("\u2014");
  });
});
