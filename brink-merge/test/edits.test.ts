// The schematic edit layer (src/edits.ts, docs/schematic-edits.md): edits
// keyed by stable ids survive a re-import; an edit whose target left the
// takeoff becomes a warning issue on the new import, never dropped and never
// re-aimed.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { migrate, openPglite, openPostgres, type Db } from "../src/db/db.js";
import {
  currentImport, loadActiveEdits, loadBomLines, loadCatalog, loadIssues, recordEdit, renderEdited, renderSchematic, revertEdit, saveMerge, seedCatalog,
} from "../src/db/repository.js";
import { applyEdits, parseEditInput, targetContext, type EditInput, type SchematicEdit } from "../src/edits.js";
import { connectKey, connEdgeId, roomNodeId } from "../src/ids.js";
import { merge } from "../src/pipeline.js";
import { validateSchematic } from "../src/validate.js";
import type { DeviceData, SchematicFile, SchematicNode } from "../src/vendor/esTypes.js";
import { catalog, clone, fixture, load, MAP_PATH, withoutDevice } from "./helpers.js";

const PROJECT = "Brink Div 27 sample (invented)";
const devices = (f: SchematicFile) => f.nodes.filter((n) => n.type === "device");
const node = (f: SchematicFile, id: string) => f.nodes.find((n) => n.id === id)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const brinkOf = (n: SchematicNode): Record<string, any> => (n.data as unknown as { brink: Record<string, unknown> }).brink;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

let seq = 0;
const edit = (input: EditInput | string, extra: Partial<SchematicEdit> = {}): SchematicEdit => {
  if (typeof input === "string") throw new Error(input);
  return { id: `e${++seq}`, targetKey: input.target, kind: input.kind, payload: input.payload, editorEmail: "alex@brink.test", createdAt: `2026-10-27T10:00:${String(seq).padStart(2, "0")}Z`, ...extra };
};

describe("stable ids", () => {
  it("node and edge ids come from OpenTakeoff's shape and run ids, not from order", () => {
    const input = load("div27-sample");
    const a = merge(input, catalog(), { date: "x" }).schematic.file;
    for (const d of devices(a)) expect(d.id).toBe(brinkOf(d).tr ? `tr-${brinkOf(d).shapeId}` : `dev-${brinkOf(d).shapeId}-${brinkOf(d).copy}`);
    for (const e of a.edges) expect(e.id).toMatch(new RegExp(`^cable-${(e.data!.brink as { runId: string }).runId}-\\d+-\\d+$`));
    for (const r of a.nodes.filter((n) => n.type === "room")) expect(r.id).toBe(roomNodeId(String(r.data.label)));
    expect(validateSchematic(a)).toEqual([]);

    // The same takeoff with its shapes and runs in another order: the same ids.
    const shuffled = clone(input);
    shuffled.takeoff.shapes.reverse();
    shuffled.takeoff.cable_runs!.reverse();
    const b = merge(shuffled, catalog(), { date: "x" }).schematic.file;
    expect(new Set(b.nodes.map((n) => n.id))).toEqual(new Set(a.nodes.map((n) => n.id)));
    expect(new Set(b.edges.map((e) => e.id))).toEqual(new Set(a.edges.map((e) => e.id)));
  });
});

