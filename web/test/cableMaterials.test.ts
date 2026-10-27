// Parts per cable and per pull (docs/design/CABLE_SETUP_PLAN.md §14.5): the
// "cables" and "pulls" supporting-materials bases. A jack and a patch cord
// per cable, a faceplate per pull — figured from the linked cable runs
// (lib/cable.js cableQtyByShape), never from the device count, so a run's
// cables_override, an unlinked, broken or held device and the ×N multiplier
// all land where the Cable summary puts them. And the other half of the
// contract: a takeoff with no cable work exports byte for byte as before.
// Fixtures are invented. Run with: node --import tsx --test test/cableMaterials.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mintCableSetup, mintCableRun, mintCableHold, computeCableTakeoff, cableQtyByShape, cableMaterialReason,
  CABLE_MATERIAL_BASES, isCableMaterialBasis,
} from "../src/lib/cable.js";
import { conditionTotals, sheetGroupedRows, materialsSummary, reportJson, totalsToCsv, materialBasisLabel } from "../src/lib/totals.js";
import { reportWorkbook } from "../src/lib/xlsx.js";
import { noCableOutputs, NO_CABLE_CONDITIONS, NO_CABLE_SHAPES, NO_CABLE_SEAMS } from "./fixtures/cableMaterials.noCable.ts";

// ── fixture ─────────────────────────────────────────────────────────────────
const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, sheet = "a.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number, sheet = "a.pdf") => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const mat = (id: string, name: string, basis: string, per = 1, unit = "ea") => ({ id, name, per, basis, unit, round: true });

const DATA_MATS = [
  mat("m-jack", "RJ45 jack", "cables"),
  mat("m-plate", "Faceplate", "pulls"),
  mat("m-cord", "Patch cord", "cables"),
  mat("m-box", "Low-voltage bracket", "count"),   // the old way: keys on device EA
];
const dataCond = (extra: any = {}) => cond("c-data", "DATA-1", { waste_pct: 10, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 4, cable_type: "CAT6" }), materials: DATA_MATS, ...extra });
const CAM = cond("c-cam", "CAM-1", { cable_setup: mintCableSetup("camera", { cable_type: "CAT6" }), materials: [mat("m-mount", "Camera mount", "pulls"), mat("m-opc", "Outdoor patch cord", "cables")] });
const WAP = cond("c-wap", "WAP-1", { cable_setup: mintCableSetup("wap"), materials: [mat("m-wjack", "RJ45 jack", "cables")] });
const VCT = cond("c-vct", "VCT-1", { materials: [mat("m-vjack", "RJ45 jack", "cables"), { id: "m-adh", name: "Adhesive", per: 250, basis: "area", unit: "gal", round: true }] });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
const conds = (data = dataCond()) => [data, CAM, WAP, VCT, TR, ROUTE];

const SHAPES = [
  count("tr", "c-tr", "a.pdf", { label: "MDF" }),
  // DATA-1: d1–d4 linked (d4 overridden to 2 cables), d5 on a broken run, d6 held
  count("d1", "c-data", "a.pdf"), count("d2", "c-data", "a.pdf"), count("d3", "c-data", "b.pdf"), count("d4", "c-data", "b.pdf"),
  count("d5", "c-data", "b.pdf"), count("d6", "c-data", "b.pdf"),
  count("cam1", "c-cam"), count("cam2", "c-cam"),
  count("wap1", "c-wap"),
  { id: "floor", sheet_id: "a.pdf", condition_id: "c-vct", measure_role: "floor_area", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 600, perimeter_lf: 100 } },
  line("r1", "c-route", 40), line("r2", "c-route", 55), line("r3", "c-route", 62, "b.pdf"), line("r4", "c-route", 71, "b.pdf"),
  line("rc1", "c-route", 90), line("rc2", "c-route", 120),
];
const run = (id: string, dev: string, route: string, extra: any = {}) => ({ ...mintCableRun({ device_shape_ids: [dev], route_shape_ids: [route], tr_id: "tr", ...extra }), id });
const RUNS = [
  // an agent's run, still pending review — it counts, like every pending shape
  run("run-1", "d1", "r1", { provenance: { method: "link_run", actor: "agent" } }),
  run("run-2", "d2", "r2"),
  run("run-3", "d3", "r3"),
  run("run-4", "d4", "r4", { cables_override: 2 }),
  run("run-5", "d5", "gone"),                              // its route was deleted: broken, excluded
  { ...mintCableHold({ device_shape_ids: ["d6"], reason: "by others (owner's vendor)" }), id: "hold-1" },
  run("run-c1", "cam1", "rc1"), run("run-c2", "cam2", "rc2"),
];

const figure = (cs = conds(), shapes: any[] = SHAPES, runs: any[] = RUNS) => {
  const takeoff: any = computeCableTakeoff(cs, shapes, runs);
  const rows = conditionTotals(cs, shapes, { cableByShape: cableQtyByShape(takeoff) });
  return { takeoff, rows, row: (tag: string) => rows.find((r: any) => r.finish_tag === tag) };
};
const qty = (row: any, name: string) => row.materials.find((m: any) => m.name === name);

