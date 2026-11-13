// Division 27 trunk and branch routes (docs/design/CABLE_SETUP_PLAN.md §14.2):
// a route condition says whether its segments are TRUNK (shared pathway) or
// BRANCH (one device out to the trunk). Each run splits its route LF by
// kind; the PATHWAY rollup counts each segment once; J-hooks come from an
// ordinary "linear" materials row on the branch condition. Every trunk/branch
// output is gated on a tagged route condition, so an untagged takeoff exports
// byte-for-byte as before (the CSV literal below was captured from the base
// commit d680c88). Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mintCableSetup, ROUTE_KINDS, isRouteKind, routeKindOf, usesRouteKinds, resolveCableRuns, pathwayRollup,
  computeCableTakeoff, cableReportBlock, cableTables, cableRunRows, sanitizeCableRuns, CABLE_RUNS_HEADER,
} from "../src/lib/cable.js";
import { cableLegend } from "../src/lib/cableMarks.js";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";
import { conditionTotals, reportJson, totalsToCsv } from "../src/lib/totals.js";
import { reportWorkbook } from "../src/lib/xlsx.js";
import { instantiateTemplate } from "../src/lib/canvasUtil.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, extra: any = {}) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const run = (id: string, dev: string, route: string[]) => ({ id, device_shape_ids: [dev], route_shape_ids: route, tr_id: "tr", provenance: { method: "manual", created_at: "2026-10-27T00:00:00.000Z" } });

const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) });
const TR = cond("c-tr", "TR", { role: "tr" });
const JHOOK = { id: "m1", name: "J-hook", per: 5, basis: "linear", unit: "EA" };
// untagged: the shapes of a pre-route_kind takeoff
const TRAY0 = cond("c-trunk", "TRAY", { role: "route" });
const BR0 = cond("c-br", "BRANCH", { role: "route", materials: [JHOOK] });
// tagged
const TRAY = { ...TRAY0, route_kind: "trunk" };
const BR = { ...BR0, route_kind: "branch" };
const SHAPES = [count("tr", "c-tr", { label: "MDF" }), count("d1", "c-data"), count("d2", "c-data"), line("t1", "c-trunk", 100), line("b1", "c-br", 40), line("b2", "c-br", 40)];
const RUNS = [run("run-1", "d1", ["b1", "t1"]), run("run-2", "d2", ["b2", "t1"])];
const byId = (res: any, id: string) => res.runs.find((r: any) => r.id === id);

test("route_kind: trunk / branch on a role \"route\" condition only; absent or anywhere else reads as unspecified", () => {
  assert.deepEqual([...ROUTE_KINDS], ["trunk", "branch"]);
  assert.equal(isRouteKind("trunk"), true);
  assert.equal(isRouteKind("tray"), false);
  assert.equal(routeKindOf(TRAY), "trunk");
  assert.equal(routeKindOf(BR), "branch");
  assert.equal(routeKindOf(TRAY0), null, "absent = unspecified");
  assert.equal(routeKindOf({ ...TR, route_kind: "trunk" }), null, "ignored off a route condition");
  assert.equal(routeKindOf({ ...TRAY0, route_kind: "riser" }), null, "an unknown value reads as unspecified");
  assert.equal(usesRouteKinds([DATA, TR, TRAY0, BR0]), false);
  assert.equal(usesRouteKinds([DATA, TR, TRAY0, BR]), true);
});

test("a run with a 40 ft branch and a shared 100 ft trunk: route 140, branch 40, trunk 100", () => {
  const res = resolveCableRuns([DATA, TR, TRAY, BR], SHAPES, RUNS.slice(0, 1));
  const r = byId(res, "run-1");
  assert.deepEqual({ status: r.status, route: r.route_lf, branch: r.branch_lf, trunk: r.trunk_lf, other: r.other_lf }, { status: "linked", route: 140, branch: 40, trunk: 100, other: 0 });
  assert.deepEqual(r.segments.map((s: any) => [s.shape_id, s.kind]), [["b1", "branch"], ["t1", "trunk"]], "segments keep their order and say their kind");
  assert.equal(r.per_cable_lf, 183, "the cable math is unchanged: 140 + 23 + 10 + 10");
  assert.deepEqual(res.warnings, [], "no new warning");
});

