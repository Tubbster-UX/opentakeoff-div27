// /mcp and /mcp/brink end to end over real Streamable HTTP, with in-memory
// fakes for the AppDeps the other modules implement. The plan PDF is invented
// (pdf-lib draws a 36" x 24" sheet); nothing here is a real drawing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, copyFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMountMcp } from "../src/mcp.ts";
import { PROJECT_TOOL_NAMES } from "../src/projectTools.ts";
import type { AppDeps, Config, FileKind, ProjectFile, ProjectManifest, Projects, Search, SearchHit, Storage, Workspace } from "../src/types.ts";

// ── fakes ───────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

class FakeProjects implements Projects {
  map = new Map<string, ProjectManifest>();
  async list() { return [...this.map.values()].map((m) => structuredClone(m)); }
  async get(id: string) { const m = this.map.get(id); return m ? structuredClone(m) : null; }
  async create(input: { name: string; id?: string; notes?: string }) {
    const id = input.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
    if (this.map.has(id)) throw new Error(`project ${id} exists`);
    const m: ProjectManifest = { schema: "brink.project.v1", id, name: input.name, notes: input.notes ?? "", created: now(), updated: now(), files: [], uploads: [] };
    this.map.set(id, m);
    return structuredClone(m);
  }
  async update(id: string, fn: (m: ProjectManifest) => void | Promise<void>) {
    const m = this.map.get(id);
    if (!m) throw new Error(`no project ${id}`);
    await fn(m);
    m.updated = now();
    return structuredClone(m);
  }
}

class FakeStorage implements Storage {
  readonly label = "fake";
  presigned: string[] = [];
  async put() {}
  async getBytes() { return null; }
  async getStream() { return null; }
  async head() { return null; }
  async list() { return []; }
  async delete() {}
  async presignGet(key: string, expiresSec: number) {
    this.presigned.push(key);
    return `https://store.test/${encodeURI(key)}?expires=${expiresSec}`;
  }
  async createMultipart(): Promise<{ uploadId: string }> { throw new Error("not in this test"); }
  async presignParts(): Promise<never[]> { throw new Error("not in this test"); }
  async completeMultipart() { throw new Error("not in this test"); }
  async abortMultipart() { throw new Error("not in this test"); }
}

class FakeSearch implements Search {
  calls: unknown[] = [];
  async search(project: string, query: string, opts?: { kinds?: FileKind[]; path?: string; limit?: number }): Promise<SearchHit[]> {
    this.calls.push({ project, query, opts });
    return query.includes("CAT6A") ? [{ path: "Specs/27 15 00.pdf", kind: "spec", page: 4, snippet: "Horizontal cabling: CAT6A plenum rated ..." }] : [];
  }
  async read() { return null; }
}

/** The store is <root>/store/<project>/files|outputs; the mirror <root>/ws/<project>/files|outputs. */
class FakeWorkspace implements Workspace {
  syncCalls = 0;
  pushedLog: string[][] = [];
  private pushed = new Map<string, string>();
  constructor(readonly root: string, readonly projects: FakeProjects) {}
  dir(p: string) { return path.join(this.root, "ws", p); }
  outputsDir(p: string) { return path.join(this.dir(p), "outputs"); }
  storePath(p: string, rel: string, kind: "files" | "outputs") { return path.join(this.root, "store", p, kind, rel); }
  async ensureFile(p: string, rel: string) {
    const m = await this.projects.get(p);
    const f = m?.files.find((x) => x.path === rel);
    if (!f) throw new Error(`no file ${rel}`);
    const isOut = f.kind === "output";
    const local = path.join(this.dir(p), isOut ? "outputs" : "files", rel);
    await mkdir(path.dirname(local), { recursive: true });
    await copyFile(this.storePath(p, rel, isOut ? "outputs" : "files"), local);
    return local;
  }
  async syncOutputs(p: string) {
    this.syncCalls++;
    const m = await this.projects.get(p);
    const originals = new Set(m?.files.filter((f) => f.kind !== "output").map((f) => f.path));
    const out: string[] = [];
    for (const sub of ["files", "outputs"] as const) {
      const base = path.join(this.dir(p), sub);
      for (const abs of await walk(base)) {
        const rel = path.relative(base, abs).split(path.sep).join("/");
        if (sub === "files" && originals.has(rel)) continue;
        if (path.basename(rel).startsWith(".")) continue;
        const bytes = await readFile(abs);
        const h = sha(bytes);
        if (this.pushed.get(rel) === h) continue;
        this.pushed.set(rel, h);
        const dest = this.storePath(p, rel, "outputs");
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        await this.projects.update(p, (mm) => {
          mm.files = mm.files.filter((f) => !(f.kind === "output" && f.path === rel));
          mm.files.push({ path: rel, kind: "output", size: bytes.length, contentType: "", added: now(), text: "none" });
        });
        out.push(rel);
      }
    }
    this.pushedLog.push(out);
    return out;
  }
}

