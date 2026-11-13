// Phase 3 — the marked set's cable marks (lib/cableMarks.js): route chips
// with run ID and per-cable LF, device tags carrying the same run ID, rings
// on unlinked and held devices, TR names, and the legend cover's per-condition
// pulls / cables / net / order LF. Placement and wording are pure, so they
// are pinned here exactly; lib/markedset.js only draws what this returns.
// Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintCableSetup, mintCableRun, mintCableHold, computeCableTakeoff, runShortIds } from "../src/lib/cable.js";
import { cableSheetMarks, cableLegend, placeLabels, polylineAt, wrapText, CHIP_PT, TAG_PT, chipHeightPt } from "../src/lib/cableMarks.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2f7d54", fill: "#2f7d54", hatch: "solid", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, at: [number, number], sheet = "comm.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [at], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number, pts: [number, number][], sheet = "rcp.pdf") => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: pts, computed: { area_sf: 0, perimeter_lf: lf } });

const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 4, cable_type: "CAT6A", vertical_ft: 9, loop_device_ft: 3, loop_tr_ft: 26 }) });
const CAM = cond("c-cam", "CAM-1", { color: "#7c3aed", waste_pct: 12, cable_setup: mintCableSetup("camera", { cables_per_location: 2, vertical_ft: 1, loop_device_ft: 15, loop_tr_ft: 26 }) });
const DOOR = cond("c-door", "EAC-1", { cable_setup: mintCableSetup("access_door") });   // no vertical → withheld
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { color: "#be185d", role: "route" });
const CONDS = [DATA, CAM, DOOR, TR, ROUTE];
const SHAPES = [
  count("tr", "c-tr", [0.1, 0.5], "comm.pdf", { label: "MDF" }),
  count("d1", "c-data", [0.5, 0.2]), count("d2", "c-data", [0.5, 0.4]), count("d3", "c-data", [0.5, 0.6]),
  count("cam1", "c-cam", [0.8, 0.8]), count("door1", "c-door", [0.3, 0.8]),
  line("r1", "c-route", 16.57, [[0.5, 0.2], [0.1, 0.2], [0.1, 0.5]]),
  line("r2", "c-route", 258.05, [[0.8, 0.8], [0.1, 0.8], [0.1, 0.5]]),
  line("r3", "c-route", 40, [[0.3, 0.8], [0.1, 0.8]]),
];
const RUNS = [
  { ...mintCableRun({ device_shape_ids: ["d1"], route_shape_ids: ["r1"], tr_id: "tr" }), id: "run-aaaa1111-0000-4000-8000-000000000001" },
  { ...mintCableRun({ device_shape_ids: ["cam1"], route_shape_ids: ["r2"], tr_id: "tr" }), id: "run-bbbb2222-0000-4000-8000-000000000002" },
  { ...mintCableRun({ device_shape_ids: ["door1"], route_shape_ids: ["r3"], tr_id: "tr" }), id: "run-cccc3333-0000-4000-8000-000000000003" },
  { ...mintCableHold({ device_shape_ids: ["d3"], reason: "by others" }), id: "hold-dddd4444-0000-4000-8000-000000000004" },
];
const W = 3400, H = 2200, PT = 0.5;   // image px; 0.5 pt per px (render scale 2.0)
const measure = (t: string, size: number) => t.length * size * 0.5;   // a stand-in Helvetica: half an em per glyph
const fmtLen = (ft: number) => `${Math.round(ft * 10) / 10} LF`;
const marks = (sheetId: string, cable = computeCableTakeoff(CONDS, SHAPES, RUNS)) => cableSheetMarks(cable, { sheetId, shapes: SHAPES, conditions: CONDS, W, H, ptScale: PT, measure, fmtLen });
const rect = (it: any) => ({ x0: it.x - it.w / 2, y0: it.y - it.h / 2, x1: it.x + it.w / 2, y1: it.y + it.h / 2 });
const overlaps = (a: any, b: any) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

test("runShortIds: six hex digits, lengthened only until unique; holds keep their prefix", () => {
  const ids = runShortIds([{ id: "run-c711ef94-73b7-4b56" }, { id: "run-c711ef00-0000" }, { id: "run-0a1b2c3d" }, { id: "hold-dddd4444-0000" }]);
  assert.deepEqual([...ids.values()], ["run-c711ef9", "run-c711ef0", "run-0a1b2c", "hold-dddd44"]);
  assert.equal(runShortIds([{ id: "run-w" }]).get("run-w"), "run-w", "a short invented id prints whole");
});

