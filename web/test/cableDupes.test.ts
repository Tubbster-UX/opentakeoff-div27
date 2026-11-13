// The duplicate device check (web/src/lib/cableDupes.js, CABLE_SETUP_PLAN.md
// §14.3): the same devices counted twice, on one sheet (two markers on one
// symbol) or across overlay plans (a comms plan and a security plan of one
// floor, at one page size). Exact findings and warnings; and the rule that a
// check never changes a count. Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCableDuplicates, hasDuplicateFindings, SAME_SHEET_DUP_FT, SAME_SHEET_DUP_NORM, PAGE_SIZE_TOL, OVERLAY_POS_TOL,
  OVERLAY_MIN_POSITIONS, OVERLAY_MIN_SHARE,
} from "../src/lib/cableDupes.js";
import { mintCableSetup, computeCableTakeoff, cableReportBlock } from "../src/lib/cable.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const mark = (id: string, condId: string, sheet: string, x: number, y: number) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [[x, y]], computed: { count: 1 } });

// a 36 × 24 in (ARCH D) sheet at RENDER_SCALE 2 is 5184 × 3456 image px;
// at 1/8" = 1'-0" one foot is 9 pt = 18 px, so 1/18 ft per px
const ARCH_D = { w: 5184, h: 3456 };
const ANSI_D = { w: 4896, h: 3168 };   // 34 × 22 in
const UPP = 1 / 18;
const LABEL: Record<string, string> = { T31: "T3.1", T41: "T4.1" };
const opts = (sizes: Record<string, any> = { T31: ARCH_D, T41: ARCH_D }, upp: Record<string, number | null> = { T31: UPP, T41: UPP }) => ({
  sheetSize: (k: string) => sizes[k] ?? null,
  uppFor: (k: string) => upp[k] ?? null,
  sheetLabel: (k: string) => LABEL[k] ?? k,
});

const CAM = cond("c-cam", "CAM-1", { cable_setup: mintCableSetup("camera", { cable_type: "CAT6" }) });
const CCTV = cond("c-cctv", "CCTV-1", { cable_setup: mintCableSetup("camera", { cable_type: "CAT6" }) });
const DATA = cond("c-data", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2, cable_type: "CAT6A" }) });
const REF = cond("c-ref", "CAM-REF");   // a non-cable reference condition
const CONDS = [CAM, CCTV, DATA, REF];

/** n positions on a loose grid — far apart on one sheet (≥ 0.1 of the width). */
const grid = (n: number) => Array.from({ length: n }, (_, i) => [0.1 + (i % 7) * 0.1, 0.2 + Math.floor(i / 7) * 0.3] as [number, number]);
const set = (prefix: string, condId: string, sheet: string, pts: [number, number][], dx = 0, dy = 0) =>
  pts.map(([x, y], i) => mark(`${prefix}${i + 1}`, condId, sheet, x + dx, y + dy));

test("thresholds are the named, documented constants", () => {
  assert.deepEqual([SAME_SHEET_DUP_FT, SAME_SHEET_DUP_NORM, PAGE_SIZE_TOL, OVERLAY_POS_TOL, OVERLAY_MIN_POSITIONS, OVERLAY_MIN_SHARE], [1, 0.0035, 0.01, 0.0075, 3, 0.5]);
});

