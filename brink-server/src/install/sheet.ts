// Drawing-sheet primitives for the install package (tabloid, landscape): the
// sheet frame and title block, absolute-position tables, device symbols and
// a few text helpers, all over the bid documents' PdfFlow (fonts, WinAnsi
// cleaning, word wrap) and palette.
import { degrees, rgb } from "pdf-lib";
import type { PDFFont, PDFImage, RGB } from "pdf-lib";
import { C } from "../bid/pdfKit.ts";
import type { Align, Cell, CellSpec, PdfFlow } from "../bid/pdfKit.ts";

export const PAGE_W = 1224;
export const PAGE_H = 792;
/** Outer border inset. */
export const M = 18;
/** Title block strip width (right edge). */
export const TB_W = 184;
/** The drawing area: inside the border, left of the title block. */
export const DA = { x: M + 10, y: M + 10, w: PAGE_W - M - TB_W - (M + 10) - 10, h: PAGE_H - 2 * M - 20 };

export const INK = {
  ...C,
  green: rgb(0.08, 0.45, 0.2),
  greenFill: rgb(0.9, 0.96, 0.91),
  faint: rgb(0.86, 0.88, 0.91),
  lighter: rgb(0.95, 0.955, 0.965),
  equipFill: rgb(0.86, 0.91, 0.97),
  panelFill: rgb(0.93, 0.95, 0.9),
  amber: rgb(0.72, 0.42, 0.02),
};

/** Text fitted to a width: truncated with an ellipsis when it would overrun. */
export function fitText(f: PdfFlow, text: string, font: PDFFont, size: number, maxW: number): string {
  let t = f.clean(text);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export interface TextOpts { font?: PDFFont; size?: number; color?: RGB; align?: Align; width?: number; rotate?: number; opacity?: number }

/** One line on the current page; fitted to `width` when given. */
export function text(f: PdfFlow, s: string, x: number, y: number, o: TextOpts = {}): number {
  const font = o.font ?? f.regular;
  const size = o.size ?? 8;
  const t = o.width !== undefined ? fitText(f, s, font, size, o.width) : f.clean(s);
  const w = font.widthOfTextAtSize(t, size);
  let dx = x;
  if (o.align === "right" && o.width !== undefined) dx = x + o.width - w;
  else if (o.align === "center" && o.width !== undefined) dx = x + (o.width - w) / 2;
  f.page.drawText(t, { x: dx, y, font, size, color: o.color ?? INK.text, ...(o.rotate ? { rotate: degrees(o.rotate) } : {}), ...(o.opacity !== undefined ? { opacity: o.opacity } : {}) });
  return w;
}

/** Wrapped lines from the top down; returns the y below the last line. */
export function para(f: PdfFlow, s: string, x: number, yTop: number, width: number, o: TextOpts & { leading?: number; maxLines?: number } = {}): number {
  const font = o.font ?? f.regular;
  const size = o.size ?? 8;
  const lh = size * (o.leading ?? 1.25);
  let lines = f.wrap(s, font, size, width);
  if (o.maxLines && lines.length > o.maxLines) {
    lines = lines.slice(0, o.maxLines);
    lines[lines.length - 1] = fitText(f, `${lines[lines.length - 1]}…`, font, size, width);
  }
  let y = yTop;
  for (const line of lines) {
    y -= lh;
    text(f, line, x, y + size * 0.22, { ...o, font, size, width: o.align ? width : undefined });
  }
  return y;
}

export function rule(f: PdfFlow, x0: number, y: number, x1: number, o: { color?: RGB; thickness?: number; dash?: number[] } = {}): void {
  f.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: o.thickness ?? 0.6, color: o.color ?? INK.rule, ...(o.dash ? { dashArray: o.dash } : {}) });
}

