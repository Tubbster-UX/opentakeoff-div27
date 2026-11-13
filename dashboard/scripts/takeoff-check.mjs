#!/usr/bin/env node
// End-to-end check of the Takeoff tab in a real browser (Playwright, chromium): the
// vendored OpenTakeoff canvas mounted directly in the app (no frame) with the Brink
// toolbar, panels, status bar and header; plan PDFs stored in Supabase Storage; takeoff
// edits saved to the edit layer under the Access identity, re-running the import so the
// BOM follows, live in another tab; machine originals kept. Self-contained like es-check:
// it builds the app, runs `wrangler dev` with Cloudflare Access configured against a local
// stand-in team (an RSA key and its JWKS, so every write goes through real JWT
// verification), and drives browser contexts as two Access users.
//
//   1. open the Takeoff tab on a project with no plan file: the Brink empty state, the
//      takeoff's sheets listed as having no plan file; loading writes nothing; no iframe,
//      no OpenTakeoff top bar, rail or logo: the Brink header, toolbar and panels
//   2. upload demo/sample-plan.pdf through the UI: stored in Supabase Storage under the
//      Access email (brink_sheets), read back through the Worker byte for byte; the
//      takeoff draws over it
//   3. a second user opens BOM & issues
//   4. user A draws a count on DATA-1 (the real canvas tool): a shape_put edit under A's
//      email, a new import, and the second tab's BOM shows the DATA-1 line +1 live
//   5. user A moves an agent's count marker: a shape_put that keeps the machine's original
//      ring (origin.proposed_verts_norm) and actor; the import's raw takeoff is unchanged
//   6. user A deletes a count: shape_delete; the BOM line goes back down, live
//   7. the second user opens the Takeoff tab; A draws again; B's canvas shows it live
//   8. reload: the edits persist; re-import the fixture with the brink-merge CLI: the
//      canvas reloads the new import with the edits re-applied
//   9. the Project menu runs upstream's exporters (marked set PDF, DXF); light and dark
//      screenshots; phone width; no page errors
// Screenshots and results.json go to docs/evidence/takeoff/. Uses only brink-merge's
// invented fixtures and the repository's demo/sample-plan.pdf.
//
// usage: node scripts/takeoff-check.mjs [--db postgres://...] [--project "Brink Div 27 sample (invented)"] [--out docs/evidence/takeoff] [--no-build]
// Needs: local Supabase with Storage (README "Run it locally") and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in
// .dev.vars, and Playwright (`require('playwright')`).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : acc), []));
const DB = args.db ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const PROJECT = args.project ?? "Brink Div 27 sample (invented)";
const OUT = resolve(args.out ?? join(ROOT, "docs/evidence/takeoff"));
const BRINK = resolve(ROOT, "../brink-merge");
const PLAN = resolve(ROOT, "../demo/sample-plan.pdf");
const TMP = mkdtempSync(join(tmpdir(), "brink-takeoff-check-"));

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright not found: npm i -g playwright && npx playwright install chromium (or set NODE_PATH to the global node_modules)");
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  log(ok ? "PASS" : "FAIL", name, detail);
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- a stand-in Cloudflare Access team: one RSA key, its JWKS, RS256 tokens ----
const AUD = "takeoff-check-aud";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
const jwks = createServer((req, res) => {
  if (req.url !== "/cdn-cgi/access/certs") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", kid: "takeoff-check", use: "sig" }] }));
});
await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
const TEAM = `http://127.0.0.1:${jwks.address().port}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function accessToken(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", kid: "takeoff-check", typ: "JWT" });
  const p = b64({ aud: [AUD], email, exp: now + 3600, iat: now, nbf: now, iss: TEAM, type: "app", sub: email });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const ALEX = "alex@brink.test";
const SAM = "sam@brink.test";

// ---- database, build, wrangler dev ----
const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const brinkMerge = (takeoff, report) =>
  execFileSync(process.execPath, [join(BRINK, "bin/brink-merge.mjs"), takeoff, "--report", report, "--db-url", DB, "--out", join(TMP, "s.json"), "--bom", join(TMP, "b.csv")], { cwd: BRINK, encoding: "utf8" });

if (!args["no-build"]) execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "inherit" });
const port = await new Promise((r) => {
  const s = netServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
let wranglerOut = "";
const wrangler = spawn(
  process.execPath,
  [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--port", String(port), "--ip", "127.0.0.1", "--var", `ACCESS_TEAM_DOMAIN:${TEAM}`, "--var", `ACCESS_AUD:${AUD}`, "--persist-to", join(TMP, "wrangler-state")],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: DB }, stdio: ["ignore", "pipe", "pipe"] },
);
wrangler.stdout.on("data", (d) => (wranglerOut += d));
wrangler.stderr.on("data", (d) => (wranglerOut += d));
for (const end = Date.now() + 90_000; ; ) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* starting */
  }
  if (Date.now() > end) throw new Error(`wrangler dev did not start:\n${wranglerOut}`);
  await new Promise((r) => setTimeout(r, 300));
}
log("wrangler dev on", BASE, "Access team", TEAM);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
async function openUser(email, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: opts.dark ? "dark" : "light", acceptDownloads: true, extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": await accessToken(email) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e}`));
  page.on("console", (m) => m.type() === "error" && !/WebSocket|ERR_CONNECTION|favicon/.test(m.text()) && errors.push(`${email}: ${m.text()}`));
  return { ctx, page, email };
}
const saveState = (page) => page.locator("[data-takeoff-save]").getAttribute("data-takeoff-save");
const waitSaved = (page, timeout = 30_000) => page.locator('[data-takeoff-save="saved"]').waitFor({ timeout });
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, name), scale: "css" });
};
/** The sheet's on-screen box: upstream draws each open sheet into one <canvas> under the overlay. */
const sheetBox = (page) =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll("[data-canvas-workspace] canvas")].find((x) => x.getBoundingClientRect().width > 50);
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
const at = (box, [nx, ny]) => ({ x: box.x + nx * box.w, y: box.y + ny * box.h });
const activeEdits = (pid) => q("select id, target_type, target_key, kind, payload, editor_email, editor_auth, client_ref from brink_takeoff_edits where project_id = $1 and superseded_at is null and reverted_at is null order by created_at", [pid]);
const currentImport = async (pid) => (await q("select current_import_id from brink_projects where id = $1", [pid]))[0].current_import_id;
const bomQty = (page, kind, tag) =>
  page.evaluate(
    ([kind, tag]) => {
      for (const tr of document.querySelectorAll('tr[data-k^="brink_bom_lines:"]')) {
        const td = [...tr.querySelectorAll("td")].map((x) => x.textContent?.trim());
        if (td[1] === kind && td[2] === tag) return Number(td[4]);
      }
      return null;
    },
    [kind, tag],
  );
