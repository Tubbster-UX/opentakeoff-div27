// Division 27 follow-ups from the first real bid (docs/design/CABLE_SETUP_PLAN.md
// §12): the six issues that bid surfaced, each pinned with exact values.
//   1. by-TR subtotals sum to the totals (a condition with no run was dropped)
//   2. the runs sheet names the device and TR sheets, not just the route's
//   3. a route on an agent-set, unconfirmed scale is flagged and warned
//   4. a HOLD records why devices deliberately get no run
//   5. a run past 295 ft per cable (TIA-568 copper) is flagged and warned
//   6. device-type aliases ("access_control") read as the canonical type
// Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintCableSetup, mintCableRun, mintCableHold, isCableHold, holdRefusal, sanitizeCableRuns, resolveCableRuns,
  computeCableTakeoff, cableReportBlock, cableTables, linkRunRefusal, applyCableRunCommand,
  normalizeDeviceType, DEVICE_TYPE_ALIASES, DEVICE_TYPES, TIA_MAX_LINK_FT,
} from "../src/lib/cable.js";
import { linkClick } from "../src/lib/cableLink.js";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, color: "#2563eb", fill: "#2563eb", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [], ...extra });
const count = (id: string, condId: string, sheet = "comm.pdf", extra: any = {}) => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number, sheet = "rcp.pdf") => ({ id, sheet_id: sheet, condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });

// devices on the comms plan, pathway traced on the ceiling plan — the bid's layout
const DATA = cond("c-data", "DATA-1", { waste_pct: 12, cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 4, cable_type: "CAT6A", vertical_ft: 9, loop_device_ft: 3, loop_tr_ft: 26 }) });
const CAM = cond("c-cam", "CAM-1", { waste_pct: 12, cable_setup: mintCableSetup("camera", { cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 1, loop_device_ft: 15, loop_tr_ft: 26 }) });
const CEIL = cond("c-ceil", "CEIL-1", { waste_pct: 12, cable_setup: mintCableSetup("ceiling_other", { cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 0, loop_device_ft: 3, loop_tr_ft: 26 }) });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
const CONDS = [DATA, CAM, CEIL, TR, ROUTE];
const SHAPES = [
  count("tr-mdf", "c-tr", "comm.pdf", { label: "MDF" }),
  count("d1", "c-data"), count("d2", "c-data"), count("cam1", "c-cam"), count("cam2", "c-cam"),
  count("ceil1", "c-ceil"), count("ceil2", "c-ceil"), count("ceil3", "c-ceil"),
  line("r-d1", "c-route", 16.57), line("r-cam1", "c-route", 258.05), line("r-cam2", "c-route", 253),
];
const run = (id: string, dev: string, route: string) => ({ ...mintCableRun({ device_shape_ids: [dev], route_shape_ids: [route], tr_id: "tr-mdf" }), id });
const RUNS = [run("run-d1", "d1", "r-d1"), run("run-cam1", "cam1", "r-cam1"), run("run-cam2", "cam2", "r-cam2")];
const SUM_KEYS = ["ea", "pulls", "cables", "route_lf", "cable_lf", "cable_lf_order", "unlinked_devices", "held_devices", "pending_runs", "over_length_runs"];
const sumOf = (rows: any[], k: string) => Math.round(rows.reduce((t, r) => t + (r[k] || 0), 0) * 100) / 100;

test("1. by-TR subtotals sum to the totals: a cable condition with no linked run sits in the no-TR group", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, RUNS)!;
  const { totals, by_tr } = t.summary;
  assert.equal(totals.ea, 7);
  assert.equal(totals.pulls, 3);
  for (const k of SUM_KEYS) assert.equal(sumOf(by_tr, k), totals[k], `by_tr ${k} sums to the total`);
  const noTr = by_tr.find((g: any) => g.tr_id === "");
  assert.ok(noTr, "the no-run condition is not filtered away");
  assert.deepEqual({ ea: noTr.ea, pulls: noTr.pulls, unlinked: noTr.unlinked_devices, name: noTr.tr_name }, { ea: 3, pulls: 0, unlinked: 3, name: "" });
  const tables = cableTables(t)!;
  const sub = tables.summary.filter((r: any[]) => r[0] === "Subtotal by TR");
  assert.deepEqual(sub.map((r: any[]) => r[3]), ["MDF", "(no TR — no linked run)"]);
  assert.equal(sub.reduce((n: number, r: any[]) => n + r[6], 0), 7, "Device EA subtotals add to 7");
});

