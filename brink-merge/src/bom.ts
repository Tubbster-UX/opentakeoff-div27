// Task 4: the normalized BOM. Every line carries where its number came from
// (source "opentakeoff", the condition, and the shapes or runs), and cable
// lines say their length is measured. Unmapped conditions keep their
// quantities on the BOM with mappingStatus "unmapped" plus an error line;
// nothing is dropped.
import type { CableData } from "./cable.js";
import { modelText, type CatalogRow, type ResolvedMapping } from "./catalog.js";
import type { Issue, Issues } from "./issues.js";
import type { OtReport, OtTakeoff } from "./ot/types.js";
import { r2, type ConditionRollup } from "./rollup.js";

export type BomKind = "device" | "tr" | "cable" | "cable_order" | "pathway" | "other" | "material" | "issue";

export interface BomProvenance {
  source: "opentakeoff";
  length?: "measured";
  conditionId?: string;
  shapeIds?: string[];
  runIds?: string[];
}

export interface BomLine {
  lineNo: number;
  kind: BomKind;
  conditionKey: string;
  description: string;
  qty: number;
  unit: "EA" | "LF" | "SF" | "BOX" | "";
  mappingStatus?: "confirmed" | "proposed" | "unmapped";
  esDeviceType?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  templateId?: string | null;
  portalSku?: string | null;
  multiplier?: number;
  wastePct?: number;
  /** Device lines: count of devices by room / zone label. */
  byLabel?: Record<string, number>;
  heldQty?: number;
  unlinkedQty?: number;
  /** Cable lines. */
  cableType?: string;
  medium?: string;
  tr?: string;
  pulls?: number;
  cables?: number;
  routeLf?: number;
  netLf?: number;
  orderLf?: number;
  overLengthRuns?: number;
  /** Cable order lines (box / reel rounding from OpenTakeoff). */
  packageFt?: number | null;
  boxes?: number | null;
  purchasedLf?: number | null;
  leftoverLf?: number | null;
  /** Issue lines. */
  severity?: Issue["severity"];
  code?: Issue["code"];
  note?: string;
  provenance: BomProvenance;
}

export interface Bom {
  project: string;
  lines: BomLine[];
  totals: { devices: number; trs: number; pulls: number; cables: number; cableNetLf: number; cableOrderLf: number; errors: number; warnings: number };
}

function modelFields(row: CatalogRow | undefined): Pick<BomLine, "manufacturer" | "modelNumber" | "templateId"> {
  const ref = row?.esTemplateRef;
  if (!ref) return { manufacturer: null, modelNumber: null, templateId: null };
  if ("templateId" in ref) return { manufacturer: null, modelNumber: null, templateId: ref.templateId };
  return { manufacturer: ref.manufacturer, modelNumber: ref.modelNumber, templateId: null };
}

