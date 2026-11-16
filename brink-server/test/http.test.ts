import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { partSizeFor, safeFileName, PART_SIZE } from "../src/http.ts";
import { startServer, login, sessionCookie, type TestServer } from "./fakes.ts";

const MiB = 1024 * 1024;

describe("helpers", () => {
  test("part size keeps parts ≤ 10000", () => {
    assert.equal(partSizeFor(800 * MiB), PART_SIZE);
    assert.equal(partSizeFor(4 * 1024 * MiB), PART_SIZE);
    const big = 500 * 1024 * MiB;
    const ps = partSizeFor(big);
    assert.ok(ps > PART_SIZE && ps % MiB === 0);
    assert.ok(Math.ceil(big / ps) <= 10_000);
  });
  test("safe file names", () => {
    assert.equal(safeFileName("Bid Package - FA4690 (Amend 1).zip"), "Bid Package - FA4690 (Amend 1).zip");
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Users\\me\\E-101.pdf"), "E-101.pdf");
    assert.equal(safeFileName(".hidden"), "hidden");
    assert.equal(safeFileName("a\u0000b\nc.pdf"), "a_b_c.pdf");
    assert.equal(safeFileName(".."), null);
    assert.equal(safeFileName("/"), null);
    assert.equal(safeFileName(""), null);
    assert.equal(safeFileName(42), null);
    const long = safeFileName("x".repeat(400) + ".pdf")!;
    assert.equal(long.length, 180);
    assert.ok(long.endsWith(".pdf"));
  });
});

