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
  if (!finiteNonNeg(setup.vertical_ft)) out.push("vertical_ft is required (no starting value for this device type — enter the job's vertical)");
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
 * @param {{ uppFor?: (sheetId: string) => number | null | undefined, scaleReason?: (sheetId: string) => string }} [opts]
 *   uppFor answers "does this sheet have a scale" for the surface asking (the
 *   canvas knows stitches; an MCP session knows its loaded sheets). Omitted =
 *   every sheet is taken as scaled (the shape's stored feet are trusted).
 *   scaleReason words the refusal for an unscaled sheet.
 * @returns {{ runs: ResolvedRun[], unlinked: { devices: any[], routes: any[] }, warnings: string[] }}
 */
export function resolveCableRuns(conditions, shapes, runs, opts = {}) {
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const shapeById = new Map((shapes || []).map((s) => [s.id, s]));
  const uppFor = typeof opts.uppFor === "function" ? opts.uppFor : null;
  const scaleReason = typeof opts.scaleReason === "function" ? opts.scaleReason : (k) => `sheet ${k} has no scale — a route is a real length, so set the scale first`;
  const resolved = [];
  const warnings = [];
  const warned = new Set();
  const linkedDevices = new Set();   // device ids in LINKED runs
  const deviceRun = new Map();       // device id → first run referencing it (any status)
  const routeRun = new Map();        // route id → first run referencing it (any status)
  const routeConds = new Set();      // conditions that serve as route conditions (any linked run)

  for (const raw of runs || []) {
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
      resolved.push({
        ...base,
        vertical_ft: setup.vertical_ft, loop_device_ft: setup.loop_device_ft, loop_tr_ft: setup.loop_tr_ft,
        per_cable_lf: perCable, cables, location_lf: perCable * cables,
        ...(Number.isInteger(run.cables_override) ? { cables_override: run.cables_override } : {}),
      });
      for (const id of devIds) linkedDevices.add(id);
      for (const seg of segments) routeConds.add(shapeById.get(seg.shape_id).condition_id);
    } else {
      resolved.push({
        ...base,
        vertical_ft: setup ? setup.vertical_ft : null, loop_device_ft: setup ? setup.loop_device_ft : null, loop_tr_ft: setup ? setup.loop_tr_ft : null,
        per_cable_lf: null, cables, location_lf: null,
      });
    }
  }

  // ── unlinked devices: every marker on a cable condition with no LINKED run ─
  const devices = [];
  for (const s of shapes || []) {
    if (s.measure_role !== "count") continue;
    const c = condById.get(s.condition_id);
    if (!c || !hasCableSetup(c)) continue;
    if (linkedDevices.has(s.id)) continue;
    const via = deviceRun.get(s.id);
    const r = via ? resolved.find((x) => x.id === via) : null;
    devices.push({
      shape_id: s.id, condition_id: c.id, finish_tag: c.finish_tag, sheet_id: s.sheet_id,
      ...(typeof s.label === "string" && s.label ? { label: s.label } : {}),
      reason: r ? `its run ${r.id} is ${r.status}: ${r.reason}` : "no run links this device",
    });
  }
  // ── unlinked routes: a segment referenced by a non-linked run, or an
  // unreferenced linear shape on a condition some linked run already uses as
  // a route condition. A linear shape on any other condition (base, a
  // transition, a wall) is not assumed to be a route.
  const routes = [];
  for (const s of shapes || []) {
    if (s.measure_role !== "linear") continue;
    const via = routeRun.get(s.id);
    if (via) {
      const r = resolved.find((x) => x.id === via);
      if (!r || r.status === "linked") continue;
      routes.push({ shape_id: s.id, condition_id: s.condition_id, sheet_id: s.sheet_id, length_lf: routeLengthFt(s), reason: `its run ${r.id} is ${r.status}: ${r.reason}` });
    } else if (routeConds.has(s.condition_id)) {
      routes.push({ shape_id: s.id, condition_id: s.condition_id, sheet_id: s.sheet_id, length_lf: routeLengthFt(s), reason: "no run links this segment" });
    }
  }
  return { runs: resolved, unlinked: { devices, routes }, warnings };
}

