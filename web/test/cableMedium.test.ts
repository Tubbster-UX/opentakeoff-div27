// Cable medium and per-condition length limits (item 6, docs/design/CABLE_SETUP_PLAN.md
// §15.1). A cable setup may state its `medium` (copper / fiber / coax) and an
// explicit `max_link_ft`. The limit a run is checked against: max_link_ft
// when stated; else 295 ft (TIA-568 copper) for copper or no medium, exactly
// as before; else no check for fiber and coax. The medium is never read from
// cable_type, and the check is a flag that never changes a quantity. A cable
// takeoff that states neither field exports byte-for-byte as 28ea3cc did
// (fixtures/cableMedium.base.json). Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as cable from "../src/lib/cable.js";
import * as marks from "../src/lib/cableMarks.js";
import * as totals from "../src/lib/totals.js";
import * as xlsx from "../src/lib/xlsx.js";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";
import { instantiateTemplate } from "../src/lib/canvasUtil.js";
import { cableMediumOutputs } from "./fixtures/cableMedium.fixture.ts";

const {
  CABLE_MEDIA, isCableMedium, cableLinkLimit, usesCableLimits, normalizeCableMedium, cableLimitRefusal, withCableLimit,
  mintCableSetup, computeCableTakeoff, cableRunRows, cableTables, cableReportBlock, CABLE_SUMMARY_HEADER, CABLE_RUNS_HEADER, CABLE_DEFAULTS,
} = cable;

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, at: [number, number] = [0.5, 0.5], extra: any = {}) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "count", verts_norm: [at], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.4, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const run = (id: string, dev: string, route: string) => ({ id, device_shape_ids: [dev], route_shape_ids: [route], tr_id: "tr", provenance: { method: "manual", created_at: "2026-10-27T00:00:00.000Z" } });

const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
// wall outlet: 23 + 10 + 10 = 43 ft of allowance, so a 252 ft route is 295 per cable and 253 is 296
const data = (extra: any = {}) => cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: { ...mintCableSetup("wall_outlet", { cable_type: "CAT6A" }), ...extra } });
// a fiber backbone: 20 + 15 + 15 = 50 ft of allowance, so a 550 ft route is 600 per cable
const fiber = (extra: any = {}) => cond("c-fib", "FIBER-1", { cable_setup: { ...mintCableSetup("custom", { cable_type: "OM4 12-strand", vertical_ft: 20, loop_device_ft: 15, loop_tr_ft: 15 }), ...extra } });
// coax (CATV): 13 + 10 + 10 = 33, so a 567 ft route is 600 per cable
const coax = (extra: any = {}) => cond("c-coax", "CATV-1", { cable_setup: { ...mintCableSetup("ceiling_other", { cable_type: "RG6" }), ...extra } });
const BASE_SHAPES = [count("tr", "c-tr", [0.1, 0.1], { label: "MDF" })];
const byId = (t: any, id: string) => t.resolved.runs.find((r: any) => r.id === id);

const W = 3400, H = 2200, PT = 0.5;
const measure = (t: string, size: number) => t.length * size * 0.5;
const fmtLen = (ft: number) => `${Math.round(ft * 10) / 10} LF`;
const chipTexts = (t: any, conds: any[], shapes: any[]) => marks.cableSheetMarks(t, { sheetId: "a.pdf", shapes, conditions: conds, W, H, ptScale: PT, measure, fmtLen }).chips.map((c: any) => c.text);

/** The 295 / 296 pair on DATA-1, its setup patched with `extra`. */
function copperPair(extra: any = {}) {
  const conds = [data(extra), TR, ROUTE];
  const shapes = [...BASE_SHAPES, count("d1", "c-data", [0.3, 0.3]), count("d2", "c-data", [0.6, 0.6]), line("r295", "c-route", 252), line("r296", "c-route", 253)];
  const runs = [run("run-295", "d1", "r295"), run("run-296", "d2", "r296")];
  return { conds, shapes, runs, t: computeCableTakeoff(conds, shapes, runs)! };
}

