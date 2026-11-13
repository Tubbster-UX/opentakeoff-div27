// Division 27 cable box / reel rounding (docs/design/CABLE_SETUP_PLAN.md
// §15.2): cable is bought in boxes or reels, so an optional cable_setup
// field `package_ft` (feet per box or reel) turns each CABLE TYPE's order LF
// into whole packages — boxes = ceil(order LF / package_ft), purchased =
// boxes × package_ft, leftover = purchased − order. Boxes pool across every
// condition of the type (rounding each condition up overstates), are bought
// against the ORDER quantity (waste and ×N in), and are left blank — never
// guessed — when a type has no size, its conditions disagree, or the type is
// blank. Every box output is gated on a stated size, so a cable takeoff
// without one exports byte for byte as before (pinned against 28ea3cc).
// Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mintCableSetup, packageFt, usesPackageSizes, cableOrderRollup, computeCableTakeoff, cableReportBlock, cableTables,
  CABLE_ORDER_HEADER, sanitizeCableRuns,
} from "../src/lib/cable.js";
import { cableLegend } from "../src/lib/cableMarks.js";
import { totalsToCsv } from "../src/lib/totals.js";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";
import { boxOutputs, BOX_CONDITIONS } from "./fixtures/cableBoxes.base.ts";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 } });
const line = (id: string, condId: string, lf: number) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const run = (id: string, dev: string, route: string[]) => ({ id, device_shape_ids: [dev], route_shape_ids: route, tr_id: "tr", provenance: { method: "manual", created_at: "2026-10-27T00:00:00.000Z" } });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-rt", "ROUTE", { role: "route" });

/** One device condition with `n` linked runs, each one route segment of the
 *  given length (a wall outlet: + 23 vertical + 10 + 10 loops = +43). */
function devices(condId: string, lengths: number[]) {
  const shapes: any[] = [];
  const runs: any[] = [];
  lengths.forEach((lf, i) => {
    shapes.push(count(`${condId}-d${i}`, condId), line(`${condId}-r${i}`, "c-rt", lf));
    runs.push(run(`${condId}-run${i}`, `${condId}-d${i}`, [`${condId}-r${i}`]));
  });
  return { shapes, runs };
}
function takeoff(conds: any[], groups: { shapes: any[]; runs: any[] }[]) {
  const shapes = [count("tr", "c-tr"), ...groups.flatMap((g) => g.shapes)];
  const runs = groups.flatMap((g) => g.runs);
  return { conds: [...conds, TR, ROUTE], shapes, runs, t: computeCableTakeoff([...conds, TR, ROUTE], shapes, runs)! };
}
const orderRow = (t: any, type: string) => t.order.rows.find((r: any) => r.cable_type === type);

// 100 CAT6A drops at 2 cables: net (11,576.17 + 100 × 43) × 2 = 31,752.34 LF
const BIG_ROUTES = [...Array(99).fill(115.76), 115.93];

test("package_ft: a number of feet > 0, else not stated; the gate reads only a valid one", () => {
  assert.equal(packageFt({ package_ft: 1000 }), 1000);
  assert.equal(packageFt({ package_ft: 0.5 }), 0.5);
  for (const bad of [0, -1000, "1000", NaN, Infinity, null, undefined]) assert.equal(packageFt({ package_ft: bad }), null, String(bad));
  assert.equal("package_ft" in mintCableSetup("wall_outlet"), false, "no starting value is minted");
  const data = cond("c", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { package_ft: 1000 }) });
  assert.equal(usesPackageSizes([data]), true);
  assert.equal(usesPackageSizes([cond("c", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { package_ft: 0 }) })]), false);
  assert.equal(usesPackageSizes([cond("r", "ROUTE", { role: "route", cable_setup: { package_ft: 1000 } })]), false, "only a cable (device) condition sizes a type");
});

