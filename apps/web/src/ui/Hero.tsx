import { useEffect, useRef, type PointerEvent } from "react";
import { reducedMotion } from "./school";
import { useSchool } from "./useSchool";

/** Where the swap is. The red fish in the hero follows it. */
export type HeroStage = "form" | "deposit" | "seen" | "into" | "pool" | "out" | "done";

const NARRATION: Record<HeroStage, [string, string]> = {
  form: ["Every chain is public. A normal swap draws a line from you to the other side.", "The red fish is you. Watch it during your swap."],
  deposit: ["Your deposit is public. The red fish waits at the edge of the pool.", "Send the exact amount to start."],
  seen: ["Deposit seen. The red fish gets ready.", "Still easy to spot."],
  into: ["Into the pool. The red fish swims for the school.", "Watch it go in."],
  pool: ["In the pool, every coin looks the same.", "Keep your eye on it. Can you?"],
  out: ["A different fish leaves for your address.", "Nothing links it to the red one."],
  done: ["The red fish is still in the school. You cannot find it.", "What left is a different fish."],
};

export function Hero({ stage, quiet = false, onOut }: { stage: HeroStage; quiet?: boolean; onOut?: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  const lastMove = useRef(0);
  const onOutRef = useRef(onOut);
  onOutRef.current = onOut;

  const school = useSchool(
    cv,
    { n: matchMedia("(max-width:980px)").matches ? 500 : 900, seed: 21, cx: 0.5, cy: 0.5, spread: 0.8 },
    (s) => {
      s.you.on = true;
      s.you.mode = "alone";
      s.flee = { x: 0, y: 0, r: 120, on: false };
      const rock = () => {
        const a = h1.current?.getBoundingClientRect();
        const b = s.cv.getBoundingClientRect();
        if (a) s.rock = { x: a.left - b.left - 16, y: a.top - b.top - 16, w: a.width + 32, h: a.height + 32 };
      };
      rock();
      addEventListener("resize", rock);
      for (let i = 0; i < 200; i++) s.step();
      s.place(0.08, 0.7);
      s.onExit = () => onOutRef.current?.();
    },
    (s, now) => {
      if (s.flee?.on && now - lastMove.current > 400) s.flee.on = false;
    },
  );

  // each stage moves the red fish
  useEffect(() => {
    const s = school.current;
    if (!s) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    s.mill = false;
    switch (stage) {
      case "form":
      case "deposit":
        if (s.you.mode !== "alone") s.place(0.08, 0.7);
        Object.assign(s.you, { mode: "alone", fade: 0, fadeRate: 0 });
        s.exit = null;
        s.speed = stage === "deposit" ? 0.6 : 1;
        break;
      case "seen":
        s.speed = 1;
        break;
      case "into":
        s.speed = 1;
        s.you.mode = "join";
        s.say("SPLASH!", 0.05, 0.93);
        break;
      case "pool":
        s.you.mode = "free";
        s.you.fadeRate = 0.006;
        s.mill = quiet;
        break;
      case "out":
        s.you.mode = "free";
        s.you.fadeRate = 0.006;
        s.startExit();
        // with reduced motion or a hidden tab the fish cannot swim out, so finish anyway
        timer = setTimeout(() => {
          if (s.exit && !s.exit.done) {
            s.exit.done = true;
            onOutRef.current?.();
          }
        }, reducedMotion() ? 600 : 6000);
        break;
      case "done":
        s.you.fade = 1;
        s.say("UNPAIRED!!", 0.52, 0.2, { life: 140, size: 60, red: true, rot: -0.1 });
        break;
    }
    if (reducedMotion()) s.draw();
    return () => clearTimeout(timer);
  }, [stage, quiet, school]);

  // the cursor only makes nearby fish swim away; it draws nothing
  const move = (e: PointerEvent) => {
    const s = school.current;
    if (!s?.flee || reducedMotion()) return;
    const b = s.cv.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    if (Math.hypot(px - s.flee.x, py - s.flee.y) > 2) {
      s.flee.on = true;
      lastMove.current = performance.now();
    }
    s.flee.x = px;
    s.flee.y = py;
  };

  const [a, b] = NARRATION[stage];
  return (
    <section className="p hero" aria-labelledby="hero-h1">
      <div className="in" onPointerMove={move} onPointerLeave={() => school.current?.flee && (school.current.flee.on = false)}>
        <canvas ref={cv} aria-hidden="true" />
        <div className="title">
          <div className="focus" aria-hidden="true" />
          <h1 id="hero-h1" ref={h1}>
            <span>Nobody can</span>
            <span>follow one fish!</span>
          </h1>
        </div>
        <div className="narr">{a}</div>
        <div className="narr br">{b}</div>
      </div>
    </section>
  );
}