test("the medium and limit vocabulary: three media, a limit is feet above 0, nothing is minted", () => {
  assert.deepEqual([...CABLE_MEDIA], ["copper", "fiber", "coax"]);
  assert.equal(isCableMedium("fiber"), true);
  assert.equal(isCableMedium("Fiber"), false, "the stored value is canonical");
  assert.equal(normalizeCableMedium(" Fiber "), "fiber", "case and spaces are forgiven on the way in");
  assert.equal(normalizeCableMedium("om4"), null, "nothing else is read as a medium");
  assert.deepEqual(cableLinkLimit(mintCableSetup("wall_outlet")), { limit_ft: 295, limit_source: "tia_568_copper" });
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("wall_outlet"), medium: "copper" }), { limit_ft: 295, limit_source: "tia_568_copper" });
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("custom"), medium: "fiber" }), { limit_ft: null, limit_source: "none" });
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("custom"), medium: "coax" }), { limit_ft: null, limit_source: "none" });
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("custom"), medium: "fiber", max_link_ft: 500 }), { limit_ft: 500, limit_source: "stated" });
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("custom"), max_link_ft: 984.25 }), { limit_ft: 984.25, limit_source: "stated" }, "a stated limit needs no medium");
  assert.deepEqual(cableLinkLimit({ ...mintCableSetup("custom"), medium: "glass", max_link_ft: 0 }), { limit_ft: 295, limit_source: "tia_568_copper" }, "invalid values read as absent");
  // never minted: no device type's starting values carry a medium or a limit
  for (const t of Object.keys(CABLE_DEFAULTS)) {
    const s = mintCableSetup(t);
    assert.equal("medium" in s || "max_link_ft" in s, false, t);
  }
  // the gate: a valid stated medium or limit on a cable condition
  assert.equal(usesCableLimits([data(), TR, ROUTE]), false);
  assert.equal(usesCableLimits([data({ medium: "copper" }), TR]), true);
  assert.equal(usesCableLimits([data({ max_link_ft: 300 }), TR]), true);
  assert.equal(usesCableLimits([data({ medium: "glass", max_link_ft: -1 })]), false, "an invalid value does not open the gate");
  assert.equal(usesCableLimits([cond("x", "X", { medium: "fiber" })]), false, "only a cable setup counts");
});

test("cableLimitRefusal and withCableLimit: a clear refusal for a bad value; null clears; key order kept", () => {
  assert.equal(cableLimitRefusal({ medium: "copper", max_link_ft: 300 }), null);
  assert.equal(cableLimitRefusal({ medium: null, max_link_ft: null }), null);
  assert.equal(cableLimitRefusal({ medium: "glass" }), 'cable_setup.medium "glass" is not a medium — use "copper", "fiber" or "coax" (or null to clear it). State it from the spec; it is never read from cable_type.');
  assert.equal(cableLimitRefusal({ max_link_ft: 0 }), "cable_setup.max_link_ft 0 is not a length limit — give the limit in feet, greater than 0, from the project spec or the system's datasheet (or null to clear it).");
  assert.match(cableLimitRefusal({ max_link_ft: -5 })!, /is not a length limit/);
  const s0 = mintCableSetup("wall_outlet", { cable_type: "CAT6A" });
  const s1 = withCableLimit(s0, { medium: "Fiber", max_link_ft: 500 });
  assert.deepEqual(Object.keys(s1), [...Object.keys(s0), "medium", "max_link_ft"], "new keys go at the end");
  assert.deepEqual([s1.medium, s1.max_link_ft], ["fiber", 500]);
  const s2 = withCableLimit(s1, { max_link_ft: null });
  assert.equal("max_link_ft" in s2, false);
  assert.equal(s2.medium, "fiber", "undefined leaves a field alone");
  const s3 = withCableLimit(s2, { medium: "" });
  assert.deepEqual(s3, s0, "clearing both gives back the setup as it was, key order and all");
  assert.equal(JSON.stringify(s3), JSON.stringify(s0));
  assert.equal("medium" in s0, false, "pure: the input is untouched");
});

