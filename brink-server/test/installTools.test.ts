// The install tools end to end over real Streamable HTTP with the real store
// modules: an invented two-sheet project, its takeoff imported from the
// invented fixture, the phase gate, install_draft → design.json pushed,
// update ops (a spec label scheme, a tag rename, rack and equipment), the
// check, revision bumps and an owner approval cleared by the next change.
// Nothing here is a real drawing, job or product.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { INSTALL_TOOL_NAMES } from "../src/installTools.ts";
import type { AppDeps, Config } from "../src/types.ts";
import type { InstallDesign } from "../src/installTypes.ts";
import { installTakeoff } from "./installFixture.ts";

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r: Reply) => JSON.parse(r.content[0].text ?? "null");

async function plan(title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([2592, 1728]);
  page.drawText(`${title} TELECOM PLAN (INVENTED FIXTURE)`, { x: 72, y: 1600, size: 24, font });
  return doc.save();
}

test("install tools: phase gate, draft, update ops, check, revisions; a change clears the owner's approval", async () => {
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
  const server = app.listen(0);
  const client = new Client({ name: "install", version: "0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return json(r);
  };
  const refuse = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(r.isError, `${name} should refuse: ${text(r)}`);
    return text(r);
  };
  const stored = async (id: string) => JSON.parse(Buffer.from((await storage.getBytes(`projects/${id}/outputs/install/design.json`))!).toString("utf8")) as InstallDesign;
  try {
    const p = await projects.create({ name: "Invented Clinic Install" });
    for (const name of ["T-101", "T-201"]) {
      const bytes = await plan(name);
      await storage.put(`projects/${p.id}/files/Drawings/${name}.pdf`, bytes);
      await projects.update(p.id, (m) => {
        m.files.push({ path: `Drawings/${name}.pdf`, kind: "plan", size: bytes.length, contentType: "application/pdf", pages: 1, added: new Date().toISOString(), text: "none" });
      });
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of INSTALL_TOOL_NAMES) assert.ok(names.includes(n), `tools/list lacks ${n}`);
    assert.match(client.getInstructions() ?? "", /INSTALL: after a bid is won/);

    // the phase gate: still in the bid phase
    assert.match(await refuse("install_draft", { project: p.id }), /install phase.*bid phase.*project page/);
    await projects.update(p.id, (m) => { m.phase = "install"; });
    assert.match(await refuse("install_draft", { project: p.id }), /open_project/);
    assert.match(await refuse("get_install_design", { project: p.id }), /no install design yet/);

    // the takeoff: the invented fixture imported onto the two sheets
    const opened = await call("open_project", { project: p.id });
    assert.deepEqual(opened.sheets.map((s: { sheet: string }) => s.sheet).sort(), ["T-101.pdf", "T-201.pdf"]);
    const fixture = path.join(deps.workspace.outputsDir(p.id), "fixture-takeoff.json");
    await mkdir(path.dirname(fixture), { recursive: true });
    await writeFile(fixture, JSON.stringify(installTakeoff()));
    await call("import_takeoff", { path: fixture });

    // draft
    const r1 = await call("install_draft", { project: p.id });
    assert.deepEqual([r1.revision, r1.status], [1, "draft"]);
    assert.deepEqual([r1.counts.devices, r1.counts.cables, r1.counts.racks], [9, 9, 2]);
    assert.ok(r1.issues.errors > 0);
    assert.match(r1.issues.items[0], /^error /);
    assert.ok(r1.issues.items.some((s: string) => /device_unlinked: Device DO-102/.test(s)));
    assert.match(r1.labelScheme, /\{type\}\{seq:2\} \(default\)/);
    assert.match(r1.approval, /Draft/);
    assert.ok(r1.download?.some((d: { path: string }) => /install\/design\.json$/.test(d.path)), JSON.stringify(r1.download));
    const d1 = await stored(p.id);
    assert.equal(d1.revision, 1);
    assert.deepEqual(d1.cables.map((c) => c.lengthFt), [120, 120, 170, 170, 300, 80, 60, 70, 70]);
    assert.ok((await projects.get(p.id))!.files.some((f) => f.kind === "output" && /install\/design\.json$/.test(f.path)));

    const summary = await call("get_install_design", { project: p.id });
    assert.deepEqual([summary.revision, summary.counts.cables, summary.racks[0].id, summary.phase], [1, 9, "RK-101", "install"]);
    const cablesPage = await call("get_install_design", { project: p.id, part: "cables", limit: 4 });
    assert.deepEqual([cablesPage.total, cablesPage.rows.length, cablesPage.next_offset, cablesPage.rows[0].label], [9, 4, 4, "D01"]);

    // equipment library
    assert.equal((await call("find_equipment", { query: "switch" })).entries.length, 0);
    await call("record_equipment", { entries: [{ manufacturer: "Invented Networks", model: "SW-24P", description: "24-port PoE switch", ruHeight: 1, watts: 370, portGroups: [{ prefix: "p", count: 24, signal: "ethernet", poe: true }], source: "https://invented.example/sw-24p.pdf", date: "2026-11-21" }] });
    const found = await call("find_equipment", { query: "poe switch" });
    assert.deepEqual([found.entries[0].key, found.entries[0].ruHeight, found.entries[0].ports], ["inventednetworks:sw24p", 1, 24]);

    // update ops: all or nothing
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "set_rack", rack: "RK-101", sizeRU: 24 }, { op: "set_cable", label: "D01", lengthFt: 99 }] }), /lengthFt comes only from the takeoff.*Nothing was saved/);
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "set_label_scheme", source: "spec", description: "x", pattern: "{tr}{panel}-{port:2}" }] }), /reference/);
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "set_label_scheme", source: "spec", reference: "27 05 53", description: "x", pattern: "{rack}-{room}" }] }), /cannot be unique/);
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "set_device", tag: "DO-101", newTag: "WAP-101" }] }), /already used/);
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "connect", from: { equipment: "PP-01", port: "p99" }, to: { equipment: "DO-101", port: "c1" } }] }), /no port p99/);
    assert.equal((await stored(p.id)).revision, 1, "refused calls save nothing");

    const r2 = await call("update_install_design", {
      project: p.id,
      ops: [
        { op: "set_label_scheme", source: "spec", reference: "27 05 53 3.2.B (invented)", description: "TR number, panel letter, port: 1A-01", pattern: "{tr}{panel}-{port:2}" },
        { op: "set_device", tag: "DO-101", newTag: "DO-1A", room: "Office 101A" },
        { op: "set_rack", rack: "RK-101", sizeRU: 24, model: "Invented 24U wall rack", circuits: [{ label: "20A dedicated", amps: 20 }] },
        { op: "set_rack", rack: "RK-201", sizeRU: 12 },
        { op: "add_equipment", tag: "SW-01", key: "inventednetworks:sw24p" },
        { op: "place_in_rack", tag: "SW-01", rack: "RK-101", ruTop: 22 },
        { op: "connect", from: { equipment: "PP-01", port: "p1" }, to: { equipment: "SW-01", port: "p1" } },
        { op: "set_mounting", deviceType: "wall_outlet", heightAff: "18 in. AFF to center", box: "1-gang mud ring (by EC)", basis: "Invented legend note 2" },
      ],
    });
    assert.equal(r2.revision, 2);
    assert.ok(r2.changes.some((c: string) => /renamed DO-1A/.test(c)));
    const d2 = await stored(p.id);
    assert.deepEqual([d2.revision, d2.status, d2.labelScheme.source, d2.labelScheme.reference], [2, "draft", "spec", "27 05 53 3.2.B (invented)"]);
    const toRenamed = d2.cables.filter((c) => c.to.equipment === "DO-1A");
    assert.deepEqual(toRenamed.map((c) => [c.label, c.to.location]), [["1A-01", "Office 101A"], ["1A-02", "Office 101A"]], "relabeled by the spec scheme, the rename and room followed");
    assert.ok(d2.connections.some((c) => c.id === "fc-d1-c1" && c.to.equipment === "DO-1A" && c.cable === "1A-01"));
    assert.ok(d2.equipment.some((e) => e.tag === "DO-1A") && !d2.equipment.some((e) => e.tag === "DO-101"));
    assert.deepEqual(d2.racks[0].items.map((it) => [it.tag, it.ruTop]), [["PP-01", 24], ["SW-01", 22]]);
    assert.ok(!d2.issues.some((i) => i.code === "rack_size_unknown"));
    assert.ok(d2.issues.some((i) => i.code === "device_unlinked"), "takeoff issues stay until the next draft");

    // install_check reports without saving
    const chk = await call("install_check", { project: p.id });
    assert.equal(chk.revision, 2);
    assert.ok(chk.issues.items.some((s: string) => /mounting_height_unset: No mounting height for wap/.test(s)));
    assert.equal(chk.racks[0].power.watts, 370);

    // the owner approves revision 2 on the phone (simulated in the store); the next change clears it
    await storage.put(`projects/${p.id}/outputs/install/design.json`, JSON.stringify({ ...d2, status: "approved", approved: { at: "2026-11-21T18:00:00.000Z", revision: 2 } }));
    assert.equal((await call("get_install_design", { project: p.id })).status, "approved");
    const r3 = await call("update_install_design", { project: p.id, ops: [{ op: "set_cable", label: "1A-05", notes: "Pull from the corridor side (invented)" }] });
    assert.equal(r3.revision, 3);
    assert.match(r3.approval, /approval is cleared/);
    const d3 = await stored(p.id);
    assert.deepEqual([d3.revision, d3.status, d3.approved], [3, "draft", undefined]);

    // re-draft from the takeoff keeps the edits
    const r4 = await call("install_draft", { project: p.id });
    assert.equal(r4.revision, 4);
    const d4 = await stored(p.id);
    assert.ok(d4.devices.some((x) => x.tag === "DO-1A" && x.room === "Office 101A"));
    assert.equal(d4.labelScheme.pattern, "{tr}{panel}-{port:2}");
    assert.equal(d4.cables.find((c) => c.label === "1A-05")?.notes, "Pull from the corridor side (invented)");
    assert.ok(d4.equipment.some((e) => e.tag === "SW-01" && e.rack === "RK-101"));

    // out of the install phase: no more changes
    await projects.update(p.id, (m) => { m.phase = "closeout"; });
    assert.match(await refuse("update_install_design", { project: p.id, ops: [{ op: "set_rack", rack: "RK-101", fanCfm: 50 }] }), /closeout phase/);
    await client.close();
  } finally {
    await client.close().catch(() => {});
    await mounted.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
