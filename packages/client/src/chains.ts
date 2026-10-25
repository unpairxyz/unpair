import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Address formats per 1Click chain. The page checks an address before it asks
 * for a quote, so a wrong-chain paste is caught on the device, not by the route.
 * These are shape checks, not full validation: the route validates again.
 */

export type ChainKind =
  | "evm"
  | "sol"
  | "btc"
  | "ltc"
  | "doge"
  | "bch"
  | "dash"
  | "zec"
  | "tron"
  | "ton"
  | "stellar"
  | "xrp"
  | "cardano"
  | "near"
  | "sui"
  | "aptos"
  | "starknet"
  | "aleo"
  | "other";

const EVM_CHAINS = new Set(["eth", "arb", "base", "op", "pol", "bsc", "avax", "gnosis", "scroll", "bera", "monad", "xlayer", "plasma", "hood", "hypercore", "abs", "adi"]);

/** The 1Click `blockchain` id to the address family it uses. */
export function chainKind(blockchain: string): ChainKind {
  const b = blockchain.toLowerCase();
  if (EVM_CHAINS.has(b)) return "evm";
  switch (b) {
    case "sol":
    case "fogo":
      return "sol";
    case "btc":
      return "btc";
    case "ltc":
      return "ltc";
    case "doge":
      return "doge";
    case "bch":
      return "bch";
    case "dash":
      return "dash";
    case "zec":
      return "zec";
    case "tron":
      return "tron";
    case "ton":
      return "ton";
    case "stellar":
      return "stellar";
    case "xrp":
      return "xrp";
    case "cardano":
      return "cardano";
    case "near":
      return "near";
    case "sui":
      return "sui";
    case "aptos":
    case "movement":
      return "aptos";
    case "starknet":
      return "starknet";
    case "aleo":
      return "aleo";
    default:
      return "other";
  }
}

export const KIND_NAMES: Record<ChainKind, string> = {
  evm: "an Ethereum-style address",
  sol: "a Solana address",
  btc: "a Bitcoin address",
  ltc: "a Litecoin address",
  doge: "a Dogecoin address",
  bch: "a Bitcoin Cash address",
  dash: "a Dash address",
  zec: "a Zcash address",
  tron: "a Tron address",
  ton: "a TON address",
  stellar: "a Stellar address",
  xrp: "an XRP address",
  cardano: "a Cardano address",
  near: "a NEAR account",
  sui: "a Sui address",
  aptos: "an Aptos-style address",
  starknet: "a Starknet address",
  aleo: "an Aleo address",
  other: "an address",
};

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const BECH32 = "[02-9ac-hj-np-z]";

const SHAPES: Record<Exclude<ChainKind, "other">, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  sol: new RegExp(`^${B58}{32,44}$`),
  btc: new RegExp(`^([13]${B58}{25,34}|bc1${BECH32}{25,87})$`),
  ltc: new RegExp(`^([LM3]${B58}{26,33}|ltc1${BECH32}{25,87})$`),
  doge: new RegExp(`^[DA9]${B58}{25,34}$`),
  bch: new RegExp(`^((bitcoincash:)?[qp]${BECH32}{41}|[13]${B58}{25,34})$`),
  dash: new RegExp(`^[X7]${B58}{25,34}$`),
  zec: new RegExp(`^(t[13]${B58}{33}|u1${BECH32}{50,}|zs1${BECH32}{75,}|tex1${BECH32}{38,})$`),
  tron: new RegExp(`^T${B58}{33}$`),
  ton: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$|^-?[0-9]+:[0-9a-fA-F]{64}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  xrp: new RegExp(`^r${B58}{24,34}$`),
  cardano: /^(addr1[a-z0-9]{50,}|DdzFF[1-9A-Za-z]{90,}|Ae2[1-9A-Za-z]{50,})$/,
  near: /^([a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?\.near|[a-z0-9_-]{2,64}\.(tg|testnet)|[0-9a-f]{64})$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{1,64}$/,
  starknet: /^0x[0-9a-fA-F]{1,64}$/,
  aleo: /^aleo1[a-z0-9]{58}$/,
};

export interface ChainAddressCheck {
  ok: boolean;
  text: string;
  /** When wrong, the family the input looks like, if any. */
  looksLike?: ChainKind;
}

/** Families with a telling prefix come first; Solana's plain base58 matches many strings, so it is last. */
const LOOKUP_ORDER: Array<Exclude<ChainKind, "other">> = ["evm", "zec", "tron", "xrp", "doge", "dash", "btc", "ltc", "bch", "ton", "stellar", "cardano", "aleo", "near", "sui", "aptos", "starknet", "sol"];

/** Which families an input could belong to, by shape, most specific first. */
export function looksLike(address: string): ChainKind[] {
  const a = address.trim();
  return LOOKUP_ORDER.filter((k) => SHAPES[k].test(a));
}

/** Check an address for the chain it will be used on. */
export function checkAddressForChain(address: string, blockchain: string): ChainAddressCheck {
  const a = address.trim();
  const kind = chainKind(blockchain);
  if (a === "") return { ok: false, text: "Enter an address." };
  if (/\s/.test(a)) return { ok: false, text: "The address has a space in it." };
  if (kind === "other") return { ok: true, text: "Checked by the route." };
  if (SHAPES[kind].test(a)) {
    if (kind === "evm" && /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2)) && !isChecksummed(a)) {
      return { ok: false, text: "The capital letters in this address do not match its checksum. Copy it again." };
    }
    if (kind === "zec" && (a.startsWith("zs1") || a.startsWith("tex1"))) {
      return { ok: false, text: "This Zcash address type is not paid by the routes. Use a unified address starting with u1, or a transparent address." };
    }
    return { ok: true, text: `Looks like ${KIND_NAMES[kind]}.` };
  }
  const other = looksLike(a).filter((k) => k !== kind);
  const first = other[0];
  if (first) {
    return { ok: false, text: `This looks like ${KIND_NAMES[first]}, not ${KIND_NAMES[kind]}.`, looksLike: first };
  }
  return { ok: false, text: `This is not ${KIND_NAMES[kind]}.` };
}

/** EIP-55 mixed-case check. */
function isChecksummed(address: string): boolean {
  try {
    const hex = address.slice(2);
    const hash = bytesToHex(keccak_256(new TextEncoder().encode(hex.toLowerCase())));
    for (let i = 0; i < 40; i++) {
      const c = hex[i] as string;
      const n = parseInt(hash[i] as string, 16);
      if (/[a-f]/i.test(c) && (n >= 8 ? c.toUpperCase() : c.toLowerCase()) !== c) return false;
    }
    return true;
  } catch {
    return true;
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
