import { describe, expect, it } from "vitest";
import { chainKind, checkAddressForChain, looksLike } from "../src/chains.js";

describe("chains", () => {
  it("maps every 1Click chain to a family", () => {
    const chains = ["abs", "adi", "aleo", "aptos", "arb", "avax", "base", "bch", "bera", "bsc", "btc", "cardano", "dash", "doge", "eth", "fogo", "gnosis", "hood", "hypercore", "ltc", "monad", "movement", "near", "op", "plasma", "pol", "qtc", "scroll", "sol", "starknet", "stellar", "sui", "ton", "tron", "xlayer", "xrp", "zec"];
    for (const c of chains) expect(typeof chainKind(c)).toBe("string");
    expect(chainKind("base")).toBe("evm");
    expect(chainKind("fogo")).toBe("sol");
    expect(chainKind("movement")).toBe("aptos");
    expect(chainKind("qtc")).toBe("other");
  });

  it("accepts right shapes", () => {
    expect(checkAddressForChain("0x1Bbb07772937909Da8eD25B28AEE0473314af9B3", "base").ok).toBe(true);
    expect(checkAddressForChain("0x1bbb07772937909da8ed25b28aee0473314af9b3", "eth").ok).toBe(true);
    expect(checkAddressForChain("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F", "zec").ok).toBe(true);
    expect(checkAddressForChain("u1gsqvqxx6lmmqg05uvx57gjdg5j3a54nxw09z4vq4z0yp7dfdcjrqk5wq64quwzrufmujd5e8xu5jn7cyewjaptxc8lsqwa2lk559u4cd", "zec").ok).toBe(true);
    expect(checkAddressForChain("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "btc").ok).toBe(true);
    expect(checkAddressForChain("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "btc").ok).toBe(true);
    expect(checkAddressForChain("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "sol").ok).toBe(true);
    expect(checkAddressForChain("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", "tron").ok).toBe(true);
    expect(checkAddressForChain("alice.near", "near").ok).toBe(true);
    expect(checkAddressForChain("GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", "stellar").ok).toBe(true);
    expect(checkAddressForChain("rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", "xrp").ok).toBe(true);
    expect(checkAddressForChain("EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2", "ton").ok).toBe(true);
    expect(checkAddressForChain("0x" + "a".repeat(64), "sui").ok).toBe(true);
  });

  it("names the family a wrong paste looks like", () => {
    const r = checkAddressForChain("0x1Bbb07772937909Da8eD25B28AEE0473314af9B3", "sol");
    expect(r.ok).toBe(false);
    expect(r.looksLike).toBe("evm");
    expect(r.text).toMatch(/Ethereum-style/);
    const z = checkAddressForChain("t1dUDJ62ANtmebE8drFg7g2MWYwXHQ6Xu3F", "btc");
    expect(z.ok).toBe(false);
    expect(z.text).toMatch(/Zcash/);
    expect(checkAddressForChain("", "eth").ok).toBe(false);
    expect(checkAddressForChain("hello world", "eth").ok).toBe(false);
    expect(checkAddressForChain("zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly", "zec").ok).toBe(false);
    expect(looksLike("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8")).toContain("tron");
  });

  it("refuses a bad EIP-55 checksum", () => {
    expect(checkAddressForChain("0x1bbb07772937909Da8eD25B28AEE0473314af9B3", "eth").ok).toBe(false);
  });
});
