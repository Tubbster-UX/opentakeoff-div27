// The canvas -> Brink chrome bridge. OpenTakeoff's canvas (TakeoffCanvas.jsx, one
// monolithic component) keeps every piece of takeoff state in its own hooks. The one
// patch the app makes to it (vendor/opentakeoff-patches/0001-host-bridge.patch) calls
// useOtHost(...) on every render with that render's state and verbs. This module keeps
// the latest render and lets the Brink toolbar, sheets panel, inspector and status bar
// (web/src/ot/brink/) read it with a selector, re-rendering only when what they show
// changes. The chrome never sets canvas state directly: it calls the canvas's own
// setters and functions, exactly as OpenTakeoff's own controls do.
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

/** A menu item as OpenTakeoff's ToolMenu takes it (scale menu, sheet menu). */
export interface OtMenuItem {
  id?: string;
  label?: string;
  section?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface OtSheetFile {
  name: string;
}

export interface OtCondition {
  id: string;
  finish_tag: string;
  color?: string;
  measure_role?: string;
  [k: string]: unknown;
}

export interface OtShape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role: string;
  label?: string;
  computed?: Record<string, number | undefined>;
  origin?: Record<string, unknown>;
  author?: string;
  updated_by?: string;
  updated_at?: string;
  created_at?: string;
  [k: string]: unknown;
}

export interface OtAction {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

/** What the patched canvas hands over each render (names are the canvas's own). */
export interface OtHostState {
  tool: string;
  setTool: (t: string | ((t: string) => string)) => void;
  poly: number;
  finishOk: boolean;
  finishShape: () => void;
  dropLastPoint: () => void;
  undoShapeCommand: () => void;
  redoShapeCommand: () => void;
  armCopyText: () => void;
  snapOn: boolean;
  setSnapOn: (v: boolean | ((v: boolean) => boolean)) => void;
  angleOn: boolean;
  setAngleOn: (v: boolean | ((v: boolean) => boolean)) => void;
  units: "imperial" | "metric";
  setUnits: (u: "imperial" | "metric" | ((u: string) => string)) => void;
  darkMode: boolean;
  setDarkMode: (v: boolean | ((v: boolean) => boolean)) => void;
  scaleFace: string;
  scaleItems: (OtMenuItem | string)[];
  unitsPerPx: number | null;
  scaleNeedsConfirm: boolean;
  sheets: OtSheetFile[];
  active: string;
  setActive: (name: string) => void;
  page: number;
  setPage: (p: number | ((p: number) => number)) => void;
  pageCount: number;
  knownPages: Record<string, number>;
  sheetKey: string;
  tabLabel: (key: string) => string;
  openSheets: (keys: string[], sideBySide: boolean) => void;
  goToSheet: (key: string) => void;
  view: string;
  setView: (v: string) => void;
  sheetGroup: string[];
  openTabs: string[];
  closeTab: (key: string) => void;
  fileInputRef: { current: HTMLInputElement | null };
  handleFiles: (files: FileList | File[]) => Promise<void>;
  refreshSheets: () => Promise<OtSheetFile[]>;
  closePdf: (name: string) => Promise<void>;
  status: string;
  conditions: OtCondition[];
  activeCond: string;
  activateCondition: (id: string, opts?: { reassign?: boolean }) => void;
  addCondition: () => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selShape: OtShape | null | undefined;
  shapes: OtShape[];
  visibleShapes: OtShape[];
  leftTab: string | null;
  setLeftTab: (t: string | null | ((t: string | null) => string | null)) => void;
  takeoffsOpen: boolean;
  toggleTakeoffs: () => void;
  agentOpen: boolean;
  setAgentOpen: (v: boolean | ((v: boolean) => boolean)) => void;
  setShowRevisions: (v: boolean) => void;
  openEstimate: () => void;
  setGuideOpen: (v: boolean) => void;
  setShowReport: (v: boolean) => void;
  showReport: boolean;
  exportMarkedSet: (includeMarkups?: boolean) => Promise<void>;
  saveState: string;
  commitMsg: string;
  setCommitMsg: (text: string) => void;
  projectName: string;
  tfRef: { current: { x: number; y: number; scale: number } };
  containerRef: { current: HTMLElement | null };
  zoomAround: (cx: number, cy: number, factor: number) => void;
  fitToView: (w: number, h: number) => void;
  stage: { w: number; h: number };
  workspaceActions: OtAction[];
  /** units_per_px by sheet key. */
  scales: Record<string, number>;
  /** The open panel of a sheet key (its rendered image size), when the sheet is open. */
  panelByKey: (key: string) => { img?: { w: number; h: number } } | undefined;
}

let current: OtHostState | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Called by the patched canvas on every render. Keeps that render's state, and tells the chrome
 * after the commit (never during render, so no component updates another while rendering).
 */
export function useOtHost(state: OtHostState): void {
  current = state;
  useLayoutEffect(() => {
    notify();
  });
  useLayoutEffect(
    () => () => {
      if (current === state) current = null;
      notify();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

/** The canvas's latest render (null before it mounts). For event handlers: always current. */
export const getHost = (): OtHostState | null => current;

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Read from the canvas with a selector. The component re-renders only when the selected value changes
 * (shallow), so a selector should return primitives or a small object of them.
 */
export function useHost<T>(select: (h: OtHostState) => T, fallback: T): T {
  const last = useRef<{ v: T } | null>(null);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      const v = current ? select(current) : fallback;
      if (last.current && shallowEqual(last.current.v, v)) return last.current.v;
      last.current = { v };
      return v;
    },
  );
}

export function subscribeHost(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
