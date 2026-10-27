#!/usr/bin/env node
// End-to-end check of the Phase 1 app shell in a real browser (Playwright, chromium),
// against a running `npm run dev` and the database it reads:
//   1. Projects page: Live, totals match the database; a BOM edit updates the row live
//   2. BOM & Issues tab: UPDATE a BOM line and a connection, INSERT / DELETE an issue,
//      each appears without a reload
//   3. Schematic tab: the generated-rows outline under the editor; a connection edit appears live
//   4. Takeoff tab: placeholder
//   5. re-import with the brink-merge CLI: the page switches to the new import
//   6. phone width (390 px): no horizontal page scroll on any view
// Screenshots and results.json go to docs/evidence/phase1/. Uses only brink-merge's invented fixtures.
//
// usage: node scripts/live-check.mjs [--url http://127.0.0.1:8787] [--db postgres://...] [--project "Brink Div 27 sample (invented)"] [--out docs/evidence/phase1]
// Needs Playwright (`require('playwright')`: global install, or `npx playwright install chromium`).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.url ?? "http://127.0.0.1:8787";
const DB = args.db ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const PROJECT = args.project ?? "Brink Div 27 sample (invented)";
const OUT = resolve(args.out ?? join(here, "../docs/evidence/phase1"));
const BRINK = resolve(here, "../../brink-merge");
const TMP = mkdtempSync(join(tmpdir(), "brink-live-check-"));

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright not found: npm i -g playwright && npx playwright install chromium (or set NODE_PATH to the global node_modules)");
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

const [proj] = await q("select id, current_import_id from brink_projects where name = $1", [PROJECT]);
if (!proj) throw new Error(`no project named ${PROJECT}: import it first (see README)`);
const imp = proj.current_import_id;
log("project", proj.id, "import", imp);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail);
};
const shot = async (name, fullPage = true) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, name), fullPage });
};
const textIs = (selector, value, timeout = 10_000) =>
  page.waitForFunction(([s, v]) => document.querySelector(s)?.textContent === v, [selector, value], { timeout });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const live = () => page.locator('#live[data-state="live"]').waitFor({ timeout: 20_000 });