describe("applyEdits", () => {
  const file = merge(load("div27-sample"), catalog(), { date: "x" }).schematic.file;
  const dev = devices(file).find((d) => !brinkOf(d).tr && file.edges.some((e) => e.source === d.id))!;
  const rooms = file.nodes.filter((n) => n.type === "room");
  const otherRoom = rooms.find((r) => r.id !== dev.parentId)!;

  it("applies rename, room change + move, disconnect and connect exactly, without touching the input", () => {
    const before = JSON.stringify(file);
    const cable = file.edges.find((e) => e.source === dev.id)!;
    const panel = node(file, cable.target);
    const spare = devices(file).find((d) => !brinkOf(d).tr && !file.edges.some((e) => e.source === d.id))!;
    const r = applyEdits(file, [
      edit(parseEditInput({ kind: "rename", target: dev.id, payload: { label: "Desk 4" } })),
      edit(parseEditInput({ kind: "room_assign", target: dev.id, payload: { room: otherRoom.id } })),
      edit(parseEditInput({ kind: "move", target: dev.id, payload: { x: 48, y: 96, parent: otherRoom.id } })),
      edit(parseEditInput({ kind: "disconnect", target: cable.id, payload: {} })),
      // the freed panel port takes a cable from a device that had none
      edit(parseEditInput({ kind: "connect", payload: { source: spare.id, sourceHandle: "p1-rear", target: panel.id, targetHandle: cable.targetHandle, signalType: "ethernet", label: "CAT6A CMP" } })),
    ]);
    expect(r.issues).toEqual([]);
    expect(r.applied).toHaveLength(5);
    const moved = node(r.file, dev.id);
    expect(moved.data.label).toBe("Desk 4");
    expect(moved.parentId).toBe(otherRoom.id);
    expect(moved.position).toEqual({ x: 48, y: 96 });
    expect(r.file.edges.find((e) => e.id === cable.id)).toBeUndefined();
    const added = r.file.edges.find((e) => e.id === connEdgeId(connectKey(spare.id, "p1-rear", panel.id, cable.targetHandle)))!;
    expect(added).toMatchObject({ source: spare.id, target: panel.id, targetHandle: cable.targetHandle, data: { signalType: "ethernet", label: "CAT6A CMP", brink: { source: "edit" } } });
    expect(validateSchematic(r.file)).toEqual([]);
    expect(JSON.stringify(file)).toBe(before);
  });

  it("an edit whose target is gone is an orphan issue; one that no longer fits is a conflict; neither is applied", () => {
    const cable = file.edges.find((e) => e.source === dev.id)!;
    const busyPanelPort = file.edges.find((e) => e.id !== cable.id)!;
    const r = applyEdits(file, [
      edit(parseEditInput({ kind: "rename", target: "dev-shp-gone-1", payload: { label: "x" } }), { targetContext: { label: "DATA-1-9", conditionKey: "DATA-1" } }),
      edit(parseEditInput({ kind: "room_assign", target: dev.id, payload: { room: "room-gone-00000000" } })),
      // made inside a room the device is not in (its room change above is orphaned)
      edit(parseEditInput({ kind: "move", target: dev.id, payload: { x: 1, y: 2, parent: "room-gone-00000000" } })),
      edit(parseEditInput({ kind: "disconnect", target: "cable-run-gone-1-1", payload: {} })),
      edit(parseEditInput({ kind: "connect", payload: { source: dev.id, sourceHandle: "p9-rear", target: busyPanelPort.target, targetHandle: busyPanelPort.targetHandle, signalType: "ethernet" } })),
      edit(parseEditInput({ kind: "connect", payload: { source: dev.id, sourceHandle: cable.sourceHandle, target: busyPanelPort.target, targetHandle: busyPanelPort.targetHandle, signalType: "ethernet" } })),
    ]);
    expect(r.applied).toEqual([]);
    expect(codes(r.issues)).toEqual(["schematic_edit_orphaned", "schematic_edit_orphaned", "schematic_edit_conflict", "schematic_edit_orphaned", "schematic_edit_orphaned", "schematic_edit_conflict"]);
    expect(r.issues.every((i) => i.severity === "warning")).toBe(true);
    expect(r.issues[0]).toMatchObject({ conditionKey: "DATA-1", refs: { targetKey: "dev-shp-gone-1", kind: "rename", editor: "alex@brink.test" } });
    expect(r.issues[0]!.message).toMatch(/alex@brink\.test.*rename of "DATA-1-9" \(dev-shp-gone-1\) to "x".*not in this import.*kept/);
    expect(JSON.stringify(r.file)).toBe(JSON.stringify(file));
  });

  it("validates input shapes", () => {
    expect(parseEditInput({ kind: "move", target: "a", payload: { x: Number.NaN, y: 1, parent: null } })).toMatch(/finite/);
    expect(parseEditInput({ kind: "rename", target: "a", payload: { label: "" } })).toMatch(/label/);
    expect(parseEditInput({ kind: "property", target: "a", payload: {} })).toMatch(/kind must be/);
    expect(parseEditInput({ kind: "drop table", target: "a" })).toMatch(/kind must be/);
    // the issues note has text, not a name
    expect(codes(applyEdits(file, [edit(parseEditInput({ kind: "rename", target: "note-brink", payload: { label: "x" } }))]).issues)).toEqual(["schematic_edit_conflict"]);
    expect(parseEditInput({ kind: "connect", payload: { source: "a", target: "a", sourceHandle: null, targetHandle: null, signalType: "ethernet" } })).toMatch(/two different/);
    expect(parseEditInput({ kind: "move", target: "a", payload: { x: 1, y: 2, parent: null, evil: true } })).toEqual({ kind: "move", target: "a", payload: { x: 1, y: 2, parent: null } });
    const ctx = targetContext(file, parseEditInput({ kind: "rename", target: dev.id, payload: { label: "x" } }) as EditInput);
    expect(ctx).toMatchObject({ label: dev.data.label, nodeType: "device", conditionKey: brinkOf(dev).conditionKey });
  });
});

