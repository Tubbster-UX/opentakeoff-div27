// The takeoff edit layer (src/takeoffEdits.ts, docs/takeoff-edits.md): edits made
// in the Brink app's takeoff canvas are a layer over the import's raw takeoff (the
// machine original). They are applied on every render and every import, keep the
// machine's original ring and authorship, cannot be used by a process to mark
// machine work reviewed, and an edit whose target left the takeoff becomes a
// warning, never dropped and never re-aimed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openPglite, openPostgres, type Db } from "../src/db/db.js";
import {
  currentImport, loadActiveTakeoffEdits, loadBomLines, loadCatalog, loadImportInput, loadIssues, recordTakeoffEdit, renderTakeoff, revertTakeoffEdit, saveMerge, seedCatalog,
} from "../src/db/repository.js";
import { merge } from "../src/pipeline.js";
import {
  applyTakeoffEdits, diffTakeoff, keepMachineOriginal, parseTakeoffEditInput, recordHash, stableJson, takeoffTargetContext,
  type TakeoffEdit, type TakeoffEditInput,
} from "../src/takeoffEdits.js";
import type { OtShape, OtTakeoff } from "../src/ot/types.js";
import { catalog, clone, load } from "./helpers.js";

const PROJECT = "Brink Div 27 sample (invented)";
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
let seq = 0;
const edit = (input: TakeoffEditInput | string, extra: Partial<TakeoffEdit> = {}, base?: OtTakeoff): TakeoffEdit => {
  if (typeof input === "string") throw new Error(input);
  return {
    id: `t${++seq}`,
    targetType: input.kind === "condition_put" ? "condition" : input.kind === "sheet_scale" ? "sheet" : "shape",
    targetKey: input.target,
    kind: input.kind,
    payload: input.payload,
    editorEmail: "alex@brink.test",
    editorAuth: "cloudflare-access",
    createdAt: `2026-10-28T10:00:${String(seq).padStart(2, "0")}Z`,
    targetContext: base ? takeoffTargetContext(base, input) : null,
    ...extra,
  };
};
const tag = (t: OtTakeoff, tagName: string) => t.conditions.find((c) => c.finish_tag === tagName)!;
const shapesOf = (t: OtTakeoff, tagName: string) => t.shapes.filter((s) => s.condition_id === tag(t, tagName).id);

describe("parseTakeoffEditInput", () => {
  const base = load("div27-sample").takeoff;
  const shape = base.shapes[0]!;
  it("accepts the four kinds and normalizes the payload", () => {
    expect(parseTakeoffEditInput({ kind: "shape_put", target: shape.id, payload: { shape } })).toMatchObject({ kind: "shape_put", target: shape.id });
    expect(parseTakeoffEditInput({ kind: "shape_delete", target: shape.id, payload: { anything: 1 } })).toEqual({ kind: "shape_delete", target: shape.id, payload: {} });
    expect(parseTakeoffEditInput({ kind: "condition_put", target: base.conditions[0]!.id, payload: { condition: base.conditions[0] } })).toMatchObject({ kind: "condition_put" });
    expect(parseTakeoffEditInput({ kind: "sheet_scale", target: "sample-plan.pdf", payload: { units_per_px: 0.05, scale_source: "calibrated", junk: 1 } })).toEqual({
      kind: "sheet_scale", target: "sample-plan.pdf", payload: { units_per_px: 0.05, scale_source: "calibrated" },
    });
  });
  it("refuses malformed records", () => {
    expect(parseTakeoffEditInput({ kind: "nope", target: "x" })).toMatch(/kind must be/);
    expect(parseTakeoffEditInput({ kind: "shape_put", target: "other", payload: { shape } })).toMatch(/id must be the target/);
    expect(parseTakeoffEditInput({ kind: "shape_put", target: shape.id, payload: { shape: { ...shape, measure_role: "volume" } } })).toMatch(/measure_role/);
    expect(parseTakeoffEditInput({ kind: "shape_put", target: shape.id, payload: { shape: { ...shape, verts_norm: [[0, "a"]] } } })).toMatch(/verts_norm/);
    expect(parseTakeoffEditInput({ kind: "shape_put", target: shape.id, payload: { shape: { ...shape, computed: { count: -1 } } } })).toMatch(/non-negative/);
    expect(parseTakeoffEditInput({ kind: "condition_put", target: "c", payload: { condition: { id: "c", finish_tag: " " } } })).toMatch(/finish_tag/);
    expect(parseTakeoffEditInput({ kind: "condition_put", target: "c", payload: { condition: { id: "c", finish_tag: "X", multiplier: 0 } } })).toMatch(/multiplier/);
    expect(parseTakeoffEditInput({ kind: "sheet_scale", target: "s", payload: { units_per_px: -2 } })).toMatch(/positive/);
  });
});