try {
  // --- 1. Projects ---
  await page.goto(`${BASE}/`);
  await page.evaluate(() => (window.__liveCheckMarker = "same-document"));
  await live();
  const row = `tr[data-project="${proj.id}"]`;
  await page.locator(row).waitFor();
  const [tot] = await q(
    `select sum(qty) filter (where kind = 'device') as devices, sum((line->>'cables')::numeric) filter (where kind = 'cable') as cables,
            sum(net_lf) filter (where kind = 'cable') as net, sum(order_lf) filter (where kind = 'cable') as ord
       from brink_bom_lines where import_id = $1`,
    [imp],
  );
  const cells = await page.locator(`${row} td`).allInnerTexts();
  check("projects row shows the current import's BOM totals", cells[2] === fmt(tot.devices) && cells[3] === fmt(tot.cables) && cells[4] === fmt(tot.net) && cells[5] === fmt(tot.ord), cells.join(" | "));
  const pushNote = await page.locator("#portal-push-note").innerText();
  const hasPushTable = (await q("select to_regclass('public.brink_portal_pushes') is not null as t"))[0].t;
  check("Portal push column follows the database", hasPushTable ? (await page.locator("th", { hasText: "Portal push" }).count()) === 1 : pushNote.includes("no brink_portal_pushes table"), pushNote);
  await shot("01-projects.png");

  const [cab] = await q("select line_no, net_lf from brink_bom_lines where import_id = $1 and kind = 'cable' order by line_no limit 1", [imp]);
  const t0 = Date.now();
  await q("update brink_bom_lines set net_lf = net_lf + 100 where import_id = $1 and line_no = $2", [imp, cab.line_no]);
  await textIs(`${row} td:nth-child(5)`, fmt(Number(tot.net) + 100), 15_000);
  check("projects page: BOM edit updates the row's Net LF live", true, `${fmt(tot.net)} -> ${fmt(Number(tot.net) + 100)} in ${Date.now() - t0} ms`);
  await shot("02-projects-live-change.png");
  await q("update brink_bom_lines set net_lf = $3 where import_id = $1 and line_no = $2", [imp, cab.line_no, cab.net_lf]);

  // --- 2. BOM & Issues (client-side navigation: no reload) ---
  await page.locator(`${row} a`).click();
  await page.waitForURL(`**/projects/${proj.id}/bom`);
  await page.locator(`tr[data-k="brink_bom_lines:${imp}|2"]`).waitFor();
  await live();
  check("project link opens the BOM & Issues tab", true, page.url());
  await shot("03-bom-issues.png");

  const [bom2] = await q("select qty from brink_bom_lines where import_id = $1 and line_no = 2", [imp]);
  const newQty = Number(bom2.qty) + 3;
  const t1 = Date.now();
  await q("update brink_bom_lines set qty = $2 where import_id = $1 and line_no = 2", [imp, newQty]);
  await textIs(`tr[data-k="brink_bom_lines:${imp}|2"] td:nth-child(5)`, fmt(newQty));
  check("BOM qty UPDATE appears without reload", true, `${bom2.qty} -> ${newQty} in ${Date.now() - t1} ms`);

  const [con1] = await q("select edge_id, cable_length_ft from brink_schematic_connections where import_id = $1 and seq = 1", [imp]);
  const conKey = `brink_schematic_connections:${imp}|${con1.edge_id}`;
  const newLen = Math.round((Number(con1.cable_length_ft) + 10.5) * 100) / 100;
  const t2 = Date.now();
  await q("update brink_schematic_connections set cable_length_ft = $2 where import_id = $1 and seq = 1", [imp, newLen]);
  await textIs(`tr[data-k="${conKey}"] td:nth-child(6)`, fmt(newLen));
  check("connection cable_length_ft UPDATE appears", true, `${con1.cable_length_ft} -> ${newLen} in ${Date.now() - t2} ms`);

  const t3 = Date.now();
  await q("insert into brink_issues (import_id, seq, severity, code, message) values ($1, 1000, 'error', 'live_check', 'Invented live-check issue: inserted by dashboard/scripts/live-check.mjs')", [imp]);
  const issueRow = page.locator(`tr[data-k="brink_issues:${imp}|1000"]`);
  await issueRow.waitFor({ timeout: 10_000 });
  check("issue INSERT appears (flashing)", (await issueRow.getAttribute("class"))?.includes("flash") ?? false, `${Date.now() - t3} ms`);
  await issueRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, "04-bom-live-change.png"), fullPage: false });
  await shot("04b-bom-live-change-full.png");

  const t4 = Date.now();
  await q("delete from brink_issues where import_id = $1 and seq = 1000", [imp]);
  await issueRow.waitFor({ state: "detached", timeout: 10_000 });
  check("issue DELETE disappears", true, `${Date.now() - t4} ms`);

  // --- 3. Schematic ---
  await page.locator('[data-tab="schematic"]').click();
  await page.locator("iframe[data-es-frame]").waitFor();
  await page.locator("#schematic-outline").waitFor();
  check("Schematic tab: editor frame and the generated-rows outline", (await page.locator("iframe[data-es-frame]").count()) === 1);
  const t5 = Date.now();
  const len2 = Math.round((newLen + 1.25) * 100) / 100;
  await q("update brink_schematic_connections set cable_length_ft = $2 where import_id = $1 and seq = 1", [imp, len2]);
  await page.waitForFunction((v) => document.querySelector("#schematic-outline")?.textContent?.includes(v), `${fmt(len2)} ft`, { timeout: 10_000 });
  check("Schematic outline: connection edit appears live", true, `${newLen} -> ${len2} in ${Date.now() - t5} ms`);
  await shot("05-schematic.png");

  // --- 4. Takeoff ---
  await page.locator('[data-tab="takeoff"]').click();
  await page.locator('[data-placeholder="Phase 3"]').waitFor();
  check("Takeoff tab: Phase 3 placeholder", true);
  await shot("06-takeoff.png");

  // --- 5. re-import: current_import_id moves ---
  await page.locator('[data-tab="bom"]').click();
  const t6 = Date.now();
  execFileSync(process.execPath, [
    join(BRINK, "bin/brink-merge.mjs"), join(BRINK, "fixtures/div27-sample.takeoff.json"),
    "--report", join(BRINK, "fixtures/div27-sample.report.json"),
    "--db-url", DB, "--out", join(TMP, "schematic.json"), "--bom", join(TMP, "bom.csv"),
  ], { cwd: BRINK, stdio: "pipe" });
  const [after] = await q("select current_import_id from brink_projects where id = $1", [proj.id]);
  check("brink-merge re-import moved current_import_id", after.current_import_id !== imp, `${imp} -> ${after.current_import_id}`);
  await page.waitForFunction((id) => document.querySelector(".meta")?.textContent?.includes(id), after.current_import_id, { timeout: 15_000 });
  await page.locator(`tr[data-k="brink_bom_lines:${after.current_import_id}|2"]`).waitFor();
  check("page switched to the new import", true, `${Date.now() - t6} ms after CLI start`);
  const qtyNow = await page.locator(`tr[data-k="brink_bom_lines:${after.current_import_id}|2"] td`).nth(4).innerText();
  check("new import shows the fixture's own quantities", qtyNow === fmt(bom2.qty), `line 2 qty ${qtyNow}`);
  await page.waitForFunction(() => document.querySelector("#feed")?.textContent?.includes("switched to import"), null, { timeout: 5_000 });
  await shot("07-reimport-switched.png");

  const marker = await page.evaluate(() => window.__liveCheckMarker);
  const navs = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  check("no reload happened (projects -> tabs -> re-import)", marker === "same-document" && navs === 1, `marker=${marker} navigations=${navs}`);

  // --- 6. phone width ---
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [["projects", "/"], ["bom", `/projects/${proj.id}/bom`], ["schematic", `/projects/${proj.id}/schematic`], ["takeoff", `/projects/${proj.id}/takeoff`]]) {
    await page.goto(`${BASE}${path}`);
    await live();
    await page.waitForTimeout(300);
    const o = await overflow();
    check(`no horizontal page scroll at 390 px: ${name}`, o <= 0, `overflow ${o}px`);
  }
  await page.goto(`${BASE}/`);
  await live();
  const card = page.locator(`[data-project-card="${proj.id}"]`);
  await card.waitFor();
  const cardText = await card.innerText();
  check("phone: project card shows the totals without sideways scroll", (await card.isVisible()) && cardText.includes(fmt(tot.ord)) && !(await page.locator(row).isVisible()), cardText.replace(/\s+/g, " "));
  await shot("08-phone-projects.png", false);
  await page.goto(`${BASE}/projects/${proj.id}/bom`);
  await live();
  await page.locator(`tr[data-k^="brink_bom_lines:"]`).first().waitFor();
  const inner = await page.evaluate(() => {
    const s = document.querySelector(".table-scroll table")?.parentElement;
    return s ? s.scrollWidth - s.clientWidth : -1;
  });
  check("BOM table scrolls inside its own container at 390 px", inner > 0, `table overflow ${inner}px inside .table-scroll`);
  await shot("09-phone-bom.png", false);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("live check", false, String(e));
  await page.screenshot({ path: join(OUT, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await db.end();
  rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
const summary = { base: BASE, project: PROJECT, ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
writeFileSync(join(OUT, "results.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exit(failed.length ? 1 : 0);