// PGlite always; a real Postgres / local Supabase too when BRINK_TEST_DATABASE_URL is set. db.test.ts
// needs that database empty, so this suite creates (and drops) a sibling database on the same server.
async function siblingPostgres(): Promise<Db> {
  const admin = await openPostgres(process.env.BRINK_TEST_DATABASE_URL!);
  const name = `brink_edits_test_${process.pid}_${Date.now()}`;
  await admin.exec(`create database ${name}`);
  const url = new URL(process.env.BRINK_TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = await openPostgres(url.toString());
  return {
    ...db,
    close: async () => {
      await db.close();
      await admin.exec(`drop database if exists ${name}`);
      await admin.close();
    },
  };
}
const targets: [string, () => Promise<Db>][] = [["PGlite", () => openPglite()]];
if (process.env.BRINK_TEST_DATABASE_URL) targets.push(["Postgres", siblingPostgres]);

describe.each(targets)("edits survive re-import (%s, real fixtures)", (_name, open) => {
  let db: Db;
  let projectId: string;
  let file: SchematicFile;
  let renamed: SchematicNode;
  let movedRoom: SchematicNode;
  let removed: SchematicNode;
  let removedCable: string;

  const importPair = async (input = load("div27-sample")) => {
    const edits = (await currentImport(db, PROJECT)) ? await loadActiveEdits(db, (await currentImport(db, PROJECT))!.projectId) : [];
    const result = merge(input, await loadCatalog(db), { date: "2026-10-27", edits });
    return { result, saved: await saveMerge(db, input, result) };
  };

  beforeAll(async () => {
    db = await open();
    await migrate(db);
    await seedCatalog(db, catalog());
    const { saved } = await importPair();
    projectId = saved.projectId;
    file = await renderSchematic(db, saved.importId);
    const devs = devices(file).filter((d) => !brinkOf(d).tr);
    renamed = devs[0]!;
    movedRoom = file.nodes.find((n) => n.type === "room")!;
    // The device the estimator will delete from the takeoff: one with a cable.
    removed = devs.find((d) => d.id !== renamed.id && file.edges.some((e) => e.source === d.id))!;
    removedCable = file.edges.find((e) => e.source === removed.id)!.id;
  });
  afterAll(() => db.close());

  const rec = (input: EditInput | string, email = "alex@brink.test") => {
    if (typeof input === "string") throw new Error(input);
    return recordEdit(db, { projectId, input, editorEmail: email, context: targetContext(file, input) });
  };

  it("an edit made on import A is present after re-import B", async () => {
    const a = (await currentImport(db, PROJECT))!;
    await rec(parseEditInput({ kind: "rename", target: renamed.id, payload: { label: "Reception desk" } }));
    await rec(parseEditInput({ kind: "move", target: movedRoom.id, payload: { x: 2000, y: 1600, parent: null, width: 1400, height: 900 } }));
    await rec(parseEditInput({ kind: "rename", target: removed.id, payload: { label: "Kiosk drop" } }), "sam@brink.test");
    await rec(parseEditInput({ kind: "disconnect", target: removedCable, payload: {} }), "sam@brink.test");
    // a second rename supersedes the first: one active edit per (target, kind)
    const second = await rec(parseEditInput({ kind: "rename", target: renamed.id, payload: { label: "Front desk" } }));
    expect(second.superseded).not.toBeNull();
    expect(await loadActiveEdits(db, projectId)).toHaveLength(4);

    // the rows stay as generated; the render carries the edits
    expect((await renderSchematic(db, a.importId, { edits: false })).nodes.find((n) => n.id === renamed.id)!.data.label).toBe(renamed.data.label);
    const onA = await renderEdited(db, a.importId);
    expect(onA.issues).toEqual([]);
    expect(node(onA.file, renamed.id).data.label).toBe("Front desk");

    // Re-import B: a new import row, generated afresh, edits re-applied.
    const { result, saved: b } = await importPair();
    expect(b.importId).not.toBe(a.importId);
    expect(result.editsApplied).toHaveLength(4);
    expect(codes(result.issues)).not.toContain("schematic_edit_orphaned");
    const onB = await renderSchematic(db, b.importId);
    expect(node(onB, renamed.id).data.label).toBe("Front desk");
    expect(node(onB, movedRoom.id)).toMatchObject({ position: { x: 2000, y: 1600 }, width: 1400, height: 900 });
    expect(node(onB, removed.id).data.label).toBe("Kiosk drop");
    expect(onB.edges.find((e) => e.id === removedCable)).toBeUndefined();
    expect(validateSchematic(onB)).toEqual([]);
    expect(codes(await loadIssues(db, b.importId))).not.toContain("schematic_edit_orphaned");
  });

  it("an edit whose device was deleted from the takeoff becomes an issue on the new import", async () => {
    const shapeId = brinkOf(removed).shapeId as string;
    const { result, saved: c } = await importPair(withoutDevice(load("div27-sample"), shapeId));
    expect(c.errors).toBe(0);
    const issues = (await loadIssues(db, c.importId)).filter((i) => i.code === "schematic_edit_orphaned");
    // the rename of the deleted device and the removal of its cable: both reported, with who made them
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.refs!.kind).sort()).toEqual(["disconnect", "rename"]);
    expect(issues.every((i) => i.severity === "warning" && i.refs!.editor === "sam@brink.test")).toBe(true);
    expect(issues.find((i) => i.refs!.kind === "rename")!.message).toContain('"Kiosk drop"');
    // the BOM carries them as issue lines too, and the import's counters include them
    expect((await loadBomLines(db, c.importId)).filter((l) => l.kind === "issue" && l.code === "schematic_edit_orphaned")).toHaveLength(2);
    expect(c.warnings).toBe(result.issues.filter((i) => i.severity === "warning").length);
    // never re-aimed: no other node took the label, and the other edits still apply
    const onC = await renderSchematic(db, c.importId);
    expect(onC.nodes.find((n) => n.id === removed.id)).toBeUndefined();
    expect(onC.nodes.filter((n) => n.data.label === "Kiosk drop")).toEqual([]);
    expect(node(onC, renamed.id).data.label).toBe("Front desk");
    // never dropped: the edits stay active, and apply again when the device comes back
    expect(await loadActiveEdits(db, projectId)).toHaveLength(4);
    const { saved: d } = await importPair();
    expect((await loadIssues(db, d.importId)).filter((i) => i.code === "schematic_edit_orphaned")).toEqual([]);
    expect(node(await renderSchematic(db, d.importId), removed.id).data.label).toBe("Kiosk drop");
  });

  it("a reverted edit no longer applies", async () => {
    const active = await loadActiveEdits(db, projectId);
    const rename = active.find((e) => e.targetKey === removed.id && e.kind === "rename")!;
    expect(await revertEdit(db, rename.id, "alex@brink.test")).toBe(true);
    expect(await revertEdit(db, rename.id, "alex@brink.test")).toBe(false);
    const cur = (await currentImport(db, PROJECT))!;
    expect(node(await renderSchematic(db, cur.importId), removed.id).data.label).toBe(removed.data.label);
  });
});

