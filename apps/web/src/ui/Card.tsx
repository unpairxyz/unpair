import { useState, type ReactNode } from "react";
import { Fish } from "./Sprites";

export type Tab = "in" | "out";

/** Card head: Swap / Send out tabs, and a small settings button for speed and slippage. */
export function CardHead<M extends string>({ tab, onTab, mode, modes, onMode, slippage, slippages, onSlippage }: {
  tab: Tab;
  onTab: (t: Tab) => void;
  mode: M;
  modes: { value: M; title: string; hint: string }[];
  onMode: (m: M) => void;
  slippage: number;
  slippages: readonly number[];
  onSlippage: (bps: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = modes.find((m) => m.value === mode);
  return (
    <>
      <div className="shead">
        <div className="tabs" role="tablist" aria-label="Direction">
          <button type="button" role="tab" aria-selected={tab === "in"} onClick={() => onTab("in")}>Swap</button>
          <button type="button" role="tab" aria-selected={tab === "out"} onClick={() => onTab("out")}>Send out</button>
        </div>
        <button type="button" className="gear" aria-expanded={open} aria-controls="card-settings" aria-label="Settings" onClick={() => setOpen(!open)}>
          <span>{current?.title.toUpperCase()} · {slippage / 100}%</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="16" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <circle cx="8" cy="17" r="2.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
          </svg>
        </button>
      </div>
      <div className="sets" id="card-settings" hidden={!open}>
        <div className="setrow"><span>Speed</span><Segment label="Speed" value={mode} options={modes} onChange={onMode} /></div>
        {current && <p className="sethint">{current.hint}</p>}
        <div className="setrow">
          <span>Slippage</span>
          <Segment label="Slippage" value={String(slippage)} options={slippages.map((b) => ({ value: String(b), title: `${b / 100}%` }))} onChange={(v) => onSlippage(Number(v))} />
        </div>
      </div>
    </>
  );
}

/** A row of plain radio buttons in one black frame. */
export function Segment<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; title: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" key={o.value} aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.title}</button>
      ))}
    </span>
  );
}

/** Who holds the coins, as one labelled row, with a one-line note under it. */
export function Keeper<T extends string>({ label, value, options, onChange, note, warn = false }: { label: string; value: T; options: { value: T; title: string }[]; onChange: (v: T) => void; note: ReactNode; warn?: boolean }) {
  return (
    <>
      <div className="keep"><span className="klbl">{label}</span><Segment label={label} value={value} options={options} onChange={onChange} /></div>
      <p className={warn ? "knote warn" : "knote"}>{note}</p>
    </>
  );
}

/** Send and get in one frame. The fish between them flips the pair, or only marks the pool when the pair cannot flip. */
export function Legs({ send, get, onFlip }: { send: ReactNode; get: ReactNode; onFlip?: () => void }) {
  return (
    <div className="legs">
      {send}
      <div className="mid">
        <button type="button" className="flip" disabled={!onFlip} onClick={onFlip} aria-label={onFlip ? "Swap send and receive tokens" : "Through the Zcash pool"} title="Through the Zcash pool">
          <Fish width={30} />
        </button>
      </div>
      {get}
    </div>
  );
}

/** One side of the swap: a label, the USD value, the amount, the token, and an optional note. */
export function Leg({ label, htmlFor, usd, amount, token, note, second = false }: { label: string; htmlFor?: string; usd?: string; amount: ReactNode; token: ReactNode; note?: ReactNode; second?: boolean }) {
  return (
    <div className={second ? "leg leg2" : "leg"}>
      <div className="lh">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}<span>{usd}</span></div>
      <div className="lr">{amount}{token}</div>
      {note ? <div className="lm">{note}</div> : null}
    </div>
  );
}

/** Receiving and refund addresses as rows of one frame, each with a Paste button. */
export function AddressRows({ children }: { children: ReactNode }) {
  return <div className="addrs">{children}</div>;
}

export function AddressRow({ id, label, value, onChange, placeholder, invalid = false }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder: string; invalid?: boolean }) {
  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) onChange(text);
    } catch {
      document.getElementById(id)?.focus();
    }
  }
  return (
    <div className="arow">
      <label className="al" htmlFor={id}>{label}</label>
      <input id={id} autoComplete="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} />
      <button type="button" className="pst" onClick={() => void paste()}>Paste</button>
    </div>
  );
}

/** One red line for what is wrong. Nothing when all is well: the button says what comes next. */
export function Hint({ children }: { children?: ReactNode }) {
  return <p className="ahint" aria-live="polite">{children}</p>;
}

/** Rate on one line, fee and time on the right; it opens to the details. */
export function Summary({ rate, meta, rows }: { rate: string; meta: string; rows: [string, ReactNode][] }) {
  return (
    <details className="sum">
      <summary><b>{rate}</b><i>{meta}</i></summary>
      <dl>
        {rows.map(([dt, dd]) => (
          <div key={dt} style={{ display: "contents" }}><dt>{dt}</dt><dd>{dd}</dd></div>
        ))}
      </dl>
    </details>
  );
}