test("overlay plans: 14 cameras at one position on two equal-size sheets → one group of 14, one warning, counts unchanged", () => {
  const pts = grid(14);
  const shapes = [
    ...set("a", "c-cam", "T31", pts),
    // 20 data outlets on the comms plan too, elsewhere: the share is per condition, so they do not hide the cameras
    ...set("d", "c-data", "T31", grid(20), 0.05, 0.1),
    ...set("b", "c-cam", "T41", pts, 0.002, -0.001),
  ];
  const d = findCableDuplicates(CONDS, shapes, opts());
  assert.equal(d.same_sheet.length, 0);
  assert.equal(d.cross_sheet.length, 1);
  const x = d.cross_sheet[0];
  assert.deepEqual({ a: x.sheet_a, b: x.sheet_b, positions: x.positions, groups: x.groups.length, below: x.below_pattern }, { a: "T3.1", b: "T4.1", positions: 14, groups: 1, below: undefined });
  const g = x.groups[0];
  assert.deepEqual({ ta: g.finish_tag_a, tb: g.finish_tag_b, count: g.count, diff: g.different_conditions, off: g.max_offset }, { ta: "CAM-1", tb: "CAM-1", count: 14, diff: false, off: 0.0021 });
  assert.deepEqual(g.pairs.slice(0, 2), [["a1", "b1"], ["a2", "b2"]]);
  assert.deepEqual(d.warnings, [
    "T3.1 and T4.1 share 14 device positions: CAM-1 on T3.1 ↔ CAM-1 on T4.1 (14). The same devices look drawn on both sheets (overlay plans), so their pulls, cable LF and price count twice. If one sheet shows them for reference only, move that sheet's markers to a non-cable reference condition; if they are separate devices, leave them. Nothing was changed.",
  ]);
  assert.equal(d.count, 1);
  // wired through the cable takeoff: the warning joins the cable warnings, no count moves
  const t = computeCableTakeoff(CONDS, shapes, [], opts())!;
  assert.equal(t.duplicates!.cross_sheet[0].positions, 14);
  assert.ok(t.summary.warnings.includes(d.warnings[0]));
  assert.equal(t.summary.totals.ea, 48, "14 + 20 + 14 markers — every one still counted");
  assert.equal(shapes.length, 48, "nothing removed");
  assert.deepEqual(cableReportBlock(t)!.duplicates.cross_sheet[0].positions, 14);
});

test("offsets: inside the position tolerance coincide, just outside do not", () => {
  const pts = grid(3);
  const inside = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("b", "c-cam", "T41", pts, 0.007, 0)], opts());
  assert.equal(inside.cross_sheet.length, 1);
  assert.equal(inside.cross_sheet[0].positions, 3);
  const outside = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("b", "c-cam", "T41", pts, 0.008, 0)], opts());
  assert.deepEqual([outside.cross_sheet, outside.warnings], [[], []]);
  // the tolerance is a fraction of the LONG edge: 0.007 down the short side is 0.0047 of the long edge → still coincides
  const tall = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("b", "c-cam", "T41", pts, 0, 0.011)], opts());
  assert.equal(tall.cross_sheet.length, 1, "0.011 of the height = 0.0073 of the width");
});

test("different page sizes are never paired; a size within 1% is", () => {
  const pts = grid(14);
  const shapes = [...set("a", "c-cam", "T31", pts), ...set("b", "c-cam", "T41", pts)];
  assert.deepEqual(findCableDuplicates(CONDS, shapes, opts({ T31: ARCH_D, T41: ANSI_D })).cross_sheet, []);
  assert.deepEqual(findCableDuplicates(CONDS, shapes, opts({ T31: ARCH_D, T41: { w: ARCH_D.h, h: ARCH_D.w } })).cross_sheet, [], "rotated is not a match");
  assert.equal(findCableDuplicates(CONDS, shapes, opts({ T31: ARCH_D, T41: { w: 5200, h: 3460 } })).cross_sheet.length, 1);
  // a sheet whose page size this surface does not know is not compared, and says so
  const unknown = findCableDuplicates(CONDS, shapes, opts({ T31: ARCH_D }));
  assert.deepEqual(unknown.cross_sheet, []);
  assert.deepEqual(unknown.not_compared, [{ sheet_id: "T41", sheet: "T4.1", reason: "page size not known on this surface — not compared with other sheets" }]);
  // two scales that disagree (an enlarged plan on the same page) are not overlay plans
  assert.deepEqual(findCableDuplicates(CONDS, shapes, opts(undefined, { T31: UPP, T41: UPP / 2 })).cross_sheet, []);
  assert.equal(findCableDuplicates(CONDS, shapes, opts(undefined, { T31: UPP, T41: null })).cross_sheet.length, 1, "a sheet with no scale does not block it");
});

