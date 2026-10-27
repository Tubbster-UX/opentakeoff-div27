// The OpenTakeoff files brink-merge reads, typed from what the engine actually
// writes (fixtures/*.json, produced by the Division 27 branch's MCP Session):
//   *.takeoff.json  export_takeoff / the canvas's EXPORT (opentakeoff.takeoff_canvas.v1)
//   *.report.json   export_report's JSON (opentakeoff.report.v1); its `cable`
//                   block carries the per-run cable math this package trusts.
// Every interface is open so fields OpenTakeoff adds later pass through.

export const OT_TAKEOFF_SCHEMA = "opentakeoff.takeoff_canvas.v1";
export const OT_REPORT_SCHEMA = "opentakeoff.report.v1";

export type MeasureRole = "floor_area" | "deduct" | "linear" | "surface_area" | "count";

export interface OtMaterial {
  [key: string]: unknown;
  id: string;
  name: string;
  per?: number;
  basis?: "area" | "linear" | "count" | "seam_lf" | "cables" | "pulls";
  unit?: string;
  round?: boolean;
  note?: string;
  lib_id?: string;
  origin_id?: string;
  inherited?: boolean;
}

/** Division 27 (branch claude/div27-cable-setup-c6t9wu): docs/div27-conditions.md. */
export interface OtCableSetup {
  [key: string]: unknown;
  device_type: "wall_outlet" | "wap" | "camera" | "access_door" | "ceiling_other" | "custom" | string;
  cables_per_location: number;
  cable_type: string;
  vertical_ft: number | null;
  loop_device_ft: number | null;
  loop_tr_ft: number | null;
  medium?: "copper" | "fiber" | "coax";
  max_link_ft?: number;
  package_ft?: number;
}

export interface OtCondition {
  [key: string]: unknown;
  id: string;
  finish_tag: string;
  multiplier?: number;
  waste_pct?: number;
  rise_ft?: number;
  drop_ft?: number;
  height_ft?: number;
  thickness_in?: number;
  materials?: OtMaterial[];
  cable_setup?: OtCableSetup | null;
  role?: "tr" | "route";
  route_kind?: "trunk" | "branch";
}

export interface OtComputed {
  [key: string]: unknown;
  area_sf?: number;
  perimeter_lf?: number;
  count?: number;
  plan_lf?: number;
  vertical_lf?: number;
}

export interface OtShape {
  [key: string]: unknown;
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role: MeasureRole;
  computed?: OtComputed;
  label?: string;
  origin?: Record<string, unknown>;
}

export interface OtCableRunRecord {
  [key: string]: unknown;
  id: string;
  device_shape_ids: string[];
  route_shape_ids: string[];
  tr_id: string;
  cables_override?: number;
  vertical_override?: number;
  hold?: { reason: string };
}

export interface OtSheet {
  [key: string]: unknown;
  sheet_id: string;
  units_per_px?: number;
}

export interface OtTakeoff {
  [key: string]: unknown;
  schema: string;
  project_name: string;
  units?: string;
  sheets: OtSheet[];
  conditions: OtCondition[];
  shapes: OtShape[];
  cable_runs?: OtCableRunRecord[];
}

/** export_report's `cable.runs[]` row (mcp/src/outputs.ts cableRunRow). */
export interface OtReportRun {
  [key: string]: unknown;
  run_id: string;
  status: "linked" | "withheld" | "broken";
  condition: string;
  device_type: string;
  cable_type: string;
  tr: string;
  tr_id?: string;
  device_shape_ids?: string[];
  route_shape_ids?: string[];
  route_lf: number;
  per_cable_lf?: number;
  cables?: number;
  location_lf?: number;
  multiplier: number;
  review_status?: string;
  reason?: string;
  notes?: string | string[];
  over_length?: true;
  limit_ft?: number | null;
  medium?: string;
  vertical_ft?: number;
}

/** export_report's `cable.summary[]` row (cableSummaryRow). */
export interface OtReportSummaryRow {
  [key: string]: unknown;
  condition_id: string;
  finish_tag: string;
  device_type: string;
  cable_type: string;
  tr_id?: string;
  tr_name?: string;
  multiplier: number;
  waste_pct: number;
  medium?: string;
  ea: number;
  pulls: number;
  cables: number;
  route_lf: number;
  cable_lf: number;
  cable_lf_order: number;
  unlinked_devices: number;
  held_devices: number;
  pending_runs: number;
  over_length_runs: number;
}

export interface OtReportOrderRow {
  [key: string]: unknown;
  cable_type: string;
  order_lf: number;
  package_ft: number | null;
  boxes: number | null;
  purchased_lf: number | null;
  leftover_lf: number | null;
  conditions: string[];
  package_conflict?: boolean;
  note?: string;
}

export interface OtReportCable {
  [key: string]: unknown;
  summary: OtReportSummaryRow[];
  totals: Record<string, number>;
  runs: OtReportRun[];
  unlinked: {
    devices: { shape_id: string; condition_id: string; finish_tag: string; label?: string; reason: string }[];
    routes: { shape_id: string; condition_id: string; finish_tag: string; length_lf: number; reason: string }[];
  };
  held?: { shape_id: string; condition_id: string; finish_tag: string; reason: string; label?: string }[];
  warnings: string[];
  pathway?: { rows: { condition_id: string; finish_tag: string; route_kind: string | null; segments: number; pathway_lf: number; used_lf: number; unused_lf: number; multiplier: number; pathway_lf_total: number }[] };
  order?: { rows: OtReportOrderRow[] };
}

export interface OtReportCondition {
  [key: string]: unknown;
  id: string;
  finish_tag: string;
  materials?: { name: string; unit: string; qty: number; basis?: string; reason?: string }[];
}

export interface OtReport {
  [key: string]: unknown;
  schema: string;
  project_name: string;
  conditions: OtReportCondition[];
  cable?: OtReportCable;
}
