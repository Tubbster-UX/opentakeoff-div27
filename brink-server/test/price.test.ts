// The pricing engine on an invented takeoff with invented rates and prices.
// Every expected number is worked by hand in the comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceBid, parseUnit, pricePerLineUnit, r2, type TakeoffDoc } from "../src/bid/price.ts";
import { defaultSettings } from "../src/settings.ts";
import type { BidJobInputs, BidSettings, LaborUnit, PriceBook, PriceEntry } from "../src/bidTypes.ts";
import { priceKey } from "../src/pricebook.ts";

const NOW = "2026-11-16T12:00:00.000Z";

const cond = (id: string, extra: Record<string, unknown> = {}) => ({ id, finish_tag: id, color: "#000", multiplier: 1, waste_pct: 10, materials: [], ...extra });
const setup = (device_type: string, extra: Record<string, unknown> = {}) => ({ device_type, cables_per_location: 1, cable_type: "CAT6A-PL", vertical_ft: 10, loop_device_ft: 5, loop_tr_ft: 5, ...extra });
const count = (id: string, condition_id: string, sheet_id: string, label?: string) => ({ id, condition_id, sheet_id, measure_role: "count", verts_norm: [[0.1, 0.1]], computed: { count: 1 }, ...(label ? { label } : {}) });
const line = (id: string, sheet_id: string, lf: number) => ({ id, condition_id: "ROUTE", sheet_id, measure_role: "linear", verts_norm: [[0, 0], [0.5, 0]], computed: { perimeter_lf: lf } });
const run = (id: string, dev: string, routes: string[], tr = "t1") => ({ id, device_shape_ids: [dev], route_shape_ids: routes, tr_id: tr, provenance: { method: "manual", created_at: NOW } });

/**
 * DATA-2 (wall, 2 cables/location, 1000 ft box): run A d1 → r1 100 ft → TR on E-101; d2 unlinked.
 * WAP (1 cable): run B w1 → r2 240 ft; run C w2 on E-201 → r3 200 ft (E-201) + r4 90 ft (E-101).
 * CAM (camera, 1 cable): run D c1 → r5 50 ft.
 * Per cable = route + 10 vertical + 5 + 5 loops: A 120, B 260, C 310, D 70.
 * Cable LF 240 + 260 + 310 + 70 = 880; order with 10% waste 968 → 1 box of 1000 ft.
 */
function takeoff(): TakeoffDoc {
  return {
    schema: "opentakeoff.takeoff_canvas.v1",
    sheets: [{ sheet_id: "E-101.pdf", units_per_px: 0.05 }, { sheet_id: "E-201.pdf", units_per_px: 0.05 }],
    conditions: [
      cond("DATA-2", {
        cable_setup: setup("wall_outlet", { cables_per_location: 2, package_ft: 1000 }),
        materials: [
          { id: "m1", name: "CAT6A jack", per: 1, basis: "cables", unit: "EA" },
          { id: "m2", name: "2-port faceplate", per: 1, basis: "pulls", unit: "EA" },
        ],
      }),
      cond("WAP", { cable_setup: setup("wap"), materials: [{ id: "m3", name: "WAP mount", per: 1, basis: "pulls", unit: "EA" }] }),
      cond("CAM", { cable_setup: setup("camera"), materials: [{ id: "m4", name: "Camera", per: 1, basis: "pulls", unit: "EA" }] }),
      cond("TR", { role: "tr" }),
      cond("ROUTE", { role: "route" }),
    ],
    shapes: [
      count("d1", "DATA-2", "E-101.pdf"), count("d2", "DATA-2", "E-101.pdf"),
      count("w1", "WAP", "E-101.pdf"), count("w2", "WAP", "E-201.pdf"),
      count("c1", "CAM", "E-101.pdf"),
      count("t1", "TR", "E-101.pdf", "IDF-1"),
      line("r1", "E-101.pdf", 100), line("r2", "E-101.pdf", 240), line("r3", "E-201.pdf", 200), line("r4", "E-101.pdf", 90), line("r5", "E-101.pdf", 50),
    ],
    markups: [],
    rfis: [],
    cable_runs: [
      run("run-aaaa01", "d1", ["r1"]),
      run("run-bbbb02", "w1", ["r2"]),
      run("run-cccc03", "w2", ["r3", "r4"]),
      run("run-dddd04", "c1", ["r5"]),
    ],
  };
}

