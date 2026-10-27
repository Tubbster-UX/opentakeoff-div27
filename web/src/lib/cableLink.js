// The Link Run tool's click logic (docs/design/CABLE_SETUP.md, Canvas UI §3):
// click the device marker, click the route segment(s) in order, click the TR,
// press Enter. Pure — no React, no DOM: the canvas hands in what lies under
// the click and gets back the next draft plus the message bar text. Every
// length in the readout comes from lib/cable.js (the one cable library); this
// module only decides what a click means.
//
// Draft: { device: shapeId|null, routes: shapeId[], tr: shapeId|null }.
import { hasCableSetup, isTrCondition, resolveCableRuns, linkRunRefusal } from "./cable.js";

/** @type {{ device: string|null, routes: string[], tr: string|null }} */
export const EMPTY_LINK = Object.freeze({ device: null, routes: /** @type {string[]} */ (Object.freeze([])), tr: null });

/** What a shape can be in a run: "device" (a count marker on a cable
 *  condition), "tr" (a count marker on a role "tr" condition), "route" (any
 *  linear shape), or null. */
export function linkRole(shape, condById) {
  if (!shape) return null;
  const c = condById.get(shape.condition_id);
  if (shape.measure_role === "count") return hasCableSetup(c) ? "device" : isTrCondition(c) ? "tr" : null;
  if (shape.measure_role === "linear") return "route";
  return null;
}

const tagOf = (shape, condById) => condById.get(shape?.condition_id)?.finish_tag || "?";

/**
 * One click of the Link Run tool.
 * @param {{device: string|null, routes: string[], tr: string|null}} draft
 * @param {any[]} hits shapes under the click, TOPMOST first
 * @param {{ conditions: any[], runs: any[] }} ctx
 * @returns {{ draft: {device: string|null, routes: string[], tr: string|null}, msg: string }}
 */
export function linkClick(draft, hits, { conditions, runs }) {
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const d = draft && Array.isArray(draft.routes) ? draft : EMPTY_LINK;
  const tagged = (hits || []).map((s) => ({ s, role: linkRole(s, condById) })).filter((h) => h.role);
  const first = (role) => tagged.find((h) => h.role === role)?.s || null;
  const linkedBy = (id) => (runs || []).find((r) => Array.isArray(r.device_shape_ids) && r.device_shape_ids.includes(id));

  // 1. no device yet: the click must start at a device marker
  if (!d.device) {
    const dev = first("device");
    if (!dev) {
      if (!hits?.length) return { draft: d, msg: "Link Run: click a device marker to start (a count marker on a condition with a cable setup)." };
      return { draft: d, msg: "Link Run starts at a device marker — a count marker on a condition with a cable setup." };
    }
    const prior = linkedBy(dev.id);
    if (prior) return { draft: d, msg: `That device is already linked by run ${prior.id} — unlink it in the Runs panel first (one pull per location).` };
    return { draft: { device: dev.id, routes: [], tr: null }, msg: `Device ${tagOf(dev, condById)} picked — now click its route segments in order, from the device toward the TR.` };
  }

  // 2. another device restarts the run from it
  const dev = first("device");
  if (dev && dev.id !== d.device && !first("route") && !first("tr")) {
    const prior = linkedBy(dev.id);
    if (prior) return { draft: d, msg: `That device is already linked by run ${prior.id} — unlink it in the Runs panel first.` };
    return { draft: { device: dev.id, routes: [], tr: null }, msg: `Restarted at device ${tagOf(dev, condById)} — click its route segments in order.` };
  }

  // 3. TR vs route: a TR marker usually sits on the route's end, so once a
  // segment is picked a hit on the TR means the TR; before that, the route.
  const tr = first("tr");
  const route = first("route");
  if (tr && (d.routes.length || !route)) {
    return { draft: { ...d, tr: tr.id }, msg: d.routes.length ? `TR ${tr.label || tagOf(tr, condById)} picked — press Enter to link the run.` : `TR ${tr.label || tagOf(tr, condById)} picked — the run still needs at least one route segment.` };
  }
  if (route) {
    const at = d.routes.indexOf(route.id);
    if (at >= 0 && at === d.routes.length - 1) return { draft: { ...d, routes: d.routes.slice(0, -1) }, msg: "Last segment removed." };
    if (at >= 0) return { draft: d, msg: "That segment is already in this run (a segment may serve other runs, but not twice in one)." };
    const n = d.routes.length + 1;
    return { draft: { ...d, routes: [...d.routes, route.id] }, msg: `Segment ${n} added — click the next segment, or the TR marker.` };
  }
  if (hits?.length) return { draft: d, msg: "That shape is not part of a run — click a linear route segment or the TR marker." };
  return { draft: d, msg: d.routes.length ? "Click the next route segment or the TR marker; Enter links the run, Backspace removes the last pick, Esc cancels." : "Click the device's first route segment (a linear shape)." };
}

/** Backspace: take back the last pick (TR, then the newest segment, then the device). */
export function linkUndoPick(draft) {
  const d = draft && Array.isArray(draft.routes) ? draft : EMPTY_LINK;
  if (d.tr) return { ...d, tr: null };
  if (d.routes.length) return { ...d, routes: d.routes.slice(0, -1) };
  return EMPTY_LINK;
}

/**
 * The live readout before commit: route LF and per-cable LF from the CURRENT
 * shapes (lib/cable.js), plus the refusal Enter would hit, if any.
 * @returns {{ stage: "device"|"route"|"tr"|"ready", device: string, segments: number, tr: string,
 *   route_lf: number, per_cable_lf: number|null, cables: number|null, location_lf: number|null,
 *   refusal: string|null }}
 */
export function linkReadout(draft, { conditions, shapes, runs, uppFor }) {
  const d = draft && Array.isArray(draft.routes) ? draft : EMPTY_LINK;
  const byId = new Map((shapes || []).map((s) => [s.id, s]));
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const dev = d.device ? byId.get(d.device) : null;
  const tr = d.tr ? byId.get(d.tr) : null;
  const probe = { id: "draft", device_shape_ids: d.device ? [d.device] : [], route_shape_ids: d.routes, tr_id: d.tr || "", provenance: { method: "manual" } };
  const r = resolveCableRuns(conditions, shapes, [probe], { uppFor }).runs[0];
  const stage = !d.device ? "device" : !d.routes.length ? "route" : !d.tr ? "tr" : "ready";
  // a full draft resolves; a partial one still reports the measured route so far
  // and the per-cable figure the setup WOULD give, when the setup is complete
  const setup = dev ? condById.get(dev.condition_id)?.cable_setup : null;
  const complete = setup && [setup.vertical_ft, setup.loop_device_ft, setup.loop_tr_ft].every((v) => typeof v === "number" && v >= 0);
  const per = r.status === "linked" ? r.per_cable_lf : (complete && d.routes.length ? r.route_lf + setup.vertical_ft + setup.loop_device_ft + setup.loop_tr_ft : null);
  const cables = r.cables ?? null;
  const refusal = stage === "ready" ? linkRunRefusal({ device_shape_ids: probe.device_shape_ids, route_shape_ids: d.routes, tr_id: d.tr }, conditions, shapes, runs, { uppFor }) : null;
  return {
    stage,
    device: dev ? tagOf(dev, condById) : "",
    segments: d.routes.length,
    tr: tr ? (tr.label || tagOf(tr, condById)) : "",
    route_lf: r.route_lf,
    per_cable_lf: per,
    cables,
    location_lf: per != null && cables != null ? per * cables : null,
    refusal,
  };
}
