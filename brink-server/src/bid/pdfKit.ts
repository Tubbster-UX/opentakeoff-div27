// A small flowing-layout layer over pdf-lib for the bid documents: Helvetica,
// real word wrapping, tables that paginate (header repeated, tall rows split),
// a footer with "Page n of N" on every page and, while a bid is a draft, a
// diagonal DRAFT stamp. Text is reduced to what the standard fonts can encode
// (WinAnsi) so a stray arrow or emoji never fails a render.
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, degrees, rgb } from "pdf-lib";
import type { RGB } from "pdf-lib";
import type { CompanyProfile } from "../bidTypes.ts";

export const C = {
  navy: rgb(0.106, 0.188, 0.333),
  blue: rgb(0.161, 0.329, 0.596),
  light: rgb(0.91, 0.933, 0.965),
  zebra: rgb(0.965, 0.973, 0.985),
  shade: rgb(0.93, 0.94, 0.955),
  rule: rgb(0.74, 0.78, 0.84),
  text: rgb(0.1, 0.11, 0.13),
  muted: rgb(0.38, 0.41, 0.45),
  red: rgb(0.74, 0.08, 0.1),
  redFill: rgb(0.99, 0.92, 0.92),
  white: rgb(1, 1, 1),
};

export type Align = "left" | "right" | "center";
export interface CellSpec { text: string; bold?: boolean; color?: RGB; align?: Align }
export type Cell = string | CellSpec;
export interface Column { header: string; width: number; align?: Align }

export interface TableOpts {
  size?: number;
  pad?: number;
  /** Every row filled with this (a shaded box); otherwise zebra rows. */
  fill?: RGB;
  zebra?: boolean;
  header?: boolean;
  borders?: boolean;
  /** First column bold (label columns). */
  boldFirst?: boolean;
  /** Fill for label columns (indexes) in grid tables. */
  labelCols?: number[];
}

const SUBST: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
  "−": "-", "‐": "-", "‑": "-", "‒": "-", "―": "-", "′": "'", "″": "\"", " ": " ",
  " ": " ", " ": " ", " ": " ", "​": "", "﻿": "", "✓": "Yes", "✔": "Yes", "✗": "No", "✘": "No",
  "●": "•", "▪": "•", "◦": "•", "⁃": "-", "­": "",
};

export interface FlowMeta {
  title: string;
  author: string;
  subject?: string;
  keywords?: string[];
  /** Page size in points; Letter portrait (612 x 792) when absent. The install package uses tabloid landscape (1224 x 792). */
  pageSize?: [number, number];
}

export class PdfFlow {
  readonly W: number;
  readonly H: number;
  readonly M = { top: 54, bottom: 62, left: 54, right: 54 };
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  private readonly chars: Set<number>;

  private constructor(readonly doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont, readonly italic: PDFFont, size: [number, number] = [612, 792]) {
    [this.W, this.H] = size;
    this.chars = new Set(regular.getCharacterSet());
  }