const unit = (id: string, hours: number, per: LaborUnit["per"]): LaborUnit => ({ id, label: id, hours, per });
function settings(): BidSettings {
  const s = defaultSettings(NOW);
  s.labor = {
    ...s.labor, targetBillRate: 90, trueCostRate: 40, crewSize: 2, hoursPerDay: 8, pmPctOfField: 0.1,
    unitSets: [
      { id: "standard", label: "Standard", units: [
        unit("wall_first", 1, "location_first"), unit("wall_add", 0.5, "cable_additional"),
        unit("wap_first", 1.5, "location_first"), unit("wap_add", 0.5, "cable_additional"),
        unit("camera", 2, "each"), unit("door", 3, "each"),
        unit("cert", 0.25, "link"), unit("label", 0.1, "link"), unit("mobilization", 2, "job"),
      ] },
      { id: "lowered", label: "Lowered (open ceilings, short runs)", units: [
        unit("wall_first", 0.8, "location_first"), unit("wall_add", 0.4, "cable_additional"),
        unit("wap_first", 1, "location_first"), unit("wap_add", 0.4, "cable_additional"),
        unit("camera", 1.5, "each"), unit("cert", 0.25, "link"), unit("label", 0.1, "link"), unit("mobilization", 2, "job"),
      ] },
    ],
  };
  s.markup = { materialPct: 0.15, overheadPct: 0.1, profitPct: 0.15, excisePct: 0.02, bondPct: 0.03 };
  s.travel = { mileageRate: 0.7 };
  return s;
}

const entry = (description: string, unit: string, price: number, date: string, status: PriceEntry["status"], source = "https://supplier.example/item"): PriceEntry =>
  ({ key: priceKey({ description }), description, unit, price, date, status, source });
function book(): PriceBook {
  return {
    schema: "brink.pricebook.v1",
    entries: [
      entry("CAT6A-PL", "FT", 0.5, "2026-11-10", "live"),                // per box 500.00
      entry("CAT6A jack", "EA", 8, "2026-11-01", "estimate"),           // 2 jacks = 16.00
      entry("2-port faceplate", "EA", 9.99, "2026-09-01", "live"),       // older: ignored
      entry("2-port faceplate", "EA", 3, "2026-11-10", "allowance"),     // same date as live: loses
      entry("2-port faceplate", "EA", 2.5, "2026-11-10", "live"),        // 1 plate = 2.50
      entry("WAP mount", "EA", 12, "2026-09-01", "live"),               // 2 mounts = 24.00, stale (76 days)
      entry("Camera", "EA", 300, "2026-11-10", "live"),                 // 1 camera = 300.00
    ],
  };
}

function inputs(over: Partial<BidJobInputs> = {}): BidJobInputs {
  return {
    excise: true, bond: true, unitSet: "standard", mobilizations: 1, driveHoursPerDay: 1.5, milesPerDay: 60, vehicles: 1,
    jobHours: [{ label: "Submittals", hours: 2 }],
    extraLines: [{ section: "equipment", description: "Patch panel 48-port", qty: 1, unit: "EA", unitPrice: null, priceStatus: "missing" }],
    extraExpenses: [{ label: "Lift rental", qty: 1, unit: "day", unitCost: 150 }],
    laborOnlyConditions: [],
    ...over,
  };
}

