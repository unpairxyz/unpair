import type { CSSProperties } from "react";

/** SVG symbols for the mascot. Render once near the root. */
export function Sprites() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <symbol id="fishBody" viewBox="0 0 70 44">
        <path d="M52 22 L67 9 L64 22 L67 35 Z" fill="var(--fill,var(--paper))" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
        <path d="M4 22 C 12 6, 42 4, 54 22 C 42 40, 12 38, 4 22 Z" fill="var(--fill,var(--paper))" stroke="var(--ink)" strokeWidth="3" />
        <path d="M34 12 q4 10 0 20" fill="none" stroke="var(--ink)" strokeWidth="2" />
      </symbol>
      <symbol id="eyeOpen" viewBox="0 0 70 44">
        <circle cx="19" cy="19" r="7" fill="var(--ink)" /><circle cx="16.5" cy="16.5" r="2.6" fill="var(--paper)" /><circle cx="21.5" cy="22" r="1.2" fill="var(--paper)" />
        <path d="M26 28 l3 -3 M30 29 l3 -3" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
      </symbol>
      <symbol id="eyeWorry" viewBox="0 0 70 44">
        <circle cx="19" cy="20" r="7" fill="var(--ink)" /><circle cx="16.5" cy="17.5" r="2.6" fill="var(--paper)" /><circle cx="21.5" cy="23" r="1.2" fill="var(--paper)" />
        <path d="M12 9 L25 12" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M10 31 q3 -3 6 0 q3 3 6 0" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
        <path d="M30 0 q6 8 0 11 q-6 -3 0 -11z" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2" />
      </symbol>
      <symbol id="eyeWow" viewBox="0 0 70 44">
        <circle cx="19" cy="19" r="8" fill="var(--ink)" /><path d="M19 13 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6z" fill="var(--paper)" />
        <path d="M9 29 q5 6 11 0" fill="var(--ink)" stroke="var(--ink)" strokeWidth="1.5" />
      </symbol>
      <symbol id="eyeHappy" viewBox="0 0 70 44">
        <path d="M12 21 Q19 12 26 21" fill="none" stroke="var(--ink)" strokeWidth="3.2" strokeLinecap="round" />
        <path d="M26 28 l3 -3 M30 29 l3 -3" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M9 28 q5 5 10 0" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
      </symbol>
      <symbol id="eyeSleep" viewBox="0 0 70 44">
        <path d="M12 20 Q19 25 26 20" fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
        <circle cx="13" cy="30" r="2.2" fill="none" stroke="var(--ink)" strokeWidth="1.6" />
      </symbol>
    </svg>
  );
}

export type Face = "open" | "worry" | "wow" | "happy" | "sleep";

/** The mascot. Red is the user's fish; white is any other fish. */
export function Fish({ face = "open", red = true, className, style, width = 56 }: { face?: Face; red?: boolean; className?: string; style?: CSSProperties; width?: number }) {
  const eye = `#eye${face[0]!.toUpperCase()}${face.slice(1)}`;
  return (
    <svg viewBox="0 0 70 44" width={width} height={(width * 44) / 70} aria-hidden="true" className={className} style={{ ["--fill" as string]: red ? "#FF2E4D" : "var(--paper)", overflow: "visible", ...style }}>
      <use href="#fishBody" />
      <use href={eye} />
    </svg>
  );
}
