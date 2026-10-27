// Division 27 duplicate device check (docs/design/CABLE_SETUP.md, "Recorded
// while building item 3") — pure, no React, no DOM. lib/cable.js calls it
// from computeCableTakeoff, so the canvas, the report exports, the marked set
// and the MCP server all read the same findings.
//
// The failure it exists for, from a real bid: the same 14 cameras were drawn
// twice — camera outlets on the communications plan and CAM markers on the
// security plan, two sheets of one floor at one page size and scale — and
// both sets sat on cable conditions, so pulls, cable LF and price doubled
// with no warning. scope_duplicates compares floor-area polygons and cannot
// see count markers. Two cases:
//
//   1. SAME SHEET — two count markers on cable conditions closer than a
//      physical device spacing allows (a symbol sweep plus a manual click on
//      the same symbol). Measured in feet when the sheet's scale and page
//      size are known, in a fraction of the sheet otherwise; the finding says
//      which.
//   2. OVERLAY PLANS — two sheets of matching page size whose cable markers
//      coincide in normalized position, often enough to be a pattern rather
//      than chance.
//
// A check never changes a quantity: nothing here merges, moves or deletes a
// marker, and every count stays as committed. Findings are flags with the
// shape ids to look at. Coinciding markers where one side sits on a
// NON-cable condition are not duplicates for cable purposes (that is the fix:
// move one set to a reference condition) — they are listed under `reference`
// as detail, never as a warning.
import { hasCableSetup } from "./cable.js";
import { round2 } from "./num.js";

/** Same-sheet threshold with a known scale: two device markers closer than
 *  this many real feet are flagged. A device symbol is drawn about 1/4" on
 *  paper — 2 ft at 1/8" = 1'-0", 1 ft at 1/4" = 1'-0" — and two clicks on
 *  one symbol (or a sweep's center and a click on its edge) land within
 *  half of it. Two real devices are not drawn that close on a plan: a
 *  two-gang location is ONE marker carrying its cable count, and
 *  back-to-back outlets sit either side of a wall, at least the wall plus
 *  both symbols apart on paper. */
export const SAME_SHEET_DUP_FT = 1.0;
/** Same-sheet threshold with no scale: a fraction of the sheet's long edge
 *  (or of the normalized unit square when the page size is unknown).
 *  0.0035 × a 36" ARCH D sheet = 0.126" on paper = 1.0 ft at 1/8" = 1'-0",
 *  the commonest plan scale and sheet, so the fallback matches the feet rule
 *  where most plans sit; at 1/4" it reads 0.5 ft, tighter, never looser. */
export const SAME_SHEET_DUP_NORM = 0.0035;
/** Page sizes match when each dimension agrees within 1%. The same sheet
 *  size from two disciplines' CAD is identical to the point; 1% absorbs a
 *  rounding of the page box and still separates ARCH D (36 × 24) from
 *  ANSI D (34 × 22, 5.5% off) and 42 × 30. Orientation must match. */
export const PAGE_SIZE_TOL = 0.01;
/** When both sheets carry a scale, they must agree within 1% to be overlay
 *  plans; an enlarged plan on the same page size is not compared. A sheet
 *  with no scale does not block the comparison (devices are counted without
 *  one). */
export const SCALE_TOL = 0.01;
/** Overlay position tolerance: two markers on matching sheets coincide when
 *  they sit within 0.75% of the long edge of each other — 0.27" on a 36"
 *  sheet, about one device symbol, ≈ 2.2 ft at 1/8" = 1'-0". The same device
 *  drawn by two disciplines over one background lands within a symbol of
 *  itself (an outlet on the wall face, the camera symbol just off it). */
export const OVERLAY_POS_TOL = 0.0075;
/** A pair of sheets is reported only when the coinciding markers make a
 *  pattern: at least 3 positions AND at least half of the smaller of the two
 *  condition sets involved. Both halves matter: 1 or 2 coincidences between
 *  dense sheets happen by chance (a card reader and a data outlet by the
 *  same door), and a share of the SMALLER set (per condition on each sheet,
 *  not per sheet) keeps 14 cameras visible on a comms plan that also
 *  carries 200 data outlets. */
