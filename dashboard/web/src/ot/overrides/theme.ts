// Replaces OpenTakeoff's lib/theme.js (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream themes its chrome with <html data-theme="dark|light"> and its own stored choice.
// The Brink app has one theme for the whole app: the `.dark` class on <html>, set by the
// header's toggle (web/src/design/theme.ts). This module reads that class, toggles it through
// the Brink store, and reports changes, so the canvas's own theme code follows the app.
// (OpenTakeoff's separate per-sheet "invert" work mode is not the chrome theme and is kept.)
import { setThemeMode } from "../../design/theme.js";

type Theme = "light" | "dark";

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setThemeMode(next);
  return next;
}

/** Subscribe to theme changes; returns the unsubscribe (usable as an effect body). */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  let last = getTheme();
  const mo = new MutationObserver(() => {
    const t = getTheme();
    if (t !== last) {
      last = t;
      fn(t);
    }
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}

/** Upstream wires OS and other-tab changes here; the Brink theme store already does. */
export function initTheme(): void {
  /* the app's theme store owns this */
}
