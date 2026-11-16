// Contracts for the bid side of brink-server: owner settings, the price book,
// and the priced bid draft that the workbook and proposal exports render.
// The pricing math follows docs/design/HOSTED_SERVER.md ("Owner's quoting
// playbook"). No rates or prices are hard-coded anywhere: they come from
// settings and the price book, and anything missing is a gap, never a guess.

import type { ProjectId } from "./types.ts";

// ── settings (store: system/settings.json; playbook text: system/playbook.md) ─

export interface CompanyProfile {
  legalName: string;          // e.g. "Example Holdings LLC DBA Example Design"
  brand: string;              // name on the letterhead
  address: string[];          // lines
  phone: string;
  email: string;
  web: string;
  signerName: string;
  signerTitle: string;
  uei?: string;
  cage?: string;
  /** Free lines printed under the company block (CMMC, licence numbers, ...). */
  extraIds?: string[];
  /** Store key of the logo (PNG/JPEG) under system/, if uploaded. */
  logoKey?: string;
}

/** What a labor unit is counted against. */
export type LaborPer =
  | "location_first"   // first cable to a location (one per pull / location)
  | "cable_additional" // each additional cable at the same location
  | "each"             // per device / item counted
  | "link"             // per certified link (= cable)
  | "lf"               // per linear foot (tray, ladder)
  | "job";             // fixed hours per job

export interface LaborUnit {
  id: string;          // stable key, e.g. "wall_first", "wall_add", "wap_first", "camera", "door", "cert", "label"
  label: string;
  hours: number;
  per: LaborPer;
}

export interface LaborUnitSet {
  id: string;          // "standard" | "lowered" | custom
  label: string;
  /** When Claude may pick this set (shown to Claude; the default set needs none). */
  when?: string;
  units: LaborUnit[];
}

export interface BidSettings {
  schema: "brink.settings.v1";
  company: CompanyProfile;
  labor: {
    /** Target sell rate per hour; the cost entry is back-solved from it. */
    targetBillRate: number | null;
    /** Real burdened cost per hour (shown as true cost / margin check only). */
    trueCostRate: number | null;
    crewSize: number | null;
    hoursPerDay: number | null;
    /** Project management as a % of field hours. */
    pmPctOfField: number | null;
    defaultUnitSet: string;   // id of a LaborUnitSet
    unitSets: LaborUnitSet[];
  };
  markup: {
    materialPct: number | null;   // at the line
    overheadPct: number | null;
    profitPct: number | null;
    /** SD contractor's excise, applied after profit when the job says so. */
    excisePct: number | null;
    /** Bond as a separate add on the grand total. */
    bondPct: number | null;
  };
  travel: {
    mileageRate: number | null;   // $ per mile per vehicle
  };
  proposal: {
    validityDays: number | null;
    paymentTerms: string;
    warranty: string;
    standardExclusions: string[];
    standardClarifications: string[];
  };
  /** ISO time of the last change and a short log of who changed what. */
  updated: string;
  changeLog: { at: string; by: "owner" | "claude"; what: string }[];
}

// ── price book (store: system/pricebook.json) ───────────────────────────────

export type PriceStatus = "live" | "estimate" | "allowance";

export interface PriceEntry {
  /** Normalised key: manufacturer + part when known, else a description key. */
  key: string;
  description: string;
  manufacturer?: string;
  part?: string;
  /** Unit the price is per: "EA", "FT", "BOX(1000FT)", "LF", ... */
  unit: string;
  price: number;
  supplier?: string;
  /** Where it came from: URL, "CED quote #1234", "past bid: <project>". */
  source: string;
  /** Date the price was seen / quoted (YYYY-MM-DD). */
  date: string;
  status: PriceStatus;
  /** Project the price was found for, if any. */
  project?: ProjectId;
  notes?: string;
}

export interface PriceBook {
  schema: "brink.pricebook.v1";
  entries: PriceEntry[];
}

// ── the priced bid draft (store: projects/<p>/outputs/bid/bid.json) ─────────

export type BidSection = "cable" | "connectivity" | "equipment" | "pathway" | "support" | "allowance" | "other";

