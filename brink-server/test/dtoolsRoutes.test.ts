// The owner's D-Tools routes (pending price approvals) and the D-Tools webhook
// receiver, mounted with mountDtools against the fake D-Tools API. Invented
// records, keys and tokens only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { FsStorage } from "../src/storage.ts";
import { StoreProjects } from "../src/projects.ts";
import { DtoolsStore, LOG_KEY } from "../src/dtools/store.ts";
import { dtoolsWebhook, mountDtools, parseWebhook } from "../src/dtoolsRoutes.ts";
import type { AppDeps } from "../src/types.ts";
import { FakeDtools, FAKE_KEY, FAKE_PASS, FAKE_USER, inventedQuote } from "./dtoolsFake.ts";

const TOKEN = "fake-webhook-token-0123456789";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test("owner price approvals apply through the D-Tools API and log; reject; a failure stays pending; the webhook re-reads and refreshes the cache", async () => {
  const fake = await new FakeDtools().start();
  const root = await mkdtemp(path.join(tmpdir(), "brink-dtools-routes-"));
  const storage = new FsStorage(path.join(root, "store"));
  const projects = new StoreProjects(storage);
  const deps = { storage, projects } as unknown as AppDeps;
  const store = new DtoolsStore(storage, projects);
  const app = express();
  const api = express.Router();
  api.use(express.json());
  const { webhook } = mountDtools(app, api, deps, { DTOOLS_API_KEY: FAKE_KEY, DTOOLS_BASIC_USER: FAKE_USER, DTOOLS_BASIC_PASSWORD: FAKE_PASS, DTOOLS_BASE_URL: `${fake.url}/api/v1`, DTOOLS_WEBHOOK_TOKEN: TOKEN });
  app.use("/api", api);
  const srv = await listen(app);
  const req = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${srv.url}${p}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  try {
    const prod = randomUUID();
    fake.products.push({ id: prod, brand: "Invented Wireless", model: "AP-9", msrp: 800, unitCost: 410, unitPrice: 600, isLengthBased: false, isActive: true });
    const [a, b] = await store.addPending([
      { productId: prod, brand: "Invented Wireless", model: "AP-9", old: { msrp: 800, unitCost: 410, unitPrice: 600 }, new: { unitCost: 395, unitPrice: 585 }, source: "https://distributor.invalid/ap9", date: "2026-11-24" },
      { productId: prod, brand: "Invented Wireless", model: "AP-9", old: { msrp: 800, unitCost: 410, unitPrice: 600 }, new: { msrp: 900 }, source: "https://distributor.invalid/ap9-msrp", date: "2026-11-24" },
    ]);

    const list = await req("GET", "/api/dtools/pending-prices?status=pending");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries.length, 2);

    // D-Tools refuses: it stays pending with the error
    fake.failures.set("Products/UpdateProductPrices", { status: 400, count: 1 });
    const f1 = await req("POST", `/api/dtools/pending-prices/${a.id}/approve`);
    assert.equal(f1.status, 502);
    assert.match(f1.body.message, /still pending/);
    assert.ok(!JSON.stringify(f1.body).includes(FAKE_KEY));
    const afterFail = (await store.listPending()).find((x) => x.id === a.id)!;
    assert.equal(afterFail.status, "pending");
    assert.match(afterFail.error!, /400/);

    // the owner approves: applied through UpdateProductPrices, untouched fields sent back as they were
    const ok1 = await req("POST", `/api/dtools/pending-prices/${a.id}/approve`);
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    assert.equal(ok1.body.entry.status, "applied");
    assert.equal(ok1.body.entry.error, undefined);
    const p = fake.products[0];
    assert.deepEqual([p.msrp, p.unitCost, p.unitPrice], [800, 395, 585]);
    assert.deepEqual(fake.callsTo("Products/UpdateProductPrices").at(-1)!.body, [{ id: prod, msrp: 800, unitCost: 395, unitPrice: 585 }]);
    const applied = (await store.readLog()).find((e) => e.action === "apply_price")!;
    assert.deepEqual([applied.actor, applied.entity, applied.id], ["owner", "product", prod]);
    assert.deepEqual(applied.before, { unitCost: 410, unitPrice: 600 });
    assert.deepEqual(applied.after, { unitCost: 395, unitPrice: 585 });
    assert.equal((await req("POST", `/api/dtools/pending-prices/${a.id}/approve`)).status, 409);

    // reject
    const rj = await req("POST", `/api/dtools/pending-prices/${b.id}/reject`);
    assert.equal(rj.body.entry.status, "rejected");
    assert.equal(fake.products[0].msrp, 800);
    assert.equal((await store.readLog())[0].action, "reject_price");
    assert.equal((await req("POST", "/api/dtools/pending-prices/pp-000000/approve")).status, 404);

    const st = await req("GET", "/api/dtools/status");
    assert.deepEqual([st.body.connected, st.body.webhook, st.body.pendingPrices], [true, true, 0]);

    // ── webhook ──
    const proj = await projects.create({ name: "Invented Webhook Job" });
    const oppId = randomUUID();
    fake.opportunities.push({ id: oppId, clientId: randomUUID(), name: "Invented Webhook Opp", stage: "New", price: 0 });
    const quote = inventedQuote(oppId);
    fake.quotes.push(quote);
    await store.setLinks(proj.id, { opportunityId: oppId, quoteId: quote.id });

    const payload = { ApiKey: "payload-key-must-not-be-logged", Type: "Update", Module: "Quote", Ids: [quote.id], UpdatedOn: "2026-11-24T10:00:00Z" };
    assert.equal((await req("POST", "/webhooks/dtools", payload)).status, 401);
    assert.equal((await req("POST", "/webhooks/dtools", payload, { authorization: "Bearer wrong-token" })).status, 401);
    assert.equal((await req("POST", "/webhooks/dtools", "not json", { authorization: `Bearer ${TOKEN}` })).status, 400);
    const before = fake.calls.length;
    const w = await req("POST", "/webhooks/dtools", payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(w.status, 202);
    await webhook.idle();
    assert.ok(fake.calls.slice(before).some((c) => c.path === "Quotes/GetQuote"), "re-read through the API");
    const cachedQuote = await store.getCache(proj.id, "quote");
    assert.equal(cachedQuote?.id, quote.id);
    assert.equal((await store.getCache(proj.id, "opportunity"))?.id, oppId);
    const wl = (await store.readLog({ project: proj.id }))[0];
    assert.deepEqual([wl.actor, wl.action, wl.entity], ["webhook", "sync", "quote"]);
    assert.match(wl.note!, /Update Quote/);
    assert.ok(!Buffer.from((await storage.getBytes(LOG_KEY))!).toString("utf8").includes("payload-key-must-not-be-logged"), "the payload's ApiKey is never stored");

    // a second change: the webhook's sync reports it
    quote.items[0].quantity = 7;
    await req("POST", "/webhooks/dtools", { type: "updated", module: "quotes", ids: [quote.id] }, { authorization: `Bearer ${TOKEN}` });
    await webhook.idle();
    assert.match((await store.readLog({ project: proj.id }))[0].note!, /qty 2 → 7/);

    // an opportunity no project links: logged, nothing refreshed
    await req("POST", "/webhooks/dtools", { Module: "Opportunity", Type: "Create", Ids: [randomUUID()] }, { authorization: `Bearer ${TOKEN}` });
    await webhook.idle();
    assert.match((await store.readLog())[0].note!, /no project here is linked/);
  } finally {
    await srv.close();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("dtools webhook: 503 without a token, rate-limited, tolerant parsing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-dtools-wh-"));
  const storage = new FsStorage(path.join(root, "store"));
  const deps = { storage, projects: new StoreProjects(storage) } as unknown as AppDeps;
  const app = express();
  const wa = dtoolsWebhook(deps, null, { token: null });
  const wb = dtoolsWebhook(deps, null, { token: TOKEN, perIpPerMinute: 2 });
  app.use("/a", wa);
  app.use("/b", wb);
  const srv = await listen(app);
  try {
    const post = (p: string) => fetch(`${srv.url}${p}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" });
    assert.equal((await post("/a/webhooks/dtools")).status, 503);
    assert.deepEqual([(await post("/b/webhooks/dtools")).status, (await post("/b/webhooks/dtools")).status, (await post("/b/webhooks/dtools")).status], [202, 202, 429]);
    assert.deepEqual(parseWebhook({ ApiKey: "x", Type: "Update", Module: "Project", Ids: ["a1b2", "a1b2", "../etc"], UpdatedOn: "2026-11-24" }), { module: "Project", type: "Update", ids: ["a1b2"], updatedOn: "2026-11-24" });
    assert.deepEqual(parseWebhook([{ entity: "Opportunity", event: "created", id: "abc-1" }]), { module: "Opportunity", type: "created", ids: ["abc-1"], updatedOn: null });
    assert.deepEqual(parseWebhook("nonsense"), { module: null, type: null, ids: [], updatedOn: null });
    await wb.idle();
    assert.match(Buffer.from((await storage.getBytes(LOG_KEY))!).toString("utf8"), /D-Tools not connected, nothing re-read/);
  } finally {
    await srv.close();
    await rm(root, { recursive: true, force: true });
  }
});
