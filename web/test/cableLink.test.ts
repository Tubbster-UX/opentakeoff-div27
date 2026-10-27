// The Link Run tool's pure click logic (lib/cableLink.js) and the cable run
// commands the canvas puts on its undo stack (lib/cable.js
// applyCableRunCommand). Fixtures are invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_LINK, linkRole, linkClick, linkUndoPick, linkReadout } from "../src/lib/cableLink.js";
import { mintCableSetup, mintCableRun, applyCableRunCommand } from "../src/lib/cable.js";

const cond = (id: string, tag: string, extra: any = {}) => ({ id, finish_tag: tag, multiplier: 1, waste_pct: 12, materials: [], ...extra });
const count = (id: string, condId: string, extra: any = {}) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, ...extra });
const line = (id: string, condId: string, lf: number) => ({ id, sheet_id: "a.pdf", condition_id: condId, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.2, 0.1]], computed: { area_sf: 0, perimeter_lf: lf } });
const WALL = cond("c-wall", "DATA-1", { cable_setup: mintCableSetup("wall_outlet", { cables_per_location: 2 }) });
const DOOR = cond("c-door", "ACS-1", { cable_setup: mintCableSetup("access_door") });
const TR = cond("c-tr", "TR", { role: "tr" });
const ROUTE = cond("c-route", "ROUTE", { role: "route" });
const FLOOR = cond("c-floor", "VCT-1");
const CONDS = [WALL, DOOR, TR, ROUTE, FLOOR];
const SHAPES = [
  count("dev-1", "c-wall"), count("dev-2", "c-wall"), count("door-1", "c-door"),
  count("tr-1", "c-tr", { label: "MDF" }),
  line("rt-1", "c-route", 50), line("rt-2", "c-route", 37.5),
  { id: "room", sheet_id: "a.pdf", condition_id: "c-floor", measure_role: "floor_area", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 100 } },
];
const S = (id: string) => SHAPES.find((s) => s.id === id)!;
const ctx = { conditions: CONDS, runs: [] as any[] };

test("linkRole: device, TR, route or nothing", () => {
  const byId = new Map(CONDS.map((c) => [c.id, c]));
  assert.equal(linkRole(S("dev-1"), byId), "device");
  assert.equal(linkRole(S("tr-1"), byId), "tr");
  assert.equal(linkRole(S("rt-1"), byId), "route");
  assert.equal(linkRole(S("room"), byId), null);
  assert.equal(linkRole(count("x", "c-floor"), byId), null, "a count on a plain condition is neither");
});

test("the click sequence: device, segments in order, TR — with the messages the bar shows", () => {
  let st = linkClick(EMPTY_LINK, [S("rt-1")], ctx);
  assert.deepEqual(st.draft, EMPTY_LINK);
  assert.match(st.msg, /starts at a device marker/);
  st = linkClick(st.draft, [S("dev-1")], ctx);
  assert.deepEqual(st.draft, { device: "dev-1", routes: [], tr: null });
  assert.match(st.msg, /Device DATA-1 picked/);
  st = linkClick(st.draft, [S("rt-1")], ctx);
  st = linkClick(st.draft, [S("rt-2")], ctx);
  assert.deepEqual(st.draft.routes, ["rt-1", "rt-2"]);
  assert.match(st.msg, /Segment 2 added/);
  // a TR marker sitting on the route's end: with segments picked, the TR wins
  st = linkClick(st.draft, [S("tr-1"), S("rt-2")], ctx);
  assert.deepEqual(st.draft, { device: "dev-1", routes: ["rt-1", "rt-2"], tr: "tr-1" });
  assert.match(st.msg, /TR MDF picked — press Enter/);
});

test("clicking the newest segment again takes it back; an earlier one is refused; a non-run shape is explained", () => {
  let d = { device: "dev-1", routes: ["rt-1", "rt-2"], tr: null };
  let st = linkClick(d, [S("rt-2")], ctx);
  assert.deepEqual(st.draft.routes, ["rt-1"]);
  st = linkClick({ ...d }, [S("rt-1")], ctx);
  assert.deepEqual(st.draft.routes, ["rt-1", "rt-2"]);
  assert.match(st.msg, /already in this run/);
  st = linkClick(d, [S("room")], ctx);
  assert.match(st.msg, /not part of a run/);
  st = linkClick(d, [], ctx);
  assert.match(st.msg, /Enter links the run/);
  // before any segment, a lone route under the TR is taken as the route
  st = linkClick({ device: "dev-1", routes: [], tr: null }, [S("tr-1"), S("rt-1")], ctx);
  assert.deepEqual(st.draft.routes, ["rt-1"]);
});

test("another device restarts the draft; an already-linked device is refused (one pull per location)", () => {
  const st = linkClick({ device: "dev-1", routes: ["rt-1"], tr: null }, [S("dev-2")], ctx);
  assert.deepEqual(st.draft, { device: "dev-2", routes: [], tr: null });
  const runs = [{ ...mintCableRun({ device_shape_ids: ["dev-1"], route_shape_ids: ["rt-1"], tr_id: "tr-1" }), id: "run-9" }];
  const r = linkClick(EMPTY_LINK, [S("dev-1")], { conditions: CONDS, runs });
  assert.deepEqual(r.draft, EMPTY_LINK);
  assert.match(r.msg, /already linked by run run-9/);
});

