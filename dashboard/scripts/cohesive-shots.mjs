#!/usr/bin/env node
// Screenshots of the Brink UI, light and dark, for review: Projects, the project header,
// the Schematic tab (Brink toolbar and panels, the re-themed canvas), the inspector, a
// report opened from the Project menu, BOM & Issues, the Takeoff tab (the OpenTakeoff canvas), the
// /design kitchen sink, About & licenses, and phone width. It also asserts that the
// Schematic tab has no iframe and no EasySchematic logo or menu bar.
//
// usage: node scripts/cohesive-shots.mjs [--url http://127.0.0.1:8787] [--project "Brink Div 27 sample (invented)"] [--out docs/evidence/cohesive]
// Needs `npm run dev` running against a database brink-merge imported the invented fixtures into,
// and Playwright (`require('playwright')`). Writes PNGs and shots.json to --out. Read-only: it saves nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const BASE = args.url ?? "http://127.0.0.1:8787";
const PROJECT = args.project ?? "Brink Div 27 sample (invented)";
const OUT = resolve(args.out ?? join(here, "../docs/evidence/cohesive"));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(ok ? "PASS" : "FAIL", name, detail);
};

const list = await (await fetch(`${BASE}/api/projects`)).json();
const project = list.projects.find((p) => p.name === PROJECT);
if (!project) throw new Error(`no project named ${PROJECT}`);
const P = `/projects/${project.id}`;

const browser = await chromium.launch();
const errors = [];
async function open(theme, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem("brink:theme", t), theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${theme}: ${e}`));
  page.on("console", (m) => m.type() === "error" && !/WebSocket|ERR_CONNECTION/.test(m.text()) && errors.push(`${theme}: ${m.text()}`));
  return { ctx, page };
}
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, name), scale: "css", ...opts });
};
const live = (page) => page.locator('#live[data-state="live"]').waitFor({ timeout: 20_000 });
const editorReady = async (page) => {
  await page.locator("[data-es-root] .react-flow__node-device").first().waitFor({ timeout: 30_000 });
  await page.locator('[data-save-state="saved"]').waitFor({ timeout: 30_000 });
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(600);
};

try {
  for (const theme of ["light", "dark"]) {
    const { ctx, page } = await open(theme);
    await page.goto(`${BASE}/`);
    await live(page);
    await page.locator(`tr[data-project="${project.id}"]`).waitFor();
    await shot(page, `01-projects-${theme}.png`);

    await page.goto(`${BASE}${P}/schematic`);
    await live(page);
    await editorReady(page);
    await shot(page, `03-schematic-${theme}.png`);
    await page.locator("header").first().screenshot({ path: join(OUT, `02-project-header-${theme}.png`), scale: "css" });
    if (theme === "light") {
      const chrome = {
        iframes: await page.locator("iframe").count(),
        esLogo: await page.locator('img[src*="favicon.svg"]').count(),
        esName: await page.getByText("EasySchematic", { exact: true }).filter({ visible: true }).count(),
        esMenus: await page.locator("[data-es-root] button", { hasText: /^(File|Export|Reports|Help)$/ }).count(),
        brinkToolbar: await page.locator("[data-brink-toolbar] [role=toolbar]").count(),
        brinkLogo: await page.locator("header [data-brink-logo]").count(),
        headers: await page.locator("header[data-bk-chrome]").count(),
      };
      check("Schematic tab: no iframe, no EasySchematic logo / name / menu bar; one Brink header and the Brink toolbar", chrome.iframes === 0 && chrome.esLogo === 0 && chrome.esName === 0 && chrome.esMenus === 0 && chrome.brinkToolbar === 1 && chrome.brinkLogo === 1 && chrome.headers === 1, JSON.stringify(chrome));
    }

    const device = page.locator("[data-es-root] .react-flow__node-device").nth(3);
    await device.click({ position: { x: 30, y: 8 } });
    await page.locator("[data-inspector-name]").waitFor();
    await shot(page, `04-inspector-${theme}.png`);
    if (theme === "light") check("the inspector shows the selected device", (await page.locator("[data-inspector-name]").inputValue()).length > 0);

    await page.locator('[data-menu="project-menu"]').click();
    await page.locator('[data-menuitem="report-pack-list"]').waitFor();
    await shot(page, `05-project-menu-${theme}.png`);
    await page.locator('[data-menuitem="report-pack-list"]').click();
    await page.getByText("This document contains").first().waitFor();
    await shot(page, `06-report-pack-list-${theme}.png`);
    await page.mouse.click(6, 700);
    await page.waitForTimeout(300);
    if (theme === "light") {
      await page.locator('[data-menu="project-menu"]').click();
      await page.locator('[data-menuitem="report-cable-schedule"]').click();
      await page.waitForTimeout(700);
      await shot(page, `06b-report-cable-schedule-${theme}.png`);
      await page.mouse.click(6, 700);
      await page.waitForTimeout(300);
      // Layers (upstream View Options) and Rows in the Brink right panel.
      await page.locator('[data-tab-key="layers"]').click();
      await shot(page, `04b-layers-panel-${theme}.png`);
      await page.locator('[data-tab-key="rows"]').click();
      await shot(page, `04c-rows-panel-${theme}.png`);
      await page.locator('[data-tab-key="inspector"]').click();
      // Upstream's device editor, opened from the inspector.
      await device.click({ position: { x: 30, y: 8 } });
      await page.locator('[data-action="open-editor"]').click();
      await page.getByPlaceholder("e.g. Camera 1").waitFor();
      await shot(page, `04d-device-editor-${theme}.png`);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForTimeout(300);
    }

    await page.locator('[data-tab="bom"]').click();
    await page.locator('tr[data-k^="brink_bom_lines:"]').first().waitFor();
    await shot(page, `07-bom-issues-${theme}.png`);
    await page.locator('[data-tab="takeoff"]').click();
    await page.locator("[data-ot-root] [data-sheet], [data-ot-root] [data-takeoff-empty]").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot(page, `08-takeoff-${theme}.png`);

    await page.setViewportSize({ width: 1440, height: 2300 });
    await page.goto(`${BASE}/design`);
    await page.locator("[data-kitchen-sink]").waitFor();
    await shot(page, `09-design-${theme}.png`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-menu="user-menu"]').click();
    await page.locator('[data-menuitem="about"]').click();
    await page.locator("[data-about]").waitFor();
    await shot(page, `10-about-licenses-${theme}.png`);
    await ctx.close();

    const phone = await open(theme, { width: 390, height: 844 });
    for (const [name, path] of [
      ["projects", "/"],
      ["schematic", `${P}/schematic`],
      ["bom", `${P}/bom`],
    ]) {
      await phone.page.goto(`${BASE}${path}`);
      await live(phone.page);
      if (name === "schematic") await phone.page.locator("[data-es-root] .react-flow__node-device").first().waitFor({ timeout: 30_000 });
      await phone.page.waitForTimeout(800);
      const o = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${theme} phone (390 px): no horizontal page scroll on ${name}`, o <= 0, `${o}px`);
      await shot(phone.page, `11-phone-${name}-${theme}.png`);
    }
    await phone.ctx.close();
  }
  check("no page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
} catch (e) {
  check("run completed", false, String(e?.stack ?? e));
} finally {
  await browser.close();
  writeFileSync(join(OUT, "shots.json"), JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, project: PROJECT, results }, null, 2) + "\n");
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
