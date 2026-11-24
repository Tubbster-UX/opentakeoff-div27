// The D-Tools client against the fake D-Tools API (test/dtoolsFake.ts):
// auth headers on every request, retries on 429 honoring Retry-After,
// no retry of a create after a 5xx, pagination, errors that never carry the
// key, and the config loader. Invented data and credentials only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DtoolsClient, DtoolsError, retryAfterMs } from "../src/dtools/client.ts";
import { loadDtoolsConfig } from "../src/dtools/config.ts";
import { FakeDtools, FAKE_KEY, FAKE_PASS } from "./dtoolsFake.ts";

test("dtools client: auth on every request, 429 retried with Retry-After then succeeds, create not retried after 500", async () => {
  const fake = await new FakeDtools().start();
  try {
    fake.clients.push({ id: randomUUID(), name: "Invented Dental", number: "C-1", isActive: true });
    const waits: number[] = [];
    const c = new DtoolsClient(fake.config(), { sleep: async (ms) => { waits.push(ms); }, baseDelayMs: 10 });

    fake.failures.set("Clients/GetClients", { status: 429, count: 2, retryAfter: "3" });
    const r = await c.getClients({ search: "dental" });
    assert.equal(r.clients?.[0].name, "Invented Dental");
    assert.equal(fake.callsTo("Clients/GetClients").length, 3, "two 429s then the answer");
    assert.deepEqual(waits, [3000, 3000], "Retry-After seconds honored");
    assert.equal(fake.unauthorized, 0, "X-API-Key and Basic auth on every attempt");

    // 503 without Retry-After: exponential backoff
    waits.length = 0;
    fake.failures.set("Clients/GetClient", { status: 503, count: 2 });
    await c.getClient(fake.clients[0].id);
    assert.equal(waits.length, 2);
    assert.ok(waits[1] > waits[0], `backoff grows: ${waits.join(", ")}`);

    // a create is not sent twice after a 5xx
    fake.failures.set("Clients/CreateClient", { status: 500, count: 1 });
    await assert.rejects(c.createClient({ name: "Invented Ortho" }), (e: unknown) => e instanceof DtoolsError && e.status === 500);
    assert.equal(fake.callsTo("Clients/CreateClient").length, 1);
    assert.equal(fake.clients.length, 1);
    // ...but is retried after a 429 (not processed)
    fake.failures.set("Clients/CreateClient", { status: 429, count: 1, retryAfter: "0" });
    const id = await c.createClient({ name: "Invented Ortho" });
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(fake.clients.length, 2);

    // gives up after maxRetries
    const c2 = new DtoolsClient(fake.config(), { sleep: async () => {}, maxRetries: 1 });
    fake.failures.set("Products/GetProducts", { status: 429, count: 5 });
    await assert.rejects(c2.getProducts(), (e: unknown) => e instanceof DtoolsError && e.status === 429 && /429/.test(e.message));
  } finally {
    await fake.stop();
  }
});

test("dtools client: pagination walks pages until the total; errors never echo the key", async () => {
  const fake = await new FakeDtools().start();
  try {
    for (let i = 1; i <= 45; i++) fake.products.push({ id: randomUUID(), brand: "Invented Co", model: `M-${i}`, isLengthBased: false, isActive: true });
    const c = fake.client();
    const all = await c.paginate("Products/GetProducts", "products", { search: "invented" }, { pageSize: 20 });
    assert.equal(all.length, 45);
    const calls = fake.callsTo("Products/GetProducts");
    assert.deepEqual(calls.map((x) => [x.query.page, x.query.pageSize]), [["1", "20"], ["2", "20"], ["3", "20"]]);
    const capped = await c.paginate("Products/GetProducts", "products", {}, { pageSize: 20, maxItems: 25 });
    assert.equal(capped.length, 25);

    // a wrong key: 401, and neither the key nor the password is in the message
    const bad = fake.client({ apiKey: "wrong-fake-key-1234" });
    await assert.rejects(bad.getClients(), (e: unknown) => {
      assert.ok(e instanceof DtoolsError);
      assert.equal(e.status, 401);
      assert.ok(!e.message.includes("wrong-fake-key-1234") && !e.message.includes(FAKE_KEY) && !e.message.includes(FAKE_PASS), e.message);
      return true;
    });
    // a server that echoes the key back has it scrubbed
    const echo = new DtoolsClient(fake.config(), {
      fetch: (async () => new Response(JSON.stringify({ title: `bad key ${FAKE_KEY}` }), { status: 400 })) as typeof fetch,
      sleep: async () => {},
    });
    await assert.rejects(echo.getClients(), (e: unknown) => e instanceof DtoolsError && !e.message.includes(FAKE_KEY) && /\*\*\*/.test(e.message));
    // 404 is reported as notFound
    await assert.rejects(c.getProduct(randomUUID()), (e: unknown) => e instanceof DtoolsError && e.notFound);
  } finally {
    await fake.stop();
  }
});

test("dtools config: null without DTOOLS_API_KEY; reads the Basic values and the webhook token; Retry-After parsing", () => {
  assert.equal(loadDtoolsConfig({}), null);
  assert.equal(loadDtoolsConfig({ DTOOLS_API_KEY: "  " }), null);
  const cfg = loadDtoolsConfig({ DTOOLS_API_KEY: "k-fake", DTOOLS_BASIC_USER: "u-fake", DTOOLS_BASIC_PASSWORD: "p-fake", DTOOLS_WEBHOOK_TOKEN: "t-fake" })!;
  assert.deepEqual([cfg.baseUrl, cfg.apiKey, cfg.basicUser, cfg.basicPassword, cfg.webhookToken], ["https://dtcloudapi.d-tools.cloud/api/v1", "k-fake", "u-fake", "p-fake", "t-fake"]);
  assert.throws(() => loadDtoolsConfig({ DTOOLS_API_KEY: "k", DTOOLS_BASE_URL: "ftp://x" }));
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now())! > 3000, true);
  assert.equal(retryAfterMs(null), null);
});
