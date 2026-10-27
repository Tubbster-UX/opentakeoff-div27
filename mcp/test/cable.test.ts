// Division 27 cable runs over the wire (docs/design/CABLE_SETUP.md): the
// edit_condition cable_setup / role path, link_run with every refusal,
// list_runs, unlink_run + undo_last, the summary and report blocks, the
// export → import round trip with runs, and a run on a stitched sheet
// (which this session cannot scale) surviving import → export → import with
// its stored length intact and reported broken, never dropped or zeroed.
// Fixtures are the bundled demo plan plus invented shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { openPdf } from "../src/pdf.ts";
import { runShortIds } from "../../web/src/lib/cable.js";
import { cableMediumScenario } from "./fixtures/cableMediumScenario.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const UPP = 1 / 36; // 1/4" = 1'-0" at render scale 2.0 — 36 px per foot

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session(), { oneClick: false });
  await server.connect(st);
  const client = new Client({ name: "cable-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
}
interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}
const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(client, name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
  return r.data;
};
const refused = async (client: Client, name: string, args: Record<string, unknown>, re: RegExp) => {
  const r = await call(client, name, args);
  assert.equal(r.isError, true, `${name} should refuse: ${JSON.stringify(r.data)}`);
  assert.match(r.data.error, re);
  return r.data.error as string;
};

/** A worked session: scale set, a TR marker labeled MDF, two devices, two
 *  routes of exactly 87.5 ft and 140 ft (3150 px and 5040 px at 36 px/ft). */
async function worked() {
  const client = await pair();
  await ok(client, "load_plan", { path: PLAN });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  const tr = await ok(client, "place_count", { sheet: KEY, points: [[200, 200]], condition: "TR" });   // mints the TR condition
  await ok(client, "edit_condition", { condition: "TR", role: "tr" });
  await ok(client, "edit_shape", { shape_id: tr.shape_ids[0], label: "MDF" });
  const w = await ok(client, "place_count", { sheet: KEY, points: [[1000, 1000]], condition: "DATA-1" });
  const c = await ok(client, "place_count", { sheet: KEY, points: [[1400, 1000]], condition: "CAM-1" });
  await ok(client, "edit_condition", { condition: "DATA-1", waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  await ok(client, "edit_condition", { condition: "CAM-1", waste_pct: 12, cable_setup: { device_type: "camera", cable_type: "CAT6" } });
  const rw = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 300], [3350, 300]], condition: "ROUTE" });
  const rc = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 400], [5240, 400]], condition: "ROUTE" });
  await ok(client, "edit_condition", { condition: "ROUTE", role: "route" });
  assert.deepEqual([rw.length_lf, rc.length_lf], [87.5, 140]);
  return { client, tr: tr.shape_ids[0] as string, devW: w.shape_ids[0] as string, devC: c.shape_ids[0] as string, rtW: rw.shape_id as string, rtC: rc.shape_id as string };
}

test("edit_condition cable_setup: a fresh opt-in mints the type's starting values, same-type edits patch, a type change re-mints, null opts out, undo restores", async () => {
  const client = await pair();
  await ok(client, "load_plan", { path: PLAN });
  await ok(client, "place_count", { sheet: KEY, points: [[500, 500]], condition: "WAP-1" });
  await refused(client, "edit_condition", { condition: "WAP-1", cable_setup: { vertical_ft: 9 } }, /device_type is required on a fresh opt-in/);
  const on = await ok(client, "edit_condition", { condition: "WAP-1", cable_setup: { device_type: "wap" } });
  assert.deepEqual(on.cable_setup, { device_type: "wap", cables_per_location: 1, cable_type: "", vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10 });
  assert.equal(on.waste_pct, 0, "waste is never set silently — the 12% starting value is a canvas pre-fill");
  assert.deepEqual(on.cable.problems, []);
  assert.deepEqual(on.cable.rows, [{ condition_id: on.condition_id, finish_tag: "WAP-1", device_type: "wap", cable_type: "", tr_id: "", tr_name: "", multiplier: 1, waste_pct: 0, ea: 1, pulls: 0, cables: 0, route_lf: 0, cable_lf: 0, cable_lf_order: 0, unlinked_devices: 1, held_devices: 0, pending_runs: 0, over_length_runs: 0, leg_warning: false }]);
  // the minted-values caveat: every value this call did not state is named
  assert.deepEqual(on.cable.minted, { cables_per_location: 1, vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10 });
  assert.match(on.cable.note, /^starting values, not verified against spec/);
  const patched = await ok(client, "edit_condition", { condition: "WAP-1", cable_setup: { loop_device_ft: 25, cable_type: "CAT6A" } });
  assert.deepEqual({ v: patched.cable_setup.vertical_ft, l: patched.cable_setup.loop_device_ft, t: patched.cable_setup.cable_type }, { v: 13, l: 25, t: "CAT6A" });
  assert.equal(patched.cable.minted, undefined, "a same-type patch mints nothing");
  const door = await ok(client, "edit_condition", { condition: "WAP-1", cable_setup: { device_type: "access_door", loop_tr_ft: 12 } });
  assert.deepEqual({ v: door.cable_setup.vertical_ft, l: door.cable_setup.loop_device_ft, t: door.cable_setup.cable_type }, { v: null, l: 15, t: "" }, "a type change starts over from that type's values");
  assert.match(door.cable.problems[0], /vertical_ft is required/);
  assert.deepEqual(door.cable.minted, { cables_per_location: 1, loop_device_ft: 15 }, "the stated loop_tr_ft and the absent vertical are not minted");
  // an explicit call mints nothing and carries no caveat
  const explicit = await ok(client, "edit_condition", { condition: "WAP-1", cable_setup: { device_type: "custom", cables_per_location: 2, vertical_ft: 15, loop_device_ft: 5, loop_tr_ft: 5 } });
  assert.deepEqual({ minted: explicit.cable.minted, note: explicit.cable.note, problems: explicit.cable.problems }, { minted: undefined, note: undefined, problems: [] });
  const off = await ok(client, "edit_condition", { condition: "WAP-1", cable_setup: null });
  assert.equal(off.cable_setup, undefined);
  assert.equal(off.cable, undefined);
  await ok(client, "undo_last", { n: 1 });
  const back = await ok(client, "export_takeoff", {});
  assert.equal(back.conditions.find((c: any) => c.finish_tag === "WAP-1").cable_setup.device_type, "custom", "undo restores the setup verbatim");
  // role: set, echoed, cleared, undone; "route" is the other value
  const tr = await ok(client, "edit_condition", { condition: "WAP-1", role: "tr" });
  assert.equal(tr.role, "tr");
  assert.equal((await ok(client, "edit_condition", { condition: "WAP-1", role: "route" })).role, "route");
  const badRole: any = await client.callTool({ name: "edit_condition", arguments: { condition: "WAP-1", role: "pathway" } });
  assert.ok(badRole.isError && /MCP error -32602/.test(badRole.content[0].text), "an unknown role is a schema violation");
  await ok(client, "edit_condition", { condition: "WAP-1", role: "tr" });
  const cleared = await ok(client, "edit_condition", { condition: "WAP-1", role: null });
  assert.equal(cleared.role, undefined);
  await ok(client, "undo_last", { n: 1 });
  assert.equal((await ok(client, "export_takeoff", {})).conditions.find((c: any) => c.finish_tag === "WAP-1").role, "tr");
});

