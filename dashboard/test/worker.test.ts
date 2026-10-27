// Runs the real Worker + Durable Object in workerd (`wrangler dev`) with the
// relay pointed at a mock Supabase Realtime server, and checks the fan-out
// path end to end: browser socket -> DO -> realtime-js upstream -> mock push
// -> routed change on the right sockets only.
//
// With DASHBOARD_TEST_DATABASE_URL set (a Postgres that brink-merge has
// imported a project into), it also reads /api/projects and a snapshot
// through the Hyperdrive binding.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage, Snapshot } from "../src/shared/protocol.js";
import { startMockRealtime, type MockRealtime } from "./mock-realtime.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_URL = process.env.DASHBOARD_TEST_DATABASE_URL;
const P = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const I1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let mock: MockRealtime;
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
  constructor(projectId: string) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}/api/projects/${projectId}/live`);
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
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  if (!existsSync(join(ROOT, "dist"))) mkdirSync(join(ROOT, "dist"));
  if (!existsSync(join(ROOT, "dist/index.html"))) writeFileSync(join(ROOT, "dist/index.html"), "<!doctype html><title>test</title>");
  wrangler = spawn(
    process.execPath,
    [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(await freePort()),
      "--var", `SUPABASE_URL:${mock.url}`, "--var", "SUPABASE_SERVICE_ROLE_KEY:test-service-key", "--persist-to", join(ROOT, ".wrangler/test-state")],
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
});

describe("worker", () => {
  it("is read-only and validates ids", async () => {
    expect((await fetch(`${base}/api/projects`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/projects/not-a-uuid`)).status).toBe(400);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true, realtime: true });
  });

  it("never hands the service key to the browser", async () => {
    const html = await (await fetch(`${base}/p/${P}`)).text();
    expect(html).not.toContain("test-service-key");
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

  it("closes the upstream when the last browser leaves", async () => {
    const end = Date.now() + 10_000;
    while (mock.joined() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(mock.joined()).toBe(0);
  }, 15_000);
});

describe.skipIf(!DB_URL)("read API over Hyperdrive (DASHBOARD_TEST_DATABASE_URL)", () => {
  it("lists projects and reads a consistent snapshot", async () => {
    const projects = (await (await fetch(`${base}/api/projects`)).json()) as { id: string; current_import_id: string }[];
    expect(projects.length).toBeGreaterThan(0);
    const p = projects[0]!;
    const snap = (await (await fetch(`${base}/api/projects/${p.id}`)).json()) as Snapshot;
    expect(snap.import?.id).toBe(p.current_import_id);
    expect(snap.bom.length).toBeGreaterThan(0);
    expect(snap.nodes.some((n) => n.node_type === "device")).toBe(true);
    for (const rows of [snap.bom, snap.issues, snap.nodes, snap.connections]) for (const r of rows) expect(r.import_id).toBe(p.current_import_id);
    expect(JSON.stringify(snap)).not.toMatch(/"(takeoff|report|node|edge|line)":/);
    expect((await fetch(`${base}/api/projects/${OTHER}`)).status).toBe(404);
  });
});
