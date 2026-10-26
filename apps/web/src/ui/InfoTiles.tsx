import { useEffect, useRef } from "react";
import { drawMark } from "./school";
import { Fish } from "./Sprites";
import { THEME_EVENT } from "./themeMode";

/** Quote mark: drawn from the quote signature, so a second device shows the same picture. */
export function QuoteMark({ seed, size = 62, className }: { seed: string; size?: number; className?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => cv.current && drawMark(cv.current, seed);
    // a frame later too: a mark inside a dialog has no size until the dialog opens
    draw();
    const raf = requestAnimationFrame(draw);
    addEventListener(THEME_EVENT, draw);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener(THEME_EVENT, draw);
    };
  }, [seed, size]);
  return <canvas ref={cv} className={className} role="img" aria-label="Quote mark" style={{ width: size, height: size }} />;
}

/** Tiles under the story: who holds the coins (full width), then Fast VS Quiet, and the mark with the fee. */
export function InfoTiles({ feePercent = "0.5%", capPercent = "1%" }: { feePercent?: string; capPercent?: string }) {
  return (
    <div className="info3">
      <section className="p keepp"><div className="in">
        <h3>WHO HOLDS THE COINS?</h3>
        <div className="three">
          <div className="half">
            <svg viewBox="0 0 120 50" className="mini-art" aria-hidden="true">
              <rect x="4" y="6" width="62" height="42" fill="var(--paper)" stroke="var(--ink)" strokeWidth="3" />
              <path d="M4 16 h62" stroke="var(--ink)" strokeWidth="3" />
              <path d="M10 6 v-4 h22 l3 4" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx="58" cy="11" r="2" fill="var(--ink)" />
              <g transform="translate(18 23)"><use href="#fishBody" style={{ ["--fill" as string]: "#FF2E4D" }} width="34" height="21" /></g>
              <text x="74" y="36" fontFamily="Bangers, Impact, sans-serif" fontSize="24" fill="var(--ink)">x1</text>
            </svg>
            <b className="ht">ONE-TIME WALLET</b>
            <p>A fresh Zcash wallet, made in this tab for one swap. Keep the tab open, or save the recovery file. We never hold the key.</p>
          </div>
          <div className="half tone">
            <svg viewBox="0 0 120 50" className="mini-art" aria-hidden="true">
              <g transform="translate(70 2)"><rect x="0" y="2" width="40" height="44" fill="var(--paper)" stroke="var(--ink)" strokeWidth="3" /><path d="M7 14 h26 M7 24 h26 M7 34 h26" stroke="var(--ink)" strokeWidth="3" /></g>
              <g transform="translate(2 8)"><use href="#fishBody" style={{ ["--fill" as string]: "var(--paper)" }} width="60" height="38" /><use href="#eyeSleep" width="60" height="38" /></g>
            </svg>
            <b className="ht">UNPAIR SERVER</b>
            <p><span className="hl">We hold the coins between the swaps, mixed with other people's coins. Harder to trace on chain, but we see both ends. You can close the tab.</span></p>
          </div>
          <div className="half">
            <svg viewBox="0 0 120 50" className="mini-art" aria-hidden="true">
              <rect x="6" y="2" width="30" height="46" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="3" />
              <path d="M16 7 h10" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
              <g transform="translate(9 17)"><use href="#fishBody" style={{ ["--fill" as string]: "#FF2E4D" }} width="24" height="15" /></g>
              <g transform="translate(52 12) rotate(20)"><circle cx="9" cy="9" r="8" fill="var(--paper)" stroke="var(--ink)" strokeWidth="3" /><circle cx="9" cy="9" r="2.5" fill="var(--ink)" /><path d="M16 13 L32 22 M25 17 l-3 5 M30 20 l-3 5" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" /></g>
            </svg>
            <b className="ht">MY ZCASH WALLET</b>
            <p>Your own wallet app, like Zodl or Zingo. The ZEC lands there. Only you hold the key.</p>
          </div>
        </div>
      </div></section>

      <section className="p vsp"><div className="in">
        <div className="vsdots" aria-hidden="true" />
        <svg className="vsline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="56" y1="0" x2="44" y2="100" stroke="var(--ink)" strokeWidth="5" vectorEffect="non-scaling-stroke" />
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