test("link_run: the spec's worked example over the wire — exact per-cable and location LF, pending, in totals; the report and summary carry it", async () => {
  const { client, tr, devW, devC, rtW, rtC } = await worked();
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  assert.deepEqual(
    { status: w.status, tr: w.tr, route: w.route_lf, v: w.vertical_ft, loops: [w.loop_device_ft, w.loop_tr_ft], per: w.per_cable_lf, cables: w.cables, loc: w.location_lf, reviewed: w.reviewed },
    { status: "linked", tr: "MDF", route: 87.5, v: 23, loops: [10, 10], per: 130.5, cables: 2, loc: 261, reviewed: false },
  );
  const c = await ok(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  assert.deepEqual({ per: c.per_cable_lf, loc: c.location_lf }, { per: 178, loc: 178 });

  const runs = await ok(client, "list_runs", {});
  assert.equal(runs.count, 2);
  assert.deepEqual(runs.runs.map((r: any) => [r.status, r.review]), [["linked", "pending"], ["linked", "pending"]]);
  assert.deepEqual(runs.unlinked, { devices: [], routes: [] });
  // set_scale over MCP lands UNCONFIRMED (the scale gate): the runs count,
  // each is flagged, and ONE warning names the sheet a person must confirm
  assert.deepEqual(runs.warnings, ["2 linked runs take route length from a sheet whose scale no person has confirmed (A-101). Every cable length there rests on that scale: confirm it in the canvas before pricing."]);
  assert.deepEqual(runs.runs.map((r: any) => r.scale_unconfirmed), [true, true]);
  assert.deepEqual(
    { pulls: runs.summary.totals.pulls, cables: runs.summary.totals.cables, net: runs.summary.totals.cable_lf, order: runs.summary.totals.cable_lf_order, pending: runs.summary.totals.pending_runs },
    { pulls: 2, cables: 3, net: 439, order: 491.68, pending: 2 },
  );
  assert.deepEqual(runs.summary.by_tr.map((g: any) => [g.tr_name, g.cables]), [["MDF", 3]]);
  assert.deepEqual(runs.summary.by_cable_type.map((g: any) => [g.cable_type, g.cable_lf]), [["CAT6A", 261], ["CAT6", 178]]);

  const sum = await ok(client, "takeoff_summary", {});
  assert.deepEqual({ pulls: sum.cable.totals.pulls, order: sum.cable.totals.cable_lf_order, ud: sum.cable.unlinked_devices }, { pulls: 2, order: 491.68, ud: 0 });
  const dataRow = sum.conditions.find((r: any) => r.finish_tag === "DATA-1");
  assert.equal(dataRow.ea, 1, "the device EA is the condition's own count — the cable figures ride beside it");

  const rep = await ok(client, "export_report", {});
  assert.equal(Object.keys(rep).at(-1), "cable", "the cable block appends last");
  assert.deepEqual({ pulls: rep.cable.totals.pulls, order: rep.cable.totals.cable_lf_order }, { pulls: 2, order: 491.68 });
  assert.equal(rep.cable.runs.length, 2);
  assert.deepEqual(rep.cable.runs.map((r: any) => [r.run_id, r.multiplier, r.review_status]), [[w.run_id, 1, "pending"], [c.run_id, 1, "pending"]]);
  assert.equal(rep.cable.runs[0].sheets, "A-101", "sheets print by title-block number");
  assert.equal(rep.roll_goods.length, 0, "the roll block is untouched");
});

test("link_run refusals: not a linear shape, unscaled sheet, missing vertical, not a TR marker, not a device marker, already linked, bad override — nothing minted", async () => {
  const { client, tr, devW, devC, rtW } = await worked();
  await refused(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [devC], tr_id: tr }, /is not a measured linear shape \(it is count\) — trace the route with measure_line/);
  await refused(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: devC }, /is not a TR marker .* role "tr"/);
  await refused(client, "link_run", { device_shape_ids: [rtW], route_shape_ids: [rtW], tr_id: tr }, /is not a count marker/);
  await refused(client, "link_run", { device_shape_ids: [tr], route_shape_ids: [rtW], tr_id: tr }, /condition TR has no cable setup — set cable_setup/);
  await refused(client, "link_run", { device_shape_ids: [devW], route_shape_ids: ["shp-nope"], tr_id: tr }, /route shape shp-nope does not exist — list_shapes/);
  const bad: any = await client.callTool({ name: "link_run", arguments: { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr, cables_override: 0 } });
  assert.ok(bad.isError && /MCP error -32602/.test(bad.content[0].text), "a zero override is a schema violation (int ≥ 1)");
  // a device condition missing its required value: withheld, with the next move
  await ok(client, "place_count", { sheet: KEY, points: [[1800, 1000]], condition: "ACS-1" });
  const d = await ok(client, "edit_condition", { condition: "ACS-1", cable_setup: { device_type: "access_door" } });
  const dev = (await ok(client, "list_shapes", { condition: "ACS-1" })).shapes[0].id;
  assert.match(d.cable.problems[0], /vertical_ft is required/);
  await refused(client, "link_run", { device_shape_ids: [dev], route_shape_ids: [rtW], tr_id: tr }, /ACS-1: vertical_ft is required[\s\S]*edit_condition[\s\S]*no length is ever assumed/);
  await ok(client, "edit_condition", { condition: "ACS-1", cable_setup: { vertical_ft: 18 } });
  const linked = await ok(client, "link_run", { device_shape_ids: [dev], route_shape_ids: [rtW], tr_id: tr });
  assert.equal(linked.per_cable_lf, 87.5 + 18 + 15 + 10);
  // one pull per location
  await refused(client, "link_run", { device_shape_ids: [dev], route_shape_ids: [rtW], tr_id: tr }, /already linked by run run-.* — unlink_run it first/);
  assert.equal((await ok(client, "list_runs", {})).count, 1, "every refusal minted nothing");
  // the scale gate: a route on a sheet this session has not scaled refuses with the engine's message
  const two = await pair();
  await ok(two, "load_plan", { path: PLAN });
  const payload = await ok(client, "export_takeoff", {});
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-"));
  const file = path.join(dir, "worked.json");
  await writeFile(file, JSON.stringify({ ...payload, sheets: [], cable_runs: [] }));   // the shapes without their scale
  await ok(two, "import_takeoff", { path: file });
  const ids = (await ok(two, "list_shapes", {})).shapes;
  const trId = ids.find((s: any) => s.condition === "TR").id, dw = ids.find((s: any) => s.condition === "DATA-1").id, rt = ids.find((s: any) => s.condition === "ROUTE").id;
  await refused(two, "link_run", { device_shape_ids: [dw], route_shape_ids: [rt], tr_id: trId }, /Set the scale for sample-plan\.pdf first — use set_scale/);
});