test("Backspace takes back the TR, then the newest segment, then the device", () => {
  let d: any = { device: "dev-1", routes: ["rt-1", "rt-2"], tr: "tr-1" };
  d = linkUndoPick(d); assert.deepEqual(d, { device: "dev-1", routes: ["rt-1", "rt-2"], tr: null });
  d = linkUndoPick(d); assert.deepEqual(d.routes, ["rt-1"]);
  d = linkUndoPick(d); assert.deepEqual(d.routes, []);
  d = linkUndoPick(d); assert.deepEqual(d, EMPTY_LINK);
});

test("the live readout: route LF and per-cable LF before commit, from the measured shapes only", () => {
  const rc = { conditions: CONDS, shapes: SHAPES, runs: [], uppFor: () => 0.05 };
  const partial = linkReadout({ device: "dev-1", routes: ["rt-1", "rt-2"], tr: null }, rc);
  assert.deepEqual({ stage: partial.stage, dev: partial.device, n: partial.segments, route: partial.route_lf, per: partial.per_cable_lf, cables: partial.cables, loc: partial.location_lf, refusal: partial.refusal },
    { stage: "tr", dev: "DATA-1", n: 2, route: 87.5, per: 130.5, cables: 2, loc: 261, refusal: null });
  const ready = linkReadout({ device: "dev-1", routes: ["rt-1", "rt-2"], tr: "tr-1" }, rc);
  assert.deepEqual({ stage: ready.stage, tr: ready.tr, per: ready.per_cable_lf, refusal: ready.refusal }, { stage: "ready", tr: "MDF", per: 130.5, refusal: null });
  // an access-control door with no vertical: no per-cable figure, and the refusal Enter would hit
  const door = linkReadout({ device: "door-1", routes: ["rt-1"], tr: "tr-1" }, rc);
  assert.equal(door.per_cable_lf, null);
  assert.match(door.refusal!, /ACS-1: vertical_ft is required/);
  // an unscaled sheet refuses at Enter, nothing estimated
  const unscaled = linkReadout({ device: "dev-1", routes: ["rt-1"], tr: "tr-1" }, { ...rc, uppFor: () => null });
  assert.match(unscaled.refusal!, /has no scale/);
  assert.deepEqual(linkReadout(EMPTY_LINK, rc).stage, "device");
});

test("applyCableRunCommand: link / unlink / restore with exact inverses — undo then redo lands the same array", () => {
  const run = { ...mintCableRun({ device_shape_ids: ["dev-1"], route_shape_ids: ["rt-1"], tr_id: "tr-1" }), id: "run-a" };
  const other = { ...mintCableRun({ device_shape_ids: ["dev-2"], route_shape_ids: ["rt-2"], tr_id: "tr-1" }), id: "run-b" };
  const linked = applyCableRunCommand([other], { type: "link", run });
  assert.deepEqual(linked.runs.map((r: any) => r.id), ["run-b", "run-a"]);
  assert.deepEqual(linked.inverse, { type: "unlink", id: "run-a" });
  const undone = applyCableRunCommand(linked.runs, linked.inverse);
  assert.deepEqual(undone.runs.map((r: any) => r.id), ["run-b"]);
  const redone = applyCableRunCommand(undone.runs, undone.inverse);
  assert.deepEqual(redone.runs, linked.runs, "the restore re-seats the record verbatim at its index");
  // unlink from the middle restores to the same index
  const three = [other, run, { ...other, id: "run-c" }];
  const u = applyCableRunCommand(three, { type: "unlink", id: "run-a" });
  assert.deepEqual(applyCableRunCommand(u.runs, u.inverse).runs, three);
  // no-ops record nothing
  assert.equal(applyCableRunCommand(three, { type: "unlink", id: "nope" }).inverse, null);
  assert.equal(applyCableRunCommand(three, { type: "link", run }).inverse, null, "a duplicate id is not linked twice");
  assert.equal(applyCableRunCommand(three, { type: "bogus" }).inverse, null);
});

test("applyCableRunCommand review: pending runs are accepted with a timestamp, accepted ones untouched; undo restores the prior provenance verbatim", () => {
  const pending = { ...mintCableRun({ device_shape_ids: ["d"], route_shape_ids: ["r"], tr_id: "t", provenance: { actor: "agent", created_at: "2026-10-27T00:00:00.000Z" } }), id: "run-p" };
  const human = { ...mintCableRun({ device_shape_ids: ["d2"], route_shape_ids: ["r"], tr_id: "t" }), id: "run-h" };
  const res = applyCableRunCommand([pending, human], { type: "review", ids: ["run-p", "run-h"], ts: "2026-10-27T01:00:00.000Z" });
  assert.deepEqual(res.runs[0].provenance, { method: "manual", actor: "agent", reviewed: true, created_at: "2026-10-27T00:00:00.000Z", accepted_ts: "2026-10-27T01:00:00.000Z" });
  assert.equal(res.runs[1], human, "a human run is not touched");
  const back = applyCableRunCommand(res.runs, res.inverse);
  assert.deepEqual(back.runs, [pending, human]);
  assert.equal(applyCableRunCommand([human], { type: "review", ids: ["run-h"] }).inverse, null);
});