const price = (over: Partial<BidJobInputs> = {}, s = settings(), b = book()) =>
  priceBid({ takeoff: takeoff(), settings: s, priceBook: b, inputs: inputs(over), project: "invented-clinic", revision: 3, now: NOW });

test("price: the chain on invented numbers (excise and bond on)", () => {
  const bid = price();
  assert.equal(bid.schema, "brink.bid.v1");
  assert.equal(bid.status, "draft");
  assert.equal(bid.revision, 3);
  assert.equal(bid.approved, undefined);

  // material: 500 (1 box) + 16 + 2.50 + 24 + 300 = 842.50; the patch panel has no price
  const byDesc = (d: string) => bid.lines.find((l) => l.description.startsWith(d))!;
  const cableLine = byDesc("CAT6A-PL");
  assert.deepEqual([cableLine.qty, cableLine.unit, cableLine.unitPrice, cableLine.extended, cableLine.priceStatus], [1, "BOX(1000FT)", 500, 500, "live"]);
  assert.match(cableLine.description, /order 968 LF/);
  assert.deepEqual([byDesc("CAT6A jack").qty, byDesc("CAT6A jack").extended, byDesc("CAT6A jack").priceStatus], [2, 16, "estimate"]);
  assert.deepEqual([byDesc("2-port faceplate").qty, byDesc("2-port faceplate").unitPrice, byDesc("2-port faceplate").priceStatus], [1, 2.5, "live"]);
  assert.deepEqual([byDesc("WAP mount").qty, byDesc("WAP mount").extended], [2, 24]);
  assert.deepEqual([byDesc("Patch panel").unitPrice, byDesc("Patch panel").extended, byDesc("Patch panel").priceStatus], [null, null, "missing"]);
  assert.equal(bid.totals.material, 842.5);

  // hours: DATA-2 1 pull × 1.0 + 1 extra cable × 0.5; WAP 2 pulls × 1.5; CAM 1 × 2.0;
  // 5 links × (0.25 cert + 0.10 label) → field 1 + 0.5 + 3 + 2 + 1.25 + 0.5 = 8.25
  const h = (id: string) => bid.hours.find((x) => x.id === id);
  assert.deepEqual([h("h-DATA-2-wall_first")?.qty, h("h-DATA-2-wall_first")?.hours], [1, 1]);
  assert.deepEqual([h("h-DATA-2-wall_add")?.qty, h("h-DATA-2-wall_add")?.hours], [1, 0.5], "additional cable at the 2-cable location");
  assert.deepEqual([h("h-WAP-wap_first")?.qty, h("h-WAP-wap_first")?.hours], [2, 3]);
  assert.equal(h("h-WAP-wap_add"), undefined, "1-cable locations carry no additional-cable hours");
  assert.deepEqual([h("h-CAM-camera")?.qty, h("h-CAM-camera")?.unit, h("h-CAM-camera")?.hours], [1, "EA", 2]);
  assert.deepEqual([h("h-cert")?.qty, h("h-cert")?.hours, h("h-label")?.hours], [5, 1.25, 0.5]);
  // job: mobilization 1 × 2; PM 10% × 8.25 = 0.825 → 0.83; site days ceil(8.25 / (2 × 8)) = 1;
  // travel 1 day × 2 crew × 1.5 h = 3; submittals 2 → 8.25 + 2 + 0.83 + 3 + 2 = 16.08
  assert.equal(h("h-mobilization")?.hours, 2);
  assert.deepEqual([h("h-pm")?.qty, h("h-pm")?.hours, h("h-pm")?.kind], [8.25, 0.83, "job"]);
  assert.deepEqual([h("h-travel")?.qty, h("h-travel")?.hoursPer, h("h-travel")?.hours], [2, 1.5, 3]);
  assert.equal(h("h-job-1")?.hours, 2);
  assert.equal(bid.totals.laborHours, 16.08);

  // expenses: mileage 1 day × 1 vehicle × 60 mi × 0.70 = 42.00; lift 150.00
  assert.deepEqual(bid.expenses.map((e) => [e.qty, e.extended]), [[60, 42], [1, 150]]);
  assert.equal(bid.totals.expenses, 192);

  // chain 1.10 × 1.15 × 1.02 = 1.2903; cost entry 90 ÷ 1.2903 = 69.7512 → 69.75
  const t = bid.totals;
  assert.equal(t.chain, 1.2903);
  assert.equal(t.laborCostRate, 69.75);
  assert.equal(t.laborCost, 1121.58);                 // 16.08 × 69.75
  assert.equal(t.materialMarkup, 155.18);             // 842.50 × 15% = 126.375 → 126.38; 192 × 15% = 28.80
  assert.equal(t.subtotal, 2311.26);                  // 842.50 + 192 + 155.18 + 1121.58
  assert.equal(t.overhead, 231.13);                   // 2311.26 × 10% = 231.126
  assert.equal(t.profit, 381.36);                     // 2542.39 × 15% = 381.3585
  assert.equal(t.excise, 58.48);                      // 2923.75 × 2% = 58.475, half up
  assert.equal(t.baseBid, 2982.23);                   // 2311.26 + 231.13 + 381.36 + 58.48
  assert.equal(t.bond, 89.47);                        // 2982.23 × 3% = 89.4669
  assert.equal(t.totalWithBond, 3071.7);
  assert.equal(t.trueCost, 1677.7);                   // 842.50 + 192 + 16.08 × 40 = 643.20
  assert.equal(t.effectiveSellRate, 90, "labor sells at the target bill rate");
  assert.deepEqual(bid.ratios, { links: 5, dollarsPerLink: 596.45, hoursPerLink: 3.22 }); // 2982.23 / 5; 16.08 / 5
});