test("no medium stated: 296 ft per cable is flagged, 295 is not — exactly as before", () => {
  const { t } = copperPair();
  assert.deepEqual([byId(t, "run-295").per_cable_lf, byId(t, "run-295").over_length], [295, undefined]);
  assert.deepEqual([byId(t, "run-296").per_cable_lf, byId(t, "run-296").over_length], [296, true]);
  assert.deepEqual(byId(t, "run-296").notes, ["per cable 296 ft exceeds 295 ft (TIA-568 copper permanent link, 90 m)"]);
  assert.equal("limit_ft" in byId(t, "run-296") || "limit_source" in byId(t, "run-296"), false, "no limit field until a condition states one");
  assert.deepEqual(t.summary.warnings, ["1 linked run exceeds 295 ft per cable, the TIA-568 limit for a 4-pair copper permanent link (90 m): DATA-1 run-296 296 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice. Fiber and coax are not bound by this limit."]);
  assert.equal(t.summary.totals.over_length_runs, 1);
  const tables = cableTables(t) as any;
  assert.deepEqual(tables.summary[0], [...CABLE_SUMMARY_HEADER]);
  assert.equal(tables.summary[0][15], "Runs over 295 ft");
  assert.deepEqual(tables.runs[0], [...CABLE_RUNS_HEADER]);
  assert.deepEqual(chipTexts(t, [data(), TR, ROUTE], copperPair().shapes).map((s: string) => s.replace(/^run-\w+ · /, "")), ["DATA-1 · 295 LF", "DATA-1 · 296 LF >295"]);
  assert.match(marks.cableLegend(t, [data(), TR, ROUTE], { fmtLen })!.meta, / · 1 over 295 ft per cable$/);
});

test("medium copper: the same check — 296 flagged, 295 not, the same note — and each run says its limit", () => {
  const { conds, shapes, t } = copperPair({ medium: "copper" });
  const r295 = byId(t, "run-295"), r296 = byId(t, "run-296");
  assert.deepEqual([r295.over_length, r296.over_length], [undefined, true]);
  assert.deepEqual(r296.notes, ["per cable 296 ft exceeds 295 ft (TIA-568 copper permanent link, 90 m)"], "the default's words are kept");
  assert.deepEqual([r296.medium, r296.limit_ft, r296.limit_source], ["copper", 295, "tia_568_copper"]);
  assert.deepEqual([r295.limit_ft, r295.limit_source], [295, "tia_568_copper"]);
  assert.deepEqual(t.summary.warnings, ["1 linked run exceeds its length limit per cable. Over 295 ft (TIA-568 copper permanent link, 90 m): DATA-1 run-296 296 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice."]);
  assert.equal(t.summary.totals.over_length_runs, 1, "a flag never changes a quantity");
  assert.equal(t.summary.totals.cable_lf, 591, "295 + 296, one cable each");
  assert.deepEqual(chipTexts(t, conds, shapes).map((s: string) => s.replace(/^run-\w+ · /, "")), ["DATA-1 · 295 LF", "DATA-1 · 296 LF >295"]);
});

test("fiber with no stated limit: a 600 ft run is not flagged and nothing warns", () => {
  const conds = [fiber({ medium: "fiber" }), TR, ROUTE];
  const shapes = [...BASE_SHAPES, count("f1", "c-fib"), line("r600", "c-route", 550)];
  const t = computeCableTakeoff(conds, shapes, [run("run-f", "f1", "r600")])!;
  const r = byId(t, "run-f");
  assert.deepEqual([r.status, r.per_cable_lf, r.over_length, r.notes], ["linked", 600, undefined, undefined]);
  assert.deepEqual([r.medium, r.limit_ft, r.limit_source], ["fiber", null, "none"]);
  assert.deepEqual(t.summary.warnings, []);
  assert.equal(t.summary.totals.over_length_runs, 0);
  assert.deepEqual([t.summary.rows[0].medium, t.summary.rows[0].limit_ft, t.summary.rows[0].limit_source], ["fiber", null, "none"]);
  assert.deepEqual(chipTexts(t, conds, shapes).map((s: string) => s.replace(/^run-\w+ · /, "")), ["FIBER-1 · 600 LF"]);
  assert.doesNotMatch(marks.cableLegend(t, conds, { fmtLen })!.meta, /over/);
  // the runs sheet says it was not checked, and why
  const tables = cableTables(t) as any;
  assert.deepEqual(tables.runs[0].slice(-3), ["Limit ft", "Limit source", "Reason / notes"]);
  assert.deepEqual(tables.runs[1].slice(-3), ["", "none (fiber: no limit stated)", ""]);
  // cable_type text naming a medium changes nothing: only the stated medium does
  const asText = computeCableTakeoff([fiber({ cable_type: "OM4 fiber, coax-free" }), TR, ROUTE], shapes, [run("run-f", "f1", "r600")])!;
  assert.equal(byId(asText, "run-f").over_length, true, "with no medium stated the run is checked as copper, whatever cable_type says");
});

