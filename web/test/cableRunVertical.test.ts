// Per-run vertical (docs/design/CABLE_SETUP.md, Decisions — "Recorded while
// building item 4"): a run may state its own vertical_override, which
// replaces the condition's vertical_ft for that location only, the
// cables_override precedent. Exact values, the access_door withhold rule,
// the load gate, the document round trip, old documents unchanged, and the
// "override" command with its exact inverse. Fixtures are invented.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintCableSetup, mintCableRun, mintCableHold, sanitizeCableRuns, resolveCableRuns, computeCableTakeoff,
  cableTables, cableRunRows, cableReportBlock, linkRunRefusal, applyCableRunCommand, runVerticalOverride,
} from "../src/lib/cable.js";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";

// ── fixture (the worked-example shapes of web/test/cable.test.ts) ────────────
const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, sheet = "a.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number, sheet = "a.pdf") => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });

const WALL = cond("c-wall", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) });
const DOOR = cond("c-door", "ACS-1", { waste_pct: 12, cable_setup: mintCableSetup("access_door", { cable_type: "CAT6" }) });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
const CONDS = [WALL, DOOR, TR, ROUTE];
const SHAPES = [
  count("tr-mdf", "c-tr", "a.pdf", { label: "MDF" }),
  count("dev-w1", "c-wall"), count("dev-w2", "c-wall"),
  count("dev-d1", "c-door"), count("dev-d2", "c-door"),
  line("rt-w1", "c-route", 87.5), line("rt-w2", "c-route", 87.5), line("rt-d1", "c-route", 60), line("rt-d2", "c-route", 60),
];
const run = (id: string, dev: string, rt: string, extra: any = {}) => ({ ...mintCableRun({ device_shape_ids: [dev], route_shape_ids: [rt], tr_id: "tr-mdf", ...extra }), id });
const byId = (t: any, id: string) => t.resolved.runs.find((r: any) => r.id === id);

test("wall outlet at 23 ft, one run overridden to 9 ft: per cable 87.5 + 9 + 10 + 10 = 116.5, ×2 = 233, order 260.96 at 12%", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, [run("run-w", "dev-w1", "rt-w1", { vertical_override: 9 })])!;
  const r = byId(t, "run-w");
  assert.deepEqual(
    { status: r.status, vertical: r.vertical_ft, override: r.vertical_override, per: r.per_cable_lf, cables: r.cables, loc: r.location_lf },
    { status: "linked", vertical: 9, override: 9, per: 116.5, cables: 2, loc: 233 },
  );
  assert.deepEqual(r.notes, ["vertical 9 ft (run override; condition 23 ft)"]);
  const row = t.summary.rows.find((x: any) => x.finish_tag === "DATA-1");
  assert.deepEqual({ pulls: row.pulls, cables: row.cables, net: row.cable_lf, order: row.cable_lf_order }, { pulls: 1, cables: 2, net: 233, order: 260.96 });
});

test("only the overridden run changes: a sibling run on the same condition keeps the condition's 23 ft (the worked example's 130.5)", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, [run("run-w", "dev-w1", "rt-w1", { vertical_override: 9 }), run("run-w2", "dev-w2", "rt-w2")])!;
  const plain = byId(t, "run-w2");
  assert.deepEqual({ vertical: plain.vertical_ft, per: plain.per_cable_lf, loc: plain.location_lf }, { vertical: 23, per: 130.5, loc: 261 });
  assert.equal("vertical_override" in plain, false);
  assert.equal(plain.notes, undefined, "no note on a run that states no vertical");
  const row = t.summary.rows.find((x: any) => x.finish_tag === "DATA-1");
  assert.deepEqual({ pulls: row.pulls, cables: row.cables, net: row.cable_lf, order: row.cable_lf_order }, { pulls: 2, cables: 4, net: 494, order: 553.28 });
});

test("access_door with no vertical: a run without an override stays withheld with the existing reason; a run with override 12 is linked", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, [run("run-d1", "dev-d1", "rt-d1"), run("run-d2", "dev-d2", "rt-d2", { vertical_override: 12 })])!;
  const without = byId(t, "run-d1");
  assert.equal(without.status, "withheld");
  assert.match(without.reason, /^ACS-1: vertical_ft is required — enter the job's vertical \(this device type has no starting value\)$/);
  assert.equal(without.per_cable_lf, null, "no length is assumed");
  assert.equal(without.vertical_ft, null);
  const withV = byId(t, "run-d2");
  assert.deepEqual({ status: withV.status, vertical: withV.vertical_ft, per: withV.per_cable_lf, loc: withV.location_lf }, { status: "linked", vertical: 12, per: 60 + 12 + 15 + 10, loc: 97 });
  assert.deepEqual(withV.notes, ["vertical 12 ft (run override; condition has none)"]);
  const row = t.summary.rows.find((x: any) => x.finish_tag === "ACS-1");
  assert.deepEqual({ ea: row.ea, pulls: row.pulls, unlinked: row.unlinked_devices, withheld: row.withheld_runs, net: row.cable_lf, order: row.cable_lf_order },
    { ea: 2, pulls: 1, unlinked: 1, withheld: 1, net: 97, order: 108.64 });
  assert.deepEqual(t.resolved.unlinked.devices.filter((d: any) => d.finish_tag === "ACS-1").map((d: any) => d.shape_id), ["dev-d1"]);
});

