import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { classify, docxXmlToPages, extractFile, joinTextItems, sheetXmlToText } from "../src/extract.ts";
import { safeEntryPath, StoreIngest, withSuffix, type IngestLimits } from "../src/ingest.ts";
import { StoreProjects } from "../src/projects.ts";
import { FsStorage } from "../src/storage.ts";
import type { ExtractedText, ProjectFile, ProjectId, UploadRecord } from "../src/types.ts";

// ── invented fixtures ───────────────────────────────────────────────────────

async function pdf(pages: { size: [number, number]; lines: string[] }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage(p.size);
    p.lines.forEach((line, i) => page.drawText(line, { x: 40, y: p.size[1] - 60 - i * 18, size: 12, font }));
    if (p.lines.length === 0) page.drawRectangle({ x: 50, y: 50, width: 200, height: 100 });
  }
  return doc.save();
}

const ARCH_D: [number, number] = [2592, 1728];
const LETTER: [number, number] = [612, 792];

function docx(paragraphs: string[], pageBreakAfter = -1): Uint8Array {
  const body = paragraphs
    .map((t, i) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r>${i === pageBreakAfter ? '<w:r><w:br w:type="page"/></w:r>' : ""}</w:p>`)
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  });
}

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cable Schedule" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; Qty" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ),
    "xl/sharedStrings.xml": strToU8('<?xml version="1.0"?><sst><si><t>Tag</t></si><si><t>Cable</t></si><si><t>D-12</t></si><si><r><t>CAT6</t></r><r><t xml:space="preserve"> plenum</t></r></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8(
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c><c r="D2"><v>42</v></c></row></sheetData></worksheet>',
    ),
    "xl/worksheets/sheet2.xml": strToU8('<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Drops &lt;total&gt;</t></is></c></row></sheetData></worksheet>'),
  });
}

interface Fixtures {
  plan: Uint8Array;
  spec: Uint8Array;
  pws: Uint8Array;
  sf1449: Uint8Array;
  scan: Uint8Array;
  t101: Uint8Array;
  bidZip: Uint8Array;
}

async function makeFixtures(): Promise<Fixtures> {
  const plan = await pdf([{ size: ARCH_D, lines: ["E-101 TELECOM PLAN", "FIRST FLOOR - STRUCTURED CABLING", "PROVIDE (2) CAT6 DATA DROPS AT EACH WORKSTATION"] }, { size: ARCH_D, lines: ["E-102 TELECOM PLAN SECOND FLOOR", "TELECOMMUNICATIONS ROOM 201"] }]);
  const spec = await pdf([
    { size: LETTER, lines: ["SECTION 27 10 00", "STRUCTURED CABLING", "PART 1 - GENERAL", "1.1 SUMMARY"] },
    { size: LETTER, lines: ["PART 2 - PRODUCTS", "2.1 CATEGORY 6 UTP CABLE, PLENUM RATED (CMP)", "Horizontal cable shall be Category 6 plenum."] },
  ]);
  const pws = await pdf([{ size: LETTER, lines: ["PERFORMANCE WORK STATEMENT", "Telecommunications infrastructure upgrade", "The contractor shall furnish and install Category 6 cabling."] }]);
  const sf1449 = await pdf([{ size: LETTER, lines: ["SOLICITATION/CONTRACT/ORDER FOR COMMERCIAL PRODUCTS", "STANDARD FORM 1449 (REV. 11/2021)", "52.204-7 System for Award Management"] }]);
  const scan = await pdf([{ size: LETTER, lines: [] }, { size: LETTER, lines: [] }]);
  const t101 = await pdf([{ size: LETTER, lines: ["T1.01 TELECOM RISER DIAGRAM"] }]);
  const deeper = zipSync({ "notes.txt": strToU8("Deeper notes: fiber backbone 12-strand OM4") });
  const inner = zipSync({ "T1.01.pdf": t101, "Deeper.zip": [deeper, { level: 0 }] });
  const bomb = new Uint8Array(5 * 1024 * 1024); // zeros: ~1000:1
  const files: Zippable = {
    "Drawings/": new Uint8Array(0),
    "Drawings/E-101.pdf": plan,
    "Drawings/.DS_Store": strToU8("junk"),
    "__MACOSX/Drawings/._E-101.pdf": strToU8("apple double"),
    "Specs/Volume 2.pdf": spec,
    "Attachment 1.pdf": pws,
    "Attachment 2.pdf": sf1449,
    "Scan.pdf": scan,
    "Broken.pdf": strToU8("%PDF-1.7\nthis is not really a pdf"),
    "Bid/Inner.zip": [inner, { level: 0 }],
    "Cable Schedule.xlsx": xlsx(),
    "Narrative.docx": docx(["Scope narrative: install Category 6 horizontal cabling", "Second paragraph & more", "Page two text"], 1),
    "takeoff.csv": strToU8("tag,qty\nD-12,24\n"),
    "empty.txt": new Uint8Array(0),
    "Thumbs.db": strToU8("junk"),
    "../evil.txt": strToU8("escaped"),
    "/abs.txt": strToU8("absolute"),
    "..\\evil2.txt": strToU8("backslash traversal"),
    "C:/Windows/evil3.txt": strToU8("drive letter"),
    "zeros.bin": [bomb, { level: 9 }],
    "outputs/report.txt": strToU8("an original that happens to sit in outputs/"),
  };
  return { plan, spec, pws, sf1449, scan, t101, bidZip: zipSync(files) };
}

// ── harness ─────────────────────────────────────────────────────────────────

let root: string;
let storage: FsStorage;
let projects: StoreProjects;
let fx: Fixtures;

async function addUpload(project: ProjectId, uploadId: string, name: string, bytes: Uint8Array | null): Promise<void> {
  if (bytes) await storage.put(`projects/${project}/uploads/${uploadId}/${name}`, bytes);
  await projects.update(project, (m) => {
    m.uploads.push({ uploadId, name, size: bytes?.length ?? 0, status: "received", added: new Date().toISOString(), files: [], skipped: [] });
  });
}

function ingestFor(limits?: Partial<IngestLimits>): StoreIngest {
  return new StoreIngest({ storage, projects, tmpDir: path.join(root, "..", path.basename(root) + "-tmp"), limits });
}

async function fileOf(project: ProjectId, p: string): Promise<ProjectFile | undefined> {
  return (await projects.get(project))!.files.find((f) => f.path === p);
}

async function textOf(project: ProjectId, p: string): Promise<ExtractedText | null> {
  const b = await storage.getBytes(`projects/${project}/text/${p}.json`);
  return b ? (JSON.parse(Buffer.from(b).toString()) as ExtractedText) : null;
}

async function walkAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brink-ingest-"));
  storage = new FsStorage(path.join(root, "store"));
  projects = new StoreProjects(storage);
  fx = await makeFixtures();
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(path.join(root, "..", path.basename(root) + "-tmp"), { recursive: true, force: true });
});

// ── tests ───────────────────────────────────────────────────────────────────

describe("StoreIngest: a bid package zip", () => {
  let rec: UploadRecord;
  const ingest = () => ingestFor();
  const P = "bid";

  before(async () => {
    await projects.create({ name: "Bid", id: P });
    await addUpload(P, "u1", "Bid Package.zip", fx.bidZip);
    rec = await ingest().process(P, "u1");
  });

  test("record is done and lists the unpacked files", async () => {
    assert.equal(rec.status, "done", rec.error);
    assert.deepEqual([...rec.files].sort(), [
      "Attachment 1.pdf",
      "Attachment 2.pdf",
      "Bid/Inner/Deeper/notes.txt",
      "Bid/Inner/T1.01.pdf",
      "Broken.pdf",
      "Cable Schedule.xlsx",
      "Drawings/E-101.pdf",
      "Narrative.docx",
      "Scan.pdf",
      "Specs/Volume 2.pdf",
      "outputs (original)/report.txt",
      "takeoff.csv",
    ]);
    const saved = (await projects.get(P))!.uploads[0];
    assert.equal(saved.status, "done");
    assert.deepEqual(saved.files, rec.files);
  });

  test("junk, unsafe names, empty files and the bomb are skipped with reasons", () => {
    const reason = (n: string) => rec.skipped.find((s) => s.name === `Bid Package.zip/${n}`)?.reason ?? "";
    assert.match(reason("../evil.txt"), /unsafe path \(\.\. traversal\)/);
    assert.match(reason("/abs.txt"), /unsafe path \(absolute\)/);
    assert.match(reason("../evil2.txt"), /unsafe path/);
    assert.match(reason("C:/Windows/evil3.txt"), /unsafe path \(absolute\)/);
    assert.match(reason("Drawings/.DS_Store"), /junk/);
    assert.match(reason("__MACOSX/Drawings/._E-101.pdf"), /junk/);
    assert.match(reason("Thumbs.db"), /junk/);
    assert.match(reason("empty.txt"), /empty/);
    assert.match(reason("zeros.bin"), /compression ratio \d+:1 exceeds 200:1/);
    assert.ok(!rec.skipped.some((s) => s.name.endsWith("Drawings/")), "directories are not listed");
  });

  test("nothing escapes the project in the store or on disk", async () => {
    const keys = (await storage.list("")).map((o) => o.key);
    assert.ok(keys.every((k) => k.startsWith(`projects/${P}/`)), keys.filter((k) => !k.startsWith(`projects/${P}/`)).join(", "));
    const all = await walkAll(root);
    assert.ok(!all.some((f) => /evil\d?\.txt$|abs\.txt$/.test(f)), "no unsafe entry was written anywhere");
    // Temp dirs are cleaned up.
    const tmp = path.join(root, "..", path.basename(root) + "-tmp");
    assert.deepEqual(await readdir(tmp), []);
  });

  test("files are classified", async () => {
    const m = (await projects.get(P))!;
    const kinds = Object.fromEntries(m.files.map((f) => [f.path, f.kind]));
    assert.equal(kinds["Drawings/E-101.pdf"], "plan");
    assert.equal(kinds["Specs/Volume 2.pdf"], "spec");
    assert.equal(kinds["Attachment 1.pdf"], "sow");
    assert.equal(kinds["Attachment 2.pdf"], "form");
    assert.equal(kinds["Bid/Inner/T1.01.pdf"], "plan");
    assert.equal(kinds["Scan.pdf"], "doc");
    assert.equal(kinds["Cable Schedule.xlsx"], "sheet");
    assert.equal(kinds["takeoff.csv"], "sheet");
    assert.equal(kinds["Narrative.docx"], "doc");
    assert.equal(kinds["Bid/Inner/Deeper/notes.txt"], "doc");
  });

  test("manifest entries carry size, type, pages, archive and text state", async () => {
    const plan = (await fileOf(P, "Drawings/E-101.pdf"))!;
    assert.equal(plan.size, fx.plan.length);
    assert.equal(plan.contentType, "application/pdf");
    assert.equal(plan.pages, 2);
    assert.equal(plan.uploadId, "u1");
    assert.equal(plan.fromArchive, "Bid Package.zip");
    assert.equal(plan.text, "ok");
    assert.ok((plan.textChars ?? 0) > 20);
    const t1 = (await fileOf(P, "Bid/Inner/T1.01.pdf"))!;
    assert.equal(t1.fromArchive, "Bid Package.zip/Bid/Inner.zip");
    const notes = (await fileOf(P, "Bid/Inner/Deeper/notes.txt"))!;
    assert.equal(notes.fromArchive, "Bid Package.zip/Bid/Inner.zip/Deeper.zip");
    const scan = (await fileOf(P, "Scan.pdf"))!;
    assert.equal(scan.text, "none");
    assert.equal(scan.pages, 2);
    assert.equal(scan.textChars, 0);
    assert.equal(await textOf(P, "Scan.pdf"), null);
    const broken = (await fileOf(P, "Broken.pdf"))!;
    assert.equal(broken.text, "error");
    assert.ok(broken.textError && broken.textError.length > 0);
    // Originals are stored byte for byte.
    assert.deepEqual(Buffer.from((await storage.getBytes(`projects/${P}/files/Drawings/E-101.pdf`))!), Buffer.from(fx.plan));
  });

  test("text is extracted page by page", async () => {
    const plan = (await textOf(P, "Drawings/E-101.pdf"))!;
    assert.equal(plan.schema, "brink.text.v1");
    assert.equal(plan.path, "Drawings/E-101.pdf");
    assert.equal(plan.pages.length, 2);
    assert.match(plan.pages[0].text, /^E-101 TELECOM PLAN\nFIRST FLOOR - STRUCTURED CABLING\n/);
    assert.match(plan.pages[1].text, /TELECOMMUNICATIONS ROOM 201/);
    const xl = (await textOf(P, "Cable Schedule.xlsx"))!;
    assert.deepEqual(xl.pages.map((p) => p.label), ["Cable Schedule", "Notes & Qty"]);
    assert.equal(xl.pages[0].text, "Tag\tCable\nD-12\t\tCAT6 plenum\t42");
    assert.equal(xl.pages[1].text, "Drops <total>");
    const dx = (await textOf(P, "Narrative.docx"))!;
    assert.equal(dx.pages.length, 2);
    assert.equal(dx.pages[0].text, "Scope narrative: install Category 6 horizontal cabling\nSecond paragraph & more");
    assert.equal(dx.pages[1].text, "Page two text");
    assert.equal((await textOf(P, "takeoff.csv"))!.pages[0].text, "tag,qty\nD-12,24\n");
  });

  test("processing again is idempotent", async () => {
    const before = (await projects.get(P))!;
    const again = await ingest().process(P, "u1");
    assert.equal(again.status, "done");
    assert.deepEqual(again.files, rec.files);
    // Force a full re-run, as after a crash mid-way.
    await projects.update(P, (m) => {
      m.uploads[0].status = "processing";
    });
    const rerun = await ingest().process(P, "u1");
    assert.equal(rerun.status, "done");
    assert.deepEqual([...rerun.files].sort(), [...rec.files].sort());
    assert.ok(!rerun.skipped.some((s) => /duplicate/.test(s.reason)), "own files are not reported as duplicates");
    const after = (await projects.get(P))!;
    assert.equal(after.files.length, before.files.length);
    assert.ok(!after.files.some((f) => / \(2\)/.test(f.path)));
  });

  test("a crash between storing a file and saving the manifest is recovered", async () => {
    // Simulate: file + text written, manifest entry lost.
    await projects.update(P, (m) => {
      m.files = m.files.filter((f) => f.path !== "Attachment 1.pdf");
      m.uploads[0].status = "processing";
    });
    const rerun = await ingest().process(P, "u1");
    assert.equal(rerun.status, "done");
    assert.ok(rerun.files.includes("Attachment 1.pdf"));
    assert.equal((await fileOf(P, "Attachment 1.pdf"))?.kind, "sow");
    assert.equal(await fileOf(P, "Attachment 1 (2).pdf"), undefined);
  });

  test("concurrent calls for one upload share one run", async () => {
    await projects.update(P, (m) => {
      m.uploads[0].status = "received";
    });
    const ing = ingest();
    const [a, b] = await Promise.all([ing.process(P, "u1"), ing.process(P, "u1")]);
    assert.deepEqual(a, b);
    assert.equal((await projects.get(P))!.files.length, rec.files.length);
  });
});

describe("StoreIngest: duplicates and collisions", () => {
  const P = "dupes";
  before(async () => {
    await projects.create({ name: "Dupes", id: P });
    await addUpload(P, "u1", "Bid Package.zip", fx.bidZip);
    assert.equal((await ingestFor().process(P, "u1")).status, "done");
  });

  test("same content at the same path is a duplicate; different content gets (2)", async () => {
    const amendment = await pdf([{ size: LETTER, lines: ["SECTION 27 10 00", "STRUCTURED CABLING", "AMENDMENT 1 REVISED"] }]);
    await addUpload(P, "u2", "Amendment 1.zip", zipSync({ "Drawings/E-101.pdf": fx.plan, "Specs/Volume 2.pdf": amendment }));
    const r2 = await ingestFor().process(P, "u2");
    assert.equal(r2.status, "done");
    assert.deepEqual(r2.files, ["Specs/Volume 2 (2).pdf"]);
    assert.deepEqual(r2.skipped, [{ name: "Amendment 1.zip/Drawings/E-101.pdf", reason: "duplicate of Drawings/E-101.pdf" }]);
    // The original is untouched; the new one sits beside it.
    assert.deepEqual(Buffer.from((await storage.getBytes(`projects/${P}/files/Specs/Volume 2.pdf`))!), Buffer.from(fx.spec));
    assert.deepEqual(Buffer.from((await storage.getBytes(`projects/${P}/files/Specs/Volume 2 (2).pdf`))!), Buffer.from(amendment));
    assert.equal((await fileOf(P, "Specs/Volume 2 (2).pdf"))?.kind, "spec");

    // The amended file again: duplicate of the (2) copy. A third version: (3).
    const third = await pdf([{ size: LETTER, lines: ["SECTION 27 10 00", "AMENDMENT 2"] }]);
    await addUpload(P, "u3", "Amendment 2.zip", zipSync({ "Specs/Volume 2.pdf": amendment, "Specs/Volume 2.pdf.bak": third }));
    const r3 = await ingestFor().process(P, "u3");
    assert.deepEqual(r3.skipped, [{ name: "Amendment 2.zip/Specs/Volume 2.pdf", reason: "duplicate of Specs/Volume 2 (2).pdf" }]);
    await addUpload(P, "u4", "Volume 2.pdf", third);
    await addUpload(P, "u5", "Specs.zip", zipSync({ "Specs/Volume 2.pdf": third }));
    assert.deepEqual((await ingestFor().process(P, "u4")).files, ["Volume 2.pdf"]);
    assert.deepEqual((await ingestFor().process(P, "u5")).files, ["Specs/Volume 2 (3).pdf"]);
  });

  test("withSuffix", () => {
    assert.equal(withSuffix("Drawings/E-101.pdf", 2), "Drawings/E-101 (2).pdf");
    assert.equal(withSuffix("README", 3), "README (3)");
    assert.equal(withSuffix("a.b/c", 2), "a.b/c (2)");
    assert.equal(withSuffix("x.tar.gz", 2), "x.tar (2).gz");
  });
});

describe("StoreIngest: limits and odd uploads", () => {
  let n = 0;
  async function fresh(): Promise<ProjectId> {
    const id = `lim-${++n}`;
    await projects.create({ name: id, id });
    return id;
  }

  test("entry limit stops unpacking and says so", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "Bid.zip", fx.bidZip);
    const r = await ingestFor({ maxEntries: 8 }).process(P, "u1");
    assert.equal(r.status, "done");
    assert.ok(r.files.length > 0 && r.files.length <= 8);
    assert.ok(r.skipped.some((s) => s.name === "Bid.zip" && /entry limit \(8\) reached/.test(s.reason)));
  });

  test("a zip claiming a huge number of entries is refused outright", async () => {
    const P = await fresh();
    const many: Zippable = {};
    for (let i = 0; i < 60; i++) many[`f${i}.txt`] = strToU8(`file ${i}`);
    await addUpload(P, "u1", "many.zip", zipSync(many));
    const r = await ingestFor({ maxEntries: 10 }).process(P, "u1");
    assert.deepEqual(r.files, []);
    assert.match(r.skipped[0].reason, /60 entries, more than the 10-entry limit/);
  });

  test("per-file and total size limits", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "Bid.zip", fx.bidZip);
    const r = await ingestFor({ maxFileBytes: fx.plan.length - 1 }).process(P, "u1");
    assert.equal(r.status, "done");
    assert.match(r.skipped.find((s) => s.name === "Bid.zip/Drawings/E-101.pdf")!.reason, /too large/);
    assert.ok(r.files.includes("takeoff.csv"));

    const P2 = await fresh();
    await addUpload(P2, "u1", "Bid.zip", fx.bidZip);
    const r2 = await ingestFor({ maxTotalBytes: fx.plan.length + 10 }).process(P2, "u1");
    assert.equal(r2.status, "done");
    assert.ok(r2.skipped.some((s) => /total uncompressed size limit/.test(s.reason)));
  });

  test("nesting deeper than the limit keeps the inner zip as a file", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "Bid.zip", fx.bidZip);
    const r = await ingestFor({ maxDepth: 2 }).process(P, "u1");
    assert.ok(r.files.includes("Bid/Inner/Deeper.zip"));
    assert.ok(!r.files.some((f) => f.includes("notes.txt")));
    assert.equal((await fileOf(P, "Bid/Inner/Deeper.zip"))?.kind, "other");
  });

  test("a loose PDF becomes one file, named by its last path segment", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "PWS Final.pdf", fx.pws);
    const r = await ingestFor().process(P, "u1");
    assert.deepEqual(r.files, ["PWS Final.pdf"]);
    const f = (await fileOf(P, "PWS Final.pdf"))!;
    assert.equal(f.kind, "sow");
    assert.equal(f.fromArchive, undefined);
    assert.equal(f.pages, 1);
  });

  test("a .zip name without zip bytes is a loose file; a broken zip is kept whole", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "Bid.zip", strToU8("not a zip at all"));
    const r = await ingestFor().process(P, "u1");
    assert.deepEqual(r.files, ["Bid.zip"]);
    assert.equal((await fileOf(P, "Bid.zip"))?.kind, "other");

    const truncated = fx.bidZip.slice(0, 2000);
    await addUpload(P, "u2", "Broken.zip", truncated);
    const r2 = await ingestFor().process(P, "u2");
    assert.equal(r2.status, "done");
    assert.deepEqual(r2.files, ["Broken.zip"]);
    assert.match(r2.skipped[0].reason, /could not open as a zip/);
  });

  test("docx/xlsx are never unpacked even though they are zips", async () => {
    const P = await fresh();
    await addUpload(P, "u1", "Statement of Work.docx", docx(["The contractor shall provide all labor."]));
    const r = await ingestFor().process(P, "u1");
    assert.deepEqual(r.files, ["Statement of Work.docx"]);
    assert.equal((await fileOf(P, "Statement of Work.docx"))?.kind, "sow");
  });

  test("missing upload record rejects; missing bytes end in status error", async () => {
    const P = await fresh();
    await assert.rejects(ingestFor().process(P, "nope"), /not found/);
    await assert.rejects(ingestFor().process(P, "../../x"), /Invalid upload id/);
    await addUpload(P, "u1", "ghost.zip", null);
    const r = await ingestFor().process(P, "u1");
    assert.equal(r.status, "error");
    assert.match(r.error!, /not found in the store/);
    assert.equal((await projects.get(P))!.uploads[0].status, "error");
  });
});

describe("classification and extraction units", () => {
  test("classify by extension, name, page size and text", () => {
    assert.equal(classify("x.xlsx"), "sheet");
    assert.equal(classify("x.CSV"), "sheet");
    assert.equal(classify("photo.JPG"), "image");
    assert.equal(classify("model.dwg"), "other");
    assert.equal(classify("readme.md"), "doc");
    assert.equal(classify("big.pdf", { maxPageDimPt: 1224 }), "plan");
    assert.equal(classify("small.pdf", { maxPageDimPt: 792 }), "doc");
    assert.equal(classify("E-101.pdf", { maxPageDimPt: 792 }), "plan");
    assert.equal(classify("Drawings/T1.01 Riser.pdf"), "plan");
    assert.equal(classify("ET-201.pdf"), "plan");
    assert.equal(classify("FA4690-26-Q-0012 SOW.pdf"), "sow");
    assert.equal(classify("PWS_rev2.pdf"), "sow");
    assert.equal(classify("SF1449.pdf"), "form");
    assert.equal(classify("Wage Determination SD20260001.pdf"), "form");
    assert.equal(classify("Project Manual Vol 1.pdf"), "spec");
    assert.equal(classify("Div 27 Specifications.pdf"), "spec");
    assert.equal(classify("Attachment.pdf", { firstText: "SECTION 271500 COMMUNICATIONS HORIZONTAL CABLING" }), "spec");
    assert.equal(classify("Attachment.pdf", { firstText: "DIVISION 27 - COMMUNICATIONS\nPART 1 – GENERAL" }), "spec");
    assert.equal(classify("Attachment.pdf", { firstText: "STATEMENT OF WORK\nCabling" }), "sow");
    assert.equal(classify("Attachment.pdf", { firstText: "This solicitation is issued as an RFQ" }), "sow");
    assert.equal(classify("Attachment.pdf", { firstText: "WAGE DETERMINATION NO. 2015-5000" }), "form");
    assert.equal(classify("Attachment.pdf", { firstText: "FAR 52.204-24 Representation Regarding..." }), "form");
    assert.equal(classify("Letter.pdf", { firstText: "Dear sir" }), "doc");
    assert.equal(classify("Statement of Work.docx", { firstText: "" }), "sow");
  });

  test("safeEntryPath", () => {
    assert.deepEqual(safeEntryPath("./a//b/c.pdf"), { path: "a/b/c.pdf" });
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "c:x", "a/\u0001", "", "./"]) assert.ok("reason" in safeEntryPath(bad), bad);
  });

  test("text joining, docx and sheet XML", () => {
    const items = [
      { str: "E-101", transform: [1, 0, 0, 1, 10, 700], height: 12, width: 30 },
      { str: "TELECOM", transform: [1, 0, 0, 1, 50, 700], height: 12, width: 50 },
      { str: "PLAN", transform: [1, 0, 0, 1, 110, 700.5], height: 12, width: 30, hasEOL: true },
      { str: "NOTES", transform: [1, 0, 0, 1, 10, 680], height: 12, width: 30 },
    ];
    assert.equal(joinTextItems(items, 1000), "E-101 TELECOM PLAN\nNOTES");
    assert.equal(joinTextItems(items, 8), "E-101 TE");
    assert.deepEqual(docxXmlToPages("<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t></w:r></w:p><w:p><w:r><w:t>D</w:t></w:r></w:p>"), [{ n: 1, text: "A&B\tC\nD" }]);
    assert.equal(sheetXmlToText('<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>', [], 1000).split("\t").length <= 52, true);
  });

  test("plain text is capped; extraction never throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brink-extract-"));
    try {
      await writeFile(path.join(dir, "big.txt"), "x".repeat(5000));
      const r = await extractFile(path.join(dir, "big.txt"), "big.txt", { maxPageChars: 1000 });
      assert.equal(r.pages[0].text.length, 1000);
      await writeFile(path.join(dir, "bad.docx"), "not a zip");
      const bad = await extractFile(path.join(dir, "bad.docx"), "bad.docx");
      assert.equal(bad.status, "error");
      const none = await extractFile(path.join(dir, "big.txt"), "photo.png");
      assert.equal(none.status, "none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
