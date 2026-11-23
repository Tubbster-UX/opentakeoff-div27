// Cable label schemes: the default {type}{seq:2}, a spec-style pattern with
// rack / panel / port tokens, the {seq} order (rack, room, device tag) and the
// pattern validator. Invented tags and rooms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLabelScheme, DEFAULT_LABEL_SCHEME, defaultLabelScheme, sequenceNumbers, validateLabelScheme, type LabelContext } from "../src/install/labels.ts";
import type { InstallCable, InstallDevice, LabelScheme, Rack } from "../src/installTypes.ts";

const dev = (tag: string, room: string | null, rack: string): InstallDevice => ({
  tag, shapeId: `s-${tag}`, conditionId: "c", sheet: "T-101.pdf", at: [0, 0], room, deviceType: "wall_outlet", description: tag, rack,
});
const cab = (kind: InstallCable["kind"], device: string, port: string, rack: string, panel: string, pport: string): InstallCable => ({
  label: "", kind, cableType: kind === "fiber" ? "OM4" : "CAT6A", lengthFt: 100,
  from: { equipment: panel, port: pport, rack, location: rack }, to: { equipment: device, port, location: "x" },
});
const racks: Rack[] = [
  { id: "RK-101", name: "IDF-1", location: "IDF 1", sizeRU: 42, items: [{ tag: "PP-01", kind: "panel", ruTop: 42, ruHeight: 2 }, { tag: "PP-02", kind: "panel", ruTop: 39, ruHeight: 1 }] },
  { id: "RK-201", name: "IDF-2", location: "IDF 2", sizeRU: 24, items: [{ tag: "PP-03", kind: "panel", ruTop: 24, ruHeight: 1 }] },
];
const ctx: LabelContext = {
  devices: [dev("DO-102", "Office B", "RK-101"), dev("DO-101", "Office A", "RK-101"), dev("WAP-201", "Hall", "RK-201"), dev("DO-103", null, "RK-101")],
  racks,
  equipment: [],
};
// deliberately out of order: the scheme orders by rack, room, device tag, port
const cables = [
  cab("data", "WAP-201", "c1", "RK-201", "PP-03", "p1"),
  cab("data", "DO-102", "c1", "RK-101", "PP-01", "p3"),
  cab("data", "DO-101", "c2", "RK-101", "PP-01", "p2"),
  cab("data", "DO-101", "c1", "RK-101", "PP-01", "p1"),
  cab("fiber", "DO-102", "c2", "RK-101", "PP-02", "p1"),
  cab("data", "DO-103", "c1", "RK-101", "PP-02", "p12"),
];

test("labels: default scheme numbers per kind in rack, room, device order", () => {
  assert.equal(DEFAULT_LABEL_SCHEME.pattern, "{type}{seq:2}");
  assert.deepEqual(sequenceNumbers(cables, ctx), [5, 3, 2, 1, 1, 4]);
  const labels = applyLabelScheme(defaultLabelScheme(), cables, ctx);
  // RK-101: Office A DO-101 c1 D01, c2 D02; Office B DO-102 c1 D03; no room DO-103 D04; RK-201 WAP-201 D05; fiber F01
  assert.deepEqual(labels, ["D05", "D03", "D02", "D01", "F01", "D04"]);
});

test("labels: a spec pattern with TR, panel letter and port", () => {
  const scheme: LabelScheme = { source: "spec", reference: "27 05 53 3.2.B (invented)", description: "TR, panel letter, port", pattern: "{tr}{panel}-{port:2}", typeLetters: defaultLabelScheme().typeLetters };
  assert.deepEqual(validateLabelScheme(scheme).errors, []);
  const labels = applyLabelScheme(scheme, cables, ctx);
  assert.deepEqual(labels, ["2A-01", "1A-03", "1A-02", "1A-01", "1B-01", "1B-12"]);
  const withRoom = applyLabelScheme({ ...scheme, pattern: "{rack}/{device}/{type}{seq}/{room}" }, cables, ctx);
  assert.equal(withRoom[1], "RK-101/DO-102/D3/Office B");
  assert.equal(withRoom[5], "RK-101/DO-103/D4/");
});

test("labels: type letters can be changed per kind", () => {
  const s = defaultLabelScheme();
  s.typeLetters.data = "C";
  assert.equal(applyLabelScheme(s, cables, ctx)[3], "C01");
});

test("labels: the validator refuses unknown tokens and patterns that cannot be unique", () => {
  assert.match(validateLabelScheme({ pattern: "{type}{seqq}" }).errors.join(), /unknown token \{seqq\}/);
  assert.match(validateLabelScheme({ pattern: "{rack}-{device}" }).errors.join(), /cannot be unique/);
  assert.match(validateLabelScheme({ pattern: "{type}{seq:9}" }).errors.join(), /width/);
  assert.match(validateLabelScheme({ pattern: "{rack:2}{seq}" }).errors.join(), /only \{seq:N\} and \{port:N\}/);
  assert.match(validateLabelScheme({ pattern: "" }).errors.join(), /empty/);
  assert.match(validateLabelScheme({ pattern: "{type}{seq}}" }).errors.join(), /unbalanced/);
  assert.match(validateLabelScheme({ pattern: "{type}{seq}", typeLetters: { data: "too-long" } }).errors.join(), /typeLetters\.data/);
  const portOnly = validateLabelScheme({ pattern: "{port:2}" });
  assert.deepEqual(portOnly.errors, []);
  assert.equal(portOnly.warnings.length, 2, portOnly.warnings.join("; "));
  assert.throws(() => applyLabelScheme({ ...defaultLabelScheme(), pattern: "{room}" }, cables, ctx), /cannot be unique/);
});
