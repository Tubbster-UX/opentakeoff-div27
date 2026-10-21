// Division 27 cable setup (lib/cable.js) — the spec's worked examples as
// exact-value tests, plus every listed edge case: a route split across two
// sheets at different scales, a recalibration that changes one segment, an
// unlinked device and route (excluded and listed), an access-control door
// with no vertical (withheld, reason stated), a broken run after a delete,
// the ×N and waste conventions, the load gate, and the document round trip.
// Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_TYPES, CABLE_DEFAULTS, mintCableSetup, hasCableSetup, isTrCondition, isRouteCondition, CONDITION_ROLES, cableSetupProblems,
  mintCableRun, sanitizeCableRuns, routeLengthFt, resolveCableRuns, cableSummary, computeCableTakeoff,
  cableReportBlock, cableTables, cableRunRows, linkRunRefusal, cableByCondition,
} from "../src/lib/cable.js";
import { computeShapeMetrics, recalibrateShapes } from "../src/lib/shapeMetrics.js";
import { buildTakeoffDocument, TAKEOFF_DOCUMENT_KEYS } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";
import { conditionTotals, reportJson, totalsToCsv } from "../src/lib/totals.js";
import { reportWorkbook } from "../src/lib/xlsx.js";
import { CSV_PROFILE } from "../src/lib/reportColumns.js";

// ── fixture ─────────────────────────────────────────────────────────────────
const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, sheet = "a.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
// a linear shape whose stored plan length is `lf` feet
const line = (id: string, condId: string, lf: number, sheet = "a.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf }, ...extra });

const WALL = cond("c-wall", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) });
const CAM = cond("c-cam", "CAM-1", { waste_pct: 12, cable_setup: mintCableSetup("camera", { cable_type: "CAT6" }) });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
const BASE_CONDS = [WALL, CAM, TR, ROUTE];
const BASE_SHAPES = [
  count("tr-mdf", "c-tr", "a.pdf", { label: "MDF" }),
  count("dev-w1", "c-wall"), count("dev-c1", "c-cam"),
  line("rt-w1", "c-route", 87.5), line("rt-c1", "c-route", 140),
];
const RUN_W = { ...mintCableRun({ device_shape_ids: ["dev-w1"], route_shape_ids: ["rt-w1"], tr_id: "tr-mdf" }), id: "run-w" };
const RUN_C = { ...mintCableRun({ device_shape_ids: ["dev-c1"], route_shape_ids: ["rt-c1"], tr_id: "tr-mdf" }), id: "run-c" };
const BASE_RUNS = [RUN_W, RUN_C];
const linked = (res: any, id: string) => res.runs.find((r: any) => r.id === id);

test("device types and starting values match the spec's table; access_door has no vertical", () => {
  assert.deepEqual([...DEVICE_TYPES], ["wall_outlet", "wap", "camera", "access_door", "ceiling_other", "custom"]);
  assert.deepEqual(CABLE_DEFAULTS.wall_outlet, { vertical_ft: 23, loop_device_ft: 10, loop_tr_ft: 10, waste_pct: 12 });
  assert.deepEqual(CABLE_DEFAULTS.wap, { vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10, waste_pct: 12 });
  assert.deepEqual(CABLE_DEFAULTS.camera, { vertical_ft: 13, loop_device_ft: 15, loop_tr_ft: 10, waste_pct: 12 });
  assert.deepEqual(CABLE_DEFAULTS.access_door, { vertical_ft: null, loop_device_ft: 15, loop_tr_ft: 10, waste_pct: 12 });
  assert.deepEqual(CABLE_DEFAULTS.ceiling_other, { vertical_ft: 13, loop_device_ft: 10, loop_tr_ft: 10, waste_pct: 12 });
  const s = mintCableSetup("wap");
  assert.deepEqual(s, { device_type: "wap", cables_per_location: 1, cable_type: "", vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10 });
  assert.equal(mintCableSetup("nonsense").device_type, "custom", "unknown type falls back to custom, never throws");
  assert.equal(mintCableSetup("camera", { device_type: "wap" }).device_type, "camera", "the type argument wins over a patch");
  assert.ok(!("price" in s) && !("labor" in s), "quantities only — no dollars");
});

test("opt-in is cable_setup presence; corrupt setups read as opted out; role 'tr' flags a TR condition", () => {
  assert.equal(hasCableSetup(WALL), true);
  assert.equal(hasCableSetup(cond("x", "X")), false);
  assert.equal(hasCableSetup(cond("x", "X", { cable_setup: "corrupt" })), false);
  assert.equal(hasCableSetup(cond("x", "X", { cable_setup: ["x"] })), false);
  assert.equal(hasCableSetup(cond("x", "X", { cable_setup: { vertical_ft: 3 } })), false, "no device type = no setup");
  assert.equal(isTrCondition(TR), true);
  assert.equal(isTrCondition(WALL), false);
  assert.equal(isRouteCondition(ROUTE), true);
  assert.equal(isRouteCondition(TR), false);
  assert.deepEqual([...CONDITION_ROLES], ["tr", "route"]);
});