const waitBomQty = async (page, kind, tag, want, ms = 30_000) => {
  const t0 = Date.now();
  for (const end = t0 + ms; Date.now() < end; await page.waitForTimeout(150)) if ((await bomQty(page, kind, tag)) === want) return Date.now() - t0;
  return null;
};
/** Shapes on view, as the status bar counts them. */
const onView = async (page) => Number((/(\d+) takeoffs? on view/.exec(await page.locator("[data-status-selection]").innerText()) ?? [])[1] ?? NaN);

let exitCode = 0;
try {
  const [proj] = await q("select id from brink_projects where name = $1", [PROJECT]);
  if (!proj) throw new Error(`no project named ${PROJECT}: import it first (README)`);
  // Start clean: revert takeoff edits left by an earlier run, take its plan files out of the set, re-import the fixture.
  await q("update brink_takeoff_edits set reverted_at = now(), reverted_by = 'takeoff-check reset' where project_id = $1 and superseded_at is null and reverted_at is null", [proj.id]);
  await q("update brink_sheets set removed_at = now(), removed_by = 'takeoff-check reset' where project_id = $1 and removed_at is null and replaced_by is null", [proj.id]);
  brinkMerge(join(BRINK, "fixtures/div27-sample.takeoff.json"), join(BRINK, "fixtures/div27-sample.report.json"));
  const importA = await currentImport(proj.id);
  const fixture = JSON.parse(readFileSync(join(BRINK, "fixtures/div27-sample.takeoff.json"), "utf8"));
  const condId = (tag) => fixture.conditions.find((c) => c.finish_tag === tag).id;
  const counts = (tag) => fixture.shapes.filter((s) => s.condition_id === condId(tag) && s.measure_role === "count");
  log("project", proj.id, "import A", importA);

  // ---- 1. user A opens the Takeoff tab: no plan file yet ----
  const A = await openUser(ALEX);
  const posts = [];
  A.page.on("request", (r) => r.method() !== "GET" && r.url().includes("/api/") && posts.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await A.page.goto(`${BASE}/projects/${proj.id}/takeoff`);
  await A.page.locator("#live[data-state='live']").waitFor({ timeout: 30_000 });
  await A.page.locator("[data-takeoff-empty]").waitFor({ timeout: 30_000 });
  await waitSaved(A.page);
  const missing = await A.page.locator("[data-missing-sheets]").innerText();
  check("Takeoff tab mounts the OpenTakeoff canvas; with no plan file, the Brink empty state names the takeoff's sheet", missing.includes("sample-plan.pdf") && missing.includes(String(fixture.shapes.length)), missing.replace(/\s+/g, " "));
  const chrome = {
    iframes: await A.page.locator("iframe").count(),
    otTopbar: await A.page.locator("[data-topbar]").count(),
    otRail: await A.page.locator("[data-tool-rail]").filter({ visible: true }).count(),
    otLogo: await A.page.getByText(/^opentakeoff$/i).filter({ visible: true }).count(),
    otStatus: await A.page.locator(".app-shell > footer.ink-panel").filter({ visible: true }).count(),
    brinkToolbar: await A.page.locator('[role=toolbar][aria-label="Takeoff tools"]').count(),
    brinkLogo: await A.page.locator("header [data-brink-logo]").count(),
    sheets: await A.page.locator("#ot-sheets").count(),
    right: await A.page.locator("#ot-right").count(),
  };
  check(
    "no iframe and no OpenTakeoff top bar, tool rail, logo or status strip: the Brink header, toolbar, sheets panel and right panel instead",
    chrome.iframes === 0 && chrome.otTopbar === 0 && chrome.otRail === 0 && chrome.otLogo === 0 && chrome.otStatus === 0 && chrome.brinkToolbar === 1 && chrome.brinkLogo === 1 && chrome.sheets === 1 && chrome.right === 1,
    JSON.stringify(chrome),
  );
  check("the app header shows the Access identity", (await A.page.locator(`[data-brink-editor="${ALEX}"]`).count()) === 1 && (await A.page.locator(`[data-editor="${ALEX}"]`).count()) === 1);
  await A.page.waitForTimeout(1000);
  check("loading the takeoff writes nothing", posts.length === 0 && (await activeEdits(proj.id)).length === 0, posts.join(", "));
  await shot(A.page, "01-no-plan-yet-light.png");

  // ---- 2. upload the sample plan through the UI ----
  const [chooser] = await Promise.all([A.page.waitForEvent("filechooser"), A.page.locator('[data-takeoff-empty] [data-action="upload-plan"]').click()]);
  await chooser.setFiles(PLAN);
  await A.page.locator('[data-sheet="sample-plan.pdf"]').waitFor({ timeout: 30_000 });
  await A.page.locator("[data-takeoff-empty]").waitFor({ state: "detached", timeout: 30_000 });
  for (const end = Date.now() + 20_000; Date.now() < end && !(await sheetBox(A.page)); ) await A.page.waitForTimeout(200);
  await A.page.waitForTimeout(1500);
  const [sheet] = await q("select id, name, storage_bucket, storage_path, byte_size, sha256, page_count, uploaded_by, uploaded_auth from brink_sheets where project_id = $1 and removed_at is null and replaced_by is null", [proj.id]);
  const planBytes = readFileSync(PLAN);
  check("the plan is stored in Supabase Storage under the Access email", sheet && sheet.name === "sample-plan.pdf" && sheet.storage_bucket === "brink-plans" && sheet.uploaded_by === ALEX && sheet.uploaded_auth === "cloudflare-access" && Number(sheet.byte_size) === planBytes.length && sheet.sha256 === sha(planBytes) && sheet.page_count === 1, sheet ? `${sheet.storage_bucket}/${sheet.storage_path}, ${sheet.byte_size} bytes, ${sheet.page_count} page` : "no row");
  const [obj] = await q("select bucket_id, name, (metadata->>'size')::int as size from storage.objects where bucket_id = 'brink-plans' and name = $1", [sheet?.storage_path ?? ""]);
  check("the object is in the private bucket (storage.objects)", obj && obj.size === planBytes.length, obj ? `${obj.bucket_id}/${obj.name}` : "missing");
  const back = Buffer.from(await (await fetch(`${BASE}/api/projects/${proj.id}/sheets/${sheet.id}/file`)).arrayBuffer());
  check("the Worker serves it back byte for byte (the browser never holds a Storage key)", sha(back) === sha(planBytes) && !(await A.page.content()).includes("service_role"), `${back.length} bytes`);
  const shown = await onView(A.page);
  check("the takeoff draws over the uploaded plan (its 41 machine shapes)", shown === fixture.shapes.length, `${shown} takeoffs on view`);
  check("uploading and opening the plan saved no takeoff edit", (await activeEdits(proj.id)).length === 0);
  await shot(A.page, "02-plan-uploaded-light.png");

  // ---- 3. user B watches BOM & issues ----
  const B = await openUser(SAM);
  await B.page.goto(`${BASE}/projects/${proj.id}/bom`);
  await B.page.locator("#live[data-state='live']").waitFor({ timeout: 30_000 });
  await B.page.locator('tr[data-k^="brink_bom_lines:"]').first().waitFor({ timeout: 30_000 });
  const data0 = await bomQty(B.page, "device", "DATA-1");
  check("BOM & issues (second user) shows the DATA-1 device line from the import", data0 === counts("DATA-1").length, `DATA-1 ${data0} EA`);

  // ---- 4. A draws a count on DATA-1 ----
  await A.page.locator("#ot-active-condition").selectOption({ label: "DATA-1" });
  await A.page.locator('[data-tool="count"]').click();
  let box = await sheetBox(A.page);
  const NEW_PT = [0.31, 0.79];
  await A.page.mouse.click(at(box, NEW_PT).x, at(box, NEW_PT).y);
  await A.page.waitForTimeout(900);
  await waitSaved(A.page);
  let edits = await activeEdits(proj.id);
  const put = edits.find((e) => e.kind === "shape_put");
  check("drawing a count with the canvas's Count tool saves a shape_put edit under the Access email", edits.length === 1 && put && put.editor_email === ALEX && put.editor_auth === "cloudflare-access" && put.payload.shape.condition_id === condId("DATA-1") && put.payload.shape.measure_role === "count" && /^ot-/.test(put.client_ref), put ? `${put.target_key} at ${JSON.stringify(put.payload.shape.verts_norm[0].map((v) => v.toFixed(3)))}` : JSON.stringify(edits));
  const importB = await currentImport(proj.id);
  check("the save re-ran the import (a new current import)", importB !== importA, `${importA.slice(0, 8)} -> ${importB.slice(0, 8)}`);
  const t4 = await waitBomQty(B.page, "device", "DATA-1", data0 + 1);
  check("the second tab's BOM shows DATA-1 +1, live (Supabase Realtime -> relay -> page)", t4 !== null, `${data0} -> ${await bomQty(B.page, "device", "DATA-1")} EA in ${t4} ms`);
  await shot(A.page, "04-count-drawn-light.png");
  await B.page.locator('tr[data-k^="brink_bom_lines:"]', { hasText: "DATA-1" }).first().scrollIntoViewIfNeeded();
  await shot(B.page, "04b-second-tab-bom-live.png");
  const [issue] = await q("select code, message from brink_issues where import_id = $1 and code = 'count_edited'", [importB]);
  check("BOM & issues says the count differs from the report because of an app edit (a warning, not an error)", issue && issue.message.includes("DATA-1"), issue?.message ?? "none");

  // ---- 5. A moves an agent's count marker (machine original kept) ----
  await A.page.locator('[data-tool="select"]').click();
  const victim = counts("DATA-1")[0];
  box = await sheetBox(A.page);
  const from = at(box, victim.verts_norm[0]);
  await A.page.mouse.click(from.x, from.y);
  await A.page.waitForTimeout(400);
  await A.page.mouse.move(from.x, from.y);
  await A.page.mouse.down();
  await A.page.mouse.move(from.x + 15, from.y + 10, { steps: 6 });
  await A.page.mouse.move(from.x + 30, from.y + 20, { steps: 6 });
  await A.page.mouse.up();
  await A.page.waitForTimeout(900);
  await waitSaved(A.page);
  edits = await activeEdits(proj.id);
  const moved = edits.find((e) => e.target_key === victim.id);
  const mo = moved?.payload.shape.origin ?? {};
  check(
    "moving an agent's marker saves a shape_put that keeps the machine's original ring and actor",
    moved && moved.kind === "shape_put" && JSON.stringify(moved.payload.shape.verts_norm) !== JSON.stringify(victim.verts_norm) && mo.actor === "agent" && JSON.stringify(mo.proposed_verts_norm) === JSON.stringify(victim.verts_norm),
    moved ? `origin ${JSON.stringify({ actor: mo.actor, edited: mo.edited, proposed_verts_norm: mo.proposed_verts_norm })}` : "no edit",
  );
  const importC = await currentImport(proj.id);
  const [{ takeoff: raw, takeoff_sha256 }] = await q("select takeoff, takeoff_sha256 from brink_imports where id = $1", [importC]);
  check("the import's stored takeoff is still the machine original (the edit is a layer)", JSON.stringify(raw.shapes.find((s) => s.id === victim.id).verts_norm) === JSON.stringify(victim.verts_norm) && takeoff_sha256 === sha(readFileSync(join(BRINK, "fixtures/div27-sample.takeoff.json"))), `takeoff_sha256 ${takeoff_sha256.slice(0, 12)}`);
  await A.page.locator('[data-tab-key="inspector"]').click();
  await A.page.locator(`[data-inspector="${victim.id}"]`).waitFor({ timeout: 10_000 });
  const insp = await A.page.locator(`[data-inspector="${victim.id}"]`).innerText();
  check("the Brink inspector says an agent made it and its original is kept", /An agent/.test(insp) && /kept/.test(insp), insp.replace(/\s+/g, " ").slice(0, 200));
  await shot(A.page, "05-machine-marker-moved-inspector-light.png");

  // ---- 6. A deletes a count ----
  const gone = counts("DATA-1")[1];
  box = await sheetBox(A.page);
  const gp = at(box, gone.verts_norm[0]);
  await A.page.mouse.click(gp.x, gp.y);
  await A.page.waitForTimeout(400);
  await A.page.keyboard.press("Delete");
  await A.page.waitForTimeout(900);
  await waitSaved(A.page);
  edits = await activeEdits(proj.id);
  const del = edits.find((e) => e.target_key === gone.id);
  check("deleting a takeoff saves a shape_delete edit", del?.kind === "shape_delete" && del.editor_email === ALEX, del ? del.kind : JSON.stringify(edits.map((e) => e.kind)));
  const t6 = await waitBomQty(B.page, "device", "DATA-1", data0);
  check("the second tab's BOM goes back to the import's count, live", t6 !== null, `DATA-1 ${await bomQty(B.page, "device", "DATA-1")} EA in ${t6} ms`);

  // ---- 7. B opens the Takeoff tab; A draws again; B sees it live ----
  await B.page.locator('[data-tab="takeoff"]').click();
  await B.page.locator('[data-sheet="sample-plan.pdf"]').waitFor({ timeout: 30_000 });
  for (const end = Date.now() + 20_000; Date.now() < end && !(await sheetBox(B.page)); ) await B.page.waitForTimeout(200);
  await B.page.waitForTimeout(1500);
  const bBefore = await onView(B.page);
  check("the second user's canvas shows the takeoff with A's edits", bBefore === fixture.shapes.length, `${bBefore} on view`);
  await A.page.locator('[data-tool="count"]').click();
  box = await sheetBox(A.page);
  const P2 = [0.62, 0.79];
  await A.page.mouse.click(at(box, P2).x, at(box, P2).y);
  await A.page.waitForTimeout(900);
  await waitSaved(A.page);
  let tLive = null;
  const t7 = Date.now();
  for (const end = t7 + 20_000; Date.now() < end; await B.page.waitForTimeout(150)) {
    if ((await onView(B.page)) === bBefore + 1) {
      tLive = Date.now() - t7;
      break;
    }
  }
  check("A's new count appears on B's canvas, live (the canvas's own sync bridge re-hydrates)", tLive !== null, `${bBefore} -> ${await onView(B.page)} in ${tLive} ms`);
  const echo = await A.page.locator('[data-notice="info"]').count();
  check("the saving tab ignored its own echo (no reload notice)", echo === 0 && (await saveState(A.page)) === "saved");
  await shot(B.page, "07-second-tab-canvas-live-light.png");

  // ---- 8. reload, re-import ----
  await A.page.reload();
  await A.page.locator('[data-sheet="sample-plan.pdf"]').waitFor({ timeout: 30_000 });
  for (const end = Date.now() + 20_000; Date.now() < end && !(await sheetBox(A.page)); ) await A.page.waitForTimeout(200);
  await A.page.waitForTimeout(1500);
  const afterReload = await onView(A.page);
  check("after a reload the edits persist (41 + 2 drawn - 1 deleted)", afterReload === fixture.shapes.length + 1 && (await activeEdits(proj.id)).length === 4, `${afterReload} on view, ${(await activeEdits(proj.id)).length} active edits`);
  brinkMerge(join(BRINK, "fixtures/div27-sample.takeoff.json"), join(BRINK, "fixtures/div27-sample.report.json"));
  await A.page.locator('[data-notice="info"]', { hasText: "re-imported" }).first().waitFor({ timeout: 30_000 });
  await A.page.waitForTimeout(1500);
  const afterReimport = await onView(A.page);
  const [{ n: applied }] = await q("select count(*)::int as n from brink_bom_lines l join brink_projects p on p.current_import_id = l.import_id where p.id = $1 and l.kind = 'device' and l.condition_key = 'DATA-1' and l.qty = $2", [proj.id, data0 + 1]);
  check("re-import with the brink-merge CLI: the canvas reloads the new import with the edits re-applied, and so does the BOM", afterReimport === fixture.shapes.length + 1 && applied === 1, `${afterReimport} on view; DATA-1 ${data0 + 1} EA on the new import`);

  // ---- 9. exporters, screenshots, phone width ----
  for (const [id, re] of [["ot-marked-set", /\.pdf$/i], ["ot-dxf", /\.dxf$/i], ["ot-takeoff-json", /\.takeoff\.json$/i]]) {
    await A.page.locator('[data-menu="project-menu"]').click();
    const [dl] = await Promise.all([A.page.waitForEvent("download", { timeout: 30_000 }).catch(() => null), A.page.locator(`[data-menuitem="${id}"]`).click()]);
    const name = dl?.suggestedFilename() ?? "";
    let size = 0;
    if (dl) size = readFileSync(await dl.path()).length;
    check(`the Project menu runs upstream's exporter: ${id.replace("ot-", "")}`, re.test(name) && size > 0, `${name} (${size} bytes)`);
  }
  await A.page.locator('[data-menu="project-menu"]').click();
  await shot(A.page, "09-project-menu-light.png");
  await A.page.keyboard.press("Escape");
  await A.page.locator('[data-tab-key="conditions"]').click();
  await shot(A.page, "09b-takeoff-tab-light.png");

  const D = await openUser(ALEX, { dark: true });
  await D.page.goto(`${BASE}/projects/${proj.id}/takeoff`);
  await D.page.locator('[data-sheet="sample-plan.pdf"]').waitFor({ timeout: 30_000 });
  for (const end = Date.now() + 20_000; Date.now() < end && !(await sheetBox(D.page)); ) await D.page.waitForTimeout(200);
  await D.page.waitForTimeout(1500);
  check("dark mode: the app's .dark class themes the canvas chrome", await D.page.evaluate(() => document.documentElement.classList.contains("dark") && getComputedStyle(document.querySelector(".bk-ot .app-shell")).getPropertyValue("--paper-bright").trim() !== ""));
  await shot(D.page, "09c-takeoff-tab-dark.png");
  await D.page.locator('[data-menu="project-menu"]').click();
  await shot(D.page, "09d-project-menu-dark.png");
  await D.page.keyboard.press("Escape");
  await D.ctx.close();

  await A.page.setViewportSize({ width: 390, height: 844 });
  await A.page.waitForTimeout(600);
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("phone width (390 px): no horizontal page scroll on the Takeoff tab", overflow <= 0, `${overflow}px`);
  await A.page.screenshot({ path: join(OUT, "10-phone-takeoff.png"), scale: "css" });

  check("no page errors in any tab", errors.length === 0, errors.slice(0, 5).join(" | "));
  await A.ctx.close();
  await B.ctx.close();
} catch (e) {
  check("run completed", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  wrangler.kill("SIGTERM");
  jwks.close();
  await db.end();
  rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), project: PROJECT, access: "Cloudflare Access JWTs verified by the Worker (local stand-in team)", realtime: "local Supabase Realtime", storage: "local Supabase Storage (bucket brink-plans)", results }, null, 2) + "\n");
  log(`${results.length - failed.length}/${results.length} checks passed; evidence in ${OUT}`);
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
