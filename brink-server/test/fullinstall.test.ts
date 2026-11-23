// One invented job through the install phase, the way the owner will use it:
// an approved bid → the owner starts the install phase (the real route) →
// Claude takes off with rooms, drafts the install design, fixes its blocking
// issues (rack size, mounting heights, a spec label scheme) → exports the
// 11x17 package and the pull schedule as DRAFT → the owner approves it for
// construction → the package is re-made as ISSUED FOR CONSTRUCTION. Nothing
// here is a real drawing, rate, price or company.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FsStorage } from "../src/storage.ts";
import { StoreProjects } from "../src/projects.ts";
import { StoreSearch } from "../src/search.ts";
import { DiskWorkspace } from "../src/workspace.ts";
import { createMountMcp } from "../src/mcp.ts";
import { installRoutes } from "../src/installApproval.ts";
import { rerenderInstallApproved } from "../src/installExportTools.ts";
import { fixtureSettings } from "./bidFixture.ts";
import type { AppDeps, Config } from "../src/types.ts";
import type { BidDraft } from "../src/bidTypes.ts";

type Reply = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r: Reply) => JSON.parse(r.content[0].text ?? "null");

async function plan(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([2592, 1728]);
  page.drawText("T-101 TELECOM PLAN (INVENTED FIXTURE)", { x: 72, y: 1600, size: 24, font });
  return doc.save();
}

const UPP = 8 / 144; // 1/8" = 1'-0" at render scale 2.0

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  let all = "";
  for (let i = 1; i <= doc.numPages; i++) all += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  return all;
}

