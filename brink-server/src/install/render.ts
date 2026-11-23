// The install drawing package: an 11x17 (ANSI B tabloid, landscape) PDF the
// install crews work from, rendered from the InstallDesign Claude drafted and
// the owner approved. Sheets, by section:
//
//   I-0.0  cover: index, revisions, system summary, status
//   I-1.n  device plans: the source plan page as a vector copy, tagged markers, legend
//   I-2.n  pull-label plans: each device with its cable labels, coloured by home-run rack
//   I-3.n  pull schedule: one table per destination room, flowing across sheets
//   I-4.n  rack elevations: front elevation, power and heat
//   I-5.n  signal flow: rack gear, then field devices by room, with far-end references
//   I-6.n  mounting details
//
// Every sheet carries the title block (company, client, project, sheet title and
// number, date, revision, status). Until the owner approves this revision the
// status reads "DRAFT — NOT FOR CONSTRUCTION"; nothing here approves anything.
// Missing facts stay missing: an unmeasured length prints blank with a note, an
// unknown wattage prints "unknown" and is never summed as zero.
import { PDFDocument } from "pdf-lib";
import type { PDFEmbeddedPage, RGB } from "pdf-lib";
import { rgb } from "pdf-lib";
import { PdfFlow } from "../bid/pdfKit.ts";
import { isoDay } from "../bid/format.ts";
import type { CompanyProfile } from "../bidTypes.ts";
import type { CableKind, Connection, InstallDesign, InstallDevice, InstallEquipment, MountingDetail, Rack } from "../installTypes.ts";
import type { ProjectManifest } from "../types.ts";
import { fitPlacement, normToSheet, placeLabels, planGeometry, rectAt, ringCandidates, uprightMatrix } from "./geometry.ts";
import type { LabelItem, Placement, PlanGeometry, Rect } from "./geometry.ts";
import { fmtFt, naturalCompare, portLabel, pullScheduleRows } from "./schedule.ts";
import type { PullRow } from "./schedule.ts";
import {
  DA, INK, PAGE_H, PAGE_W, SYMBOL_COLORS, SYMBOL_SHAPES, box, caption, drawHeader, drawRow, drawTable, fill, frame,
  headerHeight, para, rowHeight, rule, sheetHeading, symbol, tableHeight, text,
} from "./sheet.ts";
import type { SymbolShape, TCol, TRow, TitleInfo } from "./sheet.ts";

export interface RenderInstallArgs {
  design: InstallDesign;
  project: ProjectManifest;
  company: CompanyProfile;
  logo?: Uint8Array;
  /** The source plan page for a sheet key (the PDF bytes and a 0-based page index), or null when it is not available. */
  planPage: (sheet: string) => Promise<{ pdf: Uint8Array; pageIndex: number } | null>;
  /** Sheet key -> the name printed on the drawings (e.g. "T-101 First floor"). */
  sheetNames?: Record<string, string>;
  /** ISO time used as the issue date of a draft (approval date once approved). */
  now?: string;
  /** Client and site address for the cover and title block, when known (not in the contract yet). */
  site?: { client?: string; address?: string[] };
}

export interface InstallSheet { number: string; title: string }

/** Approved for construction only when the owner approved THIS revision (src/bid/format.ts isApproved, same rule). */
export function installApproved(d: InstallDesign): boolean {
  return d.status === "approved" && (d.approved == null || d.approved.revision === d.revision);
}

// ── palette ────────────────────────────────────────────────────────────────

export const KIND_COLOR: Record<CableKind | "patch" | "wireless", RGB> = {
  data: rgb(0.13, 0.36, 0.75),
  video: rgb(0.5, 0.2, 0.65),
  fiber: rgb(0.88, 0.45, 0.0),
  speaker: rgb(0.1, 0.52, 0.27),
  audio: rgb(0.0, 0.5, 0.55),
  control: rgb(0.52, 0.34, 0.1),
  coax: rgb(0.62, 0.12, 0.12),
  power: rgb(0.86, 0.1, 0.1),
  other: rgb(0.4, 0.4, 0.45),
  patch: rgb(0.45, 0.47, 0.52),
  wireless: rgb(0.35, 0.6, 0.85),
};
const KIND_ORDER: (CableKind | "patch" | "wireless")[] = ["data", "video", "fiber", "speaker", "audio", "control", "coax", "power", "other", "patch", "wireless"];

const RACK_COLORS: RGB[] = [
  rgb(0.1, 0.33, 0.72), rgb(0.85, 0.4, 0.0), rgb(0.1, 0.5, 0.25), rgb(0.65, 0.12, 0.55), rgb(0.0, 0.48, 0.52), rgb(0.5, 0.3, 0.08),
];
const NO_RACK = rgb(0.45, 0.45, 0.48);