test("pattern threshold: 2 coinciding markers are chance, not a pattern; 3 of 10 is under half the smaller set", () => {
  const two = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", grid(2)), ...set("b", "c-cam", "T41", grid(2))], opts());
  assert.deepEqual([two.cross_sheet, two.warnings, two.count], [[], [], 0]);
  // 10 cameras on each sheet, only 3 at one position
  const a = set("a", "c-cam", "T31", grid(10));
  const b = [...set("b", "c-cam", "T41", grid(3)), ...set("c", "c-cam", "T41", grid(7), 0.05, 0.12)];
  assert.deepEqual(findCableDuplicates(CONDS, [...a, ...b], opts()).cross_sheet, []);
  // 5 of 10 is half → reported
  const b5 = [...set("b", "c-cam", "T41", grid(5)), ...set("c", "c-cam", "T41", grid(5), 0.05, 0.12)];
  assert.equal(findCableDuplicates(CONDS, [...a, ...b5], opts()).cross_sheet[0].positions, 5);
});

test("coinciding markers on DIFFERENT cable conditions are flagged as such", () => {
  const pts = grid(4);
  const d = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("b", "c-cctv", "T41", pts)], opts());
  assert.equal(d.cross_sheet[0].groups[0].different_conditions, true);
  assert.equal(d.warnings[0], "T3.1 and T4.1 share 4 device positions: CAM-1 on T3.1 ↔ CCTV-1 on T4.1 (4). The same devices look drawn on both sheets (overlay plans), so their pulls, cable LF and price count twice. CAM-1 ↔ CCTV-1 is a pair of different cable conditions: two setups figure the same devices. If one sheet shows them for reference only, move that sheet's markers to a non-cable reference condition; if they are separate devices, leave them. Nothing was changed.");
});

test("one side on a non-cable condition: not a warning — listed under reference only", () => {
  const pts = grid(14);
  const d = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("b", "c-ref", "T41", pts)], opts());
  assert.deepEqual([d.cross_sheet, d.warnings, d.count], [[], [], 0]);
  assert.equal(d.reference.length, 1);
  assert.deepEqual({ a: d.reference[0].sheet_a, b: d.reference[0].sheet_b, tag: d.reference[0].groups[0].finish_tag_b, n: d.reference[0].groups[0].count, side: d.reference[0].groups[0].cable_side },
    { a: "T3.1", b: "T4.1", tag: "CAM-REF", n: 14, side: "a" });
  assert.equal(hasDuplicateFindings(d), true, "the report block still carries the detail");
  // a cable ↔ cable match takes priority over a reference marker at the same spot
  const both = findCableDuplicates(CONDS, [...set("a", "c-cam", "T31", pts), ...set("r", "c-ref", "T41", pts), ...set("b", "c-cam", "T41", pts, 0.003, 0)], opts());
  assert.equal(both.cross_sheet[0].positions, 14);
  assert.deepEqual(both.reference, []);
});