describe("applyTakeoffEdits", () => {
  const input = load("div27-sample");
  const base = input.takeoff;
  const data = shapesOf(base, "DATA-1");

  it("adds, moves and deletes shapes and sets a scale, without touching the raw takeoff", () => {
    const before = JSON.stringify(base);
    const moved = { ...clone(data[0]!), verts_norm: [[0.5, 0.5]] };
    const added: OtShape = { ...clone(data[1]!), id: "shp-added-in-app", verts_norm: [[0.4, 0.4]], origin: { method: "manual" } };
    const r = applyTakeoffEdits(base, [
      edit(parseTakeoffEditInput({ kind: "shape_put", target: moved.id, payload: { shape: moved } }), {}, base),
      edit(parseTakeoffEditInput({ kind: "shape_put", target: added.id, payload: { shape: added } }), {}, base),
      edit(parseTakeoffEditInput({ kind: "shape_delete", target: data[2]!.id, payload: {} }), {}, base),
      edit(parseTakeoffEditInput({ kind: "sheet_scale", target: "sample-plan.pdf", payload: { units_per_px: 0.05, scale_source: "calibrated", scale_confirmed: true } }), {}, base),
    ]);
    expect(JSON.stringify(base)).toBe(before);
    expect(r.issues).toEqual([]);
    expect(r.applied).toHaveLength(4);
    expect(r.takeoff.shapes.find((s) => s.id === moved.id)!.verts_norm).toEqual([[0.5, 0.5]]);
    expect(r.takeoff.shapes.find((s) => s.id === added.id)).toBeTruthy();
    expect(r.takeoff.shapes.find((s) => s.id === data[2]!.id)).toBeUndefined();
    expect(r.takeoff.shapes).toHaveLength(base.shapes.length);
    expect(r.takeoff.sheets[0]).toMatchObject({ sheet_id: "sample-plan.pdf", units_per_px: 0.05, scale_source: "calibrated", scale_confirmed: true });
    expect([...r.editedConditionIds]).toEqual([tag(base, "DATA-1").id]);
  });

  it("keeps the machine original: the agent's ring, actor and method survive a person's reshape", () => {
    const orig = data[0]!;
    expect(orig.origin).toMatchObject({ actor: "agent" });
    // The edit claims the shape was a person's manual trace and drops the frozen ring.
    const reshaped = { ...clone(orig), verts_norm: [[0.3, 0.3]], origin: { method: "manual", actor: "human", edited: true } };
    const r = applyTakeoffEdits(base, [edit(parseTakeoffEditInput({ kind: "shape_put", target: orig.id, payload: { shape: reshaped } }), {}, base)]);
    const out = r.takeoff.shapes.find((s) => s.id === orig.id)!;
    expect(out.verts_norm).toEqual([[0.3, 0.3]]);
    expect(out.origin).toMatchObject({ actor: "agent", method: "manual", edited: true, proposed_verts_norm: orig.verts_norm });
    // An original that already carries a frozen ring keeps that one, never the edit's.
    const frozen = { ...clone(orig), origin: { ...orig.origin, proposed_verts_norm: [[0.9, 0.9]] } };
    const kept = keepMachineOriginal(frozen, { ...reshaped, origin: { ...reshaped.origin, proposed_verts_norm: [[0, 0]] } }, { editorAuth: "cloudflare-access" }, () => undefined);
    expect((kept.origin as Record<string, unknown>).proposed_verts_norm).toEqual([[0.9, 0.9]]);
    // A person's own manual shape is not machine work: no frozen ring is invented.
    const human = { ...clone(orig), origin: { method: "manual" } };
    const k2 = keepMachineOriginal(human, { ...human, verts_norm: [[0.1, 0.1]] }, { editorAuth: "cloudflare-access" }, () => undefined);
    expect(k2.origin).toEqual({ method: "manual" });
  });

  it("only a verified person can mark machine work reviewed", () => {
    const orig = data[0]!;
    const reviewed = { ...clone(orig), origin: { ...orig.origin, reviewed: true } };
    const person = applyTakeoffEdits(base, [edit(parseTakeoffEditInput({ kind: "shape_put", target: orig.id, payload: { shape: reviewed } }), {}, base)]);
    expect((person.takeoff.shapes.find((s) => s.id === orig.id)!.origin as Record<string, unknown>).reviewed).toBe(true);
    const agent = applyTakeoffEdits(base, [edit(parseTakeoffEditInput({ kind: "shape_put", target: orig.id, payload: { shape: reviewed } }), { editorAuth: "brink-merge" }, base)]);
    expect((agent.takeoff.shapes.find((s) => s.id === orig.id)!.origin as Record<string, unknown>).reviewed).toBe(false);
    expect(codes(agent.issues)).toEqual(["takeoff_edit_review_refused"]);
  });

  it("reports, never drops: an orphaned edit and an edit over a changed original are warnings", () => {
    const gone = edit(parseTakeoffEditInput({ kind: "shape_delete", target: "shp-not-there", payload: {} }));
    const lost = { ...clone(data[0]!), id: "shp-on-gone-condition", condition_id: "cnd-gone" };
    const onGone = edit(parseTakeoffEditInput({ kind: "shape_put", target: lost.id, payload: { shape: lost } }));
    const stale = edit(parseTakeoffEditInput({ kind: "shape_put", target: data[0]!.id, payload: { shape: { ...clone(data[0]!), label: "Desk 9" } } }), { targetContext: { baseHash: "0000000000000000" } });
    const r = applyTakeoffEdits(base, [gone, onGone, stale]);
    expect(codes(r.issues).sort()).toEqual(["takeoff_edit_base_changed", "takeoff_edit_orphaned", "takeoff_edit_orphaned"]);
    expect(r.applied).toEqual([stale.id]);
    expect(r.issues.every((i) => i.severity === "warning" && (i.refs as { editId: string }).editId)).toBe(true);
    expect(r.takeoff.shapes.find((s) => s.id === data[0]!.id)!.label).toBe("Desk 9");
  });

  it("the BOM follows the edits: a device added in the app is counted, disclosed as an edit, not an error", () => {
    const plain = merge(input, catalog(), { date: "x" });
    const added: OtShape = { ...clone(data[0]!), id: "shp-added-in-app", verts_norm: [[0.4, 0.4]], origin: { method: "manual" } };
    const r = merge(input, catalog(), { date: "x", takeoffEdits: [edit(parseTakeoffEditInput({ kind: "shape_put", target: added.id, payload: { shape: added } }))] });
    const line = (m: typeof r) => m.bom.lines.find((l) => l.kind === "device" && l.conditionKey === "DATA-1")!;
    expect(line(r).qty).toBe(line(plain).qty + 1);
    expect(codes(r.issues)).toContain("count_edited");
    expect(r.issues.filter((i) => i.severity === "error").map((i) => i.code)).toEqual(plain.issues.filter((i) => i.severity === "error").map((i) => i.code));
    expect(r.takeoffEditsApplied).toHaveLength(1);
    // A route reshaped in the app keeps the report's cable length, and says so.
    const route = shapesOf(input.takeoff, "TRUNK")[0]!;
    const longer = { ...clone(route), computed: { ...route.computed, perimeter_lf: (route.computed?.perimeter_lf ?? 0) + 10 } };
    const r2 = merge(input, catalog(), { date: "x", takeoffEdits: [edit(parseTakeoffEditInput({ kind: "shape_put", target: route.id, payload: { shape: longer } }))] });
    expect(codes(r2.issues)).toContain("route_edited");
    expect(codes(r2.issues)).not.toContain("route_lf_mismatch");
    expect(r2.bom.totals.cableNetLf).toBe(plain.bom.totals.cableNetLf);
  });
});