const PRETTY: Record<string, string> = { wap: "WAP", wall_outlet: "Wall outlet", access_door: "Access door", tv: "TV", av: "AV" };
export function prettyType(t: string): string {
  if (PRETTY[t]) return PRETTY[t];
  const s = t.replace(/[_-]+/g, " ").trim();
  if (!s) return "Device";
  if (s.length <= 3) return s.toUpperCase();
  return s[0].toUpperCase() + s.slice(1);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── context ────────────────────────────────────────────────────────────────

interface Sheet {
  number: string;
  title: string;
  scale?: string;
  notes?: string[];
  draw: () => void | Promise<void>;
}

interface Link {
  cable?: string;
  kind: Connection["kind"];
  farTag: string;
  farPort?: string;
  farLoc?: string;
}

interface Ctx {
  f: PdfFlow;
  d: InstallDesign;
  approved: boolean;
  date: string;
  equipment: Map<string, InstallEquipment>;
  devices: Map<string, InstallDevice>;
  rackColor: (id: string | null | undefined) => RGB;
  rackName: (id: string) => string;
  typeStyle: (t: string) => { shape: SymbolShape; color: RGB };
  sheetName: (key: string) => string;
  /** tag -> port key -> links */
  links: Map<string, Map<string, Link[]>>;
  /** Equipment / device tag -> the signal-flow sheet that draws it (filled when the flow is laid out). */
  flowSheetOf: Map<string, string>;
  rows: PullRow[];
}

function buildCtx(f: PdfFlow, a: RenderInstallArgs): Ctx {
  const d = a.design;
  const approved = installApproved(d);
  const date = approved && d.approved?.at ? isoDay(d.approved.at) : isoDay(a.now ?? new Date().toISOString());
  const equipment = new Map(d.equipment.map((e) => [e.tag, e]));
  const devices = new Map(d.devices.map((x) => [x.tag, x]));
  const rackIds = [...d.racks.map((r) => r.id)];
  for (const x of d.devices) if (x.rack && !rackIds.includes(x.rack)) rackIds.push(x.rack);
  for (const c of d.cables) if (c.from.rack && !rackIds.includes(c.from.rack)) rackIds.push(c.from.rack);
  const rackColor = (id: string | null | undefined) => {
    const i = id ? rackIds.indexOf(id) : -1;
    return i < 0 ? NO_RACK : RACK_COLORS[i % RACK_COLORS.length];
  };
  const rackName = (id: string) => {
    const r = d.racks.find((x) => x.id === id);
    return r ? `${r.id} (${r.name})` : id;
  };
  const types = [...new Set(d.devices.map((x) => x.deviceType))].sort(naturalCompare);
  const typeStyle = (t: string) => {
    const i = Math.max(0, types.indexOf(t));
    return { shape: SYMBOL_SHAPES[i % SYMBOL_SHAPES.length], color: SYMBOL_COLORS[(i + Math.floor(i / SYMBOL_SHAPES.length)) % SYMBOL_COLORS.length] };
  };
  const sheetName = (key: string) => a.sheetNames?.[key]?.trim() || key;

  // links per port: connections first, then field cables no connection names
  const links = new Map<string, Map<string, Link[]>>();
  const portKey = (tag: string, port: string | undefined, fallback: string) => {
    if (!port) return fallback;
    const eq = equipment.get(tag);
    const p = eq?.ports.find((x) => x.id === port) ?? eq?.ports.find((x) => x.label === port);
    return p ? p.id : port;
  };
  const add = (tag: string, key: string, l: Link) => {
    let m = links.get(tag);
    if (!m) links.set(tag, (m = new Map()));
    const list = m.get(key) ?? [];
    list.push(l);
    m.set(key, list);
  };
  const covered = new Set<string>();
  for (const c of d.connections) {
    if (c.cable) covered.add(c.cable);
    add(c.from.equipment, portKey(c.from.equipment, c.from.port, `#${c.id}`), { cable: c.cable, kind: c.kind, farTag: c.to.equipment, farPort: c.to.port });
    add(c.to.equipment, portKey(c.to.equipment, c.to.port, `#${c.id}`), { cable: c.cable, kind: c.kind, farTag: c.from.equipment, farPort: c.from.port });
  }
  for (const c of d.cables) {
    if (covered.has(c.label)) continue;
    add(c.from.equipment, portKey(c.from.equipment, c.from.port, `#${c.label}`), { cable: c.label, kind: c.kind, farTag: c.to.equipment, farPort: c.to.port, farLoc: c.to.location });
    add(c.to.equipment, portKey(c.to.equipment, c.to.port, `#${c.label}`), { cable: c.label, kind: c.kind, farTag: c.from.equipment, farPort: c.from.port, farLoc: c.from.rack ?? c.from.location });
  }
  return { f, d, approved, date, equipment, devices, rackColor, rackName, typeStyle, sheetName, links, flowSheetOf: new Map(), rows: pullScheduleRows(d) };
}

// ── plan pages ─────────────────────────────────────────────────────────────

type LoadedPlan = { ok: true; geom: PlanGeometry; emb: PDFEmbeddedPage } | { ok: false; reason: string };

async function loadPlans(f: PdfFlow, keys: string[], planPage: RenderInstallArgs["planPage"]): Promise<Map<string, LoadedPlan>> {
  const docs = new Map<Uint8Array, PDFDocument>();
  const out = new Map<string, LoadedPlan>();
  for (const key of keys) {
    try {
      const src = await planPage(key);
      if (!src) { out.set(key, { ok: false, reason: "The source plan page is not available." }); continue; }
      let doc = docs.get(src.pdf);
      if (!doc) {
        doc = await PDFDocument.load(src.pdf, { ignoreEncryption: true, updateMetadata: false });
        docs.set(src.pdf, doc);
      }
      if (doc.isEncrypted) { out.set(key, { ok: false, reason: "The source plan PDF is encrypted and cannot be copied." }); continue; }
      if (!(src.pageIndex >= 0 && src.pageIndex < doc.getPageCount())) { out.set(key, { ok: false, reason: `Page ${src.pageIndex + 1} is not in the source plan PDF.` }); continue; }
      const page = doc.getPage(src.pageIndex);
      const geom = planGeometry(page);
      const [x0, y0, x1, y1] = geom.view;
      const emb = await f.doc.embedPage(page, { left: x0, bottom: y0, right: x1, top: y1 }, uprightMatrix(geom));
      out.set(key, { ok: true, geom, emb });
    } catch {
      out.set(key, { ok: false, reason: "The source plan page could not be read." });
    }
  }
  return out;
}

// ── device / pull-label plans ──────────────────────────────────────────────

interface Marker { dev: InstallDevice; x: number; y: number }

/** Lay the plan (or the not-available frame) into a box; returns the placement used for markers. */
function drawPlan(c: Ctx, plan: LoadedPlan | undefined, sheetKey: string, area: { x: number; y: number; w: number; h: number }): Placement {
  const { f } = c;
  if (plan?.ok) {
    const pl = fitPlacement(plan.geom.width, plan.geom.height, area);
    f.page.drawPage(plan.emb, { x: pl.x, y: pl.y, xScale: pl.scale, yScale: pl.scale, opacity: 0.55 });
    box(f, pl.x, pl.y, pl.width, pl.height, { stroke: INK.rule, width: 0.5 });
    return pl;
  }
  const pl = fitPlacement(1.5, 1, area);
  box(f, pl.x, pl.y, pl.width, pl.height, { fill: INK.lighter, stroke: INK.red, width: 1, dash: [6, 4] });
  text(f, "PLAN NOT AVAILABLE", pl.x, pl.y + pl.height - 30, { font: f.bold, size: 16, color: INK.red, align: "center", width: pl.width });
  const why = plan && !plan.ok ? plan.reason : "The source plan page is not available.";
  text(f, `${why} Sheet ${sheetKey}: device positions are shown schematically from the takeoff; locate them from the plan set.`, pl.x + 10, pl.y + pl.height - 44, { size: 8, color: INK.text, align: "center", width: pl.width - 20 });
  return pl;
}

/** Markers drawn and their label boxes placed clear of each other; returns the placed labels to draw. */
function placeMarkerLabels<T>(markers: Marker[], items: { w: number; h: number; data: T }[], bounds: Rect, markerR: number) {
  const obstacles: Rect[] = markers.map((m) => rectAt(m.x, m.y, markerR * 2 + 2, markerR * 2 + 2));
  const near: LabelItem<T & { far: boolean }>[] = [];
  const order = markers.map((_, i) => i).sort((a, b) => markers[b].y - markers[a].y || markers[a].x - markers[b].x);
  for (const i of order) {
    const m = markers[i], it = items[i];
    const ring = ringCandidates(m.x, m.y, it.w, it.h, markerR + 1.5);
    near.push({ w: it.w, h: it.h, candidates: [...ring.near, ...ring.far], data: { ...it.data, far: false } });
  }
  const placed = placeLabels(near, { placed: obstacles, bounds });
  return placed.map((p) => ({ ...p, far: p.candidate >= 8 }));
}

const MARKER_R = 4.2;

function deviceMarkers(devs: InstallDevice[], pl: Placement): Marker[] {
  return devs.map((dev) => {
    const [x, y] = normToSheet(pl, dev.at);
    return { dev, x, y };
  });
}

function drawLeader(c: Ctx, m: Marker, lx: number, ly: number, w: number, h: number, color: RGB): void {
  // from the marker to the nearest point of the label box
  const px = Math.max(lx - w / 2, Math.min(m.x, lx + w / 2));
  const py = Math.max(ly - h / 2, Math.min(m.y, ly + h / 2));
  c.f.page.drawLine({ start: { x: m.x, y: m.y }, end: { x: px, y: py }, thickness: 0.4, color });
}

interface LegendRow { type: string; description: string; mfrModel: string; mounting: string; height: string; count: number }

function legendRows(devs: InstallDevice[]): LegendRow[] {
  const map = new Map<string, LegendRow>();
  for (const d of devs) {
    const mfrModel = [d.manufacturer, d.model].filter(Boolean).join(" ") || "—";
    const description = d.description + (d.ofe && !/owner|ofe/i.test(d.description) ? " (owner-furnished)" : "");
    const k = [d.deviceType, description, mfrModel, d.mounting ?? "", d.mountingHeight ?? ""].join("\u0001");
    const r = map.get(k);
    if (r) r.count++;
    else map.set(k, { type: d.deviceType, description, mfrModel, mounting: d.mounting ?? "—", height: d.mountingHeight ?? "—", count: 1 });
  }
  return [...map.values()].sort((a, b) => naturalCompare(a.type, b.type) || naturalCompare(a.description, b.description));
}

/** The device legend as table columns at a width (wide: one column per field; narrow: stacked). */
function legendTable(rows: LegendRow[], width: number): { cols: TCol[]; rows: TRow[] } {
  if (width >= 560) {
    const cols = fill([
      { header: "SYM", w: 26, align: "center" }, { header: "TYPE", w: 70 }, { header: "DESCRIPTION", w: 180 }, { header: "MANUFACTURER / MODEL", w: 150 },
      { header: "MOUNTING", w: 90 }, { header: "MOUNTING HEIGHT", w: 110 }, { header: "QTY", w: 32, align: "right" },
    ], width);
    return { cols, rows: rows.map((r) => ({ cells: ["", prettyType(r.type), r.description, r.mfrModel, r.mounting, r.height, String(r.count)] })) };
  }
  const cols = fill([{ header: "SYM", w: 24, align: "center" }, { header: "DEVICE", w: 150 }, { header: "MOUNTING", w: 92 }, { header: "QTY", w: 28, align: "right" }], width);
  return {
    cols,
    rows: rows.map((r) => ({ cells: ["", `${prettyType(r.type)}: ${r.description}\n${r.mfrModel}`, `${r.mounting}\n${r.height}`, String(r.count)] })),
  };
}

function drawLegend(c: Ctx, title: string, rows: LegendRow[], x: number, yTop: number, width: number): number {
  const { f } = c;
  let y = caption(f, title, x, yTop, width);
  const t = legendTable(rows, width);
  const st = { size: 7.5, pad: 2.5 };
  y = drawHeader(f, x, y, t.cols, st);
  t.rows.forEach((r, i) => {
    const y2 = drawRow(f, x, y, t.cols, r, i, st);
    const s = c.typeStyle(rows[i].type);
    symbol(f, s.shape, x + t.cols[0].w / 2, (y + y2) / 2, MARKER_R, s.color, { outline: INK.text, outlineWidth: 0.4 });
    y = y2;
  });
  return y;
}

/** Plan area and legend position: legend at the bottom or on the right, whichever lets the plan draw larger. */
function planLayout(top: number, aspect: number | null, legendH: (w: number) => number): { area: { x: number; y: number; w: number; h: number }; legend: { x: number; yTop: number; w: number } } {
  const h = top - DA.y;
  const bottomLegH = legendH(DA.w) + 10;
  const bottom = { area: { x: DA.x, y: DA.y + bottomLegH, w: DA.w, h: h - bottomLegH - 4 }, legend: { x: DA.x, yTop: DA.y + bottomLegH - 4, w: DA.w } };
  if (aspect == null) return bottom;
  const RW = 300;
  const rightLegH = legendH(RW);
  if (rightLegH > h - 20) return bottom;
  const right = { area: { x: DA.x, y: DA.y + 12, w: DA.w - RW - 14, h: h - 16 }, legend: { x: DA.x + DA.w - RW, yTop: top - 2, w: RW } };
  const scale = (a: { w: number; h: number }) => Math.min(a.w / aspect, a.h);
  return scale(right.area) > scale(bottom.area) * 1.04 ? right : bottom;
}

function devicePlanSheet(c: Ctx, key: string, devs: InstallDevice[], plan: LoadedPlan | undefined): () => void {
  return () => {
    const { f } = c;
    const top = sheetHeading(f, `DEVICE PLAN — ${c.sheetName(key)}`, `${plural(devs.length, "device")} on this sheet · every device marker carries its tag · symbols per the legend`, !c.approved);
    const rows = legendRows(devs);
    const aspect = plan?.ok ? plan.geom.width / plan.geom.height : null;
    const st = { size: 7.5, pad: 2.5 };
    const lay = planLayout(top, aspect, (w) => { const t = legendTable(rows, w); return 17 + tableHeight(f, t.cols, t.rows, st); });
    const pl = drawPlan(c, plan, key, lay.area);
    const markers = deviceMarkers(devs, pl);
    const size = 6.5;
    const items = markers.map((m) => ({ w: f.bold.widthOfTextAtSize(f.clean(m.dev.tag), size) + 4, h: size + 3, data: { tag: m.dev.tag } }));
    const bounds = { x0: lay.area.x, y0: lay.area.y, x1: lay.area.x + lay.area.w, y1: lay.area.y + lay.area.h };
    const placed = placeMarkerLabels(markers, items, bounds, MARKER_R);
    const byTag = new Map(markers.map((m) => [m.dev.tag, m]));
    for (const m of markers) { const s = c.typeStyle(m.dev.deviceType); symbol(f, s.shape, m.x, m.y, MARKER_R, s.color); }
    for (const p of placed) {
      const m = byTag.get(p.data.tag)!;
      const col = c.typeStyle(m.dev.deviceType).color;
      if (p.far) drawLeader(c, m, p.x, p.y, p.w, p.h, col);
      box(f, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, { fill: INK.white, stroke: col, width: 0.5, opacity: 0.92 });
      text(f, p.data.tag, p.x - p.w / 2 + 2, p.y - size * 0.36, { font: f.bold, size, color: INK.text });
    }
    drawLegend(c, "DEVICE LEGEND (this sheet)", rows, lay.legend.x, lay.legend.yTop, lay.legend.w);
  };
}

function pullLabelSheet(c: Ctx, key: string, devs: InstallDevice[], plan: LoadedPlan | undefined): () => void {
  return () => {
    const { f } = c;
    const cablesTo = new Map<string, { label: string; spare: boolean; rack: string }[]>();
    for (const r of c.rows) {
      const list = cablesTo.get(r.toDevice) ?? [];
      list.push({ label: r.label, spare: r.spare, rack: r.fromRack });
      cablesTo.set(r.toDevice, list);
    }
    const nCables = devs.reduce((a, d) => a + (cablesTo.get(d.tag)?.length ?? 0), 0);
    const top = sheetHeading(f, `PULL-LABEL PLAN — ${c.sheetName(key)}`, `${plural(nCables, "cable")} to ${plural(devs.length, "device")} · label both ends as shown · colour = the rack each home run goes to`, !c.approved);
    // the key: one row per rack the sheet's devices home-run to
    const racks = new Map<string, { devices: number; cables: number }>();
    for (const d of devs) {
      const list = cablesTo.get(d.tag) ?? [];
      const ids = new Set(list.map((x) => x.rack || d.rack || ""));
      if (!ids.size) ids.add(d.rack ?? "");
      for (const id of ids) {
        const k = racks.get(id) ?? { devices: 0, cables: 0 };
        k.devices++;
        k.cables += list.filter((x) => (x.rack || d.rack || "") === id).length;
        racks.set(id, k);
      }
    }
    const keyRows = [...racks.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || naturalCompare(a[0], b[0]));
    const keyTable = (w: number) => ({
      cols: fill([{ header: "COLOUR", w: 40, align: "center" as const }, { header: "HOME RUN", w: 260 }, { header: "DEVICES", w: 50, align: "right" as const }, { header: "CABLES", w: 50, align: "right" as const }], Math.min(w, 560)),
      rows: keyRows.map(([id, k]) => ({
        cells: ["", id ? `Home runs to ${c.rackName(id)}${c.d.racks.find((r) => r.id === id)?.location ? ` · ${c.d.racks.find((r) => r.id === id)!.location}` : ""}` : "No rack assigned (check the design)", String(k.devices), String(k.cables)],
      })),
    });
    const st = { size: 7.5, pad: 2.5 };
    const aspect = plan?.ok ? plan.geom.width / plan.geom.height : null;
    const lay = planLayout(top, aspect, (w) => { const t = keyTable(w); return 17 + tableHeight(f, t.cols, t.rows, st) + 12; });
    const pl = drawPlan(c, plan, key, lay.area);
    const markers = deviceMarkers(devs, pl);
    const size = 6.2;
    const lh = size + 1.6;
    const labelLines = (d: InstallDevice): string[] => {
      const list = (cablesTo.get(d.tag) ?? []).slice().sort((a, b) => naturalCompare(a.label, b.label));
      if (!list.length) return ["no cable"];
      const words = list.map((x) => (x.spare ? `${x.label} SP` : x.label));
      const lines: string[] = [];
      for (let i = 0; i < words.length; i += 3) lines.push(words.slice(i, i + 3).join(" "));
      return lines;
    };
    const items = markers.map((m) => {
      const lines = labelLines(m.dev);
      const w = Math.max(...lines.map((l) => f.bold.widthOfTextAtSize(f.clean(l), size))) + 4;
      return { w, h: lines.length * lh + 2, data: { tag: m.dev.tag, lines } };
    });
    const bounds = { x0: lay.area.x, y0: lay.area.y, x1: lay.area.x + lay.area.w, y1: lay.area.y + lay.area.h };
    const placed = placeMarkerLabels(markers, items, bounds, MARKER_R);
    const byTag = new Map(markers.map((m) => [m.dev.tag, m]));
    const devRack = (d: InstallDevice) => (cablesTo.get(d.tag)?.[0]?.rack || d.rack || null);
    for (const m of markers) symbol(f, c.typeStyle(m.dev.deviceType).shape, m.x, m.y, MARKER_R, c.rackColor(devRack(m.dev)));
    for (const p of placed) {
      const m = byTag.get(p.data.tag)!;
      const col = c.rackColor(devRack(m.dev));
      if (p.far) drawLeader(c, m, p.x, p.y, p.w, p.h, col);
      box(f, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, { fill: INK.white, stroke: col, width: 0.7, opacity: 0.94 });
      p.data.lines.forEach((line, i) => {
        const none = line === "no cable";
        text(f, line, p.x - p.w / 2 + 2, p.y + p.h / 2 - 1 - (i + 1) * lh + 1.9, { font: none ? f.italic : f.bold, size, color: none ? INK.muted : col });
      });
    }
    // the key
    let y = caption(f, "HOME-RUN KEY", lay.legend.x, lay.legend.yTop, lay.legend.w);
    const t = keyTable(lay.legend.w);
    y = drawHeader(f, lay.legend.x, y, t.cols, st);
    t.rows.forEach((r, i) => {
      const y2 = drawRow(f, lay.legend.x, y, t.cols, r, i, st);
      box(f, lay.legend.x + t.cols[0].w / 2 - 9, (y + y2) / 2 - 3.5, 18, 7, { fill: c.rackColor(keyRows[i][0] || null) });
      y = y2;
    });
    text(f, "Label text = cable labels at that device; \"SP\" = spare. Symbol shape = device type (see the device plan); colour = home-run rack.", lay.legend.x, y - 9, { size: 6.5, color: INK.muted, width: lay.legend.w });
  };
}

// ── pull schedule ──────────────────────────────────────────────────────────

const SCHED_COLS: TCol[] = [
  { header: "LABEL", w: 52 }, { header: "KIND", w: 44 }, { header: "CABLE TYPE", w: 96 }, { header: "FROM RACK", w: 54 },
  { header: "FROM EQUIPMENT", w: 72 }, { header: "PORT", w: 46 }, { header: "TO DEVICE", w: 66 }, { header: "TO ROOM", w: 104 },
  { header: "LENGTH FT", w: 50, align: "right" }, { header: "SPARE", w: 36, align: "center" }, { header: "NOTES", w: 270 },
];

interface SchedGroup { rack: string; room: string; rows: PullRow[] }

type SchedItem =
  | { t: "caption"; text: string }
  | { t: "header" }
  | { t: "row"; row: PullRow; i: number }
  | { t: "total"; group: SchedGroup };

function schedGroups(rows: PullRow[]): SchedGroup[] {
  const out: SchedGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.rack === r.fromRack && last.room === r.toRoom) last.rows.push(r);
    else out.push({ rack: r.fromRack, room: r.toRoom, rows: [r] });
  }
  return out;
}

