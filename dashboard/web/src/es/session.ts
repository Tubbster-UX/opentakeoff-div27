// The open schematic session, shared by the Schematic workspace (workspace.tsx)
// and the Brink UI it puts in EasySchematic's layout slots (brink/*.tsx, mounted
// through the module overrides): the edit-layer sync, its save status and
// notices, which side panels are open, and the generated-rows outline the tab
// renders. One session at a time (the store is EasySchematic's module singleton).
import { useSyncExternalStore, type ReactNode } from "react";
import type { EditorStatus } from "../lib/esBridge.js";
import type { EditorSync } from "./sync";

export interface Notice {
  id: number;
  tone: "info" | "warn" | "error";
  text: string;
}

export type RightTab = "inspector" | "layers" | "info" | "signals" | "rows";

export interface SessionState {
  sync: EditorSync | null;
  status: EditorStatus | null;
  notices: Notice[];
  library: boolean;
  right: boolean;
  rightTab: RightTab;
  /** The tab's read-only outline of the generated rows (rendered by the app, shown in the Rows panel). */
  outline: ReactNode;
}

const PANELS_KEY = "brink:schematic-panels";
let state: SessionState = { sync: null, status: null, notices: [], library: true, right: true, rightTab: "inspector", outline: null, ...readPanels() };
const listeners = new Set<() => void>();
let seq = 0;

function readPanels(): Partial<SessionState> {
  try {
    const v = JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null") as Partial<SessionState> | null;
    return v ? { library: v.library !== false, right: v.right !== false, rightTab: v.rightTab ?? "inspector" } : {};
  } catch {
    return {};
  }
}

export function setSession(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  if ("library" in patch || "right" in patch || "rightTab" in patch) {
    try {
      sessionStorage.setItem(PANELS_KEY, JSON.stringify({ library: state.library, right: state.right, rightTab: state.rightTab }));
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l();
}

export function addNotice(tone: Notice["tone"], text: string): void {
  setSession({ notices: [{ id: ++seq, tone, text }, ...state.notices].slice(0, 6) });
}

export function dismissNotice(id: number): void {
  setSession({ notices: state.notices.filter((n) => n.id !== id) });
}

export const getSession = (): SessionState => state;

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
