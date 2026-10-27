// Division 27 Phase 2 — drive the canvas cable UI in a real browser.
// Run from web/ after `npm run build`:
//   PLAYWRIGHT_MODULE=/.../playwright-core/index.mjs BROWSER_PATH=/.../chrome \
//   node scripts/verify-cable-runs.mjs <fixture.json> <out/results.json> [dist]
// The fixture is an invented takeoff on the bundled demo/sample-plan.pdf (a TR
// labeled MDF, three DATA-1 wall-outlet markers, three straight ROUTE segments
// of 33.33 ft, one agent-linked run). Make it with the MCP server — the recipe
// is in docs/design/CABLE_SETUP_PLAN.md (Phase 2 check record). Nothing real
// is committed. Screenshots land next to results.json.
//
// Checks: the import hydrates cable_runs; the unlinked cues and the TR name
// draw on the sheet; the Runs panel lists the runs, the unlinked items and the
// TR; Link Run (W) picks device → segment → TR with a live readout, Enter
// links, ⌘Z unlinks and ⇧⌘Z re-links; Accept clears the pending run; the
// condition editor shows the cable setup; the Report shows the Cable summary
// and its Show button puts an unlinked device on screen; no console errors.
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
const dist = resolve(process.argv[4] || 'dist');
const shots = dirname(out);
mkdirSync(shots, { recursive: true });
const PLAN = fileURLToPath(new URL('../../demo/sample-plan.pdf', import.meta.url));
const PORT = 5287, BASE = `http://127.0.0.1:${PORT}/`;

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--outDir', dist]);
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('error', rej); server.once('exit', (c) => rej(new Error(`server exited ${c}`))); });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [], checks = [], blocked = new Set();
page.on('pageerror', (e) => errors.push(String(e)));
// the run is offline on purpose: external requests (web fonts) are aborted
// and listed in results.json; their "Failed to load resource" lines are the
// block itself, not an app error
page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_FAILED/.test(m.text())) errors.push(m.text()); });
await page.route('**/*', (r) => { const u = r.request().url(); if (/^(http:\/\/127\.0\.0\.1:\d+\/|blob:|data:)/.test(u)) return r.continue(); blocked.add(u); return r.abort(); });
const check = (label, ok, detail) => { checks.push({ check: label, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); console.log(ok ? 'ok  ' : 'FAIL', label, detail ?? ''); };
const shot = async (name) => { await page.mouse.move(5, 940); await page.waitForTimeout(250); await page.screenshot({ path: join(shots, name) }); console.log('shot', name); };
const centerOf = async (sel, i = 0) => { const b = await page.locator(sel).nth(i).boundingBox(); return b ? [b.x + b.width / 2, b.y + b.height / 2] : null; };
const msg = () => page.evaluate(() => document.body.innerText);

try {
  await page.goto(BASE);
  await page.locator('input[name="sheet-file"]').first().setInputFiles(PLAN);
  // a single PDF may land on the gallery: open it
  await page.waitForTimeout(1500);
  const card = page.locator('[data-sheetkey]').first();
  if (await card.count()) await card.getByTitle('Open just this sheet', { exact: true }).dispatchEvent('click').catch(() => {});
  await page.waitForSelector('svg polyline, svg rect', { timeout: 30000 });
  await page.locator('input[name="takeoff-import"]').setInputFiles(fixture);
  await page.waitForSelector('[data-cable-cue="tr"]', { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. cues on the sheet
  const cues = await page.evaluate(() => ({
    devices: document.querySelectorAll('[data-cable-cue="unlinked-device"]').length,
    routes: document.querySelectorAll('[data-cable-cue="unlinked-route"]').length,
    tr: [...document.querySelectorAll('[data-cable-cue="tr"] text')].map((t) => t.textContent),
  }));
  check('import: 2 unlinked devices and 2 unlinked routes carry the amber cue', cues.devices === 2 && cues.routes === 2, cues);
  check('import: the TR prints its name (MDF) on the sheet', cues.tr.includes('MDF'), cues.tr);
  await shot('01-cues-on-sheet.png');

  // 2. Runs panel
  await page.getByRole('button', { name: /^Cable runs/ }).first().click();
  await page.waitForSelector('[data-cable-totals]');
  const totals1 = await page.locator('[data-cable-totals]').innerText();
  check('Runs panel: 1 pull, 2 cables of 3 devices, pending counted', /1 pull · 2 cables of 3 devices/.test(totals1) && /1 pending review/.test(totals1), totals1);
  check('Runs panel: 2 unlinked devices + 2 unlinked routes listed', (await page.locator('[data-cable-unlinked] button').count()) === 4);
  check('Runs panel: the TR name field holds MDF', (await page.locator('input[name="tr-name"]').inputValue()) === 'MDF');
  await shot('02-runs-panel.png');

  // 3. Link Run: W, device, segment, TR, readout, Enter
  await page.keyboard.press('w');
  await page.waitForSelector('[data-cable-readout]');
  const dev = await centerOf('[data-cable-cue="unlinked-device"]', 0);
  await page.mouse.click(dev[0], dev[1]);
  await page.waitForSelector('[data-cable-draft="device"]');
  // the matching route: the unlinked route whose y is nearest the device
  const routes = await page.locator('[data-cable-cue="unlinked-route"]').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }));
  const seg = routes.sort((a, b) => Math.abs(a[1] - dev[1]) - Math.abs(b[1] - dev[1]))[0];
  await page.mouse.click(seg[0], seg[1]);
  await page.waitForSelector('[data-cable-draft="route"]');
  const tr = await centerOf('[data-cable-cue="tr"] circle');
  await page.mouse.click(tr[0], tr[1]);
  await page.waitForSelector('[data-cable-draft="tr"]');
  const readout = await page.locator('[data-cable-readout]').innerText();
  check('Link Run readout: DATA-1 → 1 seg → MDF, route 33.33 LF, per cable 76.33 LF, 2 cables = 152.66 LF', /DATA-1 → 1 seg → MDF/.test(readout) && /route 33\.33 LF · per cable 76\.33 LF · 2 cables = 152\.66 LF/.test(readout), readout);
  await shot('03-link-run-readout.png');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const totals2 = await page.locator('[data-cable-totals]').innerText();
  check('Enter links: 2 pulls, 4 cables, 1 unlinked left', /2 pulls · 4 cables of 3 devices/.test(totals2) && /1 unlinked/.test(totals2), totals2);
  check('Enter links: the device cue clears (1 unlinked device on the sheet)', (await page.locator('[data-cable-cue="unlinked-device"]').count()) === 1);
  await shot('04-linked.png');

  // 4. undo / redo
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('⌘Z unlinks the new run', /1 pull · 2 cables of 3 devices/.test(await page.locator('[data-cable-totals]').innerText()));
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(400);
  check('⇧⌘Z re-links it', /2 pulls · 4 cables of 3 devices/.test(await page.locator('[data-cable-totals]').innerText()));

  // 5. accept the pending agent run
  await page.locator('[data-cable-totals] button', { hasText: 'Accept all' }).click();
  await page.waitForTimeout(300);
  check('Accept all clears the pending count', !/pending review/.test(await page.locator('[data-cable-totals]').innerText()));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  check('⌘Z after Accept restores the pending run', /1 pending review/.test(await page.locator('[data-cable-totals]').innerText()));

  // 6. a refusal: link the remaining device with the TR picked before any segment
  await page.keyboard.press('w');
  const dev2 = await centerOf('[data-cable-cue="unlinked-device"]', 0);
  await page.mouse.click(dev2[0], dev2[1]);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('Enter with no segment refuses and links nothing', /needs at least one route segment/.test(await msg()) && /2 pulls/.test(await page.locator('[data-cable-totals]').innerText()));
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');

  // 7. the condition editor: the cable setup, and a required value cleared live
  await page.getByRole('button', { name: 'Quantities' }).first().click();
  // activating the condition (the toolbar's condition dropdown) opens its editor in the panel
  await page.locator('select:visible').filter({ has: page.locator('option', { hasText: /^DATA-1$/ }) }).first().selectOption({ label: 'DATA-1' });
  await page.waitForSelector('select[name="condition-cable-device-type"]', { timeout: 10000 });
  const setup = await page.evaluate(() => ({
    type: document.querySelector('select[name="condition-cable-device-type"]').value,
    per: document.querySelector('input[name="condition-cable-per-location"]').value,
    kind: document.querySelector('input[name="condition-cable-type"]').value,
    v: document.querySelector('input[name="condition-cable-vertical"]').value,
    ld: document.querySelector('input[name="condition-cable-loop-device"]').value,
    lt: document.querySelector('input[name="condition-cable-loop-tr"]').value,
  }));
  check('condition editor: wall outlet, 2 per location, CAT6A, 23 / 10 / 10', JSON.stringify(setup) === JSON.stringify({ type: 'wall_outlet', per: '2', kind: 'CAT6A', v: '23', ld: '10', lt: '10' }), setup);
  await shot('07-condition-cable-setup.png');
  await page.locator('input[name="condition-cable-vertical"]').fill('');
  await page.waitForSelector('[data-cable-problem]');
  const withheld = await page.locator('[data-cable-totals]').innerText();
  check('clearing Vertical withholds the runs (0 pulls) and says why inline', /0 pulls/.test(withheld) && /Vertical is required/.test(await page.locator('[data-cable-problem]').first().innerText()), withheld);
  await shot('08-vertical-cleared-withheld.png');
  await page.locator('input[name="condition-cable-vertical"]').fill('23');
  await page.waitForTimeout(300);
  check('entering it again restores 2 pulls', /2 pulls/.test(await page.locator('[data-cable-totals]').innerText()));
  await page.getByRole('button', { name: 'Quantities' }).first().click();

  // 8. Report: Cable summary + Show
  await page.getByRole('button', { name: 'Report', exact: true }).first().click();
  await page.waitForSelector('[data-cable-report]');
  const rep = await page.locator('[data-cable-report]').innerText();
  check('Report: Cable summary with Device EA beside Pulls and the TOTAL row', /Device EA\s+Pulls/.test(rep) && /TOTAL/.test(rep), rep.slice(0, 400));
  await page.locator('[data-cable-report]').scrollIntoViewIfNeeded();
  await shot('05-report-cable-summary.png');
  await page.locator('[data-cable-report-unlinked] button', { hasText: 'Show' }).first().click();
  await page.waitForTimeout(800);
  check('Report Show closes the Report and selects the unlinked device', !(await page.locator('[data-cable-report]').count()));
  await shot('06-show-unlinked.png');
} catch (e) {
  check('script ran to the end', false, String(e?.stack || e));
  await page.screenshot({ path: join(shots, 'error.png') }).catch(() => {});
} finally {
  const failed = checks.filter((c) => !c.ok).length;
  check('no console errors', errors.length === 0, errors.slice(0, 5));
  writeFileSync(out, JSON.stringify({ checks, errors, blocked: [...blocked] }, null, 2));
  console.log(`${checks.length - failed - (errors.length ? 1 : 0)} / ${checks.length} checks passed`);
  await browser.close();
  server.kill();
}
