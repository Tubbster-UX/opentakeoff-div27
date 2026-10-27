// Task 3: the Brink catalog map. One row per Division 27 condition, keyed on
// the condition's finish tag: Task 0 found no part identity in an OpenTakeoff
// export (lib_id points at a browser-local library entry that is not
// exported; cable_type is free text), so the tag is the join key. Rows are
// proposed until Alexavier confirms them. portalSku is Portal's numeric
// partId, read only by the Portal push (src/portal/).
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Issues } from "./issues.js";
import type { ConditionKind, ConditionRollup } from "./rollup.js";
import { CONNECTOR_TYPES, DEVICE_TYPES, SIGNAL_TYPES } from "./vendor/esEnums.generated.js";

const portSpec = z.object({
  signalType: z.string(),
  connectorType: z.string(),
  /** Passthrough devices (wall plates, patch panels): the field-termination face. */
  rearConnectorType: z.string().optional(),
});

export const catalogRowSchema = z.object({
  conditionKey: z.string().min(1),
  kind: z.enum(["device", "tr", "route", "plain"]),
  /** EasySchematic deviceType; null for a route (pathway, no device). */
  esDeviceType: z.string().nullable(),
  esTemplateRef: z.union([
    z.object({ manufacturer: z.string().nullable(), modelNumber: z.string().nullable() }),
    z.object({ templateId: z.string() }),
  ]).nullable(),
  /** Display name for the device template / BOM line. */
  label: z.string().nullable().optional(),
  /** The port each cable lands on (one per cable at a location). */
  port: portSpec.nullable().optional(),
  /** Expected OpenTakeoff cable_type (free text); a different value in the export is flagged. */
  cableType: z.string().nullable().optional(),
  portalSku: z.string().nullable(),
  status: z.enum(["proposed", "confirmed"]),
  note: z.string().optional(),
});
export type CatalogRow = z.infer<typeof catalogRowSchema>;

/**
 * Portal push (additive): the Portal part bought for one OpenTakeoff cable
 * type. Cable is pushed from OpenTakeoff's cable order lines (one per
 * cable_type), never from the per-condition cable lines. orderBasis says what
 * the Portal part's quantity counts: "box" = OpenTakeoff's box / reel count
 * (packageFt must equal the package OpenTakeoff rounded to), "ft" = whole feet
 * (OpenTakeoff's order LF rounded up). portalUnitOfMeasure is the Portal
 * part's unitOfMeasure exactly as /products/basicinfo returns it; a live push
 * aborts when they differ. See docs/portal-push.md.
 */
export const cablePartSchema = z.object({
  cableType: z.string().min(1),
  portalSku: z.string().nullable(),
  orderBasis: z.enum(["box", "ft"]),
  packageFt: z.number().positive().nullable().optional(),
  portalUnitOfMeasure: z.string().nullable().optional(),
  status: z.enum(["proposed", "confirmed"]),
  note: z.string().optional(),
});
export type CablePart = z.infer<typeof cablePartSchema>;

export const catalogMapSchema = z.object({
  version: z.literal(1),
  rows: z.array(catalogRowSchema),
  /** Portal push: cable type -> Portal part. Optional and additive. */
  cableParts: z.array(cablePartSchema).optional(),
});
export type CatalogMap = z.infer<typeof catalogMapSchema>;

export function parseCatalogMap(value: unknown): CatalogMap {
  const map = catalogMapSchema.parse(value);
  const seen = new Set<string>();
  for (const r of map.rows) {
    if (seen.has(r.conditionKey)) throw new Error(`catalog map lists ${r.conditionKey} twice`);
    seen.add(r.conditionKey);
  }
  const cables = new Set<string>();
  for (const c of map.cableParts ?? []) {
    if (cables.has(c.cableType)) throw new Error(`catalog map lists cable part ${c.cableType} twice`);
    cables.add(c.cableType);
  }
  return map;
}

export function loadCatalogMap(path: string): CatalogMap {
  return parseCatalogMap(JSON.parse(readFileSync(path, "utf8")));
}

