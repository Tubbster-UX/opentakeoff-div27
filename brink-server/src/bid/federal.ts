// The federal quote package: a cover letter and a technical package (compliance
// matrix, exceptions, assumptions, bill of materials by room, price), each as
// .docx (the `docx` package) and PDF (pdf-lib), built from ONE content object
// so the two formats never disagree. Claude writes the words in the owner's
// federal voice; this file only lays them out and enforces the rules:
//   - no blank compliance-matrix cell (the error lists every empty one)
//   - exceptions numbered, closed with "No other exceptions are taken." (or
//     "No exceptions are taken." when there are none)
//   - company block with UEI and CAGE from settings
//   - DRAFT header (and, in the PDF, the diagonal stamp) until approved
//   - no OpenTakeoff marks; no SF 1449 or reps and certs (the owner fills and signs those)
import {
  AlignmentType, BorderStyle, Document, Footer, Header, ImageRun, Packer, PageNumber, Paragraph, ShadingType,
  Table, TableBorders, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { z } from "zod";
import type { BidDraft, CompanyProfile } from "../bidTypes.ts";
import type { ProjectManifest } from "../types.ts";
import { ContentError, assertComplete, draftMark, money } from "./format.ts";
import { C, PdfFlow, letterhead, type Align, type Column } from "./pdfKit.ts";

const text = (max = 4000) => z.string().trim().min(1).max(max);
const cell = (max = 4000) => z.string().trim().max(max); // may be blank here: the renderer lists blanks by row

export const FederalContentSchema = z.object({
  solicitation: z.object({ number: text(100), title: text(300), agency: text(300), office: text(300) }),
  /** Letter date as it should print; default today. */
  date: z.string().trim().max(60).optional(),
  recipients: z.array(z.object({
    name: text(200),
    rank: z.string().trim().max(60).optional(),
    /** "Contracting Officer" or "Contract Specialist". */
    role: text(100),
    email: text(200),
  })).min(1).max(6),
  coverParagraphs: z.array(text(6000)).min(1).max(30),
  complianceMatrix: z.array(z.object({
    requirement: cell(),
    reference: cell(200),
    offered: cell(1000),
    response: z.enum(["Meets", "Exceeds", "Exception"]),
    exceptionNo: z.number().int().positive().optional(),
  })).min(1).max(400),
  exceptions: z.array(z.object({
    no: z.number().int().positive(),
    sowSays: text(),
    conflict: text(),
    brinkDoes: text(),
    offRamp: text(),
  })).max(50),
  assumptions: z.array(z.object({ text: text(), exceptionNo: z.number().int().positive().optional() })).max(100),
  bomByRoom: z.array(z.object({
    room: text(200),
    items: z.array(z.object({
      description: text(500),
      manufacturer: z.string().trim().max(200),
      model: z.string().trim().max(200),
      qty: z.union([z.number(), z.string().trim().max(40)]),
      taa: z.string().trim().max(60).optional(),
    })).min(1).max(500),
  })).max(200),
  priceStatement: text(4000),
  deliveryTerms: z.string().trim().max(2000).optional(),
  /** Letter closing; default "Respectfully,". */
  closing: z.string().trim().max(60).optional(),
});
export type FederalContent = z.infer<typeof FederalContentSchema>;

export interface FederalPackageArgs {
  bid: BidDraft;
  project: ProjectManifest;
  content: FederalContent;
  logo?: Uint8Array;
  allowIncomplete?: boolean;
}

export interface FederalPackage {
  coverDocx: Uint8Array;
  coverPdf: Uint8Array;
  technicalDocx: Uint8Array;
  technicalPdf: Uint8Array;
}

export const NO_OTHER_EXCEPTIONS = "No other exceptions are taken.";
export const NO_EXCEPTIONS = "No exceptions are taken.";

/** Every rule the renderer enforces, as messages (empty = fine). */
export function federalContentProblems(k: FederalContent): string[] {
  const out: string[] = [];
  const blanks: string[] = [];
  k.complianceMatrix.forEach((row, i) => {
    const empty: string[] = (["requirement", "reference", "offered"] as const).filter((f) => !row[f]?.trim());
    if (row.response === "Exception" && row.exceptionNo == null) empty.push("exceptionNo");
    if (empty.length) blanks.push(`row ${i + 1} (${row.reference?.trim() || row.requirement?.trim().slice(0, 40) || "?"}): ${empty.join(", ")}`);
  });
  if (blanks.length) out.push(`Compliance matrix has blank cells — ${blanks.join("; ")}`);
  const nos = k.exceptions.map((e) => e.no);
  const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
  if (dup.length) out.push(`Exception numbers repeat: ${[...new Set(dup)].join(", ")}`);
  const known = new Set(nos);
  k.complianceMatrix.forEach((row, i) => {
    if (row.exceptionNo != null && !known.has(row.exceptionNo)) out.push(`Compliance matrix row ${i + 1} points at exception ${row.exceptionNo}, which is not in exceptions`);
    if (row.exceptionNo != null && row.response !== "Exception") out.push(`Compliance matrix row ${i + 1} has exceptionNo ${row.exceptionNo} but response "${row.response}"`);
  });
  k.assumptions.forEach((a, i) => {
    if (a.exceptionNo != null && !known.has(a.exceptionNo)) out.push(`Assumption ${i + 1} points at exception ${a.exceptionNo}, which is not in exceptions`);
  });
  return out;
}

// ── one document model, two renderers ───────────────────────────────────────

type Block =
  | { t: "letterhead" }
  | { t: "title"; text: string; sub?: string }
  | { t: "h"; text: string; level?: 1 | 2 }
  | { t: "p"; text: string; bold?: boolean; red?: boolean; after?: number }
  | { t: "kv"; rows: [string, string][] }
  | { t: "table"; columns: Column[]; rows: string[][] }
  | { t: "list"; items: string[]; numbered?: boolean }
  | { t: "space"; h: number };

interface DocCtx {
  company: CompanyProfile;
  logo?: Uint8Array;
  draft: string;         // "" when approved
  title: string;
  footer: string;
}

async function blocksToPdf(blocks: Block[], ctx: DocCtx): Promise<Uint8Array> {
  const f = await PdfFlow.create({ title: ctx.title, author: ctx.company.brand || ctx.company.legalName });
  for (const b of blocks) {
    switch (b.t) {
      case "letterhead": await letterhead(f, ctx.company, ctx.logo, { ids: true }); break;
      case "title":
        f.ensure(60);
        f.y -= 20;
        f.draw(b.text, f.left, f.y, { font: f.bold, size: 18, color: C.navy });
        if (b.sub) { f.y -= 16; f.draw(b.sub, f.left, f.y, { size: 11, color: C.blue }); }
        f.y -= 12;
        break;
      case "h": f.heading(b.text, { size: b.level === 2 ? 10.5 : 12, rule: b.level !== 2, keep: 60 }); break;
      case "p": f.paragraph(b.text, { font: b.bold ? f.bold : f.regular, color: b.red ? C.red : undefined, size: 10.5, after: b.after ?? 8 }); break;
      case "kv": f.table([{ header: "", width: 24 }, { header: "", width: 76 }], b.rows, { header: false, zebra: false, labelCols: [0], size: 9.5 }); break;
      case "table": f.table(b.columns, b.rows, { size: 8.5 }); break;
      case "list": f.bullets(b.items, { numbered: b.numbered, size: 10 }); break;
      case "space": f.space(b.h); break;
    }
  }
  return f.finish({
    footerLeft: ctx.footer,
    draft: ctx.draft || undefined,
    headerNote: ctx.draft ? `${ctx.draft} — not for submission` : undefined,
  });
}

const NAVY = "1B3055";
const BLUE = "295498";
const RED = "BC1419";
const LIGHT = "E8EEF6";
const CONTENT_DXA = 9360; // letter, 1" margins

function imageSize(b: Uint8Array): { w: number; h: number; type: "png" | "jpg" } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20), type: "png" };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], type: "jpg" };
      }
      i += 2 + len;
    }
  }
  return null;
}

