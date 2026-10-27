// export_report's Excel workbook (xlsx / xlsx_path): the canvas Report's
// Excel export written from an MCP session. The workbook is built by
// web/src/lib/xlsx.js (reportWorkbook for the tabs, buildXlsx for the bytes),
// the same code the canvas's Excel button runs, so what is tested here is
// that the session hands it the same inputs the Report does, that the file on
// disk is a valid package carrying exactly those cells, and the overwrite
// guard: our own earlier workbook is replaced, anything else is refused.
// Fixtures are the bundled demo plan, copied into os.tmpdir(), plus invented
// shapes; every write lands in that temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { copyFile, mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { assertWritable, XLSX_PRODUCER } from "../src/safewrite.ts";
import { UserError } from "../src/format.ts";
import { reportWorkbook, buildXlsx } from "../../web/src/lib/xlsx.js";
import { conditionTotals, sheetTotals, sheetLabelGroupedRows } from "../../web/src/lib/totals.js";
import { CSV_PROFILE, customColProfile, specColProfile, laborColProfile, rollColProfile, cableColProfile, forceIncludeGroupCol, visibleCols, floorPerimeterLf } from "../../web/src/lib/reportColumns.js";
import { shapesDetail } from "../../web/src/lib/shapesExport.js";
import { seamLfByShape } from "../../web/src/lib/rollTakeoff.js";
import { cableQtyByShape } from "../../web/src/lib/cable.js";

const DEMO = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const UPP = 1 / 36; // 1/4" = 1'-0" at render scale 2.0 — 36 px per foot
const FIXED_TABS = ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room"];