const deviceTypes = new Set<string>(DEVICE_TYPES);
const signalTypes = new Set<string>(SIGNAL_TYPES);
const connectorTypes = new Set<string>(CONNECTOR_TYPES);

/** Enum problems in one row, worded for the issue list. */
export function rowEnumProblems(row: CatalogRow): { code: "invalid_device_type" | "invalid_signal_type" | "invalid_connector_type"; message: string }[] {
  const out: { code: "invalid_device_type" | "invalid_signal_type" | "invalid_connector_type"; message: string }[] = [];
  if (row.esDeviceType !== null && !deviceTypes.has(row.esDeviceType)) {
    out.push({ code: "invalid_device_type", message: `${row.conditionKey}: esDeviceType ${JSON.stringify(row.esDeviceType)} is not an EasySchematic device type` });
  }
  if (row.port) {
    if (!signalTypes.has(row.port.signalType)) out.push({ code: "invalid_signal_type", message: `${row.conditionKey}: signalType ${JSON.stringify(row.port.signalType)} is not an EasySchematic signal type` });
    for (const k of ["connectorType", "rearConnectorType"] as const) {
      const v = row.port[k];
      if (v !== undefined && !connectorTypes.has(v)) out.push({ code: "invalid_connector_type", message: `${row.conditionKey}: ${k} ${JSON.stringify(v)} is not an EasySchematic connector type` });
    }
  }
  return out;
}

export interface ResolvedMapping {
  /** conditionId -> usable row (mapped, valid, kind agrees). */
  byCondition: Map<string, CatalogRow>;
  unmapped: string[];
}

/**
 * Join every rolled-up condition to its row. A condition with no row, a row
 * whose kind disagrees with the condition, or a row with an enum EasySchematic
 * would reject is an error and the condition is left out of `byCondition`,
 * so the BOM carries it as an error line, never as a silent omission.
 */
export function resolveMapping(rollups: ConditionRollup[], map: CatalogMap, issues: Issues): ResolvedMapping {
  const rows = new Map(map.rows.map((r) => [r.conditionKey, r]));
  const byCondition = new Map<string, CatalogRow>();
  const unmapped: string[] = [];
  for (const c of rollups) {
    const row = rows.get(c.finishTag);
    if (!row) {
      unmapped.push(c.finishTag);
      issues.error("unmapped_condition", `${c.finishTag} (${c.kind}, ${c.shapeCount} shape(s)) has no row in the catalog map; add one to data/catalog-map.json or with the MCP map_condition tool`, { conditionKey: c.finishTag });
      continue;
    }
    if (row.kind !== c.kind) {
      issues.error("mapping_kind_mismatch", `${c.finishTag}: the catalog row is kind ${row.kind}, but the takeoff's condition is ${c.kind}${describeKind(c.kind)}`, { conditionKey: c.finishTag });
      continue;
    }
    const problems = rowEnumProblems(row);
    for (const p of problems) issues.error(p.code, p.message, { conditionKey: c.finishTag });
    if ((row.kind === "device" || row.kind === "tr") && !row.esDeviceType) {
      issues.error("invalid_device_type", `${c.finishTag}: a ${row.kind} row needs an esDeviceType`, { conditionKey: c.finishTag });
      continue;
    }
    if (problems.length) continue;
    if (row.status !== "confirmed") {
      issues.warn("mapping_unconfirmed", `${c.finishTag} -> ${row.esDeviceType ?? "pathway"}${modelText(row)} is a proposed mapping; confirm it before pricing`, { conditionKey: c.finishTag });
    }
    byCondition.set(c.conditionId, row);
  }
  return { byCondition, unmapped };
}

const describeKind = (k: ConditionKind): string =>
  k === "device" ? " (it carries a cable_setup)" : k === "tr" ? " (role tr)" : k === "route" ? " (role route)" : " (no cable setup or role)";

export function modelText(row: CatalogRow): string {
  const ref = row.esTemplateRef;
  if (!ref) return " (model not chosen)";
  if ("templateId" in ref) return ` (template ${ref.templateId})`;
  const m = [ref.manufacturer, ref.modelNumber].filter(Boolean).join(" ");
  return m ? ` (${m})` : " (model not chosen)";
}
