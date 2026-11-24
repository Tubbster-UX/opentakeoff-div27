// Reconcile and quote inputs, pure: the invented takeoff (test/installFixture.ts)
// against an invented D-Tools quote (test/dtoolsFake.ts inventedQuote). No real
// job, product or price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { takeoffFacts, reconcile, type Difference } from "../src/dtools/reconcile.ts";
import { catalogCsv, catalogRow, csvField, neededProducts, scopeText, CATALOG_COLUMNS } from "../src/dtools/quoteInputs.ts";
import type { DtoolsMapping } from "../src/dtools/store.ts";
import type { DtQuoteDetail } from "../src/dtools/client.ts";
import { installTakeoff } from "./installFixture.ts";
import { inventedQuote } from "./dtoolsFake.ts";

const mapping = (): DtoolsMapping => ({
  schema: "brink.dtools-mapping.v1",
  conditions: { DO: { brand: "Invented Co", model: "DO-2" }, wap: { partNumber: "IW-AP9" }, CAM: { brand: "Invented Cams", model: "C-1" } },
  cables: { "CAT6A plenum": { brand: "Invented Cable", model: "C6A-PL" } },
  rooms: { "Open Office": "Open Office Area", "Storage 202": "Conference 201" },
});

test("takeoff facts: EA per condition, cable feet per type (measured and with waste), device rooms", () => {
  const f = takeoffFacts(installTakeoff());
  const ea = Object.fromEntries(f.conditions.map((c) => [c.tag, c.ea]));
  assert.deepEqual(ea, { DO: 4, WAP: 3, CAM: 1, ACD: 1, TR: 2 }, "routes and floor areas are not devices");
  assert.equal(f.conditions.find((c) => c.tag === "DO")!.label, "Data outlet, 2-port (CAT6A plenum)");
  // CAT6A: d1 120×2 + d2 170×2 + w1 300 + w2 60 + d3 70×2 = 1080 ft; +10% waste = 1188
  assert.deepEqual(f.cables, [{ cableType: "CAT6A plenum", measuredFt: 1080, orderFt: 1188 }, { cableType: "CAT6 outdoor", measuredFt: 80, orderFt: 88 }]);
  assert.equal(f.roomSource, "takeoff");
  const room = (r: string, t: string) => f.rooms!.find((x) => x.room === r && x.tag === t)?.count ?? 0;
  assert.deepEqual([room("Office 101", "DO"), room("Open Office", "DO"), room("Open Office", "WAP"), room("Storage 202", "DO"), room("(room unknown)", "CAM")], [2, 1, 2, 1, 1]);
  // a saved install design's rooms win
  const design = { devices: [{ room: "Lab 9", conditionId: "DO" }] } as never;
  const g = takeoffFacts(installTakeoff(), design);
  assert.equal(g.roomSource, "install_design");
  assert.deepEqual(g.rooms, [{ room: "Lab 9", conditionId: "DO", tag: "DO", count: 1 }]);
});

