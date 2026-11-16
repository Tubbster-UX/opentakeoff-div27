// The bid export tools over MCP (in-memory transport) on a real FsStorage +
// StoreProjects + DiskWorkspace: store a fixture bid.json, set proposal
// content, export, and check the files, the links, the sync and the names.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import ExcelJS from "exceljs";
import { BID_EXPORT_TOOL_NAMES, registerBidExportTools } from "../src/bidExportTools.ts";
import { StoreProjects } from "../src/projects.ts";
import { FsStorage } from "../src/storage.ts";
import { DiskWorkspace } from "../src/workspace.ts";
import { money } from "../src/bid/format.ts";
import type { AppDeps, Config, Ingest, Search } from "../src/types.ts";
import type { BidDraft } from "../src/bidTypes.ts";
import { approve, federalContent, fixtureBid, gcContent, tinyPng } from "./bidFixture.ts";
import { pdfText } from "./pdfText.ts";

class CountingWorkspace extends DiskWorkspace {
  syncs = 0;
  override async syncOutputs(project: string) {
    this.syncs++;
    return super.syncOutputs(project);
  }
}

let root: string;
let storage: FsStorage;
let projects: StoreProjects;
let workspace: CountingWorkspace;
let client: Client;
const P = "sample-clinic";
const NAME = "Sample Clinic Data Cabling";

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: any; text: string }> {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content.map((c) => c.text).join("");
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { isError: r.isError === true, json, text };
}

async function storeBid(bid: BidDraft) {
  await storage.put(`projects/${P}/outputs/bid/bid.json`, JSON.stringify(bid));
}

const bytesAt = async (key: string) => {
  const b = await storage.getBytes(key);
  assert.ok(b, `${key} in the store`);
  return b;
};

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brink-bidx-"));
  storage = new FsStorage(path.join(root, "store"));
  projects = new StoreProjects(storage);
  workspace = new CountingWorkspace({ storage, projects, dataDir: path.join(root, "data") });
  await projects.create({ name: NAME, id: P });
  await storage.put("system/logo.png", tinyPng(40, 16));
  const deps: AppDeps = {
    config: { publicUrl: "https://brink.test" } as Config,
    storage, projects, workspace,
    ingest: {} as Ingest,
    search: {} as Search,
  };
  const server = new McpServer({ name: "test", version: "0" });
  registerBidExportTools(server, { deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
});
after(async () => {
  await client?.close();
  await rm(root, { recursive: true, force: true });
});

