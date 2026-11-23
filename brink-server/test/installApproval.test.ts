// The owner's install routes on a small express app: the page view, approve
// (exact revision, refused while errors stand, re-render hook), withdraw, and
// the project phase (install needs an approved bid). Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { MemProjects, MemStorage } from "./fakes.ts";
import { installKey, installRoutes } from "../src/installApproval.ts";
import { bidKey } from "../src/approval.ts";
import { draftInstallDesign } from "../src/install/baseline.ts";
import { fixtureBid, approve } from "./bidFixture.ts";
import { installTakeoff } from "./installFixture.ts";
import type { AppDeps } from "../src/types.ts";
import type { InstallDesign } from "../src/installTypes.ts";

test("install routes: view, approve only a current error-free revision, withdraw, phase needs an approved bid", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-install-approval-"));
  const storage = new MemStorage();
  const projects = new MemProjects();
  const deps = {
    storage, projects,
    workspace: { outputsDir: (p: string) => path.join(root, p, "outputs"), dir: (p: string) => path.join(root, p) },
  } as unknown as AppDeps;
  const rendered: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api", installRoutes(deps, { onApproved: async (p, d) => { rendered.push(`${p}:r${d.revision}:${d.status}`); return [`outputs/install/${p} - install package r${d.revision}.pdf`]; } }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const put = (id: string, d: InstallDesign) => storage.put(installKey(id), JSON.stringify(d));
  const stored = async (id: string) => JSON.parse(Buffer.from((await storage.getBytes(installKey(id)))!).toString()) as InstallDesign;
  try {
    const proj = await projects.create({ name: "Invented Clinic" });
    const id = proj.id;
    assert.equal((await api("GET", "/projects/nope/install")).status, 404);
    assert.equal((await api("GET", "/projects/Bad..Id/install")).status, 404);
    const none = await api("GET", `/projects/${id}/install`);
    assert.equal(none.status, 404);
    assert.match(none.body.message, /install phase/);

    // phase: install needs an approved bid
    assert.equal((await api("POST", `/projects/${id}/phase`, { phase: "construction" })).status, 400);
    let ph = await api("POST", `/projects/${id}/phase`, { phase: "install" });
    assert.equal(ph.status, 409);
    assert.match(ph.body.message, /approved bid.*no bid yet/);
    await storage.put(bidKey(id), JSON.stringify({ ...fixtureBid(), project: id }));
    ph = await api("POST", `/projects/${id}/phase`, { phase: "install" });
    assert.equal(ph.status, 409);
    assert.match(ph.body.message, /bid revision 3 is a draft\. Approve it first/);
    await storage.put(bidKey(id), JSON.stringify({ ...approve(fixtureBid()), project: id }));
    ph = await api("POST", `/projects/${id}/phase`, { phase: "install" });
    assert.deepEqual([ph.status, ph.body.phase], [200, "install"]);
    assert.equal((await projects.get(id))!.phase, "install");

    // a fresh draft has errors (rack sizes, mounting heights, takeoff holes): approval refused
    const draft = draftInstallDesign({ takeoff: installTakeoff(), project: id, now: "2026-11-21T00:00:00Z" });
    await put(id, draft);
    const view = await api("GET", `/projects/${id}/install`);
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.phase, view.body.design.revision, view.body.design.counts.cables, view.body.design.racks.length], ["install", 1, 9, 2]);
    assert.ok(view.body.design.issues.length > 0 && view.body.design.issueCounts.errors > 0);
    assert.equal(view.body.design.devices, undefined, "no heavy lists on the page view");
    assert.equal((await api("POST", `/projects/${id}/install/approve`, {})).status, 400);
    const blocked = await api("POST", `/projects/${id}/install/approve`, { revision: 1 });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /error/);

    // an error-free revision 2 (warnings only): stale revision refused, current approves, hook re-renders
    const clean: InstallDesign = { ...draft, revision: 2, issues: [{ severity: "warning", code: "room_unknown", message: "Device CAM-101 is in no labeled room." }] };
    await put(id, clean);
    const stale = await api("POST", `/projects/${id}/install/approve`, { revision: 1 });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /revision 2/);
    const ok = await api("POST", `/projects/${id}/install/approve`, { revision: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.rerendered, [`outputs/install/${id} - install package r2.pdf`]);
    assert.deepEqual(rendered, [`${id}:r2:approved`]);
    const s = await stored(id);
    assert.deepEqual([s.status, s.approved?.revision], ["approved", 2]);
    const local = JSON.parse(await readFile(path.join(root, id, "outputs", "install", "design.json"), "utf8")) as InstallDesign;
    assert.equal(local.status, "approved", "the local mirror follows");

    // withdraw
    assert.equal((await api("POST", `/projects/${id}/install/withdraw`, { revision: 1 })).status, 409);
    assert.equal((await api("POST", `/projects/${id}/install/withdraw`, { revision: 2 })).status, 200);
    const back = await stored(id);
    assert.deepEqual([back.status, back.approved], ["draft", undefined]);

    // closeout and back
    assert.equal((await api("POST", `/projects/${id}/phase`, { phase: "closeout" })).body.phase, "closeout");
    assert.equal((await api("POST", `/projects/${id}/phase`, { phase: "bid" })).body.phase, "bid");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