// ── rollups ─────────────────────────────────────────────────────────────────

const zeroQty = () => ({ ea: 0, pulls: 0, cables: 0, route_lf: 0, cable_lf: 0, cable_lf_order: 0, unlinked_devices: 0, pending_runs: 0 });
const QTY_KEYS = Object.keys(zeroQty());
const addQty = (a, b) => { for (const k of QTY_KEYS) a[k] += b[k] || 0; return a; };
const roundQty = (q) => ({ ...q, route_lf: round2(q.route_lf), cable_lf: round2(q.cable_lf), cable_lf_order: round2(q.cable_lf_order) });

/**
 * The Cable summary: one row per (device condition × TR) with linked runs,
 * plus one row per cable condition that has no linked run at all (so its EA
 * shows against zero pulls — the gap IS the unlinked count). ×N applies to
 * every quantity row-wide (ea, pulls, cables, LF, unlinked devices), the house
 * convention for reported quantities; pending_runs is a count of records, not
 * a quantity, and stays raw. Waste (the condition's waste_pct) applies to
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
    const withheld = resolved.runs.filter((r) => r.condition_id === c.id && r.status === "withheld");
    if (!own.length) {
      rows.push({
        condition_id: c.id, finish_tag: c.finish_tag, device_type: c.cable_setup.device_type,
        cable_type: typeof c.cable_setup.cable_type === "string" ? c.cable_setup.cable_type : "",
        tr_id: "", tr_name: "", multiplier: mult, waste_pct: Math.max(0, Number(c.waste_pct) || 0),
        ...zeroQty(), ea, unlinked_devices: unlinked, leg_warning: false,
        ...(withheld.length ? { withheld: withheld[0].reason, withheld_runs: withheld.length } : {}),
      });
      continue;
    }
    own.forEach((row, i) => {
      rows.push({ ...roundQty(row), ea: i === 0 ? ea : 0, unlinked_devices: i === 0 ? unlinked : 0, ...(i === 0 && withheld.length ? { withheld: withheld[0].reason, withheld_runs: withheld.length } : {}) });
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
  const by_tr = group((r) => r.tr_id, (r) => ({ tr_id: r.tr_id, tr_name: r.tr_name })).filter((g) => g.tr_id || g.pulls);
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

/** The whole cable takeoff, figured once: conditions + shapes + runs → what
 *  every surface reads. `null` when no condition carries a cable setup, so a
 *  project that never used the feature pays nothing and exports byte-identically. */
export function computeCableTakeoff(conditions, shapes, runs, opts = {}) {
  if (!(conditions || []).some(hasCableSetup) && !(runs || []).length) return null;
  const resolved = resolveCableRuns(conditions, shapes, runs, opts);
  const summary = cableSummary(resolved, conditions, shapes);
  return { resolved, summary, byCond: cableByCondition(summary) };
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
    route_lf: round2(r.route_lf), vertical_ft: r.vertical_ft, loop_device_ft: r.loop_device_ft, loop_tr_ft: r.loop_tr_ft,
    per_cable_lf: r.per_cable_lf == null ? null : round2(r.per_cable_lf), cables: r.cables,
    location_lf: r.location_lf == null ? null : round2(r.location_lf),
    multiplier: condMult.get(r.condition_id) || 1,
    status: r.status, review_status: r.review, reason: r.reason || "",
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
    warnings: takeoff.summary.warnings,
  };
}