test("two runs sharing the trunk: pathway trunk LF 100 (once), cable route LF 280", () => {
  const t = computeCableTakeoff([DATA, TR, TRAY, BR], SHAPES, RUNS)!;
  assert.equal(t.summary.totals.route_lf, 280, "cable reads the trunk once per run — the physical truth for cable");
  assert.deepEqual(t.pathway!.rows, [
    { condition_id: "c-trunk", finish_tag: "TRAY", route_kind: "trunk", segments: 1, pathway_lf: 100, used_lf: 100, unused_lf: 0, linked_runs: 2, pathway_lf_total: 100, multiplier: 1 },
    { condition_id: "c-br", finish_tag: "BRANCH", route_kind: "branch", segments: 2, pathway_lf: 80, used_lf: 80, unused_lf: 0, linked_runs: 2, pathway_lf_total: 80, multiplier: 1 },
  ]);
  assert.deepEqual(t.pathway!.by_kind.map((g: any) => [g.route_kind, g.pathway_lf, g.linked_runs]), [["trunk", 100, 2], ["branch", 80, 2]]);
  assert.deepEqual(t.pathway!.totals, { segments: 3, pathway_lf: 180, used_lf: 180, unused_lf: 0, linked_runs: 2, pathway_lf_total: 180 }, "a run on a branch and the trunk is one run in the total");
  const rows = cableRunRows(t);
  assert.deepEqual(rows.map((r: any) => [r.run_id, r.route_lf, r.branch_lf, r.trunk_lf, r.other_lf]), [["run-1", 140, 40, 100, 0], ["run-2", 140, 40, 100, 0]]);
});

test("pathway: an unlinked segment and one only a broken run names count as not used; ×N rides pathway_lf_total; untagged route conditions are listed as unspecified", () => {
  const OTHER = cond("c-other", "ROUTE", { role: "route" });
  const conds = [DATA, TR, { ...TRAY, multiplier: 3 }, BR, OTHER];
  const shapes = [...SHAPES, count("d3", "c-data"), line("b3", "c-br", 12.5), line("o1", "c-other", 7)];
  const runs = [...RUNS, run("run-3", "d3", ["b3", "gone"])];   // broken: a deleted segment
  const t = computeCableTakeoff(conds, shapes, runs)!;
  assert.equal(byId(t.resolved, "run-3").status, "broken");
  const [tray, br, other] = t.pathway!.rows;
  assert.deepEqual({ lf: tray.pathway_lf, total: tray.pathway_lf_total, mult: tray.multiplier }, { lf: 100, total: 300, mult: 3 });
  assert.deepEqual({ segs: br.segments, lf: br.pathway_lf, used: br.used_lf, unused: br.unused_lf, runs: br.linked_runs }, { segs: 3, lf: 92.5, used: 80, unused: 12.5, runs: 2 });
  assert.deepEqual({ kind: other.route_kind, lf: other.pathway_lf, unused: other.unused_lf, runs: other.linked_runs }, { kind: "", lf: 7, unused: 7, runs: 0 });
  assert.deepEqual(t.pathway!.by_kind.map((g: any) => g.route_kind), ["trunk", "branch", ""]);
  assert.deepEqual(pathwayRollup(t.resolved, conds, shapes), t.pathway, "the rollup is pure");
});

