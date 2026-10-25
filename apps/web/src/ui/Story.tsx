import { useRef, type CSSProperties } from "react";
import type { School } from "./school";
import { Fish } from "./Sprites";
import { useSchool } from "./useSchool";

type Scene = "alone" | "join" | "blend" | "exit";

/** One small panel: the same choreography as the hero, looped every 7 s. */
function Scene({ scene, n = 150, cx = 0.55, cy = 0.58, ink = "#000", you = true }: { scene: Scene; n?: number; cx?: number; cy?: number; ink?: string; you?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const t0 = useRef(0);
  const reset = (f: School) => {
    f.you.fade = 0;
    f.you.fadeRate = 0;
    f.exit = null;
    if (scene === "alone") { f.you.mode = "alone"; f.place(0.1, 0.7); }
    if (scene === "join") { f.you.mode = "join"; f.place(0.05, 0.75); }
    if (scene === "blend") {
      f.you.mode = "free";
      const [mx, my] = f.centre();
      f.x[0] = mx;
      f.y[0] = my;
      f.you.fadeRate = 0.006;
    }
  };
  useSchool(
    cv,
    { n, seed: "p" + scene, cx, cy, spread: 0.5, len: 7, perc: 26, sep: 8, lw: 1.6, ink },
    (f) => {
      f.you.on = scene !== "exit" && you;
      for (let i = 0; i < 120; i++) f.step();
      reset(f);
    },
    (f, now) => {
      if (!t0.current) t0.current = now;
      if (now - t0.current > 7000) { t0.current = now; reset(f); }
      if (scene === "exit" && (!f.exit || f.exit.done) && now - t0.current > 1200) { f.startExit(); t0.current = now; }
    },
  );
  return <canvas ref={cv} aria-hidden="true" />;
}

const fx = (style: CSSProperties) => style;

export function Story() {
  return (
    <div className="story" aria-label="How it unlinks">
      <section className="p"><div className="in t1">
        <div className="spot" aria-hidden="true" />
        <Scene scene="alone" ink="#fff" cx={0.74} you={false} />
        <Fish face="worry" className="hero-fish" width={96} style={{ left: "12%", bottom: "24%" }} />
        <div className="narr">1. You send from any chain. That part is public.</div>
        <div className="say l">Everyone can see me...</div>
        <span className="fx" aria-hidden="true" style={fx({ left: "10%", top: "44%", color: "#fff", WebkitTextStroke: "1.5px #000", fontSize: 26 })}>GULP</span>
      </div></section>
      <section className="p"><div className="in t2">
        <div className="speed" aria-hidden="true" />
        <Scene scene="join" cx={0.66} cy={0.72} />
        <Fish face="wow" className="hero-fish" width={92} style={{ left: "14%", top: "50%", transform: "rotate(32deg)" }} />
        <svg className="drops" viewBox="0 0 80 40" aria-hidden="true" style={{ left: "46%", top: "66%" }}>
          <path d="M10 30 q4 -14 8 0 a4 4 0 0 1 -8 0z M34 22 q5 -18 10 0 a5 5 0 0 1 -10 0z M60 32 q3 -10 6 0 a3 3 0 0 1 -6 0z" fill="#fff" stroke="#000" strokeWidth="2.5" />
        </svg>
        <div className="narr">2. It swaps into Zcash and dives into the shielded pool.</div>
        <span className="fx big" aria-hidden="true" style={{ right: "6%", top: "46%" }}>SPLASH!</span>
      </div></section>
      <section className="p"><div className="in t3">
        <Scene scene="blend" n={260} cx={0.45} />
        <svg className="eye" viewBox="0 0 160 90" aria-hidden="true">
          <path d="M6 46 Q80 -16 154 46 Q80 104 6 46 Z" fill="#fff" stroke="#000" strokeWidth="5" />
          <circle cx="84" cy="46" r="24" fill="#000" /><circle cx="84" cy="46" r="11" fill="#fff" /><circle cx="76" cy="38" r="5" fill="#fff" />
          <path d="M18 30 l-10 -12 M40 16 l-6 -14 M66 8 l-2 -14" stroke="#000" strokeWidth="3" />
          <path d="M148 10 q8 14 0 18 q-8 -4 0 -18z" fill="#fff" stroke="#000" strokeWidth="2.5" />
        </svg>
        <div className="narr">3. Inside the pool, every coin looks the same.</div>
        <div className="say r">WHICH ONE WAS IT?!</div>
      </div></section>
      <section className="p"><div className="in t4">
        <div className="impact" aria-hidden="true" />
        <Scene scene="exit" cx={0.35} />
        <div className="narr">4. A fresh fish swims out to your address.</div>
        <span className="fx big red" aria-hidden="true" style={{ left: "8%", bottom: "10%" }}>UNPAIRED.</span>
      </div></section>
    </div>
  );
}
