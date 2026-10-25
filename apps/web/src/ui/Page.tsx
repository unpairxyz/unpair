import { useEffect, useRef, useState, type ReactNode } from "react";

/** Panel dialog driven by `open`. */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={dlg} onClose={onClose} aria-label={title}>
      <h3>{title}</h3>
      {children}
      <button className="go" type="button" onClick={onClose}>GOT IT</button>
    </dialog>
  );
}

type Info = "how" | "verify" | "faq" | null;

export function Masthead() {
  const [open, setOpen] = useState<Info>(null);
  const close = () => setOpen(null);
  return (
    <>
      <div className="mast">
        <a className="logo" href="./" aria-label="Unpair"><b>UNPAIR</b><span className="vol">VOL.1 · OPEN SOURCE · YOU PICK WHO HOLDS THE KEY</span></a>
        <div className="tags">
          <button className="tag" type="button" onClick={() => setOpen("how")}>How it works</button>
          <button className="tag" type="button" onClick={() => setOpen("verify")}>Verify</button>
          <button className="tag" type="button" onClick={() => setOpen("faq")}>FAQ</button>
        </div>
      </div>
      <Dialog open={open === "how"} title="HOW IT WORKS" onClose={close}>
        <p>1. You send any token from any chain. That deposit is public.<br />2. It swaps into Zcash and goes into the shielded pool.<br />3. In the pool every coin looks the same.<br />4. A fresh source swaps out to the token you chose, at the address you chose.</p>
        <p>Fills come from NEAR Intents. It sees each leg while it runs. Between the two swaps, your browser or our server holds the coins. You choose.</p>
      </Dialog>
      <Dialog open={open === "verify"} title="VERIFY THIS SITE" onClose={close}>
        <p>Every quote is signed. The mark is drawn from the signature. Open the same quote on a second device: mark and code must match. A clone with its own server draws its own mark, so also check the signature against the key in our GitHub README. The address bar must say unpair.xyz.</p>
      </Dialog>
      <Dialog open={open === "faq"} title="FAQ" onClose={close}>
        <p><b>What do I get?</b> The token you pick, on the chain you pick, at your address. It comes from a fresh source, not from your deposit.</p>
        <p><b>Wrong amount?</b> Less: send the rest before the deadline, or it is refunded. More: the extra is refunded.</p>
        <p><b>What do you see?</b> Browser mode: nothing that links you. Server mode: our server sees both ends while it holds your coins. No analytics in either mode.</p>
      </Dialog>
    </>
  );
}

export function Footer() {
  return (
    <footer>
      <span className="tbc">TO BE CONTINUED...</span>
      <span>unpair.xyz · <a href="https://github.com/unpairxyz/unpair">GitHub</a> · MIT · not yet audited</span>
    </footer>
  );
}

/** The widget panel on the right of the hero. */
export function WidgetPanel({ children }: { children: ReactNode }) {
  return (
    <section className="p widget" aria-label="Swap">
      <div className="in">{children}</div>
    </section>
  );
}