test("the two figured cable bases are named once in lib/cable.js", () => {
  assert.deepEqual([...CABLE_MATERIAL_BASES], ["cables", "pulls"]);
  assert.equal(isCableMaterialBasis("cables"), true);
  assert.equal(isCableMaterialBasis("count"), false);
  assert.equal(isCableMaterialBasis(undefined), false);
});

test("DATA-1: 3 runs at 4 cables + 1 overridden to 2, one broken and one held device — jacks 14, faceplates 4, patch cords 14", () => {
  const { takeoff, row } = figure();
  const data = row("DATA-1");
  assert.equal(data.ea, 6, "six device markers on the plan");
  // the Cable summary and the materials agree: unlinked (broken) and held are out
  const sum = takeoff.summary.rows.find((r: any) => r.condition_id === "c-data");
  assert.deepEqual({ ea: sum.ea, pulls: sum.pulls, cables: sum.cables, unlinked: sum.unlinked_devices, held: sum.held_devices, pending: sum.pending_runs },
    { ea: 6, pulls: 4, cables: 14, unlinked: 1, held: 1, pending: 1 });
  assert.deepEqual(qty(data, "RJ45 jack"), { name: "RJ45 jack", unit: "ea", per: 1, basis: "cables", round: true, note: "", basis_qty: 14, qty: 14 });
  assert.deepEqual(qty(data, "Faceplate"), { name: "Faceplate", unit: "ea", per: 1, basis: "pulls", round: true, note: "", basis_qty: 4, qty: 4 });
  assert.deepEqual(qty(data, "Patch cord"), { name: "Patch cord", unit: "ea", per: 1, basis: "cables", round: true, note: "", basis_qty: 14, qty: 14 });
  // the hand workaround it replaces: a count row sees every marker, held and broken included
  assert.equal(qty(data, "Low-voltage bracket").qty, 6);
  // a camera: a mount per pull, an outdoor patch cord per cable
  const cam = row("CAM-1");
  assert.deepEqual([qty(cam, "Camera mount").qty, qty(cam, "Outdoor patch cord").qty], [2, 2]);
});

test("×2 doubles them, and a condition's figured cables and pulls equal cableByCondition's", () => {
  const cs = conds(dataCond({ multiplier: 2 }));
  const { takeoff, row } = figure(cs);
  const data = row("DATA-1");
  assert.deepEqual([qty(data, "RJ45 jack").qty, qty(data, "Faceplate").qty, qty(data, "Patch cord").qty], [28, 8, 28]);
  const by = takeoff.byCond.get("c-data");
  assert.deepEqual([by.cables, by.pulls], [28, 8]);
  // per shape, unmultiplied: d4 carries its override, the held and broken devices nothing
  const per = cableQtyByShape(takeoff);
  assert.deepEqual(per.get("d4"), { pulls: 1, cables: 2 });
  assert.equal(per.has("d5"), false);
  assert.equal(per.has("d6"), false);
});

test("coverage other than 1 rounds up like every row; round:false keeps two places", () => {
  const cs = conds(dataCond({ materials: [{ ...mat("m-bag", "Velcro roll", "cables", 8, "roll") }, { ...mat("m-lbl", "Label sheet", "pulls", 3, "sheet"), round: false }] }));
  const data = figure(cs).row("DATA-1");
  assert.deepEqual([qty(data, "Velcro roll").qty, qty(data, "Label sheet").qty], [2, 1.33]);   // 14 ÷ 8 → 2; 4 ÷ 3 = 1.33
});

test("a condition with no cable setup, or with no linked run, reads 0 and says why", () => {
  const { row } = figure();
  const vct = qty(row("VCT-1"), "RJ45 jack");
  // (+ 0: a zero row's ceil is -0 on every basis, which prints "0" everywhere)
  assert.deepEqual({ basis_qty: vct.basis_qty, qty: vct.qty + 0 }, { basis_qty: 0, qty: 0 });
  assert.match(vct.reason, /no cable setup on this condition/);
  assert.equal("reason" in qty(row("VCT-1"), "Adhesive"), false, "an area row never carries a reason");
  const wap = qty(row("WAP-1"), "RJ45 jack");
  assert.equal(wap.qty + 0, 0);
  assert.match(wap.reason, /no linked cable run/);
  for (const name of ["RJ45 jack", "Faceplate", "Patch cord", "Low-voltage bracket"]) assert.equal("reason" in qty(row("DATA-1"), name), false, `${name} figures, so no reason`);
  // a caller that hands in no cable takeoff at all says so rather than blaming the runs
  const bare = conditionTotals(conds(), SHAPES).find((r: any) => r.finish_tag === "DATA-1");
  assert.equal(qty(bare, "RJ45 jack").qty + 0, 0);
  assert.match(qty(bare, "RJ45 jack").reason, /not figured in this view/);
  assert.equal(cableMaterialReason(dataCond(), 3), null);
});