test("link_run vertical_ft: a run states its own vertical — an access_door with no vertical links, the reply and list_runs say so, a sibling keeps the condition's; a negative value refuses; round trip keeps it", async () => {
  const { client, tr, devW, rtW, rtC } = await worked();
  // the per-run override on a wall outlet at 23 ft: 87.5 + 9 + 10 + 10 = 116.5, ×2 = 233
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr, vertical_ft: 9 });
  assert.deepEqual({ v: w.vertical_ft, over: w.vertical_override, per: w.per_cable_lf, loc: w.location_lf }, { v: 9, over: 9, per: 116.5, loc: 233 });
  assert.equal(w.notes[0], "vertical 9 ft (run override; condition 23 ft)");
  // an access_door condition with no vertical: refused without one, linked with one
  await ok(client, "place_count", { sheet: KEY, points: [[1800, 1000], [2000, 1000]], condition: "ACS-1" });
  await ok(client, "edit_condition", { condition: "ACS-1", waste_pct: 12, cable_setup: { device_type: "access_door" } });
  const [d1, d2] = (await ok(client, "list_shapes", { condition: "ACS-1" })).shapes.map((s: any) => s.id);
  await refused(client, "link_run", { device_shape_ids: [d1], route_shape_ids: [rtC], tr_id: tr }, /ACS-1: vertical_ft is required[\s\S]*state this run's own vertical \(link_run vertical_ft\)/);
  const bad: any = await client.callTool({ name: "link_run", arguments: { device_shape_ids: [d1], route_shape_ids: [rtC], tr_id: tr, vertical_ft: -1 } });
  assert.ok(bad.isError && /MCP error -32602/.test(bad.content[0].text) && /vertical_ft/.test(bad.content[0].text), "a negative vertical is a schema violation (number ≥ 0)");
  assert.equal((await ok(client, "list_runs", {})).count, 1, "refusals minted nothing");
  const d = await ok(client, "link_run", { device_shape_ids: [d1], route_shape_ids: [rtC], tr_id: tr, vertical_ft: 12 });
  assert.deepEqual({ status: d.status, v: d.vertical_ft, over: d.vertical_override, per: d.per_cable_lf }, { status: "linked", v: 12, over: 12, per: 140 + 12 + 15 + 10 });
  assert.equal(d.notes[0], "vertical 12 ft (run override; condition has none)");
  const zero = await ok(client, "link_run", { device_shape_ids: [d2], route_shape_ids: [rtC], tr_id: tr, vertical_ft: 0 });
  assert.deepEqual({ v: zero.vertical_ft, per: zero.per_cable_lf }, { v: 0, per: 165 }, "0 is a stated vertical");
  const runs = await ok(client, "list_runs", {});
  assert.deepEqual(runs.runs.map((r: any) => [r.condition, r.status, r.vertical_ft, r.vertical_override]), [["DATA-1", "linked", 9, 9], ["ACS-1", "linked", 12, 12], ["ACS-1", "linked", 0, 0]]);
  const acs = runs.summary.rows.find((r: any) => r.finish_tag === "ACS-1");
  assert.deepEqual({ pulls: acs.pulls, net: acs.cable_lf, order: acs.cable_lf_order }, { pulls: 2, net: 342, order: 383.04 });
  // the record carries it; export → import keeps it; undo_last takes the link back
  const payload = await ok(client, "export_takeoff", {});
  assert.deepEqual(payload.cable_runs.map((r: any) => r.vertical_override), [9, 12, 0]);
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-v-"));
  const file = path.join(dir, "v.json");
  await writeFile(file, JSON.stringify(payload));
  const two = await pair();
  await ok(two, "load_plan", { path: PLAN });
  await ok(two, "import_takeoff", { path: file });
  assert.deepEqual((await ok(two, "list_runs", {})).runs.map((r: any) => [r.status, r.per_cable_lf]), [["linked", 116.5], ["linked", 177], ["linked", 165]]);
  await ok(client, "undo_last", { n: 1 });
  assert.equal((await ok(client, "list_runs", {})).count, 2);
});

test("unlink_run removes the link only; undo_last re-seats it; the device goes back on the unlinked list meanwhile", async () => {
  const { client, tr, devW, rtW } = await worked();
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  const gone = await ok(client, "unlink_run", { run_id: w.run_id });
  assert.deepEqual({ unlinked: gone.unlinked, count: gone.run_count }, { unlinked: w.run_id, count: 0 });
  const after = await ok(client, "list_runs", {});
  assert.equal(after.count, 0);
  assert.deepEqual(after.unlinked.devices.map((d: any) => [d.shape_id, d.reason]), [[devW, "no run links this device"], [(await ok(client, "list_shapes", { condition: "CAM-1" })).shapes[0].id, "no run links this device"]]);
  assert.deepEqual(after.unlinked.routes.map((r: any) => [r.shape_id, r.finish_tag, r.reason]), [[rtW, "ROUTE", "no run links this segment"], [(await ok(client, "list_shapes", { condition: "ROUTE" })).shapes[1].id, "ROUTE", "no run links this segment"]], "every line on the route condition is listed while no run uses it");
  assert.equal((await ok(client, "list_shapes", {})).count, 5, "every shape stays");
  await refused(client, "unlink_run", { run_id: "run-nope" }, /No run with id "run-nope"/);
  const undone = await ok(client, "undo_last", { n: 1 });
  assert.equal(undone.steps[0].op, "run_unlink");
  assert.equal((await ok(client, "list_runs", {})).runs[0].run_id, w.run_id);
  const undone2 = await ok(client, "undo_last", { n: 1 });
  assert.equal(undone2.steps[0].op, "run_link");
  assert.equal((await ok(client, "list_runs", {})).count, 0);
});

test("a deleted route segment breaks its run (listed with the reason, never dropped); a withheld condition reports its gap", async () => {
  const { client, tr, devW, rtW } = await worked();
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  await ok(client, "delete_shape", { shape_id: rtW });
  const runs = await ok(client, "list_runs", {});
  const r = runs.runs.find((x: any) => x.run_id === w.run_id);
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: "broken", reason: `route shape ${rtW} was deleted` });
  assert.equal(runs.summary.totals.pulls, 0);
  assert.equal(runs.unlinked.devices[0].reason, `its run ${w.run_id} is broken: route shape ${rtW} was deleted`);
  const rep = await ok(client, "export_report", {});
  assert.equal(rep.cable.runs.find((x: any) => x.run_id === w.run_id).status, "broken");
});

test("legs warning: a route segment on a condition with rise/drop reads its plan length only and the report/list_runs warn", async () => {
  const { client, tr, devW } = await worked();
  const seg = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 600], [920, 600]], condition: "LEGGY" });   // 20 ft plan
  await ok(client, "edit_condition", { condition: "LEGGY", rise_ft: 8, drop_ft: 2 });   // re-flows the run to 30 LF (#441)
  assert.equal(seg.length_lf, 20);
  assert.equal((await ok(client, "list_shapes", { condition: "LEGGY" })).shapes[0].perimeter_lf, 30);
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [seg.shape_id], tr_id: tr });
  assert.deepEqual({ route: w.route_lf, per: w.per_cable_lf }, { route: 20, per: 63 });
  assert.match(w.notes[0], /carries 10 ft of rise\/drop legs — ignored/);
  const runs = await ok(client, "list_runs", {});
  assert.match(runs.warnings[0], /Condition LEGGY carries rise\/drop legs/);
  const rep = await ok(client, "export_report", {});
  assert.match(rep.cable.warnings[0], /LEGGY/);
  assert.equal(rep.conditions.find((r: any) => r.finish_tag === "LEGGY").lf, 30, "the regular report keeps the leg-inclusive LF — which the warning names");
});