  static async create(meta: FlowMeta): Promise<PdfFlow> {
    const doc = await PDFDocument.create();
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setCreator(meta.author);
    doc.setProducer(meta.author);
    if (meta.subject) doc.setSubject(meta.subject);
    if (meta.keywords) doc.setKeywords(meta.keywords);
    const [regular, bold, italic] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold), doc.embedFont(StandardFonts.HelveticaOblique),
    ]);
    const f = new PdfFlow(doc, regular, bold, italic, meta.pageSize);
    f.newPage();
    return f;
  }

  get left() { return this.M.left; }
  get right() { return this.W - this.M.right; }
  get width() { return this.W - this.M.left - this.M.right; }
  get bottom() { return this.M.bottom; }

  newPage(): void {
    this.page = this.doc.addPage([this.W, this.H]);
    this.pages.push(this.page);
    this.y = this.H - this.M.top;
  }

  /** Start a new page unless this one is still empty. */
  pageBreak(): void {
    if (this.y < this.H - this.M.top - 0.5) this.newPage();
  }

  space(h: number): void { this.y -= h; }

  /** Make room for h points, breaking the page when needed. */
  ensure(h: number): void {
    if (this.y - h < this.M.bottom) this.newPage();
  }

  /** Text the standard fonts can draw. */
  clean(s: string): string {
    let out = "";
    for (const ch of (s ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, "    ")) {
      const cp = ch.codePointAt(0)!;
      if (ch === "\n" || this.chars.has(cp)) out += ch;
      else if (SUBST[ch] !== undefined) out += SUBST[ch];
      else out += "?";
    }
    return out;
  }

  textWidth(s: string, font: PDFFont, size: number): number {
    return font.widthOfTextAtSize(s, size);
  }

  /** Word-wrapped lines (explicit newlines kept; over-long words broken). */
  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const para of this.clean(text).split("\n")) {
      const words = para.split(/ +/).filter(Boolean);
      if (!words.length) { out.push(""); continue; }
      let line = "";
      for (let word of words) {
        while (font.widthOfTextAtSize(word, size) > maxWidth) {
          // break a word longer than the line
          let cut = word.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut--;
          if (line) { out.push(line); line = ""; }
          out.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const trial = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(trial, size) <= maxWidth) line = trial;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out;
  }

  /** One line at an absolute position (already clean or not: cleaned here). */
  draw(text: string, x: number, y: number, o: { font?: PDFFont; size?: number; color?: RGB; align?: Align; width?: number } = {}): void {
    const font = o.font ?? this.regular;
    const size = o.size ?? 10;
    const t = this.clean(text);
    let dx = x;
    if (o.align && o.align !== "left" && o.width !== undefined) {
      const w = font.widthOfTextAtSize(t, size);
      dx = o.align === "right" ? x + o.width - w : x + (o.width - w) / 2;
    }
    this.page.drawText(t, { x: dx, y, font, size, color: o.color ?? C.text });
  }

  /** A wrapped paragraph flowing across pages. */
  paragraph(text: string, o: { size?: number; font?: PDFFont; color?: RGB; indent?: number; after?: number; width?: number; align?: Align; leading?: number } = {}): void {
    const size = o.size ?? 10;
    const font = o.font ?? this.regular;
    const lh = size * (o.leading ?? 1.35);
    const x = this.left + (o.indent ?? 0);
    const w = o.width ?? this.width - (o.indent ?? 0);
    for (const line of this.wrap(text, font, size, w)) {
      this.ensure(lh);
      this.y -= lh;
      this.draw(line, x, this.y + size * 0.25, { font, size, color: o.color, align: o.align, width: w });
    }
    this.y -= o.after ?? 6;
  }

  /** A section heading in navy with a rule under it, kept with what follows. */
  heading(text: string, o: { size?: number; keep?: number; color?: RGB; rule?: boolean } = {}): void {
    const size = o.size ?? 12;
    this.ensure(size * 1.6 + (o.keep ?? 48));
    this.y -= size * 1.5;
    this.draw(text, this.left, this.y + size * 0.2, { font: this.bold, size, color: o.color ?? C.navy });
    if (o.rule !== false) {
      this.page.drawLine({ start: { x: this.left, y: this.y - 3 }, end: { x: this.right, y: this.y - 3 }, thickness: 0.8, color: C.blue });
      this.y -= 8;
    } else {
      this.y -= 4;
    }
  }

  /** A bulleted (or numbered) list with hanging indents. */
  bullets(items: string[], o: { size?: number; numbered?: boolean; indent?: number; after?: number; color?: RGB } = {}): void {
    const size = o.size ?? 10;
    const lh = size * 1.35;
    const indent = o.indent ?? 0;
    const hang = o.numbered ? 20 : 12;
    items.forEach((item, i) => {
      const lines = this.wrap(item, this.regular, size, this.width - indent - hang);
      lines.forEach((line, j) => {
        this.ensure(lh);
        this.y -= lh;
        if (j === 0) this.draw(o.numbered ? `${i + 1}.` : "•", this.left + indent, this.y + size * 0.25, { size, color: C.blue, font: o.numbered ? this.bold : this.regular });
        this.draw(line, this.left + indent + hang, this.y + size * 0.25, { size, color: o.color });
      });
      this.y -= 2;
    });
    this.y -= o.after ?? 6;
  }

  /** A table that wraps cell text, repeats its header on each page and splits rows taller than a page. */
  table(columns: Column[], rows: Cell[][], o: TableOpts = {}): void {
    const size = o.size ?? 9;
    const pad = o.pad ?? 4;
    const lh = size * 1.3;
    const total = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const xs: number[] = [];
    widths.reduce((x, w) => { xs.push(x); return x + w; }, this.left);
    const showHeader = o.header !== false;
    const spec = (c: Cell): CellSpec => (typeof c === "string" ? { text: c } : c);

    const headerLines = columns.map((c, i) => this.wrap(c.header, this.bold, size, widths[i] - 2 * pad));
    const headerH = showHeader ? Math.max(...headerLines.map((l) => l.length)) * lh + 2 * pad : 0;
    const drawHeader = () => {
      if (!showHeader) return;
      this.page.drawRectangle({ x: this.left, y: this.y - headerH, width: this.width, height: headerH, color: C.navy });
      headerLines.forEach((lines, i) => lines.forEach((line, j) => {
        this.draw(line, xs[i] + pad, this.y - pad - (j + 1) * lh + size * 0.3, { font: this.bold, size, color: C.white, align: columns[i].align, width: widths[i] - 2 * pad });
      }));
      this.y -= headerH;
    };

    const fullPage = this.H - this.M.top - this.M.bottom - headerH;
    this.ensure(headerH + lh * 2 + 2 * pad);
    drawHeader();
    rows.forEach((row, ri) => {
      const cells = columns.map((_, i) => spec(row[i] ?? ""));
      const lines = cells.map((c, i) => this.wrap(c.text, c.bold || (o.boldFirst && i === 0) || o.labelCols?.includes(i) ? this.bold : this.regular, size, widths[i] - 2 * pad));
      const n = Math.max(1, ...lines.map((l) => l.length));
      let start = 0;
      while (start < n) {
        const remaining = n - start;
        const fit = Math.floor((this.y - this.M.bottom - 2 * pad) / lh);
        const wholeFitsFresh = remaining * lh + 2 * pad <= fullPage;
        if (fit < Math.min(remaining, 2) || (start === 0 && remaining > fit && wholeFitsFresh)) {
          this.newPage();
          drawHeader();
          continue;
        }
        const take = Math.min(fit, remaining);
        const h = take * lh + 2 * pad;
        const fill = o.fill ?? (o.zebra !== false && ri % 2 === 1 ? C.zebra : undefined);
        if (fill) this.page.drawRectangle({ x: this.left, y: this.y - h, width: this.width, height: h, color: fill });
        for (const li of o.labelCols ?? []) {
          this.page.drawRectangle({ x: xs[li], y: this.y - h, width: widths[li], height: h, color: C.light });
        }
        cells.forEach((c, i) => {
          const font = c.bold || (o.boldFirst && i === 0) || o.labelCols?.includes(i) ? this.bold : this.regular;
          const color = c.color ?? (o.labelCols?.includes(i) ? C.navy : C.text);
          lines[i].slice(start, start + take).forEach((line, j) => {
            this.draw(line, xs[i] + pad, this.y - pad - (j + 1) * lh + size * 0.3, { font, size, color, align: c.align ?? columns[i].align, width: widths[i] - 2 * pad });
          });
        });
        if (o.borders !== false) {
          this.page.drawLine({ start: { x: this.left, y: this.y - h }, end: { x: this.right, y: this.y - h }, thickness: 0.4, color: C.rule });
        }
        this.y -= h;
        start += take;
      }
    });
    this.y -= 8;
  }

  async embedImage(bytes: Uint8Array): Promise<PDFImage | null> {
    try {
      if (bytes[0] === 0x89 && bytes[1] === 0x50) return await this.doc.embedPng(bytes);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return await this.doc.embedJpg(bytes);
    } catch {
      return null;
    }
    return null;
  }

  /** Footer on every page, the DRAFT stamp and header while a draft; returns the bytes. */
  async finish(o: { footerLeft: string; draft?: string; headerNote?: string }): Promise<Uint8Array> {
    const N = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      const fy = this.M.bottom - 26;
      p.drawLine({ start: { x: this.left, y: fy + 12 }, end: { x: this.right, y: fy + 12 }, thickness: 0.5, color: C.rule });
      const right = `Page ${i + 1} of ${N}`;
      const rw = this.regular.widthOfTextAtSize(right, 8);
      const leftMax = this.width - rw - 12;
      let left = this.clean(o.footerLeft);
      while (left.length > 4 && this.regular.widthOfTextAtSize(left, 8) > leftMax) left = `${left.slice(0, -2).trimEnd()}…`;
      this.draw(left, this.left, fy, { size: 8, color: C.muted });
      this.draw(right, this.right - rw, fy, { size: 8, color: C.muted });
      if (o.draft) this.draw(o.draft, this.left, fy - 11, { size: 8, font: this.bold, color: C.red, align: "center", width: this.width });
      if (o.headerNote) this.draw(o.headerNote, this.left, this.H - 30, { size: 9, font: this.bold, color: C.red, align: "center", width: this.width });
      if (o.draft) {
        // the big diagonal stamp, centred on the page, drawn last so it sits on top
        const text = "DRAFT";
        const size = 150;
        const w = this.bold.widthOfTextAtSize(text, size);
        const h = this.bold.heightAtSize(size, { descender: false });
        const a = Math.PI / 4;
        const cx = this.W / 2, cy = this.H / 2;
        const x = cx - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a);
        const y = cy - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a);
        p.drawText(text, { x, y, size, font: this.bold, color: C.red, opacity: 0.13, rotate: degrees(45) });
      }
    });
    return this.doc.save();
  }
}