export const OVERLAY_MIN_POSITIONS = 3;
export const OVERLAY_MIN_SHARE = 0.5;

export const DUPLICATE_THRESHOLDS = Object.freeze({
  same_sheet_ft: SAME_SHEET_DUP_FT, same_sheet_fraction: SAME_SHEET_DUP_NORM,
  page_size_tolerance: PAGE_SIZE_TOL, scale_tolerance: SCALE_TOL, overlay_position_fraction: OVERLAY_POS_TOL,
  overlay_min_positions: OVERLAY_MIN_POSITIONS, overlay_min_share: OVERLAY_MIN_SHARE,
});

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const posOf = (s) => {
  const p = Array.isArray(s?.verts_norm) ? s.verts_norm[0] : null;
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
};
const sizeOk = (z) => !!z && Number.isFinite(z.w) && Number.isFinite(z.h) && z.w > 0 && z.h > 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
const pctText = (f) => `${round2(f * 100)}%`;

/** Pairs (i, j) within `thr` in a metric of the form hypot(dx·fx, dy·fy):
 *  sort by x, sweep the x window. Deterministic: ascending i, then j. */
function pairsWithin(pts, fx, fy, thr) {
  const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || a - b);
  const win = thr / fx;
  const out = [];
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      const dx = pts[j][0] - pts[i][0];
      if (dx > win) break;
      const d = Math.hypot(dx * fx, (pts[j][1] - pts[i][1]) * fy);
      if (d <= thr) out.push(i < j ? [i, j, d] : [j, i, d]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Find count markers on cable conditions that look like the same device
 * counted twice. Never changes anything.
 *
 * @param {any[]} conditions
 * @param {any[]} shapes
 * @param {{ sheetSize?: (sheetId: string) => ({ w: number, h: number } | null | undefined),
 *   uppFor?: (sheetId: string) => number | null | undefined,
 *   sheetLabel?: (sheetId: string) => string }} [opts]
 *   sheetSize: the sheet's page size in the same pixel space uppFor speaks
 *   (image px at the render scale); null when this surface does not know it.
 *   uppFor: real feet per image px, or null when the sheet has no scale.
 * @returns {{ same_sheet: any[], cross_sheet: any[], reference: any[], not_compared: any[], warnings: string[], count: number, thresholds: any }}
 */
export function findCableDuplicates(conditions, shapes, opts = {}) {
  const sheetSize = typeof opts.sheetSize === "function" ? opts.sheetSize : () => null;
  const uppFor = typeof opts.uppFor === "function" ? opts.uppFor : () => null;
  const sheetLabel = typeof opts.sheetLabel === "function" ? opts.sheetLabel : (k) => k;
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const isCable = (s) => hasCableSetup(condById.get(s.condition_id));
  const tagOf = (id) => condById.get(id)?.finish_tag ?? id;
  const empty = { same_sheet: [], cross_sheet: [], reference: [], not_compared: [], warnings: [], count: 0, thresholds: DUPLICATE_THRESHOLDS };

  // count markers per sheet, in document order; sheets in first-seen order
  const bySheet = new Map();
  for (const s of shapes || []) {
    if (s?.measure_role !== "count") continue;
    const p = posOf(s);
    if (!p) continue;
    let g = bySheet.get(s.sheet_id);
    if (!g) { g = { all: [], cable: [] }; bySheet.set(s.sheet_id, g); }
    const m = { s, p, cable: isCable(s), ord: g.all.length };
    g.all.push(m);
    if (m.cable) g.cable.push(m);
  }
  if (![...bySheet.values()].some((g) => g.cable.length)) return empty;
  const sizeOf = (k) => { const z = sheetSize(k); return sizeOk(z) ? { w: z.w, h: z.h } : null; };
  const scaleOf = (k) => { const u = uppFor(k); return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : null; };

  // ── 1. same sheet ─────────────────────────────────────────────────────────
  const same_sheet = [];
  const warnings = [];
  for (const [k, g] of bySheet) {
    if (g.cable.length < 2) continue;
    const size = sizeOf(k), upp = scaleOf(k);
    const feet = !!(size && upp);
    const long = size ? Math.max(size.w, size.h) : 1;
    const fx = feet ? size.w * upp : size ? size.w / long : 1;
    const fy = feet ? size.h * upp : size ? size.h / long : 1;
    const thr = feet ? SAME_SHEET_DUP_FT : SAME_SHEET_DUP_NORM;
    const pairs = pairsWithin(g.cable.map((m) => m.p), fx, fy, thr);
    if (!pairs.length) continue;
    // union-find: three markers stacked on one symbol are one finding
    const parent = g.cable.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const worst = new Map();
    for (const [i, j] of pairs) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    for (const [i, , d] of pairs) { const r = find(i); worst.set(r, Math.max(worst.get(r) || 0, d)); }
    const clusters = new Map();
    g.cable.forEach((m, i) => { if (!worst.has(find(i))) return; const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(m); });
    const found = [];
    for (const [r, ms] of clusters) {
      const condIds = [...new Set(ms.map((m) => m.s.condition_id))];
      found.push({
        sheet_id: k, sheet: sheetLabel(k),
        shape_ids: ms.map((m) => m.s.id), finish_tags: ms.map((m) => tagOf(m.s.condition_id)), condition_ids: condIds,
        same_condition: condIds.length === 1,
        distance: feet ? round2(worst.get(r)) : round4(worst.get(r)),
        basis: feet ? "ft" : "sheet_fraction", threshold: thr,
      });
    }
    same_sheet.push(...found);
    const words = found.map((f) => (f.same_condition ? `${f.finish_tags[0]} ×${f.shape_ids.length}` : [...new Set(f.finish_tags)].join(" + ")));
    const shown = words.slice(0, 10).join("; ") + (words.length > 10 ? `; +${words.length - 10} more` : "");
    const within = feet ? `${SAME_SHEET_DUP_FT} ft` : `${pctText(SAME_SHEET_DUP_NORM)} of the sheet (no scale${size ? "" : " or page size"} known for it, so not in feet)`;
    warnings.push(`${sheetLabel(k)}: ${found.length} position${found.length === 1 ? " holds" : "s hold"} two or more device markers on cable conditions within ${within} of each other — ${shown}. One device marked twice (a symbol sweep plus a click) doubles its pull and cable LF. Check each and remove an extra marker only once a person confirms it; this check never removes one.`);
  }

  // ── 2. overlay plans: pairs of sheets of matching page size ──────────────
  const not_compared = [];
  const sheets = [...bySheet.keys()];
  for (const k of sheets) if (bySheet.get(k).cable.length && !sizeOf(k)) not_compared.push({ sheet_id: k, sheet: sheetLabel(k), reason: "page size not known on this surface — not compared with other sheets" });
  const cross_sheet = [];
  const reference = [];
  for (let ai = 0; ai < sheets.length; ai++) {
    for (let bi = ai + 1; bi < sheets.length; bi++) {
      const ka = sheets[ai], kb = sheets[bi];
      const A = bySheet.get(ka), B = bySheet.get(kb);
      if (!A.cable.length && !B.cable.length) continue;
      const za = sizeOf(ka), zb = sizeOf(kb);
      if (!za || !zb || !near(za.w, zb.w, PAGE_SIZE_TOL) || !near(za.h, zb.h, PAGE_SIZE_TOL)) continue;
      const ua = scaleOf(ka), ub = scaleOf(kb);
      if (ua && ub && !near(ua, ub, SCALE_TOL)) continue;
      const long = Math.max(za.w, za.h);
      const fx = za.w / long, fy = za.h / long;
      // candidates across the two sheets, cable ↔ cable first, then nearest
      const pts = [...A.all.map((m) => m.p), ...B.all.map((m) => m.p)];
      const nA = A.all.length;
      const cand = [];
      for (const [i, j, d] of pairsWithin(pts, fx, fy, OVERLAY_POS_TOL)) {
        if ((i < nA) === (j < nA)) continue;              // same sheet — case 1's business
        const a = A.all[i < nA ? i : j], b = B.all[(i < nA ? j : i) - nA];
        if (!a.cable && !b.cable) continue;               // neither is a cable device
        cand.push({ a, b, d, both: a.cable && b.cable });
      }
      cand.sort((x, y) => (y.both - x.both) || x.d - y.d);
      const usedA = new Set(), usedB = new Set();
      const groups = new Map();
      for (const c of cand) {
        if (usedA.has(c.a.s.id) || usedB.has(c.b.s.id)) continue;
        usedA.add(c.a.s.id); usedB.add(c.b.s.id);
        const key = `${c.a.s.condition_id}\u0000${c.b.s.condition_id}`;
        let gr = groups.get(key);
        if (!gr) { gr = { ca: c.a.s.condition_id, cb: c.b.s.condition_id, both: c.both, cableA: c.a.cable, cableB: c.b.cable, pairs: [], worst: 0 }; groups.set(key, gr); }
        gr.pairs.push({ ord: c.a.ord, ids: [c.a.s.id, c.b.s.id] });
        gr.worst = Math.max(gr.worst, c.d);
      }
      const nOn = (G, cid) => G.all.filter((m) => m.s.condition_id === cid).length;
      const passing = [];
      const refs = [];
      let below = 0;
      for (const gr of groups.values()) {
        const k = gr.pairs.length;
        const pattern = k >= OVERLAY_MIN_POSITIONS && k >= OVERLAY_MIN_SHARE * Math.min(nOn(A, gr.ca), nOn(B, gr.cb));
        const row = {
          condition_a: gr.ca, finish_tag_a: tagOf(gr.ca), condition_b: gr.cb, finish_tag_b: tagOf(gr.cb),
          count: k, pairs: gr.pairs.sort((x, y) => x.ord - y.ord).map((q) => q.ids), max_offset: round4(gr.worst),
        };
        if (!gr.both) { if (pattern) refs.push({ ...row, cable_side: gr.cableA ? "a" : "b" }); continue; }
        if (pattern) passing.push({ ...row, different_conditions: gr.ca !== gr.cb });
        else below += k;
      }
      // two files can carry one sheet number (a reissue, a copy): name them apart
      const la = sheetLabel(ka), lb = sheetLabel(kb);
      const names = la === lb
        ? { sheet_a_id: ka, sheet_a: `${la} (${ka})`, sheet_b_id: kb, sheet_b: `${lb} (${kb})` }
        : { sheet_a_id: ka, sheet_a: la, sheet_b_id: kb, sheet_b: lb };
      if (refs.length) reference.push({ ...names, groups: refs, note: "one side sits on a non-cable condition — not a cable duplicate (a reference set), listed for the record" });
      if (!passing.length) continue;
      passing.sort((x, y) => y.count - x.count || (x.finish_tag_a + x.finish_tag_b).localeCompare(y.finish_tag_a + y.finish_tag_b));
      const positions = passing.reduce((n, g) => n + g.count, 0);
      cross_sheet.push({ ...names, positions, groups: passing, ...(below ? { below_pattern: below } : {}) });
      const A1 = names.sheet_a, B1 = names.sheet_b;
      const list = passing.map((g) => `${g.finish_tag_a} on ${A1} ↔ ${g.finish_tag_b} on ${B1} (${g.count})`).join("; ");
      const diff = passing.filter((g) => g.different_conditions);
      warnings.push(`${A1} and ${B1} share ${positions} device position${positions === 1 ? "" : "s"}: ${list}. The same devices look drawn on both sheets (overlay plans), so their pulls, cable LF and price count twice.${diff.length ? ` ${diff.map((g) => `${g.finish_tag_a} ↔ ${g.finish_tag_b}`).join(", ")} ${diff.length === 1 ? "is a pair of" : "are pairs of"} different cable conditions: two setups figure the same devices.` : ""} If one sheet shows them for reference only, move that sheet's markers to a non-cable reference condition; if they are separate devices, leave them. Nothing was changed.`);
    }
  }
  return { same_sheet, cross_sheet, reference, not_compared, warnings, count: same_sheet.length + cross_sheet.length, thresholds: DUPLICATE_THRESHOLDS };
}

/** True when a findings object carries anything worth printing — what the
 *  report block and takeoff_summary gate on, so a cable takeoff with no
 *  duplicate finding exports exactly as before. */
export function hasDuplicateFindings(d) {
  return !!d && (d.count > 0 || (d.reference || []).length > 0);
}