test("CAT6A order 31,752.34 × 1.12 = 35,562.62 LF at 1000 ft boxes: 36 boxes, 36,000 purchased, 437.38 left over", () => {
  const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A", package_ft: 1000 }) });
  const { t } = takeoff([DATA], [devices("c-data", BIG_ROUTES)]);
  assert.equal(t.summary.totals.cable_lf, 31752.34);
  assert.equal(t.summary.by_cable_type[0].cable_lf_order, 35562.62);
  assert.deepEqual(t.order!.rows, [{
    cable_type: "CAT6A", order_lf: 35562.62, package_ft: 1000, boxes: 36, purchased_lf: 36000, leftover_lf: 437.38,
    conditions: ["DATA-1"], package_set_on: ["DATA-1"],
  }]);
  // the measured and net numbers are untouched: boxes ride only the order table
  const plain = takeoff([{ ...DATA, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) }], [devices("c-data", BIG_ROUTES)]).t;
  assert.deepEqual(t.summary.rows, plain.summary.rows);
  assert.deepEqual(t.summary.totals, plain.summary.totals);
  assert.equal(plain.order, null);
});

test("boxes pool by cable type: three 400 LF conditions of CAT6A are 2 boxes, not 1 + 1 + 1", () => {
  const box = { cable_type: "CAT6A", package_ft: 1000 };
  // wall outlet: 357 + 23 + 10 + 10 = 400; WAP: 357 + 13 + 20 + 10 = 400
  const A = cond("c-a", "DATA-A", { cable_setup: mintCableSetup("wall_outlet", box) });
  const B = cond("c-b", "DATA-B", { cable_setup: mintCableSetup("wall_outlet", box) });
  const W = cond("c-w", "WAP-1", { cable_setup: mintCableSetup("wap", box) });
  const { t } = takeoff([A, B, W], [devices("c-a", [357]), devices("c-b", [357]), devices("c-w", [357])]);
  assert.deepEqual(t.summary.rows.map((r: any) => r.cable_lf_order), [400, 400, 400]);
  const perCondition = t.summary.rows.reduce((n: number, r: any) => n + Math.ceil(r.cable_lf_order / 1000), 0);
  assert.equal(perCondition, 3, "rounding each condition up would buy 3 boxes");
  assert.deepEqual(orderRow(t, "CAT6A"), {
    cable_type: "CAT6A", order_lf: 1200, package_ft: 1000, boxes: 2, purchased_lf: 2000, leftover_lf: 800,
    conditions: ["DATA-A", "DATA-B", "WAP-1"], package_set_on: ["DATA-A", "DATA-B", "WAP-1"],
  });
  // 600 + 700 = 1300 is 2 boxes either way (pooling only matters when the
  // per-condition remainders add up to less than a box — as above)
  const C = cond("c-c", "DATA-C", { cable_setup: mintCableSetup("wall_outlet", box) });
  const D = cond("c-d", "DATA-D", { cable_setup: mintCableSetup("wall_outlet", box) });
  const two = takeoff([C, D], [devices("c-c", [557]), devices("c-d", [657])]).t;
  assert.deepEqual([orderRow(two, "CAT6A").order_lf, orderRow(two, "CAT6A").boxes, orderRow(two, "CAT6A").leftover_lf], [1300, 2, 700]);
});

