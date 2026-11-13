#!/usr/bin/env node
// End-to-end check of the Schematic tab in a real browser (Playwright, chromium):
// the vendored EasySchematic editor mounted directly in the app (no frame) with the
// Brink toolbar, panels and header, its saves to the edit layer, live updates, and
// edits surviving re-imports. Self-contained: it builds the app, runs
// `wrangler dev` with Cloudflare Access configured against a local stand-in team
// (an RSA key and its JWKS, so every write goes through real JWT verification),
// and drives two browser contexts as two different Access users.
//
//   1. open the Schematic tab: the editor loads the project's schematic; loading writes nothing;
//      no iframe, no EasySchematic logo / menu bar: the Brink header and toolbar instead
//   2. a second user opens the same project in another tab
//   3. user A drags a device (real EasySchematic UI): a `move` edit is saved under A's email
//   4. user A renames a device in EasySchematic's device editor: a `rename` edit is saved
//   5. the second tab shows both live (relayed through Supabase Realtime); A's tab ignores its own echo
//   6. reload: both edits persist
//   7. re-import the same takeoff with the brink-merge CLI: the editor reloads, edits still applied
//   8. delete the renamed device from a copy of the takeoff and re-import: the orphaned edits are
//      warning issues in BOM & Issues
//   9. re-import the original: the device and its edits come back
//   also: the Brink inspector shows the selection; reports open from the Brink Project menu;
//   plain keys typed in Brink chrome never act on the canvas
// Screenshots and results.json go to docs/evidence/cohesive/es-check/ (Phase 2's run, in its
// iframe, is kept in docs/evidence/phase2/). Uses only brink-merge's invented fixtures.
//
// usage: node scripts/es-check.mjs [--db postgres://...] [--project "Brink Div 27 sample (invented)"] [--out docs/evidence/cohesive/es-check] [--no-build]
// Needs: local Supabase (README "Run it locally") with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .dev.vars,
// and Playwright (`require('playwright')`).
import { execFileSync, spawn } from "node:child_process";
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
const OUT = resolve(args.out ?? join(ROOT, "docs/evidence/cohesive/es-check"));
const BRINK = resolve(ROOT, "../brink-merge");
const TMP = mkdtempSync(join(tmpdir(), "brink-es-check-"));

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

// ---- a stand-in Cloudflare Access team: one RSA key, its JWKS, RS256 tokens ----
const AUD = "es-check-aud";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
const jwks = createServer((req, res) => {
  if (req.url !== "/cdn-cgi/access/certs") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", kid: "es-check", use: "sig" }] }));
});
await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
const TEAM = `http://127.0.0.1:${jwks.address().port}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function accessToken(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", kid: "es-check", typ: "JWT" });
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
async function openUser(email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": await accessToken(email) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e}`));
  page.on("console", (m) => m.type() === "error" && !/WebSocket|ERR_CONNECTION|favicon/.test(m.text()) && errors.push(`${email}: ${m.text()}`));
  return { ctx, page, email };
}
/** The editor, mounted in the page itself (the Schematic workspace root). */
const editorFrame = (page) => page.locator("[data-es-root]");
const saveState = (page) => page.locator("[data-save-state]").getAttribute("data-save-state");
const waitSaved = (page, timeout = 20_000) => page.locator('[data-save-state="saved"]').waitFor({ timeout });
const shot = async (page, name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, name), fullPage: false, scale: "css" });
};
/** A close-up of one room of the schematic (2x), to read device labels. */
const closeup = async (page, roomId, name) => {
  await page.waitForTimeout(300);
  const b = await editorFrame(page).locator(`.react-flow__node[data-id="${roomId}"]`).boundingBox();
  if (!b) return;
  const pad = 24;
  await page.screenshot({ path: join(OUT, name), clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } });
};
const nodeLoc = (page, id) => editorFrame(page).locator(`.react-flow__node[data-id="${id}"]`);
/** A node's flow position, read from the editor's DOM (React Flow's transform). */
const nodeXY = (page, id) =>
  nodeLoc(page, id).evaluate((el) => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  });
const nodeLabel = (page, id) => nodeLoc(page, id).innerText();
const activeEdits = (pid) => q("select id, target_key, kind, payload, editor_email, editor_auth, client_ref from brink_schematic_edits where project_id = $1 and superseded_at is null and reverted_at is null order by created_at", [pid]);

