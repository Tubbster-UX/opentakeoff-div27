// An invented Division 27 cable takeoff that states NO medium and NO limit
// (item 6, docs/design/CABLE_SETUP_PLAN.md §15.1), and the function that
// figures every cable output from it. web/test/cableMedium.test.ts runs the
// function against the current library and compares the result with
// cableMedium.base.json, which the same function wrote when run against the
// library at 28ea3cc (before medium and max_link_ft existed): a cable
// document that uses neither field must export byte-for-byte as before.
//
// The fixture is plain data — no library call builds it — so the base and
// the current library read exactly the same input. It covers runs under and
// over 295 ft, a multiplier, a withheld and a broken run, a hold, an unlinked
// device and route, a run's own vertical, and a variant with a tagged trunk
// (the Branch / Trunk LF columns), each in imperial and metric.
const PROV = { method: "manual", created_at: "2026-10-27T00:00:00.000Z" };
const AGENT = { method: "manual", actor: "agent", reviewed: false, created_at: "2026-10-27T00:00:00.000Z" };
const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2f7d54", fill: "#2f7d54", hatch: "solid", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, at: [number, number], sheet = "comm.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [at], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number, pts: [number, number][], sheet = "rcp.pdf") => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: pts, computed: { area_sf: 0, perimeter_lf: lf } });
const setup = (device_type: string, extra: any) => ({ device_type, cables_per_location: 1, cable_type: "", vertical_ft: 13, loop_device_ft: 10, loop_tr_ft: 10, ...extra });

// cable_type text that names a medium is deliberately present: it must NOT
// change the check (the medium is never read from it)
export const CONDS = [
  cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: setup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 23 }) }),
  cond("c-cam", "CAM-1", { color: "#7c3aed", waste_pct: 10, multiplier: 2, cable_setup: setup("camera", { cable_type: "CAT6 outdoor", loop_device_ft: 15 }) }),
  cond("c-fib", "BB-1", { color: "#0e7490", waste_pct: 5, cable_setup: setup("custom", { cable_type: "OM4 fiber 12-strand", vertical_ft: 20, loop_device_ft: 15, loop_tr_ft: 15 }) }),
  cond("c-coax", "CATV-1", { color: "#a16207", cable_setup: setup("ceiling_other", { cable_type: "RG6 coax" }) }),
  cond("c-door", "EAC-1", { cable_setup: setup("access_door", { vertical_ft: null, loop_device_ft: 15 }) }),
  cond("c-tr", "TR", { role: "tr" }),
  cond("c-route", "ROUTE", { color: "#be185d", role: "route" }),
];
export const SHAPES = [
  count("tr", "c-tr", [0.1, 0.5], "comm.pdf", { label: "MDF" }),
  count("d1", "c-data", [0.5, 0.2]), count("d2", "c-data", [0.5, 0.4]), count("d3", "c-data", [0.5, 0.6]), count("d4", "c-data", [0.6, 0.6]),
  count("cam1", "c-cam", [0.8, 0.8]), count("cam2", "c-cam", [0.8, 0.6]),
  count("fib1", "c-fib", [0.9, 0.2]), count("cx1", "c-coax", [0.7, 0.3]), count("door1", "c-door", [0.3, 0.8]),
  line("r1", "c-route", 87.5, [[0.5, 0.2], [0.1, 0.2], [0.1, 0.5]]),
  line("r2", "c-route", 258.05, [[0.8, 0.8], [0.1, 0.8], [0.1, 0.5]]),
  line("r3", "c-route", 40, [[0.3, 0.8], [0.1, 0.8]]),
  line("r4", "c-route", 562.5, [[0.9, 0.2], [0.9, 0.5], [0.1, 0.5]]),
  line("r5", "c-route", 300, [[0.7, 0.3], [0.1, 0.3]]),
  line("r6", "c-route", 12, [[0.6, 0.6], [0.6, 0.7]]),
  line("r7", "c-route", 252, [[0.5, 0.4], [0.1, 0.4]]),
];
export const RUNS = [
  { id: "run-aaaa1111-0000-4000-8000-000000000001", device_shape_ids: ["d1"], route_shape_ids: ["r1"], tr_id: "tr", provenance: PROV },
  { id: "run-bbbb2222-0000-4000-8000-000000000002", device_shape_ids: ["cam1"], route_shape_ids: ["r2"], tr_id: "tr", provenance: AGENT },
  { id: "run-cccc3333-0000-4000-8000-000000000003", device_shape_ids: ["door1"], route_shape_ids: ["r3"], tr_id: "tr", provenance: PROV },
  { id: "run-eeee5555-0000-4000-8000-000000000005", device_shape_ids: ["fib1"], route_shape_ids: ["r4"], tr_id: "tr", provenance: PROV },
  { id: "run-ffff6666-0000-4000-8000-000000000006", device_shape_ids: ["cx1"], route_shape_ids: ["r5"], tr_id: "tr", cables_override: 2, provenance: PROV },
  { id: "run-abab7777-0000-4000-8000-000000000007", device_shape_ids: ["d2"], route_shape_ids: ["r7"], tr_id: "tr", vertical_override: 9, provenance: PROV },
  { id: "run-cdcd8888-0000-4000-8000-000000000008", device_shape_ids: ["cam2"], route_shape_ids: ["gone"], tr_id: "tr", provenance: PROV },
  { id: "hold-dddd4444-0000-4000-8000-000000000004", device_shape_ids: ["d3"], route_shape_ids: [], tr_id: "", hold: { reason: "by others" }, provenance: PROV },
];

