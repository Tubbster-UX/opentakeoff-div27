import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { StoreProjects } from "../src/projects.ts";
import { FsStorage } from "../src/storage.ts";
import { DiskWorkspace } from "../src/workspace.ts";

let root: string;
let storage: FsStorage;
let projects: StoreProjects;
let ws: DiskWorkspace;
const P = "ws";
const PLAN = Buffer.from("%PDF-1.7 invented plan bytes");
const SPEC = Buffer.from("%PDF-1.7 invented spec");

/** Counts object downloads. */
class CountingStorage extends FsStorage {
  streams = 0;
  override async getStream(key: string) {
    this.streams++;
    return super.getStream(key);
  }
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brink-ws-"));
  storage = new CountingStorage(path.join(root, "store"));
  projects = new StoreProjects(storage);
  ws = new DiskWorkspace({ storage, projects, dataDir: path.join(root, "data") });
  await projects.create({ name: "WS", id: P });
  await storage.put(`projects/${P}/files/Drawings/E-101.pdf`, PLAN);
  await storage.put(`projects/${P}/files/Specs/Volume 2.pdf`, SPEC);
  await projects.update(P, (m) => {
    const added = new Date().toISOString();
    m.files.push({ path: "Drawings/E-101.pdf", kind: "plan", size: PLAN.length, contentType: "application/pdf", added, text: "ok", uploadId: "u1" });
    m.files.push({ path: "Specs/Volume 2.pdf", kind: "spec", size: SPEC.length, contentType: "application/pdf", added, text: "ok", uploadId: "u1" });
  });
});
after(async () => rm(root, { recursive: true, force: true }));

