/**
 * Zcash address checks for the destination and refund fields.
 *
 * 1Click pays a transparent address, or an Orchard-only unified address
 * straight into Ironwood. A unified address that also carries a transparent
 * receiver is probably paid to that receiver. Sapling-only is not paid. The
 * verdict says where the ZEC will land so the user can choose.
 */
import { decodeUnified, isExpired, type Receivers } from "./unified.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type AddressCheck =
  | { kind: "transparent"; network: "mainnet" | "testnet"; p2sh: boolean }
  | { kind: "unified"; network: "mainnet" | "testnet"; receivers: Receivers; revision: 0 | 2; expired: boolean }
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
  if (/^(u|utest|zu|tu|zutest|tutest)1/.test(lower)) {
    const u = decodeUnified(s);
    if (!u) return { kind: "invalid", reason: "This unified address does not decode. Check for typos." };
    return { kind: "unified", network: u.network, receivers: u.receivers, revision: u.revision, expired: isExpired(u, { unixSeconds: Math.floor(Date.now() / 1000) }) };
  }
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

export type Landing = "shielded" | "transparent";

export interface Verdict {
  ok: boolean;
  text: string;
  /** Where the ZEC lands when ok. */
  landing?: Landing;
}

/** Plain words for the address field, for the 1Click route. */
export function describeCheck(c: AddressCheck): Verdict {
  switch (c.kind) {
    case "transparent":
      return c.network === "mainnet"
        ? { ok: true, landing: "transparent", text: "Transparent Zcash address. Your wallet shields what lands here." }
        : { ok: false, text: "This is a testnet address. Unpair routes on mainnet." };
    case "unified": {
      if (c.network !== "mainnet") return { ok: false, text: "This is a testnet address. Unpair routes on mainnet." };
      const r = c.receivers;
      if (c.expired) return { ok: false, text: "This address has expired. Ask your wallet for a fresh one." };
      if (c.revision === 2) return { ok: false, text: "This is a new address format that the routes do not accept yet. Paste a classic unified address starting with u1, or a transparent address, from the same wallet." };
      if (r.unknown.length > 0) return { ok: false, text: "This unified address uses a newer format than this page understands. Paste a transparent address from the same wallet." };
      if (r.p2pkh || r.p2sh) {
        return {
          ok: true,
          landing: "transparent",
          text: "This unified address has a transparent receiver, so the route pays that one and your wallet shields it. For a payout straight into the shielded pool, paste a shielded-only address from the same wallet if it offers one.",
        };
      }
      if (r.orchard) {
        return {
          ok: true,
          landing: "shielded",
          text: "Shielded-only address. The route pays straight into the shielded pool, with no transparent step. The amount and this address are readable on chain for this one payout, so use a fresh address.",
        };
      }
      return { ok: false, text: "This unified address has only a Sapling receiver, which the route cannot pay. Paste a transparent or Orchard address from the same wallet." };
    }
    case "sapling":
      return { ok: false, text: "This is a Sapling address, which the route cannot pay. Paste a transparent or unified address from the same wallet." };
    case "invalid":
      return { ok: false, text: c.reason };
  }
}

/**
 * Plain words for a Zcash refund address, for the 1Click route. The same
 * receiver rules apply as for a payout: a shielded-only unified address is
 * refunded straight into the pool, a transparent receiver is paid in the open.
 */
export function describeRefundCheck(c: AddressCheck): Verdict {
  const v = describeCheck(c);
  if (!v.ok) return v;
  if (v.landing === "shielded") {
    return { ok: true, landing: "shielded", text: "Shielded-only address. If the route fails, the ZEC comes back straight into the shielded pool. The amount and this address are readable on chain for that one refund, so use a fresh address." };
  }
  return { ok: true, landing: "transparent", text: "Transparent receiver. If the route fails, the ZEC comes back here in the open and your wallet shields it again. For a refund straight into the pool, paste a shielded-only address from the same wallet." };
}