const W = 3400, H = 2200, PT = 0.5;
const measure = (t: string, size: number) => t.length * size * 0.5;
const fmtLen = (ft: number) => `${Math.round(ft * 10) / 10} LF`;
const sheetLabel = (k: string) => k.replace(/\.pdf$/, "").toUpperCase();
const metricL = (v: number) => Math.round(v * 0.3048 * 100) / 100;
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x.entries()] : x instanceof Set ? [...x] : x)));

/** Every cable output for one variant of the fixture, through the library
 *  modules handed in (the current ones, or 28ea3cc's). */
function outputs(m: any, conds: any[]) {
  const { cable, marks, totals, xlsx } = m;
  const t = cable.computeCableTakeoff(conds, SHAPES, RUNS);
  const rows = totals.conditionTotals(conds, SHAPES).filter((r: any) => r.shape_count > 0);
  const sheetMarks = Object.fromEntries(["comm.pdf", "rcp.pdf"].map((sheetId) => [sheetId,
    json(marks.cableSheetMarks(t, { sheetId, shapes: SHAPES, conditions: conds, W, H, ptScale: PT, measure, fmtLen }))]));
  return {
    resolved: json(t.resolved),
    summary: json(t.summary),
    byCond: json(t.byCond),
    runRows: json(cable.cableRunRows(t, sheetLabel)),
    tables: json(cable.cableTables(t, { sheetLabel })),
    tablesMetric: json(cable.cableTables(t, { sheetLabel, L: metricL, lengthUnit: "m" })),
    reportJson: JSON.stringify(totals.reportJson({ rows, cable: cable.cableReportBlock(t, sheetLabel), sheetLabel })),
    csv: totals.totalsToCsv(rows, "Invented", null, sheetLabel, null, null, null, "OpenTakeoff", "imperial", t),
    csvMetric: totals.totalsToCsv(rows, "Invented", null, sheetLabel, null, null, null, "OpenTakeoff", "metric", t),
    workbook: JSON.stringify(xlsx.reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t, sheetLabel })),
    workbookMetric: JSON.stringify(xlsx.reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t, sheetLabel, units: "metric" })),
    legend: json(marks.cableLegend(t, conds, { fmtLen })),
    sheetMarks,
  };
}

/** The two variants: as drawn, and with the route condition tagged trunk. */
export function cableMediumOutputs(m: any) {
  return {
    plain: outputs(m, CONDS),
    trunk: outputs(m, CONDS.map((c) => (c.id === "c-route" ? { ...c, route_kind: "trunk" } : c))),
  };
}