test("fiber with max_link_ft 500: the 600 ft run is flagged with the stated limit's words, in every output", () => {
  const conds = [fiber({ medium: "fiber", max_link_ft: 500 }), TR, ROUTE];
  const shapes = [...BASE_SHAPES, count("f1", "c-fib"), line("r600", "c-route", 550)];
  const t = computeCableTakeoff(conds, shapes, [run("run-f", "f1", "r600")])!;
  const r = byId(t, "run-f");
  assert.deepEqual([r.per_cable_lf, r.over_length, r.limit_ft, r.limit_source], [600, true, 500, "stated"]);
  assert.deepEqual(r.notes, ["per cable 600 ft exceeds the stated 500 ft limit for FIBER-1"]);
  assert.deepEqual(t.summary.warnings, ["1 linked run exceeds its length limit per cable. Over the stated 500 ft limit (FIBER-1): FIBER-1 run-f 600 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice."]);
  assert.equal(t.summary.totals.over_length_runs, 1);
  assert.equal(t.summary.totals.cable_lf, 600, "the flag never changes a quantity");
  // the summary: the column names no limit; the row's note names its own
  const tables = cableTables(t) as any;
  assert.equal(tables.summary[0][15], "Runs over length limit");
  assert.deepEqual(tables.summary[0].filter((_: any, i: number) => i !== 15), CABLE_SUMMARY_HEADER.filter((_: any, i: number) => i !== 15), "every other column keeps its name and position");
  assert.deepEqual(tables.summary[1].slice(-2), [1, "1 run over the stated 500 ft limit per cable"]);
  // the runs sheet: Limit ft and Limit source just before Reason / notes
  assert.deepEqual(tables.runs[0], [...CABLE_RUNS_HEADER.slice(0, -1), "Limit ft", "Limit source", "Reason / notes"]);
  assert.deepEqual(tables.runs[1].slice(-3), [500, "stated (max_link_ft)", "per cable 600 ft exceeds the stated 500 ft limit for FIBER-1"]);
  // report JSON rows
  const rows = cableRunRows(t);
  assert.deepEqual([rows[0].medium, rows[0].limit_ft, rows[0].limit_source, rows[0].over_length], ["fiber", 500, "stated", true]);
  assert.deepEqual(Object.keys(rows[0]).slice(-6), ["reason", "medium", "limit_ft", "limit_source", "over_length", "notes"], "appended after the fields a workbook already reads");
  const block: any = cableReportBlock(t);
  assert.deepEqual([block.summary[0].limit_ft, block.summary[0].limit_source, block.summary[0].medium], [500, "stated", "fiber"]);
  // marked set: the chip shows the run's own limit; the cover counts without naming one
  assert.deepEqual(chipTexts(t, conds, shapes).map((s: string) => s.replace(/^run-\w+ · /, "")), ["FIBER-1 · 600 LF >500"]);
  assert.match(marks.cableLegend(t, conds, { fmtLen })!.meta, / · 1 over its length limit per cable$/);
  // metric converts the Limit column like every other length
  const met = cableTables(t, { L: (v: number) => Math.round(v * 0.3048 * 100) / 100, lengthUnit: "m" }) as any;
  assert.deepEqual(met.runs[0].slice(-3), ["Limit m", "Limit source", "Reason / notes"]);
  assert.equal(met.runs[1].at(-3), 152.4);
  // CSV and workbook carry the same matrices
  const trows = totals.conditionTotals(conds, shapes).filter((x: any) => x.shape_count > 0);
  const csv = totals.totalsToCsv(trows, "", null, null, null, null, null, "OpenTakeoff", "imperial", t);
  assert.ok(csv.includes(",Pending runs,Runs over length limit,Note\n"), csv);
  assert.ok(csv.includes(",linked,human,500,stated (max_link_ft),per cable 600 ft exceeds the stated 500 ft limit for FIBER-1\n"), csv);
  const tabs = xlsx.reportWorkbook({ rows: trows, bySheet: [], shapeRows: [], cable: t });
  assert.deepEqual(tabs.find((s: any) => s.name === "Cable runs")!.rows, tables.runs);
});

