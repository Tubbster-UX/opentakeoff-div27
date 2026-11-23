// update_install_design's ops on the invented draft: validation refusals,
// port moves, connections, rack items, equipment from the library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftInstallDesign } from "../src/install/baseline.ts";
import { applyInstallOps, type InstallOp } from "../src/install/ops.ts";
import { emptyEquipmentLibrary, normaliseEquipment } from "../src/equipmentLib.ts";
import type { EquipmentLibrary } from "../src/installTypes.ts";
import { installTakeoff } from "./installFixture.ts";

const base = () => draftInstallDesign({ takeoff: installTakeoff(), project: "invented", now: "2026-11-21T00:00:00Z" });
const lib: EquipmentLibrary = {
  schema: "brink.equipment.v1",
  entries: [
    normaliseEquipment({ manufacturer: "Invented Audio", model: "A-120", description: "2-channel amplifier", ruHeight: 2, watts: 300, ports: [{ id: "z1", label: "ZONE 1", signal: "speaker" }], source: "Invented A-120 sheet", date: "2026-11-01" }),
    normaliseEquipment({ manufacturer: "Invented Audio", model: "WP-1", description: "Wall volume control", ruHeight: 0, watts: null, ports: [], source: "Invented WP-1 sheet", date: "2026-11-01" }),
  ],
};
const apply = (ops: InstallOp[], d = base()) => applyInstallOps(d, ops, lib);

test("ops: assign_port moves a cable to a free port; taken ports and other racks are refused", () => {
  const { design } = apply([{ op: "assign_port", cable: "D01", panel: "PP-01", port: "p20" }]);
  const c = design.cables.find((x) => x.to.equipment === "DO-101" && x.to.port === "c1")!;
  assert.deepEqual([c.from.equipment, c.from.port], ["PP-01", "p20"]);
  assert.ok(design.connections.some((x) => x.id === "fc-d1-c1" && x.from.port === "p20"));
  assert.throws(() => apply([{ op: "assign_port", cable: "D01", panel: "PP-01", port: "p2" }]), /already terminates cable D02/);
  assert.throws(() => apply([{ op: "assign_port", cable: "D01", panel: "PP-02", port: "p10" }]), /in rack RK-201; cable D01 homes to RK-101/);
  assert.throws(() => apply([{ op: "assign_port", cable: "D01", panel: "DO-103", port: "c1" }]), /field device/);
});

test("ops: equipment from the library, RU from its spec sheet, overlaps refused, removal rules", () => {
  const { design } = apply([
    { op: "set_rack", rack: "RK-101", sizeRU: 12 },
    { op: "add_equipment", tag: "AMP-01", key: "Invented Audio:A-120" },
    { op: "place_in_rack", tag: "AMP-01", rack: "RK-101", ruTop: 10 },
    { op: "place_in_rack", tag: "BLANK-1", rack: "RK-101", ruTop: 8, ruHeight: 1, kind: "blank" },
    { op: "connect", from: { equipment: "AMP-01", port: "z1" }, to: { equipment: "PP-01", port: "p24" }, kind: "speaker" },
  ]);
  const amp = design.equipment.find((e) => e.tag === "AMP-01")!;
  assert.deepEqual([amp.rack, amp.watts, amp.libraryKey, amp.ports[0].label], ["RK-101", 300, "inventedaudio:a120", "ZONE 1"]);
  assert.deepEqual(design.racks[0].items.map((it) => [it.tag, it.ruTop, it.ruHeight]), [["PP-01", 12, 1], ["AMP-01", 10, 2], ["BLANK-1", 8, 1]]);
  assert.ok(design.issues.some((i) => i.code === "rack_circuit_unknown" && /300 W known, about 1023\.6 BTU\/hr/.test(i.message)));
  assert.throws(() => apply([{ op: "place_in_rack", tag: "PP-01", rack: "RK-101", ruTop: 10 }], design), /overlaps AMP-01/);
  assert.throws(() => apply([{ op: "place_in_rack", tag: "AMP-01", rack: "RK-101", ruTop: 14 }], design), /outside/);
  assert.throws(() => apply([{ op: "add_equipment", tag: "VC-1", key: "inventedaudio:wp1" }, { op: "place_in_rack", tag: "VC-1", rack: "RK-101", ruTop: 5 }], design), /not rack gear/);
  assert.throws(() => apply([{ op: "add_equipment", tag: "X-1", key: "nobody:nothing" }], design), /record_equipment/);
  assert.throws(() => apply([{ op: "remove_equipment", tag: "PP-01" }], design), /assign_port them elsewhere first/);
  assert.throws(() => apply([{ op: "remove_equipment", tag: "DO-101" }], design), /field device from the takeoff/);
  assert.throws(() => apply([{ op: "connect", from: { equipment: "AMP-01", port: "z1" }, to: { equipment: "PP-01", port: "p23" } }], design), /already used by connection pc-1/);
  assert.throws(() => apply([{ op: "disconnect", id: "fc-d1-c1" }], design), /assign_port/);
  const { design: after } = apply([{ op: "disconnect", equipment: "AMP-01", port: "z1" }, { op: "remove_equipment", tag: "AMP-01" }, { op: "remove_equipment", tag: "BLANK-1" }], design);
  assert.ok(!after.equipment.some((e) => e.tag === "AMP-01"));
  assert.deepEqual(after.racks[0].items.map((it) => it.tag), ["PP-01"]);
  assert.ok(!after.connections.some((c) => c.id === "pc-1"));
});

test("ops: set_rack refuses a size below its items; hand labels and spare; mounting for a missing type refused", () => {
  const { design } = apply([{ op: "set_rack", rack: "RK-101", sizeRU: 12 }]);
  assert.throws(() => apply([{ op: "set_rack", rack: "RK-101", sizeRU: 6 }], design), /items reach RU 12/);
  const { design: d2 } = apply([{ op: "set_cable", label: "D03", newLabel: "OPEN-1", spare: true }], design);
  const c = d2.cables.find((x) => x.label === "OPEN-1")!;
  assert.deepEqual([c.labelOverride, c.spare], [true, true]);
  assert.throws(() => apply([{ op: "set_cable", label: "D04", newLabel: "OPEN-1" }], d2), /already on another cable/);
  const { design: d3 } = apply([{ op: "set_cable", label: "OPEN-1", newLabel: null }], d2);
  assert.ok(d3.cables.some((x) => x.label === "D03" && !x.labelOverride));
  assert.throws(() => apply([{ op: "set_mounting", deviceType: "projector", heightAff: "x" }]), /no device of type projector/);
  assert.throws(() => applyInstallOps(base(), [{ op: "set_device", tag: "NOPE-1", room: "x" }], emptyEquipmentLibrary()), /ops\[0\] \(set_device\): no device NOPE-1/);
});