// ── a zip reader on node:zlib alone (no test dependency, and independent of
// the fflate that wrote the file): the central directory names every entry
// with its method, sizes and local-header offset.
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, "zip end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory header");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The inverse, for faking another application's save: a stored (method 0)
 * zip of these parts — enough for any zip reader, fflate's included. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStored(files: Record<string, Uint8Array>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, "utf8"), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, Buffer.from(data));
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Well-formed enough to open: one prolog, every element closed in order. */
function assertXml(xml: string, root: string) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `</${name}> closes the open element`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], "every element closed");
  assert.equal(/<([A-Za-z_][\w:.-]*)/.exec(body)?.[1], root, `root element is ${root}`);
  assert.ok(!/[<>]/.test(body.replace(/<[^<>]*>/g, "")), "no stray markup characters in text");
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** A worksheet part's cells, ref → value, read back from the XML. */
function cellsOf(xml: string): [string, string | number][] {
  return [...xml.matchAll(/<c r="([A-Z]+\d+)"( t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)]
    .map(([, ref, str, v, t]) => [ref, str ? unesc(t) : Number(v)]);
}
const colLetter = (i: number) => { let s = ""; for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s; return s; };
/** What sheetXml writes for these rows: null / undefined / "" skipped. */
function expectedCells(rows: unknown[][]): [string, string | number][] {
  const out: [string, string | number][] = [];
  rows.forEach((cells, ri) => cells.forEach((v, ci) => {
    if (v === null || v === undefined || v === "") return;
    out.push([`${colLetter(ci)}${ri + 1}`, typeof v === "number" && Number.isFinite(v) ? v : String(v)]);
  }));
  return out;
}

/** The written workbook: its tab names in workbook.xml order and every tab's cells. */
async function readWorkbook(file: string) {
  const parts = unzip(await readFile(file));
  const ct = parts.get("[Content_Types].xml")!.toString("utf8");
  const wb = parts.get("xl/workbook.xml")!.toString("utf8");
  assertXml(ct, "Types");
  assertXml(wb, "workbook");
  const tabs = [...wb.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)" r:id="rId\2"\/>/g)].map((m) => unesc(m[1]));
  const sheets = tabs.map((_, i) => {
    const xml = parts.get(`xl/worksheets/sheet${i + 1}.xml`)!.toString("utf8");
    assertXml(xml, "worksheet");
    assert.ok(ct.includes(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml"`), `content type for sheet${i + 1}`);
    return cellsOf(xml);
  });
  return { parts, ct, tabs, sheets };
}

// ── the MCP pair, with the session kept so a test can read what it holds
async function pair() {
  const session = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(session, { oneClick: false });
  await server.connect(st);
  const client = new Client({ name: "xlsx-test", version: "0.0.0" });
  await client.connect(ct);
  return { client, session };
}
interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}
const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(client, name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
  return r.data;
};
const refused = async (client: Client, name: string, args: Record<string, unknown>, re: RegExp) => {
  const r = await call(client, name, args);
  assert.equal(r.isError, true, `${name} should refuse: ${JSON.stringify(r.data)}`);
  assert.match(r.data.error, re);
};

/** The demo plan copied into a fresh temp dir, so the default workbook path
 * ("<plan dir>/<plan base> - report.xlsx") lands there too. */
async function tmpPlan() {
  const dir = await mkdtemp(path.join(tmpdir(), "ot-xlsx-"));
  const plan = path.join(dir, "sample-plan.pdf");
  await copyFile(DEMO, plan);
  return { dir, plan, book: path.join(dir, "sample-plan - report.xlsx") };
}

/** A flooring-only takeoff: two carpet rooms (one labeled), a vinyl room,
 *  a base run, with waste and a materials row. */
async function flooring() {
  const { client, session } = await pair();
  const t = await tmpPlan();
  const loaded = await ok(client, "load_plan", { path: t.plan });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  const a = await ok(client, "measure_polygon", { sheet: KEY, verts: [[360, 360], [720, 360], [720, 720], [360, 720]], condition: "CPT-1" });   // 10 × 10 ft
  await ok(client, "measure_polygon", { sheet: KEY, verts: [[900, 360], [1260, 360], [1260, 540], [900, 540]], condition: "CPT-1" });         // 10 × 5 ft
  await ok(client, "measure_polygon", { sheet: KEY, verts: [[360, 900], [540, 900], [540, 1080], [360, 1080]], condition: "LVT-1" });         // 5 × 5 ft
  await ok(client, "measure_line", { sheet: KEY, pts: [[360, 1200], [1080, 1200]], condition: "RB-1" });                                       // 20 ft
  await ok(client, "edit_shape", { shape_id: a.shape_id, label: "101" });
  await ok(client, "edit_condition", { condition: "CPT-1", waste_pct: 10 });
  await ok(client, "edit_materials", { condition: "CPT-1", add: [{ name: "Adhesive", per: 50, basis: "area", unit: "gal" }] });
  const sheetNumber: string | null = loaded.sheets?.[0]?.sheet_number ?? null;
  return { client, session, ...t, sheetLabel: (k: string) => sheetNumber || k };
}

/** The canvas Report's exportXlsx inputs, assembled literally as ReportPanel.jsx
 *  does (default column prefs, no grouping, no custom columns or label
 *  vocabulary) from the session's conditions and shapes — independent of the
 *  session's own assembly, so a drift between the two fails here. Flooring
 *  only: no roll setup and no cable takeoff, so both maps are empty. */
function canvasArgs(session: Session, sheetLabel: (k: string) => string) {
  const { conditions, shapes } = session;
  const rollByCond = new Map();
  const cableTakeoff = null;
  const seamCtx = { seamByShape: seamLfByShape(rollByCond), cableByShape: cableQtyByShape(cableTakeoff) };
  const rows = (conditionTotals(conditions, shapes, seamCtx) as any[]).filter((r) => r.shape_count > 0);
  const customCols = customColProfile([]);
  const csvCols = forceIncludeGroupCol(visibleCols([...CSV_PROFILE, ...customCols, ...specColProfile(conditions), ...laborColProfile(conditions), ...rollColProfile(rollByCond), ...cableColProfile(undefined)], {}), customCols, "");
  const ctx = {
    perimByCond: floorPerimeterLf(shapes),
    attrsByCond: new Map(conditions.map((c: any) => [c.id, c.attrs])),
    specByCond: new Map(conditions.map((c: any) => [c.id, c.spec])),
    laborByCond: new Map(conditions.map((c: any) => [c.id, { laborType: c.laborType, subfloorType: c.subfloorType }])),
    rollByCond,
    cableByCond: undefined,
  };
  return { rows, bySheet: sheetTotals(conditions, shapes), shapeRows: shapesDetail(conditions, shapes, sheetLabel), cols: csvCols, ctx, sheetLabel, units: "imperial", byFloorRoom: sheetLabelGroupedRows(conditions, shapes, [], seamCtx), cable: cableTakeoff };
}

test("flooring session: xlsx: true writes the canvas workbook beside the plan — the five tabs, every cell what reportWorkbook returns for the Report's inputs", async () => {
  const { client, session, dir, book, sheetLabel } = await flooring();
  const plain = await ok(client, "export_report", {});
  assert.equal("xlsx" in plain, false, "no xlsx option → the reply is unchanged");
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".xlsx")), [], "and nothing is written");

  const r = await ok(client, "export_report", { xlsx: true });
  const { xlsx, ...doc } = r;
  assert.deepEqual(doc, plain, "the JSON reply is exactly export_report's");
  assert.deepEqual(xlsx, { path: book, tabs: FIXED_TABS });

  const expected = reportWorkbook(canvasArgs(session, sheetLabel) as any);
  assert.deepEqual(expected.map((s: any) => s.name), FIXED_TABS);
  assert.deepEqual(reportWorkbook(session.reportWorkbookArgs() as any), expected, "the session's inputs build the canvas's workbook");

  const read = await readWorkbook(book);
  assert.deepEqual(read.tabs, FIXED_TABS);
  for (const [i, s] of expected.entries()) assert.deepEqual(read.sheets[i], expectedCells(s.rows), `${s.name} tab cells`);

  // spot values in the Conditions tab, so the comparison above is not vacuous
  const conditions = expected[0].rows;
  const header = conditions[0] as string[];
  const cpt = conditions.find((row: unknown[]) => row.includes("CPT-1")) as unknown[];
  assert.equal(cpt[header.indexOf("Floor SF")], 150);
  assert.equal(cpt[header.indexOf("Total SF w/Waste")], 165);
  assert.equal(conditions.at(-1)[header.indexOf("Finish")], "TOTAL");
  const mats = expected[2].rows;
  assert.deepEqual(mats[1].slice(0, 4), ["CPT-1", "Adhesive", 3, "gal"], "150 SF measured ÷ 50 SF/gal");
  const room = expected[4].rows.find((row: unknown[]) => row[2] === "101") as unknown[];
  assert.equal(room[3], "CPT-1", "the labeled room has its own floor × room row");
});