function sumFt(rows: PullRow[]): { ft: number; missing: number; spares: number } {
  let ft = 0, missing = 0, spares = 0;
  for (const r of rows) {
    if (r.lengthFt == null) missing++;
    else ft += r.lengthFt;
    if (r.spare) spares++;
  }
  return { ft, missing, spares };
}

function totalsText(rows: PullRow[]): string {
  const s = sumFt(rows);
  return `${plural(rows.length, "cable")} · ${fmtFt(s.ft) || "0"} ft measured${s.missing ? ` · ${s.missing} without a measured length` : ""}${s.spares ? ` · ${plural(s.spares, "spare")}` : ""}`;
}

function schedRow(r: PullRow): TRow {
  return {
    cells: [
      { text: r.label, bold: true }, r.kind, r.cableType, r.fromRack, r.fromEquipment, r.fromPort, r.toDevice, r.toRoom,
      r.lengthFt == null ? "" : fmtFt(r.lengthFt), r.spare ? "SPARE" : "", r.notes,
    ],
    ...(r.spare ? { color: INK.muted } : {}),
  };
}

/** The schedule cut into sheets: whole items per sheet, a room's table continued with its header repeated. */
function paginateSchedule(c: Ctx, cols: TCol[], avail: number): SchedItem[][] {
  const { f } = c;
  const st = { size: 8, pad: 2.3 };
  const capH = 17, hdrH = headerHeight(f, cols, st), totH = 14;
  const pages: SchedItem[][] = [];
  let cur: SchedItem[] = [];
  let left = avail;
  const newPage = () => { if (cur.length) pages.push(cur); cur = []; left = avail; };
  for (const g of schedGroups(c.rows)) {
    const name = `${g.room || "Room not set"} — home runs to ${g.rack ? c.rackName(g.rack) : "no rack"}`;
    const hs = g.rows.map((r) => rowHeight(f, cols, schedRow(r), st));
    // keep the caption, header and two rows (or the whole small table) together
    const minH = capH + hdrH + hs.slice(0, 2).reduce((a, b) => a + b, 0) + (g.rows.length <= 2 ? totH : 0);
    if (left < minH) newPage();
    cur.push({ t: "caption", text: name }, { t: "header" });
    left -= capH + hdrH;
    g.rows.forEach((r, i) => {
      const lastRow = i === g.rows.length - 1;
      const need = hs[i] + (lastRow ? totH : 0);
      if (left < need) {
        newPage();
        cur.push({ t: "caption", text: `${name} (continued)` }, { t: "header" });
        left -= capH + hdrH;
      }
      cur.push({ t: "row", row: r, i });
      left -= hs[i];
    });
    cur.push({ t: "total", group: g });
    left -= totH + 8;
  }
  newPage();
  return pages;
}

