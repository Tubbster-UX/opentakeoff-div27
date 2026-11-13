// The app's one theme: light, dark or "system". It sets the `.dark` class on <html>,
// which switches the Brink tokens (tokens.css) and EasySchematic's own dark mode
// together. EasySchematic's useTheme hook is replaced by a module that reads this
// store (web/src/es/overrides/useTheme.ts), so there is no second toggle.
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const KEY = "brink:theme";
/** EasySchematic's own preference key, kept in step so a standalone read agrees (persisted under brink-es:, web/src/es/storage.ts). */
const ES_KEY = "brink-es:easyschematic-theme";

/**
 * The browser's real localStorage, captured when this module first loads, before the
 * schematic workspace installs its in-memory storage for EasySchematic (web/src/es/storage.ts).
 */
export const realStorage: Storage | null = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

function read(): ThemeMode {
  try {
    const v = realStorage?.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* blocked storage */
  }
  return "system";
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let mode: ThemeMode = read();
const listeners = new Set<() => void>();

export const resolvedDark = (m: ThemeMode = mode): boolean => (m === "system" ? !!media?.matches : m === "dark");

function apply(): void {
  const dark = resolvedDark();
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    realStorage?.setItem(ES_KEY, dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

export function setThemeMode(m: ThemeMode): void {
  mode = m;
  try {
    realStorage?.setItem(KEY, m);
  } catch {
    /* ignore */
  }
  apply();
  for (const l of listeners) l();
}

export function toggleDark(): void {
  setThemeMode(resolvedDark() ? "light" : "dark");
}

media?.addEventListener("change", () => {
  if (mode !== "system") return;
  apply();
  for (const l of listeners) l();
});

apply();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** { mode, dark } for components; re-renders on change. */
export function useThemeMode(): { mode: ThemeMode; dark: boolean } {
  const m = useSyncExternalStore(subscribe, () => mode);
  const dark = useSyncExternalStore(subscribe, () => resolvedDark());
  return { mode: m, dark };
}
