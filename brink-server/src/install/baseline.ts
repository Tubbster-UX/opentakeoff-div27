// The install design's first draft from the takeoff document
// (session.exportPayload(), "opentakeoff.takeoff_canvas.v1"). Pure.
//
//   devices      one per count marker on a cable condition (or named by a run);
//                tag = type prefix + "-" + floor + 2-digit sequence ("WAP-102");
//                room = the label of the smallest labeled floor-area / deduct
//                polygon on the same sheet that contains the marker
//   racks        one per TR marker, "RK-<floor><seq:2>", sizeRU 0 until set
//   panels       per rack: one 24-port panel for up to 24 cables, else 48-port
//                panels; top down with a 1RU manager between panels; ports in
//                order of room then device tag (fiber on its own "FP" panels)
//   cables       one per cable of each linked run, at the run's measured
//                per-cable length (the web cable library's, never estimated)
//   connections  one per field cable, panel port ↔ device port
//   mounting     one detail per device type, heights blank until Claude sets them
//
// Withheld, broken or held runs and unlinked devices are issues, not cables.
// With `previous`, everything Claude or the owner set on the last revision is
// kept for the same shape / run / rack / equipment tag; removed items are issues.
import type {
  CableKind, Connection, EquipmentPort, InstallCable, InstallDesign, InstallDevice, InstallEquipment, InstallIssue, MountingDetail, Rack, RackItem,
} from "../installTypes.ts";
import { applyLabelScheme, defaultLabelScheme } from "./labels.ts";
import { checkInstallDesign, panelTags, sortIssues } from "./check.ts";

type CableLib = typeof import("opentakeoff-web-cable");
type ResolvedRun = import("opentakeoff-web-cable").ResolvedRun;
const cableLib = (await import(new URL("../../../web/src/lib/cable.js", import.meta.url).href)) as CableLib;

// ── the takeoff document, as far as the install design reads it ──────────────

export interface InstallTakeoff {
  schema?: string;
  sheets?: { sheet_id: string; units_per_px: number; scale_confirmed?: false }[];
  conditions?: unknown[];
  shapes?: unknown[];
  cable_runs?: unknown[];
  [k: string]: unknown;
}
interface TakeoffCondition {
  id: string;
  finish_tag: string;
  multiplier?: number;
  role?: string;
  cable_setup?: { device_type?: string; cable_type?: string; cables_per_location?: number } | null;
  [k: string]: unknown;
}
interface TakeoffShape {
  id: string;
  condition_id: string;
  sheet_id: string;
  measure_role: string;
  verts_norm?: [number, number][];
  verts_norm_holes?: [number, number][][];
  label?: string;
  [k: string]: unknown;
}

export interface DraftArgs {
  takeoff: InstallTakeoff;
  project: string;
  bidRevision?: number;
  previous?: InstallDesign | null;
  /** ISO time for `created`; default now. */
  now?: string;
  /** Loaded sheets in plan order with their sheet numbers (session.sheets); default the takeoff's sheet order. */
  sheets?: { key: string; number?: string | null }[];
}

/** Issue codes that come from the takeoff at draft time (kept as they are until the next install_draft). */
export const TAKEOFF_ISSUE_CODES = new Set([
  "device_unlinked", "device_held", "run_withheld", "run_broken", "run_pending", "cable_type_unset", "multiplier_ignored",
  "device_removed", "rack_removed", "cable_removed", "connection_dropped", "equipment_rack_removed", "takeoff_empty",
]);

// ── small helpers ───────────────────────────────────────────────────────────

const r1 = (n: number) => Math.round(n * 10) / 10;
const pad2 = (n: number) => String(n).padStart(2, "0");
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export const UNKNOWN_ROOM = "(room unknown)";