const run = (t: string, o: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {}) =>
  new TextRun({ text: t, bold: o.bold, color: o.color, size: o.size, italics: o.italics });

/** Multi-line text → one paragraph with line breaks. */
function para(t: string, o: { bold?: boolean; color?: string; size?: number; align?: Align; after?: number } = {}): Paragraph {
  const lines = t.split(/\r?\n/);
  return new Paragraph({
    alignment: o.align === "right" ? AlignmentType.RIGHT : o.align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: o.after ?? 120 },
    children: lines.map((l, i) => new TextRun({ text: l, bold: o.bold, color: o.color, size: o.size, break: i > 0 ? 1 : undefined })),
  });
}

function docxTable(columns: Column[], rows: string[][], o: { header?: boolean; labelCol?: boolean; size?: number } = {}): Table {
  const total = columns.reduce((a, c) => a + c.width, 0);
  const widths = columns.map((c) => Math.round((c.width / total) * CONTENT_DXA));
  const size = o.size ?? 18;
  const mk = (t: string, i: number, head: boolean, zebra: boolean) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: NAVY } : o.labelCol && i === 0 ? { type: ShadingType.CLEAR, color: "auto", fill: LIGHT } : zebra ? { type: ShadingType.CLEAR, color: "auto", fill: "F6F8FB" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [para(t, { bold: head || (o.labelCol && i === 0), color: head ? "FFFFFF" : o.labelCol && i === 0 ? NAVY : undefined, size, align: columns[i].align, after: 0 })],
  });
  const trs: TableRow[] = [];
  if (o.header !== false) trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: columns.map((c, i) => mk(c.header, i, true, false)) }));
  rows.forEach((r, ri) => trs.push(new TableRow({ children: columns.map((_, i) => mk(r[i] ?? "", i, false, ri % 2 === 1 && !o.labelCol)) })));
  const line = { style: BorderStyle.SINGLE, size: 4, color: "BDC7D6" };
  return new Table({
    width: { size: CONTENT_DXA, type: WidthType.DXA },
    columnWidths: widths,
    rows: trs,
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
  });
}