test("price: excise and bond off", () => {
  const t = price({ excise: false, bond: false }).totals;
  // chain 1.10 × 1.15 = 1.265; cost entry 90 ÷ 1.265 = 71.146 → 71.15; labor 16.08 × 71.15 = 1144.092
  assert.equal(t.chain, 1.265);
  assert.equal(t.laborCostRate, 71.15);
  assert.equal(t.laborCost, 1144.09);
  assert.equal(t.subtotal, 2333.77);                  // 842.50 + 192 + 155.18 + 1144.09
  assert.equal(t.overhead, 233.38);                   // 233.377
  assert.equal(t.profit, 385.07);                     // 2567.15 × 15% = 385.0725
  assert.equal(t.excise, 0);
  assert.equal(t.baseBid, 2952.22);                   // 2333.77 + 233.38 + 385.07
  assert.equal(t.bond, 0);
  assert.equal(t.totalWithBond, 2952.22);
});

test("price: flags in phone-review order, and the gaps", () => {
  const bid = price();
  const kinds = bid.flags.map((f) => f.kind);
  // long links longest first (C 310, B 260), the over-295 link, the floor crossing, then price flags
  assert.deepEqual(kinds.slice(0, 7), ["long_link", "long_link", "over_295", "floor_crossing", "unpriced", "stale_price", "estimate_price"], JSON.stringify(bid.flags, null, 1));
  assert.deepEqual(bid.flags.slice(0, 4).map((f) => f.ref), ["run-cccc03", "run-bbbb02", "run-cccc03", "run-cccc03"]);
  assert.match(bid.flags[0].message, /310 ft per cable/);
  assert.match(bid.flags[2].message, /295 ft/);
  assert.match(bid.flags[3].message, /device on E-201\.pdf, TR on E-101\.pdf, route on E-201\.pdf, E-101\.pdf/);
  assert.match(bid.flags[4].message, /Patch panel/);
  assert.match(bid.flags[5].message, /WAP mount.*2026-09-01|2026-09-01.*WAP mount/);
  assert.match(bid.flags[6].message, /CAT6A jack/);
  assert.ok(!kinds.includes("unit_set"), "the default unit set raises no flag");

  const reasons = bid.gaps.map((g) => `${g.ref}: ${g.description}: ${g.reason}`);
  assert.equal(bid.gaps.length, 2, reasons.join("\n"));
  assert.match(reasons[0], /^DATA-2: DATA-2: 1 device with no linked cable run/);
  assert.match(reasons[1], /Patch panel.*no price in the price book/);
});