test("export_takeoff → import_takeoff round trip carries cable_setup, role and cable_runs; re-import is idempotent; a stitched-sheet run survives intact and reports broken", async () => {
  const { client, tr, devW, devC, rtW, rtC } = await worked();
  const w = await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  await ok(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  const payload = await ok(client, "export_takeoff", {});
  assert.equal(payload.cable_runs.length, 2);
  assert.deepEqual(Object.keys(payload.cable_runs[0]), ["id", "device_shape_ids", "route_shape_ids", "tr_id", "provenance"]);
  assert.deepEqual({ a: payload.cable_runs[0].provenance.actor, r: payload.cable_runs[0].provenance.reviewed }, { a: "agent", r: false });
  assert.equal(payload.conditions.find((c: any) => c.finish_tag === "TR").role, "tr");
  assert.equal(payload.conditions.find((c: any) => c.finish_tag === "DATA-1").cable_setup.device_type, "wall_outlet");
  // a run the canvas linked across a stitched composite (sheet_id stitch:<uid>)
  // — invented here, as the canvas would write it, with its stored length
  const stitched = {
    ...payload,
    shapes: [...payload.shapes,
      { id: "shp-stitch-dev", sheet_id: "stitch:abc", condition_id: payload.conditions.find((c: any) => c.finish_tag === "DATA-1").id, measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 } },
      { id: "shp-stitch-rt", sheet_id: "stitch:abc", condition_id: payload.conditions.find((c: any) => c.finish_tag === "ROUTE").id, measure_role: "linear", verts_norm: [[0.1, 0.1], [0.9, 0.1]], computed: { area_sf: 0, perimeter_lf: 72.25 } },
    ],
    sheets: [...payload.sheets, { sheet_id: "stitch:abc", units_per_px: 0.05 }],
    cable_runs: [...payload.cable_runs, { id: "run-stitch", device_shape_ids: ["shp-stitch-dev"], route_shape_ids: ["shp-stitch-rt"], tr_id: tr, provenance: { method: "manual", created_at: "2026-10-21T00:00:00.000Z" } }],
  };
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-"));
  const file = path.join(dir, "stitched.json");
  await writeFile(file, JSON.stringify(stitched));

  const two = await pair();
  await ok(two, "load_plan", { path: PLAN });
  const imp = await ok(two, "import_takeoff", { path: file });
  assert.equal(imp.replaced, true);
  const runs = await ok(two, "list_runs", {});
  assert.equal(runs.count, 3);
  const st = runs.runs.find((r: any) => r.run_id === "run-stitch");
  assert.deepEqual({ status: st.status, route: st.route_lf, review: st.review }, { status: "broken", route: 72.25, review: "human" });
  assert.match(st.reason, /sheet stitch:abc is not loaded in this session \(a stitched surface does not round-trip through MCP — link it in the canvas\)/);
  assert.deepEqual({ pulls: runs.summary.totals.pulls, net: runs.summary.totals.cable_lf }, { pulls: 2, net: 439 }, "the two plan-sheet runs count; the stitched one is excluded, not zeroed into them");
  assert.ok(runs.unlinked.devices.some((d: any) => d.shape_id === "shp-stitch-dev" && /run-stitch is broken/.test(d.reason)));
  assert.ok(runs.unlinked.routes.some((r: any) => r.shape_id === "shp-stitch-rt" && r.length_lf === 72.25));

  // export → import again: the stitched run and its shape's length are intact
  const again = await ok(two, "export_takeoff", {});
  const stRun = again.cable_runs.find((r: any) => r.id === "run-stitch");
  assert.deepEqual(stRun, stitched.cable_runs[2], "the record round-trips verbatim");
  assert.equal(again.shapes.find((s: any) => s.id === "shp-stitch-rt").computed.perimeter_lf, 72.25);
  const file2 = path.join(dir, "again.json");
  await writeFile(file2, JSON.stringify(again));
  const re = await ok(two, "import_takeoff", { path: file2 });
  assert.equal(re.shapes_added, 0, "re-import is idempotent");
  assert.equal((await ok(two, "list_runs", {})).count, 3, "no duplicate runs");
  // the wire-written file and the inline payload agree
  await ok(two, "export_takeoff", { path: path.join(dir, "out.json") });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "out.json"), "utf8")).cable_runs.length, 3);
  // and the linked plan-sheet run still figures after the round trip
  assert.equal((await ok(two, "list_runs", {})).runs.find((r: any) => r.run_id === w.run_id).per_cable_lf, 130.5);
});

test("a session with no cable condition: no cable key in summary, report or export — byte-identical to before the feature", async () => {
  const client = await pair();
  await ok(client, "load_plan", { path: PLAN });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  await ok(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [460, 100], [460, 460], [100, 460]], condition: "VCT-1" });
  assert.equal("cable" in (await ok(client, "takeoff_summary", {})), false);
  assert.equal("cable" in (await ok(client, "export_report", {})), false);
  assert.equal("cable_runs" in (await ok(client, "export_takeoff", {})), false);
  const empty = await ok(client, "list_runs", {});
  assert.deepEqual({ count: empty.count, summary: empty.summary }, { count: 0, summary: null });
  assert.match(empty.note, /No condition carries a cable_setup/);
});

test("unlinked routes come only from role 'route' conditions over the wire: a route condition with zero linked runs lists every line; base lines are never listed", async () => {
  const { client, tr, devW, rtW } = await worked();
  const base = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 700], [2000, 700]], condition: "WB-1" });   // a base run, no role
  const none = await ok(client, "list_runs", {});
  assert.deepEqual(none.unlinked.routes.map((r: any) => r.finish_tag), ["ROUTE", "ROUTE"]);
  assert.ok(!none.unlinked.routes.some((r: any) => r.shape_id === base.shape_id), "the base run is never assumed to be a route");
  await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  const one = await ok(client, "list_runs", {});
  assert.equal(one.unlinked.routes.length, 1);
  assert.notEqual(one.unlinked.routes[0].shape_id, rtW);
  // clearing the flag empties the list; linking is still by shape id
  await ok(client, "edit_condition", { condition: "ROUTE", role: null });
  assert.deepEqual((await ok(client, "list_runs", {})).unlinked.routes, []);
  assert.equal((await ok(client, "list_runs", {})).runs[0].status, "linked");
});

// ── follow-ups from the first real bid (docs/design/CABLE_SETUP_PLAN.md §12) ──

test("hold_devices: held with the reason, out of totals, listed apart; link_run refuses a held device; unlink_run releases; undo re-seats; refusals mint nothing", async () => {
  const { client, tr, devW, devC, rtW } = await worked();
  await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  await refused(client, "hold_devices", { device_shape_ids: [devW], reason: "by others" }, /linked by run run-/);
  await refused(client, "hold_devices", { device_shape_ids: [tr], reason: "by others" }, /not a device marker/);
  await refused(client, "hold_devices", { device_shape_ids: [devC], reason: "   " }, /needs a reason/);
  const h = await ok(client, "hold_devices", { device_shape_ids: [devC], reason: "Flag note 3 area — crawl-space routing not drawn" });
  assert.match(h.hold_id, /^hold-/);
  assert.deepEqual({ held: h.held, by: h.by_condition, unlinked: h.unlinked_devices, reviewed: h.reviewed }, { held: 1, by: [{ condition: "CAM-1", devices: 1 }], unlinked: 0, reviewed: false });
  await refused(client, "hold_devices", { device_shape_ids: [devC], reason: "again" }, /already held by hold-/);
  const list = await ok(client, "list_runs", {});
  assert.equal(list.count, 1, "a hold is not a run");
  assert.deepEqual(list.held.map((d: any) => [d.shape_id, d.hold_id, d.reason]), [[devC, h.hold_id, "Flag note 3 area — crawl-space routing not drawn"]]);
  assert.deepEqual(list.unlinked.devices, []);
  assert.equal(list.holds[0].review, "pending");
  const tot = list.summary.totals;
  assert.deepEqual({ ea: tot.ea, pulls: tot.pulls, held: tot.held_devices, unlinked: tot.unlinked_devices, net: tot.cable_lf }, { ea: 2, pulls: 1, held: 1, unlinked: 0, net: 261 });
  const sum = await ok(client, "takeoff_summary", {});
  assert.equal(sum.cable.held_devices, 1);
  const report = await ok(client, "export_report", {});
  assert.equal(report.cable.held[0].reason, "Flag note 3 area — crawl-space routing not drawn");
  assert.equal(report.cable.held[0].sheet, "A-101");
  await refused(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtW], tr_id: tr }, /held by hold-.* — unlink_run the hold first/);
  const rel = await ok(client, "unlink_run", { run_id: h.hold_id });
  assert.equal(rel.released_hold, true);
  assert.equal(rel.run_count, 1);
  assert.equal((await ok(client, "list_runs", {})).unlinked.devices.length, 1, "released: back on the unlinked list");
  await ok(client, "undo_last", {});
  assert.equal((await ok(client, "list_runs", {})).held.length, 1, "undo re-seats the hold");
  await ok(client, "undo_last", {});
  await ok(client, "undo_last", {});
  assert.equal((await ok(client, "list_runs", {})).holds.length, 0, "undoing hold_devices removes it");
});