export function box(f: PdfFlow, x: number, y: number, w: number, h: number, o: { fill?: RGB; stroke?: RGB; width?: number; opacity?: number; dash?: number[] } = {}): void {
  f.page.drawRectangle({
    x, y, width: w, height: h,
    ...(o.fill ? { color: o.fill } : {}),
    ...(o.stroke ? { borderColor: o.stroke, borderWidth: o.width ?? 0.6 } : { borderWidth: 0 }),
    ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
    ...(o.dash ? { borderDashArray: o.dash } : {}),
  });
}

// ── tables ─────────────────────────────────────────────────────────────────

export interface TCol { header: string; w: number; align?: Align }
export interface TRow { cells: Cell[]; fill?: RGB; bold?: boolean; color?: RGB }

const spec = (c: Cell): CellSpec => (typeof c === "string" ? { text: c } : c);

export interface TableStyle { size?: number; pad?: number; zebra?: boolean; headerFill?: RGB; headerSize?: number }

function cellLines(f: PdfFlow, cols: TCol[], row: TRow, size: number, pad: number): string[][] {
  return cols.map((col, i) => {
    const c = spec(row.cells[i] ?? "");
    const font = c.bold || row.bold ? f.bold : f.regular;
    return f.wrap(c.text, font, size, col.w - 2 * pad);
  });
}

export function rowHeight(f: PdfFlow, cols: TCol[], row: TRow, st: TableStyle = {}): number {
  const size = st.size ?? 8, pad = st.pad ?? 2.5;
  const n = Math.max(1, ...cellLines(f, cols, row, size, pad).map((l) => l.length));
  return n * size * 1.22 + 2 * pad;
}

export function headerHeight(f: PdfFlow, cols: TCol[], st: TableStyle = {}): number {
  const size = st.headerSize ?? st.size ?? 8, pad = st.pad ?? 2.5;
  const n = Math.max(1, ...cols.map((c) => f.wrap(c.header, f.bold, size, c.w - 2 * pad).length));
  return n * size * 1.22 + 2 * pad;
}

export function drawHeader(f: PdfFlow, x: number, yTop: number, cols: TCol[], st: TableStyle = {}): number {
  const size = st.headerSize ?? st.size ?? 8, pad = st.pad ?? 2.5;
  const h = headerHeight(f, cols, st);
  const w = cols.reduce((a, c) => a + c.w, 0);
  box(f, x, yTop - h, w, h, { fill: st.headerFill ?? INK.navy });
  let cx = x;
  for (const c of cols) {
    f.wrap(c.header, f.bold, size, c.w - 2 * pad).forEach((line, j) => {
      text(f, line, cx + pad, yTop - pad - (j + 1) * size * 1.22 + size * 0.28, { font: f.bold, size, color: INK.white, align: c.align, width: c.w - 2 * pad });
    });
    cx += c.w;
  }
  return yTop - h;
}

export function drawRow(f: PdfFlow, x: number, yTop: number, cols: TCol[], row: TRow, index: number, st: TableStyle = {}): number {
  const size = st.size ?? 8, pad = st.pad ?? 2.5;
  const lines = cellLines(f, cols, row, size, pad);
  const h = Math.max(1, ...lines.map((l) => l.length)) * size * 1.22 + 2 * pad;
  const w = cols.reduce((a, c) => a + c.w, 0);
  const fill = row.fill ?? (st.zebra !== false && index % 2 === 1 ? INK.zebra : undefined);
  if (fill) box(f, x, yTop - h, w, h, { fill });
  let cx = x;
  cols.forEach((col, i) => {
    const c = spec(row.cells[i] ?? "");
    const font = c.bold || row.bold ? f.bold : f.regular;
    lines[i].forEach((line, j) => {
      text(f, line, cx + pad, yTop - pad - (j + 1) * size * 1.22 + size * 0.28, { font, size, color: c.color ?? row.color ?? INK.text, align: c.align ?? col.align, width: col.w - 2 * pad });
    });
    cx += col.w;
  });
  rule(f, x, yTop - h, x + w, { thickness: 0.35 });
  return yTop - h;
}

