// Items 2–5 of the post-Phase 3 list were built in parallel on separate
// branches; this pins them working TOGETHER on one invented takeoff: a run
// with its own vertical over a branch + shared trunk, a hold, a device marker
// clicked twice, and parts counted per cable and per pull. (Item 1, MCP
// auto-save, is covered over the wire in mcp/test/autosave.test.ts.)
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintCableSetup, mintCableRun, mintCableHold, computeCableTakeoff, cableQtyByShape, cableTables } from "../src/lib/cable.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2f7d54", fill: "#2f7d54", hatch: "solid", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, at: [number, number]) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "count", verts_norm: [at], computed: { count: 1 } });
const line = (id: string, condId: string, lf: number, y: number) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, y], [0.4, y]], computed: { area_sf: 0, perimeter_lf: lf } });

const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 4, cable_type: "CAT6A", vertical_ft: 9, loop_device_ft: 3, loop_tr_ft: 26 }) });
const TR = cond("c-tr", "TR", { role: "tr" });
const TRUNK = cond("c-trunk", "TRAY", { role: "route", route_kind: "trunk" });
const BRANCH = cond("c-branch", "BRANCH", { role: "route", route_kind: "branch" });
const CONDS = [DATA, TR, TRUNK, BRANCH];
const SHAPES = [
  count("tr", "c-tr", [0.05, 0.5]),
  count("d1", "c-data", [0.5, 0.2]), count("d1-again", "c-data", [0.5, 0.2]),   // the same outlet clicked twice
  count("d2", "c-data", [0.5, 0.6]), count("d3", "c-data", [0.7, 0.6]),
  line("trunk", "c-trunk", 100, 0.5), line("b1", "c-branch", 40, 0.2), line("b2", "c-branch", 35, 0.6),
];
const RUNS = [
  { ...mintCableRun({ device_shape_ids: ["d1"], route_shape_ids: ["b1", "trunk"], tr_id: "tr" }), id: "run-1", vertical_override: 12 },
  { ...mintCableRun({ device_shape_ids: ["d2"], route_shape_ids: ["b2", "trunk"], tr_id: "tr" }), id: "run-2" },
  { ...mintCableHold({ device_shape_ids: ["d3"], reason: "by others" }), id: "hold-1" },
];
const OPTS = { sheetSize: () => ({ w: 3400, h: 2200 }), uppFor: () => 1 / 36 };

test("one takeoff, every follow-up: own vertical over branch + trunk, pathway counted once, a hold, a double click flagged, parts per cable and per pull", () => {
  const t: any = computeCableTakeoff(CONDS, SHAPES, RUNS, OPTS);
  const r1 = t.resolved.runs.find((r: any) => r.id === "run-1");
  const r2 = t.resolved.runs.find((r: any) => r.id === "run-2");
  // item 4 × item 2: route 40 + 100 = 140, its own vertical 12, loops 3 + 26 → 181 per cable, × 4 = 724
  assert.deepEqual([r1.route_lf, r1.branch_lf, r1.trunk_lf, r1.vertical_ft, r1.per_cable_lf, r1.location_lf], [140, 40, 100, 12, 181, 724]);
  // the sibling run keeps the condition's 9 ft: 135 + 9 + 3 + 26 = 173 per cable, × 4 = 692
  assert.deepEqual([r2.route_lf, r2.branch_lf, r2.vertical_ft, r2.per_cable_lf, r2.location_lf], [135, 35, 9, 173, 692]);
  // item 2: the pathway counts the shared trunk ONCE; the cable counts it per run
  const trunkRow = t.pathway.rows.find((x: any) => x.condition_id === "c-trunk");
  const branchRow = t.pathway.rows.find((x: any) => x.condition_id === "c-branch");
  assert.deepEqual([trunkRow.pathway_lf, trunkRow.linked_runs, branchRow.pathway_lf, branchRow.linked_runs], [100, 2, 75, 2]);
  assert.equal(t.summary.totals.route_lf, 275);
  // summary: 2 pulls, 8 cables, 1416 net, × 1.12 = 1585.92 order; 4 EA = 2 pulls + 1 unlinked (the second click) + 1 held
  const tot = t.summary.totals;
  assert.deepEqual([tot.ea, tot.pulls, tot.cables, tot.cable_lf, tot.cable_lf_order, tot.unlinked_devices, tot.held_devices], [4, 2, 8, 1416, 1585.92, 1, 1]);
  // item 3: the outlet clicked twice is flagged, and still counted (EA 4)
  assert.equal(t.duplicates.same_sheet.length, 1);
  assert.ok(t.summary.warnings.some((w: string) => /d1|DATA-1/.test(w) && /1 ft|0 ft|same/i.test(w)), JSON.stringify(t.summary.warnings));
  // item 5: parts follow linked runs only — jacks per cable 8, plates per pull 2; the hold and the stray marker add none
  const q = cableQtyByShape(t);
  const sum = (k: "pulls" | "cables") => [...q.values()].reduce((n, v) => n + v[k], 0);
  assert.deepEqual([sum("cables"), sum("pulls")], [8, 2]);
  // the runs sheet: vertical used, the override named, branch and trunk split
  const tbl = cableTables(t)!;
  const hdr = tbl.runs[0];
  const row = tbl.runs.find((x: any[]) => x[0] === "run-1")!;
  assert.equal(row[hdr.indexOf("Vertical ft")], 12);
  assert.equal(row[hdr.indexOf("Branch LF")], 40);
  assert.equal(row[hdr.indexOf("Trunk LF")], 100);
  assert.match(String(row[hdr.indexOf("Reason / notes")]), /vertical 12 ft \(run override; condition 9 ft\)/);
});

