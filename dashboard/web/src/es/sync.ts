// Saving the EasySchematic editor to the project's edit layer, and keeping it
// in step with other people's edits.
//
// The editor is upstream EasySchematic's engine (its store is unmodified): it
// knows nothing about Brink. This module watches its zustand store and compares it with a
// BASELINE (the project's schematic as last loaded or saved). Differences
// become edit-layer ops (brink-merge/docs/schematic-edits.md):
//   node label changed                 -> rename
//   node moved into / out of a room    -> room_assign (+ move)
//   node moved (or a room resized)     -> move
//   a takeoff cable removed            -> disconnect
//   a connection added                 -> connect
//   an added connection removed        -> revert of its connect edit
// Anything else the editor lets a person change (deleting a takeoff device,
// adding devices from the library, port or cable details, manual cable
// routes) is NOT kept by the edit layer in this phase. It is listed in the
// tab's status bar as "not saved" rather than dropped silently, and "Discard"
// reloads the saved schematic.
//
// Other people's edits arrive as relayed brink_schematic_edits rows (the
// Schematic tab forwards them). This tab ignores rows it wrote itself (client_ref); for the
// rest it re-reads the server's render and patches the targets that changed
// into the store. A saved edit always wins over an unsaved local change to the
// same target, and the person is told.
import { connectKey } from "../../../../brink-merge/src/ids.js";
import { GRID_SIZE } from "../../../vendor/easyschematic/src/gridConstants";
import { useSchematicStore } from "../../../vendor/easyschematic/src/store";
import type { SchematicFile } from "../../../vendor/easyschematic/src/types";
import type { EditRequest, EditResponse, EditSummary, RowChange, SchematicView } from "../../../src/shared/protocol.js";
import type { EditorMessage, SaveState } from "../lib/esBridge.js";

interface LooseNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentId?: string;
  data: Record<string, unknown>;
  style?: Record<string, unknown>;
  width?: number;
  height?: number;
}

interface LooseEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Record<string, unknown>;
}

interface NodeSnap {
  id: string;
  type: string;
  parent: string | null;
  x: number;
  y: number;
  label: string;
  w: number | null;
  h: number | null;
  /** Everything else in `data` (ports, model, colors...), per key, to notice changes the layer does not keep. */
  sig: Record<string, string>;
}

interface EdgeSnap {
  key: string;
  id: string;
  generated: boolean;
  editId: string | null;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  signalType: string;
  label?: string;
  cableLength?: string;
  edge: LooseEdge;
}

interface Snap {
  nodes: Map<string, NodeSnap>;
  edges: Map<string, EdgeSnap>;
}

type Op =
  | { kind: "rename" | "room_assign" | "move" | "disconnect" | "connect"; target: string; payload: Record<string, unknown>; key: string }
  | { kind: "revert"; edit: string; key: string };

const DEBOUNCE_MS = 700;
const RETRY_MS = 4000;
const SETTLE_MS = 400;

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const snapGrid = (v: number): number => Math.round(v / GRID_SIZE) * GRID_SIZE;

/**
 * The port fields EasySchematic's device editor round-trips (DeviceEditor's port sync at the vendored commit). It
 * drops the rest (e.g. templatePortId) when a device is applied, which is not a change a person made.
 */
const PORT_FIELDS = [
  "id", "label", "signalType", "direction", "section", "connectorType", "gender", "networkConfig", "capabilities", "isMulticable", "channelCount", "multiConnect",
  "directAttach", "notes", "poeDrawW", "usbcPowerSourceW", "usbcPowerDrawW", "linkSpeed", "flipped", "addressable", "rearConnectorType", "rearGender",
  "frontConnectorType", "frontGender", "inheritsSignal",
];
const portFields = (p: unknown): unknown =>
  p && typeof p === "object" ? Object.fromEntries(PORT_FIELDS.filter((k) => (p as Record<string, unknown>)[k] !== undefined).map((k) => [k, (p as Record<string, unknown>)[k]])) : p;