test("2. the runs sheet names the device sheet and the TR sheet beside the route sheet(s)", () => {
  const t = computeCableTakeoff(CONDS, SHAPES, RUNS)!;
  const label = (k: string) => ({ "comm.pdf": "T3.1", "rcp.pdf": "T2.1" } as any)[k] || k;
  const block: any = cableReportBlock(t, label);
  const r = block.runs.find((x: any) => x.run_id === "run-d1");
  assert.deepEqual({ device: r.device_sheets, route: r.sheets, tr: r.tr_sheet }, { device: "T3.1", route: "T2.1", tr: "T3.1" });
  assert.deepEqual(r.device_sheet_ids, ["comm.pdf"]);
  const row = cableTables(t, { sheetLabel: label })!.runs.find((x: any[]) => x[0] === "run-d1")!;
  assert.deepEqual(row.slice(5, 8), ["T3.1", "T2.1", "T3.1"]);
  // the bid's sample run, exact: 16.57 + 9 + 3 + 26 = 54.57 per cable × 4 = 218.28
  assert.deepEqual([r.per_cable_lf, r.cables, r.location_lf], [54.57, 4, 218.28]);
});

test("3. a route on an agent-set scale no person confirmed: still counted, flagged per run, one warning naming the sheet", () => {
  const opts = { scaleUnconfirmed: (k: string) => k === "rcp.pdf", sheetLabel: (k: string) => (k === "rcp.pdf" ? "T2.1" : k) };
  const t = computeCableTakeoff(CONDS, SHAPES, RUNS, opts)!;
  assert.equal(t.summary.totals.pulls, 3, "the flag never withholds a run");
  const r = t.resolved.runs.find((x: any) => x.id === "run-d1");
  assert.equal(r.scale_unconfirmed, true);
  assert.ok(r.notes.some((n: string) => n === "route scale on T2.1 not confirmed by a person"), r.notes);
  const w = t.summary.warnings.filter((x: string) => /no person has confirmed/.test(x));
  assert.equal(w.length, 1);
  assert.match(w[0], /^3 linked runs take route length from a sheet whose scale no person has confirmed \(T2\.1\)/);
  const confirmed = computeCableTakeoff(CONDS, SHAPES, RUNS)!;
  assert.equal(confirmed.summary.warnings.some((x: string) => /confirmed/.test(x)), false, "a confirmed (or human-set) scale says nothing");
  assert.equal(confirmed.resolved.runs[0].scale_unconfirmed, undefined);
});