async function walk(dir: string): Promise<string[]> {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** An invented E-101: a 36" x 24" sheet with a title block, a scale note and some linework. */
async function inventedPlan(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([2592, 1728]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++) page.drawLine({ start: { x: 200 + i * 150, y: 300 }, end: { x: 200 + i * 150, y: 1400 }, thickness: 2, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 2200, y: 40, width: 360, height: 200, borderWidth: 2, borderColor: rgb(0, 0, 0) });
  page.drawText("E-101", { x: 2300, y: 80, size: 36, font });
  page.drawText("TELECOM PLAN - LEVEL 1 (INVENTED FIXTURE)", { x: 200, y: 1500, size: 24, font });
  page.drawText("SCALE: 1/8\" = 1'-0\"", { x: 200, y: 1460, size: 18, font });
  page.drawText("TR-1", { x: 400, y: 800, size: 14, font });
  return doc.save();
}

interface Harness {
  deps: AppDeps;
  projects: FakeProjects;
  workspace: FakeWorkspace;
  search: FakeSearch;
  storage: FakeStorage;
  url: string;
  close(): Promise<void>;
}

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

async function harness(opts: Parameters<typeof createMountMcp>[0]): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "brink-mcp-"));
  roots.push(root);
  const projects = new FakeProjects();
  const workspace = new FakeWorkspace(root, projects);
  const search = new FakeSearch();
  const storage = new FakeStorage();
  const config: Config = {
    publicUrl: "https://brink.test", port: 0, dataDir: path.join(root, "data"),
    storage: { kind: "fs", root: path.join(root, "store") }, ownerPasswordHash: "", sessionSecret: "", maxUploadBytes: 1e9,
  };
  const deps: AppDeps = { config, storage, projects, ingest: { process: async () => { throw new Error("not in this test"); } }, search, workspace };
  const app = express();
  const mounted = createMountMcp({ log: () => {}, ...opts })(app, deps, (_req, _res, next) => next());
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    deps, projects, workspace, search, storage, url,
    async close() {
      await mounted.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connect(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "brink-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

type Reply = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  return (await client.callTool({ name, arguments: args })) as Reply;
}
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r: Reply) => JSON.parse(r.content[0].text ?? "null");
function okReply(r: Reply, what: string): Reply {
  assert.ok(!r.isError, `${what} failed: ${text(r)}`);
  return r;
}