test("reconcile: mapped and unmapped conditions, room → location mapping, cable feet vs length items, ordered by money", () => {
  const facts = takeoffFacts(installTakeoff());
  const quote = inventedQuote("opp-1", "q-1") as DtQuoteDetail;
  const r = reconcile(facts, quote, mapping(), { catalogPrices: { "bm:inventedcams:c1": 250 } });
  const find = (kind: Difference["kind"], product: string, room?: string) => r.differences.find((d) => d.kind === kind && d.product.includes(product) && (room === undefined || d.room === room));

  // WAP mapped by part number (case-insensitive condition key): takeoff 3, quote 1 at $600 → $1200, the biggest
  assert.equal(r.differences[0].kind, "product_qty");
  assert.match(r.differences[0].product, /IW-AP9/);
  assert.deepEqual([r.differences[0].takeoff, r.differences[0].quote, r.differences[0].difference, r.differences[0].impact], [3, 1, -2, 1200]);
  // ordered by money impact, unpriced last
  const impacts = r.differences.map((d) => d.impact ?? -1);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a));

  // quote-only rack: $900
  const rack = find("quote_only", "R-42")!;
  assert.deepEqual([rack.quote, rack.impact, rack.location], [1, 900, "Lobby"]);
  // camera in the takeoff, not in the quote, priced from the catalog
  const cam = find("missing_from_quote", "C-1")!;
  assert.deepEqual([cam.takeoff, cam.quote, cam.unitPrice, cam.impact], [1, 0, 250, 250]);
  // CAT6A: 1188 ft to order vs 1 × 1000 ft in the quote at $0.45/ft
  const c6a = find("cable_ft", "C6A-PL")!;
  assert.deepEqual([c6a.takeoff, c6a.quote, c6a.difference, c6a.impact], [1188, 1000, -188, 84.6]);
  // data outlets: 4 vs 5 overall
  const dO = find("product_qty", "DO-2")!;
  assert.deepEqual([dO.takeoff, dO.quote, dO.impact], [4, 5, 40]);
  // per room: "Office 101" matches the quote's "101 office" (word order), Storage 202 → Conference 201 by the mapping: both agree
  assert.equal(find("location_qty", "DO-2", "Office 101"), undefined);
  assert.equal(find("location_qty", "DO-2", "Storage 202"), undefined);
  // Open Office → Open Office Area (mapping): DO 1 vs 2, WAP 2 vs 1
  assert.deepEqual([find("location_qty", "DO-2", "Open Office")!.takeoff, find("location_qty", "DO-2", "Open Office")!.quote], [1, 2]);
  assert.equal(find("location_qty", "DO-2", "Open Office")!.location, "Open Office Area");
  assert.deepEqual([find("location_qty", "IW-AP9", "Open Office")!.takeoff, find("location_qty", "IW-AP9", "Open Office")!.quote], [2, 1]);
  // unmapped: reported, never guessed
  assert.ok(find("unmapped_condition", "Access control door"));
  assert.ok(r.differences.some((d) => d.kind === "unmapped_condition" && d.conditions?.[0] === "TR"));
  assert.ok(find("unmapped_cable", "CAT6 outdoor"));
  assert.ok(r.differences.filter((d) => d.kind.startsWith("unmapped")).every((d) => d.impact === null));
  // labor skipped, notes say so; no unmatched rooms (all mapped or matched)
  assert.equal(r.quote.skipped, 1);
  assert.deepEqual(r.unmatchedRooms, []);
  assert.ok(r.notes.some((n) => /1 device sits in no labeled room/.test(n)), r.notes.join(" | "));
  assert.equal(r.moneyAtStake, 1200 + 900 + 250 + 84.6 + 40);

  // without the room mapping, Storage 202 matches no location and is reported
  const m2 = mapping();
  delete m2.rooms["Storage 202"];
  const r2 = reconcile(facts, quote, m2);
  assert.deepEqual(r2.unmatchedRooms, [{ room: "Storage 202", devices: 1 }]);
  assert.ok(r2.differences.some((d) => d.kind === "location_qty" && d.location === "Conference 201" && d.room === undefined && d.quote === 1), "the quote's Conference 201 outlet has no takeoff room");
  assert.equal(r2.differences.find((d) => d.kind === "missing_from_quote")!.impact, null, "no catalog price: impact unknown");

  // a quote that matches: nothing but the unmapped items
  const exact = structuredClone(quote);
  exact.items = [
    { id: 1, brand: "Invented Co", model: "DO-2", quantity: 2, location: "101 office", locationId: 1, unitPrice: 40 },
    { id: 2, brand: "Invented Co", model: "DO-2", quantity: 1, location: "Open Office Area", locationId: 2, unitPrice: 40 },
    { id: 3, brand: "Invented Co", model: "DO-2", quantity: 1, location: "Conference 201", locationId: 3, unitPrice: 40 },
    { id: 4, model: "AP-9", partNumber: "iw-ap9", quantity: 2, location: "Open Office Area", locationId: 2, unitPrice: 600 },
    { id: 5, model: "AP-9", partNumber: "IW-AP9", quantity: 1, location: "Conference 201", locationId: 3, unitPrice: 600 },
    { id: 6, brand: "Invented Cams", model: "C-1", quantity: 1, location: "Lobby", locationId: 4, unitPrice: 250 },
    { id: 7, brand: "Invented Cable", model: "C6A-PL", quantity: 2, isLengthBased: true, length: 594, pricePerLength: 0.45, location: "Lobby", locationId: 4 },
  ];
  const r3 = reconcile(facts, exact, mapping());
  assert.deepEqual(r3.differences.map((d) => d.kind).sort(), ["unmapped_cable", "unmapped_condition", "unmapped_condition"]);
  assert.equal(r3.matched.length, 4);
});

