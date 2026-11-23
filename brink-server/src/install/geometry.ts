// Plan geometry for the install drawings: where a device's verts_norm point
// lands on a drawing sheet, and a greedy label placer.
//
// Coordinate law (as web/src/lib/markedset.js states it): a device's `at` is
// normalized to the sheet's VISUAL raster, i.e. the page as pdf.js shows it,
// /Rotate applied, origin top-left, y down. pdf.js maps PDF user space to that
// raster with its viewport transform; viewportTransform() reproduces it at
// scale 1 (same view box, same rotation cases). The source page is then placed
// on the drawing sheet as a form XObject whose /Matrix is that transform
// flipped upright (user space -> visual points, y up), so the plan reads the
// way it reads on screen whatever its /Rotate, and a device point maps with
// plain scale + offset: no inverse transform is needed for the markers.
import type { PDFPage } from "pdf-lib";

export type Matrix = [number, number, number, number, number, number];

export interface PlanGeometry {
  /** The page's view box in user space (crop box clipped to the media box), [x0, y0, x1, y1]. */
  view: [number, number, number, number];
  rotation: 0 | 90 | 180 | 270;
  /** The visual page size in points (width and height swap at 90 / 270). */
  width: number;
  height: number;
  /** User space -> visual raster at scale 1 (y down), as pdf.js PageViewport.transform. */
  transform: Matrix;
}

/** pdf.js PageViewport's transform at scale 1 for a view box and rotation. */
export function viewportTransform(view: [number, number, number, number], rotation: number): { transform: Matrix; width: number; height: number } {
  let rot = ((Math.round(rotation) % 360) + 360) % 360;
  if (rot % 90 !== 0) rot = 0;
  const [x0, y0, x1, y1] = view;
  const cx = (x1 + x0) / 2, cy = (y1 + y0) / 2;
  let A: number, B: number, C: number, D: number;
  switch (rot) {
    case 90: A = 0; B = 1; C = 1; D = 0; break;
    case 180: A = -1; B = 0; C = 0; D = 1; break;
    case 270: A = 0; B = -1; C = -1; D = 0; break;
    default: A = 1; B = 0; C = 0; D = -1;
  }
  let ox: number, oy: number, width: number, height: number;
  if (A === 0) {
    ox = Math.abs(cy - y0); oy = Math.abs(cx - x0);
    width = y1 - y0; height = x1 - x0;
  } else {
    ox = Math.abs(cx - x0); oy = Math.abs(cy - y0);
    width = x1 - x0; height = y1 - y0;
  }
  return { transform: [A, B, C, D, ox - A * cx - C * cy, oy - B * cx - D * cy], width, height };
}

export function planGeometry(page: PDFPage): PlanGeometry {
  const m = page.getMediaBox();
  const c = page.getCropBox();
  const x0 = Math.max(m.x, c.x), y0 = Math.max(m.y, c.y);
  const x1 = Math.min(m.x + m.width, c.x + c.width), y1 = Math.min(m.y + m.height, c.y + c.height);
  // a crop box outside the media box: fall back to the media box (pdf.js does too)
  const view: [number, number, number, number] = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [m.x, m.y, m.x + m.width, m.y + m.height];
  let rot = ((page.getRotation().angle % 360) + 360) % 360;
  if (rot % 90 !== 0) rot = 0;
  const vt = viewportTransform(view, rot);
  return { view, rotation: rot as PlanGeometry["rotation"], ...vt };
}

/** The form /Matrix that draws the page upright in visual points (y up, origin bottom-left of the visual page). */
export function uprightMatrix(g: PlanGeometry): Matrix {
  const [a, b, c, d, e, f] = g.transform;
  return [a, -b, c, -d, e, g.height - f];
}

/** Where the visual page sits on the sheet when fitted (centered) into a box. */
export interface Placement { x: number; y: number; scale: number; width: number; height: number }

export function fitPlacement(visualW: number, visualH: number, box: { x: number; y: number; w: number; h: number }): Placement {
  const scale = Math.min(box.w / visualW, box.h / visualH);
  const width = visualW * scale, height = visualH * scale;
  return { x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, scale, width, height };
}

/** A verts_norm point -> sheet points (y up). */
export function normToSheet(p: Placement, at: [number, number]): [number, number] {
  return [p.x + at[0] * p.width, p.y + (1 - at[1]) * p.height];
}

// ── label placement ─────────────────────────────────────────────────────────

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const rectAt = (cx: number, cy: number, w: number, h: number): Rect => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface LabelItem<T> { w: number; h: number; candidates: [number, number][]; data: T }
export interface PlacedLabel<T> { x: number; y: number; w: number; h: number; clear: boolean; candidate: number; data: T }

/**
 * Greedy placement, the same rule as web/src/lib/cableMarks.js placeLabels: each
 * label takes its first candidate centre that overlaps nothing already placed
 * (obstacles included) and stays inside the bounds, else the least-overlapping
 * one. Placed labels become obstacles for the next.
 */
export function placeLabels<T>(items: LabelItem<T>[], o: { placed?: Rect[]; bounds?: Rect } = {}): PlacedLabel<T>[] {
  const placed = o.placed ?? [];
  const B = o.bounds;
  const out: PlacedLabel<T>[] = [];
  for (const it of items) {
    let best: { x: number; y: number; r: Rect; i: number } | null = null;
    let bestCost = Infinity;
    it.candidates.forEach(([x, y], i) => {
      if (bestCost === 0) return;
      const r = rectAt(x, y, it.w, it.h);
      let cost = B && (r.x0 < B.x0 || r.y0 < B.y0 || r.x1 > B.x1 || r.y1 > B.y1) ? it.w * it.h * 4 : 0;
      for (const p of placed) cost += overlapArea(r, p);
      // a small tie-break toward nearer candidates
      cost += i * 1e-6;
      if (cost < bestCost) { bestCost = cost; best = { x, y, r, i }; }
    });
    if (!best) continue;
    const b = best as { x: number; y: number; r: Rect; i: number };
    placed.push(b.r);
    out.push({ x: b.x, y: b.y, w: it.w, h: it.h, clear: bestCost < 1e-3, candidate: b.i, data: it.data });
  }
  return out;
}

/** Candidate label centres around a marker: a near ring of 8, then a far ring of 12 (drawn with a leader). */
export function ringCandidates(x: number, y: number, w: number, h: number, gap: number): { near: [number, number][]; far: [number, number][] } {
  const dx = gap + w / 2, dy = gap + h / 2;
  const near: [number, number][] = [
    [x + dx, y], [x - dx, y], [x, y + dy], [x, y - dy],
    [x + dx, y + dy], [x + dx, y - dy], [x - dx, y + dy], [x - dx, y - dy],
  ];
  const far: [number, number][] = [];
  for (const k of [2.2, 3.6]) {
    const gx = gap * k + w / 2, gy = gap * k + h / 2 + h * (k - 1) * 0.5;
    far.push([x + gx, y], [x - gx, y], [x, y + gy], [x, y - gy], [x + gx, y + gy], [x - gx, y - gy]);
  }
  return { near, far };
}
