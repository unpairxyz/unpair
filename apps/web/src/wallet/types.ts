/**
 * Shapes shared by the page, the wallet worker and the WebAssembly module.
 *
 * The module is built by `apps/web/scripts/build-wasm.sh` into `public/wasm/`
 * and loaded at run time, so these types are written by hand to match
 * `packages/zcash-web/src/lib.rs`. Change both together.
 */
import type { ZcashNetwork } from "../config";

export interface Landing {
  /** Orchard-only unified address. The route pays this; it lands in Ironwood. */
  shielded: string;
  /** Transparent receiver at the same index, for a refund of the second hop. */
  transparent: string;
  index: number;
}

export interface Balance {
  ironwood_spendable: number;
  ironwood_total: number;
  unshielded: number;
  chain_tip: number | null;
  scanned_to: number | null;
}

export interface Payout {
  txid: string;
  fee: number;
}

export interface Upgrade {
  name: string;
  height: number;
  blocks_left: number;
  eta_unix: number;
  sending_paused: boolean;
}

/** The wasm-bindgen class, as the module exports it. */
export interface WasmWallet {
  recoveryPhrase(): string;
  birthdayHeight(): number;
  nextLanding(): Landing;
  sync(): Promise<number>;
  balance(): Balance;
  shield(): Promise<string[]>;
  pay(to: string, zatoshis: bigint): Promise<Payout>;
  upgradeNotice(tip: number, nowUnix: bigint): Upgrade | undefined;
  free(): void;
}

export interface WasmModule {
  default(options?: { module_or_path?: string | URL }): Promise<unknown>;
  WebWallet: {
    open(network: ZcashNetwork, grpcWebUrl: string, phrase?: string, birthdayHeight?: number): Promise<WasmWallet>;
  };
}

/** What the page asks the worker to do. One wallet per worker. */
export type WalletRequest =
  | { op: "open"; network: ZcashNetwork; url: string; phrase?: string; birthday?: number }
  | { op: "landing" }
  | { op: "sync" }
  | { op: "balance" }
  | { op: "shield" }
  | { op: "pay"; to: string; zatoshis: string }
  | { op: "phrase" }
  | { op: "birthday" }
  | { op: "upgrade"; tip: number; nowUnix: number }
  | { op: "close" };

export type WalletReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export interface WalletEnvelope {
  id: number;
  request: WalletRequest;
}
