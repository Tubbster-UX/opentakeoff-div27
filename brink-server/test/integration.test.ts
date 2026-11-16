// The real modules together, no fakes: an invented bid package (a zip holding
// a nested zip, a plan sheet, a spec section and Mac junk) lands in a local
// file store the way a phone upload leaves it, is unpacked and indexed, and a
// Claude-style MCP client then searches it, opens the project, takes off,
// exports, gets download links, and a later conversation restores the work.
// Nothing here is a real drawing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FsStorage } from "../src/storage.ts";
import { StoreProjects } from "../src/projects.ts";
import { StoreIngest } from "../src/ingest.ts";
import { StoreSearch } from "../src/search.ts";
import { DiskWorkspace } from "../src/workspace.ts";
import { createMountMcp } from "../src/mcp.ts";
import type { AppDeps, Config } from "../src/types.ts";

async function pdf(w: number, h: number, lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([w, h]);
  lines.forEach((t, i) => page.drawText(t, { x: 72, y: h - 72 - i * 24, size: 18, font }));
  return doc.save();
}

type Reply = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");

test("phone upload → unpack → search → open → takeoff → export link → restore in a new conversation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-int-"));
  const storage = new FsStorage(path.join(root, "store"));
  const projects = new StoreProjects(storage);
  const config = { publicUrl: "http://127.0.0.1", port: 0, dataDir: path.join(root, "data"), storage: { kind: "fs", root: path.join(root, "store") }, ownerPasswordHash: "x", sessionSecret: "x", maxUploadBytes: 1 << 30 } as Config;
  const deps: AppDeps = {
    config, storage, projects,
    ingest: new StoreIngest({ storage, projects, tmpDir: path.join(root, "tmp") }),
    search: new StoreSearch({ storage, projects }),
    workspace: new DiskWorkspace({ storage, projects, dataDir: config.dataDir }),
  };
  const app = express();
  const mounted = createMountMcp({ syncDebounceMs: 50, autosave: { debounceMs: 20, maxWaitMs: 100 }, brink: false } as never)(app, deps, (_req, _res, next) => next());
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ name: "int", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(c);
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return r;
  };
  try {
    // the phone upload, as the upload API leaves it
    const plan = await pdf(2592, 1728, ["E-101 TELECOM PLAN - FIRST FLOOR", "INVENTED HANGAR"]);
    const spec = await pdf(612, 792, ["SECTION 27 15 00", "HORIZONTAL CABLING", "PART 2 PRODUCTS: CAT6A PLENUM CABLE"]);
    const inner = zipSync({ "E-101 Telecom Plan.pdf": plan });
    const pkg = zipSync({ "Drawings.zip": inner, "Specs/27 15 00 Horizontal Cabling.pdf": spec, "__MACOSX/._x": new Uint8Array([1]) });
    const p = await projects.create({ name: "Invented Hangar", notes: "Solicitation FA0000-00-Q-0000 (invented)" });
    await storage.put(`projects/${p.id}/uploads/u1/package.zip`, pkg);
    await projects.update(p.id, (m) => {
      m.uploads.push({ uploadId: "u1", name: "package.zip", size: pkg.length, status: "received", added: new Date().toISOString(), files: [], skipped: [] });
    });
    const rec = await deps.ingest.process(p.id, "u1");
    assert.equal(rec.status, "done", JSON.stringify(rec));
    const m = (await projects.get(p.id))!;
    const kinds = Object.fromEntries(m.files.map((f) => [f.path, f.kind]));
    const planPath = Object.keys(kinds).find((k) => k.endsWith("E-101 Telecom Plan.pdf"))!;
    assert.equal(kinds[planPath], "plan", JSON.stringify(kinds));
    assert.equal(kinds["Specs/27 15 00 Horizontal Cabling.pdf"], "spec", JSON.stringify(kinds));
    assert.ok(!m.files.some((f) => f.path.includes("__MACOSX")), "Mac junk is not a project file");

    // Claude: find the project, read the spec, take off
    const c1 = await connect();
    assert.match(text(await call(c1, "list_projects")), /Invented Hangar/);
    assert.match(text(await call(c1, "search_documents", { project: p.id, query: "CAT6A plenum" })), /27 15 00 Horizontal Cabling\.pdf/);
    const opened = JSON.parse(text(await call(c1, "open_project", { project: p.id })));
    const sheet = opened.sheets[0].sheet as string;
    await call(c1, "set_scale", { sheet, upp: 1 / 18 });
    await call(c1, "place_count", { sheet, points: [[400, 800], [700, 800], [1000, 800]], condition: "DATA-2" });
    const report = await call(c1, "export_report", { path: "report.json", project_name: "Invented Hangar" });
    assert.match(text(report), /Download links[\s\S]*fsstore:\/\/projects\/invented-hangar\/outputs\/report\.json/);
    const after = (await projects.get(p.id))!;
    assert.ok(after.files.some((f) => f.kind === "output" && /report\.json$/.test(f.path)), "the report is recorded as an output");
    assert.ok(await storage.head(`projects/${p.id}/outputs/report.json`), "and pushed to the store");

    // a later conversation, after the first one is gone and the local disk wiped
    await c1.close();
    await mounted.close();
    await rm(config.dataDir, { recursive: true, force: true });
    const mounted2App = express();
    const mounted2 = createMountMcp({ syncDebounceMs: 50, brink: false } as never)(mounted2App, deps, (_req, _res, next) => next());
    const server2 = mounted2App.listen(0);
    try {
      const c2 = new Client({ name: "int2", version: "0" });
      await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server2.address() as AddressInfo).port}/mcp`)));
      const reopened = JSON.parse(text(await call(c2, "open_project", { project: p.id })));
      assert.equal(reopened.restored?.shapes, 3, JSON.stringify(reopened));
      assert.match(text(await call(c2, "takeoff_summary")), /DATA-2/);
      await c2.close();
    } finally {
      await mounted2.close();
      await new Promise<void>((r) => server2.close(() => r()));
    }
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await mounted.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
