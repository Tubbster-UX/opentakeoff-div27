// An invented takeoff with NO cable work and every older materials basis
// (area, linear, count, seam_lf, a basis-less row, a round:false row, an
// unnamed row the engine drops), sliced by sheet and by label. The report
// JSON, CSV and workbook it produces are pinned by SHA-256 in
// test/cableMaterials.test.ts against the values the base commit printed
// before the cables / pulls bases existed — a takeoff with no cable work must
// export byte for byte as before.
import { conditionTotals, sheetTotals, labelGroupedRows, sheetLabelGroupedRows, reportJson, totalsToCsv } from "../../src/lib/totals.js";
import { reportWorkbook } from "../../src/lib/xlsx.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });

export const NO_CABLE_CONDITIONS = [
  cond("c-vct", "VCT-1", {
    waste_pct: 7,
    materials: [
      { id: "m1", name: "Adhesive", per: 250, basis: "area", unit: "gal", round: true, note: "1/16 V-notch" },
      { id: "m2", name: "Primer", per: 400, unit: "gal", round: false },
      { id: "m3", name: "", per: 10, basis: "area", unit: "x" },
    ],
  }),
  cond("c-sv", "SV-1", {
    multiplier: 2, waste_pct: 5,
    materials: [{ id: "m4", name: "Heat-weld rod", per: 1, basis: "seam_lf", unit: "lf", round: true, note: "runs the figured seams" }],
  }),
  cond("c-wb", "WB-1", { materials: [{ id: "m5", name: "Cove adhesive", per: 40, basis: "linear", unit: "tube", round: false }] }),
  cond("c-fx", "FX-1", { materials: [{ id: "m6", name: "Anchor", per: 0.5, basis: "count", unit: "ea", round: true }] }),
];

export const NO_CABLE_SHAPES = [
  { id: "s1", sheet_id: "a.pdf#1", condition_id: "c-vct", measure_role: "floor_area", label: "101", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 812.4, perimeter_lf: 120.5 } },
  { id: "s2", sheet_id: "a.pdf#2", condition_id: "c-vct", measure_role: "floor_area", label: "201", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 455.25, perimeter_lf: 88 } },
  { id: "s3", sheet_id: "a.pdf#1", condition_id: "c-sv", measure_role: "floor_area", label: "101", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 300, perimeter_lf: 70 } },
  { id: "s4", sheet_id: "a.pdf#1", condition_id: "c-wb", measure_role: "linear", verts_norm: [[0, 0], [1, 0]], computed: { area_sf: 0, perimeter_lf: 63.33 } },
  { id: "s5", sheet_id: "a.pdf#2", condition_id: "c-fx", measure_role: "count", label: "201", verts_norm: [[0.5, 0.5]], computed: { count: 1 } },
  { id: "s6", sheet_id: "a.pdf#2", condition_id: "c-fx", measure_role: "count", verts_norm: [[0.4, 0.5]], computed: { count: 1 } },
];

/** The seam figure a roll layout would hand in (per shape). */
export const NO_CABLE_SEAMS = new Map([["s3", 21.5]]);

/** Every export string for the fixture, under the given materials ctx. */
export function noCableOutputs(ctx: any) {
  const conditions = NO_CABLE_CONDITIONS, shapes = NO_CABLE_SHAPES;
  const rows = conditionTotals(conditions, shapes, ctx).filter((r: any) => r.shape_count > 0);
  const bySheet = sheetTotals(conditions, shapes);
  const byLabel = labelGroupedRows(conditions, shapes, ["101", "201"], ctx);
  const byFloorRoom = sheetLabelGroupedRows(conditions, shapes, ["101", "201"], ctx);
  return {
    json: JSON.stringify(reportJson({ projectName: "Invented", rows, bySheet, byLabel, shapeLabels: ["101", "201"] }), null, 2),
    csv: totalsToCsv(rows, "Invented", bySheet, null, null, null, byLabel),
    xlsx: JSON.stringify(reportWorkbook({ rows, bySheet, shapeRows: [], byFloorRoom })),
  };
}