describe("diffTakeoff", () => {
  const base = load("div27-sample").takeoff;
  it("turns the canvas's saved document into ops, and lists what the layer does not keep", () => {
    const after = clone(base) as OtTakeoff & Record<string, unknown>;
    after.shapes[0]!.verts_norm = [[0.2, 0.2]];
    after.shapes.splice(1, 1);
    after.shapes.push({ ...clone(base.shapes[2]!), id: "shp-new" });
    after.conditions[0]!.waste_pct = 5;
    after.sheets[0]!.units_per_px = 0.04;
    after.markups = [{ id: "mk1" }];
    after.sheet_tabs = ["sample-plan.pdf"]; // view state: never reported
    delete (after as Record<string, unknown>).cable_runs; // a canvas that does not carry a field: not a change
    const d = diffTakeoff(base, after);
    expect(d.ops.map((o) => `${o.kind}:${o.target}`).sort()).toEqual([
      `condition_put:${base.conditions[0]!.id}`, "shape_delete:" + base.shapes[1]!.id, `shape_put:${base.shapes[0]!.id}`, "shape_put:shp-new", "sheet_scale:sample-plan.pdf",
    ].sort());
    expect(d.unsupported).toEqual(["markups"]);
    const removed = clone(base);
    removed.conditions.pop();
    expect(diffTakeoff(base, removed).unsupported).toEqual(["conditions removed: BRANCH"]);
    expect(diffTakeoff(base, clone(base))).toEqual({ ops: [], unsupported: [] });
  });
  it("compares records by value, not key order", () => {
    const a = { b: 1, a: [1, { y: 2, x: 1 }] };
    expect(stableJson(a)).toBe(stableJson({ a: [1, { x: 1, y: 2 }], b: 1 }));
    expect(recordHash(a)).toBe(recordHash(JSON.parse(JSON.stringify(a))));
  });
});