/** Cable kind from the takeoff's cable type text. */
export function kindOfCableType(t: string | null | undefined): CableKind {
  const s = (t ?? "").toLowerCase();
  if (!s.trim()) return "other";
  if (/\b(om[1-5]|os[12])\b|fib(er|re)|single[- ]?mode|multi[- ]?mode|\bsmf\b|\bmmf\b/.test(s)) return "fiber";
  if (/\bcat\s?-?\d|\butp\b|\bstp\b|\bftp\b/.test(s)) return "data";
  if (/\brg-?\d+|coax/.test(s)) return "coax";
  if (/\b1[0246]\s*\/\s*[24]\b|speaker/.test(s)) return "speaker";
  if (/hdmi|hdbaset|displayport/.test(s)) return "video";
  if (/\b(18|20|22|24)\s*\/\s*\d+\b|\brs-?232\b|control/.test(s)) return "control";
  return "other";
}

/** The signal a port carries for a cable kind. */
export function signalOf(kind: CableKind): string {
  return ({ data: "ethernet", video: "hdmi", fiber: "fiber", speaker: "speaker", audio: "line-audio", control: "control", coax: "rf", power: "power", other: "other" } as Record<CableKind, string>)[kind];
}

const PREFIX: Record<string, string> = { wall_outlet: "DO", wap: "WAP", camera: "CAM", access_door: "ACD", tv: "TV", display: "TV", speaker: "SPK" };

/** Tag prefix by device type, else by the condition tag's words / letters. */
export function tagPrefix(deviceType: string, finishTag: string): string {
  if (PREFIX[deviceType]) return PREFIX[deviceType];
  const ft = finishTag ?? "";
  if (/\b(tv|display|monitor)\b/i.test(ft)) return "TV";
  if (/speaker|\bspkr?\b/i.test(ft)) return "SPK";
  const letters = ft.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  return letters || "DEV";
}

const TYPE_TITLES: Record<string, string> = {
  wall_outlet: "Wall outlet", wap: "Wireless access point", camera: "Camera", access_door: "Access control door",
  ceiling_other: "Ceiling device", custom: "Device",
};

/**
 * The floor number a sheet name states, or null: "LEVEL 2" / "FLOOR 3" / "L2",
 * "1st" / "2ND FLOOR", or a sheet number whose hundreds digit is the floor
 * ("T-201", "E101", "E1.01").
 */