test("every other missing setup value still withholds a run that states its own vertical", () => {
  const bare = cond("c-cust", "CUST-1", { cable_setup: mintCableSetup("custom") });   // custom: no vertical, no loops
  const r = byId(computeCableTakeoff([bare, TR, ROUTE], [...SHAPES, count("dev-x", "c-cust")], [run("run-x", "dev-x", "rt-d1", { vertical_override: 12 })])!, "run-x");
  assert.equal(r.status, "withheld");
  assert.deepEqual(r.reasons, ["CUST-1: loop_device_ft is required", "CUST-1: loop_tr_ft is required"], "the vertical gap is answered; the loops are not");
  assert.equal(r.vertical_ft, 12, "the vertical used is still reported");
  const noCables = cond("c-nc", "NC-1", { cable_setup: { ...mintCableSetup("wall_outlet"), cables_per_location: 0 } });
  assert.equal(byId(computeCableTakeoff([noCables, TR, ROUTE], [...SHAPES, count("dev-n", "c-nc")], [run("run-n", "dev-n", "rt-d1", { vertical_override: 12 })])!, "run-n").status, "withheld");
});

test("override 0 is a stated value, not an absence", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, [run("run-w", "dev-w1", "rt-w1", { vertical_override: 0 }), run("run-d", "dev-d1", "rt-d1", { vertical_override: 0 })])!;
  assert.deepEqual({ v: byId(t, "run-w").vertical_ft, per: byId(t, "run-w").per_cable_lf }, { v: 0, per: 107.5 });
  assert.deepEqual({ status: byId(t, "run-d").status, per: byId(t, "run-d").per_cable_lf }, { status: "linked", per: 85 });
  assert.equal(mintCableRun({ vertical_override: 0 }).vertical_override, 0);
  assert.equal(runVerticalOverride({ vertical_override: 0 }), 0);
});

test("invalid overrides are dropped by mint and by the load gate; valid ones survive in place", () => {
  for (const bad of [-1, Number.NaN, Infinity, "9", null, true]) assert.equal("vertical_override" in mintCableRun({ vertical_override: bad as any }), false, String(bad));
  const ok = { ...run("run-ok", "dev-w1", "rt-w1"), vertical_override: 9.5 };
  const out = sanitizeCableRuns([
    ok,
    { ...run("run-neg", "dev-w2", "rt-w2"), vertical_override: -3 },
    { ...run("run-str", "dev-d1", "rt-d1"), vertical_override: "12" },
    { ...run("run-nan", "dev-d2", "rt-d2"), vertical_override: null },
  ]);
  assert.deepEqual(out.map((r: any) => [r.id, r.vertical_override]), [["run-ok", 9.5], ["run-neg", undefined], ["run-str", undefined], ["run-nan", undefined]]);
  assert.deepEqual(out.slice(1).map((r: any) => "vertical_override" in r), [false, false, false]);
  assert.equal(JSON.stringify(out[0]), JSON.stringify(ok), "a valid record keeps its key order");
  // a dropped override reads the condition's vertical again — never a guess
  assert.equal(byId(computeCableTakeoff(CONDS, SHAPES, out)!, "run-neg").vertical_ft, 23);
  assert.equal(byId(computeCableTakeoff(CONDS, SHAPES, out)!, "run-str").status, "withheld", "access_door with a dropped override is withheld");
});