test("a stated 1000 ft limit: the chip reads >1000 and 1000 per cable is not over it", () => {
  const conds = [fiber({ medium: "fiber", max_link_ft: 1000 }), TR, ROUTE];
  const shapes = [...BASE_SHAPES, count("f1", "c-fib", [0.3, 0.3]), count("f2", "c-fib", [0.6, 0.6]), line("r1000", "c-route", 950), line("r1001", "c-route", 951)];
  const t = computeCableTakeoff(conds, shapes, [run("run-1000", "f1", "r1000"), run("run-1001", "f2", "r1001")])!;
  assert.deepEqual([byId(t, "run-1000").over_length, byId(t, "run-1001").over_length], [undefined, true]);
  assert.deepEqual(chipTexts(t, conds, shapes).map((s: string) => s.replace(/^run-\w+ · /, "")), ["FIBER-1 · 1000 LF", "FIBER-1 · 1001 LF >1000"]);
});

test("coax with no stated limit is not checked; coax with one is", () => {
  const shapes = [...BASE_SHAPES, count("x1", "c-coax"), line("r600", "c-route", 567)];
  const none = computeCableTakeoff([coax({ medium: "coax" }), TR, ROUTE], shapes, [run("run-x", "x1", "r600")])!;
  assert.deepEqual([byId(none, "run-x").per_cable_lf, byId(none, "run-x").over_length, byId(none, "run-x").limit_source], [600, undefined, "none"]);
  assert.deepEqual(none.summary.warnings, []);
  assert.equal((cableTables(none) as any).runs[1].at(-2), "none (coax: no limit stated)");
  const stated = computeCableTakeoff([coax({ medium: "coax", max_link_ft: 450 }), TR, ROUTE], shapes, [run("run-x", "x1", "r600")])!;
  assert.deepEqual(byId(stated, "run-x").notes, ["per cable 600 ft exceeds the stated 450 ft limit for CATV-1"]);
});

test("mixed media: one warning, runs grouped by the limit they were checked against", () => {
  const conds = [data(), fiber({ medium: "fiber", max_link_ft: 500 }), coax({ medium: "coax" }), cond("c-cam", "CAM-1", { cable_setup: { ...mintCableSetup("camera"), medium: "copper" } }), cond("c-bb2", "FIBER-2", { cable_setup: { ...mintCableSetup("custom", { vertical_ft: 0, loop_device_ft: 0, loop_tr_ft: 0 }), medium: "fiber", max_link_ft: 500 } }), TR, ROUTE];
  const shapes = [...BASE_SHAPES,
    count("d1", "c-data", [0.2, 0.2]), count("f1", "c-fib", [0.3, 0.3]), count("x1", "c-coax", [0.4, 0.4]), count("c1", "c-cam", [0.5, 0.5]), count("g1", "c-bb2", [0.6, 0.6]),
    line("rd", "c-route", 260), line("rf", "c-route", 550), line("rx", "c-route", 900), line("rc", "c-route", 300), line("rg", "c-route", 510)];
  const runs = [run("run-d", "d1", "rd"), run("run-f", "f1", "rf"), run("run-x", "x1", "rx"), run("run-c", "c1", "rc"), run("run-g", "g1", "rg")];
  const t = computeCableTakeoff(conds, shapes, runs)!;
  assert.deepEqual(t.resolved.runs.map((r: any) => [r.id, r.per_cable_lf, !!r.over_length, r.limit_ft, r.limit_source]), [
    ["run-d", 303, true, 295, "tia_568_copper"],
    ["run-f", 600, true, 500, "stated"],
    ["run-x", 933, false, null, "none"],
    ["run-c", 338, true, 295, "tia_568_copper"],
    ["run-g", 510, true, 500, "stated"],
  ]);
  assert.deepEqual(t.summary.warnings, ["4 linked runs exceed their length limit per cable. Over 295 ft (TIA-568 copper permanent link, 90 m): DATA-1 run-d 303 ft; CAM-1 run-c 338 ft. Over the stated 500 ft limit (FIBER-1, FIBER-2): FIBER-1 run-f 600 ft; FIBER-2 run-g 510 ft. DATA-1 states no medium and no limit, so it is checked as copper. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice."]);
  assert.equal(t.summary.totals.over_length_runs, 4);
  assert.match(marks.cableLegend(t, conds, { fmtLen })!.meta, / · 4 over their length limit per cable$/);
  // a run with no setup (broken: its condition lost the setup) carries no limit
  const broken = computeCableTakeoff([cond("c-data", "DATA-1"), fiber({ medium: "fiber" }), TR, ROUTE], shapes, [run("run-d", "d1", "rd")])!;
  assert.equal("limit_source" in byId(broken, "run-d"), false);
});

