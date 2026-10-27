// Marked set — Division 27 cable marks (docs/design/CABLE_SETUP.md, Phase 3:
// "draws each route in its condition color with a chip showing run ID and
// per-cable LF, and adds pulls, cables and order LF per condition to the
// legend cover"). Pure: no pdf-lib, no DOM. lib/markedset.js asks this module
// WHAT to burn and WHERE, then draws it; the placement and the legend text are
// unit-tested here (web/test/cableMarks.test.ts) instead of inside a PDF.
//
// What a sheet gets, all in image px at the marked set's render scale:
//   • a chip per run on its route — "run-c711ef · DATA-1 · 54.6 LF", with
//     " >295" when the run is over the TIA-568 copper limit and the status in
//     place of the length when the run is withheld or broken. The route
//     segment's own generic "ROUTE · 16.6 LF" chip is suppressed: the run chip
//     says more, and a corridor of overlapping generic chips was unreadable on
//     the first real bid.
//   • a tag beside each device marker naming its run — the same short id — so
//     a device on the comms plan and its route on the ceiling plan connect.
//   • a TR's name beside its marker.
//   • rings: amber dashed for an unlinked device, grey dotted for a held one.
// Chips and tags are placed greedily against everything already placed (the
// markers included), trying points along the route and beside it, so dense
// corridors spread out instead of stacking.
import { runShortIds, hasCableSetup, isTrCondition, isRouteCondition, routeKindOf, TIA_MAX_LINK_FT } from "./cable.js";

/** Font sizes, points. */
export const CHIP_PT = 7;
export const TAG_PT = 6;
/** A chip is its text plus 8 pt of padding wide (the marked set's chip()
 *  convention) and its font size plus 4.5 pt tall. */
export const CHIP_PAD_PT = 8;
export const chipHeightPt = (size) => size + 4.5;
/** Where along a segment a route chip may sit, in order of preference. */
const FRACTIONS = [0.25, 0.5, 0.75, 0.15, 0.35, 0.65, 0.85, 0.05, 0.95];

const rectAt = (x, y, w, h) => ({ x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 });
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** The point at arclength fraction `f` (0..1) along a polyline, with the
 *  unit tangent there. A zero-length line answers its first point. */
export function polylineAt(pts, f) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  if (!total) return { x: pts[0][0], y: pts[0][1], tx: 1, ty: 0 };
  let d = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, d / seg[i]) : 0;
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: seg[i] ? (bx - ax) / seg[i] : 1, ty: seg[i] ? (by - ay) / seg[i] : 0 };
    }
    d -= seg[i];
  }
  return { x: pts[0][0], y: pts[0][1], tx: 1, ty: 0 };
}

/**
 * Greedy label placement. Each item, in order, takes its first candidate
 * center that overlaps nothing already placed and stays on the sheet; when
 * every candidate collides it takes the one with the least overlap (and is
 * returned with clear: false). `placed` holds obstacle rects and grows.
 * @param {({ w: number, h: number, candidates: [number, number][] } & Record<string, any>)[]} items
 * @param {{ placed?: { x0: number, y0: number, x1: number, y1: number }[], W?: number, H?: number }} [opts]
 */
export function placeLabels(items, { placed = [], W = Infinity, H = Infinity } = {}) {
  const out = [];
  for (const it of items) {
    const { candidates, ...rest } = it;
    let best = null;
    let bestCost = Infinity;
    for (const [x, y] of candidates || []) {
      const r = rectAt(x, y, it.w, it.h);
      let cost = r.x0 < 0 || r.y0 < 0 || r.x1 > W || r.y1 > H ? it.w * it.h : 0;
      for (const p of placed) cost += overlapArea(r, p);
      if (cost < bestCost) { bestCost = cost; best = { x, y, r }; if (cost === 0) break; }
    }
    if (!best) continue;
    placed.push(best.r);
    out.push({ ...rest, x: best.x, y: best.y, clear: bestCost === 0 });
  }
  return out;
}

