// The install design check on a small invented design: every rule fires once,
// errors come first, and a clean design has no issues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInstallDesign, rackPower } from "../src/install/check.ts";
import { defaultLabelScheme } from "../src/install/labels.ts";
import type { InstallDesign } from "../src/installTypes.ts";

function clean(): InstallDesign {
  const port = (id: string, signal = "ethernet") => ({ id, label: id.toUpperCase(), signal });
  return {
    schema: "brink.install.v1", project: "invented", revision: 4, created: "2026-11-21T00:00:00Z",
    labelScheme: defaultLabelScheme(),
    devices: [
      { tag: "DO-101", shapeId: "d1", conditionId: "DO", sheet: "T-101.pdf", at: [0.1, 0.1], room: "Office 101", deviceType: "wall_outlet", description: "Wall outlet", rack: "RK-101" },
      { tag: "WAP-101", shapeId: "w1", conditionId: "WAP", sheet: "T-101.pdf", at: [0.5, 0.1], room: "Hall", deviceType: "wap", description: "WAP", rack: "RK-101", mountingHeight: "Ceiling grid" },
    ],
    cables: [
      { label: "D01", kind: "data", cableType: "CAT6A", runId: "r1", lengthFt: 120, from: { equipment: "PP-01", port: "p1", rack: "RK-101", location: "RK-101 IDF-1" }, to: { equipment: "DO-101", port: "c1", location: "Office 101" } },
      { label: "D02", kind: "data", cableType: "CAT6A", runId: "r2", lengthFt: 90, from: { equipment: "PP-01", port: "p2", rack: "RK-101", location: "RK-101 IDF-1" }, to: { equipment: "WAP-101", port: "c1", location: "Hall" } },
    ],
    equipment: [
      { tag: "PP-01", description: "24-port patch panel", location: "RK-101", rack: "RK-101", ports: Array.from({ length: 24 }, (_, i) => port(`p${i + 1}`)), watts: 0 },
      { tag: "SW-01", description: "Invented switch", location: "RK-101", rack: "RK-101", ports: [port("p1"), port("p2")], watts: 150 },
      { tag: "DO-101", description: "Wall outlet", location: "Office 101", ports: [port("c1")] },
      { tag: "WAP-101", description: "WAP", location: "Hall", ports: [port("c1")] },
    ],
    connections: [
      { id: "fc-d1-c1", cable: "D01", kind: "data", from: { equipment: "PP-01", port: "p1" }, to: { equipment: "DO-101", port: "c1" } },
      { id: "fc-w1-c1", cable: "D02", kind: "data", from: { equipment: "PP-01", port: "p2" }, to: { equipment: "WAP-101", port: "c1" } },
      { id: "pc-1", kind: "patch", from: { equipment: "PP-01", port: "p1" }, to: { equipment: "SW-01", port: "p1" } },
    ],
    racks: [{ id: "RK-101", name: "IDF-1", location: "IDF 1", sizeRU: 12, items: [{ tag: "PP-01", kind: "panel", ruTop: 12, ruHeight: 1 }, { tag: "SW-01", kind: "equipment", ruTop: 10, ruHeight: 1 }], circuits: [{ label: "20A dedicated", amps: 20 }] }],
    mounting: [{ deviceType: "wall_outlet", title: "Wall outlet", heightAff: "18 in. AFF to center", box: "1-gang", notes: [] }, { deviceType: "wap", title: "WAP", heightAff: "", box: "", notes: [] }],
    issues: [],
    status: "draft",
  };
}

test("check: a clean design has no issues (a patch on a panel's front and a field cable on its rear share a port)", () => {
  assert.deepEqual(checkInstallDesign(clean()), []);
  const pw = rackPower(clean(), clean().racks[0]);
  assert.deepEqual(pw, { watts: 150, unknown: [], capacityW: 1920, btuHr: 511.8 });
});

