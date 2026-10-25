import { chainLabel } from "./tokens";

// Shape checks only, so the form can name a wrong chain early. The swap service checks again.
export type AddressKind =
  | "evm" | "sol" | "btc" | "ltc" | "doge" | "bch" | "dash" | "zec" | "tron" | "ton" | "stellar"
  | "xrp" | "cardano" | "near" | "sui" | "aptos" | "starknet" | "aleo" | "other";

const EVM_CHAINS = ["eth", "base", "arb", "op", "bsc", "pol", "avax", "gnosis", "bera", "scroll", "monad", "xlayer", "plasma", "hood", "abs", "adi", "hypercore"];
const KIND_OF: Record<string, AddressKind> = {
  ...Object.fromEntries(EVM_CHAINS.map((c) => [c, "evm" as const])),
  sol: "sol", fogo: "sol", btc: "btc", ltc: "ltc", doge: "doge", bch: "bch", dash: "dash", zec: "zec", tron: "tron",
  ton: "ton", stellar: "stellar", xrp: "xrp", cardano: "cardano", near: "near", sui: "sui", aptos: "aptos",
  movement: "aptos", starknet: "starknet", aleo: "aleo",
};
export const kindOf = (chain: string): AddressKind => KIND_OF[chain] ?? "other";

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const B32 = "[02-9ac-hj-np-z]";
const RX: Record<AddressKind, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  sol: new RegExp(`^${B58}{32,44}$`),
  btc: new RegExp(`^(bc1${B32}{25,62}|[13]${B58}{25,34})$`),
  ltc: new RegExp(`^(ltc1${B32}{25,62}|[LM3]${B58}{26,33})$`),
  doge: new RegExp(`^D[5-9A-HJ-NP-U]${B58}{32}$`),
  bch: new RegExp(`^(bitcoincash:)?[qp]${B32}{41}$`),
  dash: new RegExp(`^X${B58}{33}$`),
  zec: new RegExp(`^(t[13]${B58}{33}|zs1${B32}{70,80}|u1${B32}{90,})$`),
  tron: new RegExp(`^T${B58}{33}$`),
  ton: /^((EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})$/,
  stellar: /^G[A-Z2-7]{55}$/,
  xrp: new RegExp(`^r${B58}{24,34}$`),
  cardano: new RegExp(`^addr1${B32}{50,110}$`),
  near: /^([0-9a-f]{64}|([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)+)$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{64}$/,
  starknet: /^0x[0-9a-fA-F]{50,64}$/,
  aleo: new RegExp(`^aleo1${B32}{58}$`),
  other: /^\S{20,}$/,
};

const KIND_NAME: Record<AddressKind, string> = {
  evm: "an Ethereum-style", sol: "a Solana", btc: "a Bitcoin", ltc: "a Litecoin", doge: "a Dogecoin", bch: "a Bitcoin Cash",
  dash: "a Dash", zec: "a Zcash", tron: "a Tron", ton: "a TON", stellar: "a Stellar", xrp: "an XRP", cardano: "a Cardano",
  near: "a NEAR", sui: "a Sui", aptos: "an Aptos", starknet: "a Starknet", aleo: "an Aleo", other: "an",
};

export const PLACEHOLDER: Record<AddressKind, string> = {
  evm: "0x…", sol: "Solana address", btc: "bc1…", ltc: "ltc1…", doge: "D…", bch: "bitcoincash:q…", dash: "X…",
  zec: "u1… or t1…", tron: "T…", ton: "UQ…", stellar: "G…", xrp: "r…", cardano: "addr1…", near: "name.near",
  sui: "0x… (64 hex)", aptos: "0x… (64 hex)", starknet: "0x…", aleo: "aleo1…", other: "Address",
};

export type ShapeCheck = { ok: true } | { ok: false; empty: boolean; message: string };

/** `what` names the field in the message, such as "receiving" or "refund". */
export function checkShape(input: string, chain: string, what: string): ShapeCheck {
  const v = input.trim();
  if (!v) return { ok: false, empty: true, message: "" };
  const kind = kindOf(chain);
  if (RX[kind].test(v)) return { ok: true };
  for (const k of Object.keys(RX) as AddressKind[]) {
    if (k !== kind && k !== "other" && RX[k].test(v)) {
      return { ok: false, empty: false, message: `That looks like ${KIND_NAME[k]} address. I need ${KIND_NAME[kind]} address on ${chainLabel(chain)} for the ${what}.` };
    }
  }
  return { ok: false, empty: false, message: `That ${what} address has a typo. Copy it again.` };
}