test("cableSetupProblems names every missing required value; a complete setup has none", () => {
  assert.deepEqual(cableSetupProblems(mintCableSetup("wall_outlet")), []);
  const door = cableSetupProblems(mintCableSetup("access_door"));
  assert.equal(door.length, 1);
  assert.match(door[0], /vertical_ft is required/);
  assert.ok(cableSetupProblems(mintCableSetup("custom")).length >= 3, "custom starts blank");
  assert.match(cableSetupProblems({ ...mintCableSetup("wap"), cables_per_location: 0 })[0], /cables_per_location/);
  assert.match(cableSetupProblems({ ...mintCableSetup("wap"), cables_per_location: 1.5 })[0], /cables_per_location/);
  assert.match(cableSetupProblems({ ...mintCableSetup("wap"), loop_tr_ft: -1 })[0], /loop_tr_ft/);
  assert.deepEqual(cableSetupProblems(null), ["no cable setup"]);
});

test("worked example: wall outlet 87.5 route → 130.5 per cable, 2 cables → 261.0, order 292.32 at 12%", () => {
  const res = resolveCableRuns(BASE_CONDS, BASE_SHAPES, BASE_RUNS);
  const w = linked(res, "run-w");
  assert.equal(w.status, "linked");
  assert.deepEqual(
    { route: w.route_lf, vertical: w.vertical_ft, loops: [w.loop_device_ft, w.loop_tr_ft], per: w.per_cable_lf, cables: w.cables, loc: w.location_lf },
    { route: 87.5, vertical: 23, loops: [10, 10], per: 130.5, cables: 2, loc: 261 },
  );
  assert.equal(w.tr_name, "MDF", "the TR name is the marker's label");
  const sum = cableSummary(res, BASE_CONDS, BASE_SHAPES);
  const row = sum.rows.find((r: any) => r.finish_tag === "DATA-1");
  assert.deepEqual(
    { pulls: row.pulls, cables: row.cables, route: row.route_lf, net: row.cable_lf, order: row.cable_lf_order, ea: row.ea, unlinked: row.unlinked_devices },
    { pulls: 1, cables: 2, route: 87.5, net: 261, order: 292.32, ea: 1, unlinked: 0 },
  );
});

test("worked example: camera 140.0 route → 178.0 per cable, 1 cable → 178.0, order 199.36", () => {
  const res = resolveCableRuns(BASE_CONDS, BASE_SHAPES, BASE_RUNS);
  const c = linked(res, "run-c");
  assert.deepEqual({ per: c.per_cable_lf, cables: c.cables, loc: c.location_lf }, { per: 178, cables: 1, loc: 178 });
  const row = cableSummary(res, BASE_CONDS, BASE_SHAPES).rows.find((r: any) => r.finish_tag === "CAM-1");
  assert.deepEqual({ net: row.cable_lf, order: row.cable_lf_order }, { net: 178, order: 199.36 });
});

test("worked example totals: 2 pulls, 3 cables, 439.0 net, 491.68 order; subtotaled by TR and by cable type", () => {
  const sum = cableSummary(resolveCableRuns(BASE_CONDS, BASE_SHAPES, BASE_RUNS), BASE_CONDS, BASE_SHAPES);
  assert.deepEqual(
    { pulls: sum.totals.pulls, cables: sum.totals.cables, net: sum.totals.cable_lf, order: sum.totals.cable_lf_order, pending: sum.totals.pending_runs },
    { pulls: 2, cables: 3, net: 439, order: 491.68, pending: 0 },
  );
  assert.equal(sum.by_tr.length, 1);
  assert.deepEqual({ tr: sum.by_tr[0].tr_name, net: sum.by_tr[0].cable_lf }, { tr: "MDF", net: 439 });
  assert.deepEqual(sum.by_cable_type.map((g: any) => [g.cable_type, g.cables, g.cable_lf]), [["CAT6A", 2, 261], ["CAT6", 1, 178]]);
  assert.deepEqual(sum.warnings, []);
});