test("the file is a valid package: [Content_Types].xml and workbook.xml parse, every part has a content type, and docProps say OpenTakeoff wrote it", async () => {
  const { client, book } = await flooring();
  await ok(client, "export_report", { xlsx: true });
  const { parts, ct } = await readWorkbook(book);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "docProps/core.xml", "docProps/app.xml"]) {
    assert.ok(parts.has(name), `missing ${name}`);
  }
  for (const name of [...parts.keys()].filter((n) => n.endsWith(".xml") && n !== "[Content_Types].xml")) {
    assert.ok(ct.includes(`PartName="/${name}"`), `content type override for ${name}`);
  }
  assertXml(parts.get("_rels/.rels")!.toString("utf8"), "Relationships");
  assertXml(parts.get("xl/_rels/workbook.xml.rels")!.toString("utf8"), "Relationships");
  const core = parts.get("docProps/core.xml")!.toString("utf8");
  const app = parts.get("docProps/app.xml")!.toString("utf8");
  assertXml(core, "cp:coreProperties");
  assertXml(app, "Properties");
  assert.ok(core.includes(`<dc:creator>${XLSX_PRODUCER}</dc:creator>`));
  assert.ok(app.includes(`<Application>${XLSX_PRODUCER}</Application>`));
  assert.ok(parts.get("_rels/.rels")!.toString("utf8").includes('Target="docProps/core.xml"'), "core properties are related from the root");
});