test("price: a non-default unit set is flagged with its reason and used", () => {
  const bid = price({ unitSet: "lowered", unitSetReason: "open ceilings, runs under 100 ft" });
  const f = bid.flags.find((x) => x.kind === "unit_set");
  assert.ok(f);
  assert.match(f.message, /Lowered.*open ceilings, runs under 100 ft/);
  assert.ok(bid.flags.indexOf(f) > bid.flags.findIndex((x) => x.kind === "floor_crossing"));
  assert.ok(bid.flags.indexOf(f) < bid.flags.findIndex((x) => x.kind === "unpriced"));
  assert.equal(bid.hours.find((h) => h.id === "h-WAP-wap_first")?.hours, 2); // 2 pulls × 1.0
  assert.equal(bid.inputs.unitSet, "lowered");
});

test("price: missing settings and prices are gaps, never guesses; the bid still figures what it can", () => {
  const bid = price({}, defaultSettings(NOW));
  const t = bid.totals;
  assert.equal(t.material, 842.5, "priced material still totals");
  assert.equal(t.expenses, 150, "the lift still counts; mileage has no rate and no site days");
  assert.deepEqual([t.laborHours, t.laborCostRate, t.laborCost, t.subtotal, t.baseBid, t.bond, t.totalWithBond, t.chain, t.trueCost, t.effectiveSellRate],
    [2, null, null, null, null, null, null, null, null, null], "only the fixed submittal hours count");
  assert.equal(bid.ratios.dollarsPerLink, null);
  const refs = bid.gaps.map((g) => g.ref);
  for (const r of ["settings.labor.targetBillRate", "settings.markup.materialPct", "settings.markup.overheadPct", "settings.markup.profitPct", "settings.markup.excisePct", "settings.markup.bondPct", "unit:cert", "unit:label", "unit:mobilization"]) {
    assert.ok(refs.includes(r), `gap for ${r}: ${refs.join(", ")}`);
  }
  assert.ok(bid.gaps.some((g) => g.ref === "WAP" && /labor unit "wap_first" is not in unit set standard/.test(g.reason)));

  // one rate missing: the base bid waits for it, everything else is figured
  const s = settings();
  s.labor.targetBillRate = null;
  const b2 = price({}, s);
  assert.equal(b2.totals.baseBid, null);
  assert.equal(b2.totals.laborHours, 16.08);
  assert.equal(b2.totals.chain, 1.2903);
  assert.ok(b2.gaps.some((g) => g.ref === "settings.labor.targetBillRate"));

  // a device type with no unit in the map is a gap
  const doc = takeoff();
  (doc.conditions![2] as { cable_setup: { device_type: string } }).cable_setup.device_type = "custom";
  const b3 = priceBid({ takeoff: doc, settings: settings(), priceBook: book(), inputs: inputs(), project: "p", revision: 1, now: NOW });
  assert.ok(b3.gaps.some((g) => g.ref === "CAM" && /no labor unit for custom/.test(g.reason)), JSON.stringify(b3.gaps));
});