test("device_type aliases over the wire: access_control reads as access_door (no vertical minted) and the reply says so; an unknown type is refused with the list", async () => {
  const client = await pair();
  await ok(client, "load_plan", { path: PLAN });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  await ok(client, "place_count", { sheet: KEY, points: [[500, 500]], condition: "EAC-1" });
  const e = await ok(client, "edit_condition", { condition: "EAC-1", cable_setup: { device_type: "access_control", cables_per_location: 3 } });
  assert.equal(e.cable_setup.device_type, "access_door");
  assert.equal(e.cable.device_type_alias, 'device_type "access_control" read as "access_door" — the document stores the canonical type');
  assert.deepEqual(e.cable.minted, { loop_device_ft: 15, loop_tr_ft: 10 }, "access_door mints no vertical");
  assert.match(e.cable.problems[0], /vertical_ft is required/);
  // a same-type patch spelled with the alias is a patch, not a re-mint
  const p = await ok(client, "edit_condition", { condition: "EAC-1", cable_setup: { device_type: "card_reader", vertical_ft: 9 } });
  assert.equal(p.cable_setup.cables_per_location, 3, "kept — not re-minted");
  assert.equal(p.cable.minted, undefined);
  await refused(client, "edit_condition", { condition: "EAC-1", cable_setup: { device_type: "intercom" } }, /"intercom" is not a device type — use one of wall_outlet, wap, camera, access_door, ceiling_other, custom \(access control → access_door/);
});

test("a run past 295 ft per cable over the wire: counted, flagged over_length on link_run and list_runs, one warning", async () => {
  const { client, tr, devC, rtC } = await worked();
  await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { vertical_ft: 130.05 } });
  const r = await ok(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  assert.equal(r.per_cable_lf, 295.05, "140 + 130.05 + 15 + 10");
  assert.equal(r.over_length, true);
  assert.deepEqual(r.device_sheets, [KEY]);
  assert.equal(r.tr_sheet, KEY);
  const list = await ok(client, "list_runs", {});
  assert.equal(list.runs[0].over_length, true);
  assert.equal(list.summary.totals.over_length_runs, 1);
  assert.equal(list.summary.totals.pulls, 1, "counted");
  assert.equal(list.warnings.filter((w: string) => /TIA-568/.test(w)).length, 1);
});

// ── Phase 3: the marked set burns the cable runs (docs/design/CABLE_SETUP.md) ──

test("export_marked_pdf: route chips carry run ID + device condition + per-cable LF, devices carry the run ID, the TR its name; the cover adds the cable lines; generic route chips give way", async () => {
  const { client, tr, devW, devC, rtW, rtC } = await worked();
  await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { vertical_ft: 130.05 } });   // → 295.05 ft per cable
  const extra = await ok(client, "place_count", { sheet: KEY, points: [[1800, 1000]], condition: "DATA-1" });
  await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  await ok(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  await ok(client, "hold_devices", { device_shape_ids: [extra.shape_ids[0]], reason: "by others" });
  const runs = (await ok(client, "list_runs", {})).runs;
  const short = runShortIds(runs.map((r: any) => r.run_id));
  const sW = short.get(runs[0].run_id)!, sC = short.get(runs[1].run_id)!;
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-marked-"));
  const out = path.join(dir, "cable marked set.pdf");
  const r = await ok(client, "export_marked_pdf", { path: out, project_name: "Invented Div 27" });
  assert.equal(r.pages, 2);
  const doc = await openPdf(out);
  const text = async (n: number) => (await doc.page(n)).textContent.items.map((i: any) => i.str).join("\n");
  const cover = await text(1);
  const sheet = await text(2);
  await doc.destroy();
  assert.ok(cover.includes("Cable runs: 2 pulls linked · 2 runs pending review · 0 unlinked devices · 1 held device · 1 over 295 ft per cable"), cover);
  assert.ok(cover.includes("1 pull · 2 cables · 261 LF cable net · 292.3 LF order at 12% waste · 1 held"), cover);
  assert.ok(cover.includes("cable route pathway, not a cable quantity: cable LF is figured per run on each device condition"), cover);
  assert.ok(cover.includes("telecom room: where the runs home"), cover);
  assert.ok(cover.includes("Route chips: run ID"), cover);
  assert.ok(/! 1 linked run exceeds 295 ft per cable/.test(cover), cover);
  assert.ok(sheet.includes(`${sW} · DATA-1 · 130.5 LF`), sheet);
  assert.match(sheet, new RegExp(`${sC} · CAM-1 · 295(\\.\\d)? LF >295`));
  assert.equal(sheet.split(sW).length - 1, 2, "the run ID prints twice: on the route chip and beside the device");
  assert.ok(sheet.includes("MDF"), "the TR is named on the sheet");
  assert.equal(/ROUTE · 87\.5 LF/.test(sheet), false, "a linked route's generic chip gives way to its run chip");
});

test("duplicate device check: two place_count calls on one spot of a cable condition → a same-sheet warning in list_runs; counts unchanged; summary and report carry it", async () => {
  const { client, devW } = await worked();
  const clean = await ok(client, "list_runs", {});
  assert.deepEqual({ count: clean.duplicates.count, same: clean.duplicates.same_sheet, cross: clean.duplicates.cross_sheet }, { count: 0, same: [], cross: [] });
  assert.equal("duplicates" in (await ok(client, "takeoff_summary", {})).cable, false, "no finding, no key");
  assert.equal("duplicates" in (await ok(client, "export_report", {})).cable, false);
  const again = await ok(client, "place_count", { sheet: KEY, points: [[1000, 1000]], condition: "DATA-1" });   // the sweep's marker, clicked again
  const runs = await ok(client, "list_runs", {});
  assert.deepEqual(runs.duplicates.same_sheet, [{
    sheet_id: KEY, sheet: "A-101", shape_ids: [devW, again.shape_ids[0]], finish_tags: ["DATA-1", "DATA-1"], condition_ids: [runs.duplicates.same_sheet[0].condition_ids[0]],
    same_condition: true, distance: 0, basis: "ft", threshold: 1,
  }]);
  assert.ok(runs.warnings.includes("A-101: 1 position holds two or more device markers on cable conditions within 1 ft of each other — DATA-1 ×2. One device marked twice (a symbol sweep plus a click) doubles its pull and cable LF. Check each and remove an extra marker only once a person confirms it; this check never removes one."), JSON.stringify(runs.warnings));
  const sum = await ok(client, "takeoff_summary", {});
  assert.equal(sum.conditions.find((r: any) => r.finish_tag === "DATA-1").ea, 2, "a check never changes a count");
  assert.equal(sum.cable.duplicates.same_sheet.length, 1);
  const rep = await ok(client, "export_report", {});
  assert.equal(rep.cable.duplicates.same_sheet[0].sheet, "A-101");
  assert.ok(rep.cable.warnings.some((w: string) => /DATA-1 ×2/.test(w)));
});

