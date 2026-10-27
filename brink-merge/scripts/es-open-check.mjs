#!/usr/bin/env node
// Acceptance check: does an emitted schematic open in the REAL EasySchematic?
// Starts EasySchematic's Vite dev server from a checkout, loads the file through
// the app's own Load input (the path a person uses), and records: alerts and
// console errors, device nodes on the canvas vs. the file, and the Pack List and
// Cable Schedule reports, with screenshots.
//
//   node scripts/es-open-check.mjs --es <EasySchematic checkout, npm ci done> \
//        --file schematic.json --out <evidence dir>
// Needs Playwright with Chromium (require("playwright")). Exit 1 on any failure.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const esDir = opt("--es");
const filePath = opt("--file");
const outDir = resolve(opt("--out") ?? "es-open-evidence");
if (!esDir || !filePath) {
  console.error("usage: node scripts/es-open-check.mjs --es <EasySchematic checkout> --file <schematic.json> [--out dir]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const port = Number(opt("--port") ?? 5179);
const fileText = readFileSync(filePath, "utf8");
const file = JSON.parse(fileText);
const expectDevices = file.nodes.filter((n) => n.type === "device").length;
const expectEdges = file.edges.length;

const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd: esDir, stdio: ["ignore", "pipe", "pipe"], detached: true });
const stop = () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);
await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error("vite did not start in 90 s")), 90_000);
  const seen = (d) => { if (String(d).includes(`localhost:${port}`)) { clearTimeout(t); ok(); } };
  vite.stdout.on("data", seen);
  vite.stderr.on("data", seen);
});

const result = { file: basename(filePath), version: file.version, expect: { devices: expectDevices, connections: expectEdges }, dialogs: [], consoleErrors: [], checks: {} };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("dialog", async (d) => { result.dialogs.push(d.message()); await d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => result.consoleErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => localStorage.setItem("easyschematic-skip-landing", "1"));
  await page.goto(`http://localhost:${port}/`);
  await page.locator(".react-flow").waitFor({ timeout: 60_000 });
  await page.locator(".react-flow__node").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  const bootErrors = result.consoleErrors.length;

  await page.locator('input[type=file][accept=".json"]').first().setInputFiles({ name: basename(filePath), mimeType: "application/json", buffer: Buffer.from(fileText) });
  await page.waitForTimeout(3000);
  result.title = await page.title();
  result.checks.noInvalidAlert = !result.dialogs.some((d) => /invalid|error|migrat/i.test(d));
  result.checks.noNewConsoleErrors = result.consoleErrors.length === bootErrors;
  result.loadErrors = result.consoleErrors.slice(bootErrors);

  // The rendered canvas: device nodes React Flow mounted for our ids.
  const ids = await page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  const deviceIds = new Set(file.nodes.filter((n) => n.type === "device").map((n) => n.id));
  result.canvas = { nodes: ids.length, devices: ids.filter((id) => deviceIds.has(id)).length };
  result.checks.deviceCount = result.canvas.devices === expectDevices;
  result.edgesRendered = await page.locator(".react-flow__edge").count();
  await page.locator(".react-flow__controls-fitview, button[title='fit view']").first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "01-canvas.png") });

  // Reports menu -> one report; later reports switch tabs inside the open dialog.
  async function report(menuLabel, tabLabel, shot) {
    const dialog = page.locator("div.fixed.inset-0.z-50");
    if (await dialog.count()) await dialog.getByText(tabLabel, { exact: true }).first().click();
    else {
      await page.getByText("Reports", { exact: true }).first().click();
      await page.getByText(menuLabel, { exact: true }).first().click();
    }
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText();
    await page.screenshot({ path: join(outDir, shot) });
    return text;
  }
  const pack = await report("Pack List...", "Pack List", "02-pack-list.png");
  const models = [...new Set(file.nodes.filter((n) => n.type === "device").map((n) => n.data.model))];
  result.packList = { modelsShown: models.filter((m) => pack.includes(m)), models };
  result.checks.packListModels = result.packList.modelsShown.length === models.length;

  const sched = await report("Cable Schedule...", "Cable Schedule", "03-cable-schedule.png");
  const lengths = [...new Set(file.edges.map((e) => e.data?.cableLength).filter(Boolean))];
  result.cableSchedule = { lengthsShown: lengths.filter((l) => sched.includes(l)).length, lengths: lengths.length, sample: lengths.slice(0, 5) };
  result.checks.cableLengths = result.cableSchedule.lengthsShown === lengths.length;
} catch (e) {
  result.checks.completed = false;
  result.error = String(e?.message ?? e).split("\n")[0];
} finally {
  await browser.close();
  stop();
}
result.ok = Object.values(result.checks).every(Boolean);
writeFileSync(join(outDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