test("check: every rule fires, errors first", () => {
  const d = clean();
  d.labelScheme = { ...d.labelScheme, pattern: "{rack}-{seq:3}" };                         // non-default, no reference
  d.cables[1].label = "D01";                                                                  // duplicate label
  d.devices.push({ ...d.devices[0], shapeId: "d9", room: null });                             // duplicate tag, no room
  d.cables.push({ ...d.cables[0], label: "D03", to: { equipment: "WAP-101", port: "c1", location: "Hall" }, lengthFt: null }); // port twice, unmeasured
  d.cables.push({ ...d.cables[0], label: "D04", from: { ...d.cables[0].from, port: "p5" }, to: { equipment: "DO-101", port: "c9", location: "x" }, lengthFt: 310 }); // missing port, over length
  d.connections.push({ id: "pc-2", kind: "patch", from: { equipment: "SW-01", port: "p1" }, to: { equipment: "GONE-1", port: "p1" } }); // switch p1 twice, missing equipment
  d.equipment.push({ tag: "AMP-01", description: "Invented amplifier", location: "RK-101", rack: "RK-101", ports: [], watts: null }); // power unknown, unplaced
  d.equipment.find((e) => e.tag === "SW-01")!.watts = 1900;                                   // 1900 W known
  d.racks[0].circuits = [{ label: "15A shared", amps: 15 }];                                  // 15 A × 120 V × 80 % = 1440 W
  d.racks[0].items.push({ tag: "BLANK-1", kind: "blank", ruTop: 10, ruHeight: 2 });           // overlaps SW-01
  d.racks[0].items.push({ tag: "SHELF-1", kind: "shelf", ruTop: 14, ruHeight: 1 });           // outside a 12 RU rack
  d.racks.push({ id: "RK-201", name: "IDF-2", location: "IDF 2", sizeRU: 0, items: [] });     // no size
  d.devices.push({ ...d.devices[0], tag: "CAM-101", shapeId: "c1", deviceType: "camera" });   // no mounting detail
  const issues = checkInstallDesign(d);
  const codes = issues.map((i) => `${i.severity}:${i.code}`);
  const want = [
    "error:label_scheme_unreferenced", "error:label_duplicate", "error:tag_duplicate", "error:connection_missing_end", "error:port_double_used",
    "error:cable_end_missing", "error:ru_overlap", "error:ru_outside", "error:rack_power_over", "error:rack_size_unknown", "error:mounting_height_unset",
    "warning:power_unknown", "warning:equipment_unplaced", "warning:length_unmeasured", "warning:cable_over_length", "warning:room_unknown",
  ];
  for (const w of want) assert.ok(codes.includes(w), `${w} missing from ${codes.join(", ")}`);
  const firstWarning = issues.findIndex((i) => i.severity === "warning");
  assert.ok(issues.slice(0, firstWarning).every((i) => i.severity === "error") && issues.slice(firstWarning).every((i) => i.severity === "warning"));
  const power = issues.find((i) => i.code === "rack_power_over")!;
  assert.match(power.message, /1900 W known, about 6482\.8 BTU\/hr of heat exceeds its circuits' 1440 W at 80% continuous/);
  assert.match(issues.find((i) => i.code === "power_unknown")!.message, /AMP-01/);
  assert.match(issues.find((i) => i.code === "mounting_height_unset")!.message, /camera/);
  assert.ok(!issues.some((i) => i.code === "mounting_height_unset" && i.ref === "wap"), "every WAP states its own height");
  assert.ok(issues.some((i) => i.code === "port_double_used" && i.ref === "SW-01:p1"));
  assert.ok(issues.some((i) => i.code === "port_double_used" && i.ref === "WAP-101:c1"));
});

test("check: a spec scheme needs its reference; 120 V is the default and stated volts count", () => {
  const d = clean();
  d.labelScheme = { ...d.labelScheme, source: "spec", pattern: "{tr}{panel}-{port:2}" };
  assert.deepEqual(checkInstallDesign(d).map((i) => i.code), ["label_scheme_unreferenced"]);
  d.labelScheme.reference = "27 05 53 3.2.B (invented)";
  assert.deepEqual(checkInstallDesign(d), []);
  d.racks[0].circuits = [{ label: "208 V 20A", amps: 20, volts: 208 }];
  assert.equal(rackPower(d, d.racks[0]).capacityW, 3328);
  d.racks[0].circuits = [];
  assert.deepEqual(checkInstallDesign(d).map((i) => i.code), ["rack_circuit_unknown"]);
});