export function buildBom(opts: {
  project: string;
  rollups: ConditionRollup[];
  cable: CableData;
  mapping: ResolvedMapping;
  takeoff: OtTakeoff;
  report: OtReport | null;
  issues: Issues;
}): Bom {
  const { rollups, cable, mapping, report, issues } = opts;
  const materialCount = new Map(opts.takeoff.conditions.map((c) => [c.id, c.materials?.length ?? 0]));
  const lines: Omit<BomLine, "lineNo">[] = [];
  const reportCond = new Map((report?.conditions ?? []).map((c) => [c.id, c]));
  const summaryByCond = new Map<string, typeof cable.summary>();
  for (const s of cable.summary) summaryByCond.set(s.condition_id, [...(summaryByCond.get(s.condition_id) ?? []), s]);
  const runsByCond = new Map<string, string[]>();
  for (const r of cable.runs) runsByCond.set(r.conditionId, [...(runsByCond.get(r.conditionId) ?? []), r.runId]);

  for (const c of rollups) {
    const row = mapping.byCondition.get(c.conditionId);
    const status: BomLine["mappingStatus"] = row ? row.status : "unmapped";
    const label = row?.label ?? c.finishTag;
    const base = {
      conditionKey: c.finishTag,
      mappingStatus: status,
      esDeviceType: row?.esDeviceType ?? null,
      ...modelFields(row),
      portalSku: row?.portalSku ?? null,
      multiplier: c.multiplier,
      wastePct: c.wastePct,
    };
    const rep = reportCond.get(c.conditionId);
    if (rep && (c.kind === "device" || c.kind === "tr") && typeof rep.ea === "number" && Math.abs(rep.ea - c.net.count) > 1e-9) {
      issues.error("report_mismatch", `${c.finishTag}: the takeoff rolls up to ${c.net.count} EA, the report says ${rep.ea}`, { conditionKey: c.finishTag });
    }

    if (c.kind === "device" || c.kind === "tr") {
      const rows = summaryByCond.get(c.conditionId) ?? [];
      lines.push({
        ...base,
        kind: c.kind,
        description: `${label}${row ? modelText(row) : " (unmapped)"}`,
        qty: c.net.count,
        unit: "EA",
        byLabel: c.countByLabel,
        ...(c.kind === "device" ? { heldQty: rows.reduce((a, s) => a + s.held_devices, 0), unlinkedQty: rows.reduce((a, s) => a + s.unlinked_devices, 0) } : {}),
        provenance: { source: "opentakeoff", conditionId: c.conditionId, shapeIds: c.shapeIds },
      });
      if (c.kind === "device") {
        for (const s of rows) {
          if (row?.cableType && s.cable_type !== row.cableType) {
            issues.warn("cable_type_mismatch", `${c.finishTag}: the takeoff's cable type is ${JSON.stringify(s.cable_type)}, the catalog row expects ${JSON.stringify(row.cableType)}`, { conditionKey: c.finishTag });
          }
          lines.push({
            ...base,
            kind: "cable",
            description: `${s.cable_type || "(no cable type)"} to ${s.tr_name || s.tr_id || "(no TR: no linked run)"}`,
            qty: s.cable_lf,
            unit: "LF",
            cableType: s.cable_type,
            ...(s.medium ? { medium: s.medium } : {}),
            tr: s.tr_name || s.tr_id || "",
            pulls: s.pulls,
            cables: s.cables,
            routeLf: s.route_lf,
            netLf: s.cable_lf,
            orderLf: s.cable_lf_order,
            overLengthRuns: s.over_length_runs,
            provenance: { source: "opentakeoff", length: "measured", conditionId: c.conditionId, runIds: cable.runs.filter((r) => r.conditionId === c.conditionId && r.trId === (s.tr_id ?? "") && r.status === "linked").map((r) => r.runId) },
          });
        }
      }
    } else if (c.kind === "route") {
      const p = cable.pathway.find((x) => x.condition_id === c.conditionId);
      lines.push({
        ...base,
        kind: "pathway",
        description: `${label}${p?.route_kind ? ` (${p.route_kind})` : ""}: pathway, not a cable quantity`,
        qty: p ? p.pathway_lf_total : c.net.linearLf,
        unit: "LF",
        routeLf: p ? p.pathway_lf : c.measured.planLf,
        provenance: { source: "opentakeoff", length: "measured", conditionId: c.conditionId, shapeIds: c.shapeIds },
      });
    } else {
      const unit: BomLine["unit"] = c.net.count ? "EA" : c.net.linearLf ? "LF" : c.net.areaSf ? "SF" : "";
      lines.push({
        ...base,
        kind: "other",
        description: label,
        qty: unit === "EA" ? c.net.count : unit === "LF" ? c.net.linearLf : unit === "SF" ? c.net.areaSf : 0,
        unit,
        provenance: { source: "opentakeoff", conditionId: c.conditionId, shapeIds: c.shapeIds },
      });
    }

    // Supporting materials: OpenTakeoff figures them (incl. the cables / pulls bases).
    if (rep?.materials?.length) {
      for (const m of rep.materials) {
        lines.push({ ...base, kind: "material", description: m.name, qty: m.qty, unit: (m.unit as BomLine["unit"]) ?? "", ...(m.reason ? { note: m.reason } : {}), provenance: { source: "opentakeoff", conditionId: c.conditionId } });
      }
    } else if (!report && (materialCount.get(c.conditionId) ?? 0) > 0) {
      issues.warn("report_missing", `${c.finishTag} has supporting-materials rows; their quantities come from OpenTakeoff's report, which was not given`, { conditionKey: c.finishTag });
    }
  }

  for (const o of cable.order) {
    lines.push({
      conditionKey: o.conditions.join(", "),
      kind: "cable_order",
      description: `${o.cable_type || "(no cable type)"}: ${o.boxes != null ? `${o.boxes} x ${o.package_ft} ft box/reel` : "no box size stated"}`,
      qty: o.boxes ?? o.order_lf,
      unit: o.boxes != null ? "BOX" : "LF",
      cableType: o.cable_type,
      orderLf: o.order_lf,
      packageFt: o.package_ft,
      boxes: o.boxes,
      purchasedLf: o.purchased_lf,
      leftoverLf: o.leftover_lf,
      ...(o.note ? { note: o.note } : {}),
      provenance: { source: "opentakeoff", length: "measured" },
    });
  }

  return { project: opts.project, lines: lines.map((l, i) => ({ lineNo: i + 1, ...l })), totals: emptyTotals() };
}