/**
 * The cable marks for ONE sheet of the marked set.
 * @param {any} cable computeCableTakeoff() result (null → nothing)
 * @param {{ sheetId: string, shapes: any[], conditions: any[], W: number, H: number, ptScale: number,
 *   measure: (text: string, sizePt: number) => number, fmtLen: (ft: number) => string }} ctx
 *   W/H: the sheet in image px; ptScale: points per image px; measure: a
 *   string's width in points at a font size; fmtLen: "54.6 LF" (units applied).
 */
export function cableSheetMarks(cable, { sheetId, shapes, conditions, W, H, ptScale, measure, fmtLen }) {
  /** @type {{ suppress: Set<string>, chips: any[], tags: any[], rings: any[], trLabels: any[] }} */
  const out = { suppress: new Set(), chips: [], tags: [], rings: [], trLabels: [] };
  if (!cable?.resolved) return out;
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const onSheet = (shapes || []).filter((s) => s.sheet_id === sheetId && Array.isArray(s.verts_norm) && s.verts_norm.length);
  const byId = new Map(onSheet.map((s) => [s.id, s]));
  const px = (s) => s.verts_norm.map(([nx, ny]) => [nx * W, ny * H]);
  const runs = cable.resolved.runs || [];
  const short = runShortIds(runs);
  const k = 1 / ptScale;   // points → image px
  const box = (text, size) => ({ w: (measure(text, size) + CHIP_PAD_PT) * k, h: chipHeightPt(size) * k });
  const around = (x, y, b, gapPt) => {
    const g = gapPt * k;
    return [[x + g + b.w / 2, y], [x - g - b.w / 2, y], [x, y - g - b.h / 2], [x, y + g + b.h / 2],
      [x + g + b.w / 2, y - g - b.h / 2], [x + g + b.w / 2, y + g + b.h / 2], [x - g - b.w / 2, y - g - b.h / 2], [x - g - b.w / 2, y + g + b.h / 2]];
  };
  const placed = [];
  // every count marker is an obstacle (the marked set draws a 4.5 pt dot)
  for (const s of onSheet) if (s.measure_role === "count") { const [x, y] = px(s)[0]; placed.push(rectAt(x, y, 10 * k, 10 * k)); }

  // TR names
  const trItems = [];
  for (const s of onSheet) {
    if (s.measure_role !== "count" || !isTrCondition(condById.get(s.condition_id))) continue;
    const text = (typeof s.label === "string" && s.label.trim()) || "TR?";
    const b = box(text, TAG_PT);
    const [x, y] = px(s)[0];
    trItems.push({ shape_id: s.id, text, ...b, candidates: around(x, y, b, 6) });
  }
  out.trLabels = placeLabels(trItems, { placed, W, H });

  // a tag beside every device marker a run names — the run's short id
  const runByDevice = new Map();
  for (const r of runs) for (const d of r.device_shape_ids || []) if (!runByDevice.has(d)) runByDevice.set(d, r);
  const tagItems = [];
  for (const s of onSheet) {
    if (s.measure_role !== "count") continue;
    const r = runByDevice.get(s.id);
    if (!r) continue;
    const text = short.get(r.id);
    const b = box(text, TAG_PT);
    const [x, y] = px(s)[0];
    tagItems.push({ shape_id: s.id, run_id: r.id, text, ...b, color: condById.get(s.condition_id)?.color || null, tone: r.status !== "linked" ? "bad" : r.over_length ? "over" : "ok", candidates: around(x, y, b, 6) });
  }
  out.tags = placeLabels(tagItems, { placed, W, H });

  // rings: the gaps, so they are caught on paper too
  for (const [list, kind] of [[cable.resolved.unlinked?.devices || [], "unlinked"], [cable.resolved.held || [], "held"]]) {
    for (const d of list) {
      const s = byId.get(d.shape_id);
      if (!s) continue;
      const [x, y] = px(s)[0];
      out.rings.push({ shape_id: s.id, x, y, kind });
    }
  }

  // a chip per run on its route, on this sheet's segments, in run order
  const chipItems = [];
  for (const r of runs) {
    const segs = (r.route_shape_ids || []).map((id) => byId.get(id)).filter((s) => s && s.measure_role === "linear" && s.verts_norm.length >= 2);
    if (!segs.length) continue;
    for (const s of segs) out.suppress.add(s.id);
    const tag = r.finish_tag || "?";
    const text = r.status === "linked"
      ? `${short.get(r.id)} · ${tag} · ${fmtLen(r.per_cable_lf)}${r.over_length ? ` >${TIA_MAX_LINK_FT}` : ""}`
      : `${short.get(r.id)} · ${tag} · ${r.status}`;
    const b = box(text, CHIP_PT);
    const candidates = [];
    for (const s of segs) {
      const pts = px(s);
      for (const f of FRACTIONS) {
        const p = polylineAt(pts, f);
        const o = b.h * 0.9;
        candidates.push([p.x, p.y], [p.x - p.ty * o, p.y + p.tx * o], [p.x + p.ty * o, p.y - p.tx * o]);
      }
    }
    chipItems.push({ run_id: r.id, text, ...b, color: condById.get(r.condition_id)?.color || null, tone: r.status !== "linked" ? "bad" : r.over_length ? "over" : "ok", candidates });
  }
  out.chips = placeLabels(chipItems, { placed, W, H });
  return out;
}