describe("bid export tools", () => {
  test("registers the four tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...BID_EXPORT_TOOL_NAMES].sort());
  });

  test("exports refuse without a priced bid", async () => {
    const r = await call("export_bid_workbook", { project: P });
    assert.ok(r.isError);
    assert.match(r.text, /price_bid/);
    assert.ok((await call("export_bid_workbook", { project: "../etc" })).isError);
  });

  test("set_proposal_content validates, stores in outputs/bid and syncs", async () => {
    const bad = await call("set_proposal_content", { project: P, kind: "gc", content: { projectTitle: "x" } });
    assert.ok(bad.isError);
    assert.match(bad.text, /preparedFor/);
    const before = workspace.syncs;
    const r = await call("set_proposal_content", { project: P, kind: "gc", content: gcContent() });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.stored, "outputs/bid/proposal-gc.json");
    assert.ok(workspace.syncs > before);
    const stored = JSON.parse(Buffer.from(await bytesAt(`projects/${P}/outputs/bid/proposal-gc.json`)).toString("utf8"));
    assert.equal(stored.preparedFor.company, "Sample Builders Inc");
    const m = await projects.get(P);
    assert.ok(m!.files.some((f) => f.kind === "output" && f.path === "outputs/bid/proposal-gc.json"));

    const blank = federalContent();
    blank.complianceMatrix[1].offered = "";
    const fr = await call("set_proposal_content", { project: P, kind: "federal", content: blank });
    assert.ok(fr.isError);
    assert.match(fr.text, /row 2 \(SOW 3\.4\): offered/);
  });

  test("export_bid_workbook writes the draft workbook and returns a link", async () => {
    const bid = fixtureBid();
    await storeBid(bid);
    const before = workspace.syncs;
    const r = await call("export_bid_workbook", { project: P });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.status, "DRAFT r3 — the owner approves on the project page");
    assert.equal(r.json.files.length, 1);
    assert.equal(r.json.files[0].path, `outputs/bid/${NAME} - bid r3 DRAFT.xlsx`);
    assert.match(r.json.files[0].url, /^fsstore:\/\//);
    assert.equal(r.json.expires_in_hours, 24);
    assert.ok(workspace.syncs > before);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await bytesAt(`projects/${P}/outputs/bid/${NAME} - bid r3 DRAFT.xlsx`)) as unknown as ArrayBuffer);
    assert.match(String(wb.getWorksheet("Summary")!.getCell("A1").value), /^DRAFT — revision 3/);
    assert.equal(r.json.workbook_check, undefined);
  });

  test("export_gc_proposal renders with the logo, refuses gaps unless allow_incomplete", async () => {
    const bid = fixtureBid();
    bid.settings.company.logoKey = "system/logo.png";
    await storeBid(bid);
    const r = await call("export_gc_proposal", { project: P });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.files[0].path, `outputs/bid/${NAME} - quote r3 DRAFT.pdf`);
    const { pages } = await pdfText(await bytesAt(`projects/${P}/outputs/bid/${NAME} - quote r3 DRAFT.pdf`));
    assert.equal(pages.length, 3);
    assert.ok(pages[0].includes(money(bid.totals.baseBid)));

    await storeBid(fixtureBid({ gap: true }));
    const refused = await call("export_gc_proposal", { project: P });
    assert.ok(refused.isError);
    assert.match(refused.text, /Firestop sleeve kit/);
    const forced = await call("export_gc_proposal", { project: P, allow_incomplete: true });
    assert.ok(!forced.isError, forced.text);
    assert.match(forced.json.incomplete, /INCOMPLETE/);
  });

  test("export_federal_package needs content, then writes four files", async () => {
    await storeBid(fixtureBid());
    const none = await call("export_federal_package", { project: P });
    assert.ok(none.isError);
    assert.match(none.text, /set_proposal_content/);
    assert.ok(!(await call("set_proposal_content", { project: P, kind: "federal", content: federalContent() })).isError);
    const r = await call("export_federal_package", { project: P });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(r.json.files.map((f: { path: string }) => f.path), [
      `outputs/bid/${NAME} - cover letter r3 DRAFT.docx`,
      `outputs/bid/${NAME} - cover letter r3 DRAFT.pdf`,
      `outputs/bid/${NAME} - technical package r3 DRAFT.docx`,
      `outputs/bid/${NAME} - technical package r3 DRAFT.pdf`,
    ]);
    for (const f of r.json.files) await bytesAt(`projects/${P}/${f.path}`);
  });

  test("an approved revision drops DRAFT from the names, and exports never approve", async () => {
    await storeBid(fixtureBid());
    await call("export_gc_proposal", { project: P });
    const stillDraft = JSON.parse(Buffer.from(await bytesAt(`projects/${P}/outputs/bid/bid.json`)).toString("utf8")) as BidDraft;
    assert.equal(stillDraft.status, "draft");
    assert.equal(stillDraft.approved, undefined);

    await storeBid(approve(fixtureBid()));
    const r = await call("export_gc_proposal", { project: P });
    assert.ok(!r.isError, r.text);
    assert.equal(r.json.status, "APPROVED r3 on 2026-11-20");
    assert.equal(r.json.files[0].path, `outputs/bid/${NAME} - quote r3.pdf`);
    const { pages } = await pdfText(await bytesAt(`projects/${P}/outputs/bid/${NAME} - quote r3.pdf`));
    assert.doesNotMatch(pages.join(" "), /draft/i);
  });
});
