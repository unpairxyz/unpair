import { readPalette } from "./school";

export type ThemeName = "light" | "dark";
/** Fired on window when the colours change, so canvases can draw again. */
export const THEME_EVENT = "unpair-theme";
const KEY = "unpair-theme";
const dark = matchMedia("(prefers-color-scheme: dark)");

function stored(): ThemeName | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme in use: the user's choice, else the system's. */
export function currentTheme(): ThemeName {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : dark.matches ? "dark" : "light";
}

export function setTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private mode: the choice lasts for this page only
  }
  changed();
}

function changed(): void {
  readPalette();
  dispatchEvent(new Event(THEME_EVENT));
}

// apply a saved choice before React draws anything
const saved = stored();
if (saved) document.documentElement.dataset.theme = saved;
dark.addEventListener("change", changed);
