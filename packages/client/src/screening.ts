/**
 * Screening that does not tell the server the address.
 *
 * The server hands every caller the same list: the hash of each denylisted
 * address. The page hashes the address it checks and looks it up here. The
 * server learns that a page fetched the list, nothing about the address. A
 * server that screens with a vendor cannot hand out the list; then the page
 * asks the server per address, and says so.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ApiClient, ScreenList } from "./api.js";

/** How the server makes a list entry from an address. A list made another way is not used. */
export const LIST_HASH = "sha256(lowercase(trim(address)))";

/** One list entry: SHA-256 of the trimmed, lower-case address, as hex. */
export function addressHash(address: string): string {
  return bytesToHex(sha256(utf8ToBytes(address.trim().toLowerCase())));
}

export type PrivateVerdict =
  /** `sent` is true when the server had to see the addresses: it screens with a vendor. */
  | { allowed: true; sent: boolean }
  | { allowed: false; reason: string };

const REFUSED = "This address cannot be used with Unpair.";

/** Screen addresses against the server's list without sending them, or per address when the server has no list. */
export async function screenPrivately(api: ApiClient, addresses: readonly (readonly [address: string, chain: string])[]): Promise<PrivateVerdict> {
  const list = await api.screenList();
  if (!list.allowed) return { allowed: false, reason: list.reason ?? "Unpair is not available in your region." };
  if (list.entries === null) {
    for (const [address, chain] of addresses) {
      const v = await api.screen(address, chain);
      if (!v.allowed) return { allowed: false, reason: v.reason ?? REFUSED };
    }
    return { allowed: true, sent: true };
  }
  if (list.hash !== LIST_HASH) return { allowed: false, reason: "The screening list is in a form this page does not know. Reload the page." };
  return listed(list, addresses.map(([a]) => a)) ? { allowed: false, reason: REFUSED } : { allowed: true, sent: false };
}

function listed(list: ScreenList, addresses: readonly string[]): boolean {
  const set = new Set(list.entries ?? []);
  return addresses.some((a) => set.has(addressHash(a)));
}
