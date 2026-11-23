// The equipment library: validated spec-sheet entries with source and date,
// history appended (newest wins), exact repeats dropped, port groups expanded.
// Invented gear only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./fakes.ts";
import { EQUIPMENT_KEY, StoreEquipmentLibrary, equipmentKey, expandPortGroups, normaliseEquipment, type EquipmentSpecInput } from "../src/equipmentLib.ts";

const sw = (over: Partial<EquipmentSpecInput> = {}): EquipmentSpecInput => ({
  manufacturer: "Invented Networks", model: "SW-24P", description: "24-port PoE switch",
  ruHeight: 1, watts: 370, portGroups: [{ prefix: "p", count: 24, label: "PORT {n}", signal: "ethernet", poe: true, connector: "RJ45" }],
  source: "https://invented.example/sw-24p.pdf", date: "2026-11-01", ...over,
});

test("equipment library: record, look up by key, newest wins, repeats dropped", async () => {
  const storage = new MemStorage();
  const lib = new StoreEquipmentLibrary(storage);
  assert.deepEqual((await lib.all()).entries, []);
  const r1 = await lib.record([sw(), { manufacturer: "Invented Audio", model: "A-120", description: "2-channel amplifier", ruHeight: 2, watts: null, ports: [{ id: "zone1", label: "ZONE 1", signal: "speaker", direction: "out" }], source: "Invented Audio A-120 spec sheet rev B", date: "2026-10-15" }]);
  assert.equal(r1.added.length, 2);
  assert.equal(r1.added[0].key, "inventednetworks:sw24p");
  assert.equal(r1.added[0].ports.length, 24);
  assert.deepEqual(r1.added[0].ports[23], { id: "p24", label: "PORT 24", signal: "ethernet", connector: "RJ45", poe: true });
  assert.equal(r1.added[1].watts, null);
  assert.ok(await storage.getBytes(EQUIPMENT_KEY));

  const again = await lib.record([sw()]);
  assert.deepEqual([again.added.length, again.duplicates.length], [0, 1]);
  await lib.record([sw({ watts: 395, date: "2026-11-18", source: "https://invented.example/sw-24p-rev2.pdf" })]);
  await lib.record([sw({ watts: 300, date: "2026-09-01" })]); // older: kept in history, not used
  assert.equal((await lib.all()).entries.length, 4);
  assert.equal((await lib.lookup("Invented Networks:SW-24P"))?.watts, 395);
  assert.equal((await lib.lookup(equipmentKey("invented networks", "sw 24p")))?.date, "2026-11-18");
  assert.equal(await lib.lookup("nobody:nothing"), null);

  const found = await lib.find("poe switch");
  assert.deepEqual(found.map((e) => [e.key, e.watts]), [["inventednetworks:sw24p", 395]], "newest per model");
  assert.equal((await lib.find("A120"))[0].model, "A-120");
  assert.deepEqual(await lib.find("fiber"), []);
});

test("equipment library: entries need source, date, RU and honest watts", () => {
  assert.throws(() => normaliseEquipment(sw({ source: "" })), /source is required/);
  assert.throws(() => normaliseEquipment(sw({ date: "last week" })), /YYYY-MM-DD/);
  assert.throws(() => normaliseEquipment(sw({ ruHeight: 1.5 })), /ruHeight/);
  assert.throws(() => normaliseEquipment(sw({ watts: -1 })), /watts/);
  assert.throws(() => normaliseEquipment(sw({ model: "" })), /model is required/);
  assert.throws(() => normaliseEquipment(sw({ ports: [{ id: "p1", label: "x", signal: "ethernet" }] })), /p1 appears twice/);
  assert.throws(() => normaliseEquipment(sw({ portGroups: [], ports: [{ id: "p1", label: "x", signal: "" }] })), /needs a signal/);
  assert.deepEqual(expandPortGroups([{ prefix: "z", count: 2, signal: "speaker", start: 3 }]).map((p) => [p.id, p.label]), [["z3", "Z 3"], ["z4", "Z 4"]]);
});