test("price: an owner-furnished condition carries labor only", () => {
  const base = price();
  const bid = price({ laborOnlyConditions: ["CAM"] });
  const cam = bid.lines.find((l) => l.description === "Camera")!;
  assert.deepEqual([cam.laborOnly, cam.unitPrice, cam.extended], [true, 0, 0]);
  const owner = bid.lines.find((l) => l.laborOnly && l.section === "cable")!;
  assert.match(owner.description, /owner-furnished, 77 LF/);    // 70 LF × 1.1 waste
  assert.match(bid.lines.find((l) => l.section === "cable" && !l.laborOnly)!.description, /order 891 LF/); // 968 − 77
  assert.equal(bid.totals.material, r2(base.totals.material - 300), "the camera's 300.00 is gone; 1 box still covers the rest");
  assert.equal(bid.totals.laborHours, base.totals.laborHours, "labor is kept");
  assert.ok(!bid.flags.some((f) => f.kind === "allowance"), "labor-only lines raise no allowance flag");
  // an unknown condition is a gap, not silently ignored
  assert.ok(price({ laborOnlyConditions: ["NOPE"] }).gaps.some((g) => g.ref === "NOPE"));
});

test("price: lookup picks newest, prefers live on the same date, converts feet and boxes, refuses other units", () => {
  assert.deepEqual(parseUnit("BOX(1000FT)"), { kind: "ft", ft: 1000 });
  assert.deepEqual(parseUnit("reel (500 ft)"), { kind: "ft", ft: 500 });
  assert.deepEqual(parseUnit("1000FT BOX"), { kind: "ft", ft: 1000 });
  assert.deepEqual(parseUnit("lf"), { kind: "ft", ft: 1 });
  assert.deepEqual(parseUnit("each"), { kind: "ea" });
  assert.equal(pricePerLineUnit(entry("x", "BOX(1000FT)", 420, "2026-11-01", "live"), "FT"), 0.42);
  assert.equal(pricePerLineUnit(entry("x", "FT", 0.42, "2026-11-01", "live"), "BOX(500FT)"), 210);
  assert.equal(pricePerLineUnit(entry("x", "EA", 5, "2026-11-01", "live"), "FT"), null);

  // a newer allowance beats an older estimate (newest wins), and is flagged
  const b = book();
  b.entries.push(entry("CAT6A jack", "EA", 7, "2026-11-12", "allowance"));
  const bid = price({}, settings(), b);
  const jack = bid.lines.find((l) => l.description === "CAT6A jack")!;
  assert.deepEqual([jack.unitPrice, jack.priceStatus, jack.priceDate], [7, "allowance", "2026-11-12"]);
  assert.ok(bid.flags.some((f) => f.kind === "allowance" && f.ref === jack.id));

  // cable priced only per EA cannot price a box: a gap that says why
  const b2 = book();
  b2.entries[0] = entry("CAT6A-PL", "EA", 1, "2026-11-10", "live");
  const bid2 = price({}, settings(), b2);
  assert.ok(bid2.gaps.some((g) => /per EA, this line is per BOX\(1000FT\)/.test(g.reason)), JSON.stringify(bid2.gaps));

  // a price recorded with manufacturer + part still prices a line named by description
  const b4 = book();
  b4.entries = b4.entries.filter((e) => e.description !== "CAT6A jack");
  b4.entries.push({ key: priceKey({ manufacturer: "Invented Co", part: "J-6A" }), manufacturer: "Invented Co", part: "J-6A", description: "CAT6A jack", unit: "EA", price: 6, date: "2026-11-11", status: "live", source: "quote INV-1" });
  const jack4 = price({}, settings(), b4).lines.find((l) => l.description === "CAT6A jack")!;
  assert.deepEqual([jack4.unitPrice, jack4.manufacturer, jack4.part, jack4.source], [6, "Invented Co", "J-6A", "quote INV-1"]);

  // a caller-priced extra line keeps its price and status
  const bid3 = price({ extraLines: [{ section: "allowance", description: "Firestopping allowance", qty: 1, unit: "LS", unitPrice: 250, priceStatus: "allowance" }] });
  const fs = bid3.lines.find((l) => l.description === "Firestopping allowance")!;
  assert.deepEqual([fs.unitPrice, fs.extended, fs.priceStatus], [250, 250, "allowance"]);
});
