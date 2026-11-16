import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { StoreProjects } from "../src/projects.ts";
import { parseQuery, StoreSearch } from "../src/search.ts";
import { FsStorage } from "../src/storage.ts";
import type { ExtractedText, FileKind, ProjectFile } from "../src/types.ts";

let root: string;
let storage: FsStorage;
let projects: StoreProjects;
const P = "srch";

/** Counts text JSON reads so the cache can be observed. */
class CountingStorage extends FsStorage {
  reads = 0;
  override async getBytes(key: string) {
    if (key.includes("/text/")) this.reads++;
    return super.getBytes(key);
  }
}

async function addText(p: string, kind: FileKind, pages: (string | { text: string; label?: string })[], extra: Partial<ProjectFile> = {}): Promise<void> {
  const doc: ExtractedText = { schema: "brink.text.v1", path: p, pages: pages.map((x, i) => (typeof x === "string" ? { n: i + 1, text: x } : { n: i + 1, ...x })) };
  await storage.put(`projects/${P}/text/${p}.json`, JSON.stringify(doc));
  await projects.update(P, (m) => {
    m.files = m.files.filter((f) => f.path !== p);
    m.files.push({ path: p, kind, size: 100, contentType: "application/pdf", added: new Date().toISOString(), text: "ok", textChars: 10, pages: pages.length, ...extra });
  });
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brink-search-"));
  storage = new CountingStorage(root);
  projects = new StoreProjects(storage);
  await projects.create({ name: "Search", id: P });
  await addText("Drawings/E-101.pdf", "plan", ["E-101 TELECOM PLAN\nPROVIDE (2) CAT6 DATA\nDROPS AT EACH WORKSTATION", "E-102 SECOND FLOOR\nWAP ON CEILING"]);
  await addText("Specs/27 10 00.pdf", "spec", ["SECTION 27 10 00\nSTRUCTURED CABLING", "2.1 CATEGORY 6 cable, plenum rated.\nCat6 patch panels. CAT6 jacks."]);
  await addText("PWS.pdf", "sow", ["PERFORMANCE WORK STATEMENT\nThe contractor shall install Cat6 data drops."]);
  await addText("Schedule.xlsx", "sheet", [{ text: "Tag\tQty\nD-12\t24 cat6", label: "Drops" }]);
  await addText("Long.txt", "doc", [`${"lorem ipsum ".repeat(100)}NEEDLE in the middle ${"dolor sit ".repeat(100)}`]);
  await projects.update(P, (m) => {
    m.files.push({ path: "Scan.pdf", kind: "plan", size: 5, contentType: "application/pdf", added: new Date().toISOString(), text: "none", textChars: 0, pages: 3 });
  });
});
after(async () => rm(root, { recursive: true, force: true }));

describe("parseQuery", () => {
  test("words and quoted phrases, lowercased, deduped", () => {
    assert.deepEqual(parseQuery('Cat6  "data   DROPS" cat6 ""'), ["cat6", "data drops"]);
    assert.deepEqual(parseQuery("   "), []);
  });
});