export interface BidLine {
  id: string;
  section: BidSection;
  description: string;
  manufacturer?: string;
  part?: string;
  qty: number;
  unit: string;
  /** null = no price yet (a gap). */
  unitPrice: number | null;
  extended: number | null;
  priceStatus: PriceStatus | "missing";
  source?: string;
  priceDate?: string;
  /** Owner-furnished / by others: carried as labor only, material 0. */
  laborOnly?: boolean;
  /** Spec clause or drawing note that names it ("27 15 00 2.1.A"). */
  basis?: string;
  /** The OpenTakeoff condition it came from. */
  conditionId?: string;
}

export interface HourLine {
  id: string;
  label: string;
  qty: number;
  unit: string;          // "locations", "cables", "links", "EA", "LF", "job", "trips", ...
  hoursPer: number;
  hours: number;
  /** Labor unit id used, when from a unit set. */
  unitId?: string;
  /** field = counts toward PM %; job = mobilization, travel, submittals, PM itself. */
  kind: "field" | "job";
}

export interface ExpenseLine {
  id: string;
  label: string;         // "Mileage", "Lift rental", "Certifier rental", ...
  qty: number;
  unit: string;
  unitCost: number | null;
  extended: number | null;
}

export interface BidJobInputs {
  /** Apply SD contractor's excise (SD work without an exemption certificate). */
  excise: boolean;
  bond: boolean;
  unitSet: string;
  /** Why the unit set was chosen when it is not the default (Claude states it). */
  unitSetReason?: string;
  mobilizations: number;
  crewSize?: number;
  /** Round-trip drive hours per tech per site day (0 for local). */
  driveHoursPerDay: number;
  /** Round-trip miles per vehicle per site day. */
  milesPerDay: number;
  vehicles: number;
  /** Fixed job hours (submittals, cleanup, training, bonding, ...). */
  jobHours: { label: string; hours: number }[];
  /** Extra material / allowance lines Claude or the owner adds. */
  extraLines: Omit<BidLine, "id" | "extended">[];
  extraExpenses: Omit<ExpenseLine, "id" | "extended">[];
  /** Condition ids carried labor-only (owner-furnished). */
  laborOnlyConditions: string[];
}

export interface BidTotals {
  material: number;            // priced material (excl. missing)
  materialMarkup: number;
  expenses: number;
  laborHours: number;
  /** Back-solved cost entry per hour = targetBillRate ÷ chain (chain excludes material markup). */
  laborCostRate: number | null;
  laborCost: number | null;
  subtotal: number | null;
  overhead: number | null;
  profit: number | null;
  excise: number | null;
  /** The number: everything above, before bond. */
  baseBid: number | null;
  bond: number | null;
  /** Base bid + bond when the job carries a bond. */
  totalWithBond: number | null;
  /** Labor at trueCostRate instead of the cost entry, for the margin check. */
  trueCost: number | null;
  /** labor sell ÷ hours: what an hour actually sells for. */
  effectiveSellRate: number | null;
  /** chain multiplier without material markup (e.g. 1.10 × 1.15 × 1.02041). */
  chain: number | null;
}

export interface BidFlag {
  kind: "long_link" | "over_295" | "floor_crossing" | "unpriced" | "stale_price" | "estimate_price" | "allowance" | "unit_set" | "other";
  message: string;
  ref?: string;    // run id, line id, condition id
}

export interface BidDraft {
  schema: "brink.bid.v1";
  project: ProjectId;
  created: string;
  /** Monotonic per project; each price_bid run is a new revision. */
  revision: number;
  inputs: BidJobInputs;
  lines: BidLine[];
  hours: HourLine[];
  expenses: ExpenseLine[];
  totals: BidTotals;
  ratios: { links: number; dollarsPerLink: number | null; hoursPerLink: number | null };
  /** Ordered for the phone review: long links / floor crossings first. */
  flags: BidFlag[];
  /** Items with no price; the bid is incomplete while any exist. */
  gaps: { ref: string; description: string; reason: string }[];
  /** A copy of the settings used, so the draft re-renders the same later. */
  settings: BidSettings;
  status: "draft" | "approved";
  /** Only the owner sets this (the phone page). Tools never do. */
  approved?: { at: string; revision: number };
}