test("a stored medium or limit that is not valid is ignored and said, never silently dropped", () => {
  const shapes = [...BASE_SHAPES, count("f1", "c-fib"), line("r600", "c-route", 550)];
  const t = computeCableTakeoff([fiber({ medium: "glass", max_link_ft: "1000" }), TR, ROUTE], shapes, [run("run-f", "f1", "r600")])!;
  assert.deepEqual(t.summary.warnings[0], 'Condition FIBER-1: cable_setup medium "glass" is not copper, fiber or coax, and max_link_ft "1000" is not a length in feet above 0 — ignored, so its runs are checked against 295 ft (TIA-568 copper permanent link, 90 m). Correct it in the cable setup.');
  assert.equal(byId(t, "run-f").over_length, true);
  const fiberBadLimit = computeCableTakeoff([fiber({ medium: "fiber", max_link_ft: -1 }), TR, ROUTE], shapes, [run("run-f", "f1", "r600")])!;
  assert.deepEqual(fiberBadLimit.summary.warnings, ["Condition FIBER-1: cable_setup max_link_ft -1 is not a length in feet above 0 — ignored, so its runs are not length-checked. Correct it in the cable setup."]);
});

test("a cable takeoff that states neither field: every export is byte-identical to 28ea3cc", () => {
  const base = JSON.parse(readFileSync(new URL("./fixtures/cableMedium.base.json", import.meta.url), "utf8"));
  const now = cableMediumOutputs({ cable, marks, totals, xlsx }) as any;
  assert.equal(now.plain.csv, base.csv);
  assert.deepEqual(now.plain.summary.warnings, base.warnings);
  const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
  const got: Record<string, string> = {};
  for (const [variant, outs] of Object.entries(now)) for (const [k, v] of Object.entries(outs as object)) got[`${variant}.${k}`] = sha(v);
  assert.deepEqual(got, base.sha256);
  assert.equal(Object.keys(got).length, 26, "resolved, summary, rows, tables, report JSON, CSV, workbook, legend and sheet marks, imperial and metric, plain and with a tagged trunk");
});

test("medium and max_link_ft round-trip through the takeoff document and the app's reader, and ride condition templates", () => {
  const conds = [data(), fiber({ medium: "fiber", max_link_ft: 500 }), TR, ROUTE];
  const shapes = [...BASE_SHAPES, count("f1", "c-fib"), line("r600", "c-route", 550)];
  const doc = buildTakeoffDocument({ project_name: "Invented job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: conds, shapes, cable_runs: [run("run-f", "f1", "r600")], sheet_tabs: ["a.pdf"] });
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(JSON.stringify(doc)), ["a.pdf"]);
  assert.deepEqual(payload.conditions.map((c: any) => [c.cable_setup?.medium, c.cable_setup?.max_link_ft]), [[undefined, undefined], ["fiber", 500], [undefined, undefined], [undefined, undefined]]);
  const t = computeCableTakeoff(payload.conditions, payload.shapes, cable.sanitizeCableRuns(payload.cable_runs))!;
  assert.equal(byId(t, "run-f").limit_ft, 500);
  // a document that states neither writes neither key
  assert.equal(/"medium"|"max_link_ft"/.test(JSON.stringify(buildTakeoffDocument({ conditions: [data(), TR, ROUTE], shapes, cable_runs: [] }))), false);
  const tpl = instantiateTemplate({ finish_tag: "FIBER-1", cable_setup: { ...mintCableSetup("custom"), medium: "fiber", max_link_ft: 500 } });
  assert.deepEqual([tpl.cable_setup.medium, tpl.cable_setup.max_link_ft], ["fiber", 500]);
});
