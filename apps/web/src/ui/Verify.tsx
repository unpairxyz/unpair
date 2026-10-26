import { QuoteMark } from "./InfoTiles";
import { Dialog } from "./Page";
import { Qr } from "./Qr";

/** One line above the deposit: the small mark, who signed the quote, the code, and a button to check on a phone. */
export function VerifyStrip({ seed, code, signedBy, onPhone }: { seed: string; code: string; signedBy: string; onPhone?: () => void }) {
  return (
    <div className="vstrip">
      <QuoteMark seed={seed} size={36} />
      <span className="vwho">{signedBy}</span>
      <span className="code">{code}</span>
      {onPhone && <button type="button" className="mini" onClick={onPhone}>Check on phone</button>}
    </div>
  );
}

/** The phone check: a large QR to open the same quote on a second device, and the mark and code it must show. */
export function PhoneCheck({ open, url, error, seed, code, onClose }: { open: boolean; url: string | null; error: string | null; seed: string; code: string; onClose: () => void }) {
  return (
    <Dialog open={open} title="CHECK ON YOUR PHONE" onClose={onClose}>
      {url ? <Qr value={url} label="QR code to open this quote on your phone" /> : <p className="fine">{error ?? "Getting a link for your phone."}</p>}
      {open && <div className="vmatch"><QuoteMark seed={seed} size={120} /><b className="code">{code}</b></div>}
      <p>Scan with your phone camera. The phone must show this mark and this code. If not, do not pay.</p>
    </Dialog>
  );
}

/** On the second device the check comes first: a large mark, the code, and whether the signature holds. */
export function VerifyHero({ seed, code, verified }: { seed: string; code: string; verified: boolean | null }) {
  return (
    <div className="vhero">
      <QuoteMark seed={seed} size={132} />
      <b className="vcode">{code}</b>
      <p className={verified ? "vok" : "vwarn"}>
        {verified ? "Signed by Unpair. The signature checks out." : "This page cannot check the signature. Do not pay unless the other screen says the same."}
      </p>
      <p className="fine">Compare with the other screen: same mark, same code.</p>
    </div>
  );
}
