// The install design's first draft from an invented takeoff (test/installFixture.ts):
// tags, rooms, racks, panels and ports, labels, lengths equal to the cable
// library's per-cable LF, issues; and a re-draft with `previous` keeps edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftInstallDesign, floorFromName, kindOfCableType, tagPrefix, type InstallTakeoff } from "../src/install/baseline.ts";
import { applyInstallOps } from "../src/install/ops.ts";
import { emptyEquipmentLibrary } from "../src/equipmentLib.ts";
import { installTakeoff, S1 } from "./installFixture.ts";

type CableLib = typeof import("opentakeoff-web-cable");
const cableLib = (await import(new URL("../../web/src/lib/cable.js", import.meta.url).href)) as CableLib;

const NOW = "2026-11-21T09:00:00.000Z";
const draft = (takeoff: InstallTakeoff = installTakeoff(), extra: Partial<Parameters<typeof draftInstallDesign>[0]> = {}) =>
  draftInstallDesign({ takeoff, project: "invented-clinic", now: NOW, ...extra });

test("baseline: devices get type prefix + floor + sequence tags and their rooms", () => {
  const d = draft();
  const tags = Object.fromEntries(d.devices.map((x) => [x.shapeId, x.tag]));
  // T-101 (floor 1) in room order: Office 101 (d1, u1), Open Office (d2, w1, h1), no room (c1); T-201 (floor 2)
  assert.deepEqual(tags, { d1: "DO-101", u1: "DO-102", d2: "DO-103", w1: "WAP-101", h1: "WAP-102", c1: "CAM-101", a1: "ACD-201", w2: "WAP-201", d3: "DO-201" });
  const room = (sid: string) => d.devices.find((x) => x.shapeId === sid)!.room;
  assert.equal(room("d1"), "Office 101");
  assert.equal(room("w1"), "Open Office");
  assert.equal(room("c1"), null, "outside every room polygon");
  assert.equal(room("w2"), "Conference 201");
  assert.equal(room("d3"), "Storage 202", "the smaller (deduct) polygon wins");
  assert.equal(d.devices.find((x) => x.tag === "DO-101")!.rack, "RK-101");
  assert.equal(d.devices.find((x) => x.tag === "DO-102")!.rack, null, "unlinked: no rack");
  assert.equal(d.devices.find((x) => x.tag === "WAP-201")!.rack, "RK-201");
  assert.deepEqual([d.schema, d.revision, d.status, d.created, d.approved], ["brink.install.v1", 1, "draft", NOW, undefined]);
});