let exitCode = 0;
try {
  const [proj] = await q("select id from brink_projects where name = $1", [PROJECT]);
  if (!proj) throw new Error(`no project named ${PROJECT}: import it first (README)`);
  // Start from the generated schematic: revert edits left by an earlier run, and re-import the fixture.
  await q("update brink_schematic_edits set reverted_at = now(), reverted_by = 'es-check reset' where project_id = $1 and superseded_at is null and reverted_at is null", [proj.id]);
  brinkMerge(join(BRINK, "fixtures/div27-sample.takeoff.json"), join(BRINK, "fixtures/div27-sample.report.json"));
  const [{ current_import_id: importA }] = await q("select current_import_id from brink_projects where id = $1", [proj.id]);
  log("project", proj.id, "import A", importA);

  // Pick the devices from the API's view.
  const view = await (await fetch(`${BASE}/api/projects/${proj.id}/schematic`)).json();
  const devices = view.file.nodes.filter((n) => n.type === "device" && n.id.startsWith("dev-"));
  const byRoom = (room) => devices.filter((d) => d.parentId === room);
  const room = view.file.nodes.find((n) => n.type === "room" && byRoom(n.id).length >= 3);
  const [moved, renamed] = byRoom(room.id);
  const renamedShape = renamed.data.brink.shapeId;
  check("the API renders stable ids (dev-<OpenTakeoff shape id>-<copy>)", moved.id === `dev-${moved.data.brink.shapeId}-1`, `${moved.id}, ${renamed.id} in ${room.data.label}`);

  // ---- 1. user A opens the Schematic tab ----
  const A = await openUser(ALEX);
  const posts = [];
  A.page.on("request", (r) => r.method() === "POST" && r.url().includes("/schematic/edits") && posts.push(r));
  await A.page.goto(`${BASE}/projects/${proj.id}/schematic`);
  await A.page.locator("#live[data-state='live']").waitFor({ timeout: 30_000 });
  await nodeLoc(A.page, moved.id).waitFor({ timeout: 30_000 });
  await waitSaved(A.page);
  const deviceCount = await editorFrame(A.page).locator('.react-flow__node-device').count();
  check("Schematic tab mounts the EasySchematic editor with the project's schematic", deviceCount === devices.length + view.file.nodes.filter((n) => n.id.startsWith("tr-")).length, `${deviceCount} device nodes in the editor`);
  check("the app header shows the Access identity, not an EasySchematic log-in", (await A.page.locator(`[data-brink-editor="${ALEX}"]`).count()) === 1 && (await A.page.getByText("Log in", { exact: true }).count()) === 0);
  const chrome = {
    iframes: await A.page.locator("iframe").count(),
    esLogo: await A.page.locator('img[src*="favicon.svg"]').count(),
    // Visible text only: the print-only title block keeps upstream's "EasySchematic" credit line (hidden on screen).
    esName: await A.page.getByText("EasySchematic", { exact: true }).filter({ visible: true }).count(),
    esMenus: await A.page.locator("[data-es-root] button", { hasText: /^(File|Export|Reports|Help)$/ }).count(),
    brinkToolbar: await A.page.locator("[data-brink-toolbar] [role=toolbar]").count(),
    brinkLogo: await A.page.locator("header [data-brink-logo]").count(),
  };
  check("no iframe and no EasySchematic logo or menu bar in the Schematic tab: the Brink header and toolbar instead", chrome.iframes === 0 && chrome.esLogo === 0 && chrome.esName === 0 && chrome.esMenus === 0 && chrome.brinkToolbar === 1 && chrome.brinkLogo === 1, JSON.stringify(chrome));
  await editorFrame(A.page).locator(".react-flow__controls-fitview").click();
  await A.page.waitForTimeout(1500);
  check("loading the editor writes nothing", posts.length === 0 && (await activeEdits(proj.id)).length === 0, `${posts.length} POSTs`);
  await shot(A.page, "01-editor-loaded.png");

  // The Brink inspector shows the selected device.
  await nodeLoc(A.page, moved.id).click({ position: { x: 40, y: 10 } });
  await A.page.locator(`[data-inspector="${moved.id}"]`).waitFor({ timeout: 10_000 });
  const inspectorName = await A.page.locator("[data-inspector-name]").inputValue();
  check("the Brink inspector shows the selected device and its takeoff source", inspectorName === moved.data.label && (await A.page.locator(`[data-inspector="${moved.id}"]`).innerText()).includes(moved.data.brink.shapeId), inspectorName);
  await shot(A.page, "01b-inspector.png");

  // Plain keys typed in Brink chrome do not reach EasySchematic's canvas shortcuts.
  await A.page.locator('[data-menu="insert"]').focus();
  await A.page.keyboard.press("Delete");
  await A.page.keyboard.press("Backspace");
  await A.page.waitForTimeout(300);
  check("Delete / Backspace in the Brink toolbar do not delete the selected device", (await nodeLoc(A.page, moved.id).count()) === 1 && posts.length === 0);
  await A.page.keyboard.press("Escape");

  // Reports open from the Brink Project menu (upstream's report generators and dialog).
  for (const [id, title, file] of [["report-pack-list", /pack list/i, "01c-report-pack-list.png"], ["report-cable-schedule", /cable schedule/i, "01d-report-cable-schedule.png"]]) {
    await A.page.locator('[data-menu="project-menu"]').click();
    await A.page.locator(`[data-menuitem="${id}"]`).click();
    const dlg = A.page.getByText(title).first();
    await dlg.waitFor({ timeout: 10_000 });
    await shot(A.page, file);
    check(`the Project menu opens the ${id.replace("report-", "").replace("-", " ")} report`, await dlg.isVisible());
    // Upstream's dialog closes on a click outside it.
    await A.page.mouse.click(6, 700);
    await A.page.waitForTimeout(300);
  }
  check("opening reports writes nothing", posts.length === 0, `${posts.length} POSTs`);

  // ---- 2. user B opens the same project ----
  const B = await openUser(SAM);
  await B.page.goto(`${BASE}/projects/${proj.id}/schematic`);
  await B.page.locator("#live[data-state='live']").waitFor({ timeout: 30_000 });
  await nodeLoc(B.page, moved.id).waitFor({ timeout: 30_000 });
  await waitSaved(B.page);
  const before = await nodeXY(B.page, moved.id);

  // ---- 3. A drags a device, a little, inside its room ----
  const box = await nodeLoc(A.page, moved.id).boundingBox();
  await A.page.mouse.move(box.x + box.width / 2, box.y + 8);
  await A.page.mouse.down();
  await A.page.mouse.move(box.x + box.width / 2 + 6, box.y + 8 + 8, { steps: 8 });
  await A.page.mouse.move(box.x + box.width / 2 + 12, box.y + 8 + 16, { steps: 8 });
  await A.page.mouse.up();
  await A.page.waitForTimeout(400);
  await waitSaved(A.page);
  const afterA = await nodeXY(A.page, moved.id);
  const moveRow = (await activeEdits(proj.id)).find((e) => e.target_key === moved.id && e.kind === "move");
  check("dragging a device in the editor saves a move edit under the Access email", moveRow && moveRow.editor_email === ALEX && moveRow.editor_auth === "cloudflare-access" && moveRow.payload.parent === room.id && moveRow.payload.x % 16 === 0 && moveRow.payload.y % 16 === 0, moveRow ? JSON.stringify(moveRow.payload) : "no edit");
  check("the device really moved", afterA && before && (afterA.x !== before.x || afterA.y !== before.y), `${JSON.stringify(before)} -> ${JSON.stringify(afterA)}`);
  await shot(A.page, "02-device-moved.png");
  await closeup(A.page, room.id, "02b-device-moved-closeup.png");

  // ---- 4. A renames a device in EasySchematic's device editor ----
  const NEW_LABEL = "Reception desk (renamed in the app)";
  await nodeLoc(A.page, renamed.id).dblclick({ position: { x: 40, y: 10 } });
  const nameInput = editorFrame(A.page).getByPlaceholder("e.g. Camera 1");
  await nameInput.waitFor({ timeout: 10_000 });
  await nameInput.fill(NEW_LABEL);
  await shot(A.page, "03-rename-in-device-editor.png");
  await editorFrame(A.page).getByRole("button", { name: "Apply", exact: true }).click();
  await A.page.waitForTimeout(300);
  await waitSaved(A.page);
  const renameRow = (await activeEdits(proj.id)).find((e) => e.target_key === renamed.id && e.kind === "rename");
  check("renaming a device in EasySchematic's device editor saves a rename edit", renameRow?.payload?.label === NEW_LABEL && renameRow.editor_email === ALEX, renameRow ? JSON.stringify(renameRow.payload) : "no edit");
  const unsupportedA = (await A.page.locator("[data-unsupported]").count()) ? await A.page.locator("[data-unsupported] li").allTextContents() : [];
  check("nothing in these edits is left unsaved", unsupportedA.length === 0, unsupportedA.join(" | "));
  await shot(A.page, "04-renamed-saved.png");
  await closeup(A.page, room.id, "04b-renamed-closeup.png");

  // ---- 5. B sees both, live; A ignored its own echo ----
  const t5 = Date.now();
  await B.page.waitForFunction(() => true);
  await nodeLoc(B.page, renamed.id).getByText(NEW_LABEL).waitFor({ timeout: 20_000 });
  const tLabel = Date.now() - t5;
  let afterB = null;
  for (const end = Date.now() + 15_000; Date.now() < end; await B.page.waitForTimeout(200)) {
    afterB = await nodeXY(B.page, moved.id);
    if (afterB && (afterB.x !== before.x || afterB.y !== before.y)) break;
  }
  // A's editor shows the drag as it ended; the saved position is on EasySchematic's 16 px grid, as its own load snaps it.
  const near = (p, r) => p && r && Math.abs(p.x - r.x) < 16 && Math.abs(p.y - r.y) < 16;
  check("the second tab shows the rename and the move live (Supabase Realtime -> relay -> page -> editor)", afterB && (afterB.x !== before.x || afterB.y !== before.y) && near(afterB, afterA), `label in ${tLabel} ms; position ${JSON.stringify(before)} -> ${JSON.stringify(afterB)} (A: ${JSON.stringify(afterA)})`);
  const echoNotices = await A.page.locator('[data-notice="warn"]').count();
  check("the saving tab ignored its own echo (no reload, no conflict notice)", echoNotices === 0 && (await saveState(A.page)) === "saved");
  await editorFrame(B.page).locator(".react-flow__controls-fitview").click();
  await shot(B.page, "05-second-tab-live.png");
  await closeup(B.page, room.id, "05b-second-tab-live-closeup.png");

  // ---- 6. reload ----
  await A.page.reload();
  await nodeLoc(A.page, renamed.id).waitFor({ timeout: 30_000 });
  await waitSaved(A.page);
  const reloaded = await nodeXY(A.page, moved.id);
  check("after a reload both edits persist (the same position the second tab shows)", (await nodeLabel(A.page, renamed.id)).includes(NEW_LABEL) && reloaded?.x === afterB.x && reloaded?.y === afterB.y, JSON.stringify(reloaded));
  check("reloading writes nothing new", (await activeEdits(proj.id)).length === 2);
  await editorFrame(A.page).locator(".react-flow__controls-fitview").click();
  await shot(A.page, "06-after-reload.png");

  // ---- 7. re-import the same takeoff ----
  brinkMerge(join(BRINK, "fixtures/div27-sample.takeoff.json"), join(BRINK, "fixtures/div27-sample.report.json"));
  const [{ current_import_id: importB }] = await q("select current_import_id from brink_projects where id = $1", [proj.id]);
  await A.page.locator('[data-notice="info"]', { hasText: "re-imported" }).first().waitFor({ timeout: 30_000 });
  await waitSaved(A.page);
  await nodeLoc(A.page, renamed.id).getByText(NEW_LABEL).waitFor({ timeout: 20_000 });
  const reimported = await nodeXY(A.page, moved.id);
  check("re-import: the editor reloads the new import with the edits still applied", importB !== importA && reimported?.x === afterB.x && reimported?.y === afterB.y, `import ${importA.slice(0, 8)} -> ${importB.slice(0, 8)}, ${moved.id} at ${JSON.stringify(reimported)}`);
  await editorFrame(A.page).locator(".react-flow__controls-fitview").click();
  await shot(A.page, "07-after-reimport.png");
  await closeup(A.page, room.id, "07b-after-reimport-closeup.png");

  // ---- 8. delete the renamed device from a copy of the takeoff, re-import ----
  const takeoff = JSON.parse(readFileSync(join(BRINK, "fixtures/div27-sample.takeoff.json"), "utf8"));
  const report = JSON.parse(readFileSync(join(BRINK, "fixtures/div27-sample.report.json"), "utf8"));
  const shape = takeoff.shapes.find((s) => s.id === renamedShape);
  const runs = new Set(takeoff.cable_runs.filter((r) => r.device_shape_ids.includes(renamedShape)).map((r) => r.id));
  takeoff.shapes = takeoff.shapes.filter((s) => s.id !== renamedShape);
  takeoff.cable_runs = takeoff.cable_runs.filter((r) => !runs.has(r.id));
  const cond = report.conditions.find((c) => c.id === shape.condition_id);
  cond.ea -= (shape.computed?.count ?? 1) * (cond.multiplier ?? 1);
  cond.shape_count -= 1;
  for (const run of report.cable.runs.filter((r) => runs.has(r.run_id))) {
    const row = report.cable.summary.find((s) => s.condition_id === shape.condition_id && s.tr_name === run.tr);
    const r2 = (n) => Math.round(n * 100) / 100;
    Object.assign(row, { ea: row.ea - 1, pulls: row.pulls - 1, cables: row.cables - run.cables, route_lf: r2(row.route_lf - run.route_lf), cable_lf: r2(row.cable_lf - run.location_lf), cable_lf_order: r2(row.cable_lf_order - run.location_lf * (1 + row.waste_pct / 100)) });
  }
  report.cable.runs = report.cable.runs.filter((r) => !runs.has(r.run_id));
  writeFileSync(join(TMP, "deleted.takeoff.json"), JSON.stringify(takeoff));
  writeFileSync(join(TMP, "deleted.report.json"), JSON.stringify(report));
  const cli = brinkMerge(join(TMP, "deleted.takeoff.json"), join(TMP, "deleted.report.json"));
  check("brink-merge reports the orphaned edit on the import (CLI)", /warning \[schematic_edit_orphaned\] Schematic edit \(alex@brink\.test/.test(cli), cli.split("\n").find((l) => l.includes("schematic_edit_orphaned")) ?? "");
  await A.page.locator('[data-notice="info"]', { hasText: "re-imported" }).first().waitFor({ timeout: 30_000 });
  await A.page.locator('[data-tab="bom"]').click();
  const issue = A.page.locator("tr", { hasText: "schematic_edit_orphaned" }).first();
  await issue.waitFor({ timeout: 20_000 });
  const issueText = await issue.innerText();
  check("BOM & Issues shows the orphaned edit as a warning issue", issueText.includes(NEW_LABEL) && issueText.includes(ALEX), issueText.replace(/\s+/g, " ").slice(0, 300));
  await issue.scrollIntoViewIfNeeded();
  await A.page.screenshot({ path: join(OUT, "08-orphaned-edit-issue.png"), fullPage: true, scale: "css" });
  await A.page.locator("section", { has: A.page.locator("h2", { hasText: /^Issues$/ }) }).screenshot({ path: join(OUT, "08b-issues-panel.png"), scale: "css" });
  const stillActive = (await activeEdits(proj.id)).length;
  check("the orphaned edit is kept, not dropped", stillActive === 2, `${stillActive} active edits`);
  await A.page.locator('[data-tab="schematic"]').click();
  await waitSaved(A.page);
  check("the editor does not show the deleted device, and nothing else took its name", (await nodeLoc(A.page, renamed.id).count()) === 0 && (await editorFrame(A.page).locator(".react-flow").getByText(NEW_LABEL).count()) === 0);
  await editorFrame(A.page).locator(".react-flow__controls-fitview").click();
  await shot(A.page, "09-editor-device-deleted.png");
  await closeup(A.page, room.id, "09b-device-deleted-closeup.png");

  // ---- 9. the device comes back ----
  brinkMerge(join(BRINK, "fixtures/div27-sample.takeoff.json"), join(BRINK, "fixtures/div27-sample.report.json"));
  await nodeLoc(A.page, renamed.id).getByText(NEW_LABEL).waitFor({ timeout: 30_000 });
  const [{ n: orphans }] = await q("select count(*)::int as n from brink_issues i join brink_projects p on p.current_import_id = i.import_id where p.id = $1 and i.code = 'schematic_edit_orphaned'", [proj.id]);
  check("re-importing with the device restored applies its edits again (no orphan issue)", orphans === 0);
  await editorFrame(A.page).locator(".react-flow__controls-fitview").click();
  await shot(A.page, "10-device-restored.png");
  await closeup(A.page, room.id, "10b-device-restored-closeup.png");

  // ---- phone width: the tab still fits ----
  await A.page.setViewportSize({ width: 390, height: 844 });
  await A.page.waitForTimeout(500);
  const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("phone width (390 px): no horizontal page scroll on the Schematic tab", overflow <= 0, `${overflow}px`);
  await A.page.screenshot({ path: join(OUT, "11-phone-schematic.png"), scale: "css" });

  check("no page errors in either tab", errors.length === 0, errors.slice(0, 5).join(" | "));
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
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ ranAt: new Date().toISOString(), project: PROJECT, access: "Cloudflare Access JWTs verified by the Worker (local stand-in team)", realtime: "local Supabase Realtime", results }, null, 2) + "\n");
  log(`${results.length - failed.length}/${results.length} checks passed; evidence in ${OUT}`);
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
