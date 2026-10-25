/**
 * Unified address decoding (ZIP 316), enough to know which receivers an
 * address carries. Bech32m, then the F4Jumble inverse, then the TLV list.
 *
 * Why the page needs this: 1Click pays an Orchard-only unified address
 * straight into Ironwood, but a unified address that also carries a
 * transparent receiver is probably paid to that one. So the page has to see
 * inside the address before it can say where the ZEC will land.
 */
import { blake2b } from "@noble/hashes/blake2.js";

export interface Receivers {
  p2pkh: boolean;
  p2sh: boolean;
  sapling: boolean;
  orchard: boolean;
  /** Typecodes the page does not know. Present means a newer address format. */
  unknown: number[];
}

export interface UnifiedAddress {
  network: "mainnet" | "testnet";
  receivers: Receivers;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Bech32m decode with no length cap, as unified addresses are long. */
export function bech32mDecode(s: string): { hrp: string; data: Uint8Array } | null {
  const lower = s.toLowerCase();
  if (lower !== s && s.toUpperCase() !== s) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const values: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    values.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== BECH32M_CONST) return null;
  const groups = values.slice(0, -6);
  // 5-bit groups to bytes.
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const g of groups) {
    acc = (acc << 5) | g;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return { hrp, data: new Uint8Array(out) };
}

function personal(tag: string, i: number, j: number): Uint8Array {
  const p = new Uint8Array(16);
  for (let k = 0; k < tag.length; k++) p[k] = tag.charCodeAt(k);
  p[13] = i;
  p[14] = j & 0xff;
  p[15] = (j >>> 8) & 0xff;
  return p;
}

function hFn(i: number, u: Uint8Array, len: number): Uint8Array {
  return blake2b(u, { dkLen: len, personalization: personal("UA_F4Jumble_H", i, 0) });
}

function gFn(i: number, u: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let j = 0; j * 64 < len; j++) {
    const block = blake2b(u, { dkLen: 64, personalization: personal("UA_F4Jumble_G", i, j) });
    out.set(block.subarray(0, Math.min(64, len - j * 64)), j * 64);
  }
  return out;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** F4Jumble inverse. Input length must be 48 to 4194368 bytes. */
export function f4jumbleInverse(y: Uint8Array): Uint8Array | null {
  const len = y.length;
  if (len < 48 || len > 4194368) return null;
  const lenL = Math.min(64, len >>> 1);
  const lenR = len - lenL;
  const w = y.subarray(0, lenL);
  const z = y.subarray(lenL);
  const yy = xor(w, hFn(1, z, lenL));
  const x = xor(z, gFn(1, yy, lenR));
  const a = xor(yy, hFn(0, x, lenL));
  const b = xor(x, gFn(0, a, lenR));
  const out = new Uint8Array(len);
  out.set(a, 0);
  out.set(b, lenL);
  return out;
}

function readCompact(buf: Uint8Array, at: number): [number, number] | null {
  const b0 = buf[at];
  if (b0 === undefined) return null;
  if (b0 < 253) return [b0, at + 1];
  if (b0 === 253) {
    if (at + 3 > buf.length) return null;
    return [buf[at + 1]! | (buf[at + 2]! << 8), at + 3];
  }
  return null;
}

/** Decode a unified address and list its receivers. Null when it is not one. */
export function decodeUnified(s: string): UnifiedAddress | null {
  const dec = bech32mDecode(s.trim());
  if (!dec) return null;
  const network = dec.hrp === "u" ? "mainnet" : dec.hrp === "utest" ? "testnet" : null;
  if (!network) return null;
  const raw = f4jumbleInverse(dec.data);
  if (!raw) return null;
  // The last 16 bytes are the HRP padded with zeros.
  const pad = raw.subarray(raw.length - 16);
  for (let i = 0; i < 16; i++) {
    const want = i < dec.hrp.length ? dec.hrp.charCodeAt(i) : 0;
    if (pad[i] !== want) return null;
  }
  const body = raw.subarray(0, raw.length - 16);
  const receivers: Receivers = { p2pkh: false, p2sh: false, sapling: false, orchard: false, unknown: [] };
  let at = 0;
  let count = 0;
  while (at < body.length) {
    const t = readCompact(body, at);
    if (!t) return null;
    const [typecode, afterType] = t;
    const l = readCompact(body, afterType);
    if (!l) return null;
    const [length, afterLen] = l;
    if (afterLen + length > body.length) return null;
    switch (typecode) {
      case 0x00:
        if (length !== 20) return null;
        receivers.p2pkh = true;
        break;
      case 0x01:
        if (length !== 20) return null;
        receivers.p2sh = true;
        break;
      case 0x02:
        if (length !== 43) return null;
        receivers.sapling = true;
        break;
      case 0x03:
        if (length !== 43) return null;
        receivers.orchard = true;
        break;
      default:
        // Metadata items (0xe0 and up) and future receivers. Kept, not understood.
        receivers.unknown.push(typecode);
    }
    at = afterLen + length;
    count++;
  }
  if (count === 0) return null;
  if (receivers.p2pkh && receivers.p2sh) return null;
  return { network, receivers };
}
