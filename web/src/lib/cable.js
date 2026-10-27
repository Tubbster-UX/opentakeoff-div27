// Division 27 cable setup — the ONE pure library behind the per-run cable
// schedule (docs/design/CABLE_SETUP.md). No React, no DOM, no pdf.js: the
// canvas, the Report's exports and the MCP server all import this module, so
// a headless session and the app can never disagree about a cable length.
//
// The estimating rules this module exists to apply, verbatim from the spec:
//   1. Measure, do not model — horizontal length comes ONLY from measured
//      linear shapes (their stored plan length). No routing factor, no
//      footprint estimate, no default length for anything unlinked.
//   2. Per cable = route + vertical + loop at device + loop at TR; the
//      vertical and loops are per-condition constants on the cable setup.
//   3. Pulls are per location, cables are per pull × cables per location.
//   4. Waste applies only to the ORDER quantity (cable_lf_order), never to
//      the measured route or the net cable LF — the house convention.
//   5. Withhold, don't guess — an unlinked device, a broken run, a setup
//      missing a required value is REPORTED with its reason and excluded
//      from totals.
//
// Opt-in contract (the roll_setup precedent, web/src/lib/rollTakeoff.js): a
// count condition is a cable (device) condition iff it carries a usable
// `cable_setup`; a condition is a telecom-room (TR) condition iff
// `role === "tr"`. Runs are their own record family on the takeoff document
// (`cable_runs`, additive, omitted when empty) and store NO lengths: every
// length is resolved from the referenced shapes at read time, so a
// recalibration or an edit propagates with nothing to update, and a deleted
// shape makes the run `broken` rather than silently dropping it.
import { mintUuid, nowIso } from "./provenance.js";
import { round2 } from "./num.js";
import { findCableDuplicates, hasDuplicateFindings } from "./cableDupes.js";

/** The device types a cable setup can name. `custom` carries no starting values. */
export const DEVICE_TYPES = Object.freeze(["wall_outlet", "wap", "camera", "access_door", "ceiling_other", "custom"]);

/** Starting values the UI offers when a device type is picked (the spec's
 *  table). `null` = no starting value: access_door has no vertical and must be
 *  entered per job before that condition's runs count. waste_pct is what the
 *  canvas pre-fills into the condition's own waste field; this module never
 *  writes it (an MCP edit_condition passes waste_pct explicitly). */
export const CABLE_DEFAULTS = Object.freeze({
  wall_outlet:   Object.freeze({ vertical_ft: 23,   loop_device_ft: 10,   loop_tr_ft: 10,   waste_pct: 12 }),
  wap:           Object.freeze({ vertical_ft: 13,   loop_device_ft: 20,   loop_tr_ft: 10,   waste_pct: 12 }),
  camera:        Object.freeze({ vertical_ft: 13,   loop_device_ft: 15,   loop_tr_ft: 10,   waste_pct: 12 }),
  access_door:   Object.freeze({ vertical_ft: null, loop_device_ft: 15,   loop_tr_ft: 10,   waste_pct: 12 }),
  ceiling_other: Object.freeze({ vertical_ft: 13,   loop_device_ft: 10,   loop_tr_ft: 10,   waste_pct: 12 }),
  custom:        Object.freeze({ vertical_ft: null, loop_device_ft: null, loop_tr_ft: null, waste_pct: null }),
});

export const DEVICE_TYPE_LABELS = Object.freeze({
  wall_outlet: "Wall outlet", wap: "WAP", camera: "Camera", access_door: "Access control door",
  ceiling_other: "Other ceiling device", custom: "Custom",
});

export function isDeviceType(t) { return DEVICE_TYPES.includes(t); }

/** Names an agent or a person reaches for that mean one of the device types.
 *  They are READ as the canonical type and never stored: the document only
 *  ever holds a DEVICE_TYPES value. (A real bid asked for "access_control".) */
export const DEVICE_TYPE_ALIASES = Object.freeze({
  access_control: "access_door", access_control_door: "access_door", card_reader: "access_door",
  wireless_access_point: "wap", access_point: "wap", wifi_ap: "wap",
  data_outlet: "wall_outlet", outlet: "wall_outlet", data_drop: "wall_outlet",
  cctv: "camera", cctv_camera: "camera", security_camera: "camera",
  ceiling_device: "ceiling_other", ceiling_speaker: "ceiling_other", speaker: "ceiling_other",
});

/** The canonical device type for a name, or null. Case, spaces and hyphens
 *  are forgiven ("Access Control" → access_door). */
export function normalizeDeviceType(t) {
  if (typeof t !== "string") return null;
  const k = t.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return isDeviceType(k) ? k : DEVICE_TYPE_ALIASES[k] || null;
}

/** The TIA-568 length limit for a 4-pair balanced copper permanent link:
 *  90 m, which the trade carries as 295 ft. A linked run whose per-cable LF
 *  exceeds it is still counted — the measured length is the truth — but it
 *  is flagged on the run and in the warnings, so it is caught before bid
 *  day instead of by hand. Fiber and coax are not bound by it; the warning
 *  says so rather than guessing the medium from free-text cable_type. */
export const TIA_MAX_LINK_FT = 295;

/** A fresh cable setup for a device type: the type's starting values plus
 *  `patch` on top. Unknown types fall back to custom (blank), never throw. */
export function mintCableSetup(deviceType, patch = {}) {
  const type = isDeviceType(deviceType) ? deviceType : "custom";
  const d = CABLE_DEFAULTS[type];
  // the type argument wins over a patch that names one
  const given = Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => v !== undefined && k !== "device_type"));
  return {
    device_type: type,
    cables_per_location: 1,
    cable_type: "",
    vertical_ft: d.vertical_ft,
    loop_device_ft: d.loop_device_ft,
    loop_tr_ft: d.loop_tr_ft,
    ...given,
  };
}

/** A condition is a cable (device) condition iff it carries a usable setup.
 *  Corrupt payloads (array, string, no device type) read as opted OUT. */
export function hasCableSetup(c) {
  const cs = c?.cable_setup;
  return !!cs && typeof cs === "object" && !Array.isArray(cs) && typeof cs.device_type === "string" && cs.device_type.length > 0;
}

/** A condition whose count markers are telecom rooms. */
export function isTrCondition(c) { return c?.role === "tr"; }
/** A condition whose linear shapes are cable routes: every one of them that
 *  no linked run uses is reported unlinked. A linear shape on any other
 *  condition (base, a transition, a wall) is never assumed to be a route. */
export function isRouteCondition(c) { return c?.role === "route"; }
export const CONDITION_ROLES = Object.freeze(["tr", "route"]);

const finiteNonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The reasons a setup cannot figure a run yet — empty when complete. These
 *  are the WITHHOLD reasons: a condition with any of them keeps its runs out
 *  of every total and says why, instead of assuming a value. */
export function cableSetupProblems(setup) {
  const out = [];
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) return ["no cable setup"];
  if (!isDeviceType(setup.device_type)) out.push(`device_type must be one of ${DEVICE_TYPES.join(", ")}`);
  const n = setup.cables_per_location;
  if (!(Number.isInteger(n) && n >= 1)) out.push("cables_per_location must be a whole number of 1 or more");
  if (!finiteNonNeg(setup.vertical_ft)) out.push(`vertical_ft is required — enter the job's vertical${setup.device_type === "access_door" || setup.device_type === "custom" ? " (this device type has no starting value)" : ""}`);
  if (!finiteNonNeg(setup.loop_device_ft)) out.push("loop_device_ft is required");
  if (!finiteNonNeg(setup.loop_tr_ft)) out.push("loop_tr_ft is required");
  return out;
}

// ── runs ────────────────────────────────────────────────────────────────────

const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : []);

/** Mint a run record. `provenance` follows the shape-origin vocabulary:
 *  `{ method, actor?, reviewed?, created_at, author? }` — a human at the canvas
 *  omits actor; an agent passes `actor: "agent"` and lands `reviewed: false`. */
export function mintCableRun({ device_shape_ids, route_shape_ids, tr_id, cables_override, provenance } = {}) {
  const prov = { method: "manual", ...(provenance && typeof provenance === "object" ? provenance : {}) };
  if (prov.actor === "agent" && prov.reviewed == null) prov.reviewed = false;
  if (!prov.created_at) prov.created_at = nowIso();
  const n = Number(cables_override);
  return {
    id: `run-${mintUuid()}`,
    device_shape_ids: strArr(device_shape_ids),
    route_shape_ids: strArr(route_shape_ids),
    tr_id: typeof tr_id === "string" ? tr_id : "",
    ...(Number.isInteger(n) && n >= 1 ? { cables_override: n } : {}),
    provenance: prov,
  };
}

/** A HOLD: device locations deliberately left without a run, with the
 *  reason (a crawl-space area whose routing is not drawn, a device by
 *  others). It rides the same `cable_runs` list as runs — one record family,
 *  one undo family, one import rule — and is told apart by its `hold`
 *  object. A held device is excluded from totals exactly as an unlinked one
 *  is, but it is listed as HELD with its reason instead of "no run links
 *  this device", so the gap reads as a decision, not a miss. */
export function isCableHold(r) { return !!r && typeof r.hold === "object" && r.hold !== null && !Array.isArray(r.hold); }

/** Mint a hold record. Same provenance rule as a run: an agent's hold lands
 *  pending review. */
export function mintCableHold({ device_shape_ids, reason, provenance } = {}) {
  const prov = { method: "manual", ...(provenance && typeof provenance === "object" ? provenance : {}) };
  if (prov.actor === "agent" && prov.reviewed == null) prov.reviewed = false;
  if (!prov.created_at) prov.created_at = nowIso();
  return {
    id: `hold-${mintUuid()}`,
    device_shape_ids: [...new Set(strArr(device_shape_ids))],
    route_shape_ids: [],
    tr_id: "",
    hold: { reason: typeof reason === "string" ? reason.trim() : "" },
    provenance: prov,
  };
}

/** Why a hold cannot be made, or null. Every id must be a device marker on
 *  a cable condition that no run or hold already names. */
export function holdRefusal({ device_shape_ids, reason }, conditions, shapes, runs = []) {
  if (typeof reason !== "string" || !reason.trim()) return "a hold needs a reason — say why these devices get no run (it prints on the Unlinked list and the report)";
  const ids = strArr(device_shape_ids);
  if (!ids.length) return "name at least one device marker to hold";
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const shapeById = new Map((shapes || []).map((s) => [s.id, s]));
  for (const id of ids) {
    const s = shapeById.get(id);
    if (!s) return `device shape ${id} does not exist — list_shapes shows every committed id`;
    if (s.measure_role !== "count" || !hasCableSetup(condById.get(s.condition_id))) return `shape ${id} is not a device marker (a count marker on a condition with a cable_setup)`;
    const other = (runs || []).find((r) => Array.isArray(r.device_shape_ids) && r.device_shape_ids.includes(id));
    if (other) return isCableHold(other) ? `device ${id} is already held by ${other.id} — unlink_run that hold first to change its reason` : `device ${id} is linked by run ${other.id} — a linked device is not held; unlink_run the run first`;
  }
  return null;
}

/** Legacy/foreign records: an agent run with no review flag is pending (the
 *  shapes' normalizeAgentReview rule) — absence is never an approval. */
export function normalizeRunReview(run) {
  const p = run?.provenance;
  return p?.actor === "agent" && p.reviewed == null ? { ...run, provenance: { ...p, reviewed: false } } : run;
}

/** The load gate (the sanitizeStitches precedent): keep only well-formed
 *  records, drop the rest, never throw. A run with a missing shape is still
 *  well-formed — it resolves as broken, which is the honest state. */
export function sanitizeCableRuns(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    if (typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    if (!Array.isArray(r.device_shape_ids) || !Array.isArray(r.route_shape_ids)) continue;
    const n = r.cables_override;
    const prov = r.provenance && typeof r.provenance === "object" && !Array.isArray(r.provenance) ? r.provenance : { method: "manual" };
    seen.add(r.id);
    const { cables_override: _dropped, ...rest } = r;
    out.push(normalizeRunReview({
      ...rest,
      device_shape_ids: strArr(r.device_shape_ids),
      route_shape_ids: strArr(r.route_shape_ids),
      tr_id: typeof r.tr_id === "string" ? r.tr_id : "",
      ...(Number.isInteger(n) && n >= 1 ? { cables_override: n } : {}),
      ...(isCableHold(r) ? { hold: { ...r.hold, reason: typeof r.hold.reason === "string" ? r.hold.reason : "" } } : {}),
      provenance: prov,
    }));
  }
  return out;
}

/** The horizontal length a route segment contributes: the shape's stored PLAN
 *  length in feet. A linear run's `perimeter_lf` is plan + rise + drop (#441),
 *  with `plan_lf` riding beside it only when a leg exists — so the plan length
 *  is `plan_lf ?? perimeter_lf`. null when the shape carries no number. */
