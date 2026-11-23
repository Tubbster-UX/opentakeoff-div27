// The install design check (src/installTypes.ts InstallDesign): what keeps a
// design from going to the crews. Pure. Errors first, then warnings, each in
// the order found. The owner cannot approve while any error stands
// (src/installApproval.ts).
//
// Rack power: the sum of the rack's equipment watts against its circuits at
// 80 % continuous (amps × volts, 120 V when a circuit states none); the heat
// (watts × 3.412 BTU/hr) is in the issue text. Equipment with unknown watts
// is a "power_unknown" warning: never guessed.
import type { Connection, InstallDesign, InstallIssue, Rack } from "../installTypes.ts";
import { DEFAULT_PATTERN, validateLabelScheme } from "./labels.ts";

/** TIA-568 copper permanent link limit (90 m) as the trade carries it. */
export const COPPER_LIMIT_FT = 295;
export const DEFAULT_VOLTS = 120;
export const CONTINUOUS_FACTOR = 0.8;
export const BTU_PER_WATT = 3.412;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Errors first; the order found is kept within each severity. */
export function sortIssues(issues: InstallIssue[]): InstallIssue[] {
  return [...issues.filter((i) => i.severity === "error"), ...issues.filter((i) => i.severity !== "error")];
}

/** Equipment tags that are passthrough panels: a field cable on the rear and a patch on the front of one port are both allowed. */
export function panelTags(design: Pick<InstallDesign, "racks" | "equipment">): Set<string> {
  const out = new Set<string>();
  for (const r of design.racks) for (const it of r.items) if (it.kind === "panel") out.add(it.tag);
  for (const e of design.equipment) if (/^(PP|FP)-\d+$/.test(e.tag)) out.add(e.tag);
  return out;
}

/** The key a connection end occupies (a panel port has a field face and a patch face). */
export function portUseKey(conn: Pick<Connection, "cable">, equipment: string, port: string, panels: Set<string>): string {
  return panels.has(equipment) ? `${equipment}\u0000${port}\u0000${conn.cable ? "field" : "patch"}` : `${equipment}\u0000${port}`;
}

/** Rack power figures (null capacity when no circuit is stated). */
export function rackPower(design: Pick<InstallDesign, "equipment">, rack: Rack): { watts: number; unknown: string[]; capacityW: number | null; btuHr: number } {
  let watts = 0;
  const unknown: string[] = [];
  for (const e of design.equipment) {
    if (e.rack !== rack.id) continue;
    if (typeof e.watts === "number" && Number.isFinite(e.watts)) watts += e.watts;
    else unknown.push(e.tag);
  }
  const circuits = rack.circuits ?? [];
  const capacityW = circuits.length ? circuits.reduce((a, c) => a + c.amps * (c.volts ?? DEFAULT_VOLTS) * CONTINUOUS_FACTOR, 0) : null;
  return { watts: r1(watts), unknown, capacityW: capacityW == null ? null : r1(capacityW), btuHr: r1(watts * BTU_PER_WATT) };
}

