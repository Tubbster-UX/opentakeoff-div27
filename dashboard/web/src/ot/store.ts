// OpenTakeoff's storage seam, backed by the Brink app's Worker instead of IndexedDB.
//
// Upstream's canvas talks only to `store` (vendor/opentakeoff/src/lib/store.js): listSheets,
// loadPdfData, addPdf, removePdf, loadAnnotations, saveAnnotations, plus the PDF-hash and
// library helpers. Upstream swaps that binding for a Drive-backed store in its own cloud
// mode with setActiveStore(); the Takeoff tab does the same with this one (no vendored
// file changes for persistence). What goes where:
//
//   plan PDFs           brink_sheets + Supabase Storage, through /api/projects/:id/sheets
//   the takeoff         loaded from GET /api/projects/:id/takeoff (the import's raw takeoff
//                       with the takeoff edit layer applied); saved as edit-layer ops:
//                       the canvas autosaves its whole document, diffTakeoff (brink-merge's
//                       own, src/takeoffEdits.ts) turns it into shape / condition / scale
//                       edits against the document last loaded or saved, and only those
//                       are posted. The server re-runs the import (BOM, schematic).
//   per-tab view state  open sheets, groups, the condition palette, units: kept in this tab
//   browser libraries   condition templates, material and stamp libraries: upstream's
//                       localStore (browser-global by design, as in upstream's cloud mode)
//   snapshots           upstream's localStore, scoped to this project
//
// Live: other tabs' saves arrive as relayed brink_takeoff_edits rows; the workspace calls
// remoteChanged(), which re-reads the server document and hands it to the canvas through
// upstream's own sync bridge (store.syncBridge.onRemoteUpdate), which defers while the
// person is mid-gesture and re-hydrates when idle. This tab's own echo is ignored
// (client_ref).
import {
  diffTakeoff, stableJson, targetTypeOf, VIEW_FIELDS,
  type SheetScalePayload, type TakeoffEditInput,
} from "../../../../brink-merge/src/takeoffEdits.js";
import type { OtCondition, OtShape, OtSheet, OtTakeoff } from "../../../../brink-merge/src/ot/types.js";
import type { SheetSummary, TakeoffEditResult, TakeoffView } from "../../../src/shared/protocol.js";
import type { TakeoffApi } from "./api.js";
import { ApiError } from "./api.js";

export type SaveState = "loading" | "saving" | "saved" | "pending" | "error" | "suspended";

export interface TakeoffStatus {
  state: SaveState;
  savedAt: string | null;
  editor: string | null;
  /** Changes the edit layer does not keep (so they are never silently lost). */
  unsupported: string[];
  /** Ops the server refused (invalid), with why. */
  refused: string[];
  /** Active edits the current import cannot carry as made (orphaned, made over an older original). */
  issues: TakeoffView["issues"];
  importId: string | null;
  message?: string;
  /** Edits saved by this tab in this session. */
  saved: number;
}

/** The subset of upstream's localStore the adapter delegates to (browser-global libraries, snapshots). */
export interface LocalLibraries {
  loadTemplates(): Promise<unknown[]>;
  saveTemplates(list: unknown[]): Promise<void>;
  loadMaterialLibrary(): Promise<unknown[]>;
  saveMaterialLibrary(list: unknown[]): Promise<void>;
  loadStampLibrary(): Promise<unknown>;
  saveStampLibrary(lib: unknown): Promise<void>;
  saveSnapshot(label: string, payload: unknown, project?: string | null): Promise<{ id: string; ts: number }>;
  listSnapshots(project?: string | null): Promise<unknown[]>;
  getSnapshot(id: string, project?: string | null): Promise<unknown>;
  deleteSnapshot(id: string): Promise<void>;
  putSnapshot?(record: unknown): Promise<void>;
}

/** Upstream's sync bridge, as TakeoffCanvas reads it (it registers the handlers). */
export interface SyncBridge {
  isBusy: (() => boolean) | null;
  onRemoteUpdate: ((data: Record<string, unknown>) => void) | null;
  getSheet: (() => string | null) | null;
  flushPending: () => Promise<void>;
}

