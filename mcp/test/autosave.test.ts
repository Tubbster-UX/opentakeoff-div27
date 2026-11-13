// Auto-save (src/autosave.ts): an MCP session's takeoff written beside the plan
// as it changes, so a client that goes away mid-bid does not take the work
// with it. Every test runs on a temp copy of the invented demo plan, so the
// default "<plan> - takeoff autosave.json" lands in a temp dir, never the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { Autosave, autosaveModeFromEnv, defaultAutosavePath, type AutosaveOptions } from "../src/autosave.ts";
import { parseTakeoffImport, mergeTakeoffImport } from "../../web/src/lib/importTakeoff.js";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const UPP = 1 / 36;

async function tmpPlan(prefix = "ot-autosave-"): Promise<{ dir: string; plan: string; auto: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const plan = path.join(dir, KEY);
  await copyFile(PLAN, plan);
  return { dir, plan, auto: path.join(dir, "sample-plan - takeoff autosave.json") };
}

/** A client/server pair whose session carries an Autosave (as server.ts's
 * entry point wires it), with a short debounce so tests stay quick. */
async function pair(opts: AutosaveOptions = {}) {
  const session = new Session();
  const autosave = new Autosave({ mode: { kind: "default" }, debounceMs: 20, maxWaitMs: 200, log: () => {}, ...opts }).attach(session);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(session, { oneClick: false }).connect(st);
  const client = new Client({ name: "autosave-test", version: "0.0.0" });
  await client.connect(ct);
  return { client, session, autosave };
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
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const withoutMarker = (doc: Record<string, unknown>) => { const { autosave, ...rest } = doc; return rest; };

/** A small cable takeoff: TR, one device, one route, one linked run. */
async function cableWork(client: Client) {
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  const tr = await ok(client, "place_count", { sheet: KEY, points: [[200, 200]], condition: "TR" });
  await ok(client, "edit_condition", { condition: "TR", role: "tr" });
  const dev = await ok(client, "place_count", { sheet: KEY, points: [[1000, 1000]], condition: "DATA-1" });
  await ok(client, "edit_condition", { condition: "DATA-1", cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  const rt = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 300], [3350, 300]], condition: "ROUTE" });
  await ok(client, "edit_condition", { condition: "ROUTE", role: "route" });
  await ok(client, "link_run", { device_shape_ids: [dev.shape_ids[0]], route_shape_ids: [rt.shape_id], tr_id: tr.shape_ids[0] });
}