test("the Cable runs sheet shows the vertical used in its Vertical column and marks the override in Reason / notes; columns stay put", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, [run("run-w", "dev-w1", "rt-w1", { vertical_override: 9 }), run("run-w2", "dev-w2", "rt-w2")])!;
  const tabs = cableTables(t) as any;
  assert.deepEqual(tabs.runs[0], ["Run ID", "Condition", "Device type", "Cable type", "TR", "Device sheet", "Route sheet(s)", "TR sheet", "Route LF", "Vertical ft", "Loop at device ft", "Loop at TR ft", "Per-cable LF", "Cables", "Location LF", "Multiplier", "Status", "Review status", "Reason / notes"]);
  assert.deepEqual(tabs.runs[1], ["run-w", "DATA-1", "wall_outlet", "CAT6A", "MDF", "a.pdf", "a.pdf", "a.pdf", 87.5, 9, 10, 10, 116.5, 2, 233, 1, "linked", "human", "vertical 9 ft (run override; condition 23 ft)"]);
  assert.deepEqual(tabs.runs[2].slice(8, 15).concat(tabs.runs[2][18]), [87.5, 23, 10, 10, 130.5, 2, 261, ""]);
  const rows = cableRunRows(t);
  assert.equal(rows[0].vertical_override, 9);
  assert.equal("vertical_override" in rows[1], false);
  assert.equal(cableReportBlock(t)!.runs[0].notes, "vertical 9 ft (run override; condition 23 ft)");
});