test("duplicate device check across sheets: the demo plan loaded twice (overlay plans) → one group of 3; moving one set to a non-cable reference condition clears the warning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cable-dupes-"));
  const comm = path.join(dir, "comm.pdf"), sec = path.join(dir, "sec.pdf");
  const bytes = await readFile(PLAN);
  await writeFile(comm, bytes);
  await writeFile(sec, bytes);
  const client = await pair();
  await ok(client, "load_plan", { path: comm });
  await ok(client, "load_plan", { path: sec, merge: true });
  const pts = [[800, 900], [1600, 900], [2400, 900]];
  const a = await ok(client, "place_count", { sheet: "comm.pdf", points: pts, condition: "CAM-1" });
  const b = await ok(client, "place_count", { sheet: "sec.pdf", points: pts.map(([x, y]) => [x + 6, y - 4]), condition: "CAM-1" });
  await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { device_type: "camera", cable_type: "CAT6" } });
  const runs = await ok(client, "list_runs", {});
  assert.equal(runs.duplicates.same_sheet.length, 0);
  assert.equal(runs.duplicates.cross_sheet.length, 1);
  const x = runs.duplicates.cross_sheet[0];
  assert.deepEqual({ a: x.sheet_a, b: x.sheet_b, n: x.positions, g: x.groups.map((g: any) => [g.finish_tag_a, g.finish_tag_b, g.count, g.different_conditions]) },
    { a: "A-101 (comm.pdf)", b: "A-101 (sec.pdf)", n: 3, g: [["CAM-1", "CAM-1", 3, false]] });
  assert.deepEqual(x.groups[0].pairs, a.shape_ids.map((id: string, i: number) => [id, b.shape_ids[i]]));
  assert.ok(runs.warnings.some((w: string) => w.startsWith("A-101 (comm.pdf) and A-101 (sec.pdf) share 3 device positions: CAM-1 on A-101 (comm.pdf) ↔ CAM-1 on A-101 (sec.pdf) (3).")), JSON.stringify(runs.warnings));
  assert.equal(runs.summary.totals.ea, 6, "both sets still counted — the check flags, the estimator decides");
  // the fix: the security plan's markers move to a non-cable reference condition
  for (const id of b.shape_ids) await ok(client, "edit_shape", { shape_id: id, condition: "CAM-REF" });
  const after = await ok(client, "list_runs", {});
  assert.deepEqual([after.duplicates.cross_sheet, after.warnings.filter((w: string) => /share \d+ device position/.test(w))], [[], []]);
  assert.deepEqual(after.duplicates.reference.map((r: any) => r.groups.map((g: any) => [g.finish_tag_a, g.finish_tag_b, g.count, g.cable_side])), [[["CAM-1", "CAM-REF", 3, "a"]]]);
  assert.equal(after.summary.totals.ea, 3);
});
// ── item 5: parts per cable and per pull (docs/design/CABLE_SETUP_PLAN.md §14.5) ──

test("edit_materials basis cables / pulls on DATA-1: the reply's computed lines and export_report's buy list carry the exact parts; ×N doubles them; a non-cable condition reads 0 with a reason", async () => {
  const { client, tr, devW, rtW, rtC } = await worked();
  // DATA-1: devW at 2 cables per location, a second location overridden to 3,
  // a third device left unlinked — 2 pulls, 5 cables, never the 3 EA
  const more = await ok(client, "place_count", { sheet: KEY, points: [[1800, 1000], [2200, 1000]], condition: "DATA-1" });
  await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  await ok(client, "link_run", { device_shape_ids: [more.shape_ids[0]], route_shape_ids: [rtC], tr_id: tr, cables_override: 3 });
  const bad: any = await client.callTool({ name: "edit_materials", arguments: { condition: "DATA-1", add: [{ name: "Jack", per: 1, basis: "jacks" }] } });
  assert.equal(!!bad.isError, true, "an unknown basis is refused by the schema");
  assert.match(bad.content[0].text, /basis/);
  const m = await ok(client, "edit_materials", {
    condition: "DATA-1",
    add: [
      { name: "RJ45 jack", per: 1, basis: "cables", unit: "ea" },
      { name: "Faceplate", per: 1, basis: "pulls", unit: "ea" },
      { name: "Patch cord", per: 1, basis: "cables", unit: "ea" },
    ],
  });
  assert.deepEqual(m.materials.map((r: any) => r.basis), ["cables", "pulls", "cables"]);
  assert.deepEqual(m.computed.map((r: any) => [r.name, r.basis_qty, r.qty]), [["RJ45 jack", 5, 5], ["Faceplate", 2, 2], ["Patch cord", 5, 5]]);
  assert.ok(m.computed.every((r: any) => !("reason" in r)));

  const rep = await ok(client, "export_report", {});
  const buy = (name: string) => rep.materials.find((x: any) => x.name === name)?.qty;
  assert.deepEqual([buy("RJ45 jack"), buy("Faceplate"), buy("Patch cord")], [5, 2, 5]);
  const dataRow = rep.conditions.find((r: any) => r.finish_tag === "DATA-1");
  assert.equal(dataRow.ea, 3, "three markers on the plan; the parts follow the two linked runs");
  const sumRow = rep.cable.summary.find((r: any) => r.finish_tag === "DATA-1");
  assert.deepEqual([sumRow.pulls, sumRow.cables], [2, 5]);

  await ok(client, "edit_condition", { condition: "DATA-1", multiplier: 2 });
  const rep2 = await ok(client, "export_report", {});
  assert.deepEqual(["RJ45 jack", "Faceplate", "Patch cord"].map((n) => rep2.materials.find((x: any) => x.name === n).qty), [10, 4, 10]);

  // a non-cable condition: the row reads 0 and says why, in the reply and the report
  await ok(client, "measure_polygon", { sheet: KEY, verts: [[100, 2000], [460, 2000], [460, 2360], [100, 2360]], condition: "VCT-1" });
  const v = await ok(client, "edit_materials", { condition: "VCT-1", add: [{ name: "Stray jack", per: 1, basis: "cables", unit: "ea" }] });
  assert.equal(v.computed[0].qty + 0, 0);
  assert.match(v.computed[0].reason, /no cable setup on this condition/);
  const vRow = (await ok(client, "export_report", {})).conditions.find((r: any) => r.finish_tag === "VCT-1");
  assert.match(vRow.materials[0].reason, /no cable setup/);
  // an ordinary materials edit on a condition the cable bases do not concern: the reply is unchanged
  const plain = await ok(client, "edit_materials", { condition: "WB-1", add: [{ name: "Adhesive", per: 40, basis: "linear", unit: "tube" }] });
  assert.equal("computed" in plain, false);
  // undo restores the materials array; the buy list follows
  await ok(client, "undo_last", { n: 3 });
  assert.equal((await ok(client, "export_report", {})).materials.some((x: any) => x.name === "Stray jack"), false);
});

// ── trunk and branch routes (docs/design/CABLE_SETUP_PLAN.md §14.2) ─────────
/** A shared 100 ft trunk (3600 px) on TRAY and two 40 ft branches (1440 px)
 *  on BRANCH, two wall outlets, the MDF. */
async function trunkBranch() {
  const client = await pair();
  await ok(client, "load_plan", { path: PLAN });
  await ok(client, "set_scale", { sheet: KEY, upp: UPP });
  const tr = await ok(client, "place_count", { sheet: KEY, points: [[200, 200]], condition: "TR" });
  await ok(client, "edit_condition", { condition: "TR", role: "tr" });
  await ok(client, "edit_shape", { shape_id: tr.shape_ids[0], label: "MDF" });
  const d1 = await ok(client, "place_count", { sheet: KEY, points: [[1000, 1000]], condition: "DATA-1" });
  const d2 = await ok(client, "place_count", { sheet: KEY, points: [[1400, 1000]], condition: "DATA-1" });
  await ok(client, "edit_condition", { condition: "DATA-1", waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  const t1 = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 300], [3800, 300]], condition: "TRAY" });
  const b1 = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 500], [1640, 500]], condition: "BRANCH" });
  const b2 = await ok(client, "measure_line", { sheet: KEY, pts: [[200, 600], [1640, 600]], condition: "BRANCH" });
  assert.deepEqual([t1.length_lf, b1.length_lf, b2.length_lf], [100, 40, 40]);
  return { client, tr: tr.shape_ids[0] as string, d1: d1.shape_ids[0] as string, d2: d2.shape_ids[0] as string, t1: t1.shape_id as string, b1: b1.shape_id as string, b2: b2.shape_id as string };
}