test("xlsx_path writes there; path and xlsx_path together write both, the JSON without the reply's xlsx block", async () => {
  const { client, dir } = await flooring();
  const json = path.join(dir, "bid", "..", "report.json");
  const xl = path.join(dir, "bid workbook.xlsx");
  const r = await ok(client, "export_report", { path: json, xlsx_path: xl });
  assert.deepEqual(r.xlsx, { path: xl, tabs: FIXED_TABS });
  const onDisk = JSON.parse(await readFile(json, "utf8"));
  const { xlsx, ...doc } = r;
  assert.deepEqual(onDisk, doc, "the JSON file is the document alone");
  assert.equal((await readWorkbook(xl)).tabs.length, 5);
  await refused(client, "export_report", { xlsx: false, xlsx_path: xl }, /xlsx: false contradicts xlsx_path/);
  await refused(client, "export_report", { path: xl, xlsx_path: xl }, /path and the workbook path are the same file/);
});

test("cable session: Cable summary and Cable runs follow the five; Pathway joins once the route condition is tagged trunk — and the re-export replaces its own workbook", async () => {
  const { client, session } = await pair();
  const { plan, book } = await tmpPlan();
  await ok(client, "load_plan", { path: plan });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  const tr = await ok(client, "place_count", { sheet: KEY, points: [[200, 200]], condition: "TR" });
  await ok(client, "edit_condition", { condition: "TR", role: "tr" });
  await ok(client, "edit_shape", { shape_id: tr.shape_ids[0], label: "MDF" });
  const dev = await ok(client, "place_count", { sheet: KEY, points: [[1000, 1000]], condition: "DATA-1" });
  await ok(client, "edit_condition", { condition: "DATA-1", waste_pct: 10, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  const rt = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 300], [3350, 300]], condition: "ROUTE" });   // 87.5 ft
  await ok(client, "edit_condition", { condition: "ROUTE", role: "route" });
  await ok(client, "link_run", { device_shape_ids: [dev.shape_ids[0]], route_shape_ids: [rt.shape_id], tr_id: tr.shape_ids[0] });

  const CABLE_TABS = [...FIXED_TABS, "Cable summary", "Cable runs"];
  const first = await ok(client, "export_report", { xlsx: true });
  assert.deepEqual(first.xlsx, { path: book, tabs: CABLE_TABS });
  const before = await stat(book);
  const expected = reportWorkbook(session.reportWorkbookArgs() as any);
  const read = await readWorkbook(book);
  assert.deepEqual(read.tabs, CABLE_TABS);
  for (const [i, s] of expected.entries()) assert.deepEqual(read.sheets[i], expectedCells(s.rows), `${s.name} tab cells`);
  // the summary tab carries the same per-condition cable LF as the report JSON's cable block
  const summary = expected[5].rows as unknown[][];
  const hdr = summary.find((row) => row[0] === "Condition") as string[];
  const data = summary.find((row) => row[0] === "DATA-1") as unknown[];
  const fromJson = first.cable.summary.find((s: any) => s.finish_tag === "DATA-1");
  assert.equal(data[hdr.indexOf("Cable LF (net)")], fromJson.cable_lf);
  assert.equal(data[hdr.indexOf("Cables")], 2);
  assert.ok((expected[6].rows as unknown[][]).some((row) => row.includes("DATA-1")), "the run is on the Cable runs tab");

  // tag the route trunk: the Pathway tab appears, and the earlier workbook
  // (ours) is replaced without overwrite
  await ok(client, "edit_condition", { condition: "ROUTE", route_kind: "trunk" });
  const second = await ok(client, "export_report", { xlsx: true });
  assert.deepEqual(second.xlsx.tabs, [...CABLE_TABS, "Pathway"]);
  const again = await readWorkbook(book);
  assert.deepEqual(again.tabs, [...CABLE_TABS, "Pathway"]);
  const pathway = reportWorkbook(session.reportWorkbookArgs() as any)[7];
  assert.deepEqual(again.sheets[7], expectedCells(pathway.rows));
  assert.ok((await stat(book)).mtimeMs >= before.mtimeMs);
});