test("a whole invented install: phase, takeoff with rooms, draft, fixes, DRAFT package, construction approval re-makes it ISSUED FOR CONSTRUCTION", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-install-"));
  const storage = new FsStorage(path.join(root, "store"));
  const projects = new StoreProjects(storage);
  const config = { publicUrl: "http://127.0.0.1", port: 0, dataDir: path.join(root, "data"), storage: { kind: "fs", root: path.join(root, "store") }, ownerPasswordHash: "x", sessionSecret: "x", maxUploadBytes: 1 << 30 } as Config;
  const deps: AppDeps = {
    config, storage, projects,
    ingest: { process: async () => { throw new Error("not in this test"); } },
    search: new StoreSearch({ storage, projects }),
    workspace: new DiskWorkspace({ storage, projects, dataDir: config.dataDir }),
  };
  const app = express();
  const mounted = createMountMcp({ syncDebounceMs: 50, autosave: { debounceMs: 20, maxWaitMs: 100 }, brink: false, log: () => {} })(app, deps, (_req, _res, next) => next());
  app.use("/api", express.json(), installRoutes(deps, { onApproved: (project) => rerenderInstallApproved(deps, project) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: "install", version: "0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return r;
  };
  const post = async (p: string, body: unknown) => {
    const r = await fetch(`${base}/api${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const p = await projects.create({ name: "Invented Hangar Install", notes: "Awarded (invented)" });
    const bytes = await plan();
    await storage.put(`projects/${p.id}/files/Drawings/T-101.pdf`, bytes);
    await projects.update(p.id, (m) => {
      m.files.push({ path: "Drawings/T-101.pdf", kind: "plan", size: bytes.length, contentType: "application/pdf", pages: 1, added: new Date().toISOString(), text: "none" });
    });
    // the company on the title block (invented)
    await storage.put("system/settings.json", JSON.stringify({ ...fixtureSettings(), updated: new Date().toISOString(), changeLog: [] }));

    // the phase gate: no approved bid yet
    const early = await post(`/projects/${p.id}/phase`, { phase: "install" });
    assert.equal(early.status, 409, JSON.stringify(early.body));
    await storage.put(`projects/${p.id}/outputs/bid/bid.json`, JSON.stringify({ schema: "brink.bid.v1", project: p.id, revision: 2, status: "approved", approved: { at: "2026-11-20T00:00:00Z", revision: 2 }, totals: { baseBid: 1000 }, gaps: [], flags: [], lines: [], hours: [], expenses: [], ratios: {}, inputs: {}, settings: fixtureSettings() }));
    const started = await post(`/projects/${p.id}/phase`, { phase: "install" });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    // the takeoff, with rooms: two 2-cable outlets in two rooms, a WAP, a TR in the MDF
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const opened = json(await call("open_project", { project: p.id }));
    const sheet = opened.sheets[0].sheet as string;
    await call("set_scale", { sheet, upp: UPP });
    await call("edit_shape", { shape_id: (await call("measure_polygon", { sheet, verts: [[400, 900], [1400, 900], [1400, 1500], [400, 1500]], condition: "ROOMS" })).structuredContent!.shape_id as string, label: "Office 101" });
    await call("edit_shape", { shape_id: (await call("measure_polygon", { sheet, verts: [[1500, 900], [2200, 900], [2200, 1500], [1500, 1500]], condition: "ROOMS" })).structuredContent!.shape_id as string, label: "Office 102" });
    await call("edit_shape", { shape_id: (await call("measure_polygon", { sheet, verts: [[2300, 900], [2800, 900], [2800, 1500], [2300, 1500]], condition: "ROOMS" })).structuredContent!.shape_id as string, label: "MDF" });
    const outlets = (await call("place_count", { sheet, points: [[600, 1200], [1800, 1200]], condition: "DATA-2" })).structuredContent!.shape_ids as string[];
    const wap = (await call("place_count", { sheet, points: [[1000, 1000]], condition: "WAP" })).structuredContent!.shape_ids as string[];
    const tr = (await call("place_count", { sheet, points: [[2500, 1200]], condition: "TR" })).structuredContent!.shape_ids as string[];
    const route = (await call("measure_line", { sheet, pts: [[600, 1300], [2400, 1300]], condition: "ROUTE" })).structuredContent!.shape_id as string;
    await call("edit_condition", { condition: "DATA-2", cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A plenum", vertical_ft: 23, loop_device_ft: 10, loop_tr_ft: 10 } });
    await call("edit_condition", { condition: "WAP", cable_setup: { device_type: "wap", cables_per_location: 1, cable_type: "CAT6A plenum", vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10 } });
    await call("edit_condition", { condition: "TR", role: "tr" });
    await call("edit_condition", { condition: "ROUTE", role: "route" });
    for (const d of [...outlets, ...wap]) await call("link_run", { device_shape_ids: [d], route_shape_ids: [route], tr_id: tr[0] });

    // the draft: tags, rooms, a rack with a panel, five labelled cables, blocking issues
    const drafted = json(await call("install_draft", { project: p.id }));
    assert.equal(drafted.revision, 1);
    const key = `projects/${p.id}/outputs/install/design.json`;
    const read = async () => JSON.parse(Buffer.from((await storage.getBytes(key))!).toString("utf8")) as import("../src/installTypes.ts").InstallDesign;
    let d = await read();
    assert.deepEqual(d.devices.map((x) => `${x.tag}@${x.room}`).sort(), ["DO-101@Office 101", "DO-102@Office 102", "WAP-101@Office 101"].sort(), JSON.stringify(d.devices.map((x) => [x.tag, x.room])));
    assert.equal(d.cables.length, 5);
    assert.ok(d.issues.some((i) => i.severity === "error"), "a fresh draft has blocking issues (rack size, mounting heights)");

    // Claude fixes them: rack size and circuit, heights from the (invented) spec, the spec's label scheme
    await call("update_install_design", { project: p.id, ops: [
      { op: "set_rack", rack: d.racks[0].id, sizeRU: 24, circuits: [{ label: "20A dedicated", amps: 20 }] },
      { op: "set_mounting", deviceType: "wall_outlet", heightAff: "18 in. AFF to center", basis: "Invented spec 27 15 00 3.4" },
      { op: "set_mounting", deviceType: "wap", heightAff: "Ceiling", basis: "Invented spec 27 15 00 3.5" },
      { op: "set_label_scheme", source: "spec", reference: "27 05 53 3.2 (invented)", description: "Rack + panel + port", pattern: "{tr}{panel}-{port:2}" },
    ] });
    d = await read();
    const errors = d.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors));
    const labels = d.cables.map((c) => c.label);
    assert.equal(new Set(labels).size, 5);

    // the DRAFT package
    const exp = json(await call("export_install_package", { project: p.id }));
    assert.match(exp.status, /DRAFT r\d/);
    assert.equal(exp.files.length, 3);
    for (const f of exp.files) assert.match(f.path, /DRAFT\.(pdf|csv|xlsx)$/);
    const draftPdf = (await storage.getBytes(`projects/${p.id}/${exp.files[0].path}`))!;
    const draftText = await pdfText(draftPdf);
    assert.match(draftText, /DRAFT/);
    for (const t of ["DO-101", "DO-102", "WAP-101", ...labels, d.racks[0].id]) assert.ok(draftText.includes(t), `${t} is on the drawings`);
    assert.doesNotMatch(draftText, /OpenTakeoff/);
    const csv = Buffer.from((await storage.getBytes(`projects/${p.id}/${exp.files[1].path}`))!).toString("utf8");
    for (const l of labels) assert.ok(csv.includes(l), `${l} in the pull schedule CSV`);

    // the owner approves for construction; the package is re-made
    const ok1 = await post(`/projects/${p.id}/install/approve`, { revision: d.revision });
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    assert.equal(ok1.body.warning, undefined, ok1.body.warning);
    assert.equal(ok1.body.rerendered.length, 3);
    for (const f of ok1.body.rerendered as string[]) assert.doesNotMatch(f, /DRAFT/, f);
    const finalText = await pdfText((await storage.getBytes(`projects/${p.id}/${ok1.body.rerendered[0]}`))!);
    assert.match(finalText, /ISSUED FOR CONSTRUCTION/);
    assert.doesNotMatch(finalText, /NOT FOR CONSTRUCTION/);

    // a later change by Claude is a new draft that needs approving again
    const changed = json(await call("update_install_design", { project: p.id, ops: [{ op: "set_device", tag: "DO-101", notes: "Verify box location with GC" }] }));
    assert.ok(changed.revision > d.revision);
    assert.equal((await read()).status, "draft");
  } finally {
    await client.close().catch(() => {});
    await mounted.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
