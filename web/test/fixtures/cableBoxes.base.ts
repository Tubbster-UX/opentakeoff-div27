// An invented cable takeoff with NO box/reel size on any condition: two
// CAT6A conditions (one ×2), a WAP on the same CAT6A, a fiber camera, a
// camera with a blank cable type, an access door withheld for its vertical,
// a held device, an unlinked device, a tagged trunk and branch. Every export
// a cable takeoff reaches (report JSON, CSV and workbook, imperial and
// metric, the cable tables and the marked-set legend) is pinned by SHA-256
// in test/cableBoxes.test.ts against the values the base commit 28ea3cc
// printed before package_ft existed — a cable takeoff that never states a
// box size must export byte for byte as before.
import { mintCableSetup, computeCableTakeoff, cableReportBlock, cableTables } from "../../src/lib/cable.js";
import { cableLegend } from "../../src/lib/cableMarks.js";
import { conditionTotals, reportJson, totalsToCsv } from "../../src/lib/totals.js";
import { reportWorkbook } from "../../src/lib/xlsx.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, x = 0.5, extra: any = {}) => ({ id, sheet_id: "t1.pdf", condition_id: condId, measure_role: "count", verts_norm: [[x, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number) => ({ id, sheet_id: "t1.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const run = (id: string, dev: string, route: string[], extra: any = {}) => ({ id, device_shape_ids: [dev], route_shape_ids: route, tr_id: "tr", ...extra, provenance: { method: "manual", created_at: "2026-10-27T00:00:00.000Z" } });

export const BOX_CONDITIONS = [
  cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) }),
  cond("c-data2", "DATA-2", { waste_pct: 10, multiplier: 2, cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A" }) }),
  cond("c-wap", "WAP-1", { waste_pct: 12, cable_setup: mintCableSetup("wap", { cables_per_location: 2, cable_type: "CAT6A" }) }),
  cond("c-fib", "CAM-FO", { waste_pct: 5, cable_setup: mintCableSetup("camera", { cable_type: "OS2 fiber" }) }),
  cond("c-cam", "CAM-1", { waste_pct: 12, cable_setup: mintCableSetup("camera") }),
  cond("c-door", "DOOR-1", { waste_pct: 12, cable_setup: mintCableSetup("access_door", { cable_type: "CAT6A" }) }),
  cond("c-tr", "TR", { role: "tr" }),
  cond("c-tray", "TRAY", { role: "route", route_kind: "trunk" }),
  cond("c-br", "BRANCH", { role: "route", route_kind: "branch" }),
];

export const BOX_SHAPES = [
  count("tr", "c-tr", 0.05, { label: "MDF" }),
  count("d1", "c-data", 0.1), count("d2", "c-data", 0.2), count("d3", "c-data", 0.3),
  count("e1", "c-data2", 0.4), count("e2", "c-data2", 0.45),
  count("w1", "c-wap", 0.5),
  count("f1", "c-fib", 0.6),
  count("k1", "c-cam", 0.7),
  count("x1", "c-door", 0.8),
  line("t1", "c-tray", 100.25),
  line("b1", "c-br", 40.5), line("b2", "c-br", 35), line("b3", "c-br", 61.75), line("b4", "c-br", 22),
  line("b5", "c-br", 18.4), line("b6", "c-br", 75), line("b7", "c-br", 140), line("b8", "c-br", 12),
];

export const BOX_RUNS = [
  run("run-d1", "d1", ["b1", "t1"]),
  run("run-d2", "d2", ["b2", "t1"], { cables_override: 3 }),
  run("run-e1", "e1", ["b3", "t1"]),
  run("run-e2", "e2", ["b4", "t1"]),
  run("run-w1", "w1", ["b5", "t1"]),
  run("run-f1", "f1", ["b6", "t1"]),
  run("run-k1", "k1", ["b7"]),
  run("run-x1", "x1", ["b8", "t1"]),
  { id: "hold-1", device_shape_ids: ["d3"], route_shape_ids: [], tr_id: "", hold: { reason: "by others" }, provenance: { method: "manual", created_at: "2026-10-27T00:00:00.000Z" } },
];

const sheetLabel = (k: string) => (k === "t1.pdf" ? "T1.1" : k);
const metricL = (v: number) => Math.round(v * 0.3048 * 100) / 100;

/** Every cable export of the fixture, as strings. `conditions` defaults to
 *  the fixture's own; a caller may pass a variant (package_ft stated, or an
 *  invalid one). */
export function boxOutputs(conditions: any[] = BOX_CONDITIONS) {
  const t = computeCableTakeoff(conditions, BOX_SHAPES, BOX_RUNS)!;
  const rows = conditionTotals(conditions, BOX_SHAPES).filter((r: any) => r.shape_count > 0);
  const legend: any = cableLegend(t, conditions, { fmtLen: (ft: number) => `${Math.round(ft * 10) / 10} LF` });
  return {
    csv: totalsToCsv(rows, "Invented", null, sheetLabel, null, null, null, "OpenTakeoff", "imperial", t),
    csvMetric: totalsToCsv(rows, "Invented", null, sheetLabel, null, null, null, "OpenTakeoff", "metric", t),
    json: JSON.stringify(reportJson({ projectName: "Invented", rows, sheetLabel, cable: cableReportBlock(t, sheetLabel) })),
    xlsx: JSON.stringify(reportWorkbook({ rows, bySheet: [], shapeRows: [], sheetLabel, cable: t })),
    xlsxMetric: JSON.stringify(reportWorkbook({ rows, bySheet: [], shapeRows: [], sheetLabel, units: "metric", cable: t })),
    tables: JSON.stringify(cableTables(t, { sheetLabel })),
    tablesMetric: JSON.stringify(cableTables(t, { sheetLabel, L: metricL, lengthUnit: "m" })),
    legend: JSON.stringify({ ...legend, lines: [...legend.lines] }),
  };
}