test("never clobbers a file OpenTakeoff did not write: a stranger's file, a canvas download, a workbook saved in Excel — all refused, both files untouched; overwrite: true replaces", async () => {
  const { client, dir, book } = await flooring();
  const json = path.join(dir, "report.json");

  // a stranger's file at the default path
  const precious = Buffer.from("PK\x03\x04 the estimator's own bid workbook");
  await writeFile(book, precious);
  await refused(client, "export_report", { xlsx: true, path: json }, /already exists and is not an OpenTakeoff export/);
  assert.deepEqual(await readFile(book), precious, "the guard did not touch it");
  await assert.rejects(stat(json), "a refused workbook writes no JSON either");

  // a real workbook without our stamp (the canvas download carries none)
  await writeFile(book, await buildXlsx([{ name: "Bid", rows: [["Total", 128400]] }]));
  await refused(client, "export_report", { xlsx: true }, /not an OpenTakeoff export/);

  // ours, then opened and saved in Excel: Application rewritten, lastModifiedBy added
  const ours = Buffer.from(await buildXlsx([{ name: "Conditions", rows: [["x"]] }], { producer: XLSX_PRODUCER }));
  await writeFile(book, ours);
  await assertWritable(book, "xlsx");                                                   // still ours
  const resaved = await buildXlsx([{ name: "Conditions", rows: [["x", "priced"]] }], { producer: XLSX_PRODUCER });
  const parts = unzip(Buffer.from(resaved));
  const zipSync = zipStored;
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of parts) files[name] = new Uint8Array(data);
  files["docProps/app.xml"] = new TextEncoder().encode(new TextDecoder().decode(files["docProps/app.xml"]).replace(`<Application>${XLSX_PRODUCER}</Application>`, "<Application>Microsoft Excel</Application>"));
  files["docProps/core.xml"] = new TextEncoder().encode(new TextDecoder().decode(files["docProps/core.xml"]).replace("</cp:coreProperties>", "<cp:lastModifiedBy>Estimator</cp:lastModifiedBy></cp:coreProperties>"));
  const excel = Buffer.from(zipSync(files));
  await writeFile(book, excel);
  await assert.rejects(() => assertWritable(book, "xlsx"), (e: unknown) => e instanceof UserError);
  await refused(client, "export_report", { xlsx: true }, /not an OpenTakeoff export/);
  assert.deepEqual(await readFile(book), excel);

  // only lastModifiedBy added (Application kept) is still someone's save
  files["docProps/app.xml"] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${XLSX_PRODUCER}</Application></Properties>`);
  await writeFile(book, Buffer.from(zipSync(files)));
  await assert.rejects(() => assertWritable(book, "xlsx"), (e: unknown) => e instanceof UserError);

  // overwrite: true is the explicit instruction
  const r = await ok(client, "export_report", { xlsx: true, overwrite: true });
  assert.deepEqual(r.xlsx.tabs, FIXED_TABS);
  assert.deepEqual((await readWorkbook(book)).tabs, FIXED_TABS);
  // …and the file it wrote is recognizably ours from here on
  await ok(client, "export_report", { xlsx: true });
});

test("no plan loaded: xlsx refuses like export_report", async () => {
  const { client } = await pair();
  await refused(client, "export_report", { xlsx: true }, /No plan loaded/);
});
