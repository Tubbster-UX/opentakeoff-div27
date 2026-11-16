// Settings in a local file store: defaults with no numbers, deep-merge
// updates, validation (fractions, ≥ 0, unit sets), the change log, the playbook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsStorage } from "../src/storage.ts";
import { StoreSettings, defaultSettings, deepMerge, settingsProblems, SETTINGS_KEY } from "../src/settings.ts";

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });
async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "brink-settings-"));
  roots.push(root);
  let tick = 0;
  const storage = new FsStorage(root);
  return { storage, settings: new StoreSettings(storage, () => `2026-11-16T10:00:${String(tick++).padStart(2, "0")}.000Z`) };
}

test("settings: defaults carry no rates, prices or hours", async () => {
  const { settings } = await store();
  const s = await settings.get();
  assert.equal(s.schema, "brink.settings.v1");
  assert.deepEqual(s.markup, { materialPct: null, overheadPct: null, profitPct: null, excisePct: null, bondPct: null });
  assert.deepEqual([s.labor.targetBillRate, s.labor.trueCostRate, s.labor.crewSize, s.labor.hoursPerDay, s.labor.pmPctOfField, s.travel.mileageRate, s.proposal.validityDays], [null, null, null, null, null, null, null]);
  assert.deepEqual(s.labor.unitSets, [
    { id: "standard", label: "Standard", units: [] },
    { id: "lowered", label: "Lowered (open ceilings, short runs)", units: [] },
  ]);
  assert.equal(s.labor.defaultUnitSet, "standard");
  assert.deepEqual(s.changeLog, []);
  assert.deepEqual(settingsProblems(defaultSettings()), []);
});

test("settings: update deep-merges objects, replaces arrays, validates and logs", async () => {
  const { settings, storage } = await store();
  const r1 = await settings.update({ markup: { materialPct: 0.15, overheadPct: 0.1 }, company: { brand: "Invented Low Voltage", address: ["1 Example St", "Nowhere, SD"] } }, "claude");
  assert.equal(r1.settings.markup.materialPct, 0.15);
  assert.equal(r1.settings.markup.profitPct, null, "untouched keys keep their value");
  assert.equal(r1.settings.company.legalName, "", "sibling company fields survive the merge");
  assert.ok(r1.changes.some((c) => c.startsWith("markup.materialPct: null → 0.15")), r1.changes.join("\n"));
  const stored = JSON.parse(Buffer.from((await storage.getBytes(SETTINGS_KEY))!).toString("utf8"));
  assert.equal(stored.markup.overheadPct, 0.1);
  assert.equal(stored.changeLog.length, 1);
  assert.equal(stored.changeLog[0].by, "claude");
  assert.match(stored.changeLog[0].what, /company\.brand/);

  // arrays replace whole
  const r2 = await settings.update({ company: { address: ["2 Example Ave"] } }, "owner");
  assert.deepEqual(r2.settings.company.address, ["2 Example Ave"]);
  assert.equal((await settings.get()).changeLog.at(-1)?.by, "owner");

  // unit sets replace whole, and the default must exist
  const sets = [{ id: "standard", label: "Standard", units: [{ id: "wall_first", label: "Wall, first cable", hours: 1, per: "location_first" }] }];
  const r3 = await settings.update({ labor: { unitSets: sets, targetBillRate: 80 } }, "claude");
  assert.deepEqual(r3.settings.labor.unitSets, sets);
  assert.equal(r3.settings.labor.hoursPerDay, null);

  // a no-op logs nothing
  const before = (await settings.get()).changeLog.length;
  const r4 = await settings.update({ labor: { targetBillRate: 80 } }, "claude");
  assert.deepEqual(r4.changes, []);
  assert.equal((await settings.get()).changeLog.length, before);
});

test("settings: bad values are refused and nothing is saved", async () => {
  const { settings } = await store();
  await assert.rejects(settings.update({ markup: { materialPct: 15 } }, "claude"), /fraction: 0\.15 means 15%/);
  await assert.rejects(settings.update({ labor: { targetBillRate: -1 } }, "claude"), /must be 0 or more/);
  await assert.rejects(settings.update({ labor: { crewSize: 1.5 } }, "claude"), /whole number/);
  await assert.rejects(settings.update({ labor: { hoursPerDay: "8" } }, "claude"), /number or null/);
  await assert.rejects(settings.update({ labor: { defaultUnitSet: "fast" } }, "claude"), /not one of the unit sets/);
  await assert.rejects(settings.update({ labor: { unitSets: [{ id: "standard", label: "S", units: [{ id: "x", label: "x", hours: 1, per: "minute" }] }] } }, "claude"), /per must be one of/);
  await assert.rejects(settings.update({ changeLog: [] }, "claude"), /cannot be set/);
  await assert.rejects(settings.update({ rates: {} }, "claude"), /unknown settings section/);
  await assert.rejects(settings.update([] as unknown, "claude"), /patch must be an object/);
  assert.deepEqual((await settings.get()).changeLog, [], "nothing was saved");
  // null clears a number back to unset
  await settings.update({ markup: { bondPct: 0.02 } }, "claude");
  const r = await settings.update({ markup: { bondPct: null } }, "claude");
  assert.equal(r.settings.markup.bondPct, null);
});

test("settings: playbook text round-trips and is logged", async () => {
  const { settings } = await store();
  assert.equal(await settings.getPlaybook(), null);
  await settings.setPlaybook("# Invented playbook\n\nRead the spec first.", "claude");
  assert.equal(await settings.getPlaybook(), "# Invented playbook\n\nRead the spec first.");
  assert.match((await settings.get()).changeLog.at(-1)!.what, /playbook replaced \(\d+ characters\)/);
});

test("settings: deepMerge semantics", () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] }), { a: { b: 1, c: 3 }, l: [9] });
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
});
