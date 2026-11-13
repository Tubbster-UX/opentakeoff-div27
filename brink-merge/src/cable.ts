// Division 27 cable runs, read from OpenTakeoff's export_report `cable` block.
// OpenTakeoff owns the math (per cable = route plan LF + vertical + both
// loops; location = per cable x cables; order = x(1 + waste), x N in the
// summary): brink-merge never recomputes it. It only cross-checks each run's
// route LF against the takeoff's stored shape lengths, so a report that
// drifted from its takeoff is caught rather than priced.
import type { Issues } from "./issues.js";
import type { OtReport, OtReportOrderRow, OtReportRun, OtReportSummaryRow, OtTakeoff } from "./ot/types.js";
import { r2 } from "./rollup.js";

export interface CableRun {
  runId: string;
  status: OtReportRun["status"];
  conditionKey: string;
  conditionId: string;
  deviceType: string;
  cableType: string;
  medium?: string;
  trId: string;
  trName: string;
  deviceShapeIds: string[];
  routeShapeIds: string[];
  routeLf: number;
  perCableLf: number | null;
  cables: number;
  locationLf: number | null;
  multiplier: number;
  review: string;
  overLength: boolean;
  limitFt: number | null;
  reason: string;
}

export interface CableData {
  runs: CableRun[];
  summary: OtReportSummaryRow[];
  order: OtReportOrderRow[];
  pathway: NonNullable<NonNullable<OtReport["cable"]>["pathway"]>["rows"];
  unlinkedDevices: NonNullable<OtReport["cable"]>["unlinked"]["devices"];
  unlinkedRoutes: NonNullable<OtReport["cable"]>["unlinked"]["routes"];
  held: NonNullable<NonNullable<OtReport["cable"]>["held"]>;
  warnings: string[];
}

const LF_TOLERANCE = 0.011;

/**
 * `editedShapeIds`: shapes the takeoff edit layer changed (takeoffEdits.ts). A run whose route LF no longer matches
 * because a person edited its route in the app is a warning that names that edit, not a report / takeoff mismatch.
 */