const emptyTotals = (): Bom["totals"] => ({ devices: 0, trs: 0, pulls: 0, cables: 0, cableNetLf: 0, cableOrderLf: 0, errors: 0, warnings: 0 });

/** Append one issue line per issue (after every stage has reported) and total the BOM. */
export function finalizeBom(bom: Bom, issues: Issues): Bom {
  const lines: BomLine[] = bom.lines.filter((l) => l.kind !== "issue");
  for (const i of issues.list) {
    lines.push({ lineNo: 0, conditionKey: i.conditionKey ?? "", kind: "issue", description: i.message, qty: 0, unit: "", severity: i.severity, code: i.code, provenance: { source: "opentakeoff" } });
  }
  lines.forEach((l, i) => (l.lineNo = i + 1));
  const sum = (k: BomKind, f: (l: BomLine) => number) => r2(lines.filter((l) => l.kind === k).reduce((a, l) => a + f(l), 0));
  return {
    project: bom.project,
    lines,
    totals: {
      devices: sum("device", (l) => l.qty),
      trs: sum("tr", (l) => l.qty),
      pulls: sum("cable", (l) => l.pulls ?? 0),
      cables: sum("cable", (l) => l.cables ?? 0),
      cableNetLf: sum("cable", (l) => l.netLf ?? 0),
      cableOrderLf: sum("cable", (l) => l.orderLf ?? 0),
      errors: issues.list.filter((i) => i.severity === "error").length,
      warnings: issues.list.filter((i) => i.severity === "warning").length,
    },
  };
}

const CSV_COLUMNS: (keyof BomLine | "source" | "length" | "runIds")[] = [
  "lineNo", "kind", "conditionKey", "description", "qty", "unit", "mappingStatus", "esDeviceType", "manufacturer", "modelNumber", "templateId", "portalSku",
  "multiplier", "wastePct", "heldQty", "unlinkedQty", "cableType", "medium", "tr", "pulls", "cables", "routeLf", "netLf", "orderLf", "overLengthRuns",
  "packageFt", "boxes", "purchasedLf", "leftoverLf", "severity", "code", "note", "byLabel", "source", "length", "runIds",
];

const csvCell = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, n]) => `${k || "(unlabeled)"}: ${n}`).join("; ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function bomToCsv(bom: Pick<Bom, "lines">): string {
  const out = [CSV_COLUMNS.join(",")];
  for (const l of bom.lines) {
    out.push(CSV_COLUMNS.map((k) => {
      if (k === "source") return csvCell(l.provenance.source);
      if (k === "length") return csvCell(l.provenance.length);
      if (k === "runIds") return csvCell(l.provenance.runIds?.join(" "));
      return csvCell(l[k as keyof BomLine]);
    }).join(","));
  }
  return out.join("\n") + "\n";
}