export function floorFromName(name: string | null | undefined): number | null {
  if (!isStr(name)) return null;
  const s = name.replace(/\.pdf$/i, "");
  let m = /\b(?:level|lvl|floor|flr)\s*[-#]?\s*(\d{1,2})\b/i.exec(s) ?? /\bL(\d{1,2})\b/.exec(s);
  if (m && Number(m[1]) > 0) return Number(m[1]);
  m = /\b(\d{1,2})(?:st|nd|rd|th)\b/i.exec(s);
  if (m && Number(m[1]) > 0) return Number(m[1]);
  m = /^[A-Z]{1,3}[-_. ]?(\d)(?:\.)?(\d{2})(?!\d)/i.exec(s.trim());
  if (m && Number(m[1]) > 0) return Number(m[1]);
  return null;
}

function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polyArea = (pts: [number, number][]) => Math.abs(pts.reduce((a, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return a + x * y2 - x2 * y; }, 0)) / 2;
const validRing = (v: unknown): v is [number, number][] => Array.isArray(v) && v.length >= 3 && v.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

/** Panel equipment (passive: 0 W). */
export function panelEquipment(tag: string, ports: number, fiber: boolean, rack: string): InstallEquipment {
  return {
    tag,
    description: `${ports}-port ${fiber ? "fiber" : "copper"} patch panel`,
    location: rack,
    rack,
    ports: Array.from({ length: ports }, (_, i): EquipmentPort => ({ id: `p${i + 1}`, label: `PORT ${i + 1}`, signal: fiber ? "fiber" : "ethernet", direction: "bidir" })),
    watts: 0,
  };
}
export const panelHeight = (ports: number) => (ports > 24 ? 2 : 1);
const isFiberPanel = (e: InstallEquipment) => e.ports[0]?.signal === "fiber";

/** The next free tag "<prefix>NN" (NN from 01) not in `used`; adds it to `used`. */
function nextTag(used: Set<string>, prefix: string, from = 1): string {
  for (let n = from; ; n++) {
    const t = `${prefix}${pad2(n)}`;
    if (!used.has(t)) { used.add(t); return t; }
  }
}

// ── refresh: labels, field connections, cable ends, issues ───────────────────

/** The device marker a cable's field end belongs to. */
const fieldConnId = (shapeId: string, port: string) => `fc-${shapeId}-${port}`;

/**
 * Bring the derived parts in step after any change: cable end locations from
 * devices and racks, device equipment from devices, labels by the scheme
 * (hand-set labels kept), the field connections from the cables, and the
 * issues (the takeoff's kept, the check's recomputed). Mutates and returns.
 */
export function refreshDesign(design: InstallDesign): InstallDesign {
  const devByTag = new Map(design.devices.map((d) => [d.tag, d]));
  const rackById = new Map(design.racks.map((r) => [r.id, r]));
  for (const d of design.devices) {
    const e = design.equipment.find((x) => x.tag === d.tag);
    if (!e) continue;
    e.location = d.room ?? UNKNOWN_ROOM;
    for (const k of ["manufacturer", "model", "ofe"] as const) {
      if (d[k] !== undefined) (e as unknown as Record<string, unknown>)[k] = d[k];
      else delete e[k];
    }
  }
  for (const c of design.cables) {
    const d = devByTag.get(c.to.equipment);
    if (d) c.to.location = d.room ?? UNKNOWN_ROOM;
    const r = c.from.rack ? rackById.get(c.from.rack) : undefined;
    if (r) c.from.location = `${r.id} ${r.name}`.trim();
  }
  const labels = applyLabelScheme(design.labelScheme, design.cables, design);
  design.cables.forEach((c, i) => { if (!c.labelOverride) c.label = labels[i]; });
  const manual = design.connections.filter((c) => !c.id.startsWith("fc-"));
  const field: Connection[] = [];
  for (const c of design.cables) {
    const d = devByTag.get(c.to.equipment);
    if (!d || !c.to.port || !c.from.equipment || !c.from.port) continue;
    field.push({ id: fieldConnId(d.shapeId, c.to.port), cable: c.label, kind: c.kind, from: { equipment: c.from.equipment, port: c.from.port }, to: { equipment: c.to.equipment, port: c.to.port } });
  }
  design.connections = [...field, ...manual];
  const kept = design.issues.filter((i) => TAKEOFF_ISSUE_CODES.has(i.code));
  design.issues = sortIssues([...kept, ...checkInstallDesign(design)]);
  return design;
}

// ── the draft ────────────────────────────────────────────────────────────────

export function draftInstallDesign(args: DraftArgs): InstallDesign {
  const { takeoff, project } = args;
  const prev = args.previous ?? null;
  const conditions = (takeoff.conditions ?? []) as TakeoffCondition[];
  const shapes = (takeoff.shapes ?? []) as TakeoffShape[];
  const rawRuns = (takeoff.cable_runs ?? []) as { id?: string; device_shape_ids?: unknown; hold?: unknown }[];
  const condById = new Map(conditions.map((c) => [c.id, c]));
  const sheetEntries = new Map((takeoff.sheets ?? []).map((s) => [s.sheet_id, s]));
  const issues: InstallIssue[] = [];
  const err = (code: string, message: string, ref?: string) => issues.push({ severity: "error", code, message, ...(ref ? { ref } : {}) });
  const warn = (code: string, message: string, ref?: string) => issues.push({ severity: "warning", code, message, ...(ref ? { ref } : {}) });

  // ── sheets: plan order and floor numbers ─────────────────────────────────
  const order: string[] = [];
  const number = new Map<string, string>();
  for (const s of args.sheets ?? []) { if (!order.includes(s.key)) order.push(s.key); if (isStr(s.number)) number.set(s.key, s.number); }
  for (const s of takeoff.sheets ?? []) if (!order.includes(s.sheet_id)) order.push(s.sheet_id);
  for (const s of shapes) if (!order.includes(s.sheet_id)) order.push(s.sheet_id);
  const sheetIdx = (k: string) => order.indexOf(k);
  const sheetLabel = (k: string) => number.get(k) ?? k;

  // ── the cable takeoff, by the web library ────────────────────────────────
  const cable = cableLib.computeCableTakeoff(conditions, shapes, rawRuns, {
    uppFor: (id) => sheetEntries.get(id)?.units_per_px ?? null,
    scaleReason: (id) => `sheet ${sheetLabel(id)} has no scale in the takeoff (set_scale it)`,
    scaleUnconfirmed: (id) => sheetEntries.get(id)?.scale_confirmed === false,
    sheetLabel,
  });
  const runs: ResolvedRun[] = cable?.resolved.runs ?? [];
  const linkedByDevice = new Map<string, ResolvedRun>();
  for (const r of runs) if (r.status === "linked") for (const id of r.device_shape_ids) if (!linkedByDevice.has(id)) linkedByDevice.set(id, r);
  const namedByRun = new Set<string>();
  for (const r of rawRuns) if (Array.isArray(r?.device_shape_ids)) for (const id of r.device_shape_ids) if (typeof id === "string") namedByRun.add(id);

  const isTr = (s: TakeoffShape) => s.measure_role === "count" && condById.get(s.condition_id)?.role === "tr";
  const deviceShapes = shapes.filter((s) => s.measure_role === "count" && !isTr(s) && (cableLib.hasCableSetup(condById.get(s.condition_id)) || namedByRun.has(s.id)));
  const trShapes = shapes.filter(isTr);
  if (!deviceShapes.length && !trShapes.length) err("takeoff_empty", "The takeoff has no device markers on a cable condition and no TR markers: take off the devices (place_count, cable_setup, link_run) first.");

  const planSheets = order.filter((k) => deviceShapes.some((s) => s.sheet_id === k) || trShapes.some((s) => s.sheet_id === k));
  const floorOf = new Map<string, number>();
  planSheets.forEach((k, i) => {
    const named = k.includes("#") && !number.has(k) ? null : floorFromName(number.get(k) ?? k);
    floorOf.set(k, named ?? i + 1);
  });

  // ── rooms ────────────────────────────────────────────────────────────────
  const roomShapes = shapes
    .filter((s) => (s.measure_role === "floor_area" || s.measure_role === "deduct") && isStr(s.label) && validRing(s.verts_norm))
    .map((s) => ({ s, area: polyArea(s.verts_norm!) }))
    .sort((a, b) => a.area - b.area);
  const at = (s: TakeoffShape): [number, number] => {
    const p = s.verts_norm?.[0];
    return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : [NaN, NaN];
  };
  const roomAt = (s: TakeoffShape): string | null => {
    const [x, y] = at(s);
    if (!Number.isFinite(x)) return null;
    for (const { s: r } of roomShapes) {
      if (r.sheet_id !== s.sheet_id || !pointInPoly(x, y, r.verts_norm!)) continue;
      if ((r.verts_norm_holes ?? []).some((h) => validRing(h) && pointInPoly(x, y, h))) continue;
      return r.label!.trim();
    }
    return null;
  };

  // ── previous revision, by identity ───────────────────────────────────────
  const prevDevByShape = new Map((prev?.devices ?? []).map((d) => [d.shapeId, d]));
  const prevRackByTr = new Map((prev?.racks ?? []).filter((r) => r.trShapeId).map((r) => [r.trShapeId!, r]));
  const prevDevTags = new Set((prev?.devices ?? []).map((d) => d.tag));
  const deviceShapeIds = new Set(deviceShapes.map((s) => s.id));
  const trIds = new Set(trShapes.map((s) => s.id));
  const used = new Set<string>();
  for (const s of deviceShapes) { const p = prevDevByShape.get(s.id); if (p) used.add(p.tag); }
  for (const s of trShapes) { const p = prevRackByTr.get(s.id); if (p) used.add(p.id); }

  // ── racks ────────────────────────────────────────────────────────────────
  const shapeOrder = (a: TakeoffShape, b: TakeoffShape, ra: string | null, rb: string | null) =>
    sheetIdx(a.sheet_id) - sheetIdx(b.sheet_id) || natural(ra ?? "￿", rb ?? "￿") || (at(a)[1] - at(b)[1]) || (at(a)[0] - at(b)[0]) || natural(a.id, b.id);
  const trRooms = new Map(trShapes.map((s) => [s.id, roomAt(s)]));
  const racks: Rack[] = [];
  const rackByTr = new Map<string, Rack>();
  for (const s of [...trShapes].sort((a, b) => shapeOrder(a, b, trRooms.get(a.id)!, trRooms.get(b.id)!))) {
    const p = prevRackByTr.get(s.id);
    const trName = isStr(s.label) ? s.label.trim() : "";
    const room = trRooms.get(s.id) ?? null;
    const rack: Rack = p
      ? structuredClone(p)
      : { id: nextTag(used, `RK-${floorOf.get(s.sheet_id) ?? 1}`), name: trName || "TR", location: room ?? (trName || `TR on ${sheetLabel(s.sheet_id)}`), trShapeId: s.id, sizeRU: 0, items: [] };
    racks.push(rack);
    rackByTr.set(s.id, rack);
  }
  for (const p of prev?.racks ?? []) if (!p.trShapeId || !trIds.has(p.trShapeId)) warn("rack_removed", `Rack ${p.id} (${p.name}) is gone: its TR marker is no longer in the takeoff. Its panels and cables were dropped.`, p.id);

  // ── devices ──────────────────────────────────────────────────────────────
  const devRooms = new Map(deviceShapes.map((s) => [s.id, roomAt(s)]));
  const devices: InstallDevice[] = [];
  const devByShape = new Map<string, InstallDevice>();
  const multWarned = new Set<string>();
  for (const s of [...deviceShapes].sort((a, b) => shapeOrder(a, b, devRooms.get(a.id)!, devRooms.get(b.id)!))) {
    const c = condById.get(s.condition_id);
    const setup = c && cableLib.hasCableSetup(c) ? c.cable_setup! : null;
    const deviceType = setup?.device_type || c?.finish_tag || "device";
    const run = linkedByDevice.get(s.id);
    const rack = run ? rackByTr.get(run.tr_id) ?? null : null;
    const p = prevDevByShape.get(s.id);
    const fresh: InstallDevice = {
      tag: p?.tag ?? `${tagPrefix(setup?.device_type ?? "", c?.finish_tag ?? "")}-${floorOf.get(s.sheet_id) ?? 1}`,
      shapeId: s.id,
      conditionId: s.condition_id,
      sheet: s.sheet_id,
      at: at(s),
      room: devRooms.get(s.id) ?? null,
      deviceType,
      description: `${TYPE_TITLES[deviceType] ?? deviceType} (${c?.finish_tag ?? s.condition_id})`,
      rack: rack?.id ?? null,
    };
    if (!p) {
      fresh.tag = nextTag(used, fresh.tag);
    } else {
      // what Claude or the owner set stays: tag, room, model, mounting, notes
      fresh.room = p.room ?? fresh.room;
      for (const k of ["manufacturer", "model", "ofe", "mounting", "mountingHeight", "notes"] as const) if (p[k] !== undefined) (fresh as unknown as Record<string, unknown>)[k] = p[k];
    }
    devices.push(fresh);
    devByShape.set(s.id, fresh);
    if (c && (c.multiplier ?? 1) !== 1 && !multWarned.has(c.id)) {
      multWarned.add(c.id);
      warn("multiplier_ignored", `Condition ${c.finish_tag} has multiplier ${c.multiplier}: the install design has one device per marker (place a marker per device).`, c.id);
    }
  }
  for (const p of prev?.devices ?? []) if (!deviceShapeIds.has(p.shapeId)) warn("device_removed", `Device ${p.tag} is gone: its marker is no longer in the takeoff.`, p.tag);

  // ── takeoff holes → issues ───────────────────────────────────────────────
  for (const r of runs) {
    if (r.status === "linked") {
      if (r.pending) warn("run_pending", `Run ${r.id} (${r.finish_tag}) is an agent's run nobody has reviewed yet.`, r.id);
      if (!isStr(r.cable_type)) warn("cable_type_unset", `Run ${r.id} (${r.finish_tag}): the condition's cable setup names no cable type, so its cables are kind "other".`, r.id);
      continue;
    }
    const tags = r.device_shape_ids.map((id) => devByShape.get(id)?.tag ?? id).join(", ");
    err(`run_${r.status}`, `Run ${r.id} (${r.finish_tag || "?"}) is ${r.status}: ${r.reason ?? "it does not resolve"}. No cables for ${tags}.`, r.id);
  }
  for (const d of cable?.resolved.unlinked.devices ?? []) {
    const dev = devByShape.get(d.shape_id);
    if (dev && !runs.some((r) => r.status !== "linked" && r.device_shape_ids.includes(d.shape_id))) {
      err("device_unlinked", `Device ${dev.tag} (${d.finish_tag}, ${sheetLabel(d.sheet_id)}) has no linked cable run: link_run it in the takeoff, or hold_devices with the reason.`, dev.tag);
    }
  }
  for (const h of cable?.resolved.held ?? []) {
    const dev = devByShape.get(h.shape_id);
    if (dev) {
      warn("device_held", `Device ${dev.tag} (${h.finish_tag}) is held with no run: ${h.reason}.`, dev.tag);
      if (!dev.notes) dev.notes = `Held in the takeoff: ${h.reason}`;
    }
  }

  // ── cables (one per cable of each linked run per device) ─────────────────
  const prevCable = new Map<string, InstallCable>();
  const prevShapeByTag = new Map((prev?.devices ?? []).map((d) => [d.tag, d.shapeId]));
  for (const c of prev?.cables ?? []) {
    const sid = prevShapeByTag.get(c.to.equipment);
    if (sid && c.to.port) prevCable.set(`${sid}\u0000${c.to.port}`, c);
  }
  const cables: InstallCable[] = [];
  const cableShape: string[] = [];
  const deviceEquipment: InstallEquipment[] = [];
  for (const d of devices) {
    const run = linkedByDevice.get(d.shapeId);
    const c = condById.get(d.conditionId);
    const n = run ? Math.max(1, run.cables ?? 1) : Math.max(1, Number(c?.cable_setup?.cables_per_location) || 1);
    const kind = kindOfCableType(run?.cable_type ?? c?.cable_setup?.cable_type);
    deviceEquipment.push({
      tag: d.tag, description: d.description, location: d.room ?? UNKNOWN_ROOM,
      ports: Array.from({ length: n }, (_, i): EquipmentPort => ({ id: `c${i + 1}`, label: `PORT ${i + 1}`, signal: signalOf(kind), direction: "bidir" })),
    });
    if (!run || !d.rack) continue;
    for (let i = 1; i <= n; i++) {
      const p = prevCable.get(`${d.shapeId}\u0000c${i}`);
      const cab: InstallCable = {
        label: "",
        kind,
        cableType: run.cable_type ?? "",
        runId: run.id,
        lengthFt: typeof run.per_cable_lf === "number" ? r1(run.per_cable_lf) : null,
        from: { equipment: "", port: "", rack: d.rack, location: "" },
        to: { equipment: d.tag, port: `c${i}`, location: d.room ?? UNKNOWN_ROOM },
      };
      if (p) {
        if (p.labelOverride) { cab.label = p.label; cab.labelOverride = true; }
        if (p.spare !== undefined) cab.spare = p.spare;
        if (p.notes !== undefined) cab.notes = p.notes;
        if (p.from.rack === d.rack && p.from.equipment && p.from.port) { cab.from.equipment = p.from.equipment; cab.from.port = p.from.port; }
      }
      cables.push(cab);
      cableShape.push(d.shapeId);
    }
  }
  for (const [k, c] of prevCable) {
    const [sid, port] = k.split("\u0000");
    if (!deviceShapeIds.has(sid)) continue; // the device's own removal is the issue
    if (!cables.some((x, i) => cableShape[i] === sid && x.to.port === port)) warn("cable_removed", `Cable ${c.label} (${c.to.equipment} ${port}) is gone: its device's run changed in the takeoff.`, c.label);
  }

  // ── equipment kept from the previous revision ────────────────────────────
  const rackIds = new Set(racks.map((r) => r.id));
  const keptEquipment: InstallEquipment[] = [];
  const panelsPrev = prev ? panelTags(prev) : new Set<string>();
  for (const e of prev?.equipment ?? []) {
    if (prevDevTags.has(e.tag)) continue; // field devices are rebuilt from the takeoff
    const copy = structuredClone(e);
    if (copy.rack && !rackIds.has(copy.rack)) {
      if (panelsPrev.has(copy.tag)) continue; // a removed rack's panels go with it
      warn("equipment_rack_removed", `Equipment ${copy.tag} was in rack ${copy.rack}, which is gone: place_in_rack it again.`, copy.tag);
      delete copy.rack;
      copy.location = "(rack removed)";
    }
    keptEquipment.push(copy);
    used.add(copy.tag);
  }
  const eqTags = new Set([...keptEquipment.map((e) => e.tag), ...deviceEquipment.map((e) => e.tag)]);
  for (const r of racks) r.items = r.items.filter((it) => (it.kind !== "equipment" && it.kind !== "panel") || eqTags.has(it.tag));

  // ── patch panels and port assignment, per rack ───────────────────────────
  const newPanels: InstallEquipment[] = [];
  const allEq = () => [...keptEquipment, ...newPanels];
  for (const rack of racks) {
    const idx = cables.map((_, i) => i).filter((i) => cables[i].from.rack === rack.id);
    const devOf = (i: number) => devByShape.get(cableShape[i])!;
    idx.sort((a, b) => natural(devOf(a).room ?? "￿", devOf(b).room ?? "￿") || natural(devOf(a).tag, devOf(b).tag) || natural(cables[a].to.port ?? "", cables[b].to.port ?? ""));
    const rackPanels = () => {
      const tops = new Map(rack.items.filter((it) => it.kind === "panel").map((it) => [it.tag, it.ruTop]));
      return allEq().filter((e) => e.rack === rack.id && (tops.has(e.tag) || /^(PP|FP)-\d+$/.test(e.tag))).sort((a, b) => (tops.get(b.tag) ?? -1e9) - (tops.get(a.tag) ?? -1e9));
    };
    const taken = new Set<string>();
    // keep previous assignments that still point at a panel port of this rack
    for (const i of idx) {
      const c = cables[i];
      const pan = rackPanels().find((e) => e.tag === c.from.equipment);
      const k = `${c.from.equipment}\u0000${c.from.port}`;
      if (pan && pan.ports.some((p) => p.id === c.from.port) && !taken.has(k)) taken.add(k);
      else { c.from.equipment = ""; c.from.port = ""; }
    }
    for (const fiber of [false, true]) {
      const want = idx.filter((i) => !cables[i].from.equipment && (cables[i].kind === "fiber") === fiber);
      const free = () => rackPanels().filter((e) => isFiberPanel(e) === fiber).flatMap((e) => e.ports.filter((p) => !taken.has(`${e.tag}\u0000${p.id}`)).map((p) => ({ e, p })));
      let slots = free();
      if (slots.length < want.length) {
        const m = want.length - slots.length;
        const sizes = m <= 24 ? [24] : Array.from({ length: Math.ceil(m / 48) }, () => 48);
        for (const size of sizes) {
          const h = panelHeight(size);
          const tag = nextTag(used, fiber ? "FP-" : "PP-");
          newPanels.push(panelEquipment(tag, size, fiber, rack.id));
          const placed = rack.items.filter((it) => it.ruTop !== 0);
          const lowest = placed.length ? Math.min(...placed.map((it) => it.ruTop - it.ruHeight + 1)) : null;
          if (lowest == null) {
            rack.items.push({ tag, kind: "panel", ruTop: 0, ruHeight: h, label: `${size}-port ${fiber ? "fiber " : ""}patch panel` });
          } else {
            const mgrTop = lowest - 1;
            rack.items.push({ tag: nextTag(used, `${rack.id}-HM`), kind: "manager", ruTop: mgrTop, ruHeight: 1, label: "1RU horizontal cable manager" });
            rack.items.push({ tag, kind: "panel", ruTop: mgrTop - 1, ruHeight: h, label: `${size}-port ${fiber ? "fiber " : ""}patch panel` });
          }
        }
        slots = free();
      }
      want.forEach((i, n) => {
        const s = slots[n];
        if (!s) return;
        cables[i].from.equipment = s.e.tag;
        cables[i].from.port = s.p.id;
        taken.add(`${s.e.tag}\u0000${s.p.id}`);
      });
    }
    // a fresh rack: the stack placed from the top down (from its own height while the rack size is unknown)
    const unplaced = rack.items.filter((it) => it.ruTop === 0);
    if (unplaced.length && unplaced.length === rack.items.length) {
      const stack: RackItem[] = [];
      unplaced.forEach((it, n) => {
        if (n > 0) stack.push({ tag: nextTag(used, `${rack.id}-HM`), kind: "manager", ruTop: 0, ruHeight: 1, label: "1RU horizontal cable manager" });
        stack.push(it);
      });
      let top = rack.sizeRU > 0 ? rack.sizeRU : stack.reduce((a, it) => a + it.ruHeight, 0);
      for (const it of stack) { it.ruTop = top; top -= it.ruHeight; }
      rack.items = stack;
    }
  }

  // ── mounting ─────────────────────────────────────────────────────────────
  const prevMount = new Map((prev?.mounting ?? []).map((m) => [m.deviceType, m]));
  const mounting: MountingDetail[] = [];
  for (const t of [...new Set(devices.map((d) => d.deviceType))]) {
    mounting.push(prevMount.has(t) ? structuredClone(prevMount.get(t)!) : { deviceType: t, title: TYPE_TITLES[t] ?? t, heightAff: "", box: "", notes: [] });
  }

  // ── manual connections kept when both ends still exist ───────────────────
  const equipment = [...keptEquipment, ...newPanels, ...deviceEquipment];
  const eqByTag = new Map(equipment.map((e) => [e.tag, e]));
  const connections: Connection[] = [];
  for (const c of prev?.connections ?? []) {
    if (c.id.startsWith("fc-")) continue;
    const okEnd = (e: { equipment: string; port: string }) => !!eqByTag.get(e.equipment)?.ports.some((p) => p.id === e.port);
    if (okEnd(c.from) && okEnd(c.to)) connections.push(structuredClone(c));
    else warn("connection_dropped", `Connection ${c.id} (${c.from.equipment} ${c.from.port} → ${c.to.equipment} ${c.to.port}) was dropped: an end is no longer in the design.`, c.id);
  }

  const design: InstallDesign = {
    schema: "brink.install.v1",
    project,
    revision: (prev?.revision ?? 0) + 1,
    created: args.now ?? new Date().toISOString(),
    ...(args.bidRevision !== undefined ? { bidRevision: args.bidRevision } : {}),
    labelScheme: prev?.labelScheme ? structuredClone(prev.labelScheme) : defaultLabelScheme(),
    devices,
    cables,
    equipment,
    connections,
    racks,
    mounting,
    issues,
    status: "draft",
  };
  return refreshDesign(design);
}