/** A whole table at a position (no pagination); returns the y below it. */
export function drawTable(f: PdfFlow, x: number, yTop: number, cols: TCol[], rows: TRow[], st: TableStyle = {}): number {
  let y = drawHeader(f, x, yTop, cols, st);
  rows.forEach((r, i) => { y = drawRow(f, x, y, cols, r, i, st); });
  return y;
}

export function tableHeight(f: PdfFlow, cols: TCol[], rows: TRow[], st: TableStyle = {}): number {
  return headerHeight(f, cols, st) + rows.reduce((a, r) => a + rowHeight(f, cols, r, st), 0);
}

/** Widths scaled to fill a total. */
export function fill(cols: TCol[], total: number): TCol[] {
  const sum = cols.reduce((a, c) => a + c.w, 0);
  return cols.map((c) => ({ ...c, w: (c.w / sum) * total }));
}

/** A small section caption (navy, with a rule). Returns the y below it. */
export function caption(f: PdfFlow, s: string, x: number, yTop: number, w: number, size = 9): number {
  text(f, s, x, yTop - size, { font: f.bold, size, color: INK.navy, width: w });
  rule(f, x, yTop - size - 3.5, x + w, { color: INK.blue, thickness: 0.7 });
  return yTop - size - 8;
}

// ── symbols ────────────────────────────────────────────────────────────────

export type SymbolShape = "circle" | "square" | "triangle" | "diamond" | "hexagon" | "pentagon" | "star" | "invtriangle";
export const SYMBOL_SHAPES: SymbolShape[] = ["circle", "square", "triangle", "diamond", "hexagon", "invtriangle", "pentagon", "star"];
export const SYMBOL_COLORS: RGB[] = [
  rgb(0.13, 0.36, 0.75), rgb(0.82, 0.36, 0.04), rgb(0.1, 0.52, 0.27), rgb(0.62, 0.16, 0.6),
  rgb(0.0, 0.5, 0.55), rgb(0.7, 0.12, 0.15), rgb(0.42, 0.33, 0.12), rgb(0.33, 0.33, 0.38),
];

function polyPath(n: number, r: number, rot: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push(`${i ? "L" : "M"}${(r * Math.cos(a)).toFixed(2)},${(-r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ") + " Z";
}

/** A device symbol centred on (x, y), r = half size. */
export function symbol(f: PdfFlow, shape: SymbolShape, x: number, y: number, r: number, color: RGB, o: { outline?: RGB; outlineWidth?: number } = {}): void {
  const border = { borderColor: o.outline ?? INK.white, borderWidth: o.outlineWidth ?? 0.8 };
  const p = f.page;
  switch (shape) {
    case "circle": p.drawCircle({ x, y, size: r, color, ...border }); return;
    case "square": p.drawRectangle({ x: x - r * 0.88, y: y - r * 0.88, width: r * 1.76, height: r * 1.76, color, ...border }); return;
    case "triangle": p.drawSvgPath(polyPath(3, r * 1.15, Math.PI / 2), { x, y: y - r * 0.15, color, ...border }); return;
    case "invtriangle": p.drawSvgPath(polyPath(3, r * 1.15, -Math.PI / 2), { x, y: y + r * 0.15, color, ...border }); return;
    case "diamond": p.drawSvgPath(polyPath(4, r * 1.15, Math.PI / 2), { x, y, color, ...border }); return;
    case "hexagon": p.drawSvgPath(polyPath(6, r * 1.05, 0), { x, y, color, ...border }); return;
    case "pentagon": p.drawSvgPath(polyPath(5, r * 1.08, Math.PI / 2), { x, y, color, ...border }); return;
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.5 : r * 1.2;
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${i ? "L" : "M"}${(rr * Math.cos(a)).toFixed(2)},${(-rr * Math.sin(a)).toFixed(2)}`);
      }
      p.drawSvgPath(pts.join(" ") + " Z", { x, y, color, ...border });
    }
  }
}

// ── frame and title block ──────────────────────────────────────────────────

