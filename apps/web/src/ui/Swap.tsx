import { useState, type ReactNode } from "react";
import { Qr } from "./Qr";
import { Fish, type Face } from "./Sprites";

/** Two-way choice drawn as a manga toggle (Fast/Quiet, My browser/Unpair server). */
export function Toggle<T extends string>({ label, value, options, onChange, small = false }: {
  label: string;
  value: T;
  options: { value: T; title: string; hint: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={small ? "modes sm" : "modes"} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" key={o.value} aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          <span>{o.title}</span>
          <small>{o.hint}</small>
        </button>
      ))}
    </div>
  );
}

/** The mascot and its bubble: the one place for hints and errors. */
export function Mascot({ tone = "", face = "open", red = true, children }: { tone?: "" | "ok" | "err"; face?: Face; red?: boolean; children: ReactNode }) {
  return (
    <div className="talk">
      <Fish face={face} red={red} />
      <div className={`bubble ${tone}`} aria-live="polite">{children}</div>
    </div>
  );
}

/** Big black call-to-action. When disabled its label says what is missing. */
export function GoButton({ children, disabled = false, onClick, type = "button", ghost = false }: { children: ReactNode; disabled?: boolean; onClick?: () => void; type?: "button" | "submit"; ghost?: boolean }) {
  return (
    <button className={ghost ? "go ghost" : "go"} type={type} disabled={disabled} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
}

/** "Through the Zcash pool" tag between send and receive, with the flip button. */
export function PoolDivider({ onFlip }: { onFlip?: () => void }) {
  return (
    <div className="flipwrap">
      {onFlip && <button type="button" className="flip" aria-label="Swap send and receive tokens" onClick={onFlip}>⇅</button>}
      <span className="pooltag"><Fish width={20} red={false} />THROUGH THE ZCASH POOL</span>
    </div>
  );
}

/** Deposit address with the first and last six characters bold and the middle in groups of four. With `qr`, a button shows it as a QR code. */
export function Address({ value, qr = false }: { value: string; qr?: boolean }) {
  const [show, setShow] = useState(false);
  const mid = value.slice(6, -6).replace(/(.{4})/g, "$1 ");
  const text = value.length < 16 ? <div className="addr"><b>{value}</b></div> : <div className="addr"><b>{value.slice(0, 6)}</b> {mid}<b>{value.slice(-6)}</b></div>;
  if (!qr) return text;
  return (
    <>
      {text}
      <button type="button" className="mini qrbtn" aria-expanded={show} onClick={() => setShow(!show)}>{show ? "Hide QR" : "Show QR"}</button>
      {show && <Qr value={value} />}
    </>
  );
}

export const STATUS_PANELS = [
  { title: "DEPOSIT SEEN", text: "Your deposit arrived. Confirming." },
  { title: "INTO THE POOL", text: "It swaps into Zcash and dives into the shielded pool." },
  { title: "IN THE POOL", text: "Every coin looks the same here." },
  { title: "OUT!", text: "A fresh source sends your token to your address." },
] as const;

/**
 * Four-panel status strip. `current` is 0 to 3; 4 means all done; -1 means waiting for the deposit.
 * Pass `texts` to replace the default line under each title.
 */
export function StatusStrip({ current, texts }: { current: number; texts?: Partial<Record<0 | 1 | 2 | 3, string>> }) {
  const live = current >= 0 && current < 4 ? STATUS_PANELS[current]!.title : current >= 4 ? "Done" : "Waiting for your deposit";
  return (
    <>
      <div className="koma">
        {STATUS_PANELS.map((p, i) => (
          <div key={p.title} className={`k ${i < current ? "done" : i === current ? "now" : "todo"}`}>
            <span className="n">{i + 1}/4</span>
            <b>{p.title}</b>
            <br />
            <p>{texts?.[i as 0 | 1 | 2 | 3] ?? p.text}</p>
          </div>
        ))}
      </div>
      <div role="status" className="sr">{live}.</div>
    </>
  );
}

export function DoneBurst() {
  return (
    <div className="boom" aria-hidden="true">
      <div className="burst" />
      <div className="burst w" />
      <b>UNPAIRED!!</b>
    </div>
  );
}