test("one condition stating the size sizes its whole cable type; an exact multiple buys no extra box; nothing linked is 0 boxes", () => {
  const A = cond("c-a", "DATA-A", { cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A", package_ft: 1000 }) });
  const W = cond("c-w", "WAP-1", { cable_setup: mintCableSetup("wap", { cable_type: "CAT6A" }) });
  const { t } = takeoff([A, W], [devices("c-a", [957, 957]), devices("c-w", [])]);
  assert.deepEqual(orderRow(t, "CAT6A"), {
    cable_type: "CAT6A", order_lf: 2000, package_ft: 1000, boxes: 2, purchased_lf: 2000, leftover_lf: 0,
    conditions: ["DATA-A", "WAP-1"], package_set_on: ["DATA-A"],
  });
  const none = takeoff([A], [devices("c-a", [])]).t;
  assert.deepEqual([orderRow(none, "CAT6A").order_lf, orderRow(none, "CAT6A").boxes, orderRow(none, "CAT6A").purchased_lf, orderRow(none, "CAT6A").leftover_lf], [0, 0, 0, 0]);
});

test("conflicting sizes on one cable type: that type's boxes are blank and a warning names the conditions and sizes", () => {
  const A = cond("c-a", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A", package_ft: 1000 }) });
  const W = cond("c-w", "WAP-1", { cable_setup: mintCableSetup("wap", { cable_type: "CAT6A", package_ft: 500 }) });
  const F = cond("c-f", "CAM-FO", { cable_setup: mintCableSetup("camera", { cable_type: "OS2 fiber", package_ft: 2000 }) });
  const { t } = takeoff([A, W, F], [devices("c-a", [357]), devices("c-w", [357]), devices("c-f", [462])]);
  assert.deepEqual(orderRow(t, "CAT6A"), {
    cable_type: "CAT6A", order_lf: 800, package_ft: null, boxes: null, purchased_lf: null, leftover_lf: null,
    conditions: ["DATA-1", "WAP-1"], package_set_on: ["DATA-1", "WAP-1"],
    note: "conflicting box/reel sizes: DATA-1 1000 ft, WAP-1 500 ft",
    package_conflict: [{ finish_tag: "DATA-1", package_ft: 1000 }, { finish_tag: "WAP-1", package_ft: 500 }],
  });
  assert.ok(t.summary.warnings.includes("Cable type CAT6A: its conditions state different box/reel sizes (DATA-1 1000 ft; WAP-1 500 ft). Its boxes are left blank rather than guessed: state one package_ft for the cable type, or give the different products different cable types."), t.summary.warnings.join("\n"));
  // the other cable type is unaffected: 462 + 13 + 15 + 10 = 500 on a 2000 ft reel
  assert.deepEqual([orderRow(t, "OS2 fiber").boxes, orderRow(t, "OS2 fiber").purchased_lf, orderRow(t, "OS2 fiber").leftover_lf], [1, 2000, 1500]);
  // the same size twice is not a conflict, and a metric entry a hair off is the same size
  const W2 = { ...W, cable_setup: { ...W.cable_setup, package_ft: 304.8 / 0.3048 } };
  assert.equal(orderRow(takeoff([A, W2], [devices("c-a", [357]), devices("c-w", [357])]).t, "CAT6A").boxes, 1);
  // the CSV row prints blanks, never 0
  const tables: any = cableTables(t);
  assert.deepEqual(tables.order[1], ["CAT6A", 800, "", "", "", "", "conflicting box/reel sizes: DATA-1 1000 ft, WAP-1 500 ft"]);
});

test("a cable type no condition sizes gets no boxes (blank, not 0); the blank cable type gets none either, and says why", () => {
  const A = cond("c-a", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A", package_ft: 1000 }) });
  const U = cond("c-u", "UTP-1", { cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6" }) });
  const K = cond("c-k", "CAM-1", { cable_setup: mintCableSetup("camera", { package_ft: 1000 }) });   // no cable type
  const { t } = takeoff([A, U, K], [devices("c-a", [357]), devices("c-u", [357]), devices("c-k", [462])]);
  assert.deepEqual(t.order!.rows.map((r: any) => [r.cable_type, r.order_lf, r.boxes]), [["CAT6A", 400, 1], ["CAT6", 400, null], ["", 500, null]]);
  assert.equal(orderRow(t, "CAT6").note, undefined, "no size stated: nothing to explain");
  assert.equal(orderRow(t, "").note, "no cable type: boxes are pooled by cable type, so none are figured");
  assert.ok(t.summary.warnings.includes("CAM-1 states a 1000 ft box/reel but no cable type. Boxes are pooled by cable type, so none are figured for it: name the cable type (the blank group may hold different products)."), t.summary.warnings.join("\n"));
  const tables: any = cableTables(t);
  assert.deepEqual(tables.order, [
    [...CABLE_ORDER_HEADER],
    ["CAT6A", 400, 1000, 1, 1000, 600, ""],
    ["CAT6", 400, "", "", "", "", ""],
    ["(no cable type)", 500, "", "", "", "", "no cable type: boxes are pooled by cable type, so none are figured"],
  ]);
  // a blank-type condition with no size adds no warning
  const quiet = takeoff([A, { ...K, cable_setup: mintCableSetup("camera") }], [devices("c-a", [357]), devices("c-k", [462])]).t;
  assert.equal(quiet.summary.warnings.some((w: string) => /no cable type/.test(w)), false);
});

test("×N: the multiplier is already in the order LF the boxes are bought against", () => {
  const A = cond("c-a", "DATA-1", { multiplier: 3, waste_pct: 10, cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A", package_ft: 1000 }) });
  const { t } = takeoff([A], [devices("c-a", [357])]);
  // 400 net × 3 = 1200, × 1.10 = 1320 → 2 boxes, 680 left over
  assert.deepEqual([t.summary.totals.cable_lf, orderRow(t, "CAT6A").order_lf, orderRow(t, "CAT6A").boxes, orderRow(t, "CAT6A").purchased_lf, orderRow(t, "CAT6A").leftover_lf], [1200, 1320, 2, 2000, 680]);
});

test("metric converts every length in the order table; boxes stay a count", () => {
  const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A", package_ft: 1000 }) });
  const { t } = takeoff([DATA], [devices("c-data", BIG_ROUTES)]);
  const met: any = cableTables(t, { L: (v: number) => Math.round(v * 0.3048 * 100) / 100, lengthUnit: "m" });
  assert.deepEqual(met.order, [
    ["Cable type", "Order m", "Box/reel m", "Boxes", "Purchased m", "Leftover m", "Note"],
    ["CAT6A", 10839.49, 304.8, 36, 10972.8, 133.31, ""],
  ]);
  const imp: any = cableTables(t);
  assert.deepEqual(imp.order[1], ["CAT6A", 35562.62, 1000, 36, 36000, 437.38, ""]);
  const csv = totalsToCsv([], "", null, null, null, null, null, "OpenTakeoff", "metric", t);
  assert.ok(csv.endsWith("\nCable order\nCable type,Order m,Box/reel m,Boxes,Purchased m,Leftover m,Note\nCAT6A,10839.49,304.8,36,10972.8,133.31,\n"), csv.slice(-300));
});

test("exports: report JSON cable.order, the CSV Cable order section, the Excel Cable order tab and the cover line", () => {
  const conds = BOX_CONDITIONS.map((c: any) => (c.cable_setup?.cable_type === "CAT6A" ? { ...c, cable_setup: { ...c.cable_setup, package_ft: 1000 } }
    : c.cable_setup?.cable_type === "OS2 fiber" ? { ...c, cable_setup: { ...c.cable_setup, package_ft: 2000 } } : c));
  const out = boxOutputs(conds);
  // CAT6A order 2187.17 → 3 boxes; OS2 fiber 223.91 → 1 reel of 2000; the blank type is not sized
  assert.ok(out.csv.endsWith([
    "Cable order",
    "Cable type,Order LF,Box/reel ft,Boxes,Purchased LF,Leftover LF,Note",
    "CAT6A,2187.17,1000,3,3000,812.83,",
    "OS2 fiber,223.91,2000,1,2000,1776.09,",
    "(no cable type),199.36,,,,,",
    "",
  ].join("\n")), out.csv.slice(-400));
  // every section before it is unchanged: the CSV starts with the base commit's CSV minus its final newline
  assert.ok(out.csv.startsWith(boxOutputs().csv.slice(0, -1)), "the Cable order section appends after everything else");
  const json = JSON.parse(out.json);
  assert.equal(Object.keys(json.cable).at(-1), "order", "appends last in the cable block");
  assert.deepEqual(json.cable.order.rows.map((r: any) => [r.cable_type, r.order_lf, r.package_ft, r.boxes, r.purchased_lf, r.leftover_lf]),
    [["CAT6A", 2187.17, 1000, 3, 3000, 812.83], ["OS2 fiber", 223.91, 2000, 1, 2000, 1776.09], ["", 199.36, null, null, null, null]]);
  const tabs = JSON.parse(out.xlsx);
  assert.deepEqual(tabs.map((s: any) => s.name).slice(-4), ["Cable summary", "Cable runs", "Pathway", "Cable order"]);
  assert.deepEqual(tabs.at(-1).rows[1], ["CAT6A", 2187.17, 1000, 3, 3000, 812.83, ""]);
  const tabsM = JSON.parse(out.xlsxMetric);
  assert.deepEqual(tabsM.at(-1).rows.slice(0, 2), [["Cable type", "Order m", "Box/reel m", "Boxes", "Purchased m", "Leftover m", "Note"], ["CAT6A", 666.65, 304.8, 3, 914.4, 247.75, ""]]);
  const legend = JSON.parse(out.legend);
  assert.deepEqual(legend.order, [
    "Cable order: CAT6A: 3 boxes of 1000 LF · 3000 LF purchased against 2187.2 LF order · 812.8 LF left over",
    "Cable order: OS2 fiber: 1 box of 2000 LF · 2000 LF purchased against 223.9 LF order · 1776.1 LF left over",
  ]);
});

test("no package_ft anywhere (or only an invalid one): every cable export is byte-identical to the base commit 28ea3cc", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  // printed by boxOutputs() on 28ea3cc, before package_ft existed
  const BASE = {
    csv: "1dc76d24610351f5", csvMetric: "f824a12c90563465", json: "ec10c6b0f2bf8625", xlsx: "4505de68da52723e",
    xlsxMetric: "90bb755abfa346e4", tables: "42d8569c361f4f14", tablesMetric: "50fcbff946b1958e", legend: "e743b967f48bbd58",
  };
  const hashes = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sha(v)]));
  assert.deepEqual(hashes(boxOutputs()), BASE);
  const t = computeCableTakeoff(BOX_CONDITIONS, [], [])!;
  assert.equal(t.order, null);
  assert.equal("order" in (cableReportBlock(t) as any), false);
  assert.equal("order" in (cableTables(t) as any), false);
  assert.equal("order" in (cableLegend(t, BOX_CONDITIONS, { fmtLen: (v: number) => `${v}` }) as any), false);
  // a corrupt size (0, negative, a string) reads as not stated: same bytes
  for (const bad of [0, -1000, "1000"]) {
    const conds = BOX_CONDITIONS.map((c: any) => (c.cable_setup ? { ...c, cable_setup: { ...c.cable_setup, package_ft: bad } } : c));
    assert.deepEqual(hashes(boxOutputs(conds)), BASE, `package_ft ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(cableOrderRollup({ by_cable_type: [] }, BOX_CONDITIONS), { rows: [], warnings: [] });
});

test("package_ft round-trips through the takeoff document and the importer", () => {
  const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A", package_ft: 1000 }) });
  const { shapes, runs } = devices("c-data", [357]);
  const doc = buildTakeoffDocument({ project_name: "Invented job", sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }], conditions: [DATA, TR, ROUTE], shapes: [count("tr", "c-tr"), ...shapes], cable_runs: runs, sheet_tabs: ["a.pdf"] });
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(JSON.stringify(doc)), ["a.pdf"]);
  assert.equal(payload.conditions[0].cable_setup.package_ft, 1000);
  const t = computeCableTakeoff(payload.conditions, payload.shapes, sanitizeCableRuns(payload.cable_runs))!;
  assert.deepEqual([orderRow(t, "CAT6A").order_lf, orderRow(t, "CAT6A").boxes], [448, 1]);
  // a setup that never stated one writes no key at all
  const plain = { ...DATA, cable_setup: mintCableSetup("wall_outlet", { cable_type: "CAT6A" }) };
  assert.equal(JSON.stringify(buildTakeoffDocument({ conditions: [plain, TR, ROUTE], shapes, cable_runs: runs })).includes("package_ft"), false);
});