test("quote inputs: catalog CSV in D-Tools' import columns and the scope by location", () => {
  const facts = takeoffFacts(installTakeoff());
  const { needed, unmapped } = neededProducts(facts, mapping());
  assert.deepEqual(needed.map((n) => [n.ref.model ?? n.ref.partNumber, n.quantity, n.unit]), [["DO-2", 4, "EA"], ["IW-AP9", 3, "EA"], ["C-1", 1, "EA"], ["C6A-PL", 1188, "FT"]]);
  assert.deepEqual(unmapped, ["ACD (Access control door (18/6 shielded), 1 EA)", "TR (TR, 2 EA)", "cable CAT6 outdoor (88 ft)"]);

  const csv = catalogCsv([catalogRow(needed[2], { unitCost: 199.5 }), catalogRow({ ...needed[0], ref: { ...needed[0].ref, description: "Outlet, \"2-port\", white" } })]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "Brand,Model,Part Number,Short Description,Description,Category,Keywords,MSRP,Unit Cost,Unit Price,Taxable,Supplier,System,Phase");
  assert.equal(lines[0].split(",").length, CATALOG_COLUMNS.length);
  assert.equal(lines[1], "Invented Cams,C-1,,Camera (CAT6 outdoor),Camera (CAT6 outdoor) (takeoff: CAM),,CAM,,199.5,,,,,");
  assert.match(lines[2], /^Invented Co,DO-2,,"Data outlet, 2-port \(CAT6A plenum\)","Outlet, ""2-port"", white",/);
  assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
  // a part-number-only product: Model carries the part number
  assert.equal(catalogRow(needed[1]).Model, "IW-AP9");

  const text = scopeText({ projectName: "Invented Clinic", date: "2026-11-24", facts, mapping: mapping() });
  assert.match(text, /^Scope by location: Invented Clinic \(from the takeoff, 2026-11-24\)/);
  assert.match(text, /\nOffice 101: 2 x Data outlet, 2-port \(CAT6A plenum\) \[DO; Invented Co DO-2\]\n/);
  assert.match(text, /\nOpen Office Area \(takeoff room Open Office\): 1 x Data outlet, 2-port \(CAT6A plenum\) \[DO; Invented Co DO-2\], 2 x Wireless access point \(CAT6A plenum\) \[WAP; part IW-AP9\]\n/);
  assert.match(text, /\nConference 201 \(takeoff room Storage 202\): 1 x Data outlet/);
  assert.match(text, /\nNo room \(place these by hand\): 1 x Camera \(CAT6 outdoor\) \[CAM; Invented Cams C-1\]\n/);
  assert.match(text, /\nNot placed in a room: .*2 x TR \[TR\]/);
  assert.match(text, /\n {2}CAT6A plenum: 1,188 ft \(1,080 ft measured\) \[Invented Cable C6A-PL\]\n/);
  assert.match(text, /\n {2}CAT6 outdoor: 88 ft \(80 ft measured\)\n/);
});