test("edit_condition route_kind: refused off a route condition with the fix named, set with role in one call, cleared by null or by leaving the role, undo restores", async () => {
  const { client } = await trunkBranch();
  await refused(client, "edit_condition", { condition: "BRANCH", route_kind: "branch" }, /route_kind tags a cable-route condition, and "BRANCH" is not flagged role "route"\. Flag it in the same call: edit_condition \{ condition: "BRANCH", role: "route", route_kind: "branch" \}/);
  await refused(client, "edit_condition", { condition: "TR", route_kind: "trunk" }, /"TR" is flagged role "tr"/);
  await refused(client, "edit_condition", { condition: "TRAY", role: "tr", route_kind: "trunk" }, /flagged role "tr"/);
  const bad: any = await client.callTool({ name: "edit_condition", arguments: { condition: "TRAY", role: "route", route_kind: "riser" } });
  assert.ok(bad.isError && /MCP error -32602/.test(bad.content[0].text), "an unknown kind is a schema violation");
  let pay = await ok(client, "export_takeoff", {});
  assert.equal(pay.conditions.some((c: any) => "route_kind" in c || c.role === "route"), false, "a refusal writes nothing");
  const trunk = await ok(client, "edit_condition", { condition: "TRAY", role: "route", route_kind: "trunk" });
  assert.deepEqual({ role: trunk.role, kind: trunk.route_kind }, { role: "route", kind: "trunk" });
  assert.deepEqual(trunk.pathway, { condition_id: trunk.condition_id, finish_tag: "TRAY", route_kind: "trunk", segments: 1, pathway_lf: 100, used_lf: 0, unused_lf: 100, linked_runs: 0, pathway_lf_total: 100, multiplier: 1 });
  await ok(client, "edit_condition", { condition: "BRANCH", role: "route" });
  const br = await ok(client, "edit_condition", { condition: "BRANCH", route_kind: "branch" });
  assert.equal(br.route_kind, "branch");
  // null clears; undo puts it back
  const cleared = await ok(client, "edit_condition", { condition: "BRANCH", route_kind: null });
  assert.deepEqual({ role: cleared.role, kind: cleared.route_kind }, { role: "route", kind: undefined });
  await ok(client, "undo_last", { n: 1 });
  pay = await ok(client, "export_takeoff", {});
  assert.equal(pay.conditions.find((c: any) => c.finish_tag === "BRANCH").route_kind, "branch");
  // leaving the role takes the kind along; undo restores both
  const off = await ok(client, "edit_condition", { condition: "TRAY", role: null });
  assert.deepEqual({ role: off.role, kind: off.route_kind }, { role: undefined, kind: undefined });
  assert.equal("route_kind" in (await ok(client, "export_takeoff", {})).conditions.find((c: any) => c.finish_tag === "TRAY"), false);
  await ok(client, "undo_last", { n: 1 });
  const tray = (await ok(client, "export_takeoff", {})).conditions.find((c: any) => c.finish_tag === "TRAY");
  assert.deepEqual({ role: tray.role, kind: tray.route_kind }, { role: "route", kind: "trunk" });
});

test("trunk and branch over the wire: link_run [branch, trunk] splits route LF; list_runs carries the split and the pathway block (trunk once); summary, report and re-import agree", async () => {
  const { client, tr, d1, d2, t1, b1, b2 } = await trunkBranch();
  // untagged route conditions: no split, no pathway (the pre-route_kind output)
  await ok(client, "edit_condition", { condition: "TRAY", role: "route" });
  await ok(client, "edit_condition", { condition: "BRANCH", role: "route" });
  const plain = await ok(client, "link_run", { device_shape_ids: [d1], route_shape_ids: [b1, t1], tr_id: tr });
  assert.equal("branch_lf" in plain || "trunk_lf" in plain, false);
  const plainList = await ok(client, "list_runs", {});
  assert.equal("pathway" in plainList || "branch_lf" in plainList.runs[0], false);
  assert.equal("pathway" in (await ok(client, "takeoff_summary", {})).cable, false);
  assert.equal("pathway" in (await ok(client, "export_report", {})).cable, false);
  await ok(client, "unlink_run", { run_id: plain.run_id });

  await ok(client, "edit_condition", { condition: "TRAY", route_kind: "trunk" });
  await ok(client, "edit_condition", { condition: "BRANCH", route_kind: "branch" });
  const r1 = await ok(client, "link_run", { device_shape_ids: [d1], route_shape_ids: [b1, t1], tr_id: tr });
  assert.deepEqual({ route: r1.route_lf, branch: r1.branch_lf, trunk: r1.trunk_lf, other: r1.other_lf, per: r1.per_cable_lf }, { route: 140, branch: 40, trunk: 100, other: 0, per: 183 });
  await ok(client, "link_run", { device_shape_ids: [d2], route_shape_ids: [b2, t1], tr_id: tr });
  const list = await ok(client, "list_runs", {});
  assert.deepEqual(list.runs.map((r: any) => [r.route_lf, r.branch_lf, r.trunk_lf, r.other_lf]), [[140, 40, 100, 0], [140, 40, 100, 0]]);
  assert.equal(list.summary.totals.route_lf, 280, "cable route LF counts the shared trunk on each run");
  assert.deepEqual(list.pathway.rows.map((r: any) => [r.finish_tag, r.route_kind, r.segments, r.pathway_lf, r.used_lf, r.unused_lf, r.linked_runs, r.multiplier]),
    [["TRAY", "trunk", 1, 100, 100, 0, 2, 1], ["BRANCH", "branch", 2, 80, 80, 0, 2, 1]], "the trunk is 100 ft of pathway, counted once");
  assert.deepEqual(list.pathway.totals, { segments: 3, pathway_lf: 180, used_lf: 180, unused_lf: 0, linked_runs: 2, pathway_lf_total: 180 });
  assert.deepEqual(list.warnings.filter((w: string) => !/scale no person has confirmed/.test(w)), [], "no new warning (every MCP scale lands unconfirmed)");
  const sum = await ok(client, "takeoff_summary", {});
  assert.deepEqual(sum.cable.pathway, list.pathway);
  // J-hooks: a linear materials row on the branch condition, each segment once
  await ok(client, "edit_materials", { condition: "BRANCH", add: [{ name: "J-hook", per: 5, basis: "linear", unit: "EA" }] });
  await ok(client, "edit_condition", { condition: "BRANCH", multiplier: 2 });
  const rep = await ok(client, "export_report", {});
  const brRow = rep.conditions.find((c: any) => c.finish_tag === "BRANCH");
  assert.deepEqual({ basis: brRow.materials[0].basis_qty, qty: brRow.materials[0].qty }, { basis: 160, qty: 32 }, "ceil(80 × 2 / 5)");
  assert.equal(rep.cable.pathway.rows.find((r: any) => r.finish_tag === "BRANCH").pathway_lf_total, 160, "the pathway's ×N column is the same basis");
  assert.deepEqual([rep.cable.runs[0].branch_lf, rep.cable.runs[0].trunk_lf], [40, 100]);
  // export → import: route_kind and the split survive
  const payload = await ok(client, "export_takeoff", {});
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-tb-"));
  const file = path.join(dir, "trunk-branch.json");
  await writeFile(file, JSON.stringify(payload));
  const two = await pair();
  await ok(two, "load_plan", { path: PLAN });
  await ok(two, "import_takeoff", { path: file });
  const back = await ok(two, "list_runs", {});
  assert.deepEqual(back.runs.map((r: any) => [r.branch_lf, r.trunk_lf]), [[40, 100], [40, 100]]);
  assert.equal(back.pathway.totals.pathway_lf, 180);
  assert.deepEqual((await ok(two, "export_takeoff", {})).conditions.map((c: any) => c.route_kind).filter(Boolean), ["trunk", "branch"]);
});

// ── item 6: cable medium and per-condition length limits ────────────────────