test("polylineAt walks arclength; a zero-length line answers its start", () => {
  assert.deepEqual(polylineAt([[0, 0], [10, 0], [10, 10]], 0.75), { x: 10, y: 5, tx: 0, ty: 1 });
  assert.deepEqual(polylineAt([[0, 0], [10, 0]], 0.5), { x: 5, y: 0, tx: 1, ty: 0 });
  assert.deepEqual(polylineAt([[3, 3], [3, 3]], 0.5), { x: 3, y: 3, tx: 1, ty: 0 });
});

test("placeLabels: a later label avoids an earlier one; with no room it takes the least overlap and says clear:false; off-sheet costs", () => {
  const placed: any[] = [];
  const out = placeLabels([
    { key: "a", w: 10, h: 4, candidates: [[50, 50]] },
    { key: "b", w: 10, h: 4, candidates: [[52, 50], [50, 60]] },
    { key: "c", w: 10, h: 4, candidates: [[50, 50], [53, 50]] },
    { key: "d", w: 10, h: 4, candidates: [[2, 2], [80, 80]] },
  ], { placed, W: 100, H: 100 });
  assert.deepEqual(out.map((o: any) => [o.key, o.x, o.y, o.clear]), [["a", 50, 50, true], ["b", 50, 60, true], ["c", 53, 50, false], ["d", 80, 80, true]]);
  assert.equal(placed.length, 4);
  assert.equal("candidates" in out[0], false);
});

test("route sheet: one chip per run with run ID, device condition and per-cable LF; >295 flagged; withheld named; generic route chips suppressed", () => {
  const m = marks("rcp.pdf");
  assert.deepEqual(m.chips.map((c: any) => [c.text, c.tone]), [
    ["run-aaaa11 · DATA-1 · 54.6 LF", "ok"],
    ["run-bbbb22 · CAM-1 · 300.1 LF >295", "over"],
    ["run-cccc33 · EAC-1 · withheld", "bad"],
  ]);
  assert.deepEqual([...m.suppress].sort(), ["r1", "r2", "r3"]);
  assert.equal(m.chips[1].color, "#7c3aed", "the chip border is the DEVICE condition's color");
  assert.ok(m.chips.every((c: any) => c.clear), "room to spare: every chip placed clear");
  for (let i = 0; i < m.chips.length; i++) for (let j = i + 1; j < m.chips.length; j++) assert.equal(overlaps(rect(m.chips[i]), rect(m.chips[j])), false);
  assert.equal(m.chips[0].h, chipHeightPt(CHIP_PT) / PT, "11.5 pt tall in image px");
  assert.equal(m.chips[0].w, (measure(m.chips[0].text, CHIP_PT) + 8) / PT);
  assert.deepEqual(m.tags, [], "no device on the ceiling plan");
  // the first candidate is 25% along the route: on r1's first leg
  assert.deepEqual([m.chips[0].x, m.chips[0].y], [polylineAt([[1700, 440], [340, 440], [340, 1100]], 0.25).x, 440]);
});

test("device sheet: each linked device tagged with its run ID beside the marker, TR named, rings on the unlinked and the held", () => {
  const m = marks("comm.pdf");
  assert.deepEqual(m.chips, []);
  assert.equal(m.suppress.size, 0);
  assert.deepEqual(m.tags.map((t: any) => [t.shape_id, t.text, t.tone]), [["d1", "run-aaaa11", "ok"], ["cam1", "run-bbbb22", "over"], ["door1", "run-cccc33", "bad"]]);
  assert.equal(m.tags[0].h, chipHeightPt(TAG_PT) / PT);
  const d1 = [0.5 * W, 0.2 * H];
  assert.deepEqual([m.tags[0].x, m.tags[0].y], [d1[0] + 6 / PT + m.tags[0].w / 2, d1[1]], "first choice: just right of the marker");
  assert.deepEqual(m.trLabels.map((t: any) => t.text), ["MDF"]);
  // door1's run is withheld (no vertical), so the device is unlinked too
  assert.deepEqual(m.rings.map((r: any) => [r.shape_id, r.kind]), [["d2", "unlinked"], ["door1", "unlinked"], ["d3", "held"]]);
  const all = [...m.trLabels, ...m.tags];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.equal(overlaps(rect(all[i]), rect(all[j])), false);
});

