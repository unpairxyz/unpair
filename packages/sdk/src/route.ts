/**
 * Unpair's swap states, and the map from 1Click's status words to them.
 * These are the states the UI shows. "landed" means the ZEC reached the
 * landing address; the wallet then moves it into the shielded pool.
 */

import type { SwapStatus } from "./oneclick/types.js";

export type UnpairState =
  | "quote"
  | "waiting_for_deposit"
  | "routing"
  | "landed"
  | "refunded"
  | "failed";

export function oneClickStatusToState(s: SwapStatus): UnpairState {
  switch (s) {
    case "PENDING_DEPOSIT":
      return "waiting_for_deposit";
    case "KNOWN_DEPOSIT_TX":
    case "INCOMPLETE_DEPOSIT":
    case "PROCESSING":
      return "routing";
    case "SUCCESS":
      return "landed";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
  }
}
