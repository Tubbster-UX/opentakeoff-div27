// The Takeoff tab's store adapter (web/src/ot/store.ts): upstream OpenTakeoff's storage
// seam backed by the Worker. Driven here with an in-memory Worker that applies edits the
// way the real one does (brink-merge's applyTakeoffEdits), so what the canvas would see
// after a reload is checked, not just the requests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { applyTakeoffEdits, parseTakeoffEditInput, targetTypeOf, type TakeoffEdit } from "../../brink-merge/src/takeoffEdits.js";
import type { OtShape, OtTakeoff } from "../../brink-merge/src/ot/types.js";
import type { SheetSummary, TakeoffEditRequest, TakeoffEditResponse, TakeoffEditResult, TakeoffView } from "../src/shared/protocol.js";
import { ApiError, type TakeoffApi } from "../web/src/ot/api.js";
import { applySaved, createBrinkTakeoffStore, type LocalLibraries, type TakeoffStatus } from "../web/src/ot/store.js";

const FIXTURE = fileURLToPath(new URL("../../brink-merge/fixtures/div27-sample.takeoff.json", import.meta.url));
const raw = (): OtTakeoff => JSON.parse(readFileSync(FIXTURE, "utf8")) as OtTakeoff;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An in-memory Worker: the raw takeoff, an edit layer with supersede / expect, a new import id per save. */
class FakeWorker implements TakeoffApi {
  base = raw();
  edits: TakeoffEdit[] = [];
  imports = 1;
  requests: TakeoffEditRequest[] = [];
  sheets: SheetSummary[] = [];
  bytes = new Map<string, Uint8Array>();
  fail: ApiError | null = null;
  seq = 0;
  importId = () => `00000000-0000-4000-8000-${String(this.imports).padStart(12, "0")}`;
  view(): TakeoffView {
    const applied = applyTakeoffEdits(this.base, this.edits);
    return {
      project_id: "p",
      project_name: "Invented",
      import_id: this.importId(),
      document: applied.takeoff as unknown as Record<string, unknown>,
      edits: this.edits.map((e) => ({ id: e.id, target_type: e.targetType, target_key: e.targetKey, kind: e.kind, editor_email: e.editorEmail, editor_auth: e.editorAuth, created_at: e.createdAt })),
      issues: applied.issues,
      sheets: this.sheets,
      readAt: "now",
    };
  }
  readTakeoff = async () => clone(this.view());
  listSheets = async () => clone(this.sheets);
  sheetBytes = async (id: string) => new Uint8Array(this.bytes.get(id)!);
  uploadSheet = async (name: string, buf: ArrayBuffer, pages: number | null) => {
    const sheet: SheetSummary = { id: `s${++this.seq}`, name, byte_size: buf.byteLength, sha256: `sha-${buf.byteLength}`, page_count: pages, rev: 1, uploaded_by: "alex@brink.test", created_at: "now" };
    this.sheets.push(sheet);
    this.bytes.set(sheet.id, new Uint8Array(buf));
    return { sheet };
  };
  removeSheet = async (id: string) => {
    this.sheets = this.sheets.filter((s) => s.id !== id);
    return { removed: true };
  };
  /** Someone else's save (another tab). */
  remote(op: { kind: TakeoffEdit["kind"]; target: string; payload: Record<string, unknown> }, email = "sam@brink.test"): TakeoffEdit {
    const e: TakeoffEdit = { id: `e${++this.seq}`, targetType: targetTypeOf(op.kind), targetKey: op.target, kind: op.kind, payload: op.payload, editorEmail: email, editorAuth: "cloudflare-access", createdAt: `2026-10-28T00:00:${String(this.seq).padStart(2, "0")}Z` };
    this.edits = this.edits.filter((x) => !(x.targetType === e.targetType && x.targetKey === e.targetKey));
    this.edits.push(e);
    this.imports++;
    return e;
  }
  saveEdits = async (req: TakeoffEditRequest): Promise<TakeoffEditResponse> => {
    this.requests.push(clone(req));
    if (this.fail) throw this.fail;
    const results: TakeoffEditResult[] = req.ops.map((op, i) => {
      const p = parseTakeoffEditInput(op);
      if (typeof p === "string") return { i, status: "invalid", error: p };
      if (p.kind === "shape_put" && (p.payload.shape as OtShape).condition_id === "cnd-refused") return { i, status: "invalid", error: "refused for the test" };
      const cur = this.edits.find((e) => e.targetType === targetTypeOf(p.kind) && e.targetKey === p.target) ?? null;
      const expect = (op as { expect?: string | null }).expect ?? null;
      if ((cur?.id ?? null) !== expect) return { i, status: "conflict", error: "newer edit", current: cur ? { id: cur.id, target_type: cur.targetType, target_key: cur.targetKey, kind: cur.kind, editor_email: cur.editorEmail, editor_auth: cur.editorAuth, created_at: cur.createdAt } : null };
      const e = this.remote(p, "alex@brink.test");
      this.imports--; // one new import per request, not per op
      return { i, status: "saved", edit: { id: e.id, target_type: e.targetType, target_key: e.targetKey, kind: e.kind, editor_email: e.editorEmail, editor_auth: e.editorAuth, created_at: e.createdAt }, superseded: cur?.id ?? null };
    });
    if (results.some((r) => r.status === "saved")) this.imports++;
    return { importId: this.importId(), editor: "alex@brink.test", results, reimport: { errors: 0, warnings: 3 } };
  };
}