function nodeSnap(n: LooseNode, snapToGrid: boolean): NodeSnap {
  const { label, brink: _brink, ...rest } = n.data ?? {};
  const isRoom = n.type === "room";
  const fix = (v: number) => (snapToGrid && n.type !== "stub-label" && n.type !== "text-stub" ? snapGrid(v) : v);
  return {
    id: n.id,
    type: n.type ?? "",
    parent: n.parentId ?? null,
    x: fix(n.position.x),
    y: fix(n.position.y),
    label: typeof label === "string" ? label : "",
    w: isRoom ? num(n.style?.width) ?? num(n.width) : null,
    h: isRoom ? num(n.style?.height) ?? num(n.height) : null,
    sig: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, JSON.stringify(sortKeys(k === "ports" && Array.isArray(v) ? v.map(portFields) : v))])),
  };
}

const brinkOf = (e: LooseEdge): { source?: string; editId?: string } => ((e.data?.brink ?? {}) as { source?: string; editId?: string });

export function edgeKey(e: LooseEdge): string {
  return brinkOf(e).source === "opentakeoff" ? `id:${e.id}` : connectKey(e.source, e.sourceHandle ?? null, e.target, e.targetHandle ?? null);
}

function edgeSnap(e: LooseEdge): EdgeSnap {
  const b = brinkOf(e);
  return {
    key: edgeKey(e),
    id: e.id,
    generated: b.source === "opentakeoff",
    editId: b.source === "edit" ? b.editId ?? null : null,
    source: e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: e.target,
    targetHandle: e.targetHandle ?? null,
    signalType: String(e.data?.signalType ?? ""),
    ...(typeof e.data?.label === "string" ? { label: e.data.label } : {}),
    ...(typeof e.data?.cableLength === "string" ? { cableLength: e.data.cableLength } : {}),
    edge: e,
  };
}

function snapshot(nodes: LooseNode[], edges: LooseEdge[], snapToGrid = false): Snap {
  return {
    nodes: new Map(nodes.map((n) => [n.id, nodeSnap(n, snapToGrid)])),
    edges: new Map(edges.map((e) => [edgeKey(e), edgeSnap(e)])),
  };
}

/**
 * The editor's state. Positions are snapped to EasySchematic's grid, as its own load (importFromJSON) snaps
 * them: a saved position then reopens exactly where it was saved.
 */
const storeSnap = (): Snap => {
  const s = useSchematicStore.getState();
  return snapshot(s.nodes as unknown as LooseNode[], s.edges as unknown as LooseEdge[], true);
};

const name = (n: NodeSnap): string => (n.label ? `"${n.label}"` : n.id);
const samePlace = (a: NodeSnap, b: NodeSnap) => a.parent === b.parent && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** The ops that take `base` to `cur`, and what changed that the edit layer does not keep. */
export function diff(base: Snap, cur: Snap): { ops: Op[]; unsupported: string[] } {
  const ops: Op[] = [];
  const unsupported: string[] = [];
  for (const [id, b] of base.nodes) {
    const c = cur.nodes.get(id);
    if (!c) {
      unsupported.push(`${b.type || "element"} ${name(b)} deleted: elements from the takeoff are removed in OpenTakeoff`);
      continue;
    }
    if (c.label !== b.label) {
      if (c.label.trim()) ops.push({ kind: "rename", target: id, payload: { label: c.label }, key: `${id}|rename` });
      else unsupported.push(`${name(b)}: an empty name is not saved`);
    }
    if (c.parent !== b.parent) {
      if (c.type === "room") unsupported.push(`room ${name(c)} put inside another room`);
      else ops.push({ kind: "room_assign", target: id, payload: { room: c.parent }, key: `${id}|room_assign` });
    }
    if (!samePlace(c, b) && !(c.type === "room" && c.parent !== b.parent)) {
      const payload: Record<string, unknown> = { x: c.x, y: c.y, parent: c.parent };
      if (c.type === "room" && c.w != null && c.h != null) Object.assign(payload, { width: c.w, height: c.h });
      ops.push({ kind: "move", target: id, payload, key: `${id}|move` });
    }
    const changed = [...new Set([...Object.keys(b.sig), ...Object.keys(c.sig)])].filter((k) => b.sig[k] !== c.sig[k]).sort();
    if (changed.length) unsupported.push(`${name(c)}: changes to ${changed.join(", ")} are not saved (only the name is)`);
  }
  for (const [id, c] of cur.nodes) {
    if (!base.nodes.has(id)) unsupported.push(`added ${c.type || "element"} ${name(c)}: adding elements is not saved in this version`);
  }
  for (const [key, b] of base.edges) {
    const c = cur.edges.get(key);
    if (!c) {
      // Gone with a deleted element: part of that (unsaved) deletion, not a separate edit.
      if (!cur.nodes.has(b.source) || !cur.nodes.has(b.target)) continue;
      if (b.generated) ops.push({ kind: "disconnect", target: b.id, payload: {}, key: `${b.id}|disconnect` });
      else if (b.editId) ops.push({ kind: "revert", edit: b.editId, key });
      continue;
    }
    if (b.generated && (c.label !== b.label || c.cableLength !== b.cableLength || c.signalType !== b.signalType)) {
      unsupported.push(`cable ${b.id}: its type, label and length come from the takeoff and are not saved`);
    }
  }
  for (const [key, c] of cur.edges) {
    if (base.edges.has(key)) continue;
    if (c.generated) continue; // a takeoff cable reappearing (undo of a removal) is the absence of its disconnect: handled above
    if (!base.nodes.has(c.source) || !base.nodes.has(c.target)) {
      unsupported.push(`a connection to an added element is not saved`);
      continue;
    }
    ops.push({
      kind: "connect",
      target: key,
      payload: { source: c.source, sourceHandle: c.sourceHandle, target: c.target, targetHandle: c.targetHandle, signalType: c.signalType || "custom", ...(c.label ? { label: c.label } : {}), ...(c.cableLength ? { cableLength: c.cableLength } : {}) },
      key,
    });
  }
  return { ops, unsupported: [...new Set(unsupported)] };
}