describe("StoreSearch.search", () => {
  const search = () => new StoreSearch({ storage, projects });

  test("case-insensitive, every word on the same page", async () => {
    const hits = await search().search(P, "cat6 WORKSTATION");
    assert.deepEqual(hits.map((h) => [h.path, h.page]), [["Drawings/E-101.pdf", 1]]);
    // Words on different pages of one file do not match.
    assert.deepEqual(await search().search(P, "E-101 ceiling"), []);
  });

  test("quoted phrases match across line breaks; unquoted words need not be adjacent", async () => {
    const phrase = await search().search(P, '"data drops"');
    assert.deepEqual(phrase.map((h) => h.path).sort(), ["Drawings/E-101.pdf", "PWS.pdf"]);
    assert.deepEqual(await search().search(P, '"drops data"'), []);
    assert.equal((await search().search(P, "drops data")).length, 2);
  });

  test("ranked by match count, then kind priority (sow, spec, form, plan, doc, sheet)", async () => {
    const hits = await search().search(P, "cat6");
    assert.deepEqual(hits.map((h) => `${h.path}#${h.page}`), [
      "Specs/27 10 00.pdf#2", // 3 matches
      "PWS.pdf#1", // 1 match, sow
      "Drawings/E-101.pdf#1", // 1 match, plan
      "Schedule.xlsx#1", // 1 match, sheet
    ]);
    assert.equal(hits[0].kind, "spec");
  });

  test("snippet is ~240 chars around the first match, whitespace collapsed", async () => {
    const [hit] = await search().search(P, "needle");
    assert.equal(hit.path, "Long.txt");
    assert.ok(hit.snippet.length <= 242, String(hit.snippet.length));
    assert.ok(hit.snippet.includes("NEEDLE in the middle"));
    assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"));
    const [plan] = await search().search(P, "workstation");
    assert.equal(plan.snippet, "E-101 TELECOM PLAN PROVIDE (2) CAT6 DATA DROPS AT EACH WORKSTATION");
  });

  test("kinds, path and limit filters; files without text are ignored", async () => {
    assert.deepEqual((await search().search(P, "cat6", { kinds: ["plan", "sheet"] })).map((h) => h.path), ["Drawings/E-101.pdf", "Schedule.xlsx"]);
    assert.deepEqual((await search().search(P, "cat6", { path: "Drawings" })).map((h) => h.path), ["Drawings/E-101.pdf"]);
    assert.deepEqual((await search().search(P, "cat6", { path: "Drawings/E-101.pdf" })).map((h) => h.path), ["Drawings/E-101.pdf"]);
    assert.deepEqual(await search().search(P, "cat6", { path: "Draw" }), []);
    assert.equal((await search().search(P, "cat6", { limit: 2 })).length, 2);
    assert.deepEqual(await search().search(P, ""), []);
    await assert.rejects(search().search("no-such-project", "x"), /not found/);
  });

  test("text JSON is cached until the manifest entry changes", async () => {
    const s = search();
    const cs = storage as CountingStorage;
    await s.search(P, "cat6");
    const reads = cs.reads;
    await s.search(P, "drops");
    assert.equal(cs.reads, reads, "second search served from cache");
    // New text for the plan, with a changed manifest entry: re-read.
    await addText("Drawings/E-101.pdf", "plan", ["E-101 REVISED\nFIBER BACKBONE"], { size: 101 });
    const hits = await s.search(P, "fiber backbone");
    assert.deepEqual(hits.map((h) => h.path), ["Drawings/E-101.pdf"]);
    assert.equal(cs.reads, reads + 1);
    assert.deepEqual(await s.search(P, "workstation"), []);
  });

  test("the cache is bounded", async () => {
    const s = new StoreSearch({ storage, projects, cacheEntries: 2 });
    const cs = storage as CountingStorage;
    await s.search(P, "cat6");
    const reads = cs.reads;
    await s.search(P, "cat6");
    assert.ok(cs.reads > reads, "with 2 entries for 5 files, some are re-read");
  });
});

describe("StoreSearch.read", () => {
  const search = () => new StoreSearch({ storage, projects });

  test("page range with page headers and the total page count", async () => {
    const r = (await search().read(P, "Specs/27 10 00.pdf", { fromPage: 2, toPage: 2 }))!;
    assert.equal(r.pages, 2);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "--- page 2 ---\n2.1 CATEGORY 6 cable, plenum rated.\nCat6 patch panels. CAT6 jacks.");
    const all = (await search().read(P, "Specs/27 10 00.pdf"))!;
    assert.match(all.text, /^--- page 1 ---\nSECTION 27 10 00[\s\S]*\n\n--- page 2 ---\n/);
    const one = (await search().read(P, "PWS.pdf"))!;
    assert.equal(one.text, "PERFORMANCE WORK STATEMENT\nThe contractor shall install Cat6 data drops.");
    assert.equal(one.pages, 1);
  });

  test("maxChars truncates and flags it", async () => {
    const r = (await search().read(P, "Long.txt", { maxChars: 50 }))!;
    assert.equal(r.text.length, 50);
    assert.equal(r.truncated, true);
    const d = (await search().read(P, "Long.txt"))!;
    assert.equal(d.truncated, false);
  });

  test("null without text; errors for unknown files and unsafe paths", async () => {
    assert.equal(await search().read(P, "Scan.pdf"), null);
    await assert.rejects(search().read(P, "Nope.pdf"), /not found/);
    await assert.rejects(search().read(P, "../srch/project.json"), /segment/);
    const r = (await search().read(P, "Specs/27 10 00.pdf", { fromPage: 5 }))!;
    assert.equal(r.text, "");
  });

  test("a single-page file reads without a page header", async () => {
    const r = (await search().read(P, "Schedule.xlsx"))!;
    assert.equal(r.text, "Tag\tQty\nD-12\t24 cat6");
  });
});