function scheduleSheet(c: Ctx, items: SchedItem[], part: number, parts: number): () => void {
  return () => {
    const { f } = c;
    const top = sheetHeading(f, `PULL SCHEDULE${parts > 1 ? ` (${part} of ${parts})` : ""}`,
      `Grouped by destination room · stable order: rack, room, label · ${totalsText(c.rows)} in the package`, !c.approved);
    const cols = fill(SCHED_COLS, DA.w);
    const st = { size: 8, pad: 2.3 };
    let y = top;
    const onSheet: PullRow[] = [];
    for (const it of items) {
      if (it.t === "caption") {
        text(f, it.text, DA.x, y - 11, { font: f.bold, size: 9, color: INK.navy, width: DA.w });
        y -= 17;
      } else if (it.t === "header") {
        y = drawHeader(f, DA.x, y, cols, st);
      } else if (it.t === "row") {
        y = drawRow(f, DA.x, y, cols, schedRow(it.row), it.i, st);
        onSheet.push(it.row);
      } else {
        box(f, DA.x, y - 13, DA.w, 13, { fill: INK.light });
        text(f, `Total ${it.group.room || "room not set"}: ${totalsText(it.group.rows)}`, DA.x + 4, y - 9.5, { font: f.bold, size: 8, color: INK.navy, width: DA.w - 8 });
        y -= 22;
      }
    }
    // the sheet's totals and the length note, on the bottom line
    const by = DA.y + 16;
    rule(f, DA.x, by + 10, DA.x + DA.w, { color: INK.navy, thickness: 0.8 });
    text(f, `Sheet total: ${totalsText(onSheet)}`, DA.x, by, { font: f.bold, size: 8.5, color: INK.navy, width: DA.w * 0.5 });
    text(f, "Length = measured per cable (route + vertical + loops), no waste. Blank length = no measured route in the takeoff: field-measure before cutting.",
      DA.x + DA.w * 0.42, by, { size: 7, color: INK.muted, width: DA.w * 0.58, align: "right" });
  };
}

// ── rack elevations ────────────────────────────────────────────────────────

