// What the one app header shows beyond the logo: the open project, and what the
// current workspace contributes (its save status and its entries in the Project
// menu). Workspaces register on mount and clear on unmount, so the header never
// shows a tab's actions after the tab is gone.
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { MenuEntry } from "../design/index.js";

export interface ChromeState {
  project: { id: string; name: string; importLine: string } | null;
  /** Save status shown in the header (the Schematic tab's edit-layer saves). */
  status: ReactNode | null;
  /** Project-menu entries from the current workspace, in sections. */
  menu: { title: string; items: MenuEntry[] }[] | null;
}

let state: ChromeState = { project: null, status: null, menu: null };
const listeners = new Set<() => void>();

export function setChrome(patch: Partial<ChromeState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useChrome(): ChromeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Contribute to the header while mounted. */
export function useChromeSlot<K extends "status" | "menu">(key: K, value: ChromeState[K]): void {
  useEffect(() => {
    setChrome({ [key]: value } as Partial<ChromeState>);
  }, [key, value]);
  useEffect(() => () => setChrome({ [key]: null } as Partial<ChromeState>), [key]);
}