export const CABLE_SUMMARY_HEADER = Object.freeze(["Condition", "Device type", "Cable type", "TR", "Multiplier", "Waste %", "Device EA", "Pulls", "Cables", "Measured route LF", "Cable LF (net)", "Cable LF (order, with waste)", "Unlinked devices", "Pending runs", "Note"]);
export const CABLE_RUNS_HEADER = Object.freeze(["Run ID", "Condition", "Device type", "Cable type", "TR", "Sheet(s)", "Route LF", "Vertical ft", "Loop at device ft", "Loop at TR ft", "Per-cable LF", "Cables", "Location LF", "Multiplier", "Status", "Review status", "Reason / notes"]);
export const CABLE_UNLINKED_HEADER = Object.freeze(["Kind", "Shape", "Condition", "Sheet", "Length LF", "Reason"]);

const rowNote = (r) => [r.withheld ? `withheld: ${r.withheld}` : "", r.leg_warning ? "route segment(s) carry rise/drop legs (ignored)" : ""].filter(Boolean).join("; ");

/** The three cable tables as plain cell matrices — the CSV sections and the
 *  workbook tabs both render from these so they can never disagree. `L`
 *  converts a length for the display units (identity for imperial). */
export function cableTables(takeoff, { sheetLabel = null, L = (v) => v, lengthUnit = "LF" } = {}) {
  if (!takeoff) return null;
  const lenHdr = (h) => h.replace(/\bLF\b/g, lengthUnit).replace(/\bft\b/g, lengthUnit === "LF" ? "ft" : "m");
  const conv = (v) => (v == null ? "" : L(v));
  const summary = [CABLE_SUMMARY_HEADER.map(lenHdr)];
  for (const r of takeoff.summary.rows) {
    summary.push([r.finish_tag, r.device_type, r.cable_type, r.tr_name || r.tr_id, r.multiplier, r.waste_pct, r.ea, r.pulls, r.cables, conv(r.route_lf), conv(r.cable_lf), conv(r.cable_lf_order), r.unlinked_devices, r.pending_runs, rowNote(r)]);
  }
  const sub = (title, g, cell) => summary.push([title, "", "", cell(g), "", "", g.ea, g.pulls, g.cables, conv(g.route_lf), conv(g.cable_lf), conv(g.cable_lf_order), g.unlinked_devices, g.pending_runs, ""]);
  for (const g of takeoff.summary.by_tr) sub("Subtotal by TR", g, (x) => x.tr_name || x.tr_id);
  for (const g of takeoff.summary.by_cable_type) summary.push(["Subtotal by cable type", "", g.cable_type, "", "", "", g.ea, g.pulls, g.cables, conv(g.route_lf), conv(g.cable_lf), conv(g.cable_lf_order), g.unlinked_devices, g.pending_runs, ""]);
  const t = takeoff.summary.totals;
  summary.push(["TOTAL", "", "", "", "", "", t.ea, t.pulls, t.cables, conv(t.route_lf), conv(t.cable_lf), conv(t.cable_lf_order), t.unlinked_devices, t.pending_runs, ""]);
  const runs = [CABLE_RUNS_HEADER.map(lenHdr)];
  for (const r of cableRunRows(takeoff, sheetLabel)) {
    runs.push([r.run_id, r.condition, r.device_type, r.cable_type, r.tr, r.sheets, conv(r.route_lf), conv(r.vertical_ft), conv(r.loop_device_ft), conv(r.loop_tr_ft), conv(r.per_cable_lf), r.cables ?? "", conv(r.location_lf), r.multiplier, r.status, r.review_status, [r.reason, r.notes].filter(Boolean).join("; ")]);
  }
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  const unlinked = [CABLE_UNLINKED_HEADER.map(lenHdr)];
  for (const d of takeoff.resolved.unlinked.devices) unlinked.push(["device", d.shape_id, d.finish_tag, label(d.sheet_id), "", d.reason]);
  for (const r of takeoff.resolved.unlinked.routes) unlinked.push(["route", r.shape_id, r.condition_id, label(r.sheet_id), conv(r.length_lf), r.reason]);
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