test("edit_condition cable_setup medium + max_link_ft over the wire: fiber unchecked, a stated limit flags with its own words, bad values refused with nothing written, null clears, a type change keeps them, undo restores", async () => {
  const { client, tr, devW, devC, rtW, rtC } = await worked();
  // CAM-1 at 140 + 435 + 15 + 10 = 600 ft per cable; DATA-1 at 130.5
  await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { vertical_ft: 435 } });
  await ok(client, "link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  const c = await ok(client, "link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  assert.deepEqual([c.per_cable_lf, c.over_length, "limit_ft" in c, "limit_source" in c], [600, true, false, false], "no medium, no limit: today's check and today's reply");
  let list = await ok(client, "list_runs", {});
  assert.ok(list.warnings.includes(`1 linked run exceeds 295 ft per cable, the TIA-568 limit for a 4-pair copper permanent link (90 m): CAM-1 ${c.run_id} 600 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice. Fiber and coax are not bound by this limit.`), list.warnings.join("\n"));

  // fiber with no stated limit: not checked, no warning; the reply says so
  const fib = await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { medium: "Fiber" } });
  assert.equal(fib.cable_setup.medium, "fiber", "case forgiven; the canonical name is stored");
  assert.deepEqual(fib.cable.limit, { medium: "fiber", limit_ft: null, limit_source: "none", note: "fiber has no single length limit (it depends on the application and the fiber grade): runs on this condition are NOT length-checked until max_link_ft states the spec's limit", medium_read_as: 'medium "Fiber" read as "fiber"' });
  list = await ok(client, "list_runs", {});
  const cam = () => list.runs.find((r: any) => r.condition === "CAM-1");
  const data = () => list.runs.find((r: any) => r.condition === "DATA-1");
  assert.deepEqual([cam().over_length, cam().medium, cam().limit_ft, cam().limit_source, cam().per_cable_lf], [undefined, "fiber", null, "none", 600]);
  assert.deepEqual([data().limit_ft, data().limit_source, "medium" in data()], [295, "tia_568_copper", false], "every run says its limit once any condition states one");
  assert.equal(list.warnings.some((w: string) => /length limit|295 ft per cable/.test(w)), false);
  assert.equal(list.summary.totals.over_length_runs, 0);

  // refusals: nothing written
  const before = JSON.stringify((await ok(client, "export_takeoff", {})).conditions);
  await refused(client, "edit_condition", { condition: "CAM-1", cable_setup: { medium: "glass" } }, /cable_setup\.medium "glass" is not a medium — use "copper", "fiber" or "coax" \(or null to clear it\)\. State it from the spec; it is never read from cable_type\./);
  await refused(client, "edit_condition", { condition: "CAM-1", waste_pct: 50, cable_setup: { max_link_ft: 0 } }, /cable_setup\.max_link_ft 0 is not a length limit — give the limit in feet, greater than 0/);
  await refused(client, "edit_condition", { condition: "CAM-1", cable_setup: { max_link_ft: -300 } }, /is not a length limit/);
  const bad: any = await client.callTool({ name: "edit_condition", arguments: { condition: "CAM-1", cable_setup: { max_link_ft: "500" } } });
  assert.ok(bad.isError && /MCP error -32602/.test(bad.content[0].text) && /cable_setup/.test(bad.content[0].text), `a string limit is a schema violation: ${bad.content[0].text}`);
  assert.equal(JSON.stringify((await ok(client, "export_takeoff", {})).conditions), before, "a refusal writes nothing, not even the waste in the same call");

  // a stated limit: the 600 ft run is flagged in the stated limit's words
  const lim = await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { max_link_ft: 500 } });
  assert.deepEqual([lim.cable_setup.medium, lim.cable_setup.max_link_ft], ["fiber", 500]);
  assert.deepEqual([lim.cable.limit.limit_ft, lim.cable.limit.limit_source], [500, "stated"]);
  assert.deepEqual([lim.cable.rows[0].limit_ft, lim.cable.rows[0].limit_source, lim.cable.rows[0].over_length_runs], [500, "stated", 1]);
  list = await ok(client, "list_runs", {});
  assert.deepEqual([cam().over_length, cam().limit_ft, cam().limit_source], [true, 500, "stated"]);
  assert.ok(cam().notes.includes("per cable 600 ft exceeds the stated 500 ft limit for CAM-1"), cam().notes.join("\n"));
  assert.ok(list.warnings.includes(`1 linked run exceeds its length limit per cable. Over the stated 500 ft limit (CAM-1): CAM-1 ${c.run_id} 600 ft. Check the route; if it stands, the run needs a closer TR, or a length test and an owner notice.`), list.warnings.join("\n"));
  assert.equal(list.summary.totals.cable_lf, 261 + 600, "a flag never changes a quantity");
  const rep = await ok(client, "export_report", {});
  const repCam = rep.cable.runs.find((r: any) => r.condition === "CAM-1");
  assert.deepEqual([repCam.medium, repCam.limit_ft, repCam.limit_source, repCam.over_length], ["fiber", 500, "stated", true]);
  assert.equal((await ok(client, "takeoff_summary", {})).cable.rows.find((r: any) => r.finish_tag === "CAM-1").limit_ft, 500);
  // the marked set: the chip shows the run's own limit; the cover counts without naming one
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-medium-"));
  const out = path.join(dir, "marked.pdf");
  await ok(client, "export_marked_pdf", { path: out, project_name: "Invented Div 27" });
  const doc = await openPdf(out);
  const cover = (await doc.page(1)).textContent.items.map((i: any) => i.str).join("\n");
  const sheet = (await doc.page(2)).textContent.items.map((i: any) => i.str).join("\n");
  await doc.destroy();
  assert.match(sheet, / · CAM-1 · 600 LF >500/);
  assert.ok(cover.includes("1 over its length limit per cable"), cover);

  // a type change keeps the medium and the limit (they describe the cable)
  const typed = await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { device_type: "ceiling_other" } });
  assert.deepEqual([typed.cable_setup.device_type, typed.cable_setup.medium, typed.cable_setup.max_link_ft], ["ceiling_other", "fiber", 500]);
  assert.equal("medium" in typed.cable.minted || "max_link_ft" in typed.cable.minted, false, "never minted");
  // null clears each; undo_last restores the last one
  const noLimit = await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { max_link_ft: null } });
  assert.equal("max_link_ft" in noLimit.cable_setup, false);
  assert.equal(noLimit.cable.limit.limit_source, "none");
  const noMedium = await ok(client, "edit_condition", { condition: "CAM-1", cable_setup: { medium: null } });
  assert.equal("medium" in noMedium.cable_setup, false);
  assert.deepEqual([noMedium.cable.limit.limit_ft, noMedium.cable.limit.limit_source], [295, "tia_568_copper"]);
  assert.match(noMedium.cable.limit.note, /^no medium stated: runs are checked as copper at 295 ft per cable/);
  await ok(client, "undo_last", { n: 1 });
  assert.equal((await ok(client, "export_takeoff", {})).conditions.find((x: any) => x.finish_tag === "CAM-1").cable_setup.medium, "fiber");
  // a fresh opt-in mints neither; stating them is the only way in
  await ok(client, "place_count", { sheet: KEY, points: [[2600, 1000]], condition: "BB-1" });
  const fresh = await ok(client, "edit_condition", { condition: "BB-1", cable_setup: { device_type: "custom", medium: "fiber", max_link_ft: 984 } });
  assert.deepEqual(fresh.cable_setup, { device_type: "custom", cables_per_location: 1, cable_type: "", vertical_ft: null, loop_device_ft: null, loop_tr_ft: null, medium: "fiber", max_link_ft: 984 });
  const plain = await ok(client, "edit_condition", { condition: "DATA-1", waste_pct: 10 });
  assert.equal("limit" in plain.cable, false, "a condition that states neither, edited without touching them, replies as before");
});

test("a cable session that states no medium and no limit replies byte-for-byte as 28ea3cc did (edit_condition, link_run, hold_devices, list_runs, takeoff_summary, export_report, the marked set's text)", async () => {
  const base = JSON.parse(await readFile(new URL("./fixtures/cableMediumScenario.base.json", import.meta.url), "utf8"));
  const now = await cableMediumScenario(buildServer, Session, PLAN);
  assert.deepEqual(Object.keys(now as object), Object.keys(base));
  for (const k of Object.keys(base)) assert.equal(JSON.stringify((now as any)[k]), JSON.stringify(base[k]), k);
});