test("4. a hold: devices deliberately left without a run, listed as held with the reason, excluded from totals", () => {
  const hold = { ...mintCableHold({ device_shape_ids: ["ceil1", "ceil2", "ceil1"], reason: "Flag note 3 area — crawl-space routing not drawn", provenance: { actor: "agent" } }), id: "hold-1" };
  assert.equal(isCableHold(hold), true);
  assert.deepEqual(hold.device_shape_ids, ["ceil1", "ceil2"], "duplicates collapse");
  assert.equal(hold.provenance.reviewed, false, "an agent's hold lands pending, like an agent run");
  const t = computeCableTakeoff(CONDS, SHAPES, [...RUNS, hold])!;
  assert.equal(t.resolved.runs.length, 3, "a hold is not a run");
  assert.deepEqual(t.resolved.held.map((d: any) => [d.shape_id, d.hold_id, d.reason]), [
    ["ceil1", "hold-1", "Flag note 3 area — crawl-space routing not drawn"],
    ["ceil2", "hold-1", "Flag note 3 area — crawl-space routing not drawn"],
  ]);
  assert.deepEqual(t.resolved.unlinked.devices.map((d: any) => d.shape_id), ["d2", "ceil3"], "held devices leave the unlinked list");
  const ceil = t.summary.rows.find((r: any) => r.condition_id === "c-ceil");
  assert.deepEqual({ ea: ceil.ea, pulls: ceil.pulls, unlinked: ceil.unlinked_devices, held: ceil.held_devices, lf: ceil.cable_lf }, { ea: 3, pulls: 0, unlinked: 1, held: 2, lf: 0 });
  const tot = t.summary.totals;
  assert.equal(tot.ea - tot.pulls, tot.unlinked_devices + tot.held_devices, "the EA − pulls gap is exactly unlinked + held");
  assert.deepEqual(t.resolved.holds, [{ id: "hold-1", reason: "Flag note 3 area — crawl-space routing not drawn", device_shape_ids: ["ceil1", "ceil2"], held: 2, review: "pending", pending: true }]);
  const rows = cableTables(t)!.unlinked.filter((r: any[]) => r[0] === "held device");
  assert.deepEqual(rows[0], ["held device", "ceil1", "CEIL-1", "comm.pdf", "", "held (hold-1): Flag note 3 area — crawl-space routing not drawn"]);
  const block: any = cableReportBlock(t);
  assert.equal(block.held.length, 2);
  assert.equal(block.holds[0].id, "hold-1");
});

test("4. hold refusals, link refusal on a held device, and release by unlink with an exact inverse", () => {
  const hold = { ...mintCableHold({ device_shape_ids: ["ceil1"], reason: "by others" }), id: "hold-1" };
  const runs = [...RUNS, hold];
  assert.match(holdRefusal({ device_shape_ids: ["ceil2"], reason: "  " }, CONDS, SHAPES, runs)!, /needs a reason/);
  assert.match(holdRefusal({ device_shape_ids: [], reason: "x" }, CONDS, SHAPES, runs)!, /at least one device/);
  assert.match(holdRefusal({ device_shape_ids: ["nope"], reason: "x" }, CONDS, SHAPES, runs)!, /does not exist/);
  assert.match(holdRefusal({ device_shape_ids: ["tr-mdf"], reason: "x" }, CONDS, SHAPES, runs)!, /not a device marker/);
  assert.match(holdRefusal({ device_shape_ids: ["d1"], reason: "x" }, CONDS, SHAPES, runs)!, /linked by run run-d1/);
  assert.match(holdRefusal({ device_shape_ids: ["ceil1"], reason: "x" }, CONDS, SHAPES, runs)!, /already held by hold-1/);
  assert.equal(holdRefusal({ device_shape_ids: ["ceil2", "ceil3"], reason: "x" }, CONDS, SHAPES, runs), null);
  const shapes = [...SHAPES, line("r-ceil1", "c-route", 40)];
  assert.match(linkRunRefusal({ device_shape_ids: ["ceil1"], route_shape_ids: ["r-ceil1"], tr_id: "tr-mdf" }, CONDS, shapes, runs)!, /held by hold-1 \(by others\) — unlink_run the hold first/);
  const click = linkClick({ device: null, routes: [], tr: null }, [shapes.find((s) => s.id === "ceil1")], { conditions: CONDS, runs });
  assert.equal(click.draft.device, null);
  assert.match(click.msg, /held \(by others\) — release the hold/);
  // release = the run family's unlink; undo re-seats it verbatim
  const rel = applyCableRunCommand(runs, { type: "unlink", id: "hold-1" });
  assert.equal(rel.runs.some((r: any) => r.id === "hold-1"), false);
  assert.deepEqual(applyCableRunCommand(rel.runs, rel.inverse).runs, runs);
});