test("linkRunRefusal: a missing condition vertical refuses without an override and accepts with one; a negative override refuses", () => {
  const link = { device_shape_ids: ["dev-d1"], route_shape_ids: ["rt-d1"], tr_id: "tr-mdf" };
  assert.match(linkRunRefusal(link, CONDS, SHAPES)!, /ACS-1: vertical_ft is required[\s\S]*state this run's own vertical[\s\S]*no length is ever assumed/);
  assert.equal(linkRunRefusal({ ...link, vertical_override: 12 }, CONDS, SHAPES), null);
  assert.equal(linkRunRefusal({ ...link, vertical_override: 0 }, CONDS, SHAPES), null);
  assert.match(linkRunRefusal({ ...link, vertical_override: -1 }, CONDS, SHAPES)!, /the run's vertical must be a number of feet, 0 or more/);
  assert.match(linkRunRefusal({ ...link, vertical_override: Number.NaN }, CONDS, SHAPES)!, /the run's vertical must be a number of feet/);
  assert.equal(linkRunRefusal({ ...link, vertical_override: null }, [WALL, { ...DOOR, cable_setup: { ...DOOR.cable_setup, vertical_ft: 18 } }, TR, ROUTE], SHAPES), null, "null = use the condition's");
});

test("document round trip: vertical_override rides cable_runs verbatim through the app's reader and resolves the same", () => {
  const runs = [run("run-w", "dev-w1", "rt-w1", { vertical_override: 9 }), run("run-d", "dev-d2", "rt-d2", { vertical_override: 12, cables_override: 3 })];
  const doc = buildTakeoffDocument({ project_name: "Invented job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: CONDS, shapes: SHAPES, cable_runs: runs, sheet_tabs: ["a.pdf"] });
  const json = JSON.stringify(doc);
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(json), ["a.pdf"]);
  assert.deepEqual(payload.cable_runs, runs);
  const loaded = sanitizeCableRuns(payload.cable_runs);
  assert.deepEqual(loaded.map((r: any) => [r.vertical_override, r.cables_override]), [[9, undefined], [12, 3]]);
  const t = computeCableTakeoff(payload.conditions, payload.shapes, loaded)!;
  assert.deepEqual([byId(t, "run-w").per_cable_lf, byId(t, "run-d").per_cable_lf, byId(t, "run-d").location_lf], [116.5, 97, 291]);
  const again = buildTakeoffDocument({ ...doc, cable_runs: loaded });
  assert.deepEqual(again.cable_runs, runs);
});

test("old documents are unchanged: no override key appears, the loaded records and the runs sheet read exactly as before", () => {
  const old = [run("run-w", "dev-w1", "rt-w1"), run("run-w2", "dev-w2", "rt-w2")];
  const doc = buildTakeoffDocument({ project_name: "Old job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: CONDS, shapes: SHAPES, cable_runs: old, sheet_tabs: ["a.pdf"] });
  const json = JSON.stringify(doc);
  const loaded = sanitizeCableRuns(mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(json), ["a.pdf"]).payload.cable_runs);
  assert.equal(JSON.stringify(buildTakeoffDocument({ ...doc, cable_runs: loaded })), json, "load → export is byte-identical");
  assert.equal(json.includes("vertical_override"), false);
  // an old record with cables_override keeps the load gate's existing placement
  const withCables = { ...run("run-c", "dev-w1", "rt-w1"), cables_override: 3 };
  const { cables_override: _c, ...front } = withCables;
  assert.equal(JSON.stringify(sanitizeCableRuns([withCables])[0]), JSON.stringify({ ...front, cables_override: 3 }));
  const t = computeCableTakeoff(CONDS, SHAPES, loaded)!;
  for (const r of cableRunRows(t)) { assert.equal("vertical_override" in r, false); assert.equal(r.notes, undefined); }
  assert.deepEqual((cableTables(t) as any).runs[1].slice(8, 19), [87.5, 23, 10, 10, 130.5, 2, 261, 1, "linked", "human", ""]);
});

test("the override command sets and clears a run's vertical and cables with an exact inverse; a hold, a bad value or a no-op records nothing", () => {
  const base = [run("run-w", "dev-w1", "rt-w1"), run("run-w2", "dev-w2", "rt-w2", { cables_override: 3 })];
  const before = JSON.stringify(base);
  // set a vertical
  const set = applyCableRunCommand(base, { type: "override", id: "run-w", vertical_override: 9 });
  assert.equal(set.runs[0].vertical_override, 9);
  assert.deepEqual(Object.keys(set.runs[0]), ["id", "device_shape_ids", "route_shape_ids", "tr_id", "vertical_override", "provenance"], "the mint slot");
  assert.equal(byId(computeCableTakeoff(CONDS, SHAPES, set.runs)!, "run-w").per_cable_lf, 116.5);
  assert.deepEqual(set.inverse, { type: "override", id: "run-w", vertical_override: null, key_order: ["id", "device_shape_ids", "route_shape_ids", "tr_id", "provenance"] });
  const undo = applyCableRunCommand(set.runs, set.inverse);
  assert.equal(JSON.stringify(undo.runs), before, "undo restores the record byte for byte");
  // redo through the inverse's inverse
  const redo = applyCableRunCommand(undo.runs, undo.inverse);
  assert.equal(JSON.stringify(redo.runs), JSON.stringify(set.runs));
  // change both on a run that already carries cables_override; clear cables, set vertical 0
  const both = applyCableRunCommand(base, { type: "override", id: "run-w2", vertical_override: 0, cables_override: null });
  assert.deepEqual([both.runs[1].vertical_override, "cables_override" in both.runs[1]], [0, false]);
  assert.deepEqual({ v: both.inverse.vertical_override, c: both.inverse.cables_override }, { v: null, c: 3 });
  assert.equal(JSON.stringify(applyCableRunCommand(both.runs, both.inverse).runs), before);
  // a sanitized record (cables_override after provenance) also comes back in its own order
  const loaded = sanitizeCableRuns(base);
  const cleared = applyCableRunCommand(loaded, { type: "override", id: "run-w2", cables_override: null });
  assert.equal(JSON.stringify(applyCableRunCommand(cleared.runs, cleared.inverse).runs), JSON.stringify(loaded));
  // nothing to record
  const hold = { ...mintCableHold({ device_shape_ids: ["dev-d1"], reason: "by others" }), id: "hold-1" };
  for (const cmd of [
    { type: "override", id: "nope", vertical_override: 9 },
    { type: "override", id: "hold-1", vertical_override: 9 },
    { type: "override", id: "run-w", vertical_override: -1 },
    { type: "override", id: "run-w", cables_override: 0 },
    { type: "override", id: "run-w", cables_override: 2.5 },
    { type: "override", id: "run-w", vertical_override: 9, cables_override: 0 },
    { type: "override", id: "run-w" },
    { type: "override", id: "run-w", vertical_override: null },
    { type: "override", id: "run-w2", cables_override: 3 },
  ]) {
    const r = applyCableRunCommand([...base, hold], cmd);
    assert.equal(r.inverse, null, JSON.stringify(cmd));
    assert.equal(JSON.stringify(r.runs), JSON.stringify([...base, hold]));
  }
});

test("a withheld run (its condition's vertical cleared after linking) is released by giving the run its own vertical", () => {
  const cleared = { ...WALL, cable_setup: { ...WALL.cable_setup, vertical_ft: null } };
  const runs = [run("run-w", "dev-w1", "rt-w1")];
  assert.equal(byId(computeCableTakeoff([cleared, DOOR, TR, ROUTE], SHAPES, runs)!, "run-w").status, "withheld");
  const { runs: next } = applyCableRunCommand(runs, { type: "override", id: "run-w", vertical_override: 9 });
  const r = byId(computeCableTakeoff([cleared, DOOR, TR, ROUTE], SHAPES, next)!, "run-w");
  assert.deepEqual({ status: r.status, per: r.per_cable_lf, notes: r.notes }, { status: "linked", per: 116.5, notes: ["vertical 9 ft (run override; condition has none)"] });
  assert.equal(resolveCableRuns([cleared, DOOR, TR, ROUTE], SHAPES, next).runs[0].location_lf, 233);
});
