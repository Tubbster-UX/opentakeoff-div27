// The D-Tools routes as mounted in the real app (http.ts): the webhook is
// reachable without the owner's cookie but only with its own Bearer token;
// the price-approval routes need the owner. No real D-Tools call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, login, sessionCookie } from "./fakes.ts";

test("mounted D-Tools routes: webhook needs its token (not the owner), approvals need the owner", async () => {
  process.env.DTOOLS_WEBHOOK_TOKEN = "test-webhook-token-0123456789abcdef";
  const t = await startServer();
  try {
    const hook = (auth?: string) => fetch(`${t.url}/webhooks/dtools`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ Type: "Update", Module: "Project", Ids: ["x"] }) });
    const noTok = await hook();
    assert.notEqual(noTok.status, 302, "the webhook does not bounce to the owner login");
    assert.ok(noTok.status === 401 || noTok.status === 403, `no token refused (got ${noTok.status})`);
    assert.ok([401, 403].includes((await hook("Bearer wrong")).status), "wrong token refused");
    const ok = await hook("Bearer test-webhook-token-0123456789abcdef");
    assert.ok(ok.status === 202 || ok.status === 200, `right token accepted (got ${ok.status})`);

    assert.equal((await fetch(`${t.url}/api/dtools/pending-prices`, { redirect: "manual" })).status, 401, "approvals need the owner");
    const cookie = sessionCookie(await login(t))!;
    const st = await fetch(`${t.url}/api/dtools/status`, { headers: { cookie } });
    assert.equal(st.status, 200);
    const body = await st.json();
    assert.equal(body.configured ?? body.connected ?? false, false, "no API key in this test → not connected");
  } finally {
    await t.close();
    delete process.env.DTOOLS_WEBHOOK_TOKEN;
  }
});