function docxLetterhead(c: CompanyProfile, logo?: Uint8Array): (Paragraph | Table)[] {
  const lines: Paragraph[] = [];
  lines.push(para(c.brand || c.legalName, { bold: true, color: NAVY, size: 28, align: "right", after: 0 }));
  if (c.legalName && c.legalName !== c.brand) lines.push(para(c.legalName, { size: 16, color: "5F6873", align: "right", after: 0 }));
  for (const a of c.address) lines.push(para(a, { size: 17, align: "right", after: 0 }));
  lines.push(para([c.phone, c.email].filter(Boolean).join(" · "), { size: 17, align: "right", after: 0 }));
  if (c.web) lines.push(para(c.web, { size: 17, align: "right", after: 0 }));
  const ids = [c.uei ? `UEI ${c.uei}` : "", c.cage ? `CAGE ${c.cage}` : ""].filter(Boolean).join(" · ");
  if (ids) lines.push(para(ids, { size: 17, bold: true, color: NAVY, align: "right", after: 0 }));
  for (const x of c.extraIds ?? []) lines.push(para(x, { size: 16, color: "5F6873", align: "right", after: 0 }));
  const dim = logo ? imageSize(logo) : null;
  const logoPara = dim && logo
    ? new Paragraph({ children: [new ImageRun({ type: dim.type, data: logo, transformation: (() => { const s = Math.min(200 / dim.w, 77 / dim.h); return { width: Math.round(dim.w * s), height: Math.round(dim.h * s) }; })() })] })
    : new Paragraph({ children: [] });
  const rule = new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 4 } }, children: [] });
  return [
    new Table({
      width: { size: CONTENT_DXA, type: WidthType.DXA },
      columnWidths: [3600, CONTENT_DXA - 3600],
      borders: TableBorders.NONE,
      rows: [new TableRow({ children: [
        new TableCell({ width: { size: 3600, type: WidthType.DXA }, children: [logoPara] }),
        new TableCell({ width: { size: CONTENT_DXA - 3600, type: WidthType.DXA }, children: lines }),
      ] })],
    }),
    rule,
  ];
}

