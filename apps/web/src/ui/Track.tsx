import { useEffect, useState, type ReactNode } from "react";
import { chainKind } from "@unpair/client";
import { chainLabel } from "./tokens";

/** One fact: a label, a value, and whether the value is a number or id set in mono. Falsy rows are skipped. */
export type Fact = [label: string, value: ReactNode, mono?: boolean] | false | "" | null | undefined;

/** The facts of a swap in progress or done, as label and value rows in one frame. */
export function Facts({ rows }: { rows: Fact[] }) {
  const shown = rows.filter((r): r is [string, ReactNode, boolean?] => Boolean(r));
  if (!shown.length) return null;
  return (
    <dl className="facts">
      {shown.map(([label, value, mono]) => (
        <div key={label}><dt>{label}</dt><dd className={mono ? "m" : undefined}>{value}</dd></div>
      ))}
    </dl>
  );
}

/** An address or id cut to its ends, for a facts row. */
export function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** The explorer page of a Zcash transaction. Opening it tells the explorer the txid and the viewer's IP. */
export function zcashTxUrl(txid: string, network: "main" | "test"): string {
  return `https://${network === "test" ? "testnet" : "mainnet"}.zcashexplorer.app/transactions/${txid}`;
}

/**
 * An address or id in a facts row. Shown cut to its ends; a click copies the
 * full value. With `url`, a second link opens the explorer page in a new tab.
 */
export function Id({ value, url }: { value: string; url?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <span className="idv">
      <button type="button" className="idcopy" title={`Copy ${value}`} onClick={() => void copy()} aria-live="polite">{copied ? "copied" : short(value)}</button>
      {url?.startsWith("https://") && <a href={url} target="_blank" rel="noopener noreferrer">view</a>}
    </span>
  );
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under 1 min";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Time since the swap started: "12 min so far" while it runs, "took 36 min" once `end` is set. Ticks every 20 s. */
export function useElapsed(start: number | null, end: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null || end !== null) return;
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, [start, end]);
  if (start === null) return null;
  return end !== null ? `took ${minutes(end - start)}` : `${minutes(now - start)} so far`;
}

/** Holds the moment `done` first turns true, so a finished swap shows a fixed time. */
export function useEndTime(done: boolean, known: number | null = null): number | null {
  const [end, setEnd] = useState<number | null>(null);
  useEffect(() => {
    if (done && end === null) setEnd(known ?? Date.now());
  }, [done, end, known]);
  return done ? (end ?? known ?? Date.now()) : null;
}

/** What the deposit step waits for on this chain, with the time measured today. */
export function depositWait(chain: string): string {
  const name = chainLabel(chain);
  if (chain === "zec") return "Needs Zcash confirmations. Credited in about 10 min.";
  if (chainKind(chain) === "evm") return `Needs ${name} confirmations. Credited in a few min.`;
  return `Needs ${name} confirmations, then the route credits it.`;
}

/** A received note can be spent after ten confirmations. */
export const POOL_WAIT = "Spendable after 10 confirmations, about 12 min.";
/** The route credits a Zcash payment about ten minutes after it confirms. */
export const OUT_WAIT = "Credited about 10 min after the Zcash payment confirms, then paid out.";

/** The estimate under "Send exactly": what arrives after both hops, from a dry quote of hop two. */
export function YouGet({ value }: { value: string }) {
  return (
    <div className="box">
      <span className="lbl">You get about</span>
      <div className="big">{value}</div>
      <p className="fine left">Small swaps lose more to fixed network fees.</p>
    </div>
  );
}
