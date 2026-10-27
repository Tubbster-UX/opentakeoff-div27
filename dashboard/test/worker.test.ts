// Runs the real Worker + Durable Object in workerd (`wrangler dev`) with the
// relay pointed at a mock Supabase Realtime server, and checks the fan-out
// path end to end: browser socket -> DO -> realtime-js upstream -> mock push
// -> routed change on the right sockets only.
//
// With DASHBOARD_TEST_DATABASE_URL set (a Postgres that brink-merge has
// imported a project into), it also reads /api/projects and a snapshot
// through the Hyperdrive binding, and writes schematic edits through it.
//
// Access is configured against a local stand-in team (test/access-keys.ts), with
// the dev bypass variable ALSO set, to prove a configuration with Access never
// takes the bypass.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ProjectList, ServerMessage, Snapshot } from "../src/shared/protocol.js";
import { summarize } from "../src/shared/state.js";
import { Client as PgClient } from "pg";
import type { EditResponse, SchematicView } from "../src/shared/protocol.js";
import { startTestTeam, type TestTeam } from "./access-keys.js";
import { startMockRealtime, type MockRealtime } from "./mock-realtime.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_URL = process.env.DASHBOARD_TEST_DATABASE_URL;
const P = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const I1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let mock: MockRealtime;
let team: TestTeam;
let wrangler: ChildProcess;
let base: string;
let output = "";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

class Client {
  readonly messages: ServerMessage[] = [];
  readonly ws: WebSocket;
  /** A project id, or "list" for the project-list socket. */
  constructor(projectId: string) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}${projectId === "list" ? "/api/live" : `/api/projects/${projectId}/live`}`);
    this.ws.on("message", (d) => this.messages.push(JSON.parse(String(d))));
  }
  open(): Promise<void> {
    return new Promise((r, j) => {
      this.ws.once("open", () => r());
      this.ws.once("error", j);
    });
  }
  watch(importId: string | null): void {
    this.ws.send(JSON.stringify({ type: "watch", importId }));
  }
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 10_000): Promise<ServerMessage> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.messages.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(this.messages)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  changes() {
    return this.messages.filter((m) => m.type === "change");
  }
}

beforeAll(async () => {
  mock = await startMockRealtime();
  team = await startTestTeam();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  if (!existsSync(join(ROOT, "dist"))) mkdirSync(join(ROOT, "dist"));
  if (!existsSync(join(ROOT, "dist/index.html"))) writeFileSync(join(ROOT, "dist/index.html"), "<!doctype html><title>test</title>");
  wrangler = spawn(
    process.execPath,
    [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort()),
      "--var", `SUPABASE_URL:${mock.url}`, "--var", "SUPABASE_SERVICE_ROLE_KEY:test-service-key",
      "--var", `ACCESS_TEAM_DOMAIN:${team.url}`, "--var", `ACCESS_AUD:${team.aud}`, "--var", "DEV_ONLY_ACCESS_BYPASS_EMAIL:bypass@brink.test",
      "--persist-to", join(ROOT, ".wrangler/test-state")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DB_URL ?? "postgres://nobody:nothing@127.0.0.1:1/none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  wrangler.stdout!.on("data", (d) => (output += d));
  wrangler.stderr!.on("data", (d) => (output += d));
  const end = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`wrangler dev did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 90_000);

afterAll(async () => {
  wrangler?.kill("SIGTERM");
  await mock?.close();
  await team?.close();
});

