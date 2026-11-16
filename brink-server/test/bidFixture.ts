// An invented BidDraft for the export tests. Company, project, prices and
// rates are all made up; the totals are worked out here, independently of
// src/bid/workbook.ts, by the playbook chain (docs/design/HOSTED_SERVER.md):
// material × (1 + markup) + labor hours × (bill rate ÷ chain) + expenses →
// × (1 + overhead) × (1 + profit) × (1 + excise), bond as a separate add.
import zlib from "node:zlib";
import type { BidDraft, BidLine, BidSettings, ExpenseLine, HourLine } from "../src/bidTypes.ts";
import type { ProjectManifest } from "../src/types.ts";
import { GcProposalContentSchema, type GcProposalContent } from "../src/bid/proposal.ts";
import { FederalContentSchema, type FederalContent } from "../src/bid/federal.ts";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function fixtureSettings(): BidSettings {
  return {
    schema: "brink.settings.v1",
    company: {
      legalName: "Example Holdings LLC DBA Example Design",
      brand: "Example Design",
      address: ["100 Sample Street", "Testville, SD 57000"],
      phone: "(555) 010-0000",
      email: "bids@example.com",
      web: "example.com",
      signerName: "Pat Example",
      signerTitle: "Owner",
      uei: "TESTUEI00000",
      cage: "0TEST",
      extraIds: ["Test licence LV-0000"],
    },
    labor: {
      targetBillRate: 95,
      trueCostRate: 48,
      crewSize: 2,
      hoursPerDay: 8,
      pmPctOfField: 10,
      defaultUnitSet: "standard",
      unitSets: [{ id: "standard", label: "Standard", units: [
        { id: "wall_first", label: "Wall location, first cable", hours: 1.2, per: "location_first" },
        { id: "wall_add", label: "Wall, additional cable", hours: 0.45, per: "cable_additional" },
      ] }],
    },
    markup: { materialPct: 15, overheadPct: 10, profitPct: 15, excisePct: 2.041, bondPct: 1.5 },
    travel: { mileageRate: 0.7 },
    proposal: {
      validityDays: 30,
      paymentTerms: "Net 30 from invoice. Progress billing monthly.",
      warranty: "One-year workmanship warranty from substantial completion; manufacturer warranties pass through.",
      standardExclusions: ["Permits and fees unless listed", "Painting and patching beyond cable penetrations"],
      standardClarifications: ["Work performed during normal business hours"],
    },
    updated: "2026-11-01T00:00:00.000Z",
    changeLog: [],
  };
}

function line(p: Omit<BidLine, "extended">): BidLine {
  return { ...p, extended: p.unitPrice == null || p.laborOnly ? (p.laborOnly ? 0 : null) : r2(p.qty * p.unitPrice) };
}
function hour(p: Omit<HourLine, "hours">): HourLine {
  return { ...p, hours: Math.round(p.qty * p.hoursPer * 10000) / 10000 };
}