export function checkInstallDesign(design: InstallDesign): InstallIssue[] {
  const out: InstallIssue[] = [];
  const err = (code: string, message: string, ref?: string) => out.push({ severity: "error", code, message, ...(ref ? { ref } : {}) });
  const warn = (code: string, message: string, ref?: string) => out.push({ severity: "warning", code, message, ...(ref ? { ref } : {}) });

  // ── label scheme ─────────────────────────────────────────────────────────
  const ls = design.labelScheme;
  const lp = validateLabelScheme(ls);
  for (const e of lp.errors) err("label_scheme_invalid", `Label scheme: ${e}.`);
  if (ls.source === "spec" && !ls.reference?.trim()) {
    err("label_scheme_unreferenced", "The label scheme says it comes from the spec but names no reference: set_label_scheme with the labeling clause (e.g. \"27 05 53 3.2.B\").");
  } else if (ls.source !== "spec" && ls.pattern !== DEFAULT_PATTERN) {
    err("label_scheme_unreferenced", `The label pattern ${JSON.stringify(ls.pattern)} is not the default and names no spec reference: a non-default scheme comes from the job's labeling section (source "spec" + reference).`);
  }

  // ── duplicates ───────────────────────────────────────────────────────────
  const dup = <T>(items: T[], key: (t: T) => string) => {
    const seen = new Map<string, number>();
    for (const t of items) { const k = key(t); seen.set(k, (seen.get(k) ?? 0) + 1); }
    return [...seen].filter(([k, n]) => k && n > 1).map(([k, n]) => ({ k, n }));
  };
  for (const c of design.cables) if (!c.label?.trim()) err("label_missing", `A cable to ${c.to.equipment} ${c.to.port ?? ""} has no label.`.replace(/ +\./, "."), c.to.equipment);
  for (const { k, n } of dup(design.cables, (c) => c.label)) err("label_duplicate", `Cable label ${k} is used ${n} times.`, k);
  for (const { k, n } of dup(design.devices, (d) => d.tag)) err("tag_duplicate", `Device tag ${k} is used ${n} times.`, k);
  for (const { k, n } of dup(design.equipment, (e) => e.tag)) err("tag_duplicate", `Equipment tag ${k} is used ${n} times.`, k);
  for (const { k, n } of dup(design.racks, (r) => r.id)) err("tag_duplicate", `Rack id ${k} is used ${n} times.`, k);

  // ── equipment, ports and connections ─────────────────────────────────────
  const eqByTag = new Map(design.equipment.map((e) => [e.tag, e]));
  const rackById = new Map(design.racks.map((r) => [r.id, r]));
  const panels = panelTags(design);
  const hasPort = (eq: string, port: string) => !!eqByTag.get(eq)?.ports.some((p) => p.id === port);
  const used = new Map<string, string>();
  for (const conn of design.connections) {
    for (const end of [conn.from, conn.to]) {
      if (!eqByTag.has(end.equipment)) { err("connection_missing_end", `Connection ${conn.id} goes to equipment ${end.equipment}, which is not in the design.`, conn.id); continue; }
      if (!hasPort(end.equipment, end.port)) { err("connection_missing_end", `Connection ${conn.id} goes to ${end.equipment} port ${end.port}, which that equipment does not have.`, conn.id); continue; }
      const k = portUseKey(conn, end.equipment, end.port, panels);
      const other = used.get(k);
      if (other && other !== conn.id) err("port_double_used", `${end.equipment} port ${end.port} is used by connections ${other} and ${conn.id}.`, `${end.equipment}:${end.port}`);
      else used.set(k, conn.id);
    }
  }
  const cableEnds = new Map<string, string>();
  for (const c of design.cables) {
    for (const [side, end] of [["rack", c.from], ["field", c.to]] as const) {
      if (!end.equipment) { err("cable_end_missing", `Cable ${c.label}: the ${side} end names no equipment.`, c.label); continue; }
      if (!eqByTag.has(end.equipment)) { err("cable_end_missing", `Cable ${c.label}: the ${side} end ${end.equipment} is not in the design.`, c.label); continue; }
      if (!end.port || !hasPort(end.equipment, end.port)) { err("cable_end_missing", `Cable ${c.label}: ${end.equipment} has no port ${end.port ?? "(none)"}.`, c.label); continue; }
      const k = `${end.equipment}\u0000${end.port}`;
      const other = cableEnds.get(k);
      if (other) err("port_double_used", `${end.equipment} port ${end.port} terminates cables ${other} and ${c.label}.`, `${end.equipment}:${end.port}`);
      else cableEnds.set(k, c.label);
    }
    if (c.from.rack && !rackById.has(c.from.rack)) err("rack_missing", `Cable ${c.label} homes to rack ${c.from.rack}, which is not in the design.`, c.label);
  }

  // ── racks ────────────────────────────────────────────────────────────────
  for (const r of design.racks) {
    if (!(r.sizeRU > 0)) err("rack_size_unknown", `Rack ${r.id} (${r.name}) has no size: set_rack sizeRU from the drawings, the spec or the rack's model (no assumed size).`, r.id);
    const spans: { tag: string; lo: number; hi: number }[] = [];
    for (const it of r.items) {
      if (!Number.isInteger(it.ruTop) || !Number.isInteger(it.ruHeight) || it.ruHeight < 1) { err("ru_invalid", `Rack ${r.id}: ${it.tag} has RU top ${it.ruTop} and height ${it.ruHeight} (whole numbers, height 1 or more).`, `${r.id}:${it.tag}`); continue; }
      const lo = it.ruTop - it.ruHeight + 1;
      if (lo < 1 || (r.sizeRU > 0 && it.ruTop > r.sizeRU)) err("ru_outside", `Rack ${r.id}: ${it.tag} sits at RU ${lo}-${it.ruTop}, outside the rack (RU 1-${r.sizeRU > 0 ? r.sizeRU : "?"}).`, `${r.id}:${it.tag}`);
      for (const s of spans) if (lo <= s.hi && s.lo <= it.ruTop) err("ru_overlap", `Rack ${r.id}: ${it.tag} (RU ${lo}-${it.ruTop}) overlaps ${s.tag} (RU ${s.lo}-${s.hi}).`, `${r.id}:${it.tag}`);
      spans.push({ tag: it.tag, lo, hi: it.ruTop });
      if ((it.kind === "equipment" || it.kind === "panel") && !eqByTag.has(it.tag)) err("rack_item_missing", `Rack ${r.id}: item ${it.tag} is not in the equipment list.`, `${r.id}:${it.tag}`);
    }
    const pw = rackPower(design, r);
    const heat = `${pw.watts} W known, about ${pw.btuHr} BTU/hr of heat`;
    if (pw.unknown.length) warn("power_unknown", `Rack ${r.id}: no wattage for ${pw.unknown.join(", ")} (record_equipment from the spec sheet); ${heat} so far.`, r.id);
    const powered = pw.watts > 0 || pw.unknown.some((t) => !panels.has(t));
    if (pw.capacityW == null) {
      if (powered) warn("rack_circuit_unknown", `Rack ${r.id}: ${heat}, but no branch circuit is stated (set_rack circuits from the electrical drawings).`, r.id);
    } else if (pw.watts > pw.capacityW) {
      err("rack_power_over", `Rack ${r.id}: ${heat} exceeds its circuits' ${pw.capacityW} W at 80% continuous.`, r.id);
    }
  }
  for (const e of design.equipment) {
    if (!e.rack) continue;
    const r = rackById.get(e.rack);
    if (!r) err("rack_missing", `Equipment ${e.tag} is in rack ${e.rack}, which is not in the design.`, e.tag);
    else if (!r.items.some((it) => it.tag === e.tag)) warn("equipment_unplaced", `Equipment ${e.tag} belongs to rack ${e.rack} but has no RU position (place_in_rack).`, e.tag);
  }

  // ── cables ───────────────────────────────────────────────────────────────
  for (const c of design.cables) {
    if (c.lengthFt == null) warn("length_unmeasured", `Cable ${c.label} has no measured length (its run has no measured route in the takeoff).`, c.label);
    else if (c.kind === "data" && c.lengthFt > COPPER_LIMIT_FT) warn("cable_over_length", `Cable ${c.label} is ${c.lengthFt} ft, over the ${COPPER_LIMIT_FT} ft TIA-568 copper link limit: check the route or the TR.`, c.label);
  }

  // ── devices and mounting ─────────────────────────────────────────────────
  for (const d of design.devices) if (!d.room) warn("room_unknown", `Device ${d.tag} is in no labeled room (set_device room, or label the room's floor area in the takeoff).`, d.tag);
  const mountByType = new Map(design.mounting.map((m) => [m.deviceType, m]));
  const types = [...new Set(design.devices.map((d) => d.deviceType))];
  for (const t of types) {
    const md = mountByType.get(t);
    if (md?.heightAff?.trim()) continue;
    const missing = design.devices.filter((d) => d.deviceType === t && !d.mountingHeight?.trim());
    if (missing.length) err("mounting_height_unset", `No mounting height for ${t} (${missing.length} device${missing.length === 1 ? "" : "s"}): set_mounting from the spec or the drawing legend.`, t);
  }
  return sortIssues(out);
}
