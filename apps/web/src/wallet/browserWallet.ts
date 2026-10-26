/**
 * The page's handle on the in-browser Zcash wallet, which runs in a worker.
 *
 * One `BrowserWallet` is one swap. The page opens it, takes a landing address
 * for the route to pay, offers the user a recovery file, and later pays the
 * second hop from it. Nothing here is stored by the page: close the tab and
 * only the recovery file can bring the wallet back.
 */
import type { ZcashNetwork } from "../config";
import type { Balance, Landing, Payout, Upgrade, WalletEnvelope, WalletReply, WalletRequest } from "./types";

/** The recovery file. Enough to reopen the wallet anywhere and finish the swap. */
export interface Recovery {
  unpair: 1;
  network: ZcashNetwork;
  /** 24 words. */
  phrase: string;
  /** Scan from here. The wallet was made at this height. */
  birthday: number;
  /** When the file was written, ISO 8601. */
  created: string;
  /** The second hop as planned, so a later session can finish it. */
  plan?: RecoveryPlan;
}

export interface RecoveryPlan {
  destinationAsset: string;
  recipient: string;
  /** Fast or quiet. */
  mode: "fast" | "quiet";
  slippageBps: number;
}

export function recoveryFileName(created: Date): string {
  return `unpair-recovery-${created.toISOString().slice(0, 10)}.json`;
}

/** Read a recovery file. Refuses anything that is not one. */
export function parseRecovery(text: string, network: ZcashNetwork): Recovery {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This is not a recovery file.");
  }
  if (!raw || typeof raw !== "object") throw new Error("This is not a recovery file.");
  const r = raw as Partial<Recovery>;
  if (r.unpair !== 1) throw new Error("This is not an Unpair recovery file.");
  if (r.network !== "main" && r.network !== "test") throw new Error("The recovery file names no network.");
  if (r.network !== network) throw new Error(`This file is for ${r.network}net and this page runs on ${network}net.`);
  const words = typeof r.phrase === "string" ? r.phrase.trim().split(/\s+/) : [];
  if (words.length !== 24) throw new Error("The recovery file has no 24 word phrase.");
  if (typeof r.birthday !== "number" || !Number.isInteger(r.birthday) || r.birthday < 0) throw new Error("The recovery file has no birthday height.");
  const out: Recovery = { unpair: 1, network: r.network, phrase: words.join(" "), birthday: r.birthday, created: typeof r.created === "string" ? r.created : "" };
  if (r.plan && typeof r.plan === "object") {
    const p = r.plan as Partial<RecoveryPlan>;
    if (typeof p.destinationAsset === "string" && typeof p.recipient === "string" && (p.mode === "fast" || p.mode === "quiet") && typeof p.slippageBps === "number") {
      out.plan = { destinationAsset: p.destinationAsset, recipient: p.recipient, mode: p.mode, slippageBps: p.slippageBps };
    }
  }
  return out;
}

/** Downloading the 9 MB module; a slow link needs minutes. */
const LOAD_TIMEOUT_MS = 180_000;
/** Reading the chain tip and the tree state from the wallet server. */
const OPEN_TIMEOUT_MS = 60_000;
export type OpenStep = "download" | "connect";
/** A short call that only reads the wallet. */
const CALL_TIMEOUT_MS = 30_000;

export class BrowserWallet {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly network: ZcashNetwork;

  private constructor(network: ZcashNetwork) {
    this.network = network;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WalletReply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "the wallet worker failed"));
      this.pending.clear();
    };
  }

  /** A fresh wallet, scanning from the chain tip. */
  static async create(network: ZcashNetwork, grpcWebUrl: string, onStep?: (step: OpenStep) => void): Promise<BrowserWallet> {
    const w = new BrowserWallet(network);
    try {
      onStep?.("download");
      await w.call({ op: "load" }, LOAD_TIMEOUT_MS, "The wallet module did not finish downloading. Check the connection and try again.");
      onStep?.("connect");
      await w.call({ op: "open", network, url: grpcWebUrl }, OPEN_TIMEOUT_MS);
    } catch (e) {
      w.close();
      throw e;
    }
    return w;
  }

  /** The wallet from a recovery file, scanning from its birthday. */
  static async recover(r: Recovery, grpcWebUrl: string, onStep?: (step: OpenStep) => void): Promise<BrowserWallet> {
    const w = new BrowserWallet(r.network);
    try {
      onStep?.("download");
      await w.call({ op: "load" }, LOAD_TIMEOUT_MS, "The wallet module did not finish downloading. Check the connection and try again.");
      onStep?.("connect");
      await w.call({ op: "open", network: r.network, url: grpcWebUrl, phrase: r.phrase, birthday: r.birthday }, OPEN_TIMEOUT_MS);
    } catch (e) {
      w.close();
      throw e;
    }
    return w;
  }

  /**
   * One request to the worker. A timeout turns a call that never answers,
   * such as a wallet server that stops mid-stream, into an error the page
   * can show; proving and scanning run without one.
   */
  private call(request: WalletRequest, timeoutMs?: number, timeoutText = "The wallet server did not answer in time. Check the connection and try again."): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      let timer: number | null = null;
      if (timeoutMs) {
        timer = window.setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(timeoutText));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) window.clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) window.clearTimeout(timer);
          reject(e);
        },
      });
      const env: WalletEnvelope = { id, request };
      this.worker.postMessage(env);
    });
  }

  nextLanding(): Promise<Landing> {
    return this.call({ op: "landing" }, CALL_TIMEOUT_MS) as Promise<Landing>;
  }

  /** Scan to the tip. Returns the tip height. */
  sync(): Promise<number> {
    return this.call({ op: "sync" }) as Promise<number>;
  }

  balance(): Promise<Balance> {
    return this.call({ op: "balance" }) as Promise<Balance>;
  }

  /** Shield a refund that came back transparent. Returns the txids broadcast. */
  shield(): Promise<string[]> {
    return this.call({ op: "shield" }) as Promise<string[]>;
  }

  /** Hop two: pay the route's transparent address from Ironwood. Proves and broadcasts. */
  pay(to: string, zatoshis: bigint): Promise<Payout> {
    return this.call({ op: "pay", to, zatoshis: zatoshis.toString() }) as Promise<Payout>;
  }

  upgradeNotice(tip: number): Promise<Upgrade | null> {
    return this.call({ op: "upgrade", tip, nowUnix: Math.floor(Date.now() / 1000) }) as Promise<Upgrade | null>;
  }

  /** The recovery file for this wallet. Ask once, hand it to the user, do not keep it in state. */
  async recovery(plan?: RecoveryPlan): Promise<{ text: string; name: string }> {
    const phrase = (await this.call({ op: "phrase" })) as string;
    const birthday = (await this.call({ op: "birthday" })) as number;
    const created = new Date();
    const r: Recovery = { unpair: 1, network: this.network, phrase, birthday, created: created.toISOString(), ...(plan ? { plan } : {}) };
    return { text: JSON.stringify(r, null, 2) + "\n", name: recoveryFileName(created) };
  }

  /** Forget the key and stop the worker. */
  close(): void {
    void this.call({ op: "close" }).catch(() => {});
    window.setTimeout(() => this.worker.terminate(), 1000);
    this.pending.clear();
  }
}

/** Hand a text file to the user. */
export function offerDownload(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
