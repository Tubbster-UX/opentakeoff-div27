import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Issues } from "./issues.js";
import { OT_REPORT_SCHEMA, OT_TAKEOFF_SCHEMA, type OtReport, type OtTakeoff } from "./ot/types.js";

export interface LoadedInput {
  takeoff: OtTakeoff;
  report: OtReport | null;
  takeoffSha256: string;
  reportSha256: string | null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readJsonFile(path: string): { value: unknown; text: string } {
  const text = readFileSync(path, "utf8");
  try {
    return { value: JSON.parse(text), text };
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Parse an OpenTakeoff takeoff export and (optionally) its export_report JSON. */
export function parseInput(takeoffText: string, reportText: string | null): LoadedInput {
  const takeoff = JSON.parse(takeoffText) as OtTakeoff;
  if (!takeoff || typeof takeoff !== "object" || !Array.isArray(takeoff.conditions) || !Array.isArray(takeoff.shapes)) {
    throw new Error("takeoff file is not an OpenTakeoff export (no conditions[] / shapes[])");
  }
  const report = reportText == null ? null : (JSON.parse(reportText) as OtReport);
  return { takeoff, report, takeoffSha256: sha256(takeoffText), reportSha256: reportText == null ? null : sha256(reportText) };
}

export function loadInput(takeoffPath: string, reportPath?: string | null): LoadedInput {
  const takeoffText = readFileSync(takeoffPath, "utf8");
  const reportText = reportPath ? readFileSync(reportPath, "utf8") : null;
  return parseInput(takeoffText, reportText);
}

/** Schema and pairing checks: a report from another takeoff would put wrong numbers in the bid. */
export function checkInput(input: LoadedInput, issues: Issues): void {
  const { takeoff, report } = input;
  if (takeoff.schema !== OT_TAKEOFF_SCHEMA) {
    issues.error("schema_mismatch", `takeoff schema is ${JSON.stringify(takeoff.schema)}, expected ${OT_TAKEOFF_SCHEMA}`);
  }
  const hasCable = (takeoff.cable_runs?.length ?? 0) > 0 || takeoff.conditions.some((c) => c.cable_setup || c.role);
  if (!report) {
    if (hasCable) {
      issues.error("report_missing", "the takeoff has Division 27 cable conditions or runs, but no export_report JSON was given: cable lengths come only from OpenTakeoff's report (pass --report)");
    }
    return;
  }
  if (report.schema !== OT_REPORT_SCHEMA) {
    issues.error("schema_mismatch", `report schema is ${JSON.stringify(report.schema)}, expected ${OT_REPORT_SCHEMA}`);
  }
  const takeoffIds = new Set(takeoff.conditions.map((c) => c.id));
  const reportIds = new Set((report.conditions ?? []).map((c) => c.id));
  const missing = [...takeoffIds].filter((id) => !reportIds.has(id));
  const extra = [...reportIds].filter((id) => !takeoffIds.has(id));
  if (missing.length || extra.length) {
    issues.error("report_mismatch", `the report does not belong to this takeoff: ${missing.length} condition(s) missing from the report, ${extra.length} not in the takeoff`, { refs: { missing, extra } });
  }
  const runIds = new Set((takeoff.cable_runs ?? []).filter((r) => !r.hold).map((r) => r.id));
  const reportRunIds = new Set((report.cable?.runs ?? []).map((r) => r.run_id));
  const runMissing = [...runIds].filter((id) => !reportRunIds.has(id));
  const runExtra = [...reportRunIds].filter((id) => !runIds.has(id));
  if (runMissing.length || runExtra.length) {
    issues.error("report_mismatch", `the report's cable runs do not match the takeoff's: ${runMissing.length} missing, ${runExtra.length} extra`, { refs: { runMissing, runExtra } });
  }
}