export interface BrinkStoreOptions {
  projectId: string;
  api: TakeoffApi;
  local: LocalLibraries;
  /** Opaque id of this browser tab (its own realtime echo is ignored). */
  clientRef: string;
  onStatus: (s: TakeoffStatus) => void;
  onNotice: (tone: "info" | "warn" | "error", text: string) => void;
  /** The Brink project's name: the takeoff's own name when its export left it empty (report headers, export file names). */
  projectName?: string;
  /** Pages in a PDF (pdf.js), recorded with an upload; null when it cannot be read. */
  countPages?: (bytes: ArrayBuffer) => Promise<number | null>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const keyOf = (op: { kind: TakeoffEditInput["kind"]; target: string }) => `${targetTypeOf(op.kind)}|${op.target}`;

/** Apply ops the server saved to a document (the adapter's baseline): the same records the server now has. */
export function applySaved(doc: OtTakeoff, op: TakeoffEditInput): void {
  switch (op.kind) {
    case "shape_put": {
      const s = op.payload.shape as OtShape;
      const i = doc.shapes.findIndex((x) => x.id === s.id);
      if (i >= 0) doc.shapes[i] = clone(s);
      else doc.shapes.push(clone(s));
      return;
    }
    case "shape_delete":
      doc.shapes = doc.shapes.filter((x) => x.id !== op.target);
      return;
    case "condition_put": {
      const c = op.payload.condition as OtCondition;
      const i = doc.conditions.findIndex((x) => x.id === c.id);
      if (i >= 0) doc.conditions[i] = clone(c);
      else doc.conditions.push(clone(c));
      return;
    }
    case "sheet_scale": {
      const p = op.payload as unknown as SheetScalePayload;
      doc.sheets = doc.sheets ?? [];
      let s = doc.sheets.find((x) => x.sheet_id === op.target);
      if (!s) {
        s = { sheet_id: op.target } as OtSheet;
        doc.sheets.push(s);
      }
      if (p.units_per_px == null) delete s.units_per_px;
      else s.units_per_px = p.units_per_px;
      if (p.scale_source !== undefined) s.scale_source = p.scale_source;
      else delete s.scale_source;
      if (p.scale_confirmed !== undefined) s.scale_confirmed = p.scale_confirmed;
      else delete s.scale_confirmed;
      return;
    }
  }
}

export function createBrinkTakeoffStore(o: BrinkStoreOptions) {
  const SNAP_SCOPE = `brink:${o.projectId}`;
  let editor: string | null = null;
  let importId: string | null = null;
  /** The document as the server has it (after this tab's own saved ops). Diffs are taken against it. */
  let baseline: OtTakeoff | null = null;
  /** target -> the active edit this tab last saw (sent back as `expect`). */
  const expect = new Map<string, string>();
  /** Per-tab view state from the canvas's last save (open sheets, groups, palette, units). */
  let viewState: Record<string, unknown> = {};
  /** Ops the server refused, by target, with the record that was refused (not re-sent until it changes). */
  const refused = new Map<string, { sig: string; why: string }>();
  /** Imports this tab's own saves produced (a current_import_id move to one of them is not news). */
  const ownImports = new Set<string>();
  let sheets: SheetSummary[] | null = null;
  const bytes = new Map<string, Promise<Uint8Array>>();
  let status: TakeoffStatus = { state: "loading", savedAt: null, editor: null, unsupported: [], refused: [], issues: [], importId: null, saved: 0 };

  // The save queue: the canvas debounces (700 ms); one request in flight, the latest payload wins.
  let latest: Record<string, unknown> | null = null;
  let running = false;
  let again = false;
  let waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let disposed = false;

  const setStatus = (patch: Partial<TakeoffStatus>) => {
    status = { ...status, ...patch, editor };
    o.onStatus(status);
  };

  const bridge: SyncBridge = {
    isBusy: null,
    onRemoteUpdate: null,
    getSheet: null,
    // Upstream's idle drain calls this before re-reading: nothing is held back here (reads are always fresh).
    flushPending: async () => undefined,
  };

  function withView(doc: Record<string, unknown>): Record<string, unknown> {
    const out = clone(doc);
    for (const k of VIEW_FIELDS) if (k !== "schema" && k in viewState) out[k] = clone(viewState[k]);
    return out;
  }

  function adopt(view: TakeoffView): void {
    importId = view.import_id;
    // An export without a project name reads as the Brink project's (in the baseline too, so it is not a change).
    if (!view.document.project_name && o.projectName) view.document.project_name = o.projectName;
    baseline = clone(view.document) as unknown as OtTakeoff;
    expect.clear();
    for (const e of view.edits) expect.set(`${e.target_type}|${e.target_key}`, e.id);
    sheets = view.sheets;
    setStatus({ importId, issues: view.issues });
  }

  async function ensureSheets(): Promise<SheetSummary[]> {
    sheets ??= await o.api.listSheets();
    return sheets;
  }
  const sheetNamed = async (name: string) => (await ensureSheets()).find((s) => s.name === name) ?? null;

  async function flush(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    // `running` is cleared in the same tick the loop ends (not in a later .finally), so a save queued by a waiter
    // that was just resolved always starts a new round instead of being folded into one that already ended.
    running = true;
    try {
      do {
        again = false;
        const payload = latest;
        const done = waiters;
        waiters = [];
        try {
          await saveOnce(payload);
          for (const w of done) w.resolve();
        } catch (e) {
          for (const w of done) w.reject(e as Error);
        }
      } while ((again || waiters.length) && !disposed);
    } finally {
      running = false;
    }
  }

  async function saveOnce(payload: Record<string, unknown> | null): Promise<void> {
    if (!payload || !baseline || !importId) return;
    for (const k of VIEW_FIELDS) if (k in payload) viewState[k] = clone(payload[k]);
    const diff = diffTakeoff(baseline as unknown as Partial<OtTakeoff>, payload as Partial<OtTakeoff>);
    const ops = diff.ops.filter((op) => {
      const r = refused.get(keyOf(op));
      return !(r && r.sig === stableJson(op.payload));
    });
    for (const [k, r] of refused) if (!diff.ops.some((op) => keyOf(op) === k && stableJson(op.payload) === r.sig)) refused.delete(k);
    const refusedList = [...refused.values()].map((r) => r.why);
    if (!ops.length) {
      setStatus({ state: "saved", unsupported: diff.unsupported, refused: refusedList, message: undefined });
      return;
    }
    if (!editor) {
      setStatus({ state: "suspended", unsupported: diff.unsupported, refused: refusedList, message: "No editor identity: changes are not saved. Open the app through Cloudflare Access to save." });
      throw new Error("Not saved: no editor identity (Cloudflare Access).");
    }
    setStatus({ state: "saving", unsupported: diff.unsupported });
    let res;
    try {
      res = await o.api.saveEdits({ importId, clientRef: o.clientRef, ops: ops.map((op) => ({ ...op, expect: expect.get(keyOf(op)) ?? null })) });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : `Could not reach the server: ${(e as Error).message}`;
      setStatus({ state: e instanceof ApiError && (e.status === 401 || e.status === 503) ? "suspended" : "error", message: `Not saved: ${msg}` });
      throw new Error(`Not saved: ${msg}`);
    }
    if (disposed) return;
    let conflicts = 0;
    for (const r of res.results as TakeoffEditResult[]) {
      const op = ops[r.i]!;
      const k = keyOf(op);
      if (r.status === "saved") {
        expect.set(k, r.edit.id);
        applySaved(baseline, op);
      } else if (r.status === "reverted") {
        expect.delete(k);
        applySaved(baseline, op);
      } else if (r.status === "conflict") {
        conflicts++;
        o.onNotice("warn", `${r.current ? `${r.current.editor_email} saved a change to this ${targetTypeOf(op.kind)} first` : "This change was reverted by someone else"}: their version is kept, and the canvas now shows it.`);
      } else {
        refused.set(k, { sig: stableJson(op.payload), why: `${op.kind.replace("_", " ")} ${op.target}: ${r.error}` });
        o.onNotice("error", `Not saved (${op.kind.replace("_", " ")} ${op.target}): ${r.error}`);
      }
    }
    importId = res.importId;
    ownImports.add(res.importId);
    const saved = res.results.filter((r) => r.status === "saved" || r.status === "reverted").length;
    setStatus({
      state: "saved",
      savedAt: new Date().toISOString(),
      importId,
      saved: status.saved + saved,
      refused: [...refused.values()].map((r) => r.why),
      message: res.reimport && res.reimport.errors ? `Saved. The BOM was rebuilt with ${res.reimport.errors} error(s) and ${res.reimport.warnings} warning(s); see BOM & issues.` : undefined,
    });
    if (conflicts) await reload();
  }

  /** Re-read the server document and hand it to the canvas (upstream defers while the person is mid-gesture). */
  async function reload(reason?: string): Promise<void> {
    const view = await o.api.readTakeoff();
    if (disposed) return;
    adopt(view);
    if (reason) o.onNotice("info", reason);
    bridge.onRemoteUpdate?.(withView(view.document));
  }

  const store = {
    // ── upstream's seam ──────────────────────────────────────────────────
    async listSheets() {
      sheets = await o.api.listSheets();
      return sheets.map((s) => ({ name: s.name }));
    },
    async loadPdfData(name: string): Promise<Uint8Array> {
      const s = await sheetNamed(name);
      if (!s) throw new Error(`PDF not in this project's plan set: ${name}`);
      let p = bytes.get(s.id);
      if (!p) {
        p = o.api.sheetBytes(s.id);
        bytes.set(s.id, p);
        p.catch(() => bytes.delete(s.id));
      }
      // pdf.js may detach what it is given: a fresh copy per call.
      return new Uint8Array(await p);
    },
    async addPdf(file: File) {
      if (!editor) throw new Error("Plans are not saved without an editor identity (Cloudflare Access).");
      const buf = await file.arrayBuffer();
      const pages = o.countPages ? await o.countPages(buf.slice(0)).catch(() => null) : null;
      const out = await o.api.uploadSheet(file.name, buf, pages, o.clientRef);
      sheets = [...(sheets ?? []).filter((s) => s.name !== out.sheet.name), out.sheet];
      return { name: out.sheet.name, rev: out.sheet.rev, ...(out.unchanged ? { unchanged: true } : {}), ...(out.revised ? { revised: true, prev_rev: out.prevRev } : {}) };
    },
    async removePdf(name: string) {
      if (!editor) throw new Error("Plans are not changed without an editor identity (Cloudflare Access).");
      const s = await sheetNamed(name);
      if (!s) return;
      await o.api.removeSheet(s.id);
      sheets = (sheets ?? []).filter((x) => x.id !== s.id);
    },
    pdfHash: async (name: string) => (await sheetNamed(name))?.sha256 ?? null,
    pdfHashIfKnown: async (name: string) => (sheets ?? []).find((s) => s.name === name)?.sha256 ?? null,
    beginPdfHash: () => () => undefined,
    rememberPdfHash: () => undefined,
    forgetPdfHash: () => undefined,
    async loadAnnotations() {
      setStatus({ state: "loading" });
      const view = await o.api.readTakeoff();
      adopt(view);
      setStatus({ state: "saved" });
      return withView(view.document);
    },
    saveAnnotations(payload: Record<string, unknown>): Promise<void> {
      latest = payload;
      if (status.state === "saved") setStatus({ state: "pending" });
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        void flush();
      });
    },
    // Browser-global libraries: upstream's local store, as in its own cloud mode.
    loadTemplates: () => o.local.loadTemplates(),
    saveTemplates: (l: unknown[]) => o.local.saveTemplates(l),
    loadMaterialLibrary: () => o.local.loadMaterialLibrary(),
    saveMaterialLibrary: (l: unknown[]) => o.local.saveMaterialLibrary(l),
    loadStampLibrary: () => o.local.loadStampLibrary(),
    saveStampLibrary: (l: unknown) => o.local.saveStampLibrary(l),
    // Snapshots: this browser, scoped to the project.
    saveSnapshot: (label: string, payload: unknown) => o.local.saveSnapshot(label, payload, SNAP_SCOPE),
    listSnapshots: () => o.local.listSnapshots(SNAP_SCOPE),
    getSnapshot: (id: string) => o.local.getSnapshot(id, SNAP_SCOPE),
    deleteSnapshot: (id: string) => o.local.deleteSnapshot(id),
    /** No revision history of plan files through this seam (rows are kept server-side). */
    async listPdfRevisions(name: string) {
      const s = await sheetNamed(name);
      return s ? [{ rev: s.rev, hash: s.sha256, ts: Date.parse(s.created_at), current: true }] : [];
    },
    async loadPdfRevisionData(name: string) {
      return store.loadPdfData(name);
    },