test("a run on an unspecified route condition among tagged ones: its LF is other_lf, no warning (mixed is fine)", () => {
  const OTHER = cond("c-other", "ROUTE", { role: "route" });
  const PLAIN = cond("c-plain", "WALL-LINE");   // linking is by shape id: a line on a non-route condition still links
  const shapes = [...SHAPES, line("o1", "c-other", 30), line("p1", "c-plain", 5)];
  const res = resolveCableRuns([DATA, TR, TRAY, BR, OTHER, PLAIN], shapes, [run("run-1", "d1", ["o1", "p1", "t1"]), run("run-2", "d2", ["b1"])]);
  assert.deepEqual([res.runs[0].route_lf, res.runs[0].branch_lf, res.runs[0].trunk_lf, res.runs[0].other_lf], [135, 0, 100, 35]);
  assert.deepEqual([res.runs[1].route_lf, res.runs[1].branch_lf, res.runs[1].trunk_lf], [40, 40, 0], "a branch with no trunk segment is not a fault either");
  assert.deepEqual(res.warnings, []);
});

test("J-hooks are a materials row on the branch condition: per 5 LF on a 40 ft + 35 ft branch → ceil(75/5) = 15; ×2 → 30, each segment once", () => {
  const shapes = [line("b1", "c-br", 40), line("b2", "c-br", 35)];
  const [row] = conditionTotals([BR], shapes);
  assert.deepEqual({ basis: row.materials[0].basis_qty, qty: row.materials[0].qty }, { basis: 75, qty: 15 });
  // the basis is the condition's own LF — runs do not enter it: three runs
  // riding the same 40 ft branch still buy 15 hooks
  const [x2] = conditionTotals([{ ...BR, multiplier: 2 }], shapes);
  assert.deepEqual({ basis: x2.materials[0].basis_qty, qty: x2.materials[0].qty }, { basis: 150, qty: 30 });
  // the pathway's ×N column is that same basis
  const t = computeCableTakeoff([DATA, TR, TRAY, { ...BR, multiplier: 2 }], [...SHAPES.slice(0, 4), ...shapes], [run("run-1", "d1", ["b1", "t1"]), run("run-2", "d2", ["b1", "t1"])])!;
  const br = t.pathway!.rows.find((r: any) => r.route_kind === "branch");
  assert.deepEqual({ lf: br.pathway_lf, total: br.pathway_lf_total, used: br.used_lf, unused: br.unused_lf }, { lf: 75, total: 150, used: 40, unused: 35 });
});

