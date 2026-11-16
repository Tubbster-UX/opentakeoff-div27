// The bid pricing engine: an OpenTakeoff takeoff document (session.exportPayload(),
// "opentakeoff.takeoff_canvas.v1") + the owner's settings + the price book →
// a BidDraft (src/bidTypes.ts). Pure: no I/O in priceBid; the cable math is
// the web library's own (web/src/lib/cable.js, totals.js), never re-derived.
//
// The owner's rules (docs/design/HOSTED_SERVER.md, "Owner's quoting playbook"):
//
//   chain       = (1 + overhead) × (1 + profit) × (1 + excise, when the job says so)
//   material    × (1 + materialPct) at the line; expenses the same
//   labor cost  = hours × (targetBillRate ÷ chain), so labor sells at the bill rate
//   subtotal    = material + expenses + their markup + labor cost
//   overhead    = subtotal × OH; profit = (subtotal + OH) × profit;
//   excise      = (subtotal + OH + profit) × excise; baseBid = their sum
//   bond        = baseBid × bondPct, only when the job carries one, shown apart
//
// Money is rounded to cents at every step so the lines add up; hours to 2
// decimals. Nothing is hard-coded: a missing rate, markup, labor unit or
// price is null and listed in `gaps`, and everything that can still be
// figured is. Pull labor is per PULL (location), not per cable.
import type { BidDraft, BidFlag, BidJobInputs, BidLine, BidSection, BidSettings, BidTotals, ExpenseLine, HourLine, LaborUnit, PriceBook, PriceEntry } from "../bidTypes.ts";
import { descriptionKey, lookupEntries, priceKey } from "../pricebook.ts";

type CableLib = typeof import("opentakeoff-web-cable");
type TotalsLib = typeof import("opentakeoff-web-totals");
type ResolvedRun = import("opentakeoff-web-cable").ResolvedRun;

// The web libraries, run by tsx from their sources (declared in src/web-lib.d.ts).
const cableLib = (await import(new URL("../../../web/src/lib/cable.js", import.meta.url).href)) as CableLib;
const totalsLib = (await import(new URL("../../../web/src/lib/totals.js", import.meta.url).href)) as TotalsLib;

// ── constants that are structure, not rates ─────────────────────────────────

/** A link longer than this per cable leads the phone review. */
export const LONG_LINK_FT = 250;
/** A price older than this (days) is flagged stale. */
export const STALE_DAYS = 30;

/** Which labor unit ids a device type's pulls are counted against. */
export type DeviceUnitMap = Record<string, { first: string; add: string } | { each: string }>;

/**
 * The default device type → labor unit map (unit ids, not hours: the hours
 * are the owner's, in settings.labor.unitSets). A device type not in the map
 * is a gap ("no labor unit for <device type>").
 */
export const DEFAULT_DEVICE_UNITS: DeviceUnitMap = {
  wall_outlet: { first: "wall_first", add: "wall_add" },
  wap: { first: "wap_first", add: "wap_add" },
  ceiling_other: { first: "wap_first", add: "wap_add" },
  camera: { each: "camera" },
  access_door: { each: "door" },
};
/** Per-link and per-job unit ids. */
export const UNIT_IDS = { cert: "cert", label: "label", mobilization: "mobilization" } as const;

// ── the takeoff document, as far as pricing reads it ────────────────────────

export interface TakeoffDoc {
  schema?: string;
  sheets?: { sheet_id: string; units_per_px: number; scale_confirmed?: false }[];
  conditions?: TakeoffCondition[];
  shapes?: unknown[];
  cable_runs?: unknown[];
  [k: string]: unknown;
}
interface TakeoffCondition {
  id: string;
  finish_tag: string;
  multiplier?: number;
  role?: string;
  cable_setup?: { device_type?: string; cable_type?: string } | null;
  [k: string]: unknown;
}

