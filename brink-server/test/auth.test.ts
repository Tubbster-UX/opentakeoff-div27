import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hashPassword, verifyPassword, signSession, verifySession, redirectUriAllowed, safeNext } from "../src/auth.ts";
import { startServer, login, sessionCookie, pkcePair, PASSWORD, type TestServer } from "./fakes.ts";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

describe("password hashing", () => {
  test("hash has the documented format and verifies", async () => {
    const h = await hashPassword("s3cret-pass-phrase", { N: 2 ** 14 });
    assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    assert.equal(await verifyPassword("s3cret-pass-phrase", h), true);
    assert.equal(await verifyPassword("s3cret-pass-phrasE", h), false);
    assert.equal(await verifyPassword("", h), false);
  });
  test("two hashes of one password differ (random salt)", async () => {
    const a = await hashPassword("same", { N: 2 ** 14 });
    const b = await hashPassword("same", { N: 2 ** 14 });
    assert.notEqual(a, b);
  });
  test("malformed or weak hashes never verify", async () => {
    assert.equal(await verifyPassword("x", "plain"), false);
    assert.equal(await verifyPassword("x", "scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"), false);
    assert.equal(await verifyPassword("x".repeat(5000), await hashPassword("x", { N: 2 ** 14 })), false);
  });
});

describe("session cookie", () => {
  const key = crypto.randomBytes(32);
  const now = Math.floor(Date.now() / 1000);
  test("valid until expiry", () => {
    const v = signSession(key, now + 60);
    assert.equal(verifySession(key, v, now), true);
    assert.equal(verifySession(key, v, now + 61), false);
  });
  test("tampering is detected", () => {
    const v = signSession(key, now + 60);
    const [ver, , nonce, sig] = v.split(".");
    assert.equal(verifySession(key, `${ver}.${now + 999999}.${nonce}.${sig}`, now), false, "extended expiry");
    assert.equal(verifySession(key, v.slice(0, -2) + (v.endsWith("AA") ? "BB" : "AA"), now), false, "changed mac");
    assert.equal(verifySession(crypto.randomBytes(32), v, now), false, "other key");
    assert.equal(verifySession(key, "", now), false);
    assert.equal(verifySession(key, "v1.x.y.z", now), false);
  });
});

describe("redirect policy and next", () => {
  const hosts = ["claude.ai", "claude.com"];
  test("allowlist", () => {
    assert.equal(redirectUriAllowed(CALLBACK, hosts), true);
    assert.equal(redirectUriAllowed("https://claude.com/api/mcp/auth_callback", hosts), true);
    assert.equal(redirectUriAllowed("http://localhost:33418/callback", hosts), true);
    assert.equal(redirectUriAllowed("http://127.0.0.1:5000/cb", hosts), true);
    assert.equal(redirectUriAllowed("http://claude.ai/api/mcp/auth_callback", hosts), false, "http non-loopback");
    assert.equal(redirectUriAllowed("https://claude.ai.evil.com/cb", hosts), false);
    assert.equal(redirectUriAllowed("https://evil.com/cb", hosts), false);
    assert.equal(redirectUriAllowed("https://claude.ai:8443/cb", hosts), false, "non-default port");
    assert.equal(redirectUriAllowed("https://user@claude.ai/cb", hosts), false, "userinfo");
    assert.equal(redirectUriAllowed("javascript:alert(1)", hosts), false);
    assert.equal(redirectUriAllowed("https://localhost/cb", hosts), false);
  });
  test("next only accepts same-site paths", () => {
    assert.equal(safeNext("/p/x"), "/p/x");
    assert.equal(safeNext("//evil.com"), "/");
    assert.equal(safeNext("/\\evil.com"), "/");
    assert.equal(safeNext("https://evil.com"), "/");
    assert.equal(safeNext("/login"), "/");
    assert.equal(safeNext(undefined), "/");
  });
});