export function routeLengthFt(shape) {
  const c = shape?.computed || {};
  const v = typeof c.plan_lf === "number" ? c.plan_lf : c.perimeter_lf;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** True when a segment's stored LF includes vertical legs (its own rise/drop
 *  or its condition's defaults) — those legs are IGNORED here, and the
 *  regular report's LF for that condition is not a cable length. */
export function segmentHasLegs(shape, cond) {
  const pick = (own, dflt) => { const v = own != null && own !== "" ? Number(own) : Number(dflt); return Number.isFinite(v) && v > 0; };
  if (shape?.origin?.derived) return false;
  return pick(shape?.rise_ft, cond?.rise_ft) || pick(shape?.drop_ft, cond?.drop_ft);
}

export const RUN_REVIEW = Object.freeze({ PENDING: "pending", ACCEPTED: "accepted", HUMAN: "human" });
export function runReviewStatus(run) {
  const r = run?.provenance?.reviewed;
  return r === false ? RUN_REVIEW.PENDING : r === true ? RUN_REVIEW.ACCEPTED : RUN_REVIEW.HUMAN;
}

/**
 * Resolve every run against the current shapes and conditions.
 *
 * @param {any[]} conditions
 * @param {any[]} shapes
 * @param {any[]} runs cable_runs records
 * @param {{ uppFor?: (sheetId: string) => number | null | undefined, scaleReason?: (sheetId: string) => string,
 *   scaleUnconfirmed?: (sheetId: string) => boolean, sheetLabel?: (sheetId: string) => string }} [opts]
 *   uppFor answers "does this sheet have a scale" for the surface asking (the
 *   canvas knows stitches; an MCP session knows its loaded sheets). Omitted =
 *   every sheet is taken as scaled (the shape's stored feet are trusted).
 *   scaleReason words the refusal for an unscaled sheet. scaleUnconfirmed
 *   answers "was this sheet's scale set by an agent and not yet confirmed by
 *   a person" — a linked run on such a sheet still counts, and is flagged.
 *   sheetLabel names a sheet in a warning (its sheet number, not its key).
 * @returns {{ runs: any[], unlinked: { devices: any[], routes: any[] }, held: any[], holds: any[], warnings: string[] }}
 */
export function resolveCableRuns(conditions, shapes, runs, opts = {}) {
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const shapeById = new Map((shapes || []).map((s) => [s.id, s]));
  const uppFor = typeof opts.uppFor === "function" ? opts.uppFor : null;
  const scaleReason = typeof opts.scaleReason === "function" ? opts.scaleReason : (k) => `sheet ${k} has no scale — a route is a real length, so set the scale first`;
  const scaleUnconfirmed = typeof opts.scaleUnconfirmed === "function" ? opts.scaleUnconfirmed : () => false;
  const sheetLabel = typeof opts.sheetLabel === "function" ? opts.sheetLabel : (k) => k;
  const unconfirmedSheets = new Set();   // route sheets of LINKED runs whose scale no person confirmed
  let unconfirmedRuns = 0;
  const overLength = [];                 // linked runs past TIA_MAX_LINK_FT per cable
  const holds = [];
  const resolved = [];
  const warnings = [];
  const warned = new Set();
  const linkedDevices = new Set();   // device ids in LINKED runs
  const deviceRun = new Map();       // device id → first run referencing it (any status)
  const routeRun = new Map();        // route id → first run referencing it (any status)
  const linkedRoutes = new Set();    // route ids in LINKED runs

  for (const raw of runs || []) {
    if (isCableHold(raw)) { holds.push(normalizeRunReview(raw)); continue; }
    const run = normalizeRunReview(raw);
    const reasons = [];
    let withheld = [];
    const notes = [];
    let legWarning = false;
    // ── devices → the cable condition ──────────────────────────────────────
    const devIds = strArr(run.device_shape_ids);
    if (!devIds.length) reasons.push("no device location");
    const devShapes = [];
    for (const id of devIds) {
      if (!deviceRun.has(id)) deviceRun.set(id, run.id);
      const s = shapeById.get(id);
      if (!s) { reasons.push(`device shape ${id} was deleted`); continue; }
      if (s.measure_role !== "count") { reasons.push(`device shape ${id} is not a count marker`); continue; }
      devShapes.push(s);
    }
    const condIds = [...new Set(devShapes.map((s) => s.condition_id))];
    if (condIds.length > 1) reasons.push("device locations sit on different conditions");
    const cond = condIds.length ? condById.get(condIds[0]) : null;
    if (devShapes.length && !cond) reasons.push(`condition ${condIds[0]} no longer exists`);
    if (cond && !hasCableSetup(cond)) reasons.push(`condition ${cond.finish_tag} has no cable setup`);
    const setup = cond && hasCableSetup(cond) ? cond.cable_setup : null;
    if (setup) withheld = cableSetupProblems(setup).map((p) => `${cond.finish_tag}: ${p}`);
    // ── TR ─────────────────────────────────────────────────────────────────
    const trShape = run.tr_id ? shapeById.get(run.tr_id) : null;
    if (!run.tr_id) reasons.push("no TR");
    else if (!trShape) reasons.push(`TR marker ${run.tr_id} was deleted`);
    else if (trShape.measure_role !== "count" || !isTrCondition(condById.get(trShape.condition_id))) reasons.push(`shape ${run.tr_id} is not a TR marker (its condition is not flagged role "tr")`);
    const trName = trShape ? (typeof trShape.label === "string" && trShape.label.trim() ? trShape.label.trim() : "") : "";
    // ── route segments, in order, each at its own sheet's scale ────────────
    const routeIds = strArr(run.route_shape_ids);
    if (!routeIds.length) reasons.push("no route segments");
    let routeLf = 0;
    const sheetIds = [];
    const segments = [];
    const runUnconfirmed = new Set();
    for (const id of routeIds) {
      if (!routeRun.has(id)) routeRun.set(id, run.id);
      const s = shapeById.get(id);
      if (!s) { reasons.push(`route shape ${id} was deleted`); continue; }
      if (s.measure_role !== "linear") { reasons.push(`route shape ${id} is not a measured linear shape (it is ${s.measure_role})`); continue; }
      const upp = uppFor ? uppFor(s.sheet_id) : 1;
      if (!(typeof upp === "number" && upp > 0)) { reasons.push(scaleReason(s.sheet_id)); }
      const len = routeLengthFt(s);
      if (len == null) { reasons.push(`route shape ${id} carries no measured length`); continue; }
      if (!sheetIds.includes(s.sheet_id)) sheetIds.push(s.sheet_id);
      if (scaleUnconfirmed(s.sheet_id)) runUnconfirmed.add(s.sheet_id);
      const sc = condById.get(s.condition_id);
      if (segmentHasLegs(s, sc)) {
        legWarning = true;
        const vert = typeof s.computed?.vertical_lf === "number" ? s.computed.vertical_lf : null;
        notes.push(`segment ${id} carries ${vert != null ? `${round2(vert)} ft of ` : ""}rise/drop legs — ignored; the vertical comes from the cable setup`);
        const key = s.condition_id;
        if (!warned.has(key)) {
          warned.add(key);
          warnings.push(`Condition ${sc?.finish_tag ?? s.condition_id} carries rise/drop legs: its LF in the regular report includes those legs and is not a cable length. Cable runs read each segment's plan length only.`);
        }
      }
      segments.push({ shape_id: id, sheet_id: s.sheet_id, length_lf: len });
      routeLf += len;
    }
    const status = reasons.length ? "broken" : withheld.length ? "withheld" : "linked";
    const cables = Number.isInteger(run.cables_override) && run.cables_override >= 1
      ? run.cables_override : (setup ? setup.cables_per_location : null);
    const base = {
      id: run.id,
      condition_id: cond?.id ?? condIds[0] ?? null,
      finish_tag: cond?.finish_tag ?? "",
      device_type: setup?.device_type ?? "",
      cable_type: typeof setup?.cable_type === "string" ? setup.cable_type : "",
      device_shape_ids: devIds,
      route_shape_ids: routeIds,
      tr_id: run.tr_id || "",
      tr_name: trName,
      sheet_ids: sheetIds,
      device_sheet_ids: [...new Set(devShapes.map((s) => s.sheet_id))],
      tr_sheet_id: trShape?.sheet_id ?? "",
      segments,
      route_lf: routeLf,
      status,
      review: runReviewStatus(run),
      pending: run.provenance?.reviewed === false,
      ...(notes.length ? { notes } : {}),
      ...(legWarning ? { leg_warning: true } : {}),
      ...(status !== "linked" ? { reason: (reasons.length ? reasons : withheld).join("; "), reasons: reasons.length ? reasons : withheld } : {}),
    };
    if (status === "linked") {
      const perCable = routeLf + setup.vertical_ft + setup.loop_device_ft + setup.loop_tr_ft;
      const over = perCable > TIA_MAX_LINK_FT;
      const flagNotes = [];
      if (over) {
        overLength.push({ id: run.id, finish_tag: base.finish_tag, per_cable_lf: perCable });
        flagNotes.push(`per cable ${round2(perCable)} ft exceeds ${TIA_MAX_LINK_FT} ft (TIA-568 copper permanent link, 90 m)`);
      }
      if (runUnconfirmed.size) {
        unconfirmedRuns += 1;
        for (const k of runUnconfirmed) unconfirmedSheets.add(k);
        flagNotes.push(`route scale on ${[...runUnconfirmed].map(sheetLabel).join(", ")} not confirmed by a person`);
      }
      const allNotes = [...notes, ...flagNotes];
      resolved.push({
        ...base,
        ...(allNotes.length ? { notes: allNotes } : {}),
        ...(over ? { over_length: true } : {}),
        ...(runUnconfirmed.size ? { scale_unconfirmed: true } : {}),
        vertical_ft: setup.vertical_ft, loop_device_ft: setup.loop_device_ft, loop_tr_ft: setup.loop_tr_ft,
        per_cable_lf: perCable, cables, location_lf: perCable * cables,
        ...(Number.isInteger(run.cables_override) ? { cables_override: run.cables_override } : {}),
      });
      for (const id of devIds) linkedDevices.add(id);
      for (const seg of segments) linkedRoutes.add(seg.shape_id);
    } else {
      resolved.push({
        ...base,
        vertical_ft: setup ? setup.vertical_ft : null, loop_device_ft: setup ? setup.loop_device_ft : null, loop_tr_ft: setup ? setup.loop_tr_ft : null,
        per_cable_lf: null, cables, location_lf: null,
      });
    }
  }

  // ── run-level warnings: over-length and unconfirmed-scale ───────────────
  if (overLength.length) {
    const shown = overLength.slice(0, 10).map((o) => `${o.finish_tag} ${o.id} ${round2(o.per_cable_lf)} ft`);
    warnings.push(`${overLength.length} linked run${overLength.length === 1 ? "" : "s"} exceed${overLength.length === 1 ? "s" : ""} ${TIA_MAX_LINK_FT} ft per cable, the TIA-568 limit for a 4-pair copper permanent link (90 m): ${shown.join("; ")}${overLength.length > 10 ? `; +${overLength.length - 10} more` : ""}. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice. Fiber and coax are not bound by this limit.`);
  }
  if (unconfirmedRuns) {
    warnings.push(`${unconfirmedRuns} linked run${unconfirmedRuns === 1 ? "" : "s"} take${unconfirmedRuns === 1 ? "s" : ""} route length from a sheet whose scale no person has confirmed (${[...unconfirmedSheets].map(sheetLabel).join(", ")}). Every cable length there rests on that scale: confirm it in the canvas before pricing.`);
  }

  // ── holds: devices deliberately left without a run, with the reason ────
  const heldBy = new Map();
  for (const h of holds) {
    for (const id of strArr(h.device_shape_ids)) {
      if (!shapeById.has(id)) { warnings.push(`Hold ${h.id} names device ${id}, which no longer exists — the hold covers nothing there.`); continue; }
      if (linkedDevices.has(id)) { warnings.push(`Device ${id} is held by ${h.id} and also linked by a run — the run counts; release the hold.`); continue; }
      if (!heldBy.has(id)) heldBy.set(id, h);
    }
  }

  // ── unlinked devices: every marker on a cable condition with no LINKED run
  // (a HELD one is listed under held, with its reason, instead) ───────────
  const devices = [];
  const held = [];
  for (const s of shapes || []) {
    if (s.measure_role !== "count") continue;
    const c = condById.get(s.condition_id);
    if (!c || !hasCableSetup(c)) continue;
    if (linkedDevices.has(s.id)) continue;
    const h = heldBy.get(s.id);
    if (h) {
      held.push({
        shape_id: s.id, condition_id: c.id, finish_tag: c.finish_tag, sheet_id: s.sheet_id,
        ...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
        hold_id: h.id, reason: h.hold.reason || "(no reason given)", review: runReviewStatus(h),
      });
      continue;
    }
    const via = deviceRun.get(s.id);
    const r = via ? resolved.find((x) => x.id === via) : null;
    devices.push({
      shape_id: s.id, condition_id: c.id, finish_tag: c.finish_tag, sheet_id: s.sheet_id,
      ...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
      reason: r ? `its run ${r.id} is ${r.status}: ${r.reason}` : "no run links this device",
    });
  }
  // ── unlinked routes: every linear shape on a condition flagged role
  // "route" that no LINKED run uses. The flag is the only thing that says a
  // line is a route — base, transitions and walls are never assumed to be.
  const routes = [];
  for (const s of shapes || []) {
    if (s.measure_role !== "linear" || !isRouteCondition(condById.get(s.condition_id))) continue;
    if (linkedRoutes.has(s.id)) continue;
    const via = routeRun.get(s.id);
    const r = via ? resolved.find((x) => x.id === via) : null;
    routes.push({
      shape_id: s.id, condition_id: s.condition_id, finish_tag: condById.get(s.condition_id).finish_tag, sheet_id: s.sheet_id, length_lf: routeLengthFt(s),
      reason: r ? `its run ${r.id} is ${r.status}: ${r.reason}` : "no run links this segment",
    });
  }
  const holdList = holds.map((h) => ({
    id: h.id, reason: h.hold.reason || "(no reason given)", device_shape_ids: strArr(h.device_shape_ids),
    held: held.filter((d) => d.hold_id === h.id).length, review: runReviewStatus(h), pending: h.provenance?.reviewed === false,
  }));
  return { runs: resolved, unlinked: { devices, routes }, held, holds: holdList, warnings };
}

// ── rollups ─────────────────────────────────────────────────────────────────

const zeroQty = () => ({ ea: 0, pulls: 0, cables: 0, route_lf: 0, cable_lf: 0, cable_lf_order: 0, unlinked_devices: 0, held_devices: 0, pending_runs: 0, over_length_runs: 0 });
const QTY_KEYS = Object.keys(zeroQty());
const addQty = (a, b) => { for (const k of QTY_KEYS) a[k] += b[k] || 0; return a; };
const roundQty = (q) => ({ ...q, route_lf: round2(q.route_lf), cable_lf: round2(q.cable_lf), cable_lf_order: round2(q.cable_lf_order) });

/**
 * The Cable summary: one row per (device condition × TR) with linked runs,
 * plus one row per cable condition that has no linked run at all (so its EA
 * shows against zero pulls — the gap IS the unlinked + held count). ×N
 * applies to every quantity row-wide (ea, pulls, cables, LF, unlinked and
 * held devices), the house convention for reported quantities; pending_runs
 * and over_length_runs are counts of records, not quantities, and stay raw.
 * Every row lands in exactly one by_tr group — a condition with no linked
 * run sits in the "" (no TR) group — so the by-TR subtotals sum to the totals. Waste (the condition's waste_pct) applies to
 * cable_lf_order only.
 *
 * @returns {{ rows: any[], by_tr: any[], by_cable_type: any[], totals: any, warnings: string[] }}
 */
export function cableSummary(resolved, conditions, shapes) {
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const cableConds = (conditions || []).filter(hasCableSetup);
  // device EA per cable condition — the count the Report's EA column shows
  const eaByCond = new Map();
  for (const s of shapes || []) {
    if (s.measure_role !== "count" || !hasCableSetup(condById.get(s.condition_id))) continue;
    eaByCond.set(s.condition_id, (eaByCond.get(s.condition_id) || 0) + (s.computed?.count || 1));
  }
  const unlinkedByCond = new Map();
  for (const d of resolved.unlinked.devices) unlinkedByCond.set(d.condition_id, (unlinkedByCond.get(d.condition_id) || 0) + 1);
  const heldByCond = new Map();
  for (const d of resolved.held || []) heldByCond.set(d.condition_id, (heldByCond.get(d.condition_id) || 0) + 1);
  const rowKey = (r) => `${r.condition_id}\u0000${r.tr_id}`;
  const rowsByKey = new Map();
  for (const r of resolved.runs) {
    if (r.status !== "linked") continue;
    const c = condById.get(r.condition_id);
    const mult = c?.multiplier || 1;
    const waste = Math.max(0, Number(c?.waste_pct) || 0);
    let row = rowsByKey.get(rowKey(r));
    if (!row) {
      row = {
        condition_id: r.condition_id, finish_tag: r.finish_tag, device_type: r.device_type, cable_type: r.cable_type,
        tr_id: r.tr_id, tr_name: r.tr_name, multiplier: mult, waste_pct: waste,
        ...zeroQty(), leg_warning: false,
      };
      rowsByKey.set(rowKey(r), row);
    }
    row.pulls += mult;
    row.cables += r.cables * mult;
    row.route_lf += r.route_lf * mult;
    row.cable_lf += r.location_lf * mult;
    row.cable_lf_order += r.location_lf * mult * (1 + waste / 100);
    if (r.pending) row.pending_runs += 1;
    if (r.over_length) row.over_length_runs += 1;
    if (r.leg_warning) row.leg_warning = true;
  }
  // EA and the unlinked gap ride on the condition's FIRST row (a condition
  // homing to two TRs would otherwise count its devices twice), and a cable
  // condition with no linked run gets a row of its own so the gap shows.
  const rows = [];
  for (const c of cableConds) {
    const mult = c.multiplier || 1;
    const own = [...rowsByKey.values()].filter((row) => row.condition_id === c.id);
    const ea = (eaByCond.get(c.id) || 0) * mult;
    const unlinked = (unlinkedByCond.get(c.id) || 0) * mult;
    const heldN = (heldByCond.get(c.id) || 0) * mult;
    const withheld = resolved.runs.filter((r) => r.condition_id === c.id && r.status === "withheld");
    if (!own.length) {
      rows.push({
        condition_id: c.id, finish_tag: c.finish_tag, device_type: c.cable_setup.device_type,
        cable_type: typeof c.cable_setup.cable_type === "string" ? c.cable_setup.cable_type : "",
        tr_id: "", tr_name: "", multiplier: mult, waste_pct: Math.max(0, Number(c.waste_pct) || 0),
        ...zeroQty(), ea, unlinked_devices: unlinked, held_devices: heldN, leg_warning: false,
        ...(withheld.length ? { withheld: withheld[0].reason, withheld_runs: withheld.length } : {}),
      });
      continue;
    }
    own.forEach((row, i) => {
      rows.push({ ...roundQty(row), ea: i === 0 ? ea : 0, unlinked_devices: i === 0 ? unlinked : 0, held_devices: i === 0 ? heldN : 0, ...(i === 0 && withheld.length ? { withheld: withheld[0].reason, withheld_runs: withheld.length } : {}) });
    });
  }
  const group = (key, name) => {
    const m = new Map();
    for (const row of rows) {
      const k = key(row);
      let g = m.get(k);
      if (!g) { g = { ...name(row), ...zeroQty() }; m.set(k, g); }
      addQty(g, row);
    }
    return [...m.values()].map(roundQty);
  };
  // the "" group is every condition with no linked run: its EA, unlinked and
  // held devices belong in the by-TR subtotals too, or they stop summing to
  // the totals (a real bid read 103 devices by TR against 111 in total)
  const by_tr = group((r) => r.tr_id, (r) => ({ tr_id: r.tr_id, tr_name: r.tr_id ? r.tr_name : "" })).filter((g) => g.tr_id || QTY_KEYS.some((k) => g[k]));
  const by_cable_type = group((r) => r.cable_type, (r) => ({ cable_type: r.cable_type }));
  const totals = roundQty(rows.reduce((t, r) => addQty(t, r), zeroQty()));
  return { rows, by_tr, by_cable_type, totals, warnings: [...resolved.warnings] };
}

/** Per-condition aggregate for the Report's Conditions-table columns
 *  (Pulls / Cables / Cable LF / Cable LF w/Waste): Map(condition_id → qty). */
export function cableByCondition(summary) {
  const out = new Map();
  for (const row of summary?.rows || []) {
    const cur = out.get(row.condition_id) || zeroQty();
    out.set(row.condition_id, addQty(cur, row));
  }
  for (const [k, v] of out) out.set(k, roundQty(v));
  return out;
}

// ── supporting materials (parts per cable / per pull) ────────────────────────

/** The two materials bases a cable takeoff answers (lib/totals.js
 *  conditionTotals): "cables" divides a row against the condition's linked
 *  cables, "pulls" against its linked pulls — a jack per cable, a faceplate
 *  or a mount per pull. Both are FIGURED from the runs, like seam_lf from the
 *  roll layout, never measured. */
export const CABLE_MATERIAL_BASES = Object.freeze(["cables", "pulls"]);
export function isCableMaterialBasis(b) { return CABLE_MATERIAL_BASES.includes(b); }

/** The figured pulls and cables per DEVICE SHAPE — what a materials row with
 *  basis "cables" / "pulls" divides against. Only LINKED runs contribute
 *  (withheld, broken, unlinked and held devices stay out, exactly as in the
 *  Cable summary; a pending run counts like everything pending does). Each
 *  run lands on its first device shape, so a run is one pull however many
 *  markers name its location, and `cables` already carries cables_override.
 *  UNMULTIPLIED: conditionTotals applies ×N like every other quantity, so a
 *  condition's sum × N equals cableByCondition's pulls and cables. Per shape,
 *  not per condition, so the Report's by-sheet and by-room slices split it
 *  the way they split seam LF. Empty map without a cable takeoff.
 *  @param {any} takeoff computeCableTakeoff() result (null → empty)
 *  @returns {Map<string, { pulls: number, cables: number }>} */
export function cableQtyByShape(takeoff) {
  const out = new Map();
  for (const r of takeoff?.resolved?.runs || []) {
    if (r.status !== "linked") continue;
    const id = (r.device_shape_ids || [])[0];
    if (!id) continue;
    const cur = out.get(id) || { pulls: 0, cables: 0 };
    cur.pulls += 1;
    cur.cables += Number(r.cables) || 0;
    out.set(id, cur);
  }
  return out;
}

/** Why a "cables" / "pulls" materials row reads 0, or null when it does not.
 *  The same honesty rule as a seam_lf row with no roll layout: nothing has
 *  figured that quantity yet, so the row says so instead of guessing.
 *  @param {any} cond the condition
 *  @param {number} basisVal the figured cables or pulls (this slice)
 *  @param {boolean} figured whether the caller handed in a cable takeoff at all */
export function cableMaterialReason(cond, basisVal, figured = true) {
  if (basisVal > 0) return null;
  if (!hasCableSetup(cond)) return "no cable setup on this condition — per cable and per pull read 0";
  if (!figured) return "cable runs are not figured in this view";
  return "no linked cable run — 0 until a run links this condition's devices";
}

/** The whole cable takeoff, figured once: conditions + shapes + runs → what
 *  every surface reads. `null` when no condition carries a cable setup, so a
 *  project that never used the feature pays nothing and exports byte-identically.
 *  `duplicates` is the duplicate device check (lib/cableDupes.js): it runs
 *  when the caller supplies `opts.sheetSize` (the canvas and the MCP session
 *  both do — the page geometry it compares), its warnings join
 *  summary.warnings, and it never changes a quantity. Without sheetSize it
 *  is null. */
export function computeCableTakeoff(conditions, shapes, runs, opts = {}) {
  if (!(conditions || []).some((c) => hasCableSetup(c) || isRouteCondition(c)) && !(runs || []).length) return null;
  const resolved = resolveCableRuns(conditions, shapes, runs, opts);
  const summary = cableSummary(resolved, conditions, shapes);
  const duplicates = typeof opts.sheetSize === "function" ? findCableDuplicates(conditions, shapes, opts) : null;
  if (duplicates) summary.warnings.push(...duplicates.warnings);
  return { resolved, summary, byCond: cableByCondition(summary), duplicates };
}

/** Short, still-unique display ids for runs and holds — what a marked-set
 *  chip prints ("run-c711ef"). Each is the record id's first 6 hex digits,
 *  lengthened only until no other id shares the prefix, so a reader finds the
 *  run in the Cable runs sheet by its start. Map(id → short). */
export function runShortIds(records, min = 6) {
  const ids = [...new Set((records || []).map((r) => (typeof r === "string" ? r : r?.id)).filter((x) => typeof x === "string" && x))];
  const body = (id) => id.replace(/^(run|hold)-/, "").replace(/-/g, "");
  const bodies = ids.map(body);
  const out = new Map();
  ids.forEach((id, i) => {
    const b = bodies[i];
    let n = Math.min(min, b.length);
    while (n < b.length && bodies.some((o, j) => j !== i && o.startsWith(b.slice(0, n)))) n += 1;
    out.set(id, `${id.startsWith("hold-") ? "hold" : "run"}-${b.slice(0, n)}`);
  });
  return out;
}

// ── export rows ─────────────────────────────────────────────────────────────

/** One Cable-runs row per run record, unmultiplied, every status included. */
/** @param {any} takeoff computeCableTakeoff() result
 *  @param {((sheetId: string) => string) | null} [sheetLabel] */
export function cableRunRows(takeoff, sheetLabel = null) {
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  const condMult = new Map();
  for (const row of takeoff?.summary?.rows || []) condMult.set(row.condition_id, row.multiplier);
  return (takeoff?.resolved?.runs || []).map((r) => ({
    run_id: r.id, condition: r.finish_tag, device_type: r.device_type, cable_type: r.cable_type,
    tr: r.tr_name || r.tr_id, sheets: r.sheet_ids.map(label).join(" | "), sheet_ids: r.sheet_ids,
    device_sheets: (r.device_sheet_ids || []).map(label).join(" | "), device_sheet_ids: r.device_sheet_ids || [],
    tr_sheet: r.tr_sheet_id ? label(r.tr_sheet_id) : "", tr_sheet_id: r.tr_sheet_id || "",
    route_lf: round2(r.route_lf), vertical_ft: r.vertical_ft, loop_device_ft: r.loop_device_ft, loop_tr_ft: r.loop_tr_ft,
    per_cable_lf: r.per_cable_lf == null ? null : round2(r.per_cable_lf), cables: r.cables,
    location_lf: r.location_lf == null ? null : round2(r.location_lf),
    multiplier: condMult.get(r.condition_id) || 1,
    status: r.status, review_status: r.review, reason: r.reason || "",
    ...(r.over_length ? { over_length: true } : {}),
    ...(r.scale_unconfirmed ? { scale_unconfirmed: true } : {}),
    ...(r.notes ? { notes: r.notes.join("; ") } : {}),
  }));
}

/** The additive `cable` block of opentakeoff.report.v1 — emitted only when a
 *  cable takeoff exists, so a cable-free report is byte-identical. */
/** @param {any} takeoff computeCableTakeoff() result
 *  @param {((sheetId: string) => string) | null} [sheetLabel] */
export function cableReportBlock(takeoff, sheetLabel = null) {
  if (!takeoff) return null;
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  return {
    summary: takeoff.summary.rows,
    by_tr: takeoff.summary.by_tr,
    by_cable_type: takeoff.summary.by_cable_type,
    totals: takeoff.summary.totals,
    runs: cableRunRows(takeoff, sheetLabel),
    unlinked: {
      devices: takeoff.resolved.unlinked.devices.map((d) => ({ ...d, sheet: label(d.sheet_id) })),
      routes: takeoff.resolved.unlinked.routes.map((r) => ({ ...r, sheet: label(r.sheet_id) })),
    },
    held: (takeoff.resolved.held || []).map((d) => ({ ...d, sheet: label(d.sheet_id) })),
    holds: takeoff.resolved.holds || [],
    warnings: takeoff.summary.warnings,
    // the duplicate device check rides only when it found something, so a
    // cable report with no finding is unchanged
    ...(hasDuplicateFindings(takeoff.duplicates) ? { duplicates: takeoff.duplicates } : {}),
  };
}

export const CABLE_SUMMARY_HEADER = Object.freeze(["Condition", "Device type", "Cable type", "TR", "Multiplier", "Waste %", "Device EA", "Pulls", "Cables", "Measured route LF", "Cable LF (net)", "Cable LF (order, with waste)", "Unlinked devices", "Held devices", "Pending runs", `Runs over ${TIA_MAX_LINK_FT} ft`, "Note"]);
export const CABLE_RUNS_HEADER = Object.freeze(["Run ID", "Condition", "Device type", "Cable type", "TR", "Device sheet", "Route sheet(s)", "TR sheet", "Route LF", "Vertical ft", "Loop at device ft", "Loop at TR ft", "Per-cable LF", "Cables", "Location LF", "Multiplier", "Status", "Review status", "Reason / notes"]);
export const CABLE_UNLINKED_HEADER = Object.freeze(["Kind", "Shape", "Condition", "Sheet", "Length LF", "Reason"]);

const rowNote = (r) => [r.withheld ? `withheld: ${r.withheld}` : "", r.leg_warning ? "route segment(s) carry rise/drop legs (ignored)" : "", r.over_length_runs ? `${r.over_length_runs} run${r.over_length_runs === 1 ? "" : "s"} over ${TIA_MAX_LINK_FT} ft per cable` : ""].filter(Boolean).join("; ");
const NO_TR = "(no TR — no linked run)";

/** The three cable tables as plain cell matrices — the CSV sections and the
 *  workbook tabs both render from these so they can never disagree. `L`
 *  converts a length for the display units (identity for imperial). */
/** @param {any} takeoff computeCableTakeoff() result
 *  @param {{ sheetLabel?: ((sheetId: string) => string) | null, L?: (v: number) => any, lengthUnit?: string }} [opts] */
export function cableTables(takeoff, { sheetLabel = null, L = (v) => v, lengthUnit = "LF" } = {}) {
  if (!takeoff) return null;
  const lenHdr = (h) => h.replace(/\bLF\b/g, lengthUnit).replace(/\bft\b/g, lengthUnit === "LF" ? "ft" : "m");
  const conv = (v) => (v == null ? "" : L(v));
  const summary = [CABLE_SUMMARY_HEADER.map(lenHdr)];
  for (const r of takeoff.summary.rows) {
    summary.push([r.finish_tag, r.device_type, r.cable_type, r.tr_name || r.tr_id || NO_TR, r.multiplier, r.waste_pct, r.ea, r.pulls, r.cables, conv(r.route_lf), conv(r.cable_lf), conv(r.cable_lf_order), r.unlinked_devices, r.held_devices, r.pending_runs, r.over_length_runs, rowNote(r)]);
  }
  const qtyCells = (g) => [g.ea, g.pulls, g.cables, conv(g.route_lf), conv(g.cable_lf), conv(g.cable_lf_order), g.unlinked_devices, g.held_devices, g.pending_runs, g.over_length_runs, ""];
  for (const g of takeoff.summary.by_tr) summary.push(["Subtotal by TR", "", "", g.tr_name || g.tr_id || NO_TR, "", "", ...qtyCells(g)]);
  for (const g of takeoff.summary.by_cable_type) summary.push(["Subtotal by cable type", "", g.cable_type, "", "", "", ...qtyCells(g)]);
  summary.push(["TOTAL", "", "", "", "", "", ...qtyCells(takeoff.summary.totals)]);
  const runs = [CABLE_RUNS_HEADER.map(lenHdr)];
  for (const r of cableRunRows(takeoff, sheetLabel)) {
    runs.push([r.run_id, r.condition, r.device_type, r.cable_type, r.tr, r.device_sheets, r.sheets, r.tr_sheet, conv(r.route_lf), conv(r.vertical_ft), conv(r.loop_device_ft), conv(r.loop_tr_ft), conv(r.per_cable_lf), r.cables ?? "", conv(r.location_lf), r.multiplier, r.status, r.review_status, [r.reason, r.notes].filter(Boolean).join("; ")]);
  }
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  const unlinked = [CABLE_UNLINKED_HEADER.map(lenHdr)];
  for (const d of takeoff.resolved.unlinked.devices) unlinked.push(["device", d.shape_id, d.finish_tag, label(d.sheet_id), "", d.reason]);
  for (const r of takeoff.resolved.unlinked.routes) unlinked.push(["route", r.shape_id, r.finish_tag, label(r.sheet_id), conv(r.length_lf), r.reason]);
  for (const d of takeoff.resolved.held || []) unlinked.push(["held device", d.shape_id, d.finish_tag, label(d.sheet_id), "", `held (${d.hold_id}): ${d.reason}`]);
  return { summary, runs, unlinked, warnings: takeoff.summary.warnings };
}

/** The shared refusal for link_run (MCP) and the Link Run tool (canvas): the
 *  first thing wrong with the proposed link, worded with its next move, or
 *  null when the link is sound. Checks run against the CURRENT shapes.
 *  @param {{ device_shape_ids?: string[], route_shape_ids?: string[], tr_id?: string, cables_override?: number | null }} link
 *  @param {any[]} conditions
 *  @param {any[]} shapes
 *  @param {any[]} [runs]
 *  @param {{ uppFor?: (sheetId: string) => number | null | undefined, scaleReason?: (sheetId: string) => string }} [opts]
 *  @returns {string | null} */
export function linkRunRefusal({ device_shape_ids, route_shape_ids, tr_id, cables_override }, conditions, shapes, runs = [], opts = {}) {
  const probe = mintCableRun({ device_shape_ids, route_shape_ids, tr_id, cables_override });
  if (cables_override !== undefined && cables_override !== null && !(Number.isInteger(cables_override) && cables_override >= 1)) return "cables_override must be a whole number of 1 or more (omit it to use the condition's cables_per_location)";
  const ids = strArr(device_shape_ids);
  for (const id of ids) {
    const other = (runs || []).find((r) => Array.isArray(r.device_shape_ids) && r.device_shape_ids.includes(id));
    if (other && isCableHold(other)) return `device ${id} is held by ${other.id} (${other.hold?.reason || "no reason given"}) — unlink_run the hold first to link it`;
    if (other) return `device ${id} is already linked by run ${other.id} — unlink_run it first (one pull per location)`;
  }
  const { runs: [r] } = resolveCableRuns(conditions, shapes, [probe], opts);
  if (r.status === "linked") return null;
  const first = r.reasons[0];
  if (/was deleted$/.test(first)) return `${first.replace(/was deleted$/, "does not exist")} — list_shapes shows every committed id`;
  if (/is not a measured linear shape/.test(first)) return `${first} — trace the route with measure_line and pass that shape id`;
  if (/is not a TR marker/.test(first)) return `${first} — place the TR with place_count on a condition set role "tr" through edit_condition`;
  if (/is not a count marker/.test(first)) return `${first} — a device location is a place_count / symbol_sweep marker`;
  if (/has no cable setup/.test(first)) return `${first} — set cable_setup on it with edit_condition before linking`;
  if (r.status === "withheld") return `${first} — set it with edit_condition { cable_setup: { … } } and link again (no length is ever assumed)`;
  return first;
}

// ── run commands (the canvas's undo family "cable") ────────────────────────
// Pure apply + exact inverse, the approvals.js precedent: the canvas records
// { family: "cable", cmd, inverse } on its ONE gesture history, so ⌘Z takes
// back a link, an unlink or an accept in order with shape edits.
//   link       { run }                 → add;   inverse unlink
//   unlink     { id }                  → drop;  inverse restore (same index)
//   restore    { run, index }          → re-seat verbatim; inverse unlink
//   review     { ids, ts? }            → pending runs get reviewed:true + accepted_ts;
//                                        inverse provenance (verbatim prior origins)
//   provenance { restore: [{ id, provenance }] } → put provenance back verbatim
// Accepting a run never touches its shapes: each keeps its own review status.
// A command that changes nothing returns inverse null (nothing to record).
/** @param {any[]} runs @param {any} cmd @returns {{ runs: any[], inverse: any }} */
export function applyCableRunCommand(runs, cmd) {
  const list = Array.isArray(runs) ? runs : [];
  switch (cmd?.type) {
    case "link": {
      if (!cmd.run || typeof cmd.run.id !== "string" || list.some((r) => r.id === cmd.run.id)) return { runs: list, inverse: null };
      return { runs: [...list, cmd.run], inverse: { type: "unlink", id: cmd.run.id } };
    }
    case "unlink": {
      const index = list.findIndex((r) => r.id === cmd.id);
      if (index < 0) return { runs: list, inverse: null };
      return { runs: list.filter((_, i) => i !== index), inverse: { type: "restore", run: list[index], index } };
    }
    case "restore": {
      if (!cmd.run || list.some((r) => r.id === cmd.run.id)) return { runs: list, inverse: null };
      const at = Math.max(0, Math.min(Number.isInteger(cmd.index) ? cmd.index : list.length, list.length));
      return { runs: [...list.slice(0, at), cmd.run, ...list.slice(at)], inverse: { type: "unlink", id: cmd.run.id } };
    }
    case "review": {
      const ids = new Set(Array.isArray(cmd.ids) ? cmd.ids : []);
      const ts = typeof cmd.ts === "string" ? cmd.ts : nowIso();
      const restore = [];
      const next = list.map((r) => {
        if (!ids.has(r.id) || r.provenance?.reviewed !== false) return r;
        restore.push({ id: r.id, provenance: r.provenance });
        return { ...r, provenance: { ...r.provenance, reviewed: true, accepted_ts: ts } };
      });
      return restore.length ? { runs: next, inverse: { type: "provenance", restore } } : { runs: list, inverse: null };
    }
    case "provenance": {
      const byId = new Map((Array.isArray(cmd.restore) ? cmd.restore : []).map((x) => [x.id, x.provenance]));
      const restore = [];
      const next = list.map((r) => {
        if (!byId.has(r.id)) return r;
        restore.push({ id: r.id, provenance: r.provenance });
        return { ...r, provenance: byId.get(r.id) };
      });
      return restore.length ? { runs: next, inverse: { type: "provenance", restore } } : { runs: list, inverse: null };
    }
    default:
      return { runs: list, inverse: null };
  }
}