describe("http app", () => {
  let t: TestServer;
  let cookie: string;
  before(async () => {
    t = await startServer({ config: { maxUploadBytes: 100 * MiB } });
  });
  after(async () => t.close());

  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${t.url}${path}`, {
      method,
      redirect: "manual",
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json", origin: t.url } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  test("health needs no auth and has security headers", async () => {
    const r = await fetch(`${t.url}/api/health`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean; version: string; storage: string };
    assert.equal(j.ok, true);
    assert.equal(j.storage, "mem:test");
    assert.match(j.version, /^\d+\.\d+\.\d+/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-powered-by"), null);
    // Not "no-referrer": that makes browsers send `Origin: null` on form POSTs and breaks sign-in.
    assert.equal(r.headers.get("referrer-policy"), "same-origin");
  });

  test("signed-out: API is 401 JSON, pages redirect to login, CSS is public", async () => {
    const a = await fetch(`${t.url}/api/projects`);
    assert.equal(a.status, 401);
    assert.equal(((await a.json()) as { error: string }).error, "not_signed_in");
    const p = await fetch(`${t.url}/`, { redirect: "manual" });
    assert.equal(p.status, 302);
    assert.equal(p.headers.get("location"), "/login");
    const js = await fetch(`${t.url}/app.js`, { redirect: "manual" });
    assert.equal(js.status, 302);
    assert.equal(js.headers.get("location"), "/login?next=%2Fapp.js");
    assert.equal((await fetch(`${t.url}/app.css`)).status, 200);
    const lp = await fetch(`${t.url}/login?next=//evil.example`);
    assert.equal(lp.status, 200);
    const html = await lp.text();
    assert.match(html, /name="next" value="\/"/);
    assert.match(html, /type="password"/);
  });

  test("login: origin check, wrong password, success, open-redirect safe", async () => {
    const noOrigin = await fetch(`${t.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=x",
    });
    assert.equal(noOrigin.status, 403);
    const crossSite = await login(t, "whatever", { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    const wrong = await login(t, "wrong password");
    assert.equal(wrong.status, 401);
    assert.equal(sessionCookie(wrong), null);
    const ok = await fetch(`${t.url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: t.url },
      body: new URLSearchParams({ password: "correct horse battery staple", next: "//evil.example/x" }).toString(),
    });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/");
    const set = ok.headers.getSetCookie().join("\n");
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.match(set, /Max-Age=2592000/);
    cookie = sessionCookie(ok)!;
    const page = await fetch(`${t.url}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
    const tampered = await fetch(`${t.url}/api/projects`, { headers: { cookie: cookie.slice(0, -3) + "AAA" } });
    assert.equal(tampered.status, 401);
  });

  test("CSRF: state-changing API calls need JSON and our Origin", async () => {
    const body = JSON.stringify({ name: "x" });
    const none = await fetch(`${t.url}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body });
    assert.equal(none.status, 403);
    const evil = await fetch(`${t.url}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://evil.example" }, body });
    assert.equal(evil.status, 403);
    const formType = await fetch(`${t.url}/api/projects`, { method: "POST", headers: { cookie, "content-type": "text/plain", origin: t.url }, body });
    assert.equal(formType.status, 415);
    assert.equal(t.projects.m.size, 0);
  });

  test("projects: create, list, get, patch", async () => {
    const c = await api("POST", "/api/projects", { name: "Hangar 4 Low Voltage", notes: "Sol FA4690-26-Q-0001, due 12/1" });
    assert.equal(c.status, 201);
    const m = (await c.json()) as { id: string; name: string };
    assert.equal(m.id, "hangar-4-low-voltage");
    const dup = await api("POST", "/api/projects", { name: "Hangar 4 Low Voltage" });
    assert.equal(dup.status, 409);
    const empty = await api("POST", "/api/projects", { name: "  " });
    assert.equal(empty.status, 400);
    const list = (await (await api("GET", "/api/projects")).json()) as { projects: { id: string; files: number }[] };
    assert.deepEqual(list.projects.map((p) => p.id), ["hangar-4-low-voltage"]);
    const got = await api("GET", `/api/projects/${m.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(((await got.json()) as { pendingUploads: unknown[] }).pendingUploads, []);
    const patched = (await (await api("PATCH", `/api/projects/${m.id}`, { notes: "Due 12/2" })).json()) as { notes: string; name: string };
    assert.equal(patched.notes, "Due 12/2");
    assert.equal(patched.name, "Hangar 4 Low Voltage");
    assert.equal((await api("GET", "/api/projects/nope")).status, 404);
    assert.equal((await api("GET", "/api/projects/..%2Fsystem")).status, 404);
  });

  test("upload: create → parts → complete → queued → ingest called → record", async () => {
    const pid = "hangar-4-low-voltage";
    const tooBig = await api("POST", `/api/projects/${pid}/uploads`, { name: "huge.zip", size: 101 * MiB, contentType: "application/zip" });
    assert.equal(tooBig.status, 413);
    const badName = await api("POST", `/api/projects/${pid}/uploads`, { name: "..", size: 10, contentType: "application/zip" });
    assert.equal(badName.status, 400);
    const zero = await api("POST", `/api/projects/${pid}/uploads`, { name: "a.zip", size: 0 });
    assert.equal(zero.status, 400);

    const size = 40 * MiB + 123;
    const cr = await api("POST", `/api/projects/${pid}/uploads`, { name: "../Bid Set.zip", size, contentType: "application/zip" });
    assert.equal(cr.status, 201);
    const up = (await cr.json()) as { uploadId: string; name: string; partSize: number; partCount: number; parts: { partNumber: number; url: string }[] };
    assert.equal(up.name, "Bid Set.zip");
    assert.equal(up.partSize, 16 * MiB);
    assert.equal(up.partCount, 3);
    assert.deepEqual(up.parts.map((p) => p.partNumber), [1, 2, 3]);
    const mpId = new URL(up.parts[0].url).searchParams.get("uploadId")!;
    assert.ok(mpId.startsWith("mp-"));

    // In flight: not in the manifest, visible as pending.
    const during = (await (await api("GET", `/api/projects/${pid}`)).json()) as { uploads: unknown[]; pendingUploads: { uploadId: string; status: string }[] };
    assert.equal(during.uploads.length, 0);
    assert.equal(during.pendingUploads[0].uploadId, up.uploadId);
    assert.equal(((await (await api("GET", `/api/projects/${pid}/uploads/${up.uploadId}`)).json()) as { status: string }).status, "uploading");

    const more = await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/parts`, { partNumbers: [2, 3] });
    assert.equal(more.status, 200);
    assert.equal(((await more.json()) as { parts: unknown[] }).parts.length, 2);
    assert.equal((await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/parts`, { partNumbers: [4] })).status, 400);
    assert.equal((await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/parts`, { partNumbers: [1, 1] })).status, 400);

    const etags: { partNumber: number; etag: string }[] = [];
    for (let n = 1; n <= 3; n++) {
      const len = n < 3 ? up.partSize : size - 2 * up.partSize;
      etags.push({ partNumber: n, etag: t.storage.fakePutPart(mpId, n, Buffer.alloc(len, n)) });
    }
    const missing = await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/complete`, { parts: etags.slice(0, 2) });
    assert.equal(missing.status, 400);

    const done = await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/complete`, { parts: [...etags].reverse() });
    assert.equal(done.status, 200, await done.clone().text());
    const rec = (await done.json()) as { status: string; uploadId: string; name: string };
    assert.equal(rec.status, "received");
    assert.ok(t.storage.objects.has(`projects/${pid}/uploads/${up.uploadId}/Bid Set.zip`));
    assert.equal(t.storage.objects.get(`projects/${pid}/uploads/${up.uploadId}/Bid Set.zip`)!.body.length, size);

    await t.built.queue.idle(5000);
    assert.deepEqual(t.ingest.calls, [{ project: pid, uploadId: up.uploadId }]);
    const after = (await (await api("GET", `/api/projects/${pid}/uploads/${up.uploadId}`)).json()) as { status: string; files: string[] };
    assert.equal(after.status, "done");
    assert.deepEqual(after.files, ["Drawings/Bid Set.zip"]);
    // Completing again (a retried request) returns the record and does not re-queue.
    const again = await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/complete`, { parts: etags });
    assert.equal(again.status, 200);
    await t.built.queue.idle(5000);
    assert.equal(t.ingest.calls.length, 1);
    const man = (await (await api("GET", `/api/projects/${pid}`)).json()) as { pendingUploads: unknown[]; uploads: unknown[] };
    assert.equal(man.pendingUploads.length, 0);
    assert.equal(man.uploads.length, 1);
    assert.equal([...t.storage.objects.keys()].filter((k) => k.startsWith("system/uploads/")).length, 0);
  });

  test("upload: a part bigger than declared is caught at complete; abort works; ingest errors are recorded", async () => {
    const pid = "hangar-4-low-voltage";
    const up = (await (await api("POST", `/api/projects/${pid}/uploads`, { name: "small.pdf", size: 1000, contentType: "application/pdf" })).json()) as { uploadId: string; parts: { url: string }[] };
    const mp = new URL(up.parts[0].url).searchParams.get("uploadId")!;
    const etag = t.storage.fakePutPart(mp, 1, Buffer.alloc(5000));
    const r = await api("POST", `/api/projects/${pid}/uploads/${up.uploadId}/complete`, { parts: [{ partNumber: 1, etag }] });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "size_mismatch");
    assert.equal(t.storage.objects.has(`projects/${pid}/uploads/${up.uploadId}/small.pdf`), false);

    const ab = (await (await api("POST", `/api/projects/${pid}/uploads`, { name: "x.pdf", size: 10 })).json()) as { uploadId: string };
    assert.equal((await api("POST", `/api/projects/${pid}/uploads/${ab.uploadId}/abort`, {})).status, 200);
    assert.equal((await api("GET", `/api/projects/${pid}/uploads/${ab.uploadId}`)).status, 404);
    assert.equal((await api("POST", `/api/projects/${pid}/uploads/${ab.uploadId}/parts`, { partNumbers: [1] })).status, 404);

    // Two uploads back to back, the first ingest throws: the queue keeps going.
    t.ingest.failNext = true;
    const ids: string[] = [];
    for (const name of ["bad.pdf", "good.pdf"]) {
      const u = (await (await api("POST", `/api/projects/${pid}/uploads`, { name, size: 10 })).json()) as { uploadId: string; parts: { url: string }[] };
      const m = new URL(u.parts[0].url).searchParams.get("uploadId")!;
      const e = t.storage.fakePutPart(m, 1, Buffer.alloc(10));
      assert.equal((await api("POST", `/api/projects/${pid}/uploads/${u.uploadId}/complete`, { parts: [{ partNumber: 1, etag: e }] })).status, 200);
      ids.push(u.uploadId);
    }
    await t.built.queue.idle(5000);
    const bad = (await (await api("GET", `/api/projects/${pid}/uploads/${ids[0]}`)).json()) as { status: string; error: string };
    assert.equal(bad.status, "error");
    assert.match(bad.error, /invented ingest failure/);
    const good = (await (await api("GET", `/api/projects/${pid}/uploads/${ids[1]}`)).json()) as { status: string };
    assert.equal(good.status, "done");
  });

  test("download: only paths in the manifest", async () => {
    const pid = "hangar-4-low-voltage";
    const ok = await api("GET", `/api/projects/${pid}/download?path=${encodeURIComponent("Drawings/Bid Set.zip")}`);
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get("location")!, /^https:\/\/store\.test\/projects\/hangar-4-low-voltage\/files\/Drawings\/Bid%20Set\.zip/);
    const last = t.storage.presigned.at(-1)!;
    assert.equal(last.expiresSec, 3600);
    assert.equal(last.filename, "Bid Set.zip");
    for (const p of ["Drawings/missing.pdf", "../../system/oauth/clients/x.json", "/etc/passwd", ""]) {
      const r = await api("GET", `/api/projects/${pid}/download?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await api("GET", `/api/projects/${pid}/download`)).status, 404);
    // Outputs map to outputs/.
    await t.projects.update(pid, (m) => {
      m.files.push({ path: "E-101 marked.pdf", kind: "output", size: 1, contentType: "application/pdf", added: new Date().toISOString(), text: "none" });
    });
    const out = await api("GET", `/api/projects/${pid}/download?path=${encodeURIComponent("E-101 marked.pdf")}`);
    assert.match(out.headers.get("location")!, /\/projects\/hangar-4-low-voltage\/outputs\/E-101%20marked\.pdf/);
    const signedOut = await fetch(`${t.url}/api/projects/${pid}/download?path=${encodeURIComponent("Drawings/Bid Set.zip")}`, { redirect: "manual" });
    assert.equal(signedOut.status, 401);
  });

  test("logout clears the cookie and needs our Origin", async () => {
    const bad = await fetch(`${t.url}/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 403);
    const r = await fetch(`${t.url}/logout`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: t.url }, body: "{}" });
    assert.equal(r.status, 200);
    assert.match(r.headers.getSetCookie().join("\n"), /brink_session=; Path=\/; Max-Age=0/);
  });

  test("unknown API routes are JSON 404", async () => {
    const r = await api("GET", "/api/nothing-here");
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { error: string }).error, "not_found");
  });
});

describe("startup re-queues unfinished ingests", () => {
  test("received uploads from before a restart are processed", async () => {
    const t = await startServer({ resumeIngest: false });
    try {
      await t.projects.create({ name: "Old Job" });
      await t.projects.update("old-job", (m) => {
        m.uploads.push({ uploadId: "abcdef0123", name: "plans.pdf", size: 1, status: "received", added: new Date().toISOString(), files: [], skipped: [] });
      });
      // A second app over the same deps, with resume on.
      const { buildApp } = await import("../src/http.ts");
      const { fakeMountMcp } = await import("./fakes.ts");
      const built = buildApp(
        { config: t.config, storage: t.storage, projects: t.projects, ingest: t.ingest, search: { search: async () => [], read: async () => null }, workspace: { dir: () => "", ensureFile: async () => "", outputsDir: () => "", syncOutputs: async () => [] } },
        fakeMountMcp,
        { auth: { sweepTimer: false } },
      );
      await new Promise((r) => setTimeout(r, 50));
      await built.queue.idle(5000);
      assert.deepEqual(t.ingest.calls, [{ project: "old-job", uploadId: "abcdef0123" }]);
      await built.close();
    } finally {
      await t.close();
    }
  });
});
