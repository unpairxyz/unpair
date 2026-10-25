/**
 * Typed calls into the Rust side. Every command name here matches one in
 * src-tauri/src/main.rs.
 */
import { invoke } from "@tauri-apps/api/core";

export interface WalletStatus {
  has_seed: boolean;
  backed_up: boolean;
  running: boolean;
  network: string;
  birthday_height: number | null;
  open_error: string | null;
}

export interface Landing {
  transparent: string;
  unified: string;
  index: number;
}

export interface BalanceInfo {
  ironwood_spendable: number;
  ironwood_total: number;
  unshielded: number;
  other_pools: number;
}

export interface Payout {
  txid: string;
  fee: number;
}

export interface WalletReport {
  landings: string[];
  shield_txids: string[];
  payout_txids: string[];
  balance: BalanceInfo;
  synced_height: number | null;
  last_error: string | null;
  cycles: number;
  syncing: boolean;
}

export const wallet = {
  status: () => invoke<WalletStatus>("wallet_status"),
  open: () => invoke<WalletStatus>("wallet_open"),
  create: () => invoke<{ phrase: string }>("wallet_create"),
  restore: (phrase: string, birthdayHeight: number | null) =>
    invoke<WalletStatus>("wallet_restore", { phrase, birthdayHeight }),
  revealPhrase: () => invoke<string>("wallet_reveal_phrase"),
  confirmBackup: () => invoke<WalletStatus>("wallet_confirm_backup"),
  nextLanding: () => invoke<Landing>("wallet_next_landing"),
  report: () => invoke<WalletReport>("wallet_report"),
  syncNow: () => invoke<WalletReport>("wallet_sync_now"),
  pay: (to: string, amountZats: bigint) => invoke<Payout>("wallet_pay", { to, amountZats: Number(amountZats) }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