test("a mutation is written to '<plan> - takeoff autosave.json' as the export_takeoff payload plus a marker", async () => {
  const { dir, plan, auto } = await tmpPlan();
  const { client, session, autosave } = await pair();
  const loaded = await ok(client, "load_plan", { path: plan });
  assert.equal(loaded.autosave.path, auto);
  assert.equal(defaultAutosavePath(plan), auto);
  assert.match(loaded.note, /every change is written to .*takeoff autosave\.json/);
  assert.equal(loaded.autosave.found, undefined);
  // loading a plan writes nothing — only a change does
  await autosave.idle();
  assert.deepEqual((await readdir(dir)).sort(), [KEY]);

  await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
  await autosave.idle();
  const raw = await readFile(auto, "utf8");
  const doc = JSON.parse(raw);
  // schema first, the marker second: the head alone identifies the file
  assert.match(raw, /^\{"schema":"opentakeoff\.takeoff_canvas\.v1","autosave":\{"saved_at":"/);
  assert.equal(doc.autosave.tool, "place_count");
  assert.equal(doc.autosave.plan, KEY);
  assert.ok(!Number.isNaN(Date.parse(doc.autosave.saved_at)));
  // the rest is export_takeoff's payload, byte for byte
  const exported = await ok(client, "export_takeoff");
  assert.equal(exported.autosave, undefined, "export_takeoff never carries the marker");
  assert.equal(JSON.stringify(withoutMarker(doc)), JSON.stringify(session.exportPayload()));
  assert.deepEqual(withoutMarker(doc), exported);
  // no temp file left behind by the atomic write
  assert.deepEqual((await readdir(dir)).sort(), [KEY, path.basename(auto)].sort());

  const summary = await ok(client, "takeoff_summary");
  assert.deepEqual(summary.autosave, { path: auto, saved_at: doc.autosave.saved_at });
});

test("a burst of calls coalesces into one write, and reads never rewrite the file", async () => {
  const { plan, auto } = await tmpPlan();
  const { client, autosave } = await pair({ debounceMs: 100, maxWaitMs: 10_000 });
  await ok(client, "load_plan", { path: plan });
  for (let i = 0; i < 30; i++) await ok(client, "place_count", { sheet: KEY, points: [[100 + 10 * i, 500]], condition: "DATA-1" });
  await autosave.idle();
  assert.equal(autosave.writes, 1);
  assert.equal((await readJson(auto)).shapes.length, 30);

  const before = (await stat(auto)).mtimeMs;
  await ok(client, "list_shapes");
  await ok(client, "takeoff_summary");
  await ok(client, "sheet_info", { sheet: KEY });
  await autosave.idle();
  assert.equal(autosave.writes, 1, "reads compare equal and write nothing");
  assert.equal((await stat(auto)).mtimeMs, before);
});

test("a continuous burst still writes within the max wait (a crash loses at most that much)", async () => {
  const { plan, auto } = await tmpPlan();
  const { client, autosave } = await pair({ debounceMs: 200, maxWaitMs: 250 });
  await ok(client, "load_plan", { path: plan });
  const started = Date.now();
  let i = 0;
  // keep calling faster than the debounce: only the max wait can fire
  while (Date.now() - started < 1500) {
    await ok(client, "place_count", { sheet: KEY, points: [[100 + i, 600]], condition: "DATA-1" });
    i++;
    await new Promise((r) => setTimeout(r, 10));
  }
  await autosave.idle();
  assert.ok(autosave.writes >= 3, `expected several capped writes, got ${autosave.writes}`);
  assert.ok(autosave.writes < i, `coalesced: ${autosave.writes} writes for ${i} calls`);
  assert.equal((await readJson(auto)).shapes.length, i);
});

test("undo_last and import_takeoff are saved; takeoff_summary writes a pending change first", async () => {
  const { plan, auto } = await tmpPlan();
  const { client, autosave } = await pair({ debounceMs: 5_000, maxWaitMs: 10_000 });
  await ok(client, "load_plan", { path: plan });
  await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
  await ok(client, "place_count", { sheet: KEY, points: [[400, 300]], condition: "DATA-1" });
  // the long debounce has not fired; the summary flushes before it reports
  const s1 = await ok(client, "takeoff_summary");
  assert.equal(s1.autosave.pending, undefined);
  assert.equal((await readJson(auto)).shapes.length, 2);

  await ok(client, "undo_last", { n: 1 });
  await autosave.flush();
  const afterUndo = await readJson(auto);
  assert.equal(afterUndo.shapes.length, 1);
  assert.equal(afterUndo.autosave.tool, "undo_last");

  // import_takeoff of a file that only carries a condition change still saves
  const other = path.join(path.dirname(plan), "other.json");
  const doc = withoutMarker(afterUndo) as Record<string, any>;
  await writeFile(other, JSON.stringify({ ...doc, conditions: [...doc.conditions, { ...doc.conditions[0], id: "c-new", finish_tag: "CAM-9" }] }));
  await ok(client, "import_takeoff", { path: other });
  await autosave.flush();
  const afterImport = await readJson(auto);
  assert.equal(afterImport.autosave.tool, "import_takeoff");
  assert.ok(afterImport.conditions.some((c: { finish_tag: string }) => c.finish_tag === "CAM-9"));
});

test("OPENTAKEOFF_AUTOSAVE=0 disables it: nothing is written and both replies say so", async () => {
  assert.deepEqual(autosaveModeFromEnv("0"), { kind: "off" });
  assert.deepEqual(autosaveModeFromEnv("off"), { kind: "off" });
  assert.deepEqual(autosaveModeFromEnv(undefined), { kind: "default" });
  assert.deepEqual(autosaveModeFromEnv(""), { kind: "default" });
  assert.deepEqual(autosaveModeFromEnv("1"), { kind: "default" });

  const { dir, plan } = await tmpPlan();
  const prev = process.env.OPENTAKEOFF_AUTOSAVE;
  process.env.OPENTAKEOFF_AUTOSAVE = "0";
  try {
    // the mode comes from the environment, exactly as server.ts constructs it
    const session = new Session();
    const autosave = new Autosave({ log: () => {} }).attach(session);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildServer(session, { oneClick: false }).connect(st);
    const client = new Client({ name: "autosave-off", version: "0.0.0" });
    await client.connect(ct);
    const loaded = await ok(client, "load_plan", { path: plan });
    assert.deepEqual(loaded.autosave, { path: null, disabled: true });
    assert.match(loaded.note, /Auto-save is off/);
    await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
    await autosave.idle();
    autosave.flushSync();
    assert.deepEqual(await readdir(dir), [KEY]);
    assert.deepEqual((await ok(client, "takeoff_summary")).autosave, { path: null, saved_at: null, disabled: true });
  } finally {
    if (prev === undefined) delete process.env.OPENTAKEOFF_AUTOSAVE;
    else process.env.OPENTAKEOFF_AUTOSAVE = prev;
  }
});

test("OPENTAKEOFF_AUTOSAVE=<path> writes that file; a directory takes the default name there", async () => {
  const { dir, plan } = await tmpPlan();
  const custom = path.join(dir, "bid 27 autosave.json");
  assert.deepEqual(autosaveModeFromEnv(custom), { kind: "file", path: custom });
  assert.deepEqual(autosaveModeFromEnv("rel/x.json", "/base"), { kind: "file", path: "/base/rel/x.json" });
  const { client, autosave } = await pair({ mode: autosaveModeFromEnv(custom) });
  const loaded = await ok(client, "load_plan", { path: plan });
  assert.equal(loaded.autosave.path, custom);
  await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
  await autosave.idle();
  assert.equal((await readJson(custom)).shapes.length, 1);
  assert.deepEqual((await readdir(dir)).sort(), [KEY, "bid 27 autosave.json"].sort());

  const saves = await mkdtemp(path.join(tmpdir(), "ot-autosave-dir-"));
  const mode = autosaveModeFromEnv(saves);
  assert.deepEqual(mode, { kind: "dir", path: saves });
  const b = await pair({ mode });
  assert.equal((await ok(b.client, "load_plan", { path: plan })).autosave.path, path.join(saves, "sample-plan - takeoff autosave.json"));
});

test("a file OpenTakeoff did not write is never clobbered: load_plan and takeoff_summary report it, the tool call still succeeds", async () => {
  const { plan, auto } = await tmpPlan();
  // an estimator's own notes, and (separately) a plain export_takeoff file
  // without the autosave marker — both foreign to auto-save
  for (const foreign of ["my notes — do not delete\n", null]) {
    const { client, session, autosave } = await pair();
    if (foreign !== null) await writeFile(auto, foreign);
    const loaded = await ok(client, "load_plan", { path: plan });
    if (foreign === null) {
      await writeFile(auto, JSON.stringify(session.exportPayload()));
      // re-load so load_plan sees the export at the path
      const again = await ok(client, "load_plan", { path: plan });
      assert.match(again.autosave.error, /is not an OpenTakeoff autosave/);
    } else {
      assert.match(loaded.autosave.error, /is not an OpenTakeoff autosave/);
      assert.match(loaded.note, /Auto-save is NOT writing/);
    }
    const before = await readFile(auto, "utf8");
    const r = await call(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
    assert.equal(r.isError, false, "a refused auto-save never fails the tool call");
    await autosave.idle();
    autosave.flushSync();
    assert.equal(await readFile(auto, "utf8"), before, "the foreign file is untouched");
    const s = await ok(client, "takeoff_summary");
    assert.equal(s.autosave.path, auto);
    assert.equal(s.autosave.saved_at, null);
    assert.match(s.autosave.error, /not an OpenTakeoff autosave; not overwriting it/);
  }
});

test("a failed write is surfaced, not thrown, and clears once a write succeeds", async () => {
  const { dir, plan } = await tmpPlan();
  const missing = path.join(dir, "no such folder", "x.json");
  const { client, autosave } = await pair({ mode: { kind: "file", path: missing } });
  await ok(client, "load_plan", { path: plan });
  const r = await call(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
  assert.equal(r.isError, false);
  await autosave.idle();
  const s = await ok(client, "takeoff_summary");
  assert.equal(s.autosave.path, missing);
  assert.match(s.autosave.error, /ENOENT/);
  assert.equal(s.autosave.saved_at, null);

  // the folder appears; the next change lands and the error is gone
  await mkdir(path.dirname(missing));
  await ok(client, "place_count", { sheet: KEY, points: [[400, 300]], condition: "DATA-1" });
  const s2 = await ok(client, "takeoff_summary");
  assert.equal(s2.autosave.error, undefined);
  assert.equal((await readJson(missing)).shapes.length, 2);
});

test("the autosave round-trips through import_takeoff and the app's importer", async () => {
  const { plan, auto } = await tmpPlan();
  const a = await pair();
  await ok(a.client, "load_plan", { path: plan });
  await cableWork(a.client);
  await ok(a.client, "annotate", { sheet: KEY, type: "cloud", text: "verify pathway", rect: [[500, 900], [800, 1200]] });
  await a.autosave.idle();
  const saved = await readJson(auto);
  assert.equal(saved.cable_runs.length, 1);
  assert.equal(saved.markups.length, 1, "an unjournaled annotate is saved too");

  // a fresh MCP session (no auto-save) resumes it exactly
  const s2 = new Session();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(s2, { oneClick: false }).connect(st);
  const c2 = new Client({ name: "resume", version: "0.0.0" });
  await c2.connect(ct);
  await ok(c2, "load_plan", { path: plan });
  const imp = await ok(c2, "import_takeoff", { path: auto });
  assert.equal(imp.replaced, true);
  assert.equal(JSON.stringify(s2.exportPayload()), JSON.stringify(a.session.exportPayload()));
  assert.equal(s2.cableRuns.length, 1);

  // the app's Sheet → Import takeoff: the parse gate accepts it and the
  // merge's field-by-field reads ignore the marker
  const parsed = parseTakeoffImport(await readFile(auto, "utf8")) as Record<string, unknown>;
  const empty = { schema: "opentakeoff.takeoff_canvas.v1", conditions: [], shapes: [], markups: [], sheets: [] };
  const merged = mergeTakeoffImport(empty, parsed, [KEY]) as { payload: Record<string, any>; note: { shapes_added: number } };
  assert.equal(merged.note.shapes_added, saved.shapes.length);
  assert.equal(merged.payload.cable_runs.length, 1);
});

test("load_plan names an earlier autosave without loading it; importing it resumes in place, ignoring it moves it aside", async () => {
  const { dir, plan, auto } = await tmpPlan();
  const first = await pair();
  await ok(first.client, "load_plan", { path: plan });
  await cableWork(first.client);
  await first.autosave.idle();
  const original = await readFile(auto, "utf8");
  const savedAt = JSON.parse(original).autosave.saved_at;

  // the client went away; a new session opens the same plan
  const second = await pair();
  const loaded = await ok(second.client, "load_plan", { path: plan });
  assert.deepEqual(loaded.autosave.found, { path: auto, saved_at: savedAt, tool: "link_run", plan: KEY, shapes: 3, conditions: 3, cable_runs: 1 });
  assert.match(loaded.note, /AUTO-SAVE for sample-plan\.pdf is at .* \(saved .*: 3 shapes, 3 conditions, 1 cable run\)\. It was NOT loaded\. To resume that work, call import_takeoff/);
  assert.equal(second.session.shapes.length, 0, "never imported silently");
  await second.autosave.idle();
  assert.equal(await readFile(auto, "utf8"), original, "loading did not touch it");

  await ok(second.client, "import_takeoff", { path: auto });
  await ok(second.client, "place_count", { sheet: KEY, points: [[1400, 1000]], condition: "DATA-1" });
  await second.autosave.idle();
  assert.equal((await readJson(auto)).shapes.length, 4, "resumed work is saved in place");
  assert.equal((await ok(second.client, "takeoff_summary")).autosave.moved_aside, undefined);
  assert.deepEqual((await readdir(dir)).sort(), [KEY, path.basename(auto)].sort());

  // a third session ignores the notice and starts over: the earlier work is
  // moved aside before this session's first write takes the name
  const third = await pair();
  const before = await readFile(auto, "utf8");
  assert.ok((await ok(third.client, "load_plan", { path: plan })).autosave.found);
  await ok(third.client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "CAM-1" });
  await third.autosave.idle();
  const status = (await ok(third.client, "takeoff_summary")).autosave;
  assert.ok(status.moved_aside, "moved_aside names the earlier file");
  assert.match(path.basename(status.moved_aside), /^sample-plan - takeoff autosave \(before .+\)\.json$/);
  assert.equal(await readFile(status.moved_aside, "utf8"), before);
  assert.equal((await readJson(auto)).shapes.length, 1);
});

test("exit and plan switches: flushSync writes at once, and load_plan saves the outgoing plan first", async () => {
  const { plan, auto } = await tmpPlan();
  const { client, session, autosave } = await pair({ debounceMs: 60_000, maxWaitMs: 60_000 });
  await ok(client, "load_plan", { path: plan });
  await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
  // the process is exiting: no timer will fire, the exit hook writes synchronously
  autosave.flushSync();
  assert.equal((await readJson(auto)).shapes.length, 1);

  await ok(client, "place_count", { sheet: KEY, points: [[400, 300]], condition: "DATA-1" });
  const other = await tmpPlan("ot-autosave-b-");
  const loaded = await ok(client, "load_plan", { path: other.plan });
  assert.equal(loaded.autosave.path, other.auto);
  assert.equal((await readJson(auto)).shapes.length, 2, "the outgoing plan's last change landed in its own file");
  assert.equal(session.shapes.length, 0);
  autosave.flushSync();
  await assert.rejects(stat(other.auto), "the new plan has no changes yet, so no file");
});

test("merge keeps the primary plan's autosave path", async () => {
  const { dir, plan, auto } = await tmpPlan();
  const second = path.join(dir, "addendum.pdf");
  await copyFile(PLAN, second);
  const { client, autosave } = await pair();
  await ok(client, "load_plan", { path: plan });
  const merged = await ok(client, "load_plan", { path: second, merge: true });
  assert.equal(merged.autosave.path, auto);
  assert.match(merged.note, /Auto-save still writes to/);
  await ok(client, "place_count", { sheet: "addendum.pdf", points: [[300, 300]], condition: "DATA-1" });
  await autosave.idle();
  assert.equal((await readJson(auto)).shapes[0].sheet_id, "addendum.pdf");
});

test("a Session with no Autosave attached writes nothing and its replies are unchanged", async () => {
  const { dir, plan } = await tmpPlan();
  const s = new Session();
  const loaded = await s.loadPlan(plan);
  assert.equal("autosave" in loaded, false);
  assert.equal(loaded.note, "Replaced the previous session — all prior scales, conditions, and shapes were cleared.");
  s.placeCount(KEY, [[300, 300]], { condition: "DATA-1" });
  assert.equal("autosave" in s.summary(), false);
  assert.deepEqual(await readdir(dir), [KEY]);
});

// The real stdio server, as a client launches it: the last change is on disk
// when the process goes, whether the client closes stdin or sends SIGTERM —
// both inside the debounce window, so only the exit hook can have written it.
for (const how of ["stdin closed", "SIGTERM"] as const) {
  test(`the stdio server writes the last change when it exits (${how})`, { timeout: 60_000 }, async () => {
    const { plan, auto } = await tmpPlan();
    const server = fileURLToPath(new URL("../server.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", server],
      cwd: path.dirname(server),
      env: { ...process.env, OPENTAKEOFF_AUTOSAVE: "1" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "autosave-exit", version: "0.0.0" });
    await client.connect(transport);
    const loaded = await ok(client, "load_plan", { path: plan });
    assert.equal(loaded.autosave.path, auto);
    await ok(client, "place_count", { sheet: KEY, points: [[300, 300]], condition: "DATA-1" });
    const pid = transport.pid as number;
    const exited = new Promise<void>((resolve) => {
      const poll = setInterval(() => { try { process.kill(pid, 0); } catch { clearInterval(poll); resolve(); } }, 20);
    });
    if (how === "SIGTERM") process.kill(pid, "SIGTERM");
    else await transport.close();
    await exited;
    const doc = await readJson(auto);
    assert.equal(doc.shapes.length, 1);
    assert.equal(doc.autosave.tool, "place_count");
    if (how === "SIGTERM") await transport.close();
  });
}