describe("OAuth flow over HTTP", () => {
  let t: TestServer;
  let clock = Date.now();
  before(async () => {
    t = await startServer({ auth: { now: () => clock, sdkRateLimits: false } });
  });
  after(async () => t.close());

  const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
    method: "POST",
    redirect: "manual" as const,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

  async function register(redirectUris: string[], name = "Claude"): Promise<Response> {
    return fetch(`${t.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    });
  }

  function authorizeUrl(clientId: string, challenge: string | null, extra: Record<string, string> = {}): string {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "st-123", resource: `${t.url}/mcp`, ...extra });
    if (challenge) {
      q.set("code_challenge", challenge);
      q.set("code_challenge_method", "S256");
    }
    return `${t.url}/authorize?${q}`;
  }

  /** Authorize → consent → code. Uses the password unless a cookie is given. */
  async function getCode(clientId: string, challenge: string, cookie?: string): Promise<{ code: string; cookie: string | null; page: string }> {
    const r = await fetch(authorizeUrl(clientId, challenge), { headers: cookie ? { cookie } : {} });
    assert.equal(r.status, 200);
    const page = await r.text();
    const sealed = /name="req" value="([^"]+)"/.exec(page)![1];
    const body: Record<string, string> = { req: sealed, action: "allow" };
    if (!cookie) body.password = PASSWORD;
    const c = await fetch(`${t.url}/oauth/consent`, form(body, { origin: t.url, ...(cookie ? { cookie } : {}) }));
    assert.equal(c.status, 302, await c.clone().text());
    const loc = new URL(c.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get("state"), "st-123");
    return { code: loc.searchParams.get("code")!, cookie: sessionCookie(c), page };
  }

  async function token(body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${t.url}/token`, form(body));
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  const mcp = (tok?: string, path = "/mcp") =>
    fetch(`${t.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: "{}" });

  test("401 from /mcp points at the protected-resource metadata", async () => {
    const r = await mcp();
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate")!, new RegExp(`^Bearer .*resource_metadata="${t.url}/\\.well-known/oauth-protected-resource/mcp"`));
    const rb = await mcp(undefined, "/mcp/brink");
    assert.match(rb.headers.get("www-authenticate")!, /resource_metadata="[^"]+\/oauth-protected-resource\/mcp\/brink"/);
    const owner = await login(t);
    const withCookie = await fetch(`${t.url}/mcp`, { method: "POST", headers: { cookie: sessionCookie(owner)! } });
    assert.equal(withCookie.status, 401, "the owner cookie is not a bearer token");
  });

  test("metadata documents", async () => {
    const prm = (await (await fetch(`${t.url}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, `${t.url}/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${t.url}/`]);
    const prmB = (await (await fetch(`${t.url}/.well-known/oauth-protected-resource/mcp/brink`)).json()) as Record<string, unknown>;
    assert.equal(prmB.resource, `${t.url}/mcp/brink`);
    const as = (await (await fetch(`${t.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.authorization_endpoint, `${t.url}/authorize`);
    assert.equal(as.token_endpoint, `${t.url}/token`);
    assert.equal(as.registration_endpoint, `${t.url}/register`);
    assert.equal(as.revocation_endpoint, `${t.url}/revoke`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  test("registration refuses redirect hosts outside the allowlist", async () => {
    for (const bad of ["https://evil.example/cb", "https://claude.ai.evil.example/cb", "http://claude.ai/cb", "https://claude.ai:444/cb"]) {
      const r = await register([bad]);
      assert.equal(r.status, 400, bad);
      assert.equal(((await r.json()) as { error: string }).error, "invalid_client_metadata");
    }
    const mixed = await register([CALLBACK, "https://evil.example/cb"]);
    assert.equal(mixed.status, 400);
    const loop = await register(["http://localhost:33418/callback"], "Claude Code");
    assert.equal(loop.status, 201);
    const r = await register([CALLBACK]);
    assert.equal(r.status, 201);
    const c = (await r.json()) as { client_id: string };
    assert.ok(t.storage.objects.has(`system/oauth/clients/${c.client_id}.json`));
  });

  test("full flow: register, consent with password, PKCE token, bearer, refresh rotation, reuse revokes", async () => {
    const reg = (await (await register([CALLBACK], "Claude <b>web</b>")).json()) as { client_id: string };
    const clientId = reg.client_id;
    const { verifier, challenge } = pkcePair();

    // Consent page: password form, client name escaped, form-action allows only self + the redirect origin.
    const page = await fetch(authorizeUrl(clientId, challenge));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /type="password"/);
    assert.ok(html.includes("Claude &lt;b&gt;web&lt;/b&gt;") && !html.includes("<b>web</b>"));
    assert.match(page.headers.get("content-security-policy")!, /form-action 'self' https:\/\/claude\.ai/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const sealed = /name="req" value="([^"]+)"/.exec(html)![1];

    // Consent POST without Origin, with a forged request, and with a wrong password.
    const noOrigin = await fetch(`${t.url}/oauth/consent`, form({ req: sealed, action: "allow", password: PASSWORD }));
    assert.equal(noOrigin.status, 403);
    const forged = await fetch(`${t.url}/oauth/consent`, form({ req: sealed.replace(/.$/, sealed.endsWith("A") ? "B" : "A"), action: "allow", password: PASSWORD }, { origin: t.url }));
    assert.equal(forged.status, 400);
    const wrong = await fetch(`${t.url}/oauth/consent`, form({ req: sealed, action: "allow", password: "nope" }, { origin: t.url }));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Wrong password/);

    // Deny goes back with access_denied.
    const deny = await fetch(`${t.url}/oauth/consent`, form({ req: sealed, action: "deny" }, { origin: t.url }));
    assert.equal(deny.status, 302);
    assert.equal(new URL(deny.headers.get("location")!).searchParams.get("error"), "access_denied");

    // Allow with the password: code + state, and the owner is now signed in.
    const { code, cookie } = await getCode(clientId, challenge);
    assert.ok(code && cookie);

    // Missing / wrong verifier burns the code.
    const wrongVerifier = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkcePair().verifier, redirect_uri: CALLBACK });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.json.error, "invalid_grant");
    const afterBurn = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: CALLBACK });
    assert.equal(afterBurn.json.error, "invalid_grant", "a code is single-use even after a failed attempt");

    // With the cookie: one-click consent (no password field).
    const second = await getCode(clientId, challenge, cookie!);
    assert.doesNotMatch(second.page, /type="password"/);
    assert.match(second.page, /Allow Claude/);
    const noPkce = await token({ grant_type: "authorization_code", client_id: clientId, code: second.code, redirect_uri: CALLBACK });
    assert.equal(noPkce.status, 400, "token request without code_verifier is refused");

    const third = await getCode(clientId, challenge, cookie!);
    const tok = await token({ grant_type: "authorization_code", client_id: clientId, code: third.code, code_verifier: verifier, redirect_uri: CALLBACK, resource: `${t.url}/mcp` });
    assert.equal(tok.status, 200, JSON.stringify(tok.json));
    assert.equal(tok.json.token_type, "Bearer");
    assert.equal(tok.json.expires_in, 3600);
    const access1 = tok.json.access_token as string;
    const refresh1 = tok.json.refresh_token as string;
    assert.match(access1, /^[A-Za-z0-9_-]{43}$/);

    // Tokens are stored only as hashes.
    for (const [key, o] of t.storage.objects) {
      if (!key.startsWith("system/oauth/")) continue;
      const text = o.body.toString("utf8");
      assert.ok(!key.includes(access1) && !text.includes(access1) && !text.includes(refresh1), `plaintext token in ${key}`);
    }
    assert.ok(t.storage.objects.has(`system/oauth/tokens/access/${crypto.createHash("sha256").update(access1).digest("hex")}.json`));

    // Bearer accepted on both MCP paths; garbage refused.
    const ok = await mcp(access1);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { clientId: string }).clientId, clientId);
    assert.equal((await mcp(access1, "/mcp/brink")).status, 200);
    assert.equal((await mcp("x".repeat(43))).status, 401);

    // Replaying the used code revokes what it issued.
    const replay = await token({ grant_type: "authorization_code", client_id: clientId, code: third.code, code_verifier: verifier });
    assert.equal(replay.json.error, "invalid_grant");
    assert.equal((await mcp(access1)).status, 401, "code replay revoked the family");

    // Fresh sign-in for the refresh tests.
    const fourth = await getCode(clientId, challenge, cookie!);
    const t2 = await token({ grant_type: "authorization_code", client_id: clientId, code: fourth.code, code_verifier: verifier });
    const access2 = t2.json.access_token as string;
    const refresh2 = t2.json.refresh_token as string;
    assert.equal((await mcp(access2)).status, 200);

    // Refresh rotates.
    const r1 = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh2 });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const access3 = r1.json.access_token as string;
    const refresh3 = r1.json.refresh_token as string;
    assert.notEqual(refresh3, refresh2);
    assert.equal((await mcp(access3)).status, 200);

    // Another client cannot use it.
    const other = (await (await register([CALLBACK], "Other")).json()) as { client_id: string };
    const stolen = await token({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: refresh3 });
    assert.equal(stolen.json.error, "invalid_grant");
    // ...and that attempt revoked the family (refresh token theft).
    assert.equal((await mcp(access3)).status, 401);

    // New family: reuse of a rotated refresh token revokes everything.
    const fifth = await getCode(clientId, challenge, cookie!);
    const t5 = await token({ grant_type: "authorization_code", client_id: clientId, code: fifth.code, code_verifier: verifier });
    const rA = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t5.json.refresh_token as string });
    assert.equal(rA.status, 200);
    const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: t5.json.refresh_token as string });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error, "invalid_grant");
    assert.equal((await mcp(rA.json.access_token as string)).status, 401, "access from the rotated pair is revoked");
    const rB = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: rA.json.refresh_token as string });
    assert.equal(rB.json.error, "invalid_grant", "the newest refresh token is revoked too");
  });

  test("access tokens expire after an hour; revoke endpoint works", async () => {
    const reg = (await (await register([CALLBACK])).json()) as { client_id: string };
    const { verifier, challenge } = pkcePair();
    const owner = sessionCookie(await login(t))!;
    const { code } = await getCode(reg.client_id, challenge, owner);
    const tok = await token({ grant_type: "authorization_code", client_id: reg.client_id, code, code_verifier: verifier });
    const access = tok.json.access_token as string;
    assert.equal((await mcp(access)).status, 200);
    clock += 3601_000;
    assert.equal((await mcp(access)).status, 401, "expired");
    const r = await token({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: tok.json.refresh_token as string });
    assert.equal(r.status, 200, "refresh still works after the access token expired");
    const fresh = r.json.access_token as string;
    assert.equal((await mcp(fresh)).status, 200);
    const rev = await fetch(`${t.url}/revoke`, form({ client_id: reg.client_id, token: fresh }));
    assert.equal(rev.status, 200);
    assert.equal((await mcp(fresh)).status, 401);
    const again = await token({ grant_type: "refresh_token", client_id: reg.client_id, refresh_token: r.json.refresh_token as string });
    assert.equal(again.json.error, "invalid_grant", "revoking the access token revoked its refresh token");
  });

  test("authorize refuses missing PKCE, plain PKCE, unregistered redirect and foreign resource", async () => {
    const reg = (await (await register([CALLBACK])).json()) as { client_id: string };
    const missing = await fetch(authorizeUrl(reg.client_id, null), { redirect: "manual" });
    assert.equal(missing.status, 302);
    const ml = new URL(missing.headers.get("location")!);
    assert.equal(ml.searchParams.get("error"), "invalid_request");
    assert.equal(ml.origin, "https://claude.ai");

    const plain = await fetch(authorizeUrl(reg.client_id, null, { code_challenge: "abc", code_challenge_method: "plain" }), { redirect: "manual" });
    assert.equal(new URL(plain.headers.get("location")!).searchParams.get("error"), "invalid_request");

    const evil = await fetch(authorizeUrl(reg.client_id, pkcePair().challenge, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    assert.equal(evil.status, 400, "unregistered redirect gets no redirect at all");
    assert.equal(evil.headers.get("location"), null);

    const foreign = await fetch(authorizeUrl(reg.client_id, pkcePair().challenge, { resource: "https://other.example/mcp" }), { redirect: "manual" });
    assert.equal(new URL(foreign.headers.get("location")!).searchParams.get("error"), "invalid_target");

    const unknown = await fetch(authorizeUrl("00000000-0000-0000-0000-000000000000", pkcePair().challenge), { redirect: "manual" });
    assert.equal(unknown.status, 400);
  });
});

describe("login rate limiting", () => {
  let t: TestServer;
  let clock = Date.now();
  before(async () => {
    t = await startServer({ auth: { now: () => clock, limits: { ipFree: 3, ipBaseMs: 60_000, globalMax: 8 } } });
  });
  after(async () => t.close());

  test("per-IP lockout with backoff, independent of other IPs, then global lockout", async () => {
    const ip = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 3; i++) assert.equal((await login(t, "wrong", ip)).status, 401);
    const locked = await login(t, PASSWORD, ip);
    assert.equal(locked.status, 429, "even the right password is refused while locked");
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.equal(sessionCookie(locked), null);
    assert.match(await locked.text(), /Too many attempts/);

    // Another IP is unaffected.
    const other = await login(t, PASSWORD, { "x-forwarded-for": "198.51.100.2" });
    assert.equal(other.status, 303);
    assert.ok(sessionCookie(other));

    // After the lockout passes, one more try; failing doubles the lockout.
    clock += 61_000;
    assert.equal((await login(t, "wrong", ip)).status, 401);
    clock += 61_000;
    assert.equal((await login(t, PASSWORD, ip)).status, 429, "second lockout is longer (120 s)");
    clock += 60_000;
    assert.equal((await login(t, PASSWORD, ip)).status, 303);

    // Global: failures spread over many IPs lock every password login.
    for (let i = 0; i < 8; i++) await login(t, "wrong", { "x-forwarded-for": `192.0.2.${i + 1}` });
    const g = await login(t, PASSWORD, { "x-forwarded-for": "192.0.2.200" });
    assert.equal(g.status, 429);
    clock += 5 * 60_000 + 1000;
    assert.equal((await login(t, PASSWORD, { "x-forwarded-for": "192.0.2.201" })).status, 303);
  });

  test("the OAuth consent password shares the limiter", async () => {
    const ip = { "x-forwarded-for": "203.0.113.99" };
    for (let i = 0; i < 3; i++) await login(t, "wrong", ip);
    const reg = (await (await fetch(`${t.url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: pkcePair().challenge, code_challenge_method: "S256" });
    const html = await (await fetch(`${t.url}/authorize?${q}`)).text();
    const sealed = /name="req" value="([^"]+)"/.exec(html)![1];
    const r = await fetch(`${t.url}/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: t.url, ...ip },
      body: new URLSearchParams({ req: sealed, action: "allow", password: PASSWORD }).toString(),
    });
    assert.equal(r.status, 429);
  });
});