function rackEquipmentWatts(c: Ctx, rack: Rack): { tag: string; description: string; watts: number | null }[] {
  const tags: string[] = [];
  for (const it of rack.items) if (it.kind === "equipment" && !tags.includes(it.tag)) tags.push(it.tag);
  for (const e of c.d.equipment) if (e.rack === rack.id && !tags.includes(e.tag) && !rack.items.some((i) => i.tag === e.tag && i.kind !== "equipment")) tags.push(e.tag);
  return tags.map((tag) => {
    const e = c.equipment.get(tag);
    const w = e?.watts;
    return { tag, description: e ? [e.description, [e.manufacturer, e.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") : "not in the equipment list", watts: typeof w === "number" && Number.isFinite(w) ? w : null };
  });
}

function rackSheet(c: Ctx, rack: Rack): () => void {
  return () => {
    const { f } = c;
    const top = sheetHeading(f, `RACK ELEVATION — ${rack.id} ${rack.name}`, [rack.location, rack.model, `${rack.sizeRU} RU`].filter(Boolean).join(" · "), !c.approved);
    // elevation
    const avail = top - DA.y - 40;
    const ru = Math.min(17, avail / Math.max(1, rack.sizeRU));
    const railW = 20, innerW = 250;
    const x0 = DA.x + 24, base = DA.y + 24 + (avail - ru * rack.sizeRU);
    const H = ru * rack.sizeRU;
    text(f, "FRONT ELEVATION", x0, base + H + 10, { font: f.bold, size: 9, color: INK.navy, width: innerW + 2 * railW, align: "center" });
    box(f, x0, base, railW, H, { fill: INK.shade, stroke: INK.text, width: 0.8 });
    box(f, x0 + railW + innerW, base, railW, H, { fill: INK.shade, stroke: INK.text, width: 0.8 });
    box(f, x0 + railW, base, innerW, H, { stroke: INK.text, width: 0.8 });
    const nSize = Math.min(6.5, Math.max(6, ru * 0.5));
    for (let n = 1; n <= rack.sizeRU; n++) {
      const yb = base + (n - 1) * ru;
      rule(f, x0, yb, x0 + railW, { thickness: 0.3 });
      rule(f, x0 + railW + innerW, yb, x0 + 2 * railW + innerW, { thickness: 0.3 });
      rule(f, x0 + railW, yb, x0 + railW + innerW, { thickness: 0.2, color: INK.faint });
      const ny = yb + ru / 2 - nSize * 0.35;
      text(f, String(n), x0, ny, { size: nSize, color: INK.muted, align: "center", width: railW });
      text(f, String(n), x0 + railW + innerW, ny, { size: nSize, color: INK.muted, align: "center", width: railW });
    }
    box(f, x0 - 3, base - 6, innerW + 2 * railW + 6, 6, { fill: INK.text });
    for (const it of rack.items) {
      const yTop = base + Math.min(it.ruTop, rack.sizeRU + 2) * ru;
      const h = Math.max(1, it.ruHeight) * ru;
      const x = x0 + railW + 2, w = innerW - 4;
      const eq = c.equipment.get(it.tag);
      const strong = it.kind === "equipment" || it.kind === "panel";
      const fillC = it.kind === "equipment" ? INK.equipFill : it.kind === "panel" ? INK.panelFill : INK.lighter;
      box(f, x, yTop - h + 0.8, w, h - 1.6, { fill: fillC, stroke: strong ? INK.navy : INK.rule, width: strong ? 0.8 : 0.5, dash: it.kind === "blank" ? [2, 2] : undefined });
      if (it.kind === "vent") for (let k = 0; k < 9; k++) rule(f, x + w * 0.3 + k * 9, yTop - h / 2, x + w * 0.3 + k * 9 + 5, { thickness: 1.2, color: INK.rule });
      const model = eq ? [eq.manufacturer, eq.model].filter(Boolean).join(" ") : "";
      const main = strong ? it.tag : it.label || it.tag;
      const sub = strong ? (it.label || model || eq?.description || "") : "";
      const lines = h >= 18 && sub ? 2 : 1;
      const tsize = Math.min(8, Math.max(6, ru * 0.48));
      const cy = yTop - h / 2;
      if (lines === 2) {
        text(f, main, x + 5, cy + 1.2, { font: f.bold, size: tsize, color: INK.navy, width: w - 10 });
        text(f, sub, x + 5, cy - tsize + 0.2, { size: Math.max(6, tsize - 1), color: INK.text, width: w - 10 });
      } else {
        const one = sub ? `${main} · ${sub}` : main;
        text(f, one, x + 5, cy - tsize * 0.36, { font: strong ? f.bold : f.regular, size: strong ? tsize : 6, color: strong ? INK.navy : INK.muted, width: w - 10 });
      }
    }
    const used = rack.items.reduce((a, it) => a + Math.max(0, it.ruHeight), 0);
    text(f, `${used} of ${rack.sizeRU} RU used · RU 1 at the bottom`, x0, base - 17, { size: 7, color: INK.muted, width: innerW + 2 * railW, align: "center" });

    // side tables
    const tx = x0 + innerW + 2 * railW + 40, tw = DA.x + DA.w - tx;
    let y = top - 2;
    y = caption(f, "RACK CONTENTS (top down)", tx, y, tw);
    const items = rack.items.slice().sort((a, b) => b.ruTop - a.ruTop);
    const st = { size: 8, pad: 2.3 };
    const contents = fill([{ header: "RU", w: 40 }, { header: "TAG", w: 70 }, { header: "KIND", w: 60 }, { header: "DESCRIPTION", w: 230 }, { header: "MANUFACTURER / MODEL", w: 160 }], tw);
    y = drawTable(f, tx, y, contents, items.map((it) => {
      const eq = c.equipment.get(it.tag);
      const span = it.ruHeight > 1 ? `${it.ruTop}-${it.ruTop - it.ruHeight + 1}` : String(it.ruTop);
      return { cells: [span, { text: it.tag, bold: it.kind === "equipment" || it.kind === "panel" }, it.kind, it.label || eq?.description || "", eq ? [eq.manufacturer, eq.model].filter(Boolean).join(" ") : ""] };
    }), st) - 10;

    const watts = rackEquipmentWatts(c, rack);
    const known = watts.filter((w) => w.watts != null);
    const unknown = watts.filter((w) => w.watts == null);
    const total = known.reduce((a, w) => a + (w.watts as number), 0);
    const half = (tw - 16) / 2;
    const yPow = caption(f, "POWER", tx, y, half);
    const pcols = fill([{ header: "EQUIPMENT", w: 70 }, { header: "WATTS", w: 50, align: "right" }, { header: "AMPS @ 120 V", w: 60, align: "right" }], half);
    const prow: TRow[] = watts.map((w) => ({
      cells: [w.tag, w.watts == null ? { text: "unknown", color: INK.red, bold: true, align: "right" } : String(w.watts), w.watts == null ? { text: "unknown", color: INK.red, align: "right" } : (w.watts / 120).toFixed(2)],
    }));
    prow.push({ cells: [unknown.length ? "Total (known only)" : "Total", String(Math.round(total * 10) / 10), (total / 120).toFixed(2)], bold: true, fill: INK.light });
    let py = drawTable(f, tx, yPow, pcols, prow, st);
    const circuits = rack.circuits ?? [];
    const capW = circuits.reduce((a, cc) => a + cc.amps * (cc.volts ?? 120), 0);
    py -= 6;
    if (circuits.length) {
      const ccols = fill([{ header: "CIRCUIT", w: 110 }, { header: "AMPS", w: 40, align: "right" }, { header: "VOLTS", w: 40, align: "right" }, { header: "80% W", w: 50, align: "right" }], half);
      py = drawTable(f, tx, py, ccols, circuits.map((cc) => ({ cells: [cc.label, String(cc.amps), String(cc.volts ?? 120), String(Math.round(cc.amps * (cc.volts ?? 120) * 0.8))] })), st) - 4;
      const pct = (total / (capW * 0.8)) * 100;
      py = para(f, `Load: ${unknown.length ? "at least " : ""}${pct.toFixed(0)}% of 80% circuit capacity (${Math.round(total)} W of ${Math.round(capW * 0.8)} W continuous).`, tx, py, half, { size: 8, font: f.bold, color: pct > 100 ? INK.red : INK.text });
    } else {
      py = para(f, "Circuits not stated in the design: capacity cannot be checked.", tx, py, half, { size: 8, color: INK.red });
    }
    if (unknown.length) {
      py = para(f, `Unknown draw: ${unknown.map((u) => u.tag).join(", ")}. The totals above exclude ${unknown.length === 1 ? "it" : "them"} and are incomplete; get the spec-sheet watts before sizing circuits or UPS.`, tx, py - 2, half, { size: 7.5, color: INK.red });
    }

    const hx = tx + half + 16;
    let hy = caption(f, "HEAT", hx, y, half);
    const btu = total * 3.412;
    const hcols = fill([{ header: "ITEM", w: 120 }, { header: "VALUE", w: 90, align: "right" }], half);
    hy = drawTable(f, hx, hy, hcols, [
      { cells: ["Heat load (W x 3.412)", `${unknown.length ? ">= " : ""}${Math.round(btu).toLocaleString("en-US")} BTU/hr`] },
      { cells: ["From equipment watts", `${Math.round(total)} W${unknown.length ? " + unknown" : ""}`] },
      { cells: ["Fan / ventilation", rack.fanCfm != null && Number.isFinite(rack.fanCfm) ? `${rack.fanCfm} CFM` : "not stated"] },
    ], st);
    if (unknown.length) para(f, "Heat load excludes the equipment with unknown watts.", hx, hy - 2, half, { size: 7.5, color: INK.red });
  };
}

// ── signal flow ────────────────────────────────────────────────────────────

interface FlowRow { key: string; label: string; signal: string; left: Link[]; right: Link[] }
interface FlowBlock { tag: string; title: string; sub: string; group: string; groupLabel: string; rows: FlowRow[] }
interface FlowPlaced { block: FlowBlock; from: number; to: number; col: number; yTop: number; groupHeader?: string }
interface FlowPage { kind: "rack" | "room"; title: string; groups: string[]; items: FlowPlaced[] }

const FCOLS = 3;
const F_ROW = 9;
const F_HEAD = 22;
const F_GROUP = 16;
const F_LEFT = 90, F_BLOCK = 104, F_STUB = 26;

function flowBlocks(c: Ctx): { racks: FlowBlock[][]; rooms: FlowBlock[] } {
  const d = c.d;
  const groupOf = new Map<string, string>();
  const rackGroups: { id: string; tags: string[] }[] = [];
  const rackIds = d.racks.map((r) => r.id);
  for (const e of d.equipment) if (e.rack && !rackIds.includes(e.rack)) rackIds.push(e.rack);
  for (const id of rackIds) {
    const rack = d.racks.find((r) => r.id === id);
    const tags: string[] = [];
    for (const it of (rack?.items ?? []).slice().sort((a, b) => b.ruTop - a.ruTop)) if (c.equipment.has(it.tag) && !tags.includes(it.tag)) tags.push(it.tag);
    for (const e of d.equipment.filter((x) => x.rack === id).sort((a, b) => naturalCompare(a.tag, b.tag))) if (!tags.includes(e.tag)) tags.push(e.tag);
    for (const t of tags) groupOf.set(t, `rack:${id}`);
    if (tags.length) rackGroups.push({ id, tags });
  }
  const roomOf = (tag: string): string => c.devices.get(tag)?.room ?? c.equipment.get(tag)?.location ?? "Room not set";
  const fieldTags: string[] = [];
  for (const dev of d.devices) if (!groupOf.has(dev.tag) && !fieldTags.includes(dev.tag)) fieldTags.push(dev.tag);
  for (const e of d.equipment) if (!groupOf.has(e.tag) && !fieldTags.includes(e.tag)) fieldTags.push(e.tag);
  for (const t of fieldTags) groupOf.set(t, `room:${roomOf(t)}`);

  const block = (tag: string): FlowBlock => {
    const eq = c.equipment.get(tag);
    const dev = c.devices.get(tag);
    const group = groupOf.get(tag)!;
    const lmap = c.links.get(tag) ?? new Map<string, Link[]>();
    const side = (l: Link) => (groupOf.get(l.farTag) === group ? "left" : "right");
    const rows: FlowRow[] = [];
    const seen = new Set<string>();
    for (const p of eq?.ports ?? []) {
      const ls = lmap.get(p.id) ?? [];
      seen.add(p.id);
      rows.push({ key: p.id, label: p.label, signal: [p.signal, p.poe ? "PoE" : ""].filter(Boolean).join(" "), left: ls.filter((l) => side(l) === "left"), right: ls.filter((l) => side(l) === "right") });
    }
    const extra = [...lmap.keys()].filter((k) => !seen.has(k)).sort(naturalCompare);
    for (const k of extra) {
      const ls = lmap.get(k)!;
      rows.push({ key: k, label: k.startsWith("#") ? "—" : k, signal: ls[0]?.kind ?? "", left: ls.filter((l) => side(l) === "left"), right: ls.filter((l) => side(l) === "right") });
    }
    const desc = eq?.description ?? dev?.description ?? "";
    const mm = [eq?.manufacturer ?? dev?.manufacturer, eq?.model ?? dev?.model].filter(Boolean).join(" ");
    return {
      tag, group,
      groupLabel: group.startsWith("rack:") ? c.rackName(group.slice(5)) : group.slice(5),
      title: tag,
      sub: [desc, mm].filter(Boolean).join(" · ") + ((eq?.ofe ?? dev?.ofe) ? " (OFE)" : ""),
      rows,
    };
  };
  const racks = rackGroups.map((g) => g.tags.map(block));
  const rooms = fieldTags.map(block).sort((a, b) => naturalCompare(a.groupLabel, b.groupLabel) || naturalCompare(a.tag, b.tag));
  return { racks, rooms };
}

const rowUnits = (r: FlowRow) => Math.max(1, r.left.length, r.right.length);

function layoutFlow(c: Ctx, top: number): FlowPage[] {
  const { racks, rooms } = flowBlocks(c);
  const pages: FlowPage[] = [];
  const bottom = DA.y + 26;
  let page: FlowPage | null = null;
  let col = 0, y = top;
  const startPage = (kind: FlowPage["kind"], title: string) => {
    page = { kind, title, groups: [], items: [] };
    pages.push(page);
    col = 0; y = top;
  };
  const nextCol = (kind: FlowPage["kind"], title: string) => {
    col++;
    y = top;
    if (col >= FCOLS) startPage(kind, title);
  };
  const flowGroup = (kind: FlowPage["kind"], title: string, groupLabel: string, blocks: FlowBlock[]) => {
    let headerPending = true;
    for (const b of blocks) {
      const units = b.rows.length ? b.rows.map(rowUnits) : [1];
      let from = 0;
      while (from < units.length) {
        const gh = headerPending || y === top ? F_GROUP : 0;
        let room = y - bottom - gh - F_HEAD;
        let take = 0;
        while (from + take < units.length && room >= units[from + take] * F_ROW) { room -= units[from + take] * F_ROW; take++; }
        const needMin = Math.min(2, units.length - from);
        if (take < needMin && !(y === top && take > 0)) {
          if (y === top && take === 0) take = 1; // a single very tall row: draw it anyway
          else { nextCol(kind, title); continue; }
        }
        const cont = !headerPending;
        page!.items.push({ block: b, from, to: from + take, col, yTop: y, ...(gh ? { groupHeader: cont ? `${groupLabel} (continued)` : groupLabel } : {}) });
        if (!page!.groups.includes(groupLabel)) page!.groups.push(groupLabel);
        if (from === 0 && !c.flowSheetOf.has(b.tag)) c.flowSheetOf.set(b.tag, String(pages.length - 1));
        headerPending = false;
        y -= gh + F_HEAD + units.slice(from, from + take).reduce((a, u) => a + u, 0) * F_ROW + 10;
        from += take;
      }
    }
    y -= 4;
  };
  for (const blocks of racks) {
    const label = blocks[0].groupLabel;
    startPage("rack", `SIGNAL FLOW — ${label}`);
    flowGroup("rack", `SIGNAL FLOW — ${label}`, label, blocks);
  }
  if (rooms.length) {
    startPage("room", "SIGNAL FLOW — FIELD DEVICES");
    const byRoom = new Map<string, FlowBlock[]>();
    for (const b of rooms) byRoom.set(b.groupLabel, [...(byRoom.get(b.groupLabel) ?? []), b]);
    for (const [room, blocks] of byRoom) flowGroup("room", "SIGNAL FLOW — FIELD DEVICES", room, blocks);
  }
  return pages.filter((p) => p.items.length);
}

function farRef(c: Ctx, l: Link, withLoc: boolean): string {
  const sheet = c.flowSheetOf.get(l.farTag);
  const eq = c.equipment.get(l.farTag);
  const multi = (eq?.ports.length ?? 2) > 1 || !eq;
  const port = l.farPort && multi ? `:${portLabel(eq, l.farPort)}` : "";
  const dev = c.devices.get(l.farTag);
  const loc = eq?.rack ?? dev?.room ?? eq?.location ?? l.farLoc ?? "";
  return `[${sheet ?? "—"}] ${l.farTag}${port}${withLoc && loc ? ` · ${loc}` : ""}`;
}

function drawFlowPage(c: Ctx, p: FlowPage): void {
  const { f } = c;
  const colW = DA.w / FCOLS;
  const kinds = new Set<string>();
  for (const it of p.items) {
    const x0 = DA.x + it.col * colW;
    let y = it.yTop;
    if (it.groupHeader) {
      box(f, x0 + 2, y - 13, colW - 8, 13, { fill: INK.navy });
      text(f, it.groupHeader, x0 + 6, y - 9.5, { font: f.bold, size: 8, color: INK.white, width: colW - 16 });
      y -= F_GROUP;
    }
    const b = it.block;
    const bx = x0 + F_LEFT;
    const rows = b.rows.slice(it.from, it.to);
    const units = rows.map(rowUnits);
    const bodyH = (rows.length ? units.reduce((a, u) => a + u, 0) : 1) * F_ROW;
    box(f, bx, y - F_HEAD - bodyH, F_BLOCK, F_HEAD + bodyH, { fill: INK.white, stroke: INK.navy, width: 0.9 });
    box(f, bx, y - F_HEAD, F_BLOCK, F_HEAD, { fill: INK.light, stroke: INK.navy, width: 0.9 });
    text(f, b.title + (it.from > 0 ? " (cont.)" : ""), bx + 3, y - 9, { font: f.bold, size: 7.5, color: INK.navy, width: F_BLOCK - 6 });
    text(f, b.sub || " ", bx + 3, y - 18, { size: 6, color: INK.muted, width: F_BLOCK - 6 });
    let ry = y - F_HEAD;
    if (!rows.length) text(f, "no ports or connections", bx + 3, ry - 6.6, { size: 6, color: INK.muted, font: f.italic });
    rows.forEach((r, i) => {
      const h = units[i] * F_ROW;
      if (i > 0) rule(f, bx, ry, bx + F_BLOCK, { thickness: 0.25, color: INK.faint });
      const linked = r.left.length + r.right.length > 0;
      text(f, r.label, bx + 3, ry - 6.6, { size: 6, color: linked ? INK.text : INK.muted, font: linked ? f.bold : f.regular, width: F_BLOCK * 0.48 });
      text(f, r.signal, bx + F_BLOCK * 0.5, ry - 6.6, { size: 6, color: INK.muted, width: F_BLOCK * 0.5 - 3, align: "right" });
      const stub = (l: Link, k: number, side: "left" | "right") => {
        kinds.add(l.kind);
        const col = KIND_COLOR[l.kind] ?? INK.muted;
        const sy = ry - F_ROW / 2 - k * F_ROW;
        const sx0 = side === "right" ? bx + F_BLOCK : bx;
        const sx1 = side === "right" ? sx0 + F_STUB : sx0 - F_STUB;
        f.page.drawLine({ start: { x: sx0, y: sy }, end: { x: sx1, y: sy }, thickness: 1, color: col, ...(l.kind === "patch" || l.kind === "wireless" ? { dashArray: [2, 1.5] } : {}) });
        f.page.drawCircle({ x: sx1, y: sy, size: 1.2, color: col });
        // the cable label rides the stub; an unlabelled patch cord is just the dashed stub
        const lab = l.cable ?? (l.kind === "patch" ? "" : l.kind);
        if (lab) {
          const lw = Math.min(F_STUB - 2, f.bold.widthOfTextAtSize(f.clean(lab), 6));
          const mid = (sx0 + sx1) / 2;
          text(f, lab, mid - lw / 2, sy + 1.2, { font: f.bold, size: 6, color: col, width: F_STUB - 2 });
        }
        const ref = farRef(c, l, side === "right");
        if (side === "right") text(f, ref, sx1 + 3, sy - 2, { size: 6, width: colW - F_LEFT - F_BLOCK - F_STUB - 8 });
        else text(f, ref, x0 + 2, sy - 2, { size: 6, width: F_LEFT - F_STUB - 5, align: "right" });
      };
      r.right.forEach((l, k) => stub(l, k, "right"));
      r.left.forEach((l, k) => stub(l, k, "left"));
      ry -= h;
    });
  }
  // the legend on the bottom line
  let lx = DA.x;
  const ly = DA.y + 12;
  rule(f, DA.x, ly + 10, DA.x + DA.w, { color: INK.navy, thickness: 0.8 });
  text(f, "CABLE KIND:", lx, ly, { font: f.bold, size: 7, color: INK.navy });
  lx += 48;
  const present = KIND_ORDER.filter((k) => kinds.has(k) || (k !== "patch" && k !== "wireless" && c.d.cables.some((x) => x.kind === k)));
  for (const k of present) {
    f.page.drawLine({ start: { x: lx, y: ly + 2.5 }, end: { x: lx + 18, y: ly + 2.5 }, thickness: 1.6, color: KIND_COLOR[k], ...(k === "patch" || k === "wireless" ? { dashArray: [2, 1.5] } : {}) });
    lx += 21;
    lx += text(f, k === "patch" ? "patch / jumper" : k, lx, ly, { size: 7 }) + 12;
  }
  text(f, "[sheet] TAG:PORT · location = the far end, drawn on that sheet. Stub text = cable label.", lx + 6, ly, { size: 7, color: INK.muted, width: DA.x + DA.w - lx - 6, align: "right" });
}

// ── mounting details ───────────────────────────────────────────────────────

/** Inches above finished floor from text like "18 in. AFF", "8 ft", "7'-6\"", null when it states none. */
export function parseInchesAff(s: string): number | null {
  const t = s.toLowerCase();
  const ftin = /(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*-?\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?/.exec(t);
  if (ftin) return parseFloat(ftin[1]) * 12 + (ftin[2] ? parseFloat(ftin[2]) : 0);
  const inch = /(\d+(?:\.\d+)?)\s*(?:"|in\b|in\.|inch)/.exec(t);
  if (inch) return parseFloat(inch[1]);
  return null;
}

function hatch(c: Ctx, x: number, y: number, w: number, h: number, step = 5): void {
  for (let k = -h; k < w; k += step) {
    const x1 = Math.max(x, x + k), y1 = y + Math.max(0, -k);
    const x2 = Math.min(x + w, x + k + h), y2 = y + Math.min(h, w - k);
    if (x2 > x1) c.f.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.35, color: INK.muted });
  }
}

function arrow(c: Ctx, x: number, y: number, up: boolean): void {
  const s = up ? 1 : -1;
  c.f.page.drawSvgPath(`M0,0 L-2.4,${4.5 * s} L2.4,${4.5 * s} Z`, { x, y, color: INK.text, borderWidth: 0 });
}

function mountingDetail(c: Ctx, m: MountingDetail, n: number, x: number, yTop: number, w: number, h: number): void {
  const { f } = c;
  box(f, x, yTop - h, w, h, { stroke: INK.rule, width: 0.6 });
  // title bar: detail number bubble + title
  f.page.drawCircle({ x: x + 14, y: yTop - 14, size: 9, borderColor: INK.navy, borderWidth: 1 });
  text(f, String(n), x + 5, yTop - 17, { font: f.bold, size: 8.5, color: INK.navy, width: 18, align: "center" });
  text(f, m.title, x + 28, yTop - 13, { font: f.bold, size: 9.5, color: INK.navy, width: w - 36 });
  text(f, `TYPICAL · ${prettyType(m.deviceType)} · not to scale`, x + 28, yTop - 22, { size: 6.5, color: INK.muted, width: w - 36 });

  // the drawing (left part)
  const dx = x + 12, dw = Math.min(170, w * 0.5), dTop = yTop - 34, dBot = yTop - h + 30;
  const floorY = dBot + 14;
  const inches = parseInchesAff(m.heightAff);
  const ceilingMount = inches == null && /ceiling|overhead/i.test(m.heightAff + " " + m.title);
  const maxIn = Math.max(120, (inches ?? 0) + 30);
  const k = (dTop - floorY - 8) / maxIn;
  const wallX = dx + dw * 0.55, wallW = 9;
  // floor
  rule(f, dx, floorY, dx + dw, { color: INK.text, thickness: 1.3 });
  hatch(c, dx, floorY - 8, dw, 8);
  text(f, "FINISHED FLOOR", dx + 2, floorY - 16, { size: 6, color: INK.muted, font: f.bold });
  // wall section
  box(f, wallX, floorY, wallW, dTop - floorY, { fill: INK.white, stroke: INK.text, width: 0.9 });
  hatch(c, wallX, floorY, wallW, dTop - floorY, 6);
  text(f, "WALL", wallX + wallW + 3, dTop - 8, { size: 6, color: INK.muted, font: f.bold });
  let centerY: number;
  if (ceilingMount) {
    const ceilY = dTop - 6;
    rule(f, dx, ceilY, wallX, { color: INK.text, thickness: 1.1 });
    hatch(c, dx, ceilY, wallX - dx, 6);
    text(f, "CEILING", dx + 2, ceilY - 9, { size: 6, color: INK.muted, font: f.bold });
    const devX = dx + (wallX - dx) * 0.55;
    box(f, devX - 14, ceilY - 6, 28, 6, { fill: INK.equipFill, stroke: INK.navy, width: 0.9 });
    centerY = ceilY - 3;
    // dimension floor -> ceiling
    const dimX = dx + 10;
    f.page.drawLine({ start: { x: dimX, y: floorY }, end: { x: dimX, y: ceilY }, thickness: 0.5, color: INK.text });
    arrow(c, dimX, floorY, true);
    arrow(c, dimX, ceilY, false);
    para(f, m.heightAff, dimX + 5, (floorY + ceilY) / 2 + 12, wallX - dimX - 12, { size: 7, font: f.bold, maxLines: 4 });
  } else {
    const hIn = inches ?? maxIn * 0.4;
    centerY = floorY + hIn * k;
    const bw = 8, bh = 18;
    box(f, wallX - bw + 1, centerY - bh / 2, bw, bh, { fill: INK.equipFill, stroke: INK.navy, width: 0.9 });
    rule(f, wallX - bw - 1.5, centerY - bh / 2 - 2, wallX - bw - 1.5, { color: INK.navy });
    f.page.drawLine({ start: { x: wallX - bw - 1.5, y: centerY - bh / 2 - 2.5 }, end: { x: wallX - bw - 1.5, y: centerY + bh / 2 + 2.5 }, thickness: 1.4, color: INK.navy });
    // centre line and dimension
    const dimX = wallX - 34;
    f.page.drawLine({ start: { x: dimX - 4, y: centerY }, end: { x: wallX - bw - 3, y: centerY }, thickness: 0.4, color: INK.text, dashArray: [3, 1.5] });
    f.page.drawLine({ start: { x: dimX, y: floorY }, end: { x: dimX, y: centerY }, thickness: 0.5, color: INK.text });
    arrow(c, dimX, floorY, true);
    arrow(c, dimX, centerY, false);
    para(f, inches == null ? `${m.heightAff} (height as stated)` : m.heightAff, dx, Math.max(floorY + 40, (floorY + centerY) / 2 + 14), dimX - dx - 4, { size: 7, font: f.bold, maxLines: 5 });
  }
  void centerY;

  // the text (right part)
  const tx = dx + dw + 14, tw = x + w - tx - 10;
  let ty = yTop - 36;
  text(f, "MOUNTING HEIGHT", tx, ty - 7, { size: 6, color: INK.muted, font: f.bold }); ty -= 8;
  ty = para(f, m.heightAff, tx, ty, tw, { size: 8, font: f.bold, maxLines: 2 }) - 3;
  text(f, "BOX / BACKING", tx, ty - 7, { size: 6, color: INK.muted, font: f.bold }); ty -= 8;
  ty = para(f, m.box, tx, ty, tw, { size: 7.5, maxLines: 3 }) - 3;
  if (m.notes.length) {
    text(f, "NOTES", tx, ty - 7, { size: 6, color: INK.muted, font: f.bold }); ty -= 8;
    for (const [i, nn] of m.notes.entries()) {
      if (ty < yTop - h + 40) { text(f, "…", tx, ty - 8, { size: 7 }); ty -= 9; break; }
      const lines = f.wrap(nn, f.regular, 7, tw - 9);
      lines.forEach((line, j) => {
        if (ty < yTop - h + 34) return;
        ty -= 8.8;
        if (j === 0) text(f, `${i + 1}.`, tx, ty, { size: 7, font: f.bold, color: INK.navy });
        text(f, line, tx + 9, ty, { size: 7 });
      });
      ty -= 1.5;
    }
  }
  const devs = c.d.devices.filter((dd) => dd.deviceType === m.deviceType);
  const applies = devs.length ? `Applies to ${plural(devs.length, "device")}: ${devs.map((dd) => dd.tag).sort(naturalCompare).join(", ")}` : "No devices of this type in the design.";
  para(f, applies, x + 10, yTop - h + 26, w - 20, { size: 6.5, color: INK.muted, maxLines: 2 });
  if (m.basis) text(f, `Basis: ${m.basis}`, x + 10, yTop - h + 5, { size: 6.5, color: INK.muted, font: f.italic, width: w - 20 });
}

function mountingSheet(c: Ctx, details: MountingDetail[], startNo: number, part: number, parts: number): () => void {
  return () => {
    const { f } = c;
    const top = sheetHeading(f, `MOUNTING DETAILS${parts > 1 ? ` (${part} of ${parts})` : ""}`, "Typical details by device type · heights to device centre above finished floor unless noted", !c.approved);
    const cols = 3, rowsN = 2, gap = 10;
    const w = (DA.w - gap * (cols - 1)) / cols, h = (top - DA.y - gap) / rowsN;
    details.forEach((m, i) => {
      const cx = DA.x + (i % cols) * (w + gap);
      const cy = top - Math.floor(i / cols) * (h + gap);
      mountingDetail(c, m, startNo + i, cx, cy, w, h);
    });
  };
}

// ── cover ──────────────────────────────────────────────────────────────────

function coverSheet(c: Ctx, a: RenderInstallArgs, all: () => Sheet[]): () => void {
  return () => {
    const { f, d } = c;
    let y = DA.y + DA.h;
    text(f, "LOW-VOLTAGE / AV INSTALLATION DRAWINGS", DA.x, y - 10, { font: f.bold, size: 9, color: INK.muted });
    y = para(f, a.project.name, DA.x, y - 14, DA.w - 330, { font: f.bold, size: 24, color: INK.navy, maxLines: 2, leading: 1.15 });
    const meta: string[] = [];
    if (a.site?.client) meta.push(`Client: ${a.site.client}`);
    if (a.site?.address?.length) meta.push(`Site: ${a.site.address.join(", ")}`);
    meta.push(`Install design revision ${d.revision}${d.bidRevision != null ? ` · drawn from bid revision ${d.bidRevision}` : ""} · ${c.date}`);
    for (const m of meta) y = para(f, m, DA.x, y - 2, DA.w - 330, { size: 10, maxLines: 2 });

    // status box, top right
    const sw = 310, sh = 74, sx = DA.x + DA.w - sw, sy = DA.y + DA.h - sh;
    if (c.approved) {
      box(f, sx, sy, sw, sh, { fill: INK.green });
      text(f, "ISSUED FOR CONSTRUCTION", sx, sy + sh - 28, { font: f.bold, size: 17, color: INK.white, align: "center", width: sw });
      text(f, `Revision ${d.revision} · approved ${c.date}`, sx, sy + sh - 46, { size: 10, color: INK.white, align: "center", width: sw });
      text(f, "Approved by the owner for this revision", sx, sy + 10, { size: 7.5, color: INK.white, align: "center", width: sw });
    } else {
      box(f, sx, sy, sw, sh, { fill: INK.redFill, stroke: INK.red, width: 1.5 });
      text(f, "DRAFT — NOT FOR CONSTRUCTION", sx, sy + sh - 28, { font: f.bold, size: 15, color: INK.red, align: "center", width: sw });
      text(f, `Revision ${d.revision} · ${c.date} · for the owner's review`, sx, sy + sh - 46, { size: 9.5, color: INK.red, align: "center", width: sw });
      text(f, "Do not pull, terminate or mount from a draft.", sx, sy + 10, { size: 7.5, color: INK.red, align: "center", width: sw });
    }

    const colTop = Math.min(y, sy) - 18;
    const gap = 22;
    const w1 = 290, w2 = 350, w3 = DA.w - w1 - w2 - 2 * gap;
    const x1 = DA.x, x2 = x1 + w1 + gap, x3 = x2 + w2 + gap;
    const st = { size: 8, pad: 2.3 };

    // drawing index
    let y1 = caption(f, "DRAWING INDEX", x1, colTop, w1);
    const sheets = all();
    const icols = fill([{ header: "SHEET", w: 46 }, { header: "TITLE", w: 244 }], w1);
    const maxRows = Math.floor((y1 - DA.y - 30) / 11.8);
    const shown = sheets.length > maxRows ? sheets.slice(0, maxRows - 1) : sheets;
    y1 = drawTable(f, x1, y1, icols, shown.map((s) => ({ cells: [{ text: s.number, bold: true }, s.title] })), { ...st, pad: 2 });
    if (shown.length < sheets.length) text(f, `… and ${sheets.length - shown.length} more sheets (through ${sheets[sheets.length - 1].number})`, x1, y1 - 10, { size: 7.5, color: INK.muted, width: w1 });
    else text(f, `${plural(sheets.length, "sheet")} in this package.`, x1, y1 - 10, { size: 7.5, color: INK.muted, width: w1 });

    // system summary
    let y2 = caption(f, "SYSTEM SUMMARY", x2, colTop, w2);
    const byType = new Map<string, { n: number; desc: Set<string> }>();
    for (const dv of d.devices) {
      const t = byType.get(dv.deviceType) ?? { n: 0, desc: new Set<string>() };
      t.n++;
      t.desc.add(dv.description);
      byType.set(dv.deviceType, t);
    }
    const tcols = fill([{ header: "SYM", w: 26, align: "center" }, { header: "DEVICE TYPE", w: 90 }, { header: "DESCRIPTION", w: 190 }, { header: "QTY", w: 40, align: "right" }], w2);
    const types = [...byType.entries()].sort((p, q) => naturalCompare(p[0], q[0]));
    y2 = drawHeader(f, x2, y2, tcols, st);
    types.forEach(([t, v], i) => {
      const y3 = drawRow(f, x2, y2, tcols, { cells: ["", prettyType(t), [...v.desc].slice(0, 2).join("; ") + (v.desc.size > 2 ? "; ..." : ""), String(v.n)] }, i, st);
      const s = c.typeStyle(t);
      symbol(f, s.shape, x2 + tcols[0].w / 2, (y2 + y3) / 2, MARKER_R, s.color, { outline: INK.text, outlineWidth: 0.4 });
      y2 = y3;
    });
    y2 = drawRow(f, x2, y2, tcols, { cells: ["", "Total devices", "", String(d.devices.length)], bold: true, fill: INK.light }, 0, st) - 10;

    const kcols = fill([{ header: "", w: 22 }, { header: "CABLE KIND", w: 70 }, { header: "CABLES", w: 50, align: "right" }, { header: "SPARES", w: 50, align: "right" }, { header: "MEASURED FT", w: 74, align: "right" }, { header: "NO LENGTH", w: 64, align: "right" }], w2);
    y2 = drawHeader(f, x2, y2, kcols, st);
    const kinds = KIND_ORDER.filter((k) => c.rows.some((r) => r.kind === k));
    kinds.forEach((k, i) => {
      const rows = c.rows.filter((r) => r.kind === k);
      const s = sumFt(rows);
      const y3 = drawRow(f, x2, y2, kcols, { cells: ["", k, String(rows.length), String(s.spares), fmtFt(s.ft) || "0", String(s.missing)] }, i, st);
      f.page.drawLine({ start: { x: x2 + 4, y: (y2 + y3) / 2 }, end: { x: x2 + kcols[0].w - 4, y: (y2 + y3) / 2 }, thickness: 2, color: KIND_COLOR[k] });
      y2 = y3;
    });
    const all2 = sumFt(c.rows);
    y2 = drawRow(f, x2, y2, kcols, { cells: ["", "Total", String(c.rows.length), String(all2.spares), fmtFt(all2.ft) || "0", String(all2.missing)], bold: true, fill: INK.light }, 0, st) - 10;

    const rcols = fill([{ header: "RACK", w: 56 }, { header: "NAME / LOCATION", w: 170 }, { header: "SIZE", w: 60, align: "right" }, { header: "EQUIPMENT", w: 64, align: "right" }], w2);
    y2 = drawTable(f, x2, y2, rcols, d.racks.map((r) => {
      const used = r.items.reduce((p, it) => p + Math.max(0, it.ruHeight), 0);
      return { cells: [{ text: r.id, bold: true }, `${r.name} · ${r.location}`, `${used}/${r.sizeRU} RU`, String(r.items.filter((it) => it.kind === "equipment" || it.kind === "panel").length)] };
    }), st);

    // revisions, labeling, design check, general notes
    let y3 = caption(f, "REVISIONS", x3, colTop, w3);
    y3 = drawTable(f, x3, y3, fill([{ header: "REV", w: 30 }, { header: "DATE", w: 62 }, { header: "DESCRIPTION", w: 200 }], w3), revisionRows(c).map((r) => ({ cells: [r.rev, r.date, r.text] })), st) - 10;
    y3 = caption(f, "CABLE LABELING", x3, y3, w3);
    const ls = d.labelScheme;
    y3 = para(f, `${ls.description}${ls.reference ? ` (spec ${ls.reference})` : ls.source === "default" ? " (default scheme; the spec states none)" : ""}. Label both ends of every cable within 6 in. of the termination, exactly as the pull schedule prints it.`, x3, y3, w3, { size: 8 }) - 8;
    y3 = caption(f, "DESIGN CHECK", x3, y3, w3);
    const errs = d.issues.filter((i) => i.severity === "error"), warns = d.issues.filter((i) => i.severity === "warning");
    if (!d.issues.length) y3 = para(f, "No open findings at this revision.", x3, y3, w3, { size: 8, color: INK.green });
    else {
      y3 = para(f, `${plural(errs.length, "error")}, ${plural(warns.length, "warning")} at this revision:`, x3, y3, w3, { size: 8, font: f.bold, color: errs.length ? INK.red : INK.amber });
      for (const iss of d.issues.slice(0, 8)) y3 = para(f, `• ${iss.message}${iss.ref ? ` (${iss.ref})` : ""}`, x3 + 4, y3, w3 - 4, { size: 7.5, color: iss.severity === "error" ? INK.red : INK.text, maxLines: 2 });
      if (d.issues.length > 8) y3 = para(f, `... and ${d.issues.length - 8} more.`, x3 + 4, y3, w3 - 4, { size: 7.5, color: INK.muted });
    }
    y3 -= 8;
    y3 = caption(f, "GENERAL NOTES", x3, y3, w3);
    const notes = [
      "Device locations are from the takeoff on the bid plans; confirm against field conditions and the current architectural set before rough-in.",
      "Cable lengths on the pull schedule are measured per cable from the takeoff (route, vertical drops and service loops), without waste. A blank length was not measured: field-measure it.",
      "Test and certify every horizontal cable after termination; record results by cable label.",
      "Keep low-voltage cabling clear of power wiring and fixtures as the specification requires; support with listed hardware only.",
    ];
    notes.forEach((n, i) => { if (y3 > DA.y + 30) y3 = para(f, `${i + 1}. ${n}`, x3, y3, w3, { size: 7.5 }) - 2; });
  };
}

function revisionRows(c: Ctx): { rev: string; date: string; text: string }[] {
  const d = c.d;
  const rows = [{ rev: String(d.revision), date: c.date, text: c.approved ? "Issued for construction" : "Draft for owner review" }];
  if (d.created && isoDay(d.created) !== c.date) rows.push({ rev: "—", date: isoDay(d.created), text: "Install design started" });
  return rows;
}

// ── the package ────────────────────────────────────────────────────────────

const PLAN_NOTES = [
  "Device markers are placed at the takeoff count positions; the plan background is screened.",
  "Tags match the pull schedule, signal flow and labels in the field.",
  "Mounting heights per the legend and the mounting details (I-6).",
];

export async function renderInstallPackage(args: RenderInstallArgs): Promise<{ pdf: Uint8Array; sheets: InstallSheet[] }> {
  const { design: d, project, company } = args;
  const author = company.brand || company.legalName || "Install package";
  const f = await PdfFlow.create({
    title: `${project.name} — install drawings r${d.revision}`,
    author,
    subject: installApproved(d) ? "Issued for construction" : "Draft install drawings, not for construction",
    pageSize: [PAGE_W, PAGE_H],
  });
  const c = buildCtx(f, args);
  const logo = args.logo ? await f.embedImage(args.logo) : null;

  // plan sheets with devices, in sheet-name order
  const bySheet = new Map<string, InstallDevice[]>();
  for (const dv of d.devices) bySheet.set(dv.sheet, [...(bySheet.get(dv.sheet) ?? []), dv]);
  const planKeys = [...bySheet.keys()].sort((p, q) => naturalCompare(c.sheetName(p), c.sheetName(q)));
  const plans = await loadPlans(f, planKeys, args.planPage);

  const sheets: Sheet[] = [];
  sheets.push({ number: "I-0.0", title: "Cover, drawing index and system summary", draw: coverSheet(c, args, () => sheets) });
  planKeys.forEach((k, i) => {
    const plan = plans.get(k);
    sheets.push({ number: `I-1.${i + 1}`, title: `Device plan — ${c.sheetName(k)}`, scale: plan?.ok ? "Plan scaled to fit" : "Schematic", notes: PLAN_NOTES, draw: devicePlanSheet(c, k, bySheet.get(k)!, plan) });
  });
  planKeys.forEach((k, i) => {
    const plan = plans.get(k);
    sheets.push({
      number: `I-2.${i + 1}`, title: `Pull-label plan — ${c.sheetName(k)}`, scale: plan?.ok ? "Plan scaled to fit" : "Schematic",
      notes: ["Pull and label every cable shown before rough-in inspection.", "Label colour = the rack the cable home-runs to (see the key).", "Lengths and ports: pull schedule (I-3)."],
      draw: pullLabelSheet(c, k, bySheet.get(k)!, plan),
    });
  });
  if (c.rows.length) {
    const top = DA.y + DA.h - 34;
    const pages = paginateSchedule(c, fill(SCHED_COLS, DA.w), top - (DA.y + 30));
    pages.forEach((items, i) => sheets.push({
      number: `I-3.${i + 1}`, title: `Pull schedule${pages.length > 1 ? ` (${i + 1} of ${pages.length})` : ""}`,
      notes: ["One row per cable; label both ends exactly as the Label column.", "Blank length: not measured in the takeoff; field-measure before cutting.", "Spares are pulled and labelled, left coiled and unterminated unless noted."],
      draw: scheduleSheet(c, items, i + 1, pages.length),
    }));
  }
  d.racks.forEach((r, i) => sheets.push({
    number: `I-4.${i + 1}`, title: `Rack elevation — ${r.id} ${r.name}`,
    notes: ["Front elevation; RU 1 at the bottom.", "Power: amps at 120 V; load against 80% of the branch circuits.", "Heat: BTU/hr = watts x 3.412. Unknown watts are excluded and flagged."],
    draw: rackSheet(c, r),
  }));
  const flowTop = DA.y + DA.h - 34;
  const flowPages = layoutFlow(c, flowTop);
  // flowSheetOf holds page indexes: turn them into sheet numbers
  for (const [tag, idx] of c.flowSheetOf) c.flowSheetOf.set(tag, `I-5.${Number(idx) + 1}`);
  flowPages.forEach((p, i) => {
    const title = p.kind === "rack" ? p.title.replace("SIGNAL FLOW — ", "Signal flow — ") : `Signal flow — field devices: ${p.groups[0]}${p.groups.length > 1 ? ` to ${p.groups[p.groups.length - 1]}` : ""}`;
    sheets.push({
      number: `I-5.${i + 1}`, title,
      notes: ["Each connected port shows the cable label on its stub and the far end as [sheet] TAG:PORT · location.", "Dashed stubs: in-rack patch cords / jumpers.", "Unconnected ports are shown in grey."],
      draw: () => {
        sheetHeading(f, title.toUpperCase(), p.kind === "rack" ? "Rack equipment top-down, with every port; field cables to the right, in-rack patches to the left" : "Field devices grouped by room, each with its ports and the rack end of every cable", !c.approved);
        drawFlowPage(c, p);
      },
    });
  });
  const per = 6;
  const mParts = Math.ceil(d.mounting.length / per);
  for (let i = 0; i < mParts; i++) {
    const list = d.mounting.slice(i * per, (i + 1) * per);
    sheets.push({
      number: `I-6.${i + 1}`, title: `Mounting details${mParts > 1 ? ` (${i + 1} of ${mParts})` : ""}`,
      notes: ["Typical details; field conditions govern where the architect's details differ.", "Heights are to the device centre above finished floor unless noted.", "Boxes and backing by others where noted."],
      draw: mountingSheet(c, list, i * per + 1, i + 1, mParts),
    });
  }

  const title: TitleInfo = {
    company: { brand: company.brand, legalName: company.legalName, address: company.address, phone: company.phone, email: company.email, web: company.web },
    logo,
    project: project.name,
    client: args.site?.client,
    site: args.site?.address,
    approved: c.approved,
    revision: d.revision,
    date: c.date,
    revisions: revisionRows(c),
    designNote: d.bidRevision != null ? `Drawn from bid revision ${d.bidRevision}.` : "",
  };
  for (const [i, s] of sheets.entries()) {
    if (i > 0) f.newPage();
    await s.draw();
    frame(f, title, { number: s.number, title: s.title, index: i + 1, total: sheets.length, scale: s.scale, notes: s.notes });
  }
  const pdf = await f.doc.save();
  return { pdf, sheets: sheets.map((s) => ({ number: s.number, title: s.title })) };
}