test("waste stays out of the measured number: route_lf and cable_lf never carry it; only cable_lf_order does", () => {
  const conds = [{ ...WALL, waste_pct: 50 }, TR, ROUTE];
  const shapes = [count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"), line("rt-w1", "c-route", 100)];
  const t = computeCableTakeoff(conds, shapes, [RUN_W])!;
  const row = t.summary.rows[0];
  assert.deepEqual({ route: row.route_lf, net: row.cable_lf, order: row.cable_lf_order }, { route: 100, net: 286, order: 429 });
  assert.equal(t.resolved.runs[0].location_lf, 286, "the run itself is never waste-adjusted");
});

test("a route split across two sheets at different scales sums each segment at its own sheet's scale", () => {
  // sheet A: 1000 px wide at 0.05 ft/px; sheet B: 1000 px at 0.1 ft/px. The same
  // normalized trace (0.1 → 0.5 of the width = 400 px) is 20 ft on A and 40 ft on B.
  const dims = { w: 1000, h: 1000 };
  const upp: Record<string, number> = { "a.pdf": 0.05, "b.pdf": 0.1 };
  const segA = { id: "seg-a", sheet_id: "a.pdf", condition_id: "c-route", measure_role: "linear", verts_norm: [[0.1, 0.5], [0.5, 0.5]] } as any;
  const segB = { ...segA, id: "seg-b", sheet_id: "b.pdf" };
  segA.computed = computeShapeMetrics(segA, dims, upp["a.pdf"], ROUTE);
  segB.computed = computeShapeMetrics(segB, dims, upp["b.pdf"], ROUTE);
  assert.deepEqual([segA.computed.perimeter_lf, segB.computed.perimeter_lf], [20, 40]);
  const shapes = [count("tr-mdf", "c-tr", "a.pdf", { label: "IDF-2" }), count("dev-w1", "c-wall", "b.pdf"), segA, segB];
  const run = { ...mintCableRun({ device_shape_ids: ["dev-w1"], route_shape_ids: ["seg-a", "seg-b"], tr_id: "tr-mdf" }), id: "run-2s" };
  const r = resolveCableRuns(BASE_CONDS, shapes, [run], { uppFor: (k) => upp[k] ?? null }).runs[0];
  assert.equal(r.status, "linked");
  assert.equal(r.route_lf, 60);
  assert.deepEqual(r.sheet_ids, ["a.pdf", "b.pdf"]);
  assert.deepEqual(r.segments.map((s: any) => s.length_lf), [20, 40], "segments keep their order");
  assert.equal(r.per_cable_lf, 60 + 23 + 10 + 10);
});

test("recalibrating a sheet changes every run that uses a segment on it — nothing is stored on the run", () => {
  const dims = { w: 1000, h: 1000 };
  const seg = { id: "seg-a", sheet_id: "a.pdf", condition_id: "c-route", measure_role: "linear", verts_norm: [[0.1, 0.5], [0.5, 0.5]] } as any;
  seg.computed = computeShapeMetrics(seg, dims, 0.05, ROUTE);
  const shapes = [count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"), seg];
  const run = { ...mintCableRun({ device_shape_ids: ["dev-w1"], route_shape_ids: ["seg-a"], tr_id: "tr-mdf" }), id: "run-r" };
  const before = resolveCableRuns(BASE_CONDS, shapes, [run]).runs[0];
  assert.equal(before.route_lf, 20);
  const rescaled = recalibrateShapes(shapes, dims, 0.1, BASE_CONDS);   // the operator recalibrates sheet A to twice the scale
  const after = resolveCableRuns(BASE_CONDS, rescaled, [run]).runs[0];
  assert.deepEqual({ route: after.route_lf, per: after.per_cable_lf }, { route: 40, per: 83 });
  assert.ok(!("route_lf" in run) && !("per_cable_lf" in run), "the run record carries no length");
});

test("an unlinked device and an unlinked route are excluded from totals and listed with a reason", () => {
  const shapes = [...BASE_SHAPES, count("dev-w2", "c-wall"), line("rt-stray", "c-route", 55)];
  const t = computeCableTakeoff(BASE_CONDS, shapes, BASE_RUNS)!;
  assert.deepEqual({ pulls: t.summary.totals.pulls, net: t.summary.totals.cable_lf }, { pulls: 2, net: 439 }, "totals unchanged by the strays");
  assert.deepEqual(t.resolved.unlinked.devices.map((d: any) => [d.shape_id, d.reason]), [["dev-w2", "no run links this device"]]);
  assert.deepEqual(t.resolved.unlinked.routes.map((r: any) => [r.shape_id, r.length_lf, r.reason]), [["rt-stray", 55, "no run links this segment"]]);
  const row = t.summary.rows.find((r: any) => r.finish_tag === "DATA-1");
  assert.deepEqual({ ea: row.ea, pulls: row.pulls, unlinked: row.unlinked_devices }, { ea: 2, pulls: 1, unlinked: 1 }, "EA beside pulls shows the gap");
});

test("unlinked routes come only from role 'route' conditions: a route condition with zero linked runs flags every line; base and transition shapes are never flagged", () => {
  const BASE = cond("c-base", "WB-1");   // no role — a base condition
  const TRANS = cond("c-trans", "TRN-1");
  const shapes = [
    count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"),
    line("rt-1", "c-route", 40), line("rt-2", "c-route", 55),
    line("base-1", "c-base", 300),
    { ...line("trn-1", "c-trans", 12), origin: { method: "derived", actor: "canvas", reviewed: false, derived: { between_shape_ids: ["a", "b"], between: ["F-1", "F-2"], case: "butt", gap_in: 0 } } },
  ];
  const none = computeCableTakeoff([WALL, TR, ROUTE, BASE, TRANS], shapes, [])!;
  assert.deepEqual(none.resolved.unlinked.routes.map((r: any) => [r.shape_id, r.finish_tag, r.length_lf, r.reason]), [["rt-1", "ROUTE", 40, "no run links this segment"], ["rt-2", "ROUTE", 55, "no run links this segment"]]);
  // linking one leaves the other; a segment in a broken run names the run
  const run = { ...mintCableRun({ device_shape_ids: ["dev-w1"], route_shape_ids: ["rt-1"], tr_id: "tr-mdf" }), id: "run-1" };
  const one = computeCableTakeoff([WALL, TR, ROUTE, BASE, TRANS], shapes, [run])!;
  assert.deepEqual(one.resolved.unlinked.routes.map((r: any) => r.shape_id), ["rt-2"]);
  const broken = computeCableTakeoff([WALL, TR, ROUTE, BASE, TRANS], shapes.filter((s) => s.id !== "tr-mdf"), [run])!;
  assert.deepEqual(broken.resolved.unlinked.routes.map((r: any) => [r.shape_id, r.reason]), [["rt-1", "its run run-1 is broken: TR marker tr-mdf was deleted"], ["rt-2", "no run links this segment"]]);
  // a line on an unflagged condition is never a route, even when a run links it
  const base = { ...run, id: "run-b", route_shape_ids: ["base-1"] };
  const viaBase = computeCableTakeoff([WALL, TR, ROUTE, BASE, TRANS], shapes, [base])!;
  assert.equal(viaBase.resolved.runs[0].status, "linked", "linking is by shape id, the role only drives the unlinked list");
  assert.deepEqual(viaBase.resolved.unlinked.routes.map((r: any) => r.shape_id), ["rt-1", "rt-2"]);
  // a project whose only cable record is a route condition still figures (so its lines get listed)
  assert.ok(computeCableTakeoff([ROUTE], [line("rt-1", "c-route", 40)], []));
  assert.equal(computeCableTakeoff([BASE, TRANS], shapes, []), null);
});

test("access-control door with no vertical: runs withheld with the stated reason, excluded from totals, condition row still shows EA", () => {
  const DOOR = cond("c-door", "ACS-1", { waste_pct: 12, cable_setup: mintCableSetup("access_door") });
  const conds = [DOOR, TR, ROUTE];
  const shapes = [count("tr-mdf", "c-tr"), count("dev-d1", "c-door"), line("rt-d1", "c-route", 60)];
  const run = { ...mintCableRun({ device_shape_ids: ["dev-d1"], route_shape_ids: ["rt-d1"], tr_id: "tr-mdf" }), id: "run-d" };
  const t = computeCableTakeoff(conds, shapes, [run])!;
  const r = t.resolved.runs[0];
  assert.equal(r.status, "withheld");
  assert.match(r.reason, /ACS-1: vertical_ft is required/);
  assert.equal(r.per_cable_lf, null, "no length is assumed");
  assert.deepEqual({ pulls: t.summary.totals.pulls, net: t.summary.totals.cable_lf }, { pulls: 0, net: 0 });
  const row = t.summary.rows[0];
  assert.deepEqual({ ea: row.ea, pulls: row.pulls, unlinked: row.unlinked_devices, withheld: row.withheld_runs }, { ea: 1, pulls: 0, unlinked: 1, withheld: 1 });
  assert.match(row.withheld, /vertical_ft is required/);
  // entering the vertical makes it count, with no other change
  const fixed = computeCableTakeoff([{ ...DOOR, cable_setup: { ...DOOR.cable_setup, vertical_ft: 18 } }, TR, ROUTE], shapes, [run])!;
  assert.deepEqual({ status: fixed.resolved.runs[0].status, per: fixed.resolved.runs[0].per_cable_lf }, { status: "linked", per: 60 + 18 + 15 + 10 });
});

test("deleting a linked shape marks the run broken and lists it — never drops the run or its length", () => {
  const withoutRoute = BASE_SHAPES.filter((s) => s.id !== "rt-w1");
  const t = computeCableTakeoff(BASE_CONDS, withoutRoute, BASE_RUNS)!;
  const r = linked(t.resolved, "run-w");
  assert.equal(r.status, "broken");
  assert.equal(r.reason, "route shape rt-w1 was deleted");
  assert.equal(t.resolved.runs.length, 2, "the run record is still there");
  assert.deepEqual({ pulls: t.summary.totals.pulls, net: t.summary.totals.cable_lf }, { pulls: 1, net: 178 });
  assert.deepEqual(t.resolved.unlinked.devices.map((d: any) => d.shape_id), ["dev-w1"]);
  assert.match(t.resolved.unlinked.devices[0].reason, /run-w is broken: route shape rt-w1 was deleted/);
  // a deleted TR and a deleted device are reported the same way
  const noTr = computeCableTakeoff(BASE_CONDS, BASE_SHAPES.filter((s) => s.id !== "tr-mdf"), BASE_RUNS)!;
  assert.deepEqual(noTr.resolved.runs.map((r: any) => r.reason), ["TR marker tr-mdf was deleted", "TR marker tr-mdf was deleted"]);
  const noDev = computeCableTakeoff(BASE_CONDS, BASE_SHAPES.filter((s) => s.id !== "dev-c1"), BASE_RUNS)!;
  assert.equal(linked(noDev.resolved, "run-c").reason, "device shape dev-c1 was deleted");
});

test("a segment on a stitched sheet the resolver cannot scale is broken with a stated reason; its stored length is kept, never zeroed", () => {
  const stitch = "stitch:abc123";
  const shapes = [count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"), line("rt-st", "c-route", 72.25, stitch)];
  const t = computeCableTakeoff(BASE_CONDS, shapes, [RUN_W.id ? { ...RUN_W, route_shape_ids: ["rt-st"] } : RUN_W], {
    uppFor: (k: string) => (k === "a.pdf" ? 0.05 : null),   // an MCP session knows only its loaded sheets
    scaleReason: (k: string) => `sheet ${k} is not loaded in this session (stitched surfaces do not round-trip through MCP)`,
  })!;
  const r = t.resolved.runs[0];
  assert.equal(r.status, "broken");
  assert.equal(r.reason, "sheet stitch:abc123 is not loaded in this session (stitched surfaces do not round-trip through MCP)");
  assert.equal(r.route_lf, 72.25, "the stored length still reads on the broken run");
  assert.equal(t.summary.totals.cable_lf, 0, "and it stays out of totals");
  // the canvas, which knows the stitch, links it
  const ok = computeCableTakeoff(BASE_CONDS, shapes, [{ ...RUN_W, route_shape_ids: ["rt-st"] }], { uppFor: () => 0.05 })!;
  assert.deepEqual({ status: ok.resolved.runs[0].status, route: ok.resolved.runs[0].route_lf }, { status: "linked", route: 72.25 });
});

test("a route segment on an unscaled sheet refuses to link (the scale gate) — nothing is estimated", () => {
  const r = resolveCableRuns(BASE_CONDS, BASE_SHAPES, BASE_RUNS, { uppFor: () => null }).runs[0];
  assert.equal(r.status, "broken");
  assert.match(r.reason, /sheet a\.pdf has no scale/);
  assert.equal(linkRunRefusal({ device_shape_ids: ["dev-w1"], route_shape_ids: ["rt-w1"], tr_id: "tr-mdf" }, BASE_CONDS, BASE_SHAPES, [], { uppFor: () => null })?.includes("has no scale"), true);
});

test("route LF is the plan length only: a segment carrying rise/drop legs is read without them and the run and summary warn", () => {
  const LEGGY = cond("c-leggy", "BASE-1", { rise_ft: 8, drop_ft: 2 });
  const dims = { w: 1000, h: 1000 };
  const seg = { id: "seg-l", sheet_id: "a.pdf", condition_id: "c-leggy", measure_role: "linear", verts_norm: [[0.1, 0.5], [0.5, 0.5]] } as any;
  seg.computed = computeShapeMetrics(seg, dims, 0.05, LEGGY);
  assert.deepEqual(seg.computed, { perimeter_lf: 30, area_sf: 0, plan_lf: 20, vertical_lf: 10 }, "#441: perimeter_lf carries the legs");
  assert.equal(routeLengthFt(seg), 20);
  const shapes = [count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"), seg];
  const run = { ...mintCableRun({ device_shape_ids: ["dev-w1"], route_shape_ids: ["seg-l"], tr_id: "tr-mdf" }), id: "run-l" };
  const t = computeCableTakeoff([...BASE_CONDS, LEGGY], shapes, [run])!;
  const r = t.resolved.runs[0];
  assert.deepEqual({ status: r.status, route: r.route_lf, per: r.per_cable_lf, leg: r.leg_warning }, { status: "linked", route: 20, per: 63, leg: true });
  assert.match(r.notes[0], /segment seg-l carries 10 ft of rise\/drop legs — ignored/);
  assert.equal(t.summary.warnings.length, 1);
  assert.match(t.summary.warnings[0], /Condition BASE-1 carries rise\/drop legs: its LF in the regular report includes those legs and is not a cable length/);
  assert.equal(t.summary.rows[0].leg_warning, true);
  // a segment with its own legs (no condition default) warns the same way; a derived run never has legs
  const own = { ...line("seg-o", "c-route", 30), rise_ft: 5, computed: { area_sf: 0, perimeter_lf: 35, plan_lf: 30, vertical_lf: 5 } };
  const t2 = computeCableTakeoff(BASE_CONDS, [count("tr-mdf", "c-tr"), count("dev-w1", "c-wall"), own], [{ ...run, route_shape_ids: ["seg-o"] }])!;
  assert.deepEqual({ route: t2.resolved.runs[0].route_lf, leg: t2.resolved.runs[0].leg_warning }, { route: 30, leg: true });
});

test("cables_override replaces cables_per_location for that location only", () => {
  const runs = [{ ...RUN_W, cables_override: 3 }, RUN_C];
  const t = computeCableTakeoff(BASE_CONDS, BASE_SHAPES, runs)!;
  assert.deepEqual({ cables: linked(t.resolved, "run-w").cables, loc: linked(t.resolved, "run-w").location_lf }, { cables: 3, loc: 391.5 });
  assert.equal(t.summary.totals.cables, 4);
});

test("×N multiplier applies to pulls, cables and cable LF together in the summary; the runs sheet stays unmultiplied with a Multiplier column", () => {
  const conds = [{ ...WALL, multiplier: 3 }, CAM, TR, ROUTE];
  const t = computeCableTakeoff(conds, BASE_SHAPES, BASE_RUNS)!;
  const row = t.summary.rows.find((r: any) => r.finish_tag === "DATA-1");
  assert.deepEqual({ ea: row.ea, pulls: row.pulls, cables: row.cables, route: row.route_lf, net: row.cable_lf, order: row.cable_lf_order }, { ea: 3, pulls: 3, cables: 6, route: 262.5, net: 783, order: 876.96 });
  assert.deepEqual({ pulls: t.summary.totals.pulls, cables: t.summary.totals.cables, net: t.summary.totals.cable_lf }, { pulls: 4, cables: 7, net: 961 });
  const rows = cableRunRows(t);
  const w = rows.find((r: any) => r.run_id === "run-w");
  assert.deepEqual({ per: w.per_cable_lf, loc: w.location_lf, mult: w.multiplier }, { per: 130.5, loc: 261, mult: 3 });
  assert.equal(rows.find((r: any) => r.run_id === "run-c").multiplier, 1);
});

test("pending agent runs count (the engine's rule for pending shapes) and are disclosed: review status per run, Pending runs on the summary", () => {
  const agentRun = { ...RUN_C, provenance: { method: "manual", actor: "agent", reviewed: false, created_at: "2026-10-21T00:00:00.000Z" } };
  const t = computeCableTakeoff(BASE_CONDS, BASE_SHAPES, [RUN_W, agentRun])!;
  assert.deepEqual({ pulls: t.summary.totals.pulls, net: t.summary.totals.cable_lf, pending: t.summary.totals.pending_runs }, { pulls: 2, net: 439, pending: 1 });
  assert.deepEqual(cableRunRows(t).map((r: any) => [r.run_id, r.review_status]), [["run-w", "human"], ["run-c", "pending"]]);
  const accepted = computeCableTakeoff(BASE_CONDS, BASE_SHAPES, [RUN_W, { ...agentRun, provenance: { ...agentRun.provenance, reviewed: true } }])!;
  assert.deepEqual({ pending: accepted.summary.totals.pending_runs, status: cableRunRows(accepted)[1].review_status }, { pending: 0, status: "accepted" });
  // an agent run with no flag at all is pending — absence is never an approval
  const legacy = sanitizeCableRuns([{ ...agentRun, provenance: { method: "manual", actor: "agent" } }]);
  assert.equal(legacy[0].provenance.reviewed, false);
});

test("mintCableRun: a stable locally minted id, provenance with created_at, agent runs land pending", () => {
  const human = mintCableRun({ device_shape_ids: ["d"], route_shape_ids: ["r"], tr_id: "t" });
  assert.match(human.id, /^run-/);
  assert.deepEqual(Object.keys(human), ["id", "device_shape_ids", "route_shape_ids", "tr_id", "provenance"]);
  assert.equal(human.provenance.method, "manual");
  assert.equal("actor" in human.provenance, false);
  assert.ok(human.provenance.created_at);
  const agent = mintCableRun({ device_shape_ids: ["d"], route_shape_ids: ["r"], tr_id: "t", cables_override: 2, provenance: { actor: "agent" } });
  assert.deepEqual({ reviewed: agent.provenance.reviewed, override: agent.cables_override }, { reviewed: false, override: 2 });
  assert.notEqual(human.id, mintCableRun({}).id);
});

test("sanitizeCableRuns is the load gate: malformed records drop, bad overrides drop, duplicate ids drop, missing shapes survive", () => {
  const out = sanitizeCableRuns([
    RUN_W,
    { ...RUN_C, cables_override: 0 },
    { id: "run-x", device_shape_ids: ["gone"], route_shape_ids: ["gone"], tr_id: "gone", provenance: { method: "manual" } },
    { id: "run-w", device_shape_ids: [], route_shape_ids: [] },   // duplicate id
    { id: "", device_shape_ids: [], route_shape_ids: [] },
    { id: "run-y", device_shape_ids: "nope", route_shape_ids: [] },
    "corrupt", null, 7,
  ]);
  assert.deepEqual(out.map((r: any) => r.id), ["run-w", "run-c", "run-x"]);
  assert.equal("cables_override" in out[1], false);
  assert.deepEqual(sanitizeCableRuns("corrupt"), []);
  assert.deepEqual(sanitizeCableRuns(undefined), []);
  const broken = resolveCableRuns(BASE_CONDS, BASE_SHAPES, out).runs.find((r: any) => r.id === "run-x");
  assert.equal(broken.status, "broken");
});

test("linkRunRefusal: each refusal names the problem and the next move; a sound link returns null", () => {
  const ok = { device_shape_ids: ["dev-w1"], route_shape_ids: ["rt-w1"], tr_id: "tr-mdf" };
  assert.equal(linkRunRefusal(ok, BASE_CONDS, BASE_SHAPES), null);
  assert.match(linkRunRefusal({ ...ok, route_shape_ids: ["dev-c1"] }, BASE_CONDS, BASE_SHAPES)!, /dev-c1 is not a measured linear shape \(it is count\) — trace the route with measure_line/);
  assert.match(linkRunRefusal({ ...ok, tr_id: "dev-c1" }, BASE_CONDS, BASE_SHAPES)!, /is not a TR marker .* role "tr"/);
  assert.match(linkRunRefusal({ ...ok, device_shape_ids: ["rt-c1"] }, BASE_CONDS, BASE_SHAPES)!, /rt-c1 is not a count marker/);
  assert.match(linkRunRefusal({ ...ok, route_shape_ids: ["nope"] }, BASE_CONDS, BASE_SHAPES)!, /route shape nope does not exist — list_shapes/);
  assert.match(linkRunRefusal({ ...ok, device_shape_ids: ["tr-mdf"] }, BASE_CONDS, BASE_SHAPES)!, /condition TR has no cable setup — set cable_setup/);
  assert.match(linkRunRefusal(ok, BASE_CONDS, BASE_SHAPES, BASE_RUNS)!, /device dev-w1 is already linked by run run-w — unlink_run it first/);
  assert.match(linkRunRefusal({ ...ok, cables_override: 1.5 }, BASE_CONDS, BASE_SHAPES)!, /cables_override must be a whole number/);
  const DOOR = cond("c-door", "ACS-1", { cable_setup: mintCableSetup("access_door") });
  assert.match(linkRunRefusal({ ...ok, device_shape_ids: ["dev-d1"] }, [...BASE_CONDS, DOOR], [...BASE_SHAPES, count("dev-d1", "c-door")])!, /ACS-1: vertical_ft is required[\s\S]*no length is ever assumed/);
});

test("computeCableTakeoff is null for a project with no cable condition and no runs — nothing figured, nothing exported", () => {
  assert.equal(computeCableTakeoff([TR, cond("c-plain", "VCT-1")], BASE_SHAPES, []), null);
  assert.equal(cableReportBlock(null), null);
  assert.equal(cableTables(null), null);
  assert.deepEqual(cableByCondition(null), new Map());
});

test("the takeoff document carries cable_runs additively: omitted when empty, present in the canonical slot, round trip through the app's reader", () => {
  assert.ok(TAKEOFF_DOCUMENT_KEYS.includes("cable_runs"));
  assert.ok(TAKEOFF_DOCUMENT_KEYS.indexOf("cable_runs") > TAKEOFF_DOCUMENT_KEYS.indexOf("rules"));
  const empty = buildTakeoffDocument({ conditions: BASE_CONDS, shapes: BASE_SHAPES, cable_runs: [] });
  assert.equal("cable_runs" in empty, false, "a project that never linked a run writes no key");
  const doc = buildTakeoffDocument({ project_name: "Invented job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: BASE_CONDS, shapes: BASE_SHAPES, cable_runs: BASE_RUNS, sheet_tabs: ["a.pdf"] });
  assert.deepEqual(doc.cable_runs, BASE_RUNS);
  const parsed = parseTakeoffImport(JSON.stringify(doc));
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parsed, ["a.pdf"]);
  assert.deepEqual(payload.cable_runs, BASE_RUNS, "clean load: the runs land verbatim");
  assert.deepEqual(payload.conditions.find((c: any) => c.id === "c-wall").cable_setup, WALL.cable_setup);
  assert.equal(payload.conditions.find((c: any) => c.id === "c-tr").role, "tr");
  const t = computeCableTakeoff(payload.conditions, payload.shapes, sanitizeCableRuns(payload.cable_runs))!;
  assert.deepEqual({ pulls: t.summary.totals.pulls, net: t.summary.totals.cable_lf }, { pulls: 2, net: 439 });
  // merge into a project that already has work: runs append by id, re-import is idempotent
  const current = { ...payload, shapes: payload.shapes.slice(0, 2), cable_runs: [RUN_W] };
  const merged = mergeTakeoffImport(current, parsed, ["a.pdf"]).payload;
  assert.deepEqual(merged.cable_runs.map((r: any) => r.id), ["run-w", "run-c"]);
  assert.deepEqual(mergeTakeoffImport(merged, parsed, ["a.pdf"]).payload.cable_runs.map((r: any) => r.id), ["run-w", "run-c"]);
});

test("report.v1, CSV and the workbook gain the cable block/sections/tabs only when a cable condition exists", () => {
  const plainConds = [TR, ROUTE, cond("c-vct", "VCT-1")];
  const plainShapes = [count("tr-mdf", "c-tr"), line("rt-w1", "c-route", 87.5)];
  const plainRows = conditionTotals(plainConds, plainShapes).filter((r: any) => r.shape_count > 0);
  const plainJson = reportJson({ rows: plainRows });
  assert.equal("cable" in plainJson, false, "no cable condition → no key (byte-identical to before)");
  assert.equal(totalsToCsv(plainRows).includes("Cable summary"), false);
  assert.deepEqual(reportWorkbook({ rows: plainRows, bySheet: [], shapeRows: [] }).map((s: any) => s.name), ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room"]);

  const t = computeCableTakeoff(BASE_CONDS, BASE_SHAPES, BASE_RUNS)!;
  const rows = conditionTotals(BASE_CONDS, BASE_SHAPES).filter((r: any) => r.shape_count > 0);
  const block = cableReportBlock(t, (id: string) => `Sheet ${id}`);
  const json: any = reportJson({ rows, cable: block });
  assert.equal(Object.keys(json).at(-1), "cable", "appends last");
  assert.deepEqual({ pulls: json.cable.totals.pulls, cables: json.cable.totals.cables, order: json.cable.totals.cable_lf_order }, { pulls: 2, cables: 3, order: 491.68 });
  assert.equal(json.cable.runs.length, 2);
  assert.equal(json.cable.runs[0].sheets, "Sheet a.pdf");
  assert.deepEqual(json.cable.unlinked, { devices: [], routes: [] });
  assert.deepEqual(json.cable.warnings, []);

  const csv = totalsToCsv(rows, "", null, null, null, null, null, "OpenTakeoff", "imperial", t);
  assert.ok(csv.includes("\nCable summary\n"));
  assert.ok(csv.includes("DATA-1,wall_outlet,CAT6A,MDF,1,12,1,1,2,87.5,261,292.32,0,0,"), csv);
  assert.ok(csv.includes("TOTAL,,,,,,2,2,3,227.5,439,491.68,0,0,"), csv);
  assert.ok(csv.includes("\nCable runs\n") && csv.includes("run-w,DATA-1,wall_outlet,CAT6A,MDF,a.pdf,87.5,23,10,10,130.5,2,261,1,linked,human,"), csv);

  const tabs = reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t });
  assert.deepEqual(tabs.map((s: any) => s.name), ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room", "Cable summary", "Cable runs"]);
  const summaryTab = tabs[5].rows;
  assert.deepEqual(summaryTab[0].slice(0, 4), ["Condition", "Device type", "Cable type", "TR"]);
  assert.deepEqual(summaryTab[1].slice(6, 12), [1, 1, 2, 87.5, 261, 292.32], "full-precision cells, no strings");
  const runsTab = tabs[6].rows;
  assert.equal(runsTab[0][13], "Multiplier");
  assert.deepEqual(runsTab[1].slice(6, 14), [87.5, 23, 10, 10, 130.5, 2, 261, 1]);
  // the Conditions tab/CSV gain Pulls / Cables / Cable LF columns through the profile seam
  const colKeys = CSV_PROFILE.map((c: any) => c.key);
  assert.ok(!colKeys.some((k: string) => k.startsWith("cable:")), "the frozen 13 never carry them");
});

test("metric display converts the cable tables' lengths and relabels their headers; imperial is identity", () => {
  const t = computeCableTakeoff(BASE_CONDS, BASE_SHAPES, BASE_RUNS)!;
  const imp = cableTables(t) as any;
  assert.equal(imp.summary[0][9], "Measured route LF");
  const met = cableTables(t, { L: (v: number) => Math.round(v * 0.3048 * 100) / 100, lengthUnit: "m" }) as any;
  assert.equal(met.summary[0][9], "Measured route m");
  assert.equal(met.summary[1][9], 26.67);
  assert.equal(met.runs[0][7], "Vertical m");
  assert.equal(met.runs[1][7], 7.01);
  assert.deepEqual(imp.unlinked[0], [...imp.unlinked[0]]);
});
