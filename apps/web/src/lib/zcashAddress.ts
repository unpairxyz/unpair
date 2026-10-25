/**
 * Zcash address checks for the destination field.
 *
 * 1Click pays transparent addresses only, so the destination must be a
 * t-address. A unified address is recognised and refused with a reason, so
 * the user knows to paste the transparent one from the same wallet.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type AddressCheck =
  | { kind: "transparent"; network: "mainnet" | "testnet"; p2sh: boolean }
  | { kind: "unified"; network: "mainnet" | "testnet" }
  | { kind: "sapling"; network: "mainnet" | "testnet" }
  | { kind: "invalid"; reason: string };

function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  bytes.reverse();
  let leading = 0;
  for (const ch of s) {
    if (ch === "1") leading++;
    else break;
  }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes]);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

/** Check a Zcash address string. Only transparent addresses pass fully. */
export async function checkZcashAddress(input: string): Promise<AddressCheck> {
  const s = input.trim();
  if (s === "") return { kind: "invalid", reason: "Paste a Zcash address." };
  const lower = s.toLowerCase();
  if (lower.startsWith("u1")) return { kind: "unified", network: "mainnet" };
  if (lower.startsWith("utest1")) return { kind: "unified", network: "testnet" };
  if (lower.startsWith("zs1")) return { kind: "sapling", network: "mainnet" };
  if (lower.startsWith("ztestsapling1")) return { kind: "sapling", network: "testnet" };
  if (!/^t[13m]/.test(s) || s.length < 34 || s.length > 36) {
    return { kind: "invalid", reason: "This is not a Zcash address." };
  }
  const raw = b58decode(s);
  if (!raw || raw.length !== 26) return { kind: "invalid", reason: "This is not a valid Zcash address." };
  const payload = raw.slice(0, 22);
  const checksum = raw.slice(22);
  const h = await sha256(await sha256(payload));
  for (let i = 0; i < 4; i++) {
    if (h[i] !== checksum[i]) return { kind: "invalid", reason: "The address checksum does not match. Check for typos." };
  }
  const prefix = (payload[0]! << 8) | payload[1]!;
  switch (prefix) {
    case 0x1cb8:
      return { kind: "transparent", network: "mainnet", p2sh: false };
    case 0x1cbd:
      return { kind: "transparent", network: "mainnet", p2sh: true };
    case 0x1d25:
      return { kind: "transparent", network: "testnet", p2sh: false };
    case 0x1cba:
      return { kind: "transparent", network: "testnet", p2sh: true };
    default:
      return { kind: "invalid", reason: "Unknown Zcash address type." };
  }
}

/** Plain words for the destination field. */
export function describeCheck(c: AddressCheck): { ok: boolean; text: string } {
  switch (c.kind) {
    case "transparent":
      return c.network === "mainnet"
        ? { ok: true, text: "Transparent Zcash address. Your wallet shields what lands here." }
        : { ok: false, text: "This is a testnet address. Unpair routes on mainnet." };
    case "unified":
      return {
        ok: false,
        text: "This is a unified address. The route pays transparent addresses only. Paste the transparent address from the same wallet; the wallet shields it.",
      };
    case "sapling":
      return { ok: false, text: "This is a Sapling address. Paste the transparent address from the same wallet." };
    case "invalid":
      return { ok: false, text: c.reason };
  }
}
