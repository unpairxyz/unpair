import { chainKind, type ChainKind } from "@unpair/client";

// Address checks live in @unpair/client (checkAddressForChain). This file only holds input hints.
export const kindOf = chainKind;

export const PLACEHOLDER: Record<ChainKind, string> = {
  evm: "0x…", sol: "Solana address", btc: "bc1…", ltc: "ltc1…", doge: "D…", bch: "bitcoincash:q…", dash: "X…",
  zec: "u1… or t1…", tron: "T…", ton: "UQ…", stellar: "G…", xrp: "r…", cardano: "addr1…", near: "name.near",
  sui: "0x… (64 hex)", aptos: "0x… (64 hex)", starknet: "0x…", aleo: "aleo1…", other: "Address",
};