/**
 * The legend cover's cable text: the meta line, one line per cable / route /
 * TR condition (pulls, cables, net and order LF — ×N applied, waste on the
 * order only), the key to the sheet marks, and the cable warnings.
 * @param {any} cable computeCableTakeoff() result
 * @param {any[]} conditions
 * @param {{ fmtLen: (ft: number) => string }} fmt
 * @returns {{ meta: string, lines: Map<string, string>, key: string, warnings: string[] } | null}
 */
export function cableLegend(cable, conditions, { fmtLen }) {
  if (!cable?.summary?.totals) return null;
  const t = cable.summary.totals;
  const n = (v, w) => `${v} ${w}${v === 1 ? "" : "s"}`;
  const meta = [
    `Cable runs: ${n(t.pulls, "pull")} linked`, `${n(t.pending_runs, "run")} pending review`, n(t.unlinked_devices, "unlinked device"),
    ...(t.held_devices ? [n(t.held_devices, "held device")] : []),
    ...(t.over_length_runs ? [`${t.over_length_runs} over ${TIA_MAX_LINK_FT} ft per cable`] : []),
  ].join(" · ");
  const byCond = cable.byCond instanceof Map ? cable.byCond : new Map();
  const lines = new Map();
  const pathwayRow = new Map((cable.pathway?.rows || []).map((r) => [r.condition_id, r]));
  for (const c of conditions || []) {
    if (hasCableSetup(c)) {
      const q = byCond.get(c.id);
      if (!q) continue;
      const waste = Math.max(0, Number(c.waste_pct) || 0);
      lines.set(c.id, [
        n(q.pulls, "pull"), n(q.cables, "cable"), `${fmtLen(q.cable_lf)} cable net`, `${fmtLen(q.cable_lf_order)} order at ${waste}% waste`,
        q.unlinked_devices ? `${q.unlinked_devices} unlinked` : "", q.held_devices ? `${q.held_devices} held` : "",
      ].filter(Boolean).join(" · "));
    } else if (isRouteCondition(c)) {
      // a trunk or branch condition names its kind and its pathway LF, each
      // segment counted once; an untagged one keeps the line it always had
      const kind = routeKindOf(c);
      const p = pathwayRow.get(c.id);
      lines.set(c.id, kind && p
        ? `${kind} pathway, ${fmtLen(p.pathway_lf)} measured once: not a cable quantity; cable LF is figured per run on each device condition`
        : "cable route pathway, not a cable quantity: cable LF is figured per run on each device condition");
    } else if (isTrCondition(c)) {
      lines.set(c.id, "telecom room: where the runs home");
    }
  }
  const key = "Route chips: run ID · device condition · per-cable LF (the Cable runs sheet lists every run in full); each device tag carries its run ID. Amber ring: unlinked device. Grey ring: held device.";
  return { meta, lines, key, warnings: [...(cable.summary.warnings || [])] };
}

/** Word-wrap `text` to `maxW` points with `measure(str)` → points. A single
 *  word wider than the line stays on its own line. */
export function wrapText(text, maxW, measure) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