export interface TitleInfo {
  company: { brand: string; legalName: string; address: string[]; phone: string; email: string; web: string };
  logo: PDFImage | null;
  project: string;
  client?: string;
  site?: string[];
  approved: boolean;
  revision: number;
  /** YYYY-MM-DD: the issue date (approval date once approved). */
  date: string;
  /** Revision rows, newest first. */
  revisions: { rev: string; date: string; text: string }[];
  designNote: string;
}

export interface SheetId { number: string; title: string; index: number; total: number; scale?: string; notes?: string[] }

/** The border, the title block and (while a draft) a faint stamp over the drawing area. */
export function frame(f: PdfFlow, t: TitleInfo, s: SheetId): void {
  const p = f.page;
  p.drawRectangle({ x: M, y: M, width: PAGE_W - 2 * M, height: PAGE_H - 2 * M, borderColor: INK.text, borderWidth: 1.4 });
  const tx = PAGE_W - M - TB_W;
  p.drawLine({ start: { x: tx, y: M }, end: { x: tx, y: PAGE_H - M }, thickness: 1.1, color: INK.text });
  const x = tx + 8, w = TB_W - 16;
  let y = PAGE_H - M - 8;

  // company
  if (t.logo) {
    const sc = Math.min(w / t.logo.width, 44 / t.logo.height);
    const lw = t.logo.width * sc, lh = t.logo.height * sc;
    p.drawImage(t.logo, { x, y: y - lh, width: lw, height: lh });
    y -= lh + 4;
  }
  y = para(f, t.company.brand || t.company.legalName, x, y, w, { font: f.bold, size: 11, color: INK.navy, maxLines: 2 });
  if (t.company.legalName && t.company.legalName !== t.company.brand) y = para(f, t.company.legalName, x, y, w, { size: 6.5, color: INK.muted, maxLines: 2 });
  for (const a of t.company.address) y = para(f, a, x, y, w, { size: 7, maxLines: 1 });
  const contact = [t.company.phone, t.company.email, t.company.web].filter(Boolean);
  for (const c of contact) y = para(f, c, x, y, w, { size: 7, maxLines: 1 });
  y -= 5;
  rule(f, tx, y, PAGE_W - M, { color: INK.text, thickness: 0.8 });

  // project
  const label = (s: string) => { text(f, s, x, y - 9, { size: 6, color: INK.muted, font: f.bold }); y -= 9; };
  label("PROJECT");
  y = para(f, t.project, x, y, w, { font: f.bold, size: 9.5, maxLines: 3 });
  label("CLIENT");
  y = para(f, t.client?.trim() || "Not stated", x, y, w, { size: 8, maxLines: 2, color: t.client ? INK.text : INK.muted });
  if (t.site?.length) {
    label("SITE");
    for (const a of t.site.slice(0, 3)) y = para(f, a, x, y, w, { size: 7.5, maxLines: 1 });
  }
  y -= 6;
  rule(f, tx, y, PAGE_W - M, { color: INK.text, thickness: 0.8 });

  // status box
  y -= 6;
  const sh = 46;
  if (t.approved) {
    box(f, x, y - sh, w, sh, { fill: INK.green });
    text(f, "ISSUED FOR", x, y - 15, { font: f.bold, size: 11, color: INK.white, align: "center", width: w });
    text(f, "CONSTRUCTION", x, y - 28, { font: f.bold, size: 11, color: INK.white, align: "center", width: w });
    text(f, `Revision ${t.revision} · ${t.date}`, x, y - 40, { size: 7.5, color: INK.white, align: "center", width: w });
  } else {
    box(f, x, y - sh, w, sh, { fill: INK.redFill, stroke: INK.red, width: 1.2 });
    text(f, "DRAFT", x, y - 18, { font: f.bold, size: 16, color: INK.red, align: "center", width: w });
    text(f, "NOT FOR CONSTRUCTION", x, y - 30, { font: f.bold, size: 8.5, color: INK.red, align: "center", width: w });
    text(f, `Revision ${t.revision} · ${t.date} · for review`, x, y - 41, { size: 7, color: INK.red, align: "center", width: w });
  }
  y -= sh + 8;

  // revisions
  label("REVISIONS");
  y -= 1;
  const rc = [{ header: "REV", w: 24 }, { header: "DATE", w: 52 }, { header: "DESCRIPTION", w: w - 76 }];
  y = drawTable(f, x, y, rc, t.revisions.slice(0, 4).map((r) => ({ cells: [r.rev, r.date, r.text] })), { size: 6.5, pad: 2, headerSize: 6 });
  if (t.designNote) y = para(f, t.designNote, x, y - 2, w, { size: 6.5, color: INK.muted, maxLines: 3 });

  // sheet notes, in the space left above the bottom block
  const bottomTop = M + 152;
  if (s.notes?.length) {
    y -= 4;
    label("NOTES");
    s.notes.forEach((n, i) => {
      if (y < bottomTop + 20) return;
      const lines = f.wrap(n, f.regular, 6.5, w - 10);
      for (const [j, line] of lines.entries()) {
        if (y - 8 < bottomTop + 4) break;
        y -= 8;
        if (j === 0) text(f, `${i + 1}.`, x, y, { size: 6.5, font: f.bold, color: INK.navy });
        text(f, line, x + 10, y, { size: 6.5 });
      }
      y -= 2;
    });
  }

  // bottom block: sheet title, date / revision / scale, sheet number
  rule(f, tx, bottomTop, PAGE_W - M, { color: INK.text, thickness: 0.8 });
  let by = bottomTop;
  text(f, "SHEET TITLE", x, by - 10, { size: 6, color: INK.muted, font: f.bold });
  by -= 10;
  by = para(f, s.title, x, by, w, { font: f.bold, size: 10, maxLines: 3, color: INK.navy });
  const gridTop = M + 84;
  rule(f, tx, gridTop, PAGE_W - M, { thickness: 0.6, color: INK.text });
  const half = (TB_W) / 2;
  p.drawLine({ start: { x: tx + half, y: gridTop }, end: { x: tx + half, y: M + 52 }, thickness: 0.6, color: INK.text });
  rule(f, tx, M + 68, PAGE_W - M, { thickness: 0.4 });
  const cell = (lab: string, val: string, cx: number, cy: number) => {
    text(f, lab, cx + 6, cy - 7, { size: 5.8, color: INK.muted, font: f.bold });
    text(f, val, cx + 6, cy - 14.5, { size: 7.5, width: half - 10 });
  };
  cell("DATE", t.date, tx, gridTop);
  cell("REVISION", String(t.revision), tx + half, gridTop);
  cell("SCALE", s.scale ?? "Not to scale", tx, M + 68);
  cell("SHEET", `${s.index} of ${s.total}`, tx + half, M + 68);
  rule(f, tx, M + 52, PAGE_W - M, { thickness: 0.6, color: INK.text });
  text(f, "SHEET NUMBER", x, M + 42, { size: 6, color: INK.muted, font: f.bold });
  text(f, s.number, x, M + 12, { font: f.bold, size: 26, color: INK.navy, align: "center", width: w });

}

/** The sheet heading at the top of the drawing area; returns the y below it. */
export function sheetHeading(f: PdfFlow, title: string, sub?: string, draft = false): number {
  const y = DA.y + DA.h;
  text(f, title, DA.x, y - 13, { font: f.bold, size: 13, color: INK.navy, width: DA.w * (draft ? 0.72 : 1) });
  if (draft) text(f, "DRAFT — NOT FOR CONSTRUCTION", DA.x + DA.w * 0.72, y - 12, { font: f.bold, size: 10, color: INK.red, width: DA.w * 0.28, align: "right" });
  if (sub) text(f, sub, DA.x, y - 23, { size: 7.5, color: INK.muted, width: DA.w });
  rule(f, DA.x, y - (sub ? 28 : 19), DA.x + DA.w, { color: INK.navy, thickness: 1 });
  return y - (sub ? 34 : 25);
}