test("exports: Branch LF / Trunk LF before Reason / notes on the runs sheet, a Pathway section, tab and report block — only once a route condition is tagged", () => {
  const conds = [DATA, TR, TRAY, BR];
  const t = computeCableTakeoff(conds, SHAPES, RUNS)!;
  const tables = cableTables(t) as any;
  assert.deepEqual(tables.runs[0].slice(-3), ["Branch LF", "Trunk LF", "Reason / notes"]);
  assert.deepEqual(tables.runs[0].slice(0, -3), CABLE_RUNS_HEADER.slice(0, -1), "every other column keeps its position");
  assert.deepEqual(tables.runs[1].slice(8, 9), [140]);
  assert.deepEqual(tables.runs[1].slice(-3), [40, 100, ""]);
  assert.deepEqual(tables.pathway, [
    ["Route condition", "Kind", "Segments", "Pathway LF (each segment once)", "Used by linked runs LF", "Not used by a linked run LF", "Linked runs", "Multiplier", "Pathway LF ×N"],
    ["TRAY", "Trunk", 1, 100, 100, 0, 2, 1, 100],
    ["BRANCH", "Branch", 2, 80, 80, 0, 2, 1, 80],
    ["Subtotal trunk", "Trunk", 1, 100, 100, 0, 2, "", 100],
    ["Subtotal branch", "Branch", 2, 80, 80, 0, 2, "", 80],
    ["TOTAL", "", 3, 180, 180, 0, 2, "", 180],
  ]);
  const rows = conditionTotals(conds, SHAPES).filter((r: any) => r.shape_count > 0);
  const csv = totalsToCsv(rows, "", null, null, null, null, null, "OpenTakeoff", "imperial", t);
  assert.ok(csv.endsWith("\nPathway\nRoute condition,Kind,Segments,Pathway LF (each segment once),Used by linked runs LF,Not used by a linked run LF,Linked runs,Multiplier,Pathway LF ×N\nTRAY,Trunk,1,100,100,0,2,1,100\nBRANCH,Branch,2,80,80,0,2,1,80\nSubtotal trunk,Trunk,1,100,100,0,2,,100\nSubtotal branch,Branch,2,80,80,0,2,,80\nTOTAL,,3,180,180,0,2,,180\n"), csv);
  assert.ok(csv.includes("run-1,DATA-1,wall_outlet,CAT6A,MDF,a.pdf,a.pdf,a.pdf,140,23,10,10,183,2,366,1,linked,human,40,100,\n"), csv);
  const tabs = reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t });
  assert.deepEqual(tabs.map((s: any) => s.name).slice(-3), ["Cable summary", "Cable runs", "Pathway"]);
  assert.deepEqual(tabs.at(-1)!.rows, tables.pathway);
  const json: any = reportJson({ rows, cable: cableReportBlock(t) });
  assert.equal(Object.keys(json.cable).at(-1), "pathway", "appends last in the cable block");
  assert.deepEqual(json.cable.pathway.totals.pathway_lf, 180);
  assert.deepEqual([json.cable.runs[0].branch_lf, json.cable.runs[0].trunk_lf, json.cable.runs[0].other_lf], [40, 100, 0]);
  // metric converts the pathway and split cells like every other length
  const met = cableTables(t, { L: (v: number) => Math.round(v * 0.3048 * 100) / 100, lengthUnit: "m" }) as any;
  assert.equal(met.pathway[0][3], "Pathway m (each segment once)");
  assert.equal(met.pathway[1][3], 30.48);
  assert.deepEqual(met.runs[0].slice(-3), ["Branch m", "Trunk m", "Reason / notes"]);
  // the cover names the kind and the pathway LF counted once
  const legend = cableLegend(t, conds, { fmtLen: (ft: number) => `${ft} LF` })!;
  assert.equal(legend.lines.get("c-trunk"), "trunk pathway, 100 LF measured once: not a cable quantity; cable LF is figured per run on each device condition");
  assert.equal(legend.lines.get("c-tr"), "telecom room: where the runs home");
});