function randomRef(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class EditorSync {
  readonly clientRef = randomRef();
  private base: Snap = { nodes: new Map(), edges: new Map() };
  /** `${target}|${kind}` -> active edit id: what this tab last saw, sent back as `expect`. */
  private active = new Map<string, string>();
  private importId: string | null = null;
  private loadSeq = -1;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight = false;
  private dirtyAgain = false;
  private state: SaveState = "loading";
  private savedAt: string | null = null;
  private message: string | undefined;
  private lastStatus = "";
  private unsubscribe: (() => void) | null = null;

  private readonly projectId: string;
  private editor: string | null;
  private readonly post: (m: EditorMessage) => void;

  constructor(projectId: string, editor: string | null, post: (m: EditorMessage) => void) {
    this.projectId = projectId;
    this.editor = editor;
    this.post = post;
  }

  /** Load the project's schematic into the editor (also after a re-import, or Discard). */
  async load(notice?: string): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.ready = false;
    this.setState("loading");
    const view = await this.fetchView();
    if (!view || this.disposed) return;
    const store = useSchematicStore.getState();
    store.importFromJSON(view.file as unknown as SchematicFile);
    this.loadSeq = useSchematicStore.getState().loadSeq;
    this.importId = view.import_id;
    this.setActive(view.edits);
    // Let the editor finish its own load-time work (routing, measuring) before taking the baseline.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, SETTLE_MS))));
    if (this.disposed) return;
    this.base = storeSnap();
    this.ready = true;
    this.unsubscribe ??= useSchematicStore.subscribe(() => this.onStoreChange());
    this.setState("saved");
    if (notice) this.post({ type: "es:notice", tone: "info", text: notice });
    for (const i of view.issues) this.post({ type: "es:notice", tone: "warn", text: i.message });
  }

  /** The Access identity edits are saved under (known once /api/me answers, before the first load). */
  setEditor(editor: string | null): void {
    this.editor = editor;
  }

  /** The tab is closing: save what is pending, then stop listening. An in-flight save completes. */
  dispose(): void {
    if (this.disposed) return;
    if (this.ready) {
      clearTimeout(this.timer);
      void this.flush();
    }
    this.disposed = true;
    this.ready = false;
    clearTimeout(this.resyncTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private disposed = false;

  /** Save now (Ctrl+S). */
  flushNow(): void {
    clearTimeout(this.timer);
    void this.flush();
  }

  /** A relayed brink_schematic_edits row. */
  onEditChange(change: RowChange): void {
    const r = change.record ?? change.old;
    if (!r || r.project_id !== this.projectId) return;
    if (r.client_ref === this.clientRef) return; // our own echo
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => void this.resync(), 250);
  }

  onImportChanged(importId: string | null): void {
    if (importId && importId === this.importId) return;
    void this.load("The project was re-imported. The editor reloaded it; your saved edits were re-applied to the new import.");
  }

  private setActive(edits: EditSummary[]): void {
    this.active = new Map(edits.map((e) => [`${e.target_key}|${e.kind}`, e.id]));
  }

  private async fetchView(): Promise<SchematicView | null> {
    try {
      const res = await fetch(`/api/projects/${this.projectId}/schematic`, { cache: "no-store" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      return (await res.json()) as SchematicView;
    } catch (e) {
      this.setState("error", `Could not load the schematic: ${(e as Error).message}`);
      return null;
    }
  }

  private onStoreChange(): void {
    if (!this.ready) return;
    const seq = useSchematicStore.getState().loadSeq;
    if (seq !== this.loadSeq) {
      // File > New / Open / Import replaced the document: nothing in it maps onto the project's edit layer.
      this.ready = false;
      clearTimeout(this.timer);
      this.setState("suspended", "The editor's document was replaced (File > New, Open or Import). Nothing from it is saved to the project. Reload the project schematic to keep editing.");
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
    // A drag changes the store on every pointer move: report at most once a frame.
    if (this.reportQueued) return;
    this.reportQueued = true;
    requestAnimationFrame(() => {
      this.reportQueued = false;
      this.report();
    });
  }

  private reportQueued = false;

  private report(): void {
    if (!this.ready) return;
    const { ops, unsupported } = diff(this.base, storeSnap());
    const state: SaveState = this.inflight ? "saving" : this.state === "error" ? "error" : ops.length ? "pending" : "saved";
    this.emit(state, ops.length, unsupported);
  }

  private setState(state: SaveState, message?: string): void {
    this.state = state;
    this.message = message;
    if (state === "saved" || state === "pending" || state === "saving") this.report();
    else this.emit(state, 0, []);
  }

  private emit(state: SaveState, pending: number, unsupported: string[]): void {
    if (this.disposed) return;
    const msg: EditorMessage = { type: "es:status", state, pending, unsupported, savedAt: this.savedAt, editor: this.editor, ...(this.message ? { message: this.message } : {}) };
    const key = JSON.stringify(msg);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.post(msg);
  }

  private async flush(): Promise<void> {
    if (!this.ready) return;
    if (this.inflight) {
      this.dirtyAgain = true;
      return;
    }
    if (useSchematicStore.getState().isDragging) {
      this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
      return;
    }
    const { ops } = diff(this.base, storeSnap());
    if (ops.length && !this.editor) {
      // No Cloudflare Access identity: an edit could not be attributed, so the Worker would refuse it. Say so; do not try.
      this.state = "error";
      this.message = "Not signed in through Cloudflare Access: changes in the editor cannot be saved.";
      this.report();
      return;
    }
    if (!ops.length) {
      this.state = "saved";
      this.report();
      return;
    }
    this.inflight = true;
    this.state = "saving";
    this.report();
    const body: EditRequest = {
      importId: this.importId!,
      clientRef: this.clientRef,
      ops: ops.map((o) => (o.kind === "revert" ? { kind: "revert", edit: o.edit } : { kind: o.kind, target: o.target, payload: o.payload, expect: this.active.get(o.key) ?? null })),
    };
    let resync = false;
    try {
      const res = await fetch(`/api/projects/${this.projectId}/schematic/edits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as EditResponse & { error?: string; currentImportId?: string };
      if (res.status === 409 && data.currentImportId) {
        this.inflight = false;
        await this.load("The project was re-imported while you were editing. The editor reloaded it; changes that were not saved yet were not applied.");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const problems: string[] = [];
      for (const r of data.results) {
        const op = ops[r.i]!;
        if (r.status === "saved") {
          this.active.set(op.key, r.edit.id);
          this.acceptIntoBase(op, r.edit.id);
        } else if (r.status === "reverted") {
          this.active.delete(op.key);
          this.base.edges.delete(op.key);
        } else {
          problems.push(r.error);
          resync = true;
        }
      }
      this.savedAt = new Date().toISOString();
      this.state = "saved";
      this.message = undefined;
      if (problems.length) this.post({ type: "es:notice", tone: "warn", text: `Not saved: ${problems.join("; ")}. The editor now shows the saved version.` });
    } catch (e) {
      this.state = "error";
      this.message = `Saving failed: ${(e as Error).message}. Retrying.`;
      this.timer = setTimeout(() => void this.flush(), RETRY_MS);
    } finally {
      this.inflight = false;
    }
    if (resync) await this.resync();
    this.report();
    if (this.dirtyAgain) {
      this.dirtyAgain = false;
      this.timer = setTimeout(() => void this.flush(), 50);
    }
  }

  /** A saved op becomes part of the baseline, with the values it saved. */
  private acceptIntoBase(op: Op, editId: string): void {
    if (op.kind === "revert") return;
    const b = this.base.nodes.get(op.target);
    const p = op.payload;
    if (op.kind === "rename" && b) b.label = String(p.label);
    else if (op.kind === "room_assign" && b) b.parent = (p.room as string | null) ?? null;
    else if (op.kind === "move" && b) {
      b.x = p.x as number;
      b.y = p.y as number;
      b.parent = (p.parent as string | null) ?? null;
      if (typeof p.width === "number") b.w = p.width;
      if (typeof p.height === "number") b.h = p.height;
    } else if (op.kind === "disconnect") {
      this.base.edges.delete(`id:${op.target}`);
    } else if (op.kind === "connect") {
      const cur = storeSnap().edges.get(op.key);
      if (cur) this.base.edges.set(op.key, { ...cur, editId });
    }
  }

  /** Bring other people's saved edits into the editor: patch every target where the server differs from the baseline. */
  private async resync(): Promise<void> {
    if (!this.ready) return;
    const view = await this.fetchView();
    if (!view || !this.ready) return;
    if (view.import_id !== this.importId) {
      await this.load("The project was re-imported. The editor reloaded it; your saved edits were re-applied to the new import.");
      return;
    }
    this.setActive(view.edits);
    const file = view.file as unknown as { nodes: LooseNode[]; edges: LooseEdge[] };
    // Upstream snaps positions to its grid on load; compare like with like.
    const server = snapshot(file.nodes, file.edges, true);
    const cur = storeSnap();
    const patches = new Map<string, NodeSnap>();
    const overwritten: string[] = [];
    for (const [id, s] of server.nodes) {
      const b = this.base.nodes.get(id);
      if (!b) continue;
      const labelChanged = s.label !== b.label;
      const placeChanged = !samePlace(s, b);
      if (!labelChanged && !placeChanged) continue;
      const c = cur.nodes.get(id);
      if (c && ((labelChanged && c.label !== b.label && c.label !== s.label) || (placeChanged && !samePlace(c, b) && !samePlace(c, s)))) overwritten.push(name(c));
      if (labelChanged) b.label = s.label;
      if (placeChanged) Object.assign(b, { parent: s.parent, x: s.x, y: s.y, w: s.w, h: s.h });
      patches.set(id, b);
    }
    const addEdges: LooseEdge[] = [];
    const dropKeys = new Set<string>();
    for (const [key, s] of server.edges) {
      if (this.base.edges.has(key)) {
        this.base.edges.get(key)!.editId = s.editId;
        continue;
      }
      this.base.edges.set(key, s);
      if (!cur.edges.has(key)) addEdges.push(s.edge);
    }
    for (const key of [...this.base.edges.keys()]) {
      if (server.edges.has(key)) continue;
      this.base.edges.delete(key);
      dropKeys.add(key);
    }
    if (patches.size || addEdges.length || dropKeys.size) {
      useSchematicStore.setState((st) => ({
        nodes: (st.nodes as unknown as LooseNode[]).map((n) => {
          const p = patches.get(n.id);
          if (!p) return n;
          const next: LooseNode = { ...n, position: { x: p.x, y: p.y }, data: { ...n.data, label: p.label } };
          if (p.parent) next.parentId = p.parent;
          else delete next.parentId;
          if (n.type === "room" && p.w != null && p.h != null) Object.assign(next, { style: { ...(n.style ?? {}), width: p.w, height: p.h }, width: p.w, height: p.h });
          return next;
        }) as unknown as typeof st.nodes,
        edges: [...(st.edges as unknown as LooseEdge[]).filter((e) => !dropKeys.has(edgeKey(e))), ...addEdges] as unknown as typeof st.edges,
      }));
    }
    if (overwritten.length) this.post({ type: "es:notice", tone: "warn", text: `Someone else saved changes to ${overwritten.join(", ")}; the editor shows their saved version.` });
    this.report();
  }
}
