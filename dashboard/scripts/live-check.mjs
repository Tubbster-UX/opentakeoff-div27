#!/usr/bin/env node
// End-to-end live check in a real browser (Playwright, chromium):
//   1. open the project page and wait for "Live"
//   2. change rows in Postgres (UPDATE a BOM line, UPDATE a connection, INSERT and DELETE an issue)
//      and wait for the page to show each change, without a reload
//   3. re-import the fixture with the brink-merge CLI (--db) and wait for the page to switch
//      to the new current import
// Screenshots go to docs/evidence/. Uses only brink-merge's invented fixture data.
//
// usage: node scripts/live-check.mjs [--url http://127.0.0.1:8787] [--db postgres://...] [--project "Brink Div 27 sample (invented)"] [--out docs/evidence]
// Needs: `npm run dev` running against a database that has the project, and Playwright
// (`require('playwright')`; install it globally or with `npx playwright install chromium`).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
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
const OUT = resolve(args.out ?? join(here, "../docs/evidence"));
const BRINK = resolve(here, "../../brink-merge");
const TMP = mkdtempSync(join(tmpdir(), "brink-live-check-"));

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright not found: npm i -g playwright && npx playwright install chromium");
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

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
const cell = (key, col) => page.locator(`tr[data-k="${key}"] td`).nth(col).innerText();

try {
  await page.goto(`${BASE}/p/${proj.id}`);
  await page.evaluate(() => {
    window.__liveCheckMarker = "same-document";
  });
  await page.locator('#live[data-state="live"]').waitFor({ timeout: 20_000 });
  await page.locator(`tr[data-k="brink_bom_lines:${imp}|2"]`).waitFor();
  check("page shows Live", true);
  await page.screenshot({ path: join(OUT, "01-initial.png"), fullPage: true });

  // --- 2. row edits ---
  const [bom2] = await q("select qty from brink_bom_lines where import_id = $1 and line_no = 2", [imp]);
  const [con1] = await q("select cable_length_ft from brink_schematic_connections where import_id = $1 and seq = 1", [imp]);
  const newQty = Number(bom2.qty) + 3;
  const newLen = Math.round((Number(con1.cable_length_ft) + 10.5) * 100) / 100;
  const t0 = Date.now();
  await q("update brink_bom_lines set qty = $2 where import_id = $1 and line_no = 2", [imp, newQty]);
  await page.waitForFunction(([k, v]) => document.querySelector(`tr[data-k="${k}"] td:nth-child(5)`)?.textContent === v, [`brink_bom_lines:${imp}|2`, String(newQty)], { timeout: 10_000 });
  check("BOM qty UPDATE appears without reload", true, `${bom2.qty} -> ${newQty} in ${Date.now() - t0} ms`);

  const t1 = Date.now();
  await q("update brink_schematic_connections set cable_length_ft = $2 where import_id = $1 and seq = 1", [imp, newLen]);
  const conKey = `brink_schematic_connections:${imp}|${(await q("select edge_id from brink_schematic_connections where import_id = $1 and seq = 1", [imp]))[0].edge_id}`;
  await page.waitForFunction(([k, v]) => document.querySelector(`tr[data-k="${k}"] td:nth-child(6)`)?.textContent === v, [conKey, newLen.toLocaleString("en-US", { maximumFractionDigits: 2 })], { timeout: 10_000 });
  check("connection cable_length_ft UPDATE appears", true, `${con1.cable_length_ft} -> ${newLen} in ${Date.now() - t1} ms`);

  const t2 = Date.now();
  await q("insert into brink_issues (import_id, seq, severity, code, message) values ($1, 1000, 'error', 'live_check', 'Invented live-check issue: inserted by dashboard/scripts/live-check.mjs')", [imp]);
  await page.locator(`tr[data-k="brink_issues:${imp}|1000"]`).waitFor({ timeout: 10_000 });
  check("issue INSERT appears", true, `${Date.now() - t2} ms`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, "02-row-changes-live.png"), fullPage: true });

  const t3 = Date.now();
  await q("delete from brink_issues where import_id = $1 and seq = 1000", [imp]);
  await page.locator(`tr[data-k="brink_issues:${imp}|1000"]`).waitFor({ state: "detached", timeout: 10_000 });
  check("issue DELETE disappears", true, `${Date.now() - t3} ms`);

  // --- 3. re-import: current_import_id moves ---
  const t4 = Date.now();
  execFileSync(process.execPath, [
    join(BRINK, "bin/brink-merge.mjs"), join(BRINK, "fixtures/div27-sample.takeoff.json"),
    "--report", join(BRINK, "fixtures/div27-sample.report.json"),
    "--db-url", DB, "--out", join(TMP, "schematic.json"), "--bom", join(TMP, "bom.csv"),
  ], { cwd: BRINK, stdio: "pipe" });
  const [after] = await q("select current_import_id from brink_projects where id = $1", [proj.id]);
  check("brink-merge re-import moved current_import_id", after.current_import_id !== imp, `${imp} -> ${after.current_import_id}`);
  await page.waitForFunction((id) => document.querySelector(".meta")?.textContent?.includes(id), after.current_import_id, { timeout: 15_000 });
  await page.locator(`tr[data-k="brink_bom_lines:${after.current_import_id}|2"]`).waitFor();
  check("page switched to the new import", true, `${Date.now() - t4} ms after CLI start`);
  const qtyNow = await cell(`brink_bom_lines:${after.current_import_id}|2`, 4);
  check("new import shows the fixture's own quantities", qtyNow !== String(newQty), `line 2 qty ${qtyNow}`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, "03-reimport-switched.png"), fullPage: true });

  const marker = await page.evaluate(() => window.__liveCheckMarker);
  const navs = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  check("no reload happened", marker === "same-document" && navs === 1, `marker=${marker} navigations=${navs}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, "04-phone-width.png"), fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal page scroll at 390 px", overflow <= 0, `overflow ${overflow}px`);

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
console.log(JSON.stringify({ base: BASE, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
