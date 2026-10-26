/**
 * The wallet worker. Holds one in-browser Zcash wallet and runs every call on
 * it off the page's thread, so proving a transaction does not freeze the UI.
 *
 * The seed lives here, in this worker's memory, until the page asks for the
 * recovery phrase once to write the recovery file. It is never posted
 * anywhere else.
 */
import type { WalletEnvelope, WalletReply, WalletRequest, WasmModule, WasmWallet } from "./types";

const ctx = self as unknown as { postMessage(m: WalletReply): void; onmessage: ((e: MessageEvent<WalletEnvelope>) => void) | null; close(): void };

let wallet: WasmWallet | null = null;
let loading: Promise<WasmModule> | null = null;

/** The module is served from public/wasm/, next to the page, never bundled. */
function loadModule(): Promise<WasmModule> {
  if (!loading) {
    const base = new URL(import.meta.env.BASE_URL, self.location.origin);
    const js = new URL("wasm/unpair_zcash.js", base);
    const wasm = new URL("wasm/unpair_zcash_bg.wasm", base);
    loading = import(/* @vite-ignore */ js.href)
      .then(async (m: WasmModule) => {
        await m.default({ module_or_path: wasm });
        return m;
      })
      .catch((e: unknown) => {
        loading = null;
        const msg = e instanceof Error ? e.message : String(e);
        // a module that failed to download is a connection problem, not a page built without the wallet
        if (/network|abort|fetch|load/i.test(msg)) throw new Error("The wallet module did not finish loading. Check the connection and try again.");
        throw new Error(`the browser wallet is not built on this page (${msg})`);
      });
  }
  return loading;
}

function need(): WasmWallet {
  if (!wallet) throw new Error("no wallet is open");
  return wallet;
}

async function handle(r: WalletRequest): Promise<unknown> {
  switch (r.op) {
    case "open": {
      const m = await loadModule();
      if (wallet) wallet.free();
      wallet = await m.WebWallet.open(r.network, r.url, r.phrase, r.birthday);
      return r.network;
    }
    case "landing":
      return need().nextLanding();
    case "sync":
      return need().sync();
    case "balance":
      return need().balance();
    case "shield":
      return need().shield();
    case "pay":
      return need().pay(r.to, BigInt(r.zatoshis));
    case "phrase":
      return need().recoveryPhrase();
    case "birthday":
      return need().birthdayHeight();
    case "upgrade":
      return need().upgradeNotice(r.tip, BigInt(r.nowUnix)) ?? null;
    case "close":
      if (wallet) wallet.free();
      wallet = null;
      ctx.close();
      return null;
  }
}

/** Calls run one at a time: the wallet is not reentrant, and the DB is one connection. */
let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (e) => {
  const { id, request } = e.data;
  queue = queue.then(async () => {
    try {
      const value = await handle(request);
      ctx.postMessage({ id, ok: true, value });
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
