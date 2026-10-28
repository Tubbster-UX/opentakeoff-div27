// The open takeoff session, shared by the Takeoff workspace (workspace.tsx) and its
// Brink chrome (brink/*.tsx): the store adapter, its save status and notices, and which
// side panels are open. One session at a time (the canvas is upstream's module singleton
// store binding, swapped per mount).
import { useSyncExternalStore } from "react";
import type { Tone } from "../design/index.js";
import type { BrinkTakeoffStore, SaveState, TakeoffStatus } from "./store";

export const STATE_TEXT: Record<SaveState, string> = {
  loading: "Loading…",
  saving: "Saving…",
  saved: "All changes saved",
  pending: "Unsaved changes",
  error: "Not saved",
  suspended: "Not saving",
};
export const STATE_TONE: Record<SaveState, Tone> = { loading: "neutral", saving: "warn", saved: "ok", pending: "warn", error: "danger", suspended: "danger" };

export interface Notice {
  id: number;
  tone: "info" | "warn" | "error";
  text: string;
}

export type RightTab = "conditions" | "inspector" | "edits";

export interface SessionState {
  store: BrinkTakeoffStore | null;
  status: TakeoffStatus | null;
  notices: Notice[];
  sheets: boolean;
  right: boolean;
  rightTab: RightTab;
  projectId: string | null;
  projectName: string;
}

const PANELS_KEY = "brink:takeoff-panels";
let state: SessionState = { store: null, status: null, notices: [], sheets: true, right: true, rightTab: "conditions", projectId: null, projectName: "", ...readPanels() };
const listeners = new Set<() => void>();
let seq = 0;

function readPanels(): Partial<SessionState> {
  try {
    const v = JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null") as Partial<SessionState> | null;
    return v ? { sheets: v.sheets !== false, right: v.right !== false, rightTab: v.rightTab ?? "conditions" } : {};
  } catch {
    return {};
  }
}

export function setSession(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  if ("sheets" in patch || "right" in patch || "rightTab" in patch) {
    try {
      sessionStorage.setItem(PANELS_KEY, JSON.stringify({ sheets: state.sheets, right: state.right, rightTab: state.rightTab }));
    } catch {
      /* per-tab convenience only */
    }
  }
  for (const l of listeners) l();
}

export function addNotice(tone: Notice["tone"], text: string): void {
  if (state.notices[0]?.text === text) return;
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