const memLocal = (): LocalLibraries & { snaps: { label: string; project: string | null }[] } => {
  const snaps: { id: string; label: string; project: string | null; payload: unknown }[] = [];
  return {
    snaps,
    loadTemplates: async () => [],
    saveTemplates: async () => undefined,
    loadMaterialLibrary: async () => [],
    saveMaterialLibrary: async () => undefined,
    loadStampLibrary: async () => ({}),
    saveStampLibrary: async () => undefined,
    saveSnapshot: async (label, payload, project = null) => {
      snaps.push({ id: `snap${snaps.length}`, label, project, payload });
      return { id: `snap${snaps.length - 1}`, ts: 1 };
    },
    listSnapshots: async (project = null) => snaps.filter((s) => s.project === project),
    getSnapshot: async (id, project = null) => snaps.find((s) => s.id === id && s.project === project) ?? null,
    deleteSnapshot: async () => undefined,
  };
};

let api: FakeWorker;
let statuses: TakeoffStatus[];
let notices: { tone: string; text: string }[];
let local: ReturnType<typeof memLocal>;
const make = (opts: { projectName?: string } = {}) =>
  createBrinkTakeoffStore({
    projectId: "p",
    api,
    local,
    clientRef: "ot-this-tab",
    projectName: opts.projectName,
    onStatus: (s) => statuses.push(s),
    onNotice: (tone, text) => notices.push({ tone, text }),
    countPages: async () => 3,
  });
const last = () => statuses[statuses.length - 1]!;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  api = new FakeWorker();
  statuses = [];
  notices = [];
  local = memLocal();
});