const targets: [string, () => Promise<Db>][] = [["PGlite", () => openPglite()]];
if (process.env.BRINK_TEST_DATABASE_URL) targets.push(["Postgres", () => openPostgres(process.env.BRINK_TEST_DATABASE_URL!)]);

describe.each(targets)("takeoff edit layer on %s", (_name, open) => {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    await migrate(db);
    await seedCatalog(db, catalog());
  });
  afterAll(() => db.close());

  it("creates the two additive tables with RLS on, and nothing else", async () => {
    const t = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('brink_sheets', 'brink_takeoff_edits') order by relname");
    expect(t.rows).toEqual([{ relname: "brink_sheets", relrowsecurity: true }, { relname: "brink_takeoff_edits", relrowsecurity: true }]);
    const pol = await db.query("select * from pg_policies where tablename in ('brink_sheets', 'brink_takeoff_edits')");
    expect(pol.rows).toEqual([]);
    // the kind / target type pairing is enforced by the table, not only the code
    const p = (await db.query<{ id: string }>("insert into brink_projects (name) values ('constraint check') returning id")).rows[0]!;
    await expect(db.query("insert into brink_takeoff_edits (project_id, target_type, target_key, kind, payload, editor_email, editor_auth) values ($1, 'sheet', 'x', 'shape_put', '{}', 'a@b', 'brink-merge')", [p.id])).rejects.toThrow();
    await expect(db.query("insert into brink_sheets (project_id, name, storage_path, byte_size, sha256, uploaded_by, uploaded_auth) values ($1, 'a.pdf', 'p', 0, 'h', 'a@b', 'brink-merge')", [p.id])).rejects.toThrow();
    // one current sheet per (project, name)
    await db.query("insert into brink_sheets (project_id, name, storage_path, byte_size, sha256, uploaded_by, uploaded_auth) values ($1, 'a.pdf', 'p1', 10, 'h1', 'a@b', 'brink-merge')", [p.id]);
    await expect(db.query("insert into brink_sheets (project_id, name, storage_path, byte_size, sha256, uploaded_by, uploaded_auth) values ($1, 'a.pdf', 'p2', 10, 'h2', 'a@b', 'brink-merge')", [p.id])).rejects.toThrow();
  });

  it("re-runs the import with the edits: the stored takeoff stays the export, the BOM moves, a re-import re-applies them", async () => {
    const input = load("div27-sample");
    const first = await saveMerge(db, input, merge(input, await loadCatalog(db), { date: "x" }));
    const devLine = async (importId: string) => (await loadBomLines(db, importId)).find((l) => l.kind === "device" && l.conditionKey === "DATA-1")!.qty;
    const before = await devLine(first.importId);
    const victim = shapesOf(input.takeoff, "DATA-1")[0]!;
    const saved = await recordTakeoffEdit(db, { projectId: first.projectId, input: { kind: "shape_delete", target: victim.id, payload: {} }, editorEmail: "alex@brink.test", editorAuth: "cloudflare-access", baseImportId: first.importId });
    expect(saved.targetContext).toMatchObject({ baseHash: recordHash(victim), measureRole: "count", finishTag: "DATA-1" });
    const edits = await loadActiveTakeoffEdits(db, first.projectId);
    expect(edits.map((e) => e.id)).toEqual([saved.id]);

    // The app's save re-runs the import from the stored raw input.
    const raw = await loadImportInput(db, first.importId);
    const second = await saveMerge(db, raw, merge(raw, await loadCatalog(db), { date: "x", takeoffEdits: edits }));
    expect(await devLine(second.importId)).toBe(before - 1);
    expect((await loadImportInput(db, second.importId)).takeoff).toEqual(input.takeoff);
    expect((await loadImportInput(db, second.importId)).takeoffSha256).toBe(input.takeoffSha256);
    expect(codes(await loadIssues(db, second.importId))).toContain("count_edited");
    const view = await renderTakeoff(db, second.importId);
    expect(view.takeoff.shapes.some((s) => s.id === victim.id)).toBe(false);
    expect(view.base.shapes.some((s) => s.id === victim.id)).toBe(true);

    // A newer edit of the same target supersedes; a revert brings the machine original back.
    const again = await recordTakeoffEdit(db, { projectId: first.projectId, input: { kind: "shape_put", target: victim.id, payload: { shape: { ...victim, label: "Kept" } } }, editorEmail: "sam@brink.test", editorAuth: "cloudflare-access" });
    expect(again.superseded).toBe(saved.id);
    expect((await loadActiveTakeoffEdits(db, first.projectId)).map((e) => e.id)).toEqual([again.id]);
    expect(await revertTakeoffEdit(db, again.id, "alex@brink.test")).toBe(true);
    expect(await revertTakeoffEdit(db, again.id, "alex@brink.test")).toBe(false);
    expect(await loadActiveTakeoffEdits(db, first.projectId)).toEqual([]);
    expect((await currentImport(db, PROJECT))!.importId).toBe(second.importId);
  });
});