test("baseline: racks per TR with size 0, panels top down, ports by room then tag", () => {
  const d = draft();
  assert.deepEqual(d.racks.map((r) => [r.id, r.name, r.location, r.sizeRU, r.trShapeId]), [["RK-101", "IDF-1", "IDF 1", 0, "t1"], ["RK-201", "IDF-2", "Conference 201", 0, "t2"]]);
  assert.deepEqual(d.racks[0].items, [{ tag: "PP-01", kind: "panel", ruTop: 1, ruHeight: 1, label: "24-port patch panel" }]);
  const pp1 = d.equipment.find((e) => e.tag === "PP-01")!;
  assert.deepEqual([pp1.ports.length, pp1.rack, pp1.watts, pp1.ports[0].id], [24, "RK-101", 0, "p1"]);
  const end = (label: string) => { const c = d.cables.find((x) => x.label === label)!; return `${c.from.equipment}:${c.from.port}→${c.to.equipment}:${c.to.port}`; };
  assert.deepEqual(d.cables.map((c) => c.label), ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09"]);
  assert.equal(end("D01"), "PP-01:p1→DO-101:c1");
  assert.equal(end("D02"), "PP-01:p2→DO-101:c2");
  assert.equal(end("D05"), "PP-01:p5→WAP-101:c1");
  assert.equal(end("D06"), "PP-01:p6→CAM-101:c1", "no room sorts last");
  assert.equal(end("D07"), "PP-02:p1→WAP-201:c1");
  assert.equal(end("D09"), "PP-02:p3→DO-201:c2");
  // field devices are equipment with one port per cable; one connection per field cable
  assert.deepEqual(d.equipment.find((e) => e.tag === "DO-101")!.ports.map((p) => p.id), ["c1", "c2"]);
  assert.equal(d.connections.length, d.cables.length);
  assert.deepEqual(d.connections[0], { id: "fc-d1-c1", cable: "D01", kind: "data", from: { equipment: "PP-01", port: "p1" }, to: { equipment: "DO-101", port: "c1" } });
  assert.deepEqual(d.mounting.map((m) => [m.deviceType, m.heightAff]), [["wall_outlet", ""], ["wap", ""], ["camera", ""], ["access_door", ""]]);
});

test("baseline: lengths are the cable library's per-cable LF; held, unlinked, withheld are issues, not cables", () => {
  const t = installTakeoff();
  const lib = cableLib.computeCableTakeoff(t.conditions!, t.shapes!, t.cable_runs!, { uppFor: () => 0.05 })!;
  const d = draft(t);
  for (const c of d.cables) {
    const run = lib.resolved.runs.find((r) => r.id === c.runId)!;
    assert.equal(c.lengthFt, Math.round(run.per_cable_lf! * 10) / 10, c.label);
  }
  assert.deepEqual(d.cables.map((c) => c.lengthFt), [120, 120, 170, 170, 300, 80, 60, 70, 70]);
  assert.equal(d.cables.find((c) => c.to.equipment === "CAM-101")!.cableType, "CAT6 outdoor");
  assert.ok(!d.cables.some((c) => ["DO-102", "WAP-102", "ACD-201"].includes(c.to.equipment)));
  const codes = d.issues.map((i) => `${i.severity}:${i.code}:${i.ref ?? ""}`);
  for (const want of ["error:device_unlinked:DO-102", "error:run_withheld:run-g", "warning:device_held:WAP-102", "warning:cable_over_length:D05", "warning:room_unknown:CAM-101", "error:rack_size_unknown:RK-101", "error:mounting_height_unset:wall_outlet"]) {
    assert.ok(codes.includes(want), `${want} in ${codes.join(", ")}`);
  }
  const firstWarning = d.issues.findIndex((i) => i.severity === "warning");
  assert.ok(d.issues.slice(firstWarning).every((i) => i.severity === "warning"), "errors first");
  assert.match(d.devices.find((x) => x.tag === "WAP-102")!.notes ?? "", /owner-furnished AP/);
});

test("baseline: floors from sheet names, prefixes and cable kinds", () => {
  assert.equal(floorFromName("T-201"), 2);
  assert.equal(floorFromName("E101.pdf"), 1);
  assert.equal(floorFromName("E1.01"), 1);
  assert.equal(floorFromName("LEVEL 3 TECHNOLOGY PLAN"), 3);
  assert.equal(floorFromName("2ND FLOOR"), 2);
  assert.equal(floorFromName("T-001"), null);
  assert.equal(floorFromName("Plans.pdf"), null);
  const d = draft(installTakeoff(), { sheets: [{ key: S1, number: "LEVEL 3" }] });
  assert.equal(d.devices.find((x) => x.shapeId === "w1")!.tag, "WAP-301");
  assert.equal(d.racks[0].id, "RK-301");
  assert.equal(tagPrefix("ceiling_other", "SPK-1"), "SPK");
  assert.equal(tagPrefix("custom", "TV DISPLAY"), "TV");
  assert.equal(tagPrefix("custom", "AV-RACK"), "AVRA");
  assert.deepEqual(["CAT6A plenum", "OM4 12-strand", "RG6 quad", "16/2 speaker", "HDMI 2.1", "18/6 shielded", "mystery"].map(kindOfCableType), ["data", "fiber", "coax", "speaker", "video", "control", "other"]);
});

test("baseline: more than 24 cables → 48-port panels with a manager between", () => {
  const t = installTakeoff();
  const shapes = t.shapes as Record<string, unknown>[];
  const runs = t.cable_runs as Record<string, unknown>[];
  for (let i = 0; i < 30; i++) {
    shapes.push({ id: `x${i}`, condition_id: "DO", sheet_id: S1, measure_role: "count", verts_norm: [[0.55 + i * 0.01, 0.4]], computed: { count: 1 } });
    shapes.push({ id: `xr${i}`, condition_id: "ROUTE", sheet_id: S1, measure_role: "linear", verts_norm: [[0, 0], [1, 0]], computed: { perimeter_lf: 10 + i } });
    runs.push({ id: `run-x${i}`, device_shape_ids: [`x${i}`], route_shape_ids: [`xr${i}`], tr_id: "t1", provenance: { method: "manual", created_at: NOW } });
  }
  const d = draft(t);
  const rk = d.racks.find((r) => r.id === "RK-101")!;
  // 6 + 60 = 66 cables → two 48-port (2RU) panels; stack PP-01 RU 4-5, manager RU 3, PP-02 RU 1-2
  assert.deepEqual(rk.items.map((it) => [it.tag, it.kind, it.ruTop, it.ruHeight]), [["PP-01", "panel", 5, 2], ["RK-101-HM01", "manager", 3, 1], ["PP-02", "panel", 2, 2]]);
  assert.equal(d.equipment.find((e) => e.tag === "PP-02")!.ports.length, 48);
  assert.equal(d.cables.filter((c) => c.from.equipment === "PP-01").length, 48);
  assert.equal(d.cables.filter((c) => c.from.equipment === "PP-02").length, 18);
  assert.equal(d.equipment.find((e) => e.tag === "PP-03")!.rack, "RK-201", "panel tags are unique across the project");
});

test("baseline: re-draft with previous keeps what was set, adds new items, lists removed ones", () => {
  const first = draft(undefined, { bidRevision: 3 });
  assert.equal(first.bidRevision, 3);
  const { design: edited } = applyInstallOps(first, [
    { op: "set_device", tag: "DO-101", newTag: "DO-1A", model: "Invented jack set" },
    { op: "set_device", tag: "CAM-101", room: "Lobby (invented)" },
    { op: "set_mounting", deviceType: "wall_outlet", heightAff: "18 in. AFF to center", basis: "Invented legend note 4" },
    { op: "set_rack", rack: "RK-101", sizeRU: 42, circuits: [{ label: "20A dedicated", amps: 20 }] },
    { op: "set_label_scheme", source: "spec", reference: "27 05 53 3.2.B (invented)", description: "TR + panel + port", pattern: "{tr}{panel}-{port:2}" },
    { op: "assign_port", cable: "D05", panel: "PP-01", port: "p10" },
    { op: "add_equipment", tag: "SW-01", description: "Invented 24-port switch", portGroups: [{ prefix: "p", count: 24, signal: "ethernet" }], watts: 60 },
    { op: "place_in_rack", tag: "SW-01", rack: "RK-101", ruTop: 40, ruHeight: 1 },
    { op: "connect", from: { equipment: "PP-01", port: "p1" }, to: { equipment: "SW-01", port: "p1" } },
  ], emptyEquipmentLibrary());
  const cam = edited.cables.find((c) => c.to.equipment === "CAM-101")!;
  const { design: edited2 } = applyInstallOps(edited, [{ op: "set_cable", label: cam.label, newLabel: "CAM-X1" }], emptyEquipmentLibrary());
  assert.deepEqual(edited2.racks[0].items.map((it) => [it.tag, it.ruTop]), [["PP-01", 42], ["SW-01", 40]], "the stack moved to the top when the size was set");

  // the takeoff changes: outlet d2 and its run are deleted, a new WAP w3 is linked
  const t = installTakeoff();
  t.shapes = (t.shapes as { id: string }[]).filter((s) => s.id !== "d2");
  t.cable_runs = (t.cable_runs as { id: string }[]).filter((r) => r.id !== "run-b");
  (t.shapes as unknown[]).push(
    { id: "w3", condition_id: "WAP", sheet_id: S1, measure_role: "count", verts_norm: [[0.75, 0.25]], computed: { count: 1 } },
    { id: "r8", condition_id: "ROUTE", sheet_id: S1, measure_role: "linear", verts_norm: [[0, 0], [1, 0]], computed: { perimeter_lf: 20 } },
  );
  (t.cable_runs as unknown[]).push({ id: "run-h", device_shape_ids: ["w3"], route_shape_ids: ["r8"], tr_id: "t1", provenance: { method: "manual", created_at: NOW } });
  const again = draft(t, { previous: { ...edited2, status: "approved", approved: { at: NOW, revision: 1 } } });

  assert.deepEqual([again.revision, again.status, again.approved], [2, "draft", undefined]);
  const byShape = (sid: string) => again.devices.find((x) => x.shapeId === sid)!;
  assert.deepEqual([byShape("d1").tag, byShape("d1").model], ["DO-1A", "Invented jack set"]);
  assert.equal(byShape("c1").room, "Lobby (invented)");
  assert.equal(byShape("w3").tag, "WAP-103", "new device: next free sequence");
  assert.equal(again.labelScheme.pattern, "{tr}{panel}-{port:2}");
  assert.equal(again.mounting.find((m) => m.deviceType === "wall_outlet")!.heightAff, "18 in. AFF to center");
  const rk = again.racks.find((r) => r.id === "RK-101")!;
  assert.deepEqual([rk.sizeRU, rk.circuits?.[0].amps, rk.items.map((it) => `${it.tag}@${it.ruTop}`).join(",")], [42, 20, "PP-01@42,SW-01@40"]);
  const port = (tag: string) => again.cables.filter((c) => c.to.equipment === tag).map((c) => `${c.from.equipment}:${c.from.port}`);
  assert.deepEqual(port("DO-1A"), ["PP-01:p1", "PP-01:p2"]);
  assert.deepEqual(port("WAP-101"), ["PP-01:p10"], "the port assignment is kept");
  assert.deepEqual(port("CAM-101"), ["PP-01:p6"]);
  assert.deepEqual(port("WAP-103"), ["PP-01:p3"], "the new cable takes the first free port");
  assert.equal(again.cables.find((c) => c.to.equipment === "WAP-103")!.lengthFt, 40);
  assert.equal(again.cables.find((c) => c.to.equipment === "CAM-101")!.label, "CAM-X1", "a hand label is kept");
  assert.equal(again.cables.find((c) => c.to.equipment === "WAP-101")!.label, "1A-10", "labels by the kept scheme");
  assert.ok(again.connections.some((c) => c.id === "pc-1" && c.to.equipment === "SW-01"), "manual connection kept");
  assert.ok(again.equipment.some((e) => e.tag === "SW-01" && e.rack === "RK-101" && e.watts === 60));
  assert.ok(again.issues.some((i) => i.code === "device_removed" && i.ref === "DO-103"), JSON.stringify(again.issues.map((i) => i.code)));
  assert.ok(!again.issues.some((i) => i.code === "mounting_height_unset" && i.ref === "wall_outlet"));
  assert.ok(!again.issues.some((i) => i.code === "rack_size_unknown" && i.ref === "RK-101"));
});

test("labels keep their numbers across revisions: a removed cable's number is retired, new cables take the next one", () => {
  const first = draft();
  const before = new Map(first.cables.map((c) => [`${c.runId}|${c.to.equipment}|${c.to.port}`, c.label]));
  const removed = first.cables.filter((c) => c.runId === "run-b").map((c) => c.label);
  assert.ok(removed.length > 0, "run-b has cables to remove");
  const maxData = Math.max(...first.cables.filter((c) => c.kind === "data").map((c) => c.seq!));

  // the takeoff changes: outlet d2 and its run go, a new WAP w3 is linked
  const t = installTakeoff();
  t.shapes = (t.shapes as { id: string }[]).filter((s) => s.id !== "d2");
  t.cable_runs = (t.cable_runs as { id: string }[]).filter((r) => r.id !== "run-b");
  (t.shapes as unknown[]).push(
    { id: "w3", condition_id: "WAP", sheet_id: S1, measure_role: "count", verts_norm: [[0.75, 0.25]], computed: { count: 1 } },
    { id: "r8", condition_id: "ROUTE", sheet_id: S1, measure_role: "linear", verts_norm: [[0, 0], [1, 0]], computed: { perimeter_lf: 20 } },
  );
  (t.cable_runs as unknown[]).push({ id: "run-h", device_shape_ids: ["w3"], route_shape_ids: ["r8"], tr_id: "t1", provenance: { method: "manual", created_at: NOW } });
  const again = draft(t, { previous: first });

  for (const c of again.cables) {
    const was = before.get(`${c.runId}|${c.to.equipment}|${c.to.port}`);
    if (was) assert.equal(c.label, was, `${c.to.equipment} kept its printed label`);
  }
  for (const l of removed) assert.ok(!again.cables.some((c) => c.label === l), `${l} is retired, not reused`);
  const fresh = again.cables.filter((c) => c.runId === "run-h");
  assert.ok(fresh.length > 0);
  for (const c of fresh) assert.ok(c.kind !== "data" || c.seq! > maxData, `new cable ${c.label} continues after the highest number`);
  assert.equal(new Set(again.cables.map((c) => c.label)).size, again.cables.length, "labels stay unique");
});
