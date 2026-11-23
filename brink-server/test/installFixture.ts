// An invented takeoff document for the install-phase tests: two plan sheets
// (T-101 first floor, T-201 second floor), labeled room polygons, two TRs,
// 2-cable wall outlets, WAPs, a camera, an access door whose setup has no
// vertical (its run is withheld), an unlinked outlet and a held WAP. Nothing
// here is a real drawing or job.
import type { InstallTakeoff } from "../src/install/baseline.ts";

const NOW = "2026-11-20T12:00:00.000Z";
const cond = (id: string, extra: Record<string, unknown> = {}) => ({ id, finish_tag: id, color: "#000", multiplier: 1, waste_pct: 10, materials: [], ...extra });
const setup = (device_type: string, extra: Record<string, unknown> = {}) => ({ device_type, cables_per_location: 1, cable_type: "CAT6A plenum", vertical_ft: 10, loop_device_ft: 5, loop_tr_ft: 5, ...extra });
const count = (id: string, condition_id: string, sheet_id: string, x: number, y: number, label?: string) =>
  ({ id, condition_id, sheet_id, measure_role: "count", verts_norm: [[x, y]], computed: { count: 1 }, ...(label ? { label } : {}) });
const line = (id: string, sheet_id: string, lf: number) => ({ id, condition_id: "ROUTE", sheet_id, measure_role: "linear", verts_norm: [[0, 0], [0.5, 0]], computed: { perimeter_lf: lf } });
const rect = (id: string, sheet_id: string, label: string, x0: number, y0: number, x1: number, y1: number, role = "floor_area") =>
  ({ id, condition_id: "FLOOR", sheet_id, measure_role: role, label, verts_norm: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], computed: { area_sf: 100 } });
const run = (id: string, dev: string, routes: string[], tr: string) => ({ id, device_shape_ids: [dev], route_shape_ids: routes, tr_id: tr, provenance: { method: "manual", created_at: NOW } });

export const S1 = "T-101.pdf";
export const S2 = "T-201.pdf";

/**
 * Per cable = route + 10 vertical + 5 + 5 loops:
 *   d1 DO 100 → 120 (×2), d2 DO 150 → 170 (×2), w1 WAP 280 → 300, c1 CAM 60 → 80 (RK-101)
 *   w2 WAP 40 → 60, d3 DO 50 → 70 (×2) (RK-201); a1 ACD withheld (no vertical)
 */
export function installTakeoff(): InstallTakeoff {
  return {
    schema: "opentakeoff.takeoff_canvas.v1",
    sheets: [{ sheet_id: S1, units_per_px: 0.05 }, { sheet_id: S2, units_per_px: 0.05 }],
    conditions: [
      cond("DO", { cable_setup: setup("wall_outlet", { cables_per_location: 2 }) }),
      cond("WAP", { cable_setup: setup("wap") }),
      cond("CAM", { cable_setup: setup("camera", { cable_type: "CAT6 outdoor" }) }),
      cond("ACD", { cable_setup: setup("access_door", { vertical_ft: null, cable_type: "18/6 shielded" }) }),
      cond("TR", { role: "tr" }),
      cond("ROUTE", { role: "route" }),
      cond("FLOOR"),
    ],
    shapes: [
      rect("rm1", S1, "Office 101", 0, 0, 0.5, 0.5),
      rect("rm2", S1, "Open Office", 0.5, 0, 1, 0.5),
      rect("rm3", S1, "IDF 1", 0, 0.5, 0.3, 1),
      rect("rm4", S2, "Conference 201", 0, 0, 1, 1),
      rect("rm5", S2, "Storage 202", 0.6, 0.6, 0.9, 0.9, "deduct"),
      count("d1", "DO", S1, 0.1, 0.1),
      count("u1", "DO", S1, 0.2, 0.2),
      count("d2", "DO", S1, 0.6, 0.1),
      count("w1", "WAP", S1, 0.7, 0.2),
      count("h1", "WAP", S1, 0.8, 0.3),
      count("c1", "CAM", S1, 0.9, 0.9),
      count("t1", "TR", S1, 0.1, 0.7, "IDF-1"),
      count("t2", "TR", S2, 0.05, 0.05, "IDF-2"),
      count("w2", "WAP", S2, 0.3, 0.3),
      count("d3", "DO", S2, 0.7, 0.7),
      count("a1", "ACD", S2, 0.4, 0.2),
      line("r1", S1, 100), line("r2", S1, 150), line("r3", S1, 280), line("r4", S1, 60),
      line("r5", S2, 40), line("r6", S2, 50), line("r7", S2, 30),
    ],
    markups: [],
    rfis: [],
    cable_runs: [
      run("run-a", "d1", ["r1"], "t1"),
      run("run-b", "d2", ["r2"], "t1"),
      run("run-c", "w1", ["r3"], "t1"),
      run("run-d", "c1", ["r4"], "t1"),
      run("run-e", "w2", ["r5"], "t2"),
      run("run-f", "d3", ["r6"], "t2"),
      run("run-g", "a1", ["r7"], "t2"),
      { id: "hold-1", device_shape_ids: ["h1"], hold: { reason: "owner-furnished AP, by others" }, provenance: { method: "manual", created_at: NOW } },
    ],
  };
}