describe("the store adapter (upstream's storage seam over the Worker)", () => {
  it("loads the server document, names an unnamed export after the project, and writes nothing", async () => {
    const store = make({ projectName: "Brink Div 27 sample (invented)" });
    const doc = await store.loadAnnotations();
    expect((doc.shapes as unknown[]).length).toBe(api.base.shapes.length);
    expect(doc.project_name).toBe("Brink Div 27 sample (invented)");
    store.setEditor("alex@brink.test");
    // the canvas autosaves the same document back (its hydration echo is suppressed upstream, but even if not):
    await store.saveAnnotations(doc);
    expect(api.requests).toEqual([]);
    expect(last()).toMatchObject({ state: "saved", unsupported: [], editor: "alex@brink.test" });
  });

  it("turns a whole-document autosave into edit-layer ops, with expect, and keeps per-tab view state out of them", async () => {
    const store = make();
    store.setEditor("alex@brink.test");
    const doc = (await store.loadAnnotations()) as unknown as OtTakeoff & Record<string, unknown>;
    const next = clone(doc);
    next.shapes[0]!.verts_norm = [[0.5, 0.5]];
    next.shapes.push({ ...clone(next.shapes[1]!), id: "shp-new", origin: { method: "manual" } });
    next.sheet_tabs = ["sample-plan.pdf"];
    next.palette = [next.conditions[0]!.id];
    await store.saveAnnotations(next);
    expect(api.requests).toHaveLength(1);
    const req = api.requests[0]!;
    expect(req.clientRef).toBe("ot-this-tab");
    expect(req.ops.map((o) => `${o.kind}:${"target" in o ? o.target : ""}:${(o as { expect?: string | null }).expect ?? null}`).sort()).toEqual([`shape_put:${doc.shapes[0]!.id}:null`, "shape_put:shp-new:null"].sort());
    expect(last()).toMatchObject({ state: "saved", saved: 2, importId: api.importId() });
    // The same document again: nothing new to send. A further change of the same shape sends the edit id it replaces.
    await store.saveAnnotations(next);
    expect(api.requests).toHaveLength(1);
    const again = clone(next);
    again.shapes[0]!.verts_norm = [[0.6, 0.6]];
    await store.saveAnnotations(again);
    const expected = api.edits.find((e) => e.targetKey === doc.shapes[0]!.id);
    expect(api.requests[1]!.ops).toEqual([expect.objectContaining({ kind: "shape_put", target: doc.shapes[0]!.id, expect: api.requests.length && (api.requests[1]!.ops[0] as { expect: string }).expect })]);
    expect((api.requests[1]!.ops[0] as { expect: string }).expect).not.toBeNull();
    expect(expected?.payload).toMatchObject({ shape: { verts_norm: [[0.6, 0.6]] } });
    // A reload shows what was saved, with this tab's view state laid over the server document.
    const reread = (await store.loadAnnotations()) as unknown as OtTakeoff & Record<string, unknown>;
    expect(reread.shapes.find((s) => s.id === "shp-new")).toBeTruthy();
    expect(reread.sheet_tabs).toEqual(["sample-plan.pdf"]);
  });

  it("lists what the layer does not keep, never drops it silently, and refuses to save without an identity", async () => {
    const store = make();
    const doc = (await store.loadAnnotations()) as Record<string, unknown> & OtTakeoff;
    const next = clone(doc);
    next.markups = [{ id: "mk1", type: "cloud" }];
    next.conditions = next.conditions.slice(1);
    next.shapes[0]!.label = "Desk";
    await expect(store.saveAnnotations(next)).rejects.toThrow(/no editor identity/);
    expect(api.requests).toEqual([]);
    expect(last()).toMatchObject({ state: "suspended" });
    expect(last().unsupported).toEqual(expect.arrayContaining(["markups", `conditions removed: ${doc.conditions[0]!.finish_tag}`]));
    store.setEditor("alex@brink.test");
    await store.saveAnnotations(next);
    expect(api.requests[0]!.ops.map((o) => o.kind)).toEqual(["shape_put"]);
    expect(last()).toMatchObject({ state: "saved" });
    expect(last().unsupported).toContain("markups");
  });

  it("a conflict keeps the other person's edit and re-hydrates the canvas through upstream's sync bridge", async () => {
    const store = make();
    store.setEditor("alex@brink.test");
    const hydrated: Record<string, unknown>[] = [];
    store.syncBridge.onRemoteUpdate = (d) => hydrated.push(d);
    const doc = (await store.loadAnnotations()) as unknown as OtTakeoff;
    const target = doc.shapes[0]!;
    api.remote({ kind: "shape_put", target: target.id, payload: { shape: { ...clone(target), label: "Sam's" } } });
    const mine = clone(doc);
    mine.shapes[0]!.label = "Alex's";
    await store.saveAnnotations(mine);
    expect(notices.some((n) => n.tone === "warn" && /sam@brink\.test saved a change/.test(n.text))).toBe(true);
    expect(hydrated).toHaveLength(1);
    expect((hydrated[0]!.shapes as OtShape[])[0]!.label).toBe("Sam's");
  });

  it("an op the server refuses is reported once and not re-sent until it changes", async () => {
    const store = make();
    store.setEditor("alex@brink.test");
    const doc = (await store.loadAnnotations()) as unknown as OtTakeoff;
    const next = clone(doc);
    next.shapes.push({ ...clone(next.shapes[0]!), id: "shp-bad", condition_id: "cnd-refused" });
    await store.saveAnnotations(next);
    await store.saveAnnotations(next);
    expect(api.requests).toHaveLength(1);
    expect(notices.filter((n) => n.tone === "error")).toHaveLength(1);
    expect(last().refused).toEqual([expect.stringMatching(/shp-bad: refused for the test/)]);
  });

  it("a failed request leaves the change pending and says why", async () => {
    const store = make();
    store.setEditor("alex@brink.test");
    const doc = (await store.loadAnnotations()) as unknown as OtTakeoff;
    const next = clone(doc);
    next.shapes[0]!.label = "x";
    api.fail = new ApiError(503, "database unavailable");
    await expect(store.saveAnnotations(next)).rejects.toThrow(/database unavailable/);
    expect(last()).toMatchObject({ state: "suspended", message: expect.stringMatching(/database unavailable/) });
    api.fail = null;
    await store.saveAnnotations(next);
    expect(last()).toMatchObject({ state: "saved", saved: 1 });
  });

  it("ignores its own realtime echo and its own imports; re-reads on another tab's edit or a re-import", async () => {
    const store = make();
    store.setEditor("alex@brink.test");
    const hydrated: Record<string, unknown>[] = [];
    store.syncBridge.onRemoteUpdate = (d) => hydrated.push(d);
    const doc = (await store.loadAnnotations()) as unknown as OtTakeoff;
    const next = clone(doc);
    next.shapes[0]!.label = "mine";
    await store.saveAnnotations(next);
    store.onEditRow("INSERT", { client_ref: "ot-this-tab", editor_email: "alex@brink.test" });
    store.onImportChanged(api.importId());
    await tick(350);
    expect(hydrated).toHaveLength(0);
    api.remote({ kind: "shape_delete", target: doc.shapes[1]!.id, payload: {} });
    store.onEditRow("INSERT", { client_ref: "ot-other-tab", editor_email: "sam@brink.test" });
    store.onEditRow("UPDATE", { client_ref: "ot-other-tab", superseded_at: "now" }); // a supersede: not news on its own
    await tick(350);
    expect(hydrated).toHaveLength(1);
    expect((hydrated[0]!.shapes as OtShape[]).some((s) => s.id === doc.shapes[1]!.id)).toBe(false);
    expect(notices.at(-1)!.text).toMatch(/sam@brink\.test saved a takeoff change/);
    store.onImportChanged("00000000-0000-4000-8000-999999999999");
    await tick(350);
    expect(hydrated).toHaveLength(2);
  });

  it("plan files go through the Worker: upload with a page count, fresh bytes per read, the stored hash, remove", async () => {
    const store = make();
    await store.loadAnnotations();
    await expect(store.addPdf(new File([new Uint8Array([37, 80, 68, 70, 45])], "a.pdf"))).rejects.toThrow(/identity/);
    store.setEditor("alex@brink.test");
    const out = await store.addPdf(new File([new Uint8Array([37, 80, 68, 70, 45, 49])], "a.pdf"));
    expect(out).toMatchObject({ name: "a.pdf", rev: 1 });
    expect(api.sheets[0]).toMatchObject({ name: "a.pdf", page_count: 3 });
    expect(await store.listSheets()).toEqual([{ name: "a.pdf" }]);
    const b1 = await store.loadPdfData("a.pdf");
    const b2 = await store.loadPdfData("a.pdf");
    expect(b1).not.toBe(b2);
    expect([...b1]).toEqual([37, 80, 68, 70, 45, 49]);
    expect(await store.pdfHash("a.pdf")).toBe("sha-6");
    await store.removePdf("a.pdf");
    expect(await store.listSheets()).toEqual([]);
    await expect(store.loadPdfData("a.pdf")).rejects.toThrow(/not in this project's plan set/);
  });

  it("keeps snapshots in this browser, scoped to the project", async () => {
    const store = make();
    await store.saveSnapshot("before", { shapes: [] });
    expect(local.snaps.map((s) => s.project)).toEqual(["brink:p"]);
    expect(await store.listSnapshots()).toHaveLength(1);
    expect(await local.listSnapshots(null)).toHaveLength(0);
  });

  it("applySaved mirrors the server's records into the baseline", () => {
    const doc = raw();
    applySaved(doc, { kind: "sheet_scale", target: "sample-plan.pdf", payload: { units_per_px: 0.05, scale_source: "calibrated" } });
    expect(doc.sheets[0]).toMatchObject({ units_per_px: 0.05, scale_source: "calibrated" });
    expect(doc.sheets[0]).not.toHaveProperty("scale_confirmed");
    applySaved(doc, { kind: "shape_delete", target: doc.shapes[0]!.id, payload: {} });
    expect(doc.shapes).toHaveLength(raw().shapes.length - 1);
  });
});