export function companyContact(c: CompanyProfile): string {
  return [c.brand, c.phone, c.email, c.web].filter(Boolean).join(" · ");
}

/** Letterhead: logo on the left, the company block right-aligned; UEI / CAGE when asked. */
export async function letterhead(f: PdfFlow, c: CompanyProfile, logo: Uint8Array | undefined, o: { ids?: boolean } = {}): Promise<void> {
  const top = f.y;
  let logoH = 0;
  if (logo) {
    const img = await f.embedImage(logo);
    if (img) {
      const s = Math.min(150 / img.width, 58 / img.height);
      const w = img.width * s, h = img.height * s;
      f.page.drawImage(img, { x: f.left, y: top - h, width: w, height: h });
      logoH = h;
    }
  }
  const lines: { text: string; bold?: boolean; size: number; color?: RGB }[] = [{ text: c.brand || c.legalName, bold: true, size: 13, color: C.navy }];
  if (c.legalName && c.legalName !== c.brand) lines.push({ text: c.legalName, size: 8, color: C.muted });
  for (const a of c.address) lines.push({ text: a, size: 8.5 });
  lines.push({ text: [c.phone, c.email].filter(Boolean).join(" · "), size: 8.5 });
  if (c.web) lines.push({ text: c.web, size: 8.5 });
  if (o.ids) {
    const ids = [c.uei ? `UEI ${c.uei}` : "", c.cage ? `CAGE ${c.cage}` : ""].filter(Boolean).join(" · ");
    if (ids) lines.push({ text: ids, bold: true, size: 8.5, color: C.navy });
  }
  for (const x of c.extraIds ?? []) lines.push({ text: x, size: 8, color: C.muted });
  let y = top;
  const alignLeft = !logoH;
  for (const l of lines) {
    y -= l.size * 1.3;
    f.draw(l.text, f.left, y, { font: l.bold ? f.bold : f.regular, size: l.size, color: l.color ?? C.text, align: alignLeft ? "left" : "right", width: f.width });
  }
  f.y = Math.min(y, top - logoH) - 8;
  f.page.drawLine({ start: { x: f.left, y: f.y }, end: { x: f.right, y: f.y }, thickness: 1.5, color: C.navy });
  f.y -= 10;
}