test("no route_kind anywhere: CSV, report JSON and workbook are byte-identical to the base commit", () => {
  const conds = [DATA, TR, TRAY0, BR0];
  const t = computeCableTakeoff(conds, SHAPES, RUNS)!;
  assert.equal(t.pathway, null);
  const rows = conditionTotals(conds, SHAPES).filter((r: any) => r.shape_count > 0);
  // captured from d680c88 with the same fixture
  const BASE_CSV = [
    "# Invented — OpenTakeoff report",
    "Finish,Shapes,Multiplier,Waste %,Floor SF,Wall SF,Border SF,Total SF,LF,EA,Total SF w/Waste,LF w/Waste,SY w/Waste",
    "DATA-1,2,1,12,0,0,0,0,0,2,0,0,0",
    "TR,1,1,0,0,0,0,0,0,1,0,0,0",
    "TRAY,1,1,0,0,0,0,0,100,0,0,100,0",
    "BRANCH,2,1,0,0,0,0,0,80,0,0,80,0",
    "TOTAL,,,,,,,0,180,3,0,180,0",
    "",
    "Finish,Material,Qty,Unit,Coverage,Note",
    "BRANCH,J-hook,16,EA,1 EA / 5 LF,",
    "",
    "Material (combined),Qty,Unit",
    "J-hook,16,EA",
    "",
    "Cable summary",
    "Condition,Device type,Cable type,TR,Multiplier,Waste %,Device EA,Pulls,Cables,Measured route LF,Cable LF (net),\"Cable LF (order, with waste)\",Unlinked devices,Held devices,Pending runs,Runs over 295 ft,Note",
    "DATA-1,wall_outlet,CAT6A,MDF,1,12,2,2,4,280,732,819.84,0,0,0,0,",
    "Subtotal by TR,,,MDF,,,2,2,4,280,732,819.84,0,0,0,0,",
    "Subtotal by cable type,,CAT6A,,,,2,2,4,280,732,819.84,0,0,0,0,",
    "TOTAL,,,,,,2,2,4,280,732,819.84,0,0,0,0,",
    "",
    "Cable runs",
    "Run ID,Condition,Device type,Cable type,TR,Device sheet,Route sheet(s),TR sheet,Route LF,Vertical ft,Loop at device ft,Loop at TR ft,Per-cable LF,Cables,Location LF,Multiplier,Status,Review status,Reason / notes",
    "run-1,DATA-1,wall_outlet,CAT6A,MDF,a.pdf,a.pdf,a.pdf,140,23,10,10,183,2,366,1,linked,human,",
    "run-2,DATA-1,wall_outlet,CAT6A,MDF,a.pdf,a.pdf,a.pdf,140,23,10,10,183,2,366,1,linked,human,",
    "",
  ].join("\n");
  assert.equal(totalsToCsv(rows, "Invented", null, null, null, null, null, "OpenTakeoff", "imperial", t), BASE_CSV);
  const block: any = cableReportBlock(t);
  assert.equal("pathway" in block, false);
  assert.equal("branch_lf" in block.runs[0] || "trunk_lf" in block.runs[0] || "other_lf" in block.runs[0], false);
  assert.deepEqual(Object.keys(block), ["summary", "by_tr", "by_cable_type", "totals", "runs", "unlinked", "held", "holds", "warnings"]);
  assert.deepEqual(reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t }).map((s: any) => s.name), ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room", "Cable summary", "Cable runs"]);
  assert.equal(cableLegend(t, conds, { fmtLen: (ft: number) => `${ft} LF` })!.lines.get("c-trunk"), "cable route pathway, not a cable quantity: cable LF is figured per run on each device condition");
  // the report JSON and the workbook, hashed on d680c88 with this fixture
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  assert.equal(sha(JSON.stringify(reportJson({ rows, cable: cableReportBlock(t) }))), "64897409c2f2d70f");
  assert.equal(sha(JSON.stringify(reportWorkbook({ rows, bySheet: [], shapeRows: [], cable: t }))), "8467bc1a07dbe810");
});

test("route_kind round-trips through the takeoff document and the app's reader; templates carry it on a route condition only", () => {
  const conds = [DATA, TR, TRAY, BR];
  const doc = buildTakeoffDocument({ project_name: "Invented job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: conds, shapes: SHAPES, cable_runs: RUNS, sheet_tabs: ["a.pdf"] });
  const text = JSON.stringify(doc);
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(text), ["a.pdf"]);
  assert.deepEqual(payload.conditions.map((c: any) => c.route_kind), [undefined, undefined, "trunk", "branch"]);
  const t = computeCableTakeoff(payload.conditions, payload.shapes, sanitizeCableRuns(payload.cable_runs))!;
  assert.deepEqual([t.resolved.runs[0].branch_lf, t.resolved.runs[0].trunk_lf, t.pathway!.totals.pathway_lf], [40, 100, 180]);
  // an untagged document writes no route_kind key at all
  assert.equal(JSON.stringify(buildTakeoffDocument({ conditions: [DATA, TR, TRAY0, BR0], shapes: SHAPES, cable_runs: RUNS })).includes("route_kind"), false);
  // condition templates (the library) copy the kind with the role
  assert.equal(instantiateTemplate({ finish_tag: "TRAY", role: "route", route_kind: "trunk" }).route_kind, "trunk");
  assert.equal("route_kind" in instantiateTemplate({ finish_tag: "TRAY", role: "route" }), false);
  assert.equal("route_kind" in instantiateTemplate({ finish_tag: "TR", role: "tr", route_kind: "trunk" }), false, "a kind never rides off a route condition");
});
