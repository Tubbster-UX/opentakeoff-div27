import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalogMap, type CatalogMap } from "../src/catalog.js";
import { parseInput, type LoadedInput } from "../src/load.js";

export const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const MAP_PATH = fileURLToPath(new URL("../data/catalog-map.json", import.meta.url));

/** A real OpenTakeoff export pair (fixtures/generate/README.md says how it was made). */
export function load(name: "div27-sample" | "div27-minimal", withReport = true): LoadedInput {
  return parseInput(readFileSync(fixture(`${name}.takeoff.json`), "utf8"), withReport ? readFileSync(fixture(`${name}.report.json`), "utf8") : null);
}

export function catalog(): CatalogMap {
  return loadCatalogMap(MAP_PATH);
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * The same export pair with one device marker deleted, as OpenTakeoff would export it after the
 * estimator deleted it: the shape goes, and so does its cable run (from the takeoff and the report).
 */
export function withoutDevice(input: LoadedInput, shapeId: string): LoadedInput {
  const takeoff = clone(input.takeoff);
  const report = clone(input.report);
  const shape = takeoff.shapes.find((s) => s.id === shapeId);
  if (!shape) throw new Error(`no shape ${shapeId}`);
  const runs = new Set((takeoff.cable_runs ?? []).filter((r) => r.device_shape_ids.includes(shapeId)).map((r) => r.id));
  takeoff.shapes = takeoff.shapes.filter((s) => s.id !== shapeId);
  takeoff.cable_runs = (takeoff.cable_runs ?? []).filter((r) => !runs.has(r.id));
  if (report) {
    // OpenTakeoff's report totals drop the device too (the BOM cross-checks the condition's EA).
    const cond = report.conditions?.find((c) => c.id === shape.condition_id) as { ea?: number; shape_count?: number; multiplier?: number } | undefined;
    if (cond) {
      cond.ea = (cond.ea ?? 0) - (shape.computed?.count ?? 1) * (cond.multiplier ?? 1);
      cond.shape_count = (cond.shape_count ?? 1) - 1;
    }
    if (report.cable) {
      for (const run of report.cable.runs.filter((r) => runs.has(r.run_id))) {
        const row = report.cable.summary.find((s) => s.condition_id === shape.condition_id && s.tr_name === run.tr);
        if (!row) continue;
        const r2 = (n: number) => Math.round(n * 100) / 100;
        row.ea -= 1;
        row.pulls -= 1;
        row.cables -= run.cables ?? 0;
        row.route_lf = r2(row.route_lf - run.route_lf);
        row.cable_lf = r2(row.cable_lf - (run.location_lf ?? 0));
        row.cable_lf_order = r2(row.cable_lf_order - (run.location_lf ?? 0) * (1 + row.waste_pct / 100));
      }
      report.cable.runs = report.cable.runs.filter((r) => !runs.has(r.run_id));
    }
  }
  const takeoffText = JSON.stringify(takeoff);
  const reportText = report ? JSON.stringify(report) : null;
  return parseInput(takeoffText, reportText);
}