describe("DiskWorkspace", () => {
  test("dir and outputsDir", () => {
    assert.equal(ws.dir(P), path.join(root, "data", "projects", P));
    assert.equal(ws.outputsDir(P), path.join(root, "data", "projects", P, "outputs"));
    assert.throws(() => ws.dir("../x"), /Invalid project id/);
  });

  test("ensureFile downloads once, re-downloads when the size is stale", async () => {
    const cs = storage as CountingStorage;
    const local = await ws.ensureFile(P, "Drawings/E-101.pdf");
    assert.equal(local, path.join(ws.dir(P), "files", "Drawings", "E-101.pdf"));
    assert.deepEqual(await readFile(local), PLAN);
    const n = cs.streams;
    assert.equal(await ws.ensureFile(P, "Drawings/E-101.pdf"), local);
    assert.equal(cs.streams, n, "cached");
    await writeFile(local, "truncated");
    await ws.ensureFile(P, "Drawings/E-101.pdf");
    assert.equal(cs.streams, n + 1);
    assert.deepEqual(await readFile(local), PLAN);
    // Concurrent calls share one download.
    await rm(local);
    await Promise.all([ws.ensureFile(P, "Drawings/E-101.pdf"), ws.ensureFile(P, "Drawings/E-101.pdf"), ws.ensureFile(P, "Drawings/E-101.pdf")]);
    assert.equal(cs.streams, n + 2);
  });

  test("ensureFile refuses unknown and unsafe paths", async () => {
    await assert.rejects(ws.ensureFile(P, "Nope.pdf"), /not found/);
    await assert.rejects(ws.ensureFile(P, "../../../etc/passwd"), /segment/);
    await assert.rejects(ws.ensureFile(P, "/etc/passwd"), /must not start/);
    await assert.rejects(ws.ensureFile("nope", "a.pdf"), /not found/);
  });

  test("syncOutputs pushes what the tools wrote, never unchanged originals or temp files", async () => {
    await ws.ensureFile(P, "Specs/Volume 2.pdf");
    const base = ws.dir(P);
    await writeFile(path.join(ws.outputsDir(P), "report.json"), '{"total":42}');
    await mkdir(path.join(ws.outputsDir(P), "autosave"), { recursive: true });
    await writeFile(path.join(ws.outputsDir(P), "autosave", "takeoff.json"), "{}");
    await writeFile(path.join(base, "files", "Drawings", "E-101 marked.pdf"), "%PDF marked set");
    await writeFile(path.join(base, "files", "Drawings", ".E-101.pdf.lock"), "x");
    await writeFile(path.join(ws.outputsDir(P), "partial.pdf.tmp"), "x");
    await mkdir(path.join(ws.outputsDir(P), ".cache"), { recursive: true });
    await writeFile(path.join(ws.outputsDir(P), ".cache", "x.bin"), "x");
    await writeFile(path.join(root, "secret.txt"), "not for the store");
    await symlink(path.join(root, "secret.txt"), path.join(ws.outputsDir(P), "link.txt"));

    const pushed = await ws.syncOutputs(P);
    assert.deepEqual(pushed.sort(), ["outputs/Drawings/E-101 marked.pdf", "outputs/autosave/takeoff.json", "outputs/report.json"]);
    assert.equal(Buffer.from((await storage.getBytes(`projects/${P}/outputs/report.json`))!).toString(), '{"total":42}');
    assert.equal(Buffer.from((await storage.getBytes(`projects/${P}/outputs/Drawings/E-101 marked.pdf`))!).toString(), "%PDF marked set");
    assert.equal(await storage.head(`projects/${P}/outputs/link.txt`), null, "symlinks are not followed");
    const m = (await projects.get(P))!;
    const out = m.files.find((f) => f.path === "outputs/report.json")!;
    assert.equal(out.kind, "output");
    assert.equal(out.size, 12);
    assert.equal(out.contentType, "application/json");
    assert.equal(out.uploadId, undefined);
    assert.equal(m.files.filter((f) => f.kind !== "output").length, 2, "originals untouched in the manifest");

    assert.deepEqual(await ws.syncOutputs(P), [], "nothing new");
  });

  test("changed outputs are pushed again; touched-but-identical ones are not", async () => {
    const report = path.join(ws.outputsDir(P), "report.json");
    await writeFile(report, '{"total":43}');
    assert.deepEqual(await ws.syncOutputs(P), ["outputs/report.json"]);
    assert.equal(Buffer.from((await storage.getBytes(`projects/${P}/outputs/report.json`))!).toString(), '{"total":43}');
    const later = new Date(Date.now() + 5000);
    await utimes(report, later, later);
    assert.deepEqual(await ws.syncOutputs(P), []);
    const m = (await projects.get(P))!;
    assert.equal(m.files.filter((f) => f.path === "outputs/report.json").length, 1);
    assert.equal(m.files.find((f) => f.path === "outputs/report.json")!.size, 12);
  });

  test("an original modified in place is pushed as an output; the stored original is never overwritten", async () => {
    const local = await ws.ensureFile(P, "Drawings/E-101.pdf");
    await writeFile(local, "%PDF-1.7 invented plan bytes WITH MARKUP");
    assert.deepEqual(await ws.syncOutputs(P), ["outputs/Drawings/E-101.pdf"]);
    assert.deepEqual(Buffer.from((await storage.getBytes(`projects/${P}/files/Drawings/E-101.pdf`))!), PLAN);
    const m = (await projects.get(P))!;
    assert.equal(m.files.find((f) => f.path === "Drawings/E-101.pdf")!.kind, "plan");
    assert.equal(m.files.find((f) => f.path === "outputs/Drawings/E-101.pdf")!.kind, "output");
  });

  test("outputs can be fetched back to a fresh mirror without being re-pushed", async () => {
    const fresh = new DiskWorkspace({ storage, projects, dataDir: path.join(root, "data2") });
    const local = await fresh.ensureFile(P, "outputs/report.json");
    assert.equal(local, path.join(fresh.dir(P), "outputs", "report.json"));
    assert.equal(await readFile(local, "utf8"), '{"total":43}');
    assert.deepEqual(await fresh.syncOutputs(P), []);
    // A fresh mirror holding an identical copy it did not download is not re-pushed either.
    const other = new DiskWorkspace({ storage, projects, dataDir: path.join(root, "data3") });
    await mkdir(other.outputsDir(P), { recursive: true });
    await writeFile(path.join(other.outputsDir(P), "report.json"), '{"total":43}');
    assert.deepEqual(await other.syncOutputs(P), []);
    assert.ok((await stat(path.join(other.dir(P), ".sync-state.json"))).isFile());
  });

  test("an output never replaces an original's manifest entry", async () => {
    // An original that happens to live at "outputs/..." in the manifest.
    await storage.put(`projects/${P}/files/outputs/old.txt`, "orig");
    await projects.update(P, (m) => {
      m.files.push({ path: "outputs/old.txt", kind: "doc", size: 4, contentType: "text/plain", added: new Date().toISOString(), text: "ok" });
    });
    await writeFile(path.join(ws.outputsDir(P), "old.txt"), "tool wrote this");
    assert.deepEqual(await ws.syncOutputs(P), []);
    assert.equal((await projects.get(P))!.files.find((f) => f.path === "outputs/old.txt")!.kind, "doc");
  });
});