    // ── the Brink side ────────────────────────────────────────────────────
    /** Who saves (the Access email), or null: then nothing is written and the status bar says why. */
    setEditor(email: string | null) {
      editor = email;
      setStatus({});
    },
    getStatus: () => status,
    /** A relayed brink_takeoff_edits row. Other tabs' edits re-read the document. */
    onEditRow(type: "INSERT" | "UPDATE" | "DELETE", record: Record<string, unknown> | null) {
      if (!record || disposed) return;
      if (type === "INSERT" && record.client_ref === o.clientRef) return; // our own echo
      if (type === "UPDATE" && !record.reverted_at) return; // a supersede: the INSERT that caused it is the news
      scheduleReload(`${String(record.editor_email ?? "Someone")} saved a takeoff change; the canvas now shows it.`);
    },
    /** A relayed brink_sheets row from another tab: refresh the plan set. */
    async onSheetRow(record: Record<string, unknown> | null): Promise<boolean> {
      if (!record || record.client_ref === o.clientRef || disposed) return false;
      sheets = await o.api.listSheets();
      return true;
    },
    /** The project's current import moved: news unless this tab's own save made it. */
    onImportChanged(id: string | null) {
      if (!id || ownImports.has(id) || id === importId) return;
      scheduleReload("The takeoff was re-imported; the canvas now shows the new import with your team's edits re-applied.");
    },
    /** Retry a failed save now. */
    retry: () => void flush(),
    reload,
    dispose() {
      disposed = true;
      clearTimeout(reloadTimer);
    },
  };

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadReason = "";
  function scheduleReload(reason: string) {
    reloadReason = reason;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reload(reloadReason).catch((e) => o.onNotice("error", `Could not re-read the takeoff: ${(e as Error).message}`)), 250);
  }

  // Upstream reads `store.syncBridge` (its local-first sync path): defer remote renders while busy.
  Object.defineProperty(store, "syncBridge", { value: bridge, enumerable: false });
  return store as typeof store & { readonly syncBridge: SyncBridge };
}

export type BrinkTakeoffStore = ReturnType<typeof createBrinkTakeoffStore>;