/** A project in the fakes with the invented plan (and a scanned spec) in its store. */
async function seedProject(h: Harness, client: Client, name: string): Promise<string> {
  const created = json(okReply(await call(client, "create_project", { name, notes: "Solicitation FA0000-00-Q-0000 (invented)\nDue 2026-12-01 14:00" }), "create_project"));
  const id = created.id as string;
  const bytes = await inventedPlan();
  for (const [rel, kind] of [["Drawings/E-101.pdf", "plan"], ["Specs/27 15 00.pdf", "spec"]] as const) {
    const dest = h.workspace.storePath(id, rel, "files");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
  await h.projects.update(id, (m) => {
    const file = (p: string, kind: FileKind): ProjectFile => ({ path: p, kind, size: bytes.length, contentType: "application/pdf", pages: 1, added: now(), text: "none", uploadId: "u1" });
    m.files.push(file("Drawings/E-101.pdf", "plan"), file("Specs/27 15 00.pdf", "spec"));
    m.uploads.push({ uploadId: "u1", name: "bid-package.zip", size: bytes.length * 2, status: "done", added: now(), files: ["Drawings/E-101.pdf", "Specs/27 15 00.pdf"], skipped: [{ name: "__MACOSX/._E-101.pdf", reason: "junk" }] });
  });
  return id;
}

const UPP_EIGHTH = 1 / 144 * 8; // 1/8" = 1'-0" at render scale 2.0: one px is 1/144 in on paper

// ── tests ───────────────────────────────────────────────────────────────────

test("/mcp: tools, project flow, export with download link, confinement, second session, /mcp/brink", async () => {
  const h = await harness({ syncDebounceMs: 50, autosave: { debounceMs: 20, maxWaitMs: 100 } });
  try {
    const { client } = await connect(`${h.url}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["load_plan", "set_scale", "measure_line", "place_count", "export_report", "export_marked_pdf", "import_takeoff", ...PROJECT_TOOL_NAMES]) {
      assert.ok(names.includes(n), `tools/list lacks ${n}`);
    }
    assert.ok(names.length >= 60 + PROJECT_TOOL_NAMES.length, `expected the OpenTakeoff tools plus ours, got ${names.length}`);
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /^OpenTakeoff: quantity takeoff/);
    assert.match(instructions, /HOSTED PROJECTS/);
    assert.match(instructions, /open_project, not load_plan/);

    const id = await seedProject(h, client, "Invented Hangar Data Cabling");
    assert.equal(id, "invented-hangar-data-cabling");

    const listed = json(okReply(await call(client, "list_projects"), "list_projects"));
    assert.equal(listed.projects[0].id, id);
    assert.equal(listed.projects[0].notes, "Solicitation FA0000-00-Q-0000 (invented)");
    assert.deepEqual(listed.projects[0].files, { plan: 1, spec: 1 });
    const info = json(okReply(await call(client, "project_info", { project: id }), "project_info"));
    assert.equal(info.files.plan[0].path, "Drawings/E-101.pdf");
    assert.equal(info.uploads[0].skipped[0].reason, "junk");
    assert.match(info.note, /no text layer/);

    // untrusted ids and paths
    assert.ok((await call(client, "project_info", { project: "../etc" })).isError);
    assert.ok((await call(client, "read_document", { project: id, path: "../../etc/passwd" })).isError);
    assert.ok((await call(client, "download_link", { project: id, path: "/etc/passwd" })).isError);
    // engine file tools need an open project, then stay inside its workspace
    assert.match(text(await call(client, "load_plan", { path: "/etc/hosts" })), /open_project first/);

    // documents
    const found = json(okReply(await call(client, "search_documents", { project: id, query: "CAT6A plenum", kinds: ["spec"] }), "search_documents"));
    assert.equal(found.hits[0].path, "Specs/27 15 00.pdf");
    assert.deepEqual(h.search.calls.at(-1), { project: id, query: "CAT6A plenum", opts: { kinds: ["spec"], path: undefined, limit: 20 } });
    assert.match(text(await call(client, "read_document", { project: id, path: "Specs/27 15 00.pdf" })), /no text layer[\s\S]*view_sheet/);
    okReply(await call(client, "set_project_notes", { project: id, notes: "Solicitation FA0000-00-Q-0000 (invented)\nSite visit 2026-11-20" }), "set_project_notes");
    assert.match((await h.projects.get(id))!.notes, /Site visit/);

    // the takeoff
    const opened = json(okReply(await call(client, "open_project", { project: id }), "open_project"));
    assert.deepEqual(opened.files, ["Drawings/E-101.pdf"]);
    assert.equal(opened.sheets[0].sheet, "E-101.pdf");
    assert.equal(opened.restored, false);
    assert.match(opened.note, /download link/);
    okReply(await call(client, "set_scale", { sheet: "E-101.pdf", upp: UPP_EIGHTH }), "set_scale");
    const line = okReply(await call(client, "measure_line", { sheet: "E-101.pdf", pts: [[400, 600], [1840, 600]], condition: "CAT6A-HOME" }), "measure_line");
    assert.ok(Math.abs((line.structuredContent!.length_lf as number) - 80) < 0.5, `1440 px at 1/8" should be 80 LF, got ${line.structuredContent!.length_lf}`);
    okReply(await call(client, "place_count", { sheet: "E-101.pdf", points: [[400, 800], [700, 800]], condition: "DATA-2" }), "place_count");

    // writing outside the project is refused; a bare name lands in outputs
    assert.match(text(await call(client, "export_takeoff", { path: "/tmp/elsewhere.json" })), /outside project/);
    assert.match(text(await call(client, "export_takeoff", { path: "../../../escape.json" })), /outside project/);

    const syncsBefore = h.workspace.syncCalls;
    const report = okReply(await call(client, "export_report", { path: "E-101 report.json", project_name: "Invented Hangar", xlsx: true }), "export_report");
    assert.ok(h.workspace.syncCalls > syncsBefore, "export_report pushed outputs at once");
    const links = text(report);
    assert.match(links, /Download links/);
    assert.match(links, new RegExp(`https://store\\.test/projects/${id}/outputs/E-101%20report\\.json`));
    assert.match(links, new RegExp(`https://store\\.test/projects/${id}/outputs/Drawings/E-101%20-%20report\\.xlsx`));
    assert.ok(report.structuredContent && "conditions" in report.structuredContent, "the report document is still the structured reply");
    await stat(path.join(h.workspace.outputsDir(id), "E-101 report.json"));

    const marked = okReply(await call(client, "export_marked_pdf", {}), "export_marked_pdf");
    assert.match(text(marked), /outputs\/Drawings\/E-101%20-%20marked%20set\.pdf/);
    const outs = json(okReply(await call(client, "project_outputs", { project: id }), "project_outputs"));
    assert.ok(outs.outputs.some((o: { path: string; url: string }) => o.path === "Drawings/E-101 - marked set.pdf" && o.url.startsWith("https://store.test/")));
    const dl = json(okReply(await call(client, "download_link", { project: id, path: "Drawings/E-101.pdf" }), "download_link"));
    assert.equal(dl.url, `https://store.test/projects/${id}/files/Drawings/E-101.pdf?expires=86400`);

    // the debounced push after an ordinary call
    const before = h.workspace.syncCalls;
    okReply(await call(client, "takeoff_summary"), "takeoff_summary");
    await waitFor(() => h.workspace.syncCalls > before, "debounced sync after takeoff_summary");

    // a second MCP session is its own takeoff
    const second = await connect(`${h.url}/mcp`);
    const summary2 = okReply(await call(second.client, "takeoff_summary"), "takeoff_summary (2)");
    assert.equal((summary2.structuredContent!.conditions as unknown[]).length, 0, "session 2 starts empty");
    const summary1 = okReply(await call(client, "takeoff_summary"), "takeoff_summary (1)");
    assert.ok((summary1.structuredContent!.conditions as unknown[]).length >= 2, "session 1 keeps its conditions");
    const opened2 = json(okReply(await call(second.client, "open_project", { project: id }), "open_project (2)"));
    assert.match(opened2.note, /other conversation also has this project open/);
    await second.transport.terminateSession();
    await second.client.close();

    // /mcp/brink with PGlite under dataDir
    const brink = await connect(`${h.url}/mcp/brink`);
    const brinkTools = (await brink.client.listTools()).tools.map((t) => t.name);
    for (const n of ["import_takeoff", "bom", "export_bom", "export_schematic", "map_condition"]) assert.ok(brinkTools.includes(n), `brink lacks ${n}`);
    assert.match(brink.client.getInstructions() ?? "", /HOSTED: file paths/);
    const outside = (await brink.client.callTool({ name: "import_takeoff", arguments: { takeoff_path: "/etc/passwd" } })) as Reply;
    assert.ok(outside.isError);
    assert.match(text(outside), /not inside a project's workspace/);
    await stat(path.join(h.deps.config.dataDir, "brink-pglite"));
    await brink.client.close();
    await client.close();
  } finally {
    await h.close();
  }
});

test("/mcp: an idle session is closed, its auto-save lands and is pushed, and the next session restores it", async () => {
  const h = await harness({ idleMs: 400, sweepMs: 50, brink: false, syncDebounceMs: 10_000, autosave: { debounceMs: 5_000, maxWaitMs: 10_000 } });
  try {
    const { client, transport } = await connect(`${h.url}/mcp`);
    const id = await seedProject(h, client, "Invented Clinic Low Voltage");
    okReply(await call(client, "open_project", { project: id }), "open_project");
    okReply(await call(client, "set_scale", { sheet: "E-101.pdf", upp: UPP_EIGHTH }), "set_scale");
    okReply(await call(client, "place_count", { sheet: "E-101.pdf", points: [[400, 800], [700, 800], [900, 800]], condition: "WAP" }), "place_count");
    const autosave = path.join(h.workspace.outputsDir(id), "E-101 - takeoff autosave.json");
    await assert.rejects(stat(autosave), "the long debounce has not written yet");

    // idle past 400 ms: the sweeper closes the session, flushing first
    await waitFor(async () => (await h.projects.get(id))!.files.some((f) => f.kind === "output" && f.path === "E-101 - takeoff autosave.json"), "autosave pushed on idle close", 8000);
    const saved = JSON.parse(await readFile(autosave, "utf8"));
    assert.equal(saved.shapes.length, 3);
    const sid = transport.sessionId!;
    const res = await fetch(`${h.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    assert.equal(res.status, 404, "the closed session is gone");
    await client.close().catch(() => {});

    // a wiped local mirror: the next session pulls the auto-save back from the store and restores it
    await rm(h.workspace.dir(id), { recursive: true, force: true });
    const next = await connect(`${h.url}/mcp`);
    const opened = json(okReply(await call(next.client, "open_project", { project: id }), "open_project (again)"));
    assert.ok(opened.restored, `expected a restore: ${opened.note}`);
    assert.equal(opened.restored.shapes, 3);
    const summary = okReply(await call(next.client, "takeoff_summary"), "takeoff_summary");
    const wap = (summary.structuredContent!.conditions as { tag?: string; name?: string }[]);
    assert.ok(JSON.stringify(wap).includes("WAP"), "the restored takeoff carries the WAP condition");
    await next.client.close();
  } finally {
    await h.close();
  }
});

test("/mcp: the live-session cap evicts the longest-idle session", async () => {
  const h = await harness({ maxSessions: 2, brink: false });
  try {
    const a = await connect(`${h.url}/mcp`);
    await new Promise((r) => setTimeout(r, 20));
    const b = await connect(`${h.url}/mcp`);
    okReply(await call(a.client, "list_projects"), "a touches"); // b is now the longest idle
    const c = await connect(`${h.url}/mcp`);
    okReply(await call(a.client, "list_projects"), "a survives");
    okReply(await call(c.client, "list_projects"), "c works");
    await assert.rejects(b.client.callTool({ name: "list_projects", arguments: {} }), "b was evicted");
    for (const x of [a, b, c]) await x.client.close().catch(() => {});
  } finally {
    await h.close();
  }
});

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${what}`);
}