export function readCable(takeoff: OtTakeoff, report: OtReport | null, issues: Issues, editedShapeIds: ReadonlySet<string> = new Set()): CableData {
  const empty: CableData = { runs: [], summary: [], order: [], pathway: [], unlinkedDevices: [], unlinkedRoutes: [], held: [], warnings: [] };
  const cable = report?.cable;
  if (!cable) return empty;
  const records = new Map((takeoff.cable_runs ?? []).map((r) => [r.id, r]));
  const shapes = new Map(takeoff.shapes.map((s) => [s.id, s]));
  const conditionByTag = new Map(takeoff.conditions.map((c) => [c.finish_tag, c]));

  const runs: CableRun[] = [];
  for (const row of cable.runs) {
    const rec = records.get(row.run_id);
    const cond = conditionByTag.get(row.condition);
    const routeShapeIds = rec?.route_shape_ids ?? [];
    const run: CableRun = {
      runId: row.run_id,
      status: row.status,
      conditionKey: row.condition,
      conditionId: cond?.id ?? "",
      deviceType: row.device_type,
      cableType: row.cable_type,
      ...(row.medium ? { medium: row.medium } : {}),
      trId: row.tr_id ?? rec?.tr_id ?? "",
      trName: row.tr,
      deviceShapeIds: rec?.device_shape_ids ?? [],
      routeShapeIds,
      routeLf: row.route_lf,
      perCableLf: row.per_cable_lf ?? null,
      cables: row.cables ?? 0,
      locationLf: row.location_lf ?? null,
      multiplier: row.multiplier,
      review: row.review_status ?? "",
      overLength: row.over_length === true,
      limitFt: row.limit_ft ?? null,
      reason: row.reason ?? "",
    };
    runs.push(run);

    if (rec && run.status !== "broken") {
      // Cross-check: route LF = sum of the route shapes' stored plan length.
      let sum = 0;
      for (const id of routeShapeIds) {
        const c = shapes.get(id)?.computed;
        sum += c?.plan_lf ?? c?.perimeter_lf ?? 0;
      }
      const edited = routeShapeIds.filter((id) => editedShapeIds.has(id));
      if (Math.abs(r2(sum) - run.routeLf) > LF_TOLERANCE && edited.length) {
        issues.warn("route_edited", `run ${run.runId} (${run.conditionKey}): its route was edited in the Brink app (now ${r2(sum)} LF); the cable length on this BOM is still OpenTakeoff's report value from before the edit (${run.routeLf} LF route). Re-export the report from OpenTakeoff to update the cable math`, { conditionKey: run.conditionKey, refs: { runId: run.runId, editedShapeIds: edited } });
      } else if (Math.abs(r2(sum) - run.routeLf) > LF_TOLERANCE) {
        issues.error("route_lf_mismatch", `run ${run.runId} (${run.conditionKey}): the report says route ${run.routeLf} LF, the takeoff's route shapes sum to ${r2(sum)} LF; re-export both files from one session`, { conditionKey: run.conditionKey, refs: { runId: run.runId } });
      }
    }
    const goneDevices = (rec?.device_shape_ids ?? []).filter((id) => !shapes.has(id) && editedShapeIds.has(id));
    if (goneDevices.length) {
      issues.warn("run_device_edited", `run ${run.runId} (${run.conditionKey}): its device was deleted in the Brink app; the run's ${run.cables} cable(s) stay on this BOM from OpenTakeoff's report until the report is re-exported`, { conditionKey: run.conditionKey, refs: { runId: run.runId, deviceShapeIds: goneDevices } });
    }
    if (run.status !== "linked") {
      issues.warn("run_not_linked", `run ${run.runId} (${run.conditionKey}) is ${run.status}: ${run.reason || "no reason given"}; OpenTakeoff excludes it from cable totals, so its device has no cable on this BOM`, { conditionKey: run.conditionKey, refs: { runId: run.runId } });
    }
    if (run.overLength) {
      issues.warn("over_length", `run ${run.runId} (${run.conditionKey}) is ${run.perCableLf} ft per cable, over its ${run.limitFt ?? "?"} ft limit; it is counted, check the route`, { conditionKey: run.conditionKey, refs: { runId: run.runId } });
    }
  }

  for (const d of cable.unlinked.devices) {
    issues.warn("unlinked_device", `${d.finish_tag} device ${d.shape_id}${d.label ? ` (${d.label})` : ""} has no cable run: ${d.reason}; it is on the BOM with no cable`, { conditionKey: d.finish_tag, refs: { shapeId: d.shape_id } });
  }
  for (const r of cable.unlinked.routes) {
    issues.warn("unlinked_route", `${r.finish_tag} route segment ${r.shape_id} (${r.length_lf} LF) is used by no run: ${r.reason}`, { conditionKey: r.finish_tag, refs: { shapeId: r.shape_id } });
  }
  for (const h of cable.held ?? []) {
    issues.warn("held_device", `${h.finish_tag} device ${h.shape_id}${h.label ? ` (${h.label})` : ""} is held: ${h.reason}`, { conditionKey: h.finish_tag, refs: { shapeId: h.shape_id } });
  }
  const pending = runs.filter((r) => r.review === "pending").length;
  if (pending) {
    issues.warn("review_pending", `${pending} cable run(s) were linked by an agent and no person has accepted them in OpenTakeoff; they count, as OpenTakeoff counts them`);
  }
  for (const w of cable.warnings) issues.warn("ot_warning", `OpenTakeoff: ${w}`);

  return {
    runs,
    summary: cable.summary,
    order: cable.order?.rows ?? [],
    pathway: cable.pathway?.rows ?? [],
    unlinkedDevices: cable.unlinked.devices,
    unlinkedRoutes: cable.unlinked.routes,
    held: cable.held ?? [],
    warnings: cable.warnings,
  };
}