describe("CLI --db re-applies the edit layer", () => {
  it("writes the edited schematic and reports orphans", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "brink-edits-cli-"));
    const pglite = join(dir, "pg");
    const args = (takeoff: string, report: string) => [takeoff, "--report", report, "--map", MAP_PATH, "--out", join(dir, "s.json"), "--bom", join(dir, "b.csv"), "--db"];
    process.env.BRINK_PGLITE_DIR = pglite;
    try {
      expect(await main(args(fixture("div27-sample.takeoff.json"), fixture("div27-sample.report.json")))).toBe(0);
      const first = JSON.parse(readFileSync(join(dir, "s.json"), "utf8")) as SchematicFile;
      const dev = devices(first).find((d) => !brinkOf(d).tr)!;
      const db = await openPglite(pglite);
      const cur = (await currentImport(db, PROJECT))!;
      await recordEdit(db, { projectId: cur.projectId, input: parseEditInput({ kind: "rename", target: dev.id, payload: { label: "Edited in the app" } }) as EditInput, editorEmail: "alex@brink.test" });
      await db.close();

      expect(await main(args(fixture("div27-sample.takeoff.json"), fixture("div27-sample.report.json")))).toBe(0);
      expect(node(JSON.parse(readFileSync(join(dir, "s.json"), "utf8")), dev.id).data.label).toBe("Edited in the app");

      const gone = withoutDevice(load("div27-sample"), brinkOf(dev).shapeId);
      writeFileSync(join(dir, "t.json"), JSON.stringify(gone.takeoff));
      writeFileSync(join(dir, "r.json"), JSON.stringify(gone.report));
      expect(await main(args(join(dir, "t.json"), join(dir, "r.json")))).toBe(0);
      const out = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join("\n");
      expect(out).toMatch(/warning \[schematic_edit_orphaned\] Schematic edit \(alex@brink\.test/);
      expect(out).toMatch(/schematic edits: 0 of 1 re-applied/);
    } finally {
      delete process.env.BRINK_PGLITE_DIR;
      vi.restoreAllMocks();
    }
  });
});

// keep the DeviceData import meaningful for readers: ports are what connect edits land on
export type { DeviceData };