/** A complete (no gaps) draft, revision 3. Percent settings are whole percents (15 = 15 %). */
export function fixtureBid(over: { fractions?: boolean; gap?: boolean; manyLines?: number } = {}): BidDraft {
  const settings = fixtureSettings();
  if (over.fractions) {
    const k = settings.markup;
    k.materialPct = 0.15; k.overheadPct = 0.1; k.profitPct = 0.15; k.excisePct = 0.02041; k.bondPct = 0.015;
    settings.labor.pmPctOfField = 0.1;
  }
  const lines: BidLine[] = [
    line({ id: "L1", section: "cable", description: "CAT6A plenum cable, 1000 ft box", manufacturer: "Example Cable Co", part: "EC-6AP-1000", qty: 6, unit: "BOX", unitPrice: 412.5, priceStatus: "live", source: "Example Supply quote 1001", priceDate: "2026-10-19", basis: "27 15 00 2.1.A", conditionId: "c-cable" }),
    line({ id: "L2", section: "connectivity", description: "CAT6A jack", manufacturer: "Example Mfg", part: "EX-6A-WH", qty: 96, unit: "EA", unitPrice: 9.85, priceStatus: "live", source: "Example Supply", priceDate: "2026-10-19", basis: "27 15 00 2.3" }),
    line({ id: "L3", section: "connectivity", description: "2-port faceplate", manufacturer: "Example Mfg", part: "EX-FP2", qty: 48, unit: "EA", unitPrice: 1.1, priceStatus: "estimate", source: "past bid: Sample Clinic", priceDate: "2026-06-02" }),
    line({ id: "L4", section: "equipment", description: "48-port CAT6A patch panel", manufacturer: "Example Mfg", part: "EX-PP48", qty: 2, unit: "EA", unitPrice: 285, priceStatus: "live", source: "examplesupply.test/pp48", priceDate: "2026-10-20" }),
    line({ id: "L5", section: "support", description: "J-hooks, 2 in.", qty: 120, unit: "EA", unitPrice: 2.35, priceStatus: "allowance", source: "allowance", priceDate: "2026-11-01" }),
    line({ id: "L6", section: "equipment", description: "Wireless access point (owner-furnished)", qty: 8, unit: "EA", unitPrice: 0, priceStatus: "live", laborOnly: true, source: "owner-furnished" }),
  ];
  for (let i = 0; i < (over.manyLines ?? 0); i++) {
    lines.push(line({ id: `X${i + 1}`, section: "other", description: `Extra test item number ${i + 1} with a longer description that wraps in the table`, manufacturer: "Example Mfg", part: `EX-${1000 + i}`, qty: 1 + (i % 5), unit: "EA", unitPrice: 3 + (i % 7), priceStatus: "live", source: "Example Supply", priceDate: "2026-10-19" }));
  }
  if (over.gap) {
    lines.push(line({ id: "L7", section: "support", description: "Firestop sleeve kit", manufacturer: "Example Fire", part: "EF-2", qty: 4, unit: "EA", unitPrice: null, priceStatus: "missing" }));
  }

  const crew = 2, hpd = 8, drive = 1.5, miles = 120, vehicles = 1;
  const field: HourLine[] = [
    hour({ id: "h-wall-first", label: "Wall location, first cable", qty: 40, unit: "locations", hoursPer: 1.2, unitId: "wall_first", kind: "field" }),
    hour({ id: "h-wall-add", label: "Wall, additional cable", qty: 48, unit: "cables", hoursPer: 0.45, unitId: "wall_add", kind: "field" }),
    hour({ id: "h-wap", label: "WAP location, first cable", qty: 8, unit: "locations", hoursPer: 1.4, unitId: "wap_first", kind: "field" }),
    hour({ id: "h-cert", label: "Certify and label", qty: 96, unit: "links", hoursPer: 0.1, unitId: "cert", kind: "field" }),
  ];
  const fieldHours = field.reduce((a, h) => a + h.qty * h.hoursPer, 0);
  const siteDays = Math.ceil(Math.round((fieldHours / (crew * hpd)) * 1e9) / 1e9);
  const pmFrac = 0.1;
  const hours: HourLine[] = [
    ...field,
    hour({ id: "h-mob", label: "Mobilization", qty: 1, unit: "trips", hoursPer: 4, kind: "job" }),
    hour({ id: "h-submittals", label: "Submittals and closeout", qty: 1, unit: "job", hoursPer: 3, kind: "job" }),
    hour({ id: "pm", label: "Project management", qty: fieldHours, unit: "field hours", hoursPer: pmFrac, kind: "job" }),
    hour({ id: "travel", label: "Travel", qty: siteDays * crew, unit: "tech-days", hoursPer: drive, kind: "job" }),
  ];
  const expenses: ExpenseLine[] = [
    { id: "mileage", label: "Mileage", qty: siteDays * vehicles * miles, unit: "miles", unitCost: 0.7, extended: r2(siteDays * vehicles * miles * 0.7) },
    { id: "lift", label: "Lift rental", qty: 1, unit: "week", unitCost: 450, extended: 450 },
  ];

  const material = lines.reduce((a, l) => a + (l.laborOnly || l.unitPrice == null ? 0 : l.qty * l.unitPrice), 0);
  const laborHours = hours.reduce((a, h) => a + h.qty * h.hoursPer, 0);
  const chain = 1.1 * 1.15 * 1.02041;
  const laborCostRate = 95 / chain;
  const laborCost = laborHours * laborCostRate;
  const exp = expenses.reduce((a, e) => a + (e.unitCost ?? 0) * e.qty, 0);
  const markup = material * 0.15;
  const subtotal = material + markup + exp + laborCost;
  const overhead = subtotal * 0.1;
  const profit = (subtotal + overhead) * 0.15;
  const excise = (subtotal + overhead + profit) * 0.02041;
  const baseBid = subtotal + overhead + profit + excise;
  const bond = baseBid * 0.015;
  const links = 96;
  const gaps = over.gap ? [{ ref: "L7", description: "Firestop sleeve kit", reason: "no price in the price book" }] : [];

  return {
    schema: "brink.bid.v1",
    project: "sample-clinic",
    created: "2026-11-15T18:00:00.000Z",
    revision: 3,
    inputs: {
      excise: true, bond: true, unitSet: "standard", mobilizations: 1, crewSize: crew,
      driveHoursPerDay: drive, milesPerDay: miles, vehicles,
      jobHours: [{ label: "Submittals and closeout", hours: 3 }], extraLines: [], extraExpenses: [], laborOnlyConditions: [],
    },
    lines,
    hours,
    expenses,
    totals: {
      material: r2(material), materialMarkup: r2(markup), expenses: r2(exp), laborHours: r2(laborHours),
      laborCostRate: r2(laborCostRate), laborCost: r2(laborCost), subtotal: r2(subtotal), overhead: r2(overhead),
      profit: r2(profit), excise: r2(excise), baseBid: r2(baseBid), bond: r2(bond), totalWithBond: r2(baseBid + bond),
      trueCost: r2(material + exp + laborHours * 48), effectiveSellRate: r2((laborCost * chain) / laborHours), chain: Math.round(chain * 1e6) / 1e6,
    },
    ratios: { links, dollarsPerLink: r2(baseBid / links), hoursPerLink: r2(laborHours / links) },
    flags: [
      { kind: "long_link", message: "Run R-14 to the north office is 268 ft (over 250 ft).", ref: "R-14" },
      { kind: "floor_crossing", message: "Run R-22 crosses from level 1 to level 2 through a sleeve.", ref: "R-22" },
      { kind: "estimate_price", message: "Faceplate price is an estimate from a past bid.", ref: "L3" },
      { kind: "allowance", message: "J-hooks carried as an allowance.", ref: "L5" },
    ],
    gaps,
    settings,
    status: "draft",
  };
}

