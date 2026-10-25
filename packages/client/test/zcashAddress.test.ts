import { describe, expect, it } from "vitest";
import { checkZcashAddress, describeCheck } from "../src/zcashAddress.js";

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
  it("recognises unified and sapling addresses and refuses them", async () => {
    const u = await checkZcashAddress("u16sw4v6wy7f4jzdny55yzl020tp3yqg3c85dc6n7mmq0urfm6adqg79hxmyk85ufn4lun4pfh5q48cc3kvxhxm3w978eqqecdd260gkzjrkun6z7m9mcrt2zszaj0mvk6ufux2zteqwh57cq906hz3rkg63duaeqsvjelv9h5srct0zq8rvlv23wz5hed7zuatqd7p6p4ztugc4t4w2g");
    expect(u.kind).toBe("unified");
    expect(describeCheck(u).ok).toBe(false);
    expect(describeCheck(u).text).toContain("transparent");
    const z = await checkZcashAddress("zs1abc");
    expect(z.kind).toBe("sapling");
  });
  it("rejects garbage and empty input", async () => {
    expect((await checkZcashAddress("")).kind).toBe("invalid");
    expect((await checkZcashAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).kind).toBe("invalid");
    expect((await checkZcashAddress("t1OOOO")).kind).toBe("invalid");
  });
});
