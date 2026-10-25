import { useEffect, useRef, type RefObject } from "react";
import { School, reducedMotion, type SchoolOptions } from "./school";
import { THEME_EVENT } from "./themeMode";

/**
 * Runs a School on a canvas. It animates only while the canvas is on screen and the tab is visible.
 * With reduced motion it draws one still frame.
 */
export function useSchool(
  canvas: RefObject<HTMLCanvasElement | null>,
  options: SchoolOptions,
  setup?: (s: School) => void,
  tick?: (s: School, now: number) => void,
): RefObject<School | null> {
  const school = useRef<School | null>(null);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const s = new School(cv, options);
    school.current = s;
    setup?.(s);
    const still = reducedMotion();
    let visible = true;
    let raf = 0;
    const io = new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true));
    io.observe(cv);
    const onResize = () => {
      s.resize();
      s.draw();
    };
    addEventListener("resize", onResize);
    // a still frame must be drawn again in the new colours
    addEventListener(THEME_EVENT, onResize);
    s.draw();
    const loop = (now: number) => {
      if (!still && visible && !document.hidden) {
        tickRef.current?.(s, now);
        s.step();
        s.draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      removeEventListener("resize", onResize);
      removeEventListener(THEME_EVENT, onResize);
      school.current = null;
    };
    // the school is built once per canvas; options are read at mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return school;
}