// ── round two (items 6–8, plan §15): medium and stated limits, box/reel
// rounding, and the workbook those tabs land in — together on one takeoff ──
import { reportWorkbook } from "../src/lib/xlsx.js";

test("one takeoff, round two: copper checked at 295, fiber at its stated 500, coax unchecked; boxes per cable type; the workbook carries every cable tab", () => {
  const cu = cond("c-cu", "DATA-1", { waste_pct: 12, cable_setup: { ...mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 9, loop_device_ft: 3, loop_tr_ft: 26 }), medium: "copper", package_ft: 1000 } });
  const fi = cond("c-fi", "FIBER-1", { waste_pct: 12, cable_setup: { ...mintCableSetup("custom", { cables_per_location: 1, cable_type: "OM4", vertical_ft: 10, loop_device_ft: 20, loop_tr_ft: 30 }), medium: "fiber", max_link_ft: 500, package_ft: 2000 } });
  const cx = cond("c-cx", "CATV-1", { waste_pct: 0, cable_setup: { ...mintCableSetup("custom", { cables_per_location: 1, cable_type: "RG6", vertical_ft: 10, loop_device_ft: 0, loop_tr_ft: 0 }), medium: "coax" } });
  const route = cond("c-r", "ROUTE", { role: "route" });
  const conds = [cu, fi, cx, TR, route];
  const shapes = [
    count("tr", "c-tr", [0.05, 0.5]), count("cu1", "c-cu", [0.5, 0.2]), count("fi1", "c-fi", [0.5, 0.4]), count("cx1", "c-cx", [0.5, 0.8]),
    line("r-cu", "c-r", 262, 0.2), line("r-fi", "c-r", 540, 0.4), line("r-cx", "c-r", 700, 0.8),
  ];
  const runs = [
    { ...mintCableRun({ device_shape_ids: ["cu1"], route_shape_ids: ["r-cu"], tr_id: "tr" }), id: "run-cu" },
    { ...mintCableRun({ device_shape_ids: ["fi1"], route_shape_ids: ["r-fi"], tr_id: "tr" }), id: "run-fi" },
    { ...mintCableRun({ device_shape_ids: ["cx1"], route_shape_ids: ["r-cx"], tr_id: "tr" }), id: "run-cx" },
  ];
  const t: any = computeCableTakeoff(conds, shapes, runs);
  const run = (id: string) => t.resolved.runs.find((r: any) => r.id === id);
  // item 6: copper 262 + 9 + 3 + 26 = 300 > 295 (TIA); fiber 540 + 60 = 600 > its stated 500; coax 710, no limit → unflagged
  assert.deepEqual([run("run-cu").per_cable_lf, run("run-cu").over_length, run("run-cu").limit_ft, run("run-cu").limit_source], [300, true, 295, "tia_568_copper"]);
  assert.deepEqual([run("run-fi").per_cable_lf, run("run-fi").over_length, run("run-fi").limit_ft, run("run-fi").limit_source], [600, true, 500, "stated"]);
  assert.deepEqual([run("run-cx").per_cable_lf, run("run-cx").over_length, run("run-cx").limit_source], [710, undefined, "none"]);
  assert.equal(t.summary.totals.pulls, 3, "a flag never withholds a run");
  // item 7: CAT6A 300 × 2 = 600 net, × 1.12 = 672 order → 1 box of 1000, 328 left; OM4 600 × 1.12 = 672 → 1 reel of 2000, 1328 left; RG6 unsized → blank
  const order = (k: string) => t.order.rows.find((r: any) => r.cable_type === k);
  assert.deepEqual([order("CAT6A").order_lf, order("CAT6A").boxes, order("CAT6A").purchased_lf, order("CAT6A").leftover_lf], [672, 1, 1000, 328]);
  assert.deepEqual([order("OM4").order_lf, order("OM4").boxes, order("OM4").purchased_lf, order("OM4").leftover_lf], [672, 1, 2000, 1328]);
  assert.deepEqual([order("RG6").order_lf, order("RG6").boxes], [710, null]);
  // item 8's builder: the canvas workbook (and so the MCP one) carries every cable tab
  const tabs = reportWorkbook({ rows: [], bySheet: [], shapeRows: [], cable: t }).map((s: any) => s.name);
  for (const tab of ["Cable summary", "Cable runs", "Cable order"]) assert.ok(tabs.includes(tab), `${tab} in ${tabs.join(", ")}`);
  const runsTab = reportWorkbook({ rows: [], bySheet: [], shapeRows: [], cable: t }).find((s: any) => s.name === "Cable runs")!.rows;
  assert.ok(runsTab[0].includes("Limit ft"), runsTab[0].join(" | "));
});
