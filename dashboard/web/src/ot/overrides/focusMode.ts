// Replaces OpenTakeoff's lib/focusMode.js (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream's focus mode (F) collapses its own chrome rows (the top bar, the condition
// palette, the sheet tabs, the compact strip) and keeps the canvas, its prompts and its
// panels. In the Brink app that chrome is replaced by the Brink toolbar, sheets panel,
// right panel and status bar (web/src/ot/brink/), so focus mode is always on and never
// stored: upstream's own code path removes its rows, no source edit needed. What focus
// mode keeps (the tool rail, the panel rail, the status strip) is hidden by the theme
// (design/ot-theme.css) and driven from the Brink chrome instead.
export { isCompactViewport } from "../../../../vendor/opentakeoff/src/lib/focusMode.js";

export function getFocusMode(): boolean {
  return true;
}

export function setFocusMode(_on: boolean): void {
  /* always on in the Brink app */
}

export function toggleFocusMode(): boolean {
  return true;
}

export function onFocusModeChange(_fn: (on: boolean) => void): () => void {
  return () => undefined;
}
