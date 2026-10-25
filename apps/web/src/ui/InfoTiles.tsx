import { useEffect, useRef } from "react";
import { drawMark } from "./school";
import { Fish } from "./Sprites";

/** Quote mark: drawn from the quote signature, so a second device shows the same picture. */
export function QuoteMark({ seed, size = 62, className }: { seed: string; size?: number; className?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (cv.current) drawMark(cv.current, seed);
  }, [seed, size]);
  return <canvas ref={cv} className={className} role="img" aria-label="Quote mark" style={{ width: size, height: size }} />;
}

/** Three compact tiles under the story: custody, Fast VS Quiet, the mark and the fee. */
export function InfoTiles({ feePercent = "0.5%", capPercent = "1%" }: { feePercent?: string; capPercent?: string }) {
  return (
    <div className="info3">
      <section className="p"><div className="in">
        <h3>WHO HOLDS THE COINS?</h3>
        <div className="two">
          <div className="half">
            <svg viewBox="0 0 120 50" className="mini-art" aria-hidden="true">
              <g transform="translate(4 4)"><use href="#fishBody" style={{ ["--fill" as string]: "#FF2E4D" }} width="64" height="40" /><use href="#eyeHappy" width="64" height="40" /></g>
              <g transform="translate(78 8) rotate(20)"><circle cx="9" cy="9" r="8" fill="#fff" stroke="#000" strokeWidth="3" /><circle cx="9" cy="9" r="2.5" fill="#000" /><path d="M16 13 L32 22 M25 17 l-3 5 M30 20 l-3 5" stroke="#000" strokeWidth="3" strokeLinecap="round" /></g>
            </svg>
            <b className="ht">MY WALLET</b>
            <p>The ZEC lands in your own Zcash wallet. We never hold it. Soon: a wallet in this page.</p>
          </div>
          <div className="half tone">
            <svg viewBox="0 0 120 50" className="mini-art" aria-hidden="true">
              <g transform="translate(70 2)"><rect x="0" y="2" width="40" height="44" fill="#fff" stroke="#000" strokeWidth="3" /><path d="M7 14 h26 M7 24 h26 M7 34 h26" stroke="#000" strokeWidth="3" /></g>
              <g transform="translate(2 8)"><use href="#fishBody" style={{ ["--fill" as string]: "#fff" }} width="60" height="38" /><use href="#eyeSleep" width="60" height="38" /></g>
            </svg>
            <b className="ht">UNPAIR SERVER</b>
            <p><span className="hl">We hold the coins between swaps and see both ends. You can close the tab.</span></p>
          </div>
        </div>
      </div></section>

      <section className="p vsp"><div className="in">
        <div className="vsdots" aria-hidden="true" />
        <svg className="vsline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="56" y1="0" x2="44" y2="100" stroke="#000" strokeWidth="5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="vsl">
          <h3>FAST</h3>
          <Fish face="wow" className="vsfish" width={70} />
          <p>In and out in minutes. Exact amount.</p>
        </div>
        <div className="vsr">
          <h3><span className="hl">QUIET</span></h3>
          <Fish face="sleep" red={false} className="vsfish" width={70} />
          <p><span className="hl">Common sizes, random exit time. Harder to match.</span></p>
        </div>
        <div className="vs" aria-hidden="true"><b>VS</b></div>
      </div></section>

      <section className="p"><div className="in markfee">
        <div className="mk">
          <QuoteMark seed="7Q4K2M9X" size={92} />
          <span className="sparkle s1" aria-hidden="true">✦</span><span className="sparkle s2" aria-hidden="true">✦</span>
        </div>
        <div>
          <h3>CHECK THE MARK</h3>
          <p>Each quote has a mark drawn from our signature. Scan it with your phone on unpair.xyz. Same mark, real quote.</p>
          <div className="feechip"><b>{feePercent}</b> fee · capped at {capPercent} in open code</div>
        </div>
      </div></section>
    </div>
  );
}
