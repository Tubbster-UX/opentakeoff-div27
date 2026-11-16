// Text extraction and classification for ingested files.
//
// PDFs: pdfjs-dist legacy build in Node, text content only (never renders),
// read through a range transport so a 300 MB plan set is not loaded into
// memory, one page at a time. Word (.docx) and Excel (.xlsx): the needed XML
// parts are streamed out of the zip with yauzl under a size cap. Plain text
// formats: decoded as UTF-8 under a size cap.

import { open as openFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import yauzl from "yauzl";
import type { FileKind } from "./types.ts";

export interface PageText {
  n: number;
  text: string;
  label?: string;
}

export interface ExtractLimits {
  /** Characters kept per page (rest dropped). Default 200k. */
  maxPageChars: number;
  /** Characters kept per file. Default 20M. */
  maxFileChars: number;
  /** Uncompressed bytes read from one XML part of a docx/xlsx. Default 64 MiB. */
  maxXmlBytes: number;
  /** Bytes read from a plain-text file. Default 32 MiB. */
  maxPlainBytes: number;
  /** Pages read from a PDF (text beyond is dropped, the page count is still right). Default 5000. */
  maxPdfPages: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxPageChars: 200_000,
  maxFileChars: 20_000_000,
  maxXmlBytes: 64 * 1024 * 1024,
  maxPlainBytes: 32 * 1024 * 1024,
  maxPdfPages: 5000,
};

export interface ExtractResult {
  /** ok: text extracted; none: no text layer / not a text format; error: extraction failed. */
  status: "ok" | "none" | "error";
  error?: string;
  pages: PageText[];
  /** PDF page count. */
  pageCount?: number;
  /** Largest page dimension (points) among the first pages of a PDF. */
  maxPageDimPt?: number;
  textChars: number;
}

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// ── classification ──────────────────────────────────────────────────────────

const DOC_EXTS = new Set(["docx", "doc", "txt", "rtf", "md", "odt", "pages", "htm", "html"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "xlsm", "csv", "tsv", "ods", "numbers"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "gif", "bmp", "webp", "heic"]);

/** 17 in = 1224 pt; anything with a side this long is a drawing sheet, not a letter/legal page. */
const LARGE_FORMAT_PT = 1200;

/** "E-101", "T1.01", "ET-201", "E101 Telecom Plan", "FA-001A". */
const SHEET_NUMBER_NAME = /^[a-z]{1,3}[-_ .]?\d{1,3}(?:\.\d{1,3})?[a-z]?(?:$|[\s_-])/i;

interface Signal {
  re: RegExp;
  w: number;
}

const SOW_TEXT: Signal[] = [
  { re: /statement\s+of\s+work/i, w: 3 },
  { re: /performance\s+work\s+statement/i, w: 3 },
  { re: /statement\s+of\s+objectives/i, w: 2 },
  { re: /\bSOW\b/, w: 1 },
  { re: /\bPWS\b/, w: 1 },
  { re: /\bsolicitation\b/i, w: 1 },
];
const SPEC_TEXT: Signal[] = [
  { re: /\bSECTION\s+\d{2}\s?\d{2}\s?\d{2}(?:\.\d+)?\b/i, w: 3 },
  { re: /\bPART\s+1\s*[-–—.]?\s*GENERAL\b/i, w: 3 },
  { re: /\bDIVISION\s+\d{1,2}\b/i, w: 1 },
  { re: /\bproject\s+manual\b/i, w: 2 },
  { re: /\bspecifications?\b/i, w: 1 },
];
const FORM_TEXT: Signal[] = [
  { re: /\b(?:SF|standard\s+form)\s*-?\s*(?:1449|1442|30|33|18|26|1447)\b/i, w: 3 },
  { re: /\bwage\s+determination\b/i, w: 3 },
  { re: /\b52\.204-\d+/, w: 2 },
  { re: /\b52\.212-\d+/, w: 2 },
  { re: /\brepresentations\s+and\s+certifications\b/i, w: 2 },
  { re: /\bamendment\s+of\s+solicitation\b/i, w: 2 },
  { re: /\brepresentations\b/i, w: 1 },
];

function score(text: string, signals: Signal[]): number {
  let s = 0;
  for (const sig of signals) if (sig.re.test(text)) s += sig.w;
  return s;
}

/**
 * FileKind from the name, extension, and (for PDFs and text documents) page
 * size and first-page text. Name signals beat page size, page size beats text.
 */
export function classify(name: string, info: { maxPageDimPt?: number; firstText?: string } = {}): Exclude<FileKind, "output"> {
  const ext = extOf(name);
  const base = (name.split("/").pop() ?? name).replace(/\.[^.]+$/, "");
  const lname = base.toLowerCase();
  if (SHEET_EXTS.has(ext)) return "sheet";
  if (IMAGE_EXTS.has(ext)) return "image";
  const isPdf = ext === "pdf";
  if (!isPdf && !DOC_EXTS.has(ext)) return "other";

  // Name signals.
  if (/\b(?:sow|pws|soo)\b|statement[\s_-]*of[\s_-]*work|performance[\s_-]*work[\s_-]*statement/.test(lname.replace(/_/g, " "))) return "sow";
  if (/\bsf[\s_-]*(?:1449|1442|30|33|18)\b|wage[\s_-]*determination|\bwd[\s_-]*\d|reps?[\s_-]*(?:and|&)[\s_-]*certs?/.test(lname.replace(/_/g, " "))) return "form";
  if (/spec(?:ification)?s?\b|project[\s_-]*manual/.test(lname.replace(/_/g, " "))) return "spec";
  if (isPdf) {
    if ((info.maxPageDimPt ?? 0) >= LARGE_FORMAT_PT) return "plan";
    if (SHEET_NUMBER_NAME.test(base) || /\b(?:drawings?|plans|plan[\s_-]*set|sheets)\b/.test(lname.replace(/_/g, " "))) return "plan";
  }

  // First-page text.
  const text = (info.firstText ?? "").slice(0, 8000);
  if (text) {
    const s = { sow: score(text, SOW_TEXT), spec: score(text, SPEC_TEXT), form: score(text, FORM_TEXT) };
    const best = (["sow", "spec", "form"] as const).reduce((a, b) => (s[b] > s[a] ? b : a));
    if (s[best] > 0) return best;
  }
  return "doc";
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** Extracts text from a local file; never throws (failures come back as status "error"). */
export async function extractFile(file: string, name: string, limits: Partial<ExtractLimits> = {}): Promise<ExtractResult> {
  const lim = { ...DEFAULT_EXTRACT_LIMITS, ...limits };
  const ext = extOf(name);
  try {
    let res: ExtractResult;
    if (ext === "pdf") res = await extractPdf(file, lim);
    else if (ext === "docx" || ext === "docm") res = finish(await extractDocx(file, lim), lim);
    else if (ext === "xlsx" || ext === "xlsm") res = finish(await extractXlsx(file, lim), lim);
    else if (ext === "txt" || ext === "md" || ext === "csv" || ext === "tsv") res = finish(await extractPlain(file, lim), lim);
    else if (ext === "rtf") res = finish(await extractRtf(file, lim), lim);
    else return { status: "none", pages: [], textChars: 0 };
    return res;
  } catch (err) {
    return { status: "error", error: errMessage(err), pages: [], textChars: 0 };
  }
}

function finish(pages: PageText[], lim: ExtractLimits): ExtractResult {
  const capped = capPages(pages, lim);
  const textChars = capped.reduce((n, p) => n + p.text.length, 0);
  const meaningful = capped.reduce((n, p) => n + p.text.replace(/\s+/g, "").length, 0);
  return { status: meaningful > 0 ? "ok" : "none", pages: meaningful > 0 ? capped : [], textChars: meaningful > 0 ? textChars : 0 };
}

function capPages(pages: PageText[], lim: ExtractLimits): PageText[] {
  let budget = lim.maxFileChars;
  return pages.map((p) => {
    let text = p.text.length > lim.maxPageChars ? p.text.slice(0, lim.maxPageChars) : p.text;
    if (text.length > budget) text = text.slice(0, Math.max(0, budget));
    budget -= text.length;
    return { ...p, text };
  });
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? m.slice(0, 500) + "…" : m;
}

// ── PDF ─────────────────────────────────────────────────────────────────────

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function pdfjsAssetDir(sub: string): string {
  const req = createRequire(import.meta.url);
  const pkg = path.dirname(req.resolve("pdfjs-dist/package.json"));
  return path.join(pkg, sub) + path.sep;
}

/** Below this many non-space characters per page on average, the PDF has no usable text layer. */
const MIN_CHARS_PER_PAGE = 8;

export async function extractPdf(file: string, lim: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<ExtractResult> {
  const pdfjs = await loadPdfJs();
  const { size } = await stat(file);
  const fh = await openFile(file, "r");
  const transport = new pdfjs.PDFDataRangeTransport(size, null);
  transport.requestDataRange = (begin: number, end: number) => {
    const len = Math.max(0, Math.min(end, size) - begin);
    const buf = new Uint8Array(len);
    fh.read(buf, 0, len, begin).then(
      () => transport.onDataRange(begin, buf),
      () => transport.onDataRange(begin, new Uint8Array(0)),
    );
  };
  const task = pdfjs.getDocument({
    range: transport,
    length: size,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    stopAtErrors: false,
    verbosity: 0,
    standardFontDataUrl: pdfjsAssetDir("standard_fonts"),
    cMapUrl: pdfjsAssetDir("cmaps"),
    cMapPacked: true,
  } as Parameters<PdfJs["getDocument"]>[0]);
  try {
    const doc = await task.promise;
    const pageCount = doc.numPages;
    const pages: PageText[] = [];
    let maxDim = 0;
    let budget = lim.maxFileChars;
    let meaningful = 0;
    const readPages = Math.min(pageCount, lim.maxPdfPages);
    for (let n = 1; n <= readPages; n++) {
      const page = await doc.getPage(n);
      try {
        if (n <= 3) {
          const vp = page.getViewport({ scale: 1 });
          maxDim = Math.max(maxDim, vp.width, vp.height);
        }
        let text = "";
        if (budget > 0) {
          const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          text = joinTextItems(content.items as TextItemLike[], Math.min(lim.maxPageChars, budget));
          budget -= text.length;
        }
        meaningful += text.replace(/\s+/g, "").length;
        pages.push({ n, text });
      } finally {
        page.cleanup();
      }
      // pdf.js caches every page proxy (and the worker its parsed pages); drop them as we go.
      if (n % 25 === 0) await doc.cleanup().catch(() => undefined);
    }
    const textChars = pages.reduce((a, p) => a + p.text.length, 0);
    const hasText = meaningful >= Math.max(1, readPages) * MIN_CHARS_PER_PAGE;
    return { status: hasText ? "ok" : "none", pages: hasText ? pages : [], pageCount, maxPageDimPt: maxDim || undefined, textChars: hasText ? textChars : 0 };
  } finally {
    await task.destroy().catch(() => undefined);
    await fh.close().catch(() => undefined);
  }
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  height?: number;
  width?: number;
  hasEOL?: boolean;
}

/** Joins pdf.js text items into lines: a new line when the baseline moves, a space between runs on one line. */
export function joinTextItems(items: TextItemLike[], maxChars: number): string {
  const parts: string[] = [];
  let len = 0;
  let lastY: number | null = null;
  let lastEndX: number | null = null;
  let lineHasText = false;
  const push = (s: string) => {
    parts.push(s);
    len += s.length;
  };
  for (const it of items) {
    if (len >= maxChars) break;
    if (typeof it.str !== "string") continue;
    const t = it.transform ?? [1, 0, 0, 1, 0, 0];
    const y = t[5];
    const x = t[4];
    const h = Math.abs(it.height || t[3] || 10);
    if (lastY !== null && Math.abs(y - lastY) > Math.max(2, h * 0.5)) {
      if (lineHasText) push("\n");
      lineHasText = false;
      lastEndX = null;
    } else if (lineHasText && it.str && !/^\s/.test(it.str) && !/\s$/.test(parts[parts.length - 1] ?? "")) {
      // Same line: a space unless the runs touch.
      if (lastEndX === null || x - lastEndX > h * 0.1) push(" ");
    }
    if (it.str) {
      push(it.str);
      lineHasText = lineHasText || it.str.trim().length > 0;
      lastEndX = x + (it.width ?? 0);
      lastY = y;
    }
    if (it.hasEOL) {
      if (lineHasText) push("\n");
      lineHasText = false;
      lastEndX = null;
    }
  }
  const out = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// ── zip parts (docx / xlsx) ─────────────────────────────────────────────────

/** Reads the wanted entries of a (trusted-format, untrusted-content) zip into memory, each capped at maxBytes. */
export async function readZipParts(file: string, want: (name: string) => boolean, maxBytes: number, maxEntries = 20000): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: false, decodeStrings: true }, (err, z) => (err || !z ? reject(err ?? new Error("Not a zip")) : resolve(z))),
  );
  const out = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    let count = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(err);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(out);
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      if (++count > maxEntries) return fail(new Error("Too many entries in the document package"));
      if (!want(entry.fileName) || entry.fileName.endsWith("/")) return zip.readEntry();
      if (entry.uncompressedSize > maxBytes) return fail(new Error(`${entry.fileName} is larger than ${maxBytes} bytes`));
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err ?? new Error("Cannot read entry"));
        const chunks: Buffer[] = [];
        let n = 0;
        stream.on("data", (c: Buffer) => {
          n += c.length;
          if (n > maxBytes) {
            stream.destroy();
            fail(new Error(`${entry.fileName} is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          out.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

const XML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
function decodeXml(s: string): string {
  return s.replace(XML_ENTITY_RE, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// ── Word ────────────────────────────────────────────────────────────────────

/** Text of word/document.xml: <w:t> runs, tabs, line breaks, paragraph breaks; explicit page breaks start a new page. */
export async function extractDocx(file: string, lim: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<PageText[]> {
  const parts = await readZipParts(file, (n) => n === "word/document.xml", lim.maxXmlBytes);
  const xml = parts.get("word/document.xml")?.toString("utf8");
  if (xml == null) throw new Error("word/document.xml not found (not a Word document?)");
  return docxXmlToPages(xml);
}

export function docxXmlToPages(xml: string): PageText[] {
  const pages: string[] = [];
  let cur = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t\s*\/>|<w:(tab|br|cr)(\s[^>]*)?\/>|<\/w:p>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) cur += decodeXml(m[1]);
    else if (m[2] === "tab") cur += "\t";
    else if (m[2] === "br" && /w:type\s*=\s*"page"/.test(m[3] ?? "")) {
      pages.push(cur);
      cur = "";
    } else if (m[2] === "br" || m[2] === "cr") cur += "\n";
    else if (m[0] === "</w:p>") cur += "\n";
  }
  pages.push(cur);
  return pages.map((t, i) => ({ n: i + 1, text: t.replace(/\n{3,}/g, "\n\n").trim() })).filter((p, i, all) => p.text || all.length === 1).map((p, i) => ({ ...p, n: i + 1 }));
}

// ── Excel ───────────────────────────────────────────────────────────────────

/** One page per worksheet, label = sheet name, rows as tab-separated lines. */
export async function extractXlsx(file: string, lim: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<PageText[]> {
  const parts = await readZipParts(
    file,
    (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n),
    lim.maxXmlBytes,
  );
  const wb = parts.get("xl/workbook.xml")?.toString("utf8");
  if (wb == null) throw new Error("xl/workbook.xml not found (not an Excel workbook?)");
  const shared = parseSharedStrings(parts.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const rels = new Map<string, string>();
  for (const m of (parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target);
  }
  const pages: PageText[] = [];
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)];
  sheets.forEach((m, i) => {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${i + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1] ?? /\bid="([^"]*)"/.exec(m[0])?.[1];
    let target = rid ? rels.get(rid) : undefined;
    if (target) target = target.startsWith("/") ? target.slice(1) : target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = parts.get(target ?? `xl/worksheets/sheet${i + 1}.xml`)?.toString("utf8") ?? "";
    pages.push({ n: i + 1, label: name, text: sheetXmlToText(xml, shared, lim.maxPageChars) });
  });
  return pages;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // Skip phonetic runs (<rPh>); join every <t>.
    const body = si[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let s = "";
    for (const t of body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += decodeXml(t[1]);
    out.push(s);
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export function sheetXmlToText(xml: string, shared: string[], maxChars: number): string {
  const lines: string[] = [];
  let len = 0;
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (len >= maxChars) break;
    const cells: string[] = [];
    let next = 0;
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      let val = "";
      if (type === "inlineStr") {
        for (const t of body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) val += decodeXml(t[1]);
      } else {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (v != null) val = type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
      }
      const idx = ref ? colIndex(ref) : next;
      // Pad skipped columns (capped so a stray "XFD1" cell cannot blow up a line).
      while (cells.length < idx && cells.length < next + 50) cells.push("");
      cells.push(val.replace(/[\t\r\n]+/g, " "));
      next = cells.length;
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length) {
      const line = cells.join("\t");
      lines.push(line);
      len += line.length + 1;
    }
  }
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// ── plain text, RTF ─────────────────────────────────────────────────────────

async function readCapped(file: string, maxBytes: number): Promise<Buffer> {
  const fh = await openFile(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return sw.toString("utf16le");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/^﻿/, "");
}

export async function extractPlain(file: string, lim: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<PageText[]> {
  // eslint-disable-next-line no-control-regex
  const text = decodeText(await readCapped(file, lim.maxPlainBytes)).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  return [{ n: 1, text }];
}

/** Crude RTF → text: drops destinations ({\*...}, fonttbl, colortbl, pict...), control words and braces. */
export async function extractRtf(file: string, lim: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<PageText[]> {
  const src = (await readCapped(file, lim.maxPlainBytes)).toString("latin1");
  let out = "";
  let depth = 0;
  let skipDepth = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      depth++;
      const ahead = src.slice(i + 1, i + 16);
      if (skipDepth < 0 && /^\\\*|^\\(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|datastore|latentstyles)\b/.test(ahead)) skipDepth = depth;
      continue;
    }
    if (ch === "}") {
      if (depth === skipDepth) skipDepth = -1;
      depth--;
      continue;
    }
    if (ch === "\\") {
      const m = /^\\(?:([a-zA-Z]+)(-?\d+)? ?|'([0-9a-fA-F]{2})|(.))/s.exec(src.slice(i, i + 40));
      if (!m) continue;
      i += m[0].length - 1;
      if (skipDepth >= 0) continue;
      if (m[1]) {
        if (m[1] === "par" || m[1] === "line" || m[1] === "row") out += "\n";
        else if (m[1] === "tab" || m[1] === "cell") out += "\t";
        else if (m[1] === "u" && m[2]) {
          out += String.fromCharCode(((Number(m[2]) % 65536) + 65536) % 65536);
          if (src[i + 1] === "?") i++;
        }
      } else if (m[3]) out += Buffer.from([parseInt(m[3], 16)]).toString("latin1");
      else if (m[4] && "\\{}".includes(m[4])) out += m[4];
      continue;
    }
    if (skipDepth >= 0 || ch === "\r" || ch === "\n") continue;
    out += ch;
  }
  return [{ n: 1, text: out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() }];
}