test("4. holds survive the load gate and the takeoff document round trip; a deleted held device warns, never vanishes silently", () => {
  const hold = { ...mintCableHold({ device_shape_ids: ["ceil1", "gone"], reason: "by others" }), id: "hold-1" };
  const clean = sanitizeCableRuns([...RUNS, hold, { ...hold, id: "hold-2", hold: { reason: 7 } }]);
  assert.equal(clean.length, 5);
  assert.deepEqual(clean[3].hold, { reason: "by others" });
  assert.deepEqual(clean[4].hold, { reason: "" }, "a non-string reason is blanked, the hold kept");
  const doc = buildTakeoffDocument({ ...emptyAnnotations(), conditions: CONDS, shapes: SHAPES, cable_runs: [...RUNS, hold] } as any);
  const back: any = parseTakeoffImport(JSON.stringify(doc));
  assert.deepEqual(back.cable_runs.at(-1), hold);
  const t = resolveCableRuns(CONDS, SHAPES, [hold]);
  assert.ok(t.warnings.some((w: string) => w === "Hold hold-1 names device gone, which no longer exists — the hold covers nothing there."), JSON.stringify(t.warnings));
  const blank = resolveCableRuns(CONDS, SHAPES, [clean[4]]);
  assert.equal(blank.held[0].reason, "(no reason given)");
});

test("5. a run past 295 ft per cable is counted, flagged on the run and the summary row, and warned once with the run named", () => {
  assert.equal(TIA_MAX_LINK_FT, 295);
  const t = computeCableTakeoff(CONDS, SHAPES, RUNS)!;
  const over = t.resolved.runs.find((r: any) => r.id === "run-cam1");
  const at = t.resolved.runs.find((r: any) => r.id === "run-cam2");
  assert.equal(over.per_cable_lf, 300.05, "258.05 + 1 + 15 + 26");
  assert.equal(over.over_length, true);
  assert.ok(over.notes.includes("per cable 300.05 ft exceeds 295 ft (TIA-568 copper permanent link, 90 m)"));
  assert.equal(at.per_cable_lf, 295);
  assert.equal(at.over_length, undefined, "exactly 295 ft is within the limit");
  assert.equal(t.summary.totals.pulls, 3, "the measured length is the truth: an over-length run still counts");
  const camRow = t.summary.rows.find((r: any) => r.condition_id === "c-cam");
  assert.equal(camRow.over_length_runs, 1);
  const w = t.summary.warnings.filter((x: string) => /TIA-568/.test(x));
  assert.equal(w.length, 1);
  assert.equal(w[0], "1 linked run exceeds 295 ft per cable, the TIA-568 limit for a 4-pair copper permanent link (90 m): CAM-1 run-cam1 300.05 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice. Fiber and coax are not bound by this limit.");
  const tbl = cableTables(t)!;
  assert.equal(tbl.summary[0][15], "Runs over 295 ft");
  const camLine = tbl.summary.find((r: any[]) => r[0] === "CAM-1")!;
  assert.equal(camLine[15], 1);
  assert.equal(camLine[16], "1 run over 295 ft per cable");
  const block: any = cableReportBlock(t);
  assert.equal(block.runs.find((r: any) => r.run_id === "run-cam1").over_length, true);
});

test("6. device-type aliases read as the canonical type; the stored set never grows", () => {
  assert.equal(normalizeDeviceType("access_control"), "access_door");
  assert.equal(normalizeDeviceType("Access Control"), "access_door");
  assert.equal(normalizeDeviceType("card-reader"), "access_door");
  assert.equal(normalizeDeviceType("wireless_access_point"), "wap");
  assert.equal(normalizeDeviceType("CCTV"), "camera");
  assert.equal(normalizeDeviceType("data_outlet"), "wall_outlet");
  assert.equal(normalizeDeviceType("speaker"), "ceiling_other");
  assert.equal(normalizeDeviceType("camera"), "camera");
  assert.equal(normalizeDeviceType("intercom"), null);
  assert.equal(normalizeDeviceType(undefined), null);
  for (const v of Object.values(DEVICE_TYPE_ALIASES)) assert.ok((DEVICE_TYPES as readonly string[]).includes(v), `${v} is canonical`);
  for (const k of Object.keys(DEVICE_TYPE_ALIASES)) assert.ok(!(DEVICE_TYPES as readonly string[]).includes(k), `${k} is not itself a stored type`);
});