test("same sheet: two markers 0.5 ft apart are flagged in feet; 3 ft apart are not", () => {
  const near = [mark("m1", "c-data", "T31", 0.5, 0.5), mark("m2", "c-data", "T31", 0.5 + 9 / ARCH_D.w, 0.5)];   // 9 px = 0.5 ft
  const d = findCableDuplicates(CONDS, near, opts());
  assert.deepEqual(d.same_sheet, [{ sheet_id: "T31", sheet: "T3.1", shape_ids: ["m1", "m2"], finish_tags: ["DATA-1", "DATA-1"], condition_ids: ["c-data"], same_condition: true, distance: 0.5, basis: "ft", threshold: 1 }]);
  assert.deepEqual(d.warnings, ["T3.1: 1 position holds two or more device markers on cable conditions within 1 ft of each other — DATA-1 ×2. One device marked twice (a symbol sweep plus a click) doubles its pull and cable LF. Check each and remove an extra marker only once a person confirms it; this check never removes one."]);
  const far = [mark("m1", "c-data", "T31", 0.5, 0.5), mark("m2", "c-data", "T31", 0.5 + 54 / ARCH_D.w, 0.5)];   // 54 px = 3 ft
  assert.deepEqual(findCableDuplicates(CONDS, far, opts()).same_sheet, []);
  // three stacked on one symbol are ONE finding; a camera and an outlet on one spot read "CAM-1 + DATA-1"
  const three = [mark("m1", "c-data", "T31", 0.5, 0.5), mark("m2", "c-data", "T31", 0.5001, 0.5), mark("m3", "c-cam", "T31", 0.5002, 0.5)];
  const t3 = findCableDuplicates(CONDS, three, opts());
  assert.deepEqual(t3.same_sheet.map((f) => [f.shape_ids, f.same_condition]), [[["m1", "m2", "m3"], false]]);
  assert.match(t3.warnings[0], /— DATA-1 \+ CAM-1\./);
});

test("same sheet with no scale: the sheet-fraction fallback, and it says so", () => {
  const pair = (dx: number) => [mark("m1", "c-data", "T31", 0.5, 0.5), mark("m2", "c-data", "T31", 0.5 + dx, 0.5)];
  const d = findCableDuplicates(CONDS, pair(0.003), opts(undefined, {}));
  assert.deepEqual([d.same_sheet[0].basis, d.same_sheet[0].distance, d.same_sheet[0].threshold], ["sheet_fraction", 0.003, 0.0035]);
  assert.match(d.warnings[0], /within 0\.35% of the sheet \(no scale known for it, so not in feet\)/);
  assert.deepEqual(findCableDuplicates(CONDS, pair(0.004), opts(undefined, {})).same_sheet, []);
  // no page size either: the normalized square, worded so
  assert.match(findCableDuplicates(CONDS, pair(0.003), opts({}, {})).warnings[0], /no scale or page size known/);
});

test("non-cable markers never make a same-sheet finding; no cable conditions → nothing at all", () => {
  const ref = [mark("m1", "c-ref", "T31", 0.5, 0.5), mark("m2", "c-ref", "T31", 0.5, 0.5)];
  assert.deepEqual(findCableDuplicates(CONDS, ref, opts()).same_sheet, []);
  const plain = [cond("c-x", "X"), cond("c-y", "Y")];
  const shapes = [...set("a", "c-x", "T31", grid(14)), ...set("b", "c-y", "T41", grid(14)), mark("z", "c-x", "T31", 0.1, 0.2)];
  const d = findCableDuplicates(plain, shapes, opts());
  assert.deepEqual([d.same_sheet, d.cross_sheet, d.reference, d.not_compared, d.warnings, d.count], [[], [], [], [], [], 0]);
  assert.equal(computeCableTakeoff(plain, shapes, [], opts()), null, "no cable takeoff, no check, no output");
});

test("the check runs only when the caller supplies page geometry; a report with no finding is unchanged", () => {
  const shapes = [...set("a", "c-cam", "T31", grid(14)), ...set("b", "c-cam", "T41", grid(14))];
  const without = computeCableTakeoff(CONDS, shapes, [], { sheetLabel: (k: string) => LABEL[k] })!;
  assert.equal(without.duplicates, null);
  assert.equal(without.summary.warnings.length, 0);
  assert.equal("duplicates" in cableReportBlock(without)!, false);
  const clean = computeCableTakeoff(CONDS, set("a", "c-cam", "T31", grid(14)), [], opts())!;
  assert.equal(clean.duplicates!.count, 0);
  assert.equal("duplicates" in cableReportBlock(clean)!, false);
});