async function blocksToDocx(blocks: Block[], ctx: DocCtx): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "letterhead": children.push(...docxLetterhead(ctx.company, ctx.logo)); break;
      case "title":
        children.push(para(b.text, { bold: true, color: NAVY, size: 36, after: b.sub ? 40 : 200 }));
        if (b.sub) children.push(para(b.sub, { color: BLUE, size: 22, after: 200 }));
        break;
      case "h":
        children.push(new Paragraph({
          keepNext: true,
          spacing: { before: 240, after: 100 },
          border: b.level === 2 ? undefined : { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLUE, space: 2 } },
          children: [run(b.text, { bold: true, color: NAVY, size: b.level === 2 ? 21 : 24 })],
        }));
        break;
      case "p": children.push(para(b.text, { bold: b.bold, color: b.red ? RED : undefined, size: 21, after: Math.round((b.after ?? 8) * 20) })); break;
      case "kv": children.push(docxTable([{ header: "", width: 24 }, { header: "", width: 76 }], b.rows, { header: false, labelCol: true, size: 19 }), para("", { after: 120 })); break;
      case "table": children.push(docxTable(b.columns, b.rows, { size: 17 }), para("", { after: 120 })); break;
      case "list":
        b.items.forEach((item, i) => children.push(new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360, hanging: 360 },
          children: [run(b.numbered ? `${i + 1}.\t` : "•\t", { bold: b.numbered, color: BLUE, size: 20 }), run(item, { size: 20 })],
        })));
        children.push(para("", { after: 60 }));
        break;
      case "space": children.push(para("", { after: Math.round(b.h * 20) })); break;
    }
  }
  const header = new Header({
    children: ctx.draft ? [para(`${ctx.draft} — not for submission`, { bold: true, color: RED, size: 24, align: "center", after: 0 })] : [],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: "BDC7D6", space: 4 } },
        tabStops: [{ type: "right", position: CONTENT_DXA }],
        children: [
          run(ctx.footer, { size: 16, color: "5F6873" }),
          new TextRun({ children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: "5F6873" }),
        ],
      }),
      ...(ctx.draft ? [para(ctx.draft, { bold: true, color: RED, size: 16, align: "center", after: 0 })] : []),
    ],
  });
  const who = ctx.company.brand || ctx.company.legalName;
  const doc = new Document({
    creator: who,
    lastModifiedBy: who,
    title: ctx.title,
    styles: { default: { document: { run: { font: "Arial", size: 21 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1300, left: 1440, right: 1440, header: 600, footer: 500 } } },
      headers: { default: header },
      footers: { default: footer },
      children,
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// ── the two documents ───────────────────────────────────────────────────────

function today(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function priceBlocks(bid: BidDraft, incomplete: boolean): Block[] {
  return incomplete
    ? [{ t: "p", text: `Firm-fixed price: INCOMPLETE — not for submission${bid.totals.baseBid != null ? ` (priced so far ${money(bid.totals.baseBid)})` : ""}`, bold: true, red: true }]
    : [{ t: "p", text: `Firm-fixed price: ${money(bid.totals.baseBid)}`, bold: true }];
}

export function coverLetterBlocks(bid: BidDraft, k: FederalContent, incomplete: boolean): Block[] {
  const c = bid.settings.company;
  const sol = k.solicitation;
  const blocks: Block[] = [{ t: "letterhead" }, { t: "p", text: k.date || today(), after: 14 }];
  for (const r of k.recipients) {
    blocks.push({ t: "p", text: [`${r.name}${r.rank ? `, ${r.rank}` : ""}`, r.role, r.email].join("\n"), after: 8 });
  }
  blocks.push({ t: "p", text: [sol.office, sol.agency].join("\n"), after: 14 });
  blocks.push({ t: "p", text: `RE: Solicitation ${sol.number}, ${sol.title}`, bold: true, after: 12 });
  for (const p of k.coverParagraphs) blocks.push({ t: "p", text: p, after: 10 });
  blocks.push(...priceBlocks(bid, incomplete));
  blocks.push({ t: "space", h: 6 });
  blocks.push({ t: "p", text: k.closing || "Respectfully,", after: 30 });
  blocks.push({ t: "p", text: [c.signerName, c.signerTitle, c.legalName || c.brand, [c.phone, c.email].filter(Boolean).join(" · ")].filter(Boolean).join("\n") });
  return blocks;
}

export function technicalBlocks(bid: BidDraft, k: FederalContent, incomplete: boolean): Block[] {
  const c = bid.settings.company;
  const sol = k.solicitation;
  const blocks: Block[] = [
    { t: "letterhead" },
    { t: "title", text: "Technical Package", sub: `Solicitation ${sol.number} — ${sol.title}` },
    { t: "kv", rows: [
      ["Solicitation", sol.number], ["Title", sol.title], ["Agency", sol.agency], ["Office", sol.office],
      ["Offeror", c.legalName || c.brand], ["UEI", c.uei ?? "NOT SET in settings"], ["CAGE", c.cage ?? "NOT SET in settings"],
      ["Date", k.date || today()],
    ] },
    { t: "h", text: "1. Compliance Matrix" },
    { t: "table",
      columns: [{ header: "#", width: 4, align: "center" }, { header: "SOW requirement", width: 38 }, { header: "SOW ref", width: 11 }, { header: "Offered (make / model)", width: 29 }, { header: "Response", width: 18 }],
      rows: k.complianceMatrix.map((r, i) => [String(i + 1), r.requirement, r.reference, r.offered, r.response === "Exception" ? `Exception ${r.exceptionNo}` : r.response]) },
    { t: "h", text: "2. Exceptions" },
  ];
  const brand = c.brand || c.legalName;
  const exceptions = [...k.exceptions].sort((a, b) => a.no - b.no);
  for (const e of exceptions) {
    blocks.push({ t: "h", text: `Exception ${e.no}`, level: 2 });
    blocks.push({ t: "kv", rows: [["The SOW says", e.sowSays], ["Conflict", e.conflict], [`${brand} will`, e.brinkDoes], ["Off-ramp", e.offRamp]] });
  }
  blocks.push({ t: "p", text: exceptions.length ? NO_OTHER_EXCEPTIONS : NO_EXCEPTIONS, bold: true });
  blocks.push({ t: "h", text: "3. Assumptions" });
  if (k.assumptions.length) blocks.push({ t: "list", numbered: true, items: k.assumptions.map((a) => `${a.text}${a.exceptionNo != null ? ` (see Exception ${a.exceptionNo})` : ""}`) });
  else blocks.push({ t: "p", text: "None." });
  blocks.push({ t: "h", text: "4. Bill of Materials by Room" });
  if (!k.bomByRoom.length) blocks.push({ t: "p", text: "None." });
  for (const room of k.bomByRoom) {
    blocks.push({ t: "h", text: room.room, level: 2 });
    blocks.push({ t: "table",
      columns: [{ header: "Description", width: 38 }, { header: "Manufacturer", width: 20 }, { header: "Model", width: 22 }, { header: "Qty", width: 8, align: "right" }, { header: "TAA", width: 12 }],
      rows: room.items.map((it) => [it.description, it.manufacturer, it.model, String(it.qty), it.taa ?? ""]) });
  }
  blocks.push({ t: "h", text: "5. Price" });
  blocks.push({ t: "p", text: k.priceStatement });
  blocks.push(...priceBlocks(bid, incomplete));
  if (k.deliveryTerms) blocks.push({ t: "p", text: k.deliveryTerms });
  return blocks;
}

export async function renderFederalPackage(args: FederalPackageArgs): Promise<FederalPackage> {
  const { bid, content: k } = args;
  const problems = federalContentProblems(k);
  if (problems.length) throw new ContentError(`Federal package content is not ready: ${problems.join(". ")}.`);
  const incomplete = assertComplete(bid, args.allowIncomplete, "federal package");
  const c = bid.settings.company;
  const ids = [c.uei ? `UEI ${c.uei}` : "", c.cage ? `CAGE ${c.cage}` : ""].filter(Boolean).join(" · ");
  const base = {
    company: c,
    logo: args.logo,
    draft: draftMark(bid),
    footer: [c.brand || c.legalName, ids, `Solicitation ${k.solicitation.number}`].filter(Boolean).join(" · "),
  };
  const coverCtx: DocCtx = { ...base, title: `Cover letter — ${k.solicitation.number}` };
  const techCtx: DocCtx = { ...base, title: `Technical package — ${k.solicitation.number}` };
  const cover = coverLetterBlocks(bid, k, incomplete);
  const tech = technicalBlocks(bid, k, incomplete);
  const [coverDocx, coverPdf, technicalDocx, technicalPdf] = await Promise.all([
    blocksToDocx(cover, coverCtx), blocksToPdf(cover, coverCtx), blocksToDocx(tech, techCtx), blocksToPdf(tech, techCtx),
  ]);
  return { coverDocx, coverPdf, technicalDocx, technicalPdf };
}