export function approve(bid: BidDraft, at = "2026-11-20T15:00:00.000Z"): BidDraft {
  return { ...bid, status: "approved", approved: { at, revision: bid.revision } };
}

export function fixtureProject(): ProjectManifest {
  return {
    schema: "brink.project.v1",
    id: "sample-clinic",
    name: "Sample Clinic Data Cabling",
    notes: "Invented test project.",
    created: "2026-11-01T00:00:00.000Z",
    updated: "2026-11-15T00:00:00.000Z",
    files: [],
    uploads: [],
  };
}

/** A small valid PNG (navy block) for the logo tests. */
export function tinyPng(w = 4, h = 2): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([27, 48, 85], y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

export function gcContent(over: Partial<GcProposalContent> = {}): GcProposalContent {
  return GcProposalContentSchema.parse({
    preparedFor: { company: "Sample Builders Inc", attention: "Jordan Estimator", email: "estimating@sample-builders.test" },
    projectTitle: "Sample Clinic Renovation",
    documents: ["Drawings T-001 to T-401 dated 2026-10-01", "Specification 27 15 00", "Addendum 1 dated 2026-10-12"],
    quoteDate: "2026-11-16",
    bidDate: "2026-11-20",
    scopeItems: [
      { item: "Horizontal cabling", detail: "Furnish and install CAT6A plenum cable to 40 wall locations and 8 access point locations." },
      { item: "Termination and testing", detail: "Terminate both ends, certify every link, label per the specification." },
      "Pathway support: J-hooks at 4 ft on center above accessible ceilings.",
    ],
    products: [
      { item: "CAT6A plenum cable", model: "Example Cable EC-6AP", qty: 6, basis: "Spec 27 15 00 2.1.A" },
      { item: "CAT6A jack", model: "Example Mfg EX-6A-WH", qty: 96, basis: "Spec 27 15 00 2.3" },
    ],
    responsibilities: [
      { task: "Cable, jacks and patch panels", brink: true, others: "" },
      { task: "Backboxes and conduit stubs", brink: false, others: "Electrical contractor" },
    ],
    projectConditions: ["Ceilings open during rough-in.", "Site access 7 am to 5 pm."],
    exclusions: ["Wireless access points (owner-furnished; installed labor only)."],
    clarifications: ["One mobilization assumed."],
    priceNote: "Flat rate · no taxes",
    ...over,
  });
}


export function federalContent(over: Partial<FederalContent> = {}): FederalContent {
  return FederalContentSchema.parse({
    solicitation: { number: "TEST00-26-Q-0001", title: "Sample Building Network Cabling", agency: "Department of Examples", office: "Example Contracting Squadron" },
    date: "November 16, 2026",
    recipients: [
      { name: "Alex Sample", rank: "Capt", role: "Contracting Officer", email: "alex.sample@example.test" },
      { name: "Robin Test", role: "Contract Specialist", email: "robin.test@example.test" },
    ],
    coverParagraphs: [
      "Example Design submits this quote for the cabling work described in the solicitation.",
      "Example Design has reviewed the Statement of Work and the drawings and offers the products listed in the technical package.",
    ],
    complianceMatrix: [
      { requirement: "Provide CAT6A plenum cable to each outlet", reference: "SOW 3.1", offered: "Example Cable EC-6AP", response: "Meets" },
      { requirement: "Certify every link to the permanent link limit", reference: "SOW 3.4", offered: "Example certifier, permanent link test", response: "Exceeds" },
      { requirement: "Install cable in existing conduit only", reference: "SOW 3.2", offered: "J-hooks above accessible ceilings", response: "Exception", exceptionNo: 1 },
    ],
    exceptions: [
      { no: 1, sowSays: "All cable in existing conduit.", conflict: "The drawings show no conduit above the corridor ceiling.", brinkDoes: "Supports cable on J-hooks at 4 ft on center above accessible ceilings.", offRamp: "If conduit is required, Example Design will price it on request." },
    ],
    assumptions: [
      { text: "Work during normal duty hours." },
      { text: "Corridor ceilings remain accessible.", exceptionNo: 1 },
    ],
    bomByRoom: [
      { room: "Room 101 Telecom", items: [
        { description: "48-port CAT6A patch panel", manufacturer: "Example Mfg", model: "EX-PP48", qty: 2, taa: "Yes" },
        { description: "CAT6A jack", manufacturer: "Example Mfg", model: "EX-6A-WH", qty: 24, taa: "Yes" },
      ] },
      { room: "Room 102 Office", items: [{ description: "2-port faceplate", manufacturer: "Example Mfg", model: "EX-FP2", qty: 12 }] },
    ],
    priceStatement: "The price below covers all labor, material and equipment for the work in the Statement of Work.",
    deliveryTerms: "Work complete within 30 days after notice to proceed.",
    ...over,
  });
}