export interface PriceBidArgs {
  takeoff: TakeoffDoc;
  settings: BidSettings;
  priceBook: PriceBook;
  inputs: BidJobInputs;
  project: string;
  revision: number;
  /** ISO time; default now. Stale prices are judged against it. */
  now?: string;
  /** sheet_id → sheet number for messages (default: the sheet id). */
  sheetLabels?: Record<string, string>;
  /** Override of DEFAULT_DEVICE_UNITS. */
  deviceUnits?: DeviceUnitMap;
}

// ── numbers ─────────────────────────────────────────────────────────────────

/** Round to cents (and hours to 2 decimals), half away from zero, float noise forgiven. */
export const r2 = (n: number): number => Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100;
const r4 = (n: number): number => Math.round(n * 10000 + (n >= 0 ? 1e-7 : -1e-7)) / 10000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (f: number) => `${r2(f * 100)}%`;
const fmtFt = (n: number) => `${Math.round(n * 10) / 10} ft`;

// ── units (price book entry unit ↔ line unit) ───────────────────────────────

type UnitShape = { kind: "ft"; ft: number } | { kind: "ea" } | { kind: "other"; name: string };
/** "FT" / "LF" → feet; "BOX(1000FT)", "REEL (500 FT)", "1000FT BOX" → a package of feet; "EA" / "EACH" / "PC" → each. */
export function parseUnit(u: string): UnitShape {
  const s = (u ?? "").toUpperCase().replace(/\s+/g, "");
  if (["FT", "LF", "FEET", "FOOT", "'"].includes(s)) return { kind: "ft", ft: 1 };
  if (["EA", "EACH", "PC", "PCS", "PIECE", "UNIT"].includes(s)) return { kind: "ea" };
  const pkg = /(?:BOX|REEL|SPOOL|PULLBOX|CARTON|ROLL)\(?(\d+(?:\.\d+)?)(?:FT|LF|')?\)?$/.exec(s) ?? /^(\d+(?:\.\d+)?)(?:FT|LF|')(?:BOX|REEL|SPOOL|PULLBOX|CARTON|ROLL)$/.exec(s);
  if (pkg) return { kind: "ft", ft: Number(pkg[1]) };
  return { kind: "other", name: s };
}
/** An entry's price per the line's unit, or null when the units cannot be converted. */
export function pricePerLineUnit(entry: PriceEntry, lineUnit: string): number | null {
  const a = parseUnit(entry.unit);
  const b = parseUnit(lineUnit);
  if (a.kind === "ft" && b.kind === "ft") return r4((entry.price / a.ft) * b.ft);
  if (a.kind === "ea" && b.kind === "ea") return entry.price;
  if (a.kind === "other" && b.kind === "other" && a.name === b.name) return entry.price;
  return null;
}

const daysBetween = (fromDate: string, nowIso: string) => (Date.parse(nowIso) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;

// ── the engine ──────────────────────────────────────────────────────────────

export function priceBid(args: PriceBidArgs): BidDraft {
  const { takeoff, settings, priceBook, inputs, project, revision } = args;
  const now = args.now ?? new Date().toISOString();
  const deviceUnits = args.deviceUnits ?? DEFAULT_DEVICE_UNITS;
  const conditions = (takeoff.conditions ?? []) as TakeoffCondition[];
  const shapes = takeoff.shapes ?? [];
  const runs = takeoff.cable_runs ?? [];
  const condById = new Map(conditions.map((c) => [c.id, c]));
  const sheetEntries = new Map((takeoff.sheets ?? []).map((s) => [s.sheet_id, s]));
  const sheetLabel = (id: string) => args.sheetLabels?.[id] || id;

  const gaps: BidDraft["gaps"] = [];
  const gap = (ref: string, description: string, reason: string) => gaps.push({ ref, description, reason });
  const otherFlags: BidFlag[] = [];

  // ── the cable takeoff, figured by the web library ────────────────────────
  const cable = cableLib.computeCableTakeoff(conditions, shapes, runs, {
    uppFor: (id) => sheetEntries.get(id)?.units_per_px ?? null,
    scaleReason: (id) => `sheet ${sheetLabel(id)} has no scale in the takeoff — set_scale it`,
    scaleUnconfirmed: (id) => sheetEntries.get(id)?.scale_confirmed === false,
    sheetLabel,
  });
  const allRuns: ResolvedRun[] = cable?.resolved.runs ?? [];
  const linked = allRuns.filter((r) => r.status === "linked");
  const shortIds = cableLib.runShortIds(allRuns.map((r) => r.id));
  const shortId = (id: string) => shortIds.get(id) ?? id;
  const multOf = (condId: string | null) => (condId && condById.get(condId)?.multiplier) || 1;

  // ── labor-only (owner-furnished) conditions: by id or finish tag ─────────
  const laborOnly = new Set<string>();
  for (const want of inputs.laborOnlyConditions ?? []) {
    const c = conditions.find((x) => x.id === want) ?? conditions.find((x) => x.finish_tag.toLowerCase() === String(want).toLowerCase());
    if (c) laborOnly.add(c.id);
    else gap(String(want), `labor-only condition ${want}`, "no condition in the takeoff has this id or finish tag");
  }

  // ── takeoff holes: devices with no linked run are priced nowhere ─────────
  if (cable) {
    const byCond = new Map<string, number>();
    for (const d of cable.resolved.unlinked.devices) byCond.set(d.condition_id, (byCond.get(d.condition_id) ?? 0) + 1);
    for (const [cid, n] of byCond) {
      gap(cid, `${condById.get(cid)?.finish_tag ?? cid}: ${n} device${n === 1 ? "" : "s"} with no linked cable run`, "no cable, pull labor or connectivity is priced for them until link_run links them (or hold_devices says why not)");
    }
    const bad = new Map<string, ResolvedRun[]>();
    for (const r of allRuns) if (r.status !== "linked") bad.set(r.condition_id ?? "", [...(bad.get(r.condition_id ?? "") ?? []), r]);
    for (const [cid, list] of bad) {
      gap(cid, `${list[0].finish_tag || cid}: ${list.length} run${list.length === 1 ? "" : "s"} ${[...new Set(list.map((r) => r.status))].join("/")}`, list[0].reason ?? "the run does not resolve");
    }
    const heldByCond = new Map<string, { n: number; reason: string }>();
    for (const h of cable.resolved.held) {
      const cur = heldByCond.get(h.condition_id) ?? { n: 0, reason: h.reason };
      cur.n += 1;
      heldByCond.set(h.condition_id, cur);
    }
    for (const [cid, h] of heldByCond) {
      otherFlags.push({ kind: "other", ref: cid, message: `${condById.get(cid)?.finish_tag ?? cid}: ${h.n} device${h.n === 1 ? "" : "s"} held with no run (${h.reason}); not priced` });
    }
    for (const w of cable.summary.warnings) if (!/exceed/.test(w)) otherFlags.push({ kind: "other", message: w });
  }

  // ── material lines ───────────────────────────────────────────────────────
  const lines: BidLine[] = [];
  /** line id → the name its price is looked up by, when not its description. */
  const lookupName = new Map<string, string>();
  /** cable lines whose conditions state no cable type: unpriceable by design. */
  const untyped = new Set<string>();
  let lineN = 0;
  const nextId = (p: string) => `${p}-${++lineN}`;

  if (cable) {
    const orderByType = new Map((cable.order?.rows ?? []).map((r) => [r.cable_type, r]));
    for (const g of cable.summary.by_cable_type) {
      const type = g.cable_type;
      const rows = cable.summary.rows.filter((r) => r.cable_type === type);
      const pricedLf = r2(sum(rows.filter((r) => !laborOnly.has(r.condition_id)).map((r) => r.cable_lf_order)));
      const ownerLf = r2(sum(rows.filter((r) => laborOnly.has(r.condition_id)).map((r) => r.cable_lf_order)));
      const condIds = [...new Set(rows.map((r) => r.condition_id))];
      const order = orderByType.get(type);
      const pkg = order?.package_ft ?? null;
      const label = type || "Cable (no cable type stated)";
      if (pricedLf > 0) {
        const boxes = pkg ? Math.ceil(pricedLf / pkg - 1e-9) : null;
        const id = nextId("cable");
        lookupName.set(id, type);
        if (!type) untyped.add(id);
        lines.push({
          id,
          section: "cable",
          description: `${label} (order ${pricedLf} LF incl. waste${pkg ? `; ${pkg} ft per box/reel` : ""})`,
          qty: boxes ?? pricedLf,
          unit: pkg ? `BOX(${pkg}FT)` : "FT",
          unitPrice: null, extended: null, priceStatus: "missing",
          ...(condIds.length === 1 ? { conditionId: condIds[0] } : {}),
        });
        if (order?.note) otherFlags.push({ kind: "other", ref: type, message: `Cable ${label}: ${order.note}; priced by the foot` });
      }
      if (ownerLf > 0) {
        lines.push({
          id: nextId("cable"), section: "cable", description: `${label} (owner-furnished, ${ownerLf} LF)`,
          qty: ownerLf, unit: "FT", unitPrice: 0, extended: 0, priceStatus: "allowance", source: "owner-furnished (labor only)", laborOnly: true,
          ...(condIds.length === 1 ? { conditionId: condIds[0] } : {}),
        });
      }
    }
  }

  const totalsRows = totalsLib.conditionTotals(conditions, shapes, { cableByShape: cableLib.cableQtyByShape(cable) });
  for (const row of totalsRows) {
    const c = condById.get(row.id);
    for (const m of row.materials ?? []) {
      if (!(m.qty > 0)) continue;
      const section: BidSection = m.basis === "cables" || m.basis === "pulls" ? "connectivity"
        : c?.role === "route" ? "pathway" : c?.role === "tr" ? "equipment" : cableLib.hasCableSetup(c) ? "connectivity" : "other";
      const lo = laborOnly.has(row.id);
      lines.push({
        id: nextId("mat"), section, description: m.name, qty: m.qty, unit: (m.unit || "EA").toUpperCase(),
        unitPrice: lo ? 0 : null, extended: lo ? 0 : null, priceStatus: lo ? "allowance" : "missing",
        ...(lo ? { laborOnly: true, source: "owner-furnished (labor only)" } : {}),
        conditionId: row.id,
      });
    }
  }

  for (const x of inputs.extraLines ?? []) {
    const preset = typeof x.unitPrice === "number" && Number.isFinite(x.unitPrice);
    lines.push({
      ...x,
      id: nextId("extra"),
      unit: (x.unit || "EA").toUpperCase(),
      unitPrice: preset ? x.unitPrice : null,
      extended: null,
      priceStatus: preset ? (x.priceStatus === "missing" ? "estimate" : x.priceStatus) : "missing",
    });
  }

  // price each line from the book (unless labor-only or priced by the caller)
  const priceFlags: { unpriced: BidFlag[]; stale: BidFlag[]; estimate: BidFlag[]; allowance: BidFlag[] } = { unpriced: [], stale: [], estimate: [], allowance: [] };
  for (const l of lines) {
    if (l.laborOnly) continue;
    if (l.unitPrice == null) {
      if (untyped.has(l.id)) {
        gap(l.id, l.description, "the cable conditions state no cable_type: name it (edit_condition cable_setup.cable_type) so it can be priced");
        priceFlags.unpriced.push({ kind: "unpriced", ref: l.id, message: `No price: ${l.description}` });
        continue;
      }
      const keys = [...new Set([l.manufacturer && l.part ? priceKey(l) : null, descriptionKey(lookupName.get(l.id) ?? l.description)].filter((k): k is string => !!k))];
      let hit: { e: PriceEntry; price: number } | null = null;
      const seenUnits = new Set<string>();
      for (const k of keys) {
        for (const e of lookupEntries(priceBook, k)) {
          const p = pricePerLineUnit(e, l.unit);
          if (p == null) { seenUnits.add(e.unit); continue; }
          hit = { e, price: p };
          break;
        }
        if (hit) break;
      }
      if (!hit) {
        gap(l.id, l.description, seenUnits.size
          ? `the price book has it per ${[...seenUnits].join(" / ")}, this line is per ${l.unit}: record a price per ${l.unit} (or per FT for cable)`
          : "no price in the price book: find_prices, look it up, then record_prices");
        priceFlags.unpriced.push({ kind: "unpriced", ref: l.id, message: `No price: ${l.description} (${l.qty} ${l.unit})` });
        continue;
      }
      l.unitPrice = hit.price;
      l.priceStatus = hit.e.status;
      l.source = hit.e.source;
      l.priceDate = hit.e.date;
      if (!l.manufacturer && hit.e.manufacturer) l.manufacturer = hit.e.manufacturer;
      if (!l.part && hit.e.part) l.part = hit.e.part;
    }
    l.extended = r2(l.qty * (l.unitPrice as number));
    const age = l.priceDate ? daysBetween(l.priceDate, now) : null;
    if (age != null && age > STALE_DAYS) priceFlags.stale.push({ kind: "stale_price", ref: l.id, message: `Stale price (${Math.floor(age)} days, ${l.priceDate}): ${l.description} at ${l.unitPrice}/${l.unit} from ${l.source ?? "?"}` });
    if (l.priceStatus === "estimate") priceFlags.estimate.push({ kind: "estimate_price", ref: l.id, message: `Estimate price: ${l.description} at ${l.unitPrice}/${l.unit}${l.source ? ` (${l.source})` : ""}` });
    if (l.priceStatus === "allowance") priceFlags.allowance.push({ kind: "allowance", ref: l.id, message: `Allowance: ${l.description} at ${l.unitPrice}/${l.unit}${l.source ? ` (${l.source})` : ""}` });
  }

  // ── hours ────────────────────────────────────────────────────────────────
  const hours: HourLine[] = [];
  const unitSetId = inputs.unitSet || settings.labor.defaultUnitSet;
  const unitSet = settings.labor.unitSets.find((s) => s.id === unitSetId) ?? null;
  if (!unitSet) gap(`unitSet:${unitSetId}`, `labor unit set ${unitSetId}`, `no such unit set in settings.labor.unitSets (${settings.labor.unitSets.map((s) => s.id).join(", ") || "none"})`);
  const unitsById = new Map<string, LaborUnit>((unitSet?.units ?? []).map((u) => [u.id, u]));
  const missingUnit = new Set<string>();
  const unit = (id: string, ref: string, what: string): LaborUnit | null => {
    const u = unitsById.get(id);
    if (u) return u;
    if (unitSet && !missingUnit.has(`${id}\u0000${ref}`)) {
      missingUnit.add(`${id}\u0000${ref}`);
      gap(ref, what, `labor unit "${id}" is not in unit set ${unitSet.id} (settings.labor.unitSets): its hours are not counted`);
    }
    return null;
  };
  const addHours = (h: Omit<HourLine, "hours">) => hours.push({ ...h, hours: r2(h.qty * h.hoursPer) });

  // pulls and cables per device condition (linked runs, ×N)
  const perCond = new Map<string, { pulls: number; cables: number; deviceType: string; tag: string }>();
  for (const r of linked) {
    const cid = r.condition_id ?? "";
    const m = multOf(cid);
    const cur = perCond.get(cid) ?? { pulls: 0, cables: 0, deviceType: r.device_type, tag: r.finish_tag };
    cur.pulls += m;
    cur.cables += (r.cables ?? 0) * m;
    perCond.set(cid, cur);
  }
  for (const [cid, q] of perCond) {
    const map = deviceUnits[q.deviceType];
    if (!map) {
      gap(cid, `${q.tag}: pull labor`, `no labor unit for ${q.deviceType || "(no device type)"}: add one to the device-unit map or carry the hours in jobHours`);
      continue;
    }
    if ("each" in map) {
      const u = unit(map.each, cid, `${q.tag}: ${q.deviceType} labor`);
      if (u) addHours({ id: `h-${cid}-${u.id}`, label: `${q.tag}: ${u.label}`, qty: q.pulls, unit: "EA", hoursPer: u.hours, unitId: u.id, kind: "field" });
      continue;
    }
    const first = unit(map.first, cid, `${q.tag}: first cable per location`);
    if (first) addHours({ id: `h-${cid}-${first.id}`, label: `${q.tag}: ${first.label} (first cable per location)`, qty: q.pulls, unit: "locations", hoursPer: first.hours, unitId: first.id, kind: "field" });
    const extra = q.cables - q.pulls;
    if (extra > 0) {
      const add = unit(map.add, cid, `${q.tag}: additional cables`);
      if (add) addHours({ id: `h-${cid}-${add.id}`, label: `${q.tag}: ${add.label} (each additional cable)`, qty: extra, unit: "cables", hoursPer: add.hours, unitId: add.id, kind: "field" });
    }
  }
  const links = sum([...perCond.values()].map((q) => q.cables));
  if (links > 0) {
    for (const [id, what] of [[UNIT_IDS.cert, "Certification"], [UNIT_IDS.label, "Labeling"]] as const) {
      const u = unit(id, `unit:${id}`, `${what} per link`);
      if (u) addHours({ id: `h-${id}`, label: `${u.label || what} (per link)`, qty: links, unit: "links", hoursPer: u.hours, unitId: u.id, kind: "field" });
    }
  }
  const fieldHours = r2(sum(hours.filter((h) => h.kind === "field").map((h) => h.hours)));

  if (inputs.mobilizations > 0) {
    const u = unit(UNIT_IDS.mobilization, `unit:${UNIT_IDS.mobilization}`, "Mobilization");
    if (u) addHours({ id: "h-mobilization", label: u.label || "Mobilization", qty: inputs.mobilizations, unit: "trips", hoursPer: u.hours, unitId: u.id, kind: "job" });
  }
  const pmPct = settings.labor.pmPctOfField;
  if (fieldHours > 0) {
    if (pmPct == null) gap("settings.labor.pmPctOfField", "Project management hours", "settings.labor.pmPctOfField is not set (a fraction of field hours, 0.10 = 10%)");
    else addHours({ id: "h-pm", label: `Project management (${pct(pmPct)} of field hours)`, qty: fieldHours, unit: "field hours", hoursPer: pmPct, kind: "job" });
  }
  const crew = inputs.crewSize ?? settings.labor.crewSize;
  const hpd = settings.labor.hoursPerDay;
  let siteDays: number | null = 0;
  if (fieldHours > 0) {
    if (!crew || !hpd) {
      siteDays = null;
      gap(!crew ? "settings.labor.crewSize" : "settings.labor.hoursPerDay", "Site days (travel and mileage)", `${!crew ? "crew size (settings.labor.crewSize or inputs.crewSize)" : "settings.labor.hoursPerDay"} is not set: site days, travel hours and mileage cannot be figured`);
    } else {
      siteDays = Math.ceil(fieldHours / (crew * hpd) - 1e-9);
    }
  }
  if (siteDays && crew && inputs.driveHoursPerDay > 0) {
    addHours({ id: "h-travel", label: `Travel (${siteDays} site day${siteDays === 1 ? "" : "s"} × ${crew} crew)`, qty: siteDays * crew, unit: "tech-days", hoursPer: inputs.driveHoursPerDay, kind: "job" });
  }
  (inputs.jobHours ?? []).forEach((j, i) => addHours({ id: `h-job-${i + 1}`, label: j.label, qty: 1, unit: "job", hoursPer: j.hours, kind: "job" }));

  // ── expenses ─────────────────────────────────────────────────────────────
  const expenses: ExpenseLine[] = [];
  const miles = inputs.vehicles > 0 && inputs.milesPerDay > 0;
  if (miles && siteDays == null) gap("expense:mileage", "Mileage", "site days are unknown (see the site-days gap)");
  if (miles && siteDays) {
    const rate = settings.travel.mileageRate;
    const qty = r2(siteDays * inputs.vehicles * inputs.milesPerDay);
    expenses.push({ id: "e-mileage", label: `Mileage (${siteDays} site days × ${inputs.vehicles} vehicle${inputs.vehicles === 1 ? "" : "s"} × ${inputs.milesPerDay} mi)`, qty, unit: "mi", unitCost: rate, extended: rate == null ? null : r2(qty * rate) });
    if (rate == null) gap("settings.travel.mileageRate", "Mileage", "settings.travel.mileageRate is not set ($ per mile per vehicle)");
  }
  (inputs.extraExpenses ?? []).forEach((x, i) => {
    const id = `e-extra-${i + 1}`;
    const unitCost = typeof x.unitCost === "number" && Number.isFinite(x.unitCost) ? x.unitCost : null;
    expenses.push({ ...x, id, unitCost, extended: unitCost == null ? null : r2(x.qty * unitCost) });
    if (unitCost == null) gap(id, x.label, "no unit cost given");
  });

  // ── totals ───────────────────────────────────────────────────────────────
  const mk = settings.markup;
  const target = settings.labor.targetBillRate;
  const needed: [string, number | null][] = [
    ["settings.labor.targetBillRate", target],
    ["settings.markup.materialPct", mk.materialPct],
    ["settings.markup.overheadPct", mk.overheadPct],
    ["settings.markup.profitPct", mk.profitPct],
    ...(inputs.excise ? [["settings.markup.excisePct", mk.excisePct] as [string, number | null]] : []),
  ];
  for (const [k, v] of needed) if (v == null) gap(k, k.replace(/^settings\./, ""), `${k} is not set: the base bid cannot be figured until it is`);
  if (inputs.bond && mk.bondPct == null) gap("settings.markup.bondPct", "markup.bondPct", "the job carries a bond but settings.markup.bondPct is not set");

  const material = r2(sum(lines.map((l) => l.extended ?? 0)));
  const expenseTotal = r2(sum(expenses.map((e) => e.extended ?? 0)));
  const laborHours = r2(sum(hours.map((h) => h.hours)));
  const mPct = mk.materialPct;
  const materialMarkup = mPct == null ? 0 : r2(r2(material * mPct) + r2(expenseTotal * mPct));
  const chain = mk.overheadPct == null || mk.profitPct == null || (inputs.excise && mk.excisePct == null)
    ? null
    : (1 + mk.overheadPct) * (1 + mk.profitPct) * (inputs.excise ? 1 + (mk.excisePct as number) : 1);
  const laborCostRate = chain == null || target == null ? null : r2(target / chain);
  const laborCost = laborCostRate == null ? null : r2(laborHours * laborCostRate);
  const subtotal = laborCost == null || mPct == null ? null : r2(material + expenseTotal + materialMarkup + laborCost);
  const overhead = subtotal == null ? null : r2(subtotal * (mk.overheadPct as number));
  const profit = subtotal == null || overhead == null ? null : r2((subtotal + overhead) * (mk.profitPct as number));
  const excise = subtotal == null || overhead == null || profit == null ? null : inputs.excise ? r2((subtotal + overhead + profit) * (mk.excisePct as number)) : 0;
  const baseBid = subtotal == null || overhead == null || profit == null || excise == null ? null : r2(subtotal + overhead + profit + excise);
  const bond = !inputs.bond ? 0 : baseBid == null || mk.bondPct == null ? null : r2(baseBid * mk.bondPct);
  const totalWithBond = baseBid == null || bond == null ? null : r2(baseBid + bond);
  const trueRate = settings.labor.trueCostRate;
  const trueCost = trueRate == null ? null : r2(material + expenseTotal + r2(laborHours * trueRate));
  const effectiveSellRate = laborCost == null || chain == null || laborHours <= 0 ? null : r2((laborCost * chain) / laborHours);
  const totals: BidTotals = {
    material, materialMarkup, expenses: expenseTotal, laborHours, laborCostRate, laborCost, subtotal, overhead, profit, excise,
    baseBid, bond, totalWithBond, trueCost, effectiveSellRate, chain: chain == null ? null : Math.round(chain * 1e6) / 1e6,
  };

  // ── flags, ordered for the phone review ──────────────────────────────────
  const where = (r: ResolvedRun) => `TR ${r.tr_name || "(unlabeled)"}; route on ${r.sheet_ids.map(sheetLabel).join(", ") || "?"}`;
  const flags: BidFlag[] = [];
  for (const r of [...linked].filter((x) => (x.per_cable_lf ?? 0) > LONG_LINK_FT).sort((a, b) => (b.per_cable_lf ?? 0) - (a.per_cable_lf ?? 0))) {
    flags.push({ kind: "long_link", ref: r.id, message: `Long link ${shortId(r.id)} (${r.finish_tag}): ${fmtFt(r.per_cable_lf ?? 0)} per cable × ${r.cables} (${where(r)})` });
  }
  for (const r of linked.filter((x) => x.over_length)) {
    const lim = r.limit_ft ?? cableLib.TIA_MAX_LINK_FT;
    flags.push({ kind: "over_295", ref: r.id, message: `Over ${r.limit_source === "stated" ? `the stated ${lim} ft limit` : `${lim} ft (TIA-568 copper permanent link)`}: ${shortId(r.id)} (${r.finish_tag}) is ${fmtFt(r.per_cable_lf ?? 0)} per cable (${where(r)}); needs a closer TR, or a length test and an owner notice` });
  }
  for (const r of linked) {
    const all = [...new Set([...r.device_sheet_ids, ...r.sheet_ids, r.tr_sheet_id].filter(Boolean))];
    if (all.length < 2) continue;
    flags.push({
      kind: "floor_crossing", ref: r.id,
      message: `Floor crossing ${shortId(r.id)} (${r.finish_tag}): device on ${r.device_sheet_ids.map(sheetLabel).join(", ") || "?"}, TR on ${r.tr_sheet_id ? sheetLabel(r.tr_sheet_id) : "?"}, route on ${r.sheet_ids.map(sheetLabel).join(", ") || "?"} (${fmtFt(r.per_cable_lf ?? 0)} per cable); check the riser path and vertical`,
    });
  }
  if (unitSetId !== settings.labor.defaultUnitSet) {
    flags.push({ kind: "unit_set", ref: unitSetId, message: `Labor unit set "${unitSet?.label ?? unitSetId}" instead of the default "${settings.labor.defaultUnitSet}": ${inputs.unitSetReason?.trim() || "no reason given"}` });
  }
  flags.push(...priceFlags.unpriced, ...priceFlags.stale, ...priceFlags.estimate, ...priceFlags.allowance, ...otherFlags);

  return {
    schema: "brink.bid.v1",
    project,
    created: now,
    revision,
    inputs: { ...inputs, unitSet: unitSetId },
    lines,
    hours,
    expenses,
    totals,
    ratios: {
      links,
      dollarsPerLink: baseBid != null && links > 0 ? r2(baseBid / links) : null,
      hoursPerLink: links > 0 ? r2(laborHours / links) : null,
    },
    flags,
    gaps,
    settings: structuredClone(settings),
    status: "draft",
  };
}
