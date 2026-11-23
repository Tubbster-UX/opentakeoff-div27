// The pull schedule: one row per cable of the install design, in a stable
// order (home-run rack, destination room, label), as the drawing package's
// schedule sheets print it, as CSV for label-printer software and as a
// workbook with one tab per rack. Lengths are the takeoff's measured
// per-cable lengths; a cable with no measured route keeps a blank length and
// says so in its notes, never a guess.
import ExcelJS from "exceljs";
import type { CableKind, InstallDesign, InstallEquipment } from "../installTypes.ts";
import type { ProjectManifest } from "../types.ts";

export interface PullRow {
  label: string;
  kind: CableKind;
  cableType: string;
  fromRack: string;
  fromEquipment: string;
  /** The port as printed on the gear when the equipment lists it, else as the cable end names it. */
  fromPort: string;
  toDevice: string;
  toRoom: string;
  lengthFt: number | null;
  spare: boolean;
  notes: string;
}

export const LENGTH_NOT_MEASURED = "length not measured: field-measure before cutting";

/** Natural order ("D2" before "D10"), case-insensitive. */
export const naturalCompare = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" }).compare;

/** Compare with blanks sorted last. */
function cmpBlankLast(a: string, b: string): number {
  if (!a && b) return 1;
  if (a && !b) return -1;
  return naturalCompare(a, b);
}

/** A port's printed label: matched by id first, then by label; the raw value when the equipment does not list it. */
export function portLabel(equipment: InstallEquipment | undefined, port: string | undefined): string {
  if (!port) return "";
  const p = equipment?.ports.find((x) => x.id === port) ?? equipment?.ports.find((x) => x.label === port);
  return p ? p.label : port;
}

export function pullScheduleRows(design: InstallDesign): PullRow[] {
  const equipment = new Map(design.equipment.map((e) => [e.tag, e]));
  const devices = new Map(design.devices.map((d) => [d.tag, d]));
  const rows = design.cables.map((c): PullRow => {
    const dev = devices.get(c.to.equipment);
    const notes = [c.notes?.trim() ?? "", c.lengthFt == null ? LENGTH_NOT_MEASURED : ""].filter(Boolean).join("; ");
    return {
      label: c.label,
      kind: c.kind,
      cableType: c.cableType,
      fromRack: c.from.rack ?? dev?.rack ?? "",
      fromEquipment: c.from.equipment,
      fromPort: portLabel(equipment.get(c.from.equipment), c.from.port),
      toDevice: c.to.equipment,
      toRoom: (dev?.room ?? c.to.location ?? "").trim(),
      lengthFt: c.lengthFt != null && Number.isFinite(c.lengthFt) ? c.lengthFt : null,
      spare: !!c.spare,
      notes,
    };
  });
  return rows.sort((a, b) => cmpBlankLast(a.fromRack, b.fromRack) || cmpBlankLast(a.toRoom, b.toRoom) || naturalCompare(a.label, b.label));
}

/** Feet to one decimal, trailing ".0" dropped; "" for null. */
export function fmtFt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Math.round(n * 10) / 10);
}

export const SCHEDULE_COLUMNS = [
  "Label", "Kind", "Cable type", "From rack", "From equipment", "From port", "To device", "To room", "Length ft", "Spare", "Notes",
] as const;

function rowValues(r: PullRow): string[] {
  return [r.label, r.kind, r.cableType, r.fromRack, r.fromEquipment, r.fromPort, r.toDevice, r.toRoom, fmtFt(r.lengthFt), r.spare ? "Yes" : "", r.notes];
}

/** Label-printer importers read one line per record: line breaks inside a field become " / ". */
function csvField(raw: string): string {
  const v = raw.replace(/\s*\r?\n\s*/g, " / ");
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV (CRLF), UTF-8, header row, one row per cable. */
export function renderPullScheduleCsv(design: InstallDesign): string {
  const lines = [SCHEDULE_COLUMNS.map(csvField).join(",")];
  for (const r of pullScheduleRows(design)) lines.push(rowValues(r).map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

const NAVY = "FF1B3055";
const WIDTHS = [10, 9, 22, 11, 15, 10, 14, 20, 10, 7, 44];

/** A tab name Excel accepts (31 chars, none of []:*?/\), unique in the workbook. */
function tabName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, "-").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function fillTab(ws: ExcelJS.Worksheet, rows: PullRow[]): void {
  ws.columns = SCHEDULE_COLUMNS.map((h, i) => ({ header: h, key: `c${i}`, width: WIDTHS[i] }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  head.alignment = { vertical: "middle" };
  for (const r of rows) {
    const v = rowValues(r);
    const row = ws.addRow([...v.slice(0, 8), r.lengthFt ?? null, v[9], v[10]]);
    row.getCell(9).numFmt = "0.0";
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: SCHEDULE_COLUMNS.length } };
}

/** The workbook: "All cables" first, then one tab per rack (cables with no rack on a "No rack" tab). */
export async function renderPullScheduleXlsx(design: InstallDesign, project: ProjectManifest): Promise<Uint8Array> {
  const rows = pullScheduleRows(design);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Install package";
  wb.title = `${project.name} pull schedule r${design.revision}`;
  wb.created = new Date(design.created);
  const used = new Set<string>();
  fillTab(wb.addWorksheet(tabName("All cables", used), { properties: { tabColor: { argb: NAVY } } }), rows);
  const racks = [...design.racks.map((r) => r.id)];
  for (const r of rows) if (r.fromRack && !racks.includes(r.fromRack)) racks.push(r.fromRack);
  for (const id of racks) {
    const mine = rows.filter((r) => r.fromRack === id);
    if (!mine.length && !design.racks.some((r) => r.id === id)) continue;
    fillTab(wb.addWorksheet(tabName(id, used)), mine);
  }
  const orphan = rows.filter((r) => !r.fromRack);
  if (orphan.length) fillTab(wb.addWorksheet(tabName("No rack", used)), orphan);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