test("the by-sheet slice splits the parts where the devices sit, and the slices sum to the condition", () => {
  const takeoff = computeCableTakeoff(conds(), SHAPES, RUNS);
  const groups: any[] = sheetGroupedRows(conds(), SHAPES, { cableByShape: cableQtyByShape(takeoff) });
  const jacks = (sheet: string) => qty(groups.find((g: any) => g.sheet_id === sheet).rows.find((r: any) => r.finish_tag === "DATA-1"), "RJ45 jack").qty;
  assert.deepEqual([jacks("a.pdf"), jacks("b.pdf")], [8, 6]);   // d1 + d2 at 4; d3 at 4 + d4 at 2
});

test("the buy list, CSV, workbook and report JSON carry the exact parts, the coverage in cables/pulls, and the reason", () => {
  const { takeoff, rows } = figure();
  const live = rows.filter((r: any) => r.shape_count > 0);
  const buy = materialsSummary(live);
  assert.equal(buy.find((m: any) => m.name === "RJ45 jack").qty, 14, "DATA-1's 14 + VCT-1's 0 + WAP-1's 0");
  assert.equal(buy.find((m: any) => m.name === "Faceplate").qty, 4);
  assert.equal(buy.find((m: any) => m.name === "Patch cord").qty, 14);
  assert.equal(buy.find((m: any) => m.name === "Camera mount").qty, 2);
  assert.equal(materialBasisLabel("cables", 1), "cable");
  assert.equal(materialBasisLabel("pulls", 3), "pulls");

  const csv = totalsToCsv(live, "", null, null, null, null, null, "OpenTakeoff", "imperial", takeoff);
  assert.ok(csv.includes("\nDATA-1,RJ45 jack,14,ea,1 ea / 1 cable,\n"));
  assert.ok(csv.includes("\nDATA-1,Faceplate,4,ea,1 ea / 1 pull,\n"));
  assert.ok(csv.includes("\nDATA-1,Patch cord,14,ea,1 ea / 1 cable,\n"));
  assert.ok(csv.includes("\nVCT-1,RJ45 jack,0,ea,1 ea / 1 cable,no cable setup on this condition — per cable and per pull read 0\n"));
  assert.ok(csv.includes("\nWAP-1,RJ45 jack,0,ea,1 ea / 1 cable,no linked cable run — 0 until a run links this condition's devices\n"));

  const tab = reportWorkbook({ rows: live, bySheet: [], shapeRows: [], cable: takeoff }).find((s: any) => s.name === "Materials")!.rows;
  assert.deepEqual(tab.find((r: any[]) => r[0] === "DATA-1" && r[1] === "RJ45 jack"), ["DATA-1", "RJ45 jack", 14, "ea", "1 ea / 1 cable", ""]);
  assert.match(String(tab.find((r: any[]) => r[0] === "VCT-1" && r[1] === "RJ45 jack")![5]), /no cable setup/);

  const json = reportJson({ rows: live, cable: null });
  assert.equal(json.materials.find((m: any) => m.name === "RJ45 jack").qty, 14);
  const dataJson = json.conditions.find((r: any) => r.finish_tag === "DATA-1");
  assert.equal(dataJson.materials.find((m: any) => m.name === "Faceplate").basis_qty, 4);
});

test("a takeoff with no cable work: report JSON, CSV and workbook are byte-identical to the base commit", () => {
  // SHA-256 of noCableOutputs({ seamByShape }) computed on d680c88, before the
  // cables / pulls bases existed (the fixture's own header says how)
  const BASE = {
    json: "a7fa4c0e44034aaaaaa232d9d85d6b2a5ebc1932f6d13a4f4af29fc3d67ac914",
    csv: "331b6eda11635625e6b7b83e6d697323158b58c3bb18a9f4f4da4b15528ede0a",
    xlsx: "0ec25c10c671ff966cf9cf5cc40a02af888c676cc8e742762ec7db2d9ee6ca67",
  };
  const sha = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, createHash("sha256").update(v).digest("hex")]));
  assert.deepEqual(sha(noCableOutputs({ seamByShape: NO_CABLE_SEAMS })), BASE, "no cable ctx");
  // every caller now hands in the cable map: with no cable takeoff it is empty
  const none = computeCableTakeoff(NO_CABLE_CONDITIONS, NO_CABLE_SHAPES, []);
  assert.equal(none, null);
  assert.deepEqual(sha(noCableOutputs({ seamByShape: NO_CABLE_SEAMS, cableByShape: cableQtyByShape(none) })), BASE, "empty cable ctx");
  const rows = conditionTotals(NO_CABLE_CONDITIONS, NO_CABLE_SHAPES, { seamByShape: NO_CABLE_SEAMS, cableByShape: new Map() });
  for (const r of rows) for (const m of r.materials) assert.equal("reason" in m, false, `${r.finish_tag} ${m.name}`);
});