const editsUrl = (p: string) => `${base}/api/projects/${p}/schematic/edits`;
const postEdits = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(editsUrl(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("worker", () => {
  it("reads are GET-only, the one write route needs an identity, and ids are validated", async () => {
    const post = await fetch(`${base}/api/projects`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect((await fetch(`${base}/api/projects/${P}`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/api/projects/${P}/schematic`, { method: "POST" })).status).toBe(405);
    expect((await fetch(editsUrl(P))).headers.get("allow")).toBe("POST");
    // The write route: same-origin JSON from a verified Access identity only.
    const body = { importId: I1, clientRef: "test-client-1", ops: [{ kind: "rename", target: "x", payload: { label: "y" } }] };
    expect((await postEdits(P, body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(editsUrl(P), { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const anon = await postEdits(P, body);
    expect(anon.status).toBe(401); // the dev bypass variable is set, but Access is configured: no bypass
    expect((await anon.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/no Cloudflare Access identity/) });
    expect((await postEdits(P, body, { "cf-access-jwt-assertion": await team.token({ aud: ["another-app"] }) })).status).toBe(401);
    // Identified, but the body is checked before the database is touched.
    const token = await team.token();
    expect((await postEdits(P, { ...body, ops: [] }, { "cf-access-jwt-assertion": token })).status).toBe(400);
    expect((await postEdits(P, { ...body, importId: "nope" }, { "cf-access-jwt-assertion": token })).status).toBe(400);
    expect((await postEdits("not-a-uuid", body, { "cf-access-jwt-assertion": token })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${base}/api/nothing-here`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true, realtime: true });
  });

  it("GET /api/me is the verified Access identity", async () => {
    expect(await (await fetch(`${base}/api/me`)).json()).toMatchObject({ email: null, auth: null, error: expect.stringMatching(/no Cloudflare Access identity/) });
    const me = await fetch(`${base}/api/me`, { headers: { "cf-access-jwt-assertion": await team.token({ email: "Sam@Brink.test" }) } });
    expect(await me.json()).toEqual({ email: "sam@brink.test", auth: "cloudflare-access" });
    expect(await (await fetch(`${base}/api/me`, { headers: { "cf-access-jwt-assertion": await team.token({ exp: 1 }) } })).json()).toMatchObject({ email: null, error: expect.stringMatching(/expired/) });
  });

  it("serves the app shell for client-side routes and never hands the service key to the browser", async () => {
    for (const path of ["/", `/projects/${P}`, `/projects/${P}/schematic`, `/p/${P}`, `/es-frame.html?project=${P}`]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).not.toContain("test-service-key");
    }
  });
});

describe("relay fan-out (mock Supabase Realtime)", () => {
  it("subscribes once with the service key and routes changes per project and import", async () => {
    const a = new Client(P);
    const b = new Client(P);
    const other = new Client(OTHER);
    await Promise.all([a.open(), b.open(), other.open()]);
    a.watch(I1);
    b.watch(I1);
    other.watch(I2);
    await mock.waitJoined(1);
    await a.waitFor((m) => m.type === "status" && m.upstream === "live");

    // One upstream connection for all three browsers, keyed with the service key.
    expect(mock.joined()).toBe(1);
    expect(mock.connects).toHaveLength(1);
    expect(mock.connects[0]!.get("apikey")).toBe("test-service-key");

    // A child row of import I1 reaches both P sockets, not the other project.
    mock.push("brink_bom_lines", "UPDATE", { import_id: I1, line_no: 2, qty: "11", line: { heavy: true } });
    const got = await a.waitFor((m) => m.type === "change");
    await b.waitFor((m) => m.type === "change");
    expect(got).toEqual({
      type: "change",
      change: { table: "brink_bom_lines", type: "UPDATE", record: { import_id: I1, line_no: 2, qty: 11 }, old: null, commitTimestamp: expect.any(String) },
    });

    // The project moves to import I2: sockets on P are re-pointed and told.
    mock.push("brink_projects", "UPDATE", { id: P, name: "Invented", current_import_id: I2 });
    await a.waitFor((m) => m.type === "change" && m.change.table === "brink_projects");
    mock.push("brink_issues", "DELETE", null, { import_id: I2, seq: 4 });
    await a.waitFor((m) => m.type === "change" && m.change.table === "brink_issues");
    await b.waitFor((m) => m.type === "change" && m.change.table === "brink_issues");
    // `other` watches I2 too, but for another project; it receives the I2 issue (it shows that import) and nothing of P's.
    await other.waitFor((m) => m.type === "change" && m.change.table === "brink_issues");
    expect(other.changes().map((m) => m.type === "change" && m.change.table)).toEqual(["brink_issues"]);

    // A row for the old import no longer reaches P's sockets.
    mock.push("brink_bom_lines", "UPDATE", { import_id: I1, line_no: 2, qty: 12 });
    mock.push("brink_schematic_connections", "INSERT", { import_id: I2, seq: 1, edge_id: "e1", cable_length_ft: "40.5", edge: {} });
    await a.waitFor((m) => m.type === "change" && m.change.table === "brink_schematic_connections");
    expect(a.changes().filter((m) => m.type === "change" && m.change.table === "brink_bom_lines")).toHaveLength(1);

    for (const c of [a, b, other]) c.ws.close();
  }, 30_000);

  it("tells the project-list socket which tables changed, coalesced, and sends it no rows", async () => {
    const list = new Client("list");
    const page = new Client(P);
    await Promise.all([list.open(), page.open()]);
    page.watch(I1);
    await list.waitFor((m) => m.type === "status" && m.upstream === "live");
    await mock.waitJoined(1);

    for (let i = 0; i < 20; i++) mock.push("brink_bom_lines", "INSERT", { import_id: I1, line_no: 100 + i, qty: 1 });
    mock.push("brink_projects", "UPDATE", { id: OTHER, name: "Other", current_import_id: I2 });
    const touch = await list.waitFor((m) => m.type === "touch");
    await new Promise((r) => setTimeout(r, 600));
    const touches = list.messages.filter((m) => m.type === "touch");
    // 21 changes inside one coalescing window: one or two touches, never 21.
    expect(touches.length).toBeLessThanOrEqual(2);
    expect(new Set(touches.flatMap((m) => (m.type === "touch" ? m.tables : [])))).toEqual(new Set(["brink_bom_lines", "brink_projects"]));
    expect(touch.type === "touch" && touch.tables).toContain("brink_bom_lines");
    expect(list.changes()).toHaveLength(0);
    // The project page still gets its rows.
    await page.waitFor((m) => m.type === "change" && m.change.table === "brink_bom_lines" && m.change.record?.line_no === 119);

    list.ws.close();
    page.ws.close();
  }, 30_000);

  it("closes the upstream when the last browser leaves", async () => {
    const end = Date.now() + 10_000;
    while (mock.joined() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(mock.joined()).toBe(0);
  }, 15_000);
});

describe.skipIf(!DB_URL)("read API over Hyperdrive (DASHBOARD_TEST_DATABASE_URL)", () => {
  it("lists projects with totals and reads a consistent snapshot", async () => {
    const list = (await (await fetch(`${base}/api/projects`)).json()) as ProjectList;
    expect(list.projects.length).toBeGreaterThan(0);
    // CI's database has only brink-merge's init migration: no Portal push table, and that is not an error.
    expect(typeof list.features.portalPushes).toBe("boolean");
    const p = list.projects.find((x) => x.name === "Brink Div 27 sample (invented)") ?? list.projects[0]!;
    const snap = (await (await fetch(`${base}/api/projects/${p.id}`)).json()) as Snapshot;
    expect(snap.import?.id).toBe(p.current_import_id);
    expect(snap.bom.length).toBeGreaterThan(0);
    expect(snap.nodes.some((n) => n.node_type === "device")).toBe(true);
    for (const rows of [snap.bom, snap.issues, snap.nodes, snap.connections]) for (const r of rows) expect(r.import_id).toBe(p.current_import_id);
    expect(JSON.stringify(snap)).not.toMatch(/"(takeoff|report|node|edge|line)":/);
    expect((await fetch(`${base}/api/projects/${OTHER}`)).status).toBe(404);

    // The list's SQL totals agree with the page's own totals over the snapshot rows.
    const sum = summarize(snap);
    expect({ devices: p.devices, trs: p.trs, cables: p.cables, netLf: p.net_lf, orderLf: p.order_lf }).toEqual(sum.bom);
    expect({ errors: p.errors, warnings: p.warnings, bomLines: p.bom_lines }).toEqual({ errors: sum.errors, warnings: sum.warnings, bomLines: sum.bomLines });
    if (p.name === "Brink Div 27 sample (invented)") {
      // What brink-merge's CLI prints for this fixture (brink-merge/README.md).
      expect(sum.bom).toMatchObject({ devices: 16, cables: 23, netLf: 1795.13, orderLf: 2007.79 });
    }
  });
});

describe.skipIf(!DB_URL)("schematic edits over Hyperdrive (DASHBOARD_TEST_DATABASE_URL)", () => {
  const PROJECT = "Brink Div 27 sample (invented)";
  let pid: string;
  let view: SchematicView;
  let pg: PgClient;
  const auth = async (email = "alex@brink.test") => ({ "cf-access-jwt-assertion": await team.token({ email }) });

  beforeAll(async () => {
    const list = (await (await fetch(`${base}/api/projects`)).json()) as ProjectList;
    pid = (list.projects.find((x) => x.name === PROJECT) ?? list.projects[0]!).id;
    pg = new PgClient({ connectionString: DB_URL });
    await pg.connect();
  });
  afterAll(() => pg?.end());

  const read = async () => (await (await fetch(`${base}/api/projects/${pid}/schematic`)).json()) as SchematicView;

  it("serves the schematic as rows + edit layer, and saves an edit under the Access email", async () => {
    view = await read();
    const nodes = view.file.nodes as { id: string; type: string; data: { label: string } }[];
    const dev = nodes.find((n) => n.id.startsWith("dev-"))!;
    expect(dev).toBeTruthy();
    const active = view.edits.find((e) => e.target_key === dev.id && e.kind === "rename")?.id ?? null;
    const label = `Renamed ${Date.now()}`;
    const res = await postEdits(pid, { importId: view.import_id, clientRef: "test-client-1", ops: [{ kind: "rename", target: dev.id, payload: { label }, expect: active }] }, await auth("Alex@Brink.test"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as EditResponse;
    expect(out.editor).toBe("alex@brink.test");
    expect(out.results[0]).toMatchObject({ i: 0, status: "saved", edit: { target_key: dev.id, kind: "rename", editor_email: "alex@brink.test" }, superseded: active });
    const saved = out.results[0]!.status === "saved" ? out.results[0]!.edit.id : "";
    const row = (await pg.query("select editor_email, editor_auth, client_ref, base_import_id, payload from brink_schematic_edits where id = $1", [saved])).rows[0];
    expect(row).toEqual({ editor_email: "alex@brink.test", editor_auth: "cloudflare-access", client_ref: "test-client-1", base_import_id: view.import_id, payload: { label } });
    const after = await read();
    expect((after.file.nodes as { id: string; data: { label: string } }[]).find((n) => n.id === dev.id)!.data.label).toBe(label);

    // Someone saved since this editor last looked: the stale op is a conflict, the saved edit wins.
    const stale = (await (await postEdits(pid, { importId: view.import_id, clientRef: "test-client-2", ops: [{ kind: "rename", target: dev.id, payload: { label: "stale" }, expect: active }] }, await auth("sam@brink.test"))).json()) as EditResponse;
    expect(stale.results[0]).toMatchObject({ status: "conflict", current: { id: saved, editor_email: "alex@brink.test" } });
    // Targets that do not exist, and ops the layer does not take, are refused one by one.
    const bad = (await (await postEdits(pid, { importId: view.import_id, clientRef: "test-client-2", ops: [
      { kind: "rename", target: "dev-shp-nope-1", payload: { label: "x" } },
      { kind: "move", target: dev.id, payload: { x: 1, y: 2, parent: "room-nope-00000000" }, expect: view.edits.find((e) => e.target_key === dev.id && e.kind === "move")?.id ?? null },
      { kind: "property", target: dev.id, payload: {} },
      { kind: "disconnect", target: "cable-nope", payload: {} },
    ] }, await auth())).json()) as EditResponse;
    expect(bad.results.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    // A request built on an older import is refused as a whole.
    const old = await postEdits(pid, { importId: I1, clientRef: "test-client-2", ops: [{ kind: "rename", target: dev.id, payload: { label: "x" }, expect: saved }] }, await auth());
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ currentImportId: view.import_id });
    // Revert: the generated label comes back.
    const rev = (await (await postEdits(pid, { importId: view.import_id, clientRef: "test-client-1", ops: [{ kind: "revert", edit: saved }] }, await auth())).json()) as EditResponse;
    expect(rev.results[0]).toEqual({ i: 0, status: "reverted", edit: saved });
    expect((await pg.query("select reverted_by from brink_schematic_edits where id = $1", [saved])).rows[0]).toEqual({ reverted_by: "alex@brink.test" });
  });
});