test("a crowded corridor: chips for runs on the same trunk spread out instead of stacking", () => {
  const shapes = [count("tr", "c-tr", [0.05, 0.5], "rcp.pdf", { label: "MDF" })];
  const runs: any[] = [];
  for (let i = 0; i < 8; i++) {
    shapes.push(count(`d${i}`, "c-data", [0.9, 0.1 + i * 0.1], "rcp.pdf"));
    shapes.push(line(`r${i}`, "c-route", 50, [[0.9, 0.1 + i * 0.1], [0.5, 0.5], [0.05, 0.5]]) as any);
    runs.push({ ...mintCableRun({ device_shape_ids: [`d${i}`], route_shape_ids: [`r${i}`], tr_id: "tr" }), id: `run-${String(i).repeat(8)}` });
  }
  const t = computeCableTakeoff(CONDS, shapes, runs);
  const m = cableSheetMarks(t, { sheetId: "rcp.pdf", shapes, conditions: CONDS, W, H, ptScale: PT, measure, fmtLen });
  assert.equal(m.chips.length, 8);
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) assert.equal(overlaps(rect(m.chips[i]), rect(m.chips[j])), false, `${m.chips[i].text} vs ${m.chips[j].text}`);
});

test("legend cover: the meta line, a cable line per device condition (×N, waste on order only), route and TR conditions named, key and warnings", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, RUNS);
  const lg = cableLegend(t, CONDS, { fmtLen })!;
  assert.equal(lg.meta, "Cable runs: 2 pulls linked · 0 runs pending review · 2 unlinked devices · 1 held device · 1 over 295 ft per cable");
  assert.equal(lg.lines.get("c-data"), "1 pull · 4 cables · 218.3 LF cable net · 244.5 LF order at 12% waste · 1 unlinked · 1 held");
  assert.equal(lg.lines.get("c-cam"), "1 pull · 2 cables · 600.1 LF cable net · 672.1 LF order at 12% waste");
  assert.equal(lg.lines.get("c-door"), "0 pulls · 0 cables · 0 LF cable net · 0 LF order at 0% waste · 1 unlinked");
  assert.equal(lg.lines.get("c-route"), "cable route pathway, not a cable quantity: cable LF is figured per run on each device condition");
  assert.equal(lg.lines.get("c-tr"), "telecom room: where the runs home");
  assert.match(lg.key, /^Route chips: run ID · device condition · per-cable LF/);
  assert.equal(lg.warnings.length, 1);
  assert.match(lg.warnings[0], /^1 linked run exceeds 295 ft per cable/);
  // ×N: a ×2 device condition doubles pulls, cables and LF on its line
  const x2 = CONDS.map((c) => (c.id === "c-data" ? { ...c, multiplier: 2 } : c));
  assert.equal(cableLegend(computeCableTakeoff(x2, SHAPES, RUNS), x2, { fmtLen })!.lines.get("c-data"), "2 pulls · 8 cables · 436.6 LF cable net · 489 LF order at 12% waste · 2 unlinked · 2 held");
  // the Phase 1 cover line is unchanged when nothing is held or over length
  const plain = computeCableTakeoff(CONDS, SHAPES, RUNS.slice(0, 1));
  assert.equal(cableLegend(plain, CONDS, { fmtLen })!.meta, "Cable runs: 1 pull linked · 0 runs pending review · 4 unlinked devices");
  assert.equal(cableLegend(null, CONDS, { fmtLen }), null);
});

test("wrapText breaks on words at the width; a warning is never cut", () => {
  const m = (s: string) => s.length;
  assert.deepEqual(wrapText("one two three four", 9, m), ["one two", "three", "four"]);
  assert.deepEqual(wrapText("supercalifragilistic word", 5, m), ["supercalifragilistic", "word"]);
  assert.deepEqual(wrapText("", 5, m), []);
  const long = "2 linked runs exceed 295 ft per cable, the TIA-568 limit for a 4-pair copper permanent link (90 m): CAM-1 run-x 300.05 ft; CAM-1 run-y 318.62 ft.";
  assert.equal(wrapText(long, 40, m).join(" "), long);
});
