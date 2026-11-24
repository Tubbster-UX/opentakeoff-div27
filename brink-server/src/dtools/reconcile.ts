// Takeoff ↔ D-Tools quote reconciliation. Pure: no I/O.
//
//   takeoffFacts(takeoff, design)   what the takeoff says: device count per
//       condition (the web totals library's EA, ×N included), measured and
//       order cable feet per cable type (the web cable library's, waste on the
//       order figure only), and device counts per room (the install design's
//       device rooms when one exists, else the same room rule drafted in
//       memory: the smallest labeled floor-area polygon holding the marker).
//   reconcile(facts, quote, mapping) the differences, ordered by money:
//       - per mapped product: takeoff EA vs the quote's quantity;
//       - per product and room: takeoff room count vs the quote at the
//         matching location (explicit room → location mapping first, then
//         names compared without case/punctuation, then word order ignored);
//       - per mapped cable type: takeoff order feet vs the quote's
//         length-based items (quantity × length);
//       - quote items with no takeoff counterpart, takeoff items missing from
//         the quote, conditions and cable types with no mapping (reported,
//         never guessed).
//   Money impact = |quantity difference| × unit price (the quote's, else the
//   catalog price the caller looked up), null when no price is known.
import type { InstallDesign } from "../installTypes.ts";
import type { DtQuoteDetail, DtQuoteItem } from "./client.ts";
import type { DtoolsMapping, ProductRef } from "./store.ts";
import { draftInstallDesign, UNKNOWN_ROOM } from "../install/baseline.ts";

type CableLib = typeof import("opentakeoff-web-cable");
type TotalsLib = typeof import("opentakeoff-web-totals");
const cableLib = (await import(new URL("../../../web/src/lib/cable.js", import.meta.url).href)) as CableLib;
const totalsLib = (await import(new URL("../../../web/src/lib/totals.js", import.meta.url).href)) as TotalsLib;

// ── normalising ─────────────────────────────────────────────────────────────

/** Lowercase letters and digits only ("CS-6A PL" → "cs6apl"). */
export const tight = (s: unknown): string => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Lowercase words ("Office #101," → "office 101"). */
export const words = (s: unknown): string => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Words in sorted order ("101 Office" ≡ "Office 101"). */
const sortedWords = (s: unknown): string => words(s).split(" ").filter(Boolean).sort().join(" ");
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100;

/** The grouping key of a product reference. */
export function refKey(r: ProductRef): string {
  return r.brand && r.model ? `bm:${tight(r.brand)}:${tight(r.model)}` : `pn:${tight(r.partNumber)}`;
}
export function refLabel(r: ProductRef): string {
  return r.brand && r.model ? `${r.brand} ${r.model}${r.partNumber ? ` (${r.partNumber})` : ""}` : `part ${r.partNumber}`;
}
/** Does a catalog product / quote item match the reference? Part number against partNumber or model; brand + model both. */
export function refMatches(r: ProductRef, p: { brand?: string | null; model?: string | null; partNumber?: string | null }): boolean {
  if (r.partNumber && tight(r.partNumber) && (tight(p.partNumber) === tight(r.partNumber) || tight(p.model) === tight(r.partNumber))) return true;
  return !!(r.brand && r.model && tight(p.brand) === tight(r.brand) && tight(p.model) === tight(r.model));
}

/** A mapping entry by exact key, else case/punctuation-insensitive. */
export function lookup<T>(rec: Record<string, T>, ...keys: (string | undefined | null)[]): T | undefined {
  for (const k of keys) if (k && Object.hasOwn(rec, k)) return rec[k];
  for (const k of keys) {
    if (!k) continue;
    const hit = Object.keys(rec).find((x) => tight(x) === tight(k));
    if (hit) return rec[hit];
  }
  return undefined;
}

// ── the takeoff side ────────────────────────────────────────────────────────

export interface TakeoffCondFact {
  id: string;
  tag: string;
  role?: string;
  /** Device count (×N). */
  ea: number;
  deviceType?: string;
  cableType?: string;
  cablesPerLocation?: number;
  /** "Data outlet, 2-port (CAT6A plenum)" or the finish tag. */
  label: string;
}
export interface TakeoffCableFact {
  cableType: string;
  /** Measured cable feet (route + vertical + loops, × cables, ×N). */
  measuredFt: number;
  /** With the conditions' waste: what is ordered and quoted. */
  orderFt: number;
}
export interface TakeoffRoomFact {
  room: string;
  conditionId: string;
  tag: string;
  count: number;
}
export interface TakeoffFacts {
  conditions: TakeoffCondFact[];
  cables: TakeoffCableFact[];
  /** null when no room could be read at all. */
  rooms: TakeoffRoomFact[] | null;
  roomSource: "install_design" | "takeoff" | null;
  notes: string[];
}

interface TakeoffDocLike {
  sheets?: { sheet_id: string; units_per_px: number; scale_confirmed?: false }[];
  conditions?: unknown[];
  shapes?: unknown[];
  cable_runs?: unknown[];
  [k: string]: unknown;
}
interface CondLike {
  id: string;
  finish_tag: string;
  role?: string;
  multiplier?: number;
  cable_setup?: { device_type?: string; cable_type?: string; cables_per_location?: number } | null;
}

const TITLES: Record<string, string> = {
  wall_outlet: "Data outlet", wap: "Wireless access point", camera: "Camera", access_door: "Access control door", ceiling_other: "Ceiling device",
};

export function conditionLabel(c: CondLike): string {
  const s = cableLib.hasCableSetup(c) ? c.cable_setup ?? null : null;
  const title = s?.device_type ? TITLES[s.device_type] ?? s.device_type.replace(/_/g, " ") : c.finish_tag;
  const ports = s?.cables_per_location && s.cables_per_location > 1 ? `, ${s.cables_per_location}-port` : "";
  return `${title}${ports}${s?.cable_type ? ` (${s.cable_type})` : ""}`;
}

export function takeoffFacts(takeoff: TakeoffDocLike, design?: InstallDesign | null): TakeoffFacts {
  const conditions = (takeoff.conditions ?? []) as CondLike[];
  const shapes = takeoff.shapes ?? [];
  const sheets = new Map((takeoff.sheets ?? []).map((s) => [s.sheet_id, s]));
  const notes: string[] = [];
  const cable = cableLib.computeCableTakeoff(conditions, shapes, takeoff.cable_runs ?? [], {
    uppFor: (id) => sheets.get(id)?.units_per_px ?? null,
    scaleUnconfirmed: (id) => sheets.get(id)?.scale_confirmed === false,
  });
  const totals = totalsLib.conditionTotals(conditions, shapes, { cableByShape: cableLib.cableQtyByShape(cable) });
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const conds: TakeoffCondFact[] = [];
  for (const row of totals) {
    const c = byId.get(row.id);
    if (!c || !(row.ea > 0) || c.role === "route") continue;
    const s = cableLib.hasCableSetup(c) ? c.cable_setup ?? null : null;
    conds.push({
      id: c.id, tag: c.finish_tag, ...(c.role ? { role: c.role } : {}), ea: row.ea,
      ...(s?.device_type ? { deviceType: s.device_type } : {}),
      ...(s?.cable_type ? { cableType: s.cable_type } : {}),
      ...(s?.cables_per_location ? { cablesPerLocation: s.cables_per_location } : {}),
      label: conditionLabel(c),
    });
    if ((c.multiplier ?? 1) > 1) notes.push(`${c.finish_tag} carries ×${c.multiplier}: its EA counts it, its per-room counts do not.`);
  }
  const cables: TakeoffCableFact[] = (cable?.summary.by_cable_type ?? [])
    .map((g) => ({ cableType: g.cable_type, measuredFt: r1(Number(g.cable_lf) || 0), orderFt: r1(Number(g.cable_lf_order) || 0) }))
    .filter((g) => g.orderFt > 0 || g.measuredFt > 0);
  if (cables.some((c) => !c.cableType)) notes.push("Some cable has no cable_type on its condition: it cannot be mapped until cable_setup.cable_type names it.");

  let devices = design?.devices?.length ? design.devices : null;
  let roomSource: TakeoffFacts["roomSource"] = devices ? "install_design" : null;
  if (!devices) {
    try {
      const d = draftInstallDesign({ takeoff, project: "reconcile" });
      if (d.devices.length) { devices = d.devices; roomSource = "takeoff"; }
    } catch {
      /* no rooms */
    }
  }
  let rooms: TakeoffRoomFact[] | null = null;
  if (devices) {
    const acc = new Map<string, TakeoffRoomFact>();
    for (const d of devices) {
      const room = d.room ?? UNKNOWN_ROOM;
      const k = `${room}\u0000${d.conditionId}`;
      const cur = acc.get(k) ?? { room, conditionId: d.conditionId, tag: byId.get(d.conditionId)?.finish_tag ?? d.conditionId, count: 0 };
      cur.count += 1;
      acc.set(k, cur);
    }
    rooms = [...acc.values()];
    if (rooms.every((r) => r.room === UNKNOWN_ROOM)) notes.push("No device sits in a labeled room polygon: per-location counts cannot be compared (measure and label the rooms, or set rooms in the install design).");
  }
  return { conditions: conds, cables, rooms, roomSource, notes: [...new Set(notes)] };
}

// ── the quote side ──────────────────────────────────────────────────────────

export interface QuoteLine {
  id: number;
  brand: string;
  model: string;
  partNumber: string;
  name: string;
  location: string;
  /** "id:<locationId>" or "name:<location words>": lines at one quote location share it. */
  locKey: string;
  lengthBased: boolean;
  quantity: number;
  /** Feet for a length-based item (quantity × length), else null. */
  feet: number | null;
  unitPrice: number | null;
  pricePerFoot: number | null;
}

const SKIP_TYPES = /^(labor|package)$/i;

/** The quote's product items, flattened with their location names and feet. */
export function quoteLines(q: DtQuoteDetail): { lines: QuoteLine[]; skipped: number } {
  const locs = new Map((q.locations ?? []).map((l) => [l.id, l]));
  const lengths = new Map((q.lengths ?? []).map((l) => [l.id, l.length]));
  const lines: QuoteLine[] = [];
  let skipped = 0;
  for (const it of q.items ?? []) {
    if (SKIP_TYPES.test(String(it.type ?? ""))) { skipped++; continue; }
    const loc = it.locationId != null ? locs.get(it.locationId) : undefined;
    const location = (it.location ?? loc?.fullName ?? loc?.name ?? "").trim();
    const len = it.length ?? (it.lengthId != null ? lengths.get(it.lengthId) : undefined) ?? null;
    const lengthBased = !!it.isLengthBased;
    const qty = Number(it.quantity) || 0;
    const feet = lengthBased ? r1(qty * (len ?? 1)) : null;
    const ppf = it.pricePerLength ?? (lengthBased && it.unitPrice != null && len ? it.unitPrice / len : null);
    lines.push({
      id: it.id, brand: it.brand ?? "", model: it.model ?? "", partNumber: it.partNumber ?? "", name: it.name ?? it.shortDescription ?? "",
      location, locKey: loc ? `id:${loc.id}` : `name:${words(location)}`, lengthBased, quantity: qty, feet, unitPrice: it.unitPrice ?? null, pricePerFoot: ppf ?? null,
    });
  }
  return { lines, skipped };
}

const itemLabel = (l: Pick<QuoteLine, "brand" | "model" | "partNumber" | "name">) =>
  [l.brand, l.model].filter(Boolean).join(" ") || l.partNumber || l.name || "(unnamed item)";

// ── reconcile ───────────────────────────────────────────────────────────────

export type DiffKind = "product_qty" | "missing_from_quote" | "location_qty" | "cable_ft" | "quote_only" | "unmapped_condition" | "unmapped_cable";

export interface Difference {
  kind: DiffKind;
  product: string;
  conditions?: string[];
  room?: string;
  location?: string;
  takeoff: number | null;
  quote: number | null;
  /** quote − takeoff. */
  difference: number | null;
  unit: "EA" | "FT";
  unitPrice: number | null;
  /** |difference| × unitPrice, null when no price is known. */
  impact: number | null;
  message: string;
}

export interface ReconcileResult {
  quote: { id: string; name: string | null; number: string | null; price: number | null; lines: number; skipped: number };
  matched: { product: string; takeoff: number; quote: number; unit: "EA" | "FT" }[];
  differences: Difference[];
  unmatchedRooms: { room: string; devices: number }[];
  roomSource: TakeoffFacts["roomSource"];
  moneyAtStake: number;
  notes: string[];
}

export interface ReconcileOptions {
  /** refKey → a catalog unit price (EA) or price per foot (cables), for items the quote lacks. */
  catalogPrices?: Record<string, number>;
}

const KIND_ORDER: DiffKind[] = ["missing_from_quote", "product_qty", "cable_ft", "quote_only", "location_qty", "unmapped_condition", "unmapped_cable"];

export function reconcile(facts: TakeoffFacts, quote: DtQuoteDetail, mapping: DtoolsMapping, opts: ReconcileOptions = {}): ReconcileResult {
  const { lines, skipped } = quoteLines(quote);
  const locs = quoteLocations(quote, lines);
  const notes = [...facts.notes];
  const diffs: Difference[] = [];
  const matched: ReconcileResult["matched"] = [];
  const used = new Set<number>();
  const catalog = opts.catalogPrices ?? {};

  // product groups: mapped device conditions, several conditions may share a product
  interface Group { key: string; ref: ProductRef; conds: TakeoffCondFact[]; takeoff: number }
  const groups = new Map<string, Group>();
  for (const c of facts.conditions) {
    const ref = lookup(mapping.conditions, c.tag, c.id);
    if (!ref) {
      diffs.push({ kind: "unmapped_condition", product: c.label, conditions: [c.tag], takeoff: c.ea, quote: null, difference: null, unit: "EA", unitPrice: null, impact: null, message: `${c.tag} (${c.label}, ${c.ea} EA) has no D-Tools product mapped: dtools_set_mapping it to a brand + model or part number.` });
      continue;
    }
    const key = refKey(ref);
    const g = groups.get(key) ?? { key, ref, conds: [], takeoff: 0 };
    g.conds.push(c);
    g.takeoff += c.ea;
    groups.set(key, g);
  }
  interface CableGroup { key: string; ref: ProductRef; types: string[]; orderFt: number; measuredFt: number }
  const cgroups = new Map<string, CableGroup>();
  for (const c of facts.cables) {
    const ref = c.cableType ? lookup(mapping.cables, c.cableType) : undefined;
    if (!ref) {
      diffs.push({ kind: "unmapped_cable", product: c.cableType || "(no cable type)", takeoff: c.orderFt, quote: null, difference: null, unit: "FT", unitPrice: null, impact: null, message: `Cable ${c.cableType || "(no cable type)"} (${c.orderFt} ft to order) has no D-Tools product mapped: dtools_set_mapping cables.` });
      continue;
    }
    const key = refKey(ref);
    const g = cgroups.get(key) ?? { key, ref, types: [], orderFt: 0, measuredFt: 0 };
    g.types.push(c.cableType);
    g.orderFt = r1(g.orderFt + c.orderFt);
    g.measuredFt = r1(g.measuredFt + c.measuredFt);
    cgroups.set(key, g);
  }

  // assign quote lines to groups
  const linesOf = new Map<string, QuoteLine[]>();
  const add = (k: string, l: QuoteLine) => { linesOf.set(k, [...(linesOf.get(k) ?? []), l]); used.add(l.id); };
  for (const l of lines) {
    const cg = [...cgroups.values()].find((g) => refMatches(g.ref, l));
    const pg = [...groups.values()].find((g) => refMatches(g.ref, l));
    if (l.lengthBased && cg) add(`c:${cg.key}`, l);
    else if (pg) add(`p:${pg.key}`, l);
    else if (cg) add(`c:${cg.key}`, l);
  }
  const avg = (ls: QuoteLine[], f: (l: QuoteLine) => number | null, w: (l: QuoteLine) => number) => {
    let num = 0, den = 0;
    for (const l of ls) { const v = f(l); if (v == null) continue; num += v * w(l); den += w(l); }
    return den > 0 ? num / den : ls.map(f).find((v) => v != null) ?? null;
  };
  const money = (d: number | null, p: number | null) => (d == null || p == null ? null : r2(Math.abs(d) * p));

  // product totals
  for (const g of groups.values()) {
    const ls = linesOf.get(`p:${g.key}`) ?? [];
    const q = ls.reduce((a, l) => a + l.quantity, 0);
    const price = avg(ls, (l) => l.unitPrice, (l) => l.quantity || 1) ?? catalog[g.key] ?? null;
    const label = refLabel(g.ref);
    const tags = g.conds.map((c) => c.tag);
    if (q === g.takeoff) { matched.push({ product: label, takeoff: g.takeoff, quote: q, unit: "EA" }); }
    else {
      const d = q - g.takeoff;
      diffs.push({
        kind: q === 0 ? "missing_from_quote" : "product_qty", product: label, conditions: tags, takeoff: g.takeoff, quote: q, difference: d, unit: "EA",
        unitPrice: price != null ? r2(price) : null, impact: money(d, price),
        message: q === 0 ? `${label} (${tags.join(", ")}): ${g.takeoff} in the takeoff, not in the quote.` : `${label} (${tags.join(", ")}): takeoff ${g.takeoff}, quote ${q} (${d > 0 ? "+" : ""}${d}).`,
      });
    }

    // per room ↔ location
    if (!facts.rooms) continue;
    const condIds = new Set(g.conds.map((c) => c.id));
    const roomCounts = new Map<string, number>();
    for (const r of facts.rooms) if (condIds.has(r.conditionId)) roomCounts.set(r.room, (roomCounts.get(r.room) ?? 0) + r.count);
    if (!roomCounts.size) continue;
    const quoteByLoc = new Map<string, { name: string; qty: number }>();
    for (const l of ls) {
      const cur = quoteByLoc.get(l.locKey) ?? { name: locs.find((x) => x.key === l.locKey)?.name ?? (l.location || "(no location)"), qty: 0 };
      cur.qty += l.quantity;
      quoteByLoc.set(l.locKey, cur);
    }
    const seenLoc = new Set<string>();
    for (const [room, n] of roomCounts) {
      if (room === UNKNOWN_ROOM) continue;
      const loc = matchLocation(room, mapping, locs);
      if (!loc) continue; // reported once in unmatchedRooms
      seenLoc.add(loc.key);
      const qn = quoteByLoc.get(loc.key)?.qty ?? 0;
      if (qn !== n) {
        const d = qn - n;
        diffs.push({ kind: "location_qty", product: label, conditions: tags, room, location: loc.name, takeoff: n, quote: qn, difference: d, unit: "EA", unitPrice: price != null ? r2(price) : null, impact: money(d, price), message: `${label} in ${room}${words(loc.name) !== words(room) ? ` (quote location ${loc.name})` : ""}: takeoff ${n}, quote ${qn}.` });
      }
    }
    // devices the takeoff could not place in a room may be the ones the quote puts at an unmatched location
    let unplaced = roomCounts.get(UNKNOWN_ROOM) ?? 0;
    for (const [k, v] of quoteByLoc) {
      if (seenLoc.has(k)) continue;
      const absorbed = Math.min(unplaced, v.qty);
      unplaced -= absorbed;
      const qty = v.qty - absorbed;
      if (qty <= 0) continue;
      diffs.push({ kind: "location_qty", product: label, conditions: tags, location: v.name, takeoff: 0, quote: qty, difference: qty, unit: "EA", unitPrice: price != null ? r2(price) : null, impact: money(qty, price), message: `${label} at quote location ${v.name}: ${qty} in the quote, no takeoff room maps to ${qty === v.qty ? "it" : "them"}${absorbed ? ` (${absorbed} more may be the takeoff's devices with no room)` : ""}.` });
    }
  }

  // cable feet
  for (const g of cgroups.values()) {
    const ls = linesOf.get(`c:${g.key}`) ?? [];
    const q = r1(ls.reduce((a, l) => a + (l.feet ?? l.quantity), 0));
    const ppf = avg(ls, (l) => l.pricePerFoot, (l) => l.feet ?? 1) ?? catalog[g.key] ?? null;
    const label = refLabel(g.ref);
    if (Math.abs(q - g.orderFt) < 0.5) { matched.push({ product: label, takeoff: g.orderFt, quote: q, unit: "FT" }); continue; }
    const d = r1(q - g.orderFt);
    diffs.push({
      kind: q === 0 ? "missing_from_quote" : "cable_ft", product: label, conditions: g.types, takeoff: g.orderFt, quote: q, difference: d, unit: "FT",
      unitPrice: ppf != null ? Math.round(ppf * 10000) / 10000 : null, impact: money(d, ppf),
      message: `${label} (${g.types.join(", ")}): takeoff ${g.orderFt} ft to order (${g.measuredFt} ft measured + waste), quote ${q} ft.`,
    });
  }

  // quote items with no takeoff counterpart
  for (const l of lines) {
    if (used.has(l.id)) continue;
    const label = itemLabel(l);
    const isFt = l.lengthBased;
    const qty = isFt ? l.feet ?? l.quantity : l.quantity;
    const price = isFt ? l.pricePerFoot : l.unitPrice;
    diffs.push({ kind: "quote_only", product: label, ...(l.location ? { location: l.location } : {}), takeoff: null, quote: qty, difference: qty, unit: isFt ? "FT" : "EA", unitPrice: price, impact: money(qty, price), message: `${label}${l.location ? ` at ${l.location}` : ""}: ${qty}${isFt ? " ft" : ""} in the quote, nothing in the takeoff maps to it.` });
  }

  // rooms with devices that match no quote location
  const unmatchedRooms: ReconcileResult["unmatchedRooms"] = [];
  if (facts.rooms) {
    const per = new Map<string, number>();
    for (const r of facts.rooms) if (r.room !== UNKNOWN_ROOM) per.set(r.room, (per.get(r.room) ?? 0) + r.count);
    for (const [room, n] of per) if (!matchLocation(room, mapping, locs)) unmatchedRooms.push({ room, devices: n });
    const unknown = facts.rooms.filter((r) => r.room === UNKNOWN_ROOM).reduce((a, r) => a + r.count, 0);
    if (unknown) notes.push(`${unknown === 1 ? "1 device sits" : `${unknown} devices sit`} in no labeled room: left out of the per-location comparison.`);
    if (unmatchedRooms.length) notes.push(`Rooms with no matching quote location: ${unmatchedRooms.map((r) => r.room).join(", ")}. Map them with dtools_set_mapping rooms (room → quote location).`);
  } else {
    notes.push("No room data in the takeoff: per-location counts were not compared.");
  }
  if (skipped) notes.push(skipped === 1 ? "1 labor / package item in the quote was not compared." : `${skipped} labor / package items in the quote were not compared.`);

  diffs.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.product.localeCompare(b.product));
  const moneyAtStake = r2(diffs.filter((d) => d.kind !== "location_qty").reduce((a, d) => a + (d.impact ?? 0), 0));
  return {
    quote: { id: quote.id, name: quote.name ?? null, number: quote.number ?? null, price: quote.price ?? null, lines: lines.length, skipped },
    matched, differences: diffs, unmatchedRooms, roomSource: facts.roomSource, moneyAtStake, notes,
  };
}

export interface QuoteLocRef {
  key: string;
  name: string;
  names: string[];
}

/** The quote's locations (by id, with every spelling of their name) plus item locations that name no location id. */
export function quoteLocations(q: DtQuoteDetail, lines: QuoteLine[] = quoteLines(q).lines): QuoteLocRef[] {
  const out: QuoteLocRef[] = [];
  for (const l of q.locations ?? []) {
    const names = [l.name, l.fullName, l.number && l.name ? `${l.number} ${l.name}` : null, l.number && l.name ? `${l.name} ${l.number}` : null, l.number].filter((n): n is string => !!n && !!n.trim());
    out.push({ key: `id:${l.id}`, name: l.fullName || l.name || l.number || `location ${l.id}`, names });
  }
  for (const ln of lines) {
    if (!ln.locKey.startsWith("name:") || out.some((x) => x.key === ln.locKey)) continue;
    out.push({ key: ln.locKey, name: ln.location || "(no location)", names: ln.location ? [ln.location] : [] });
  }
  return out;
}

/** The quote location a takeoff room maps to: the explicit mapping, else a name match (case/punctuation, then word order). */
export function matchLocation(room: string, mapping: DtoolsMapping, locs: QuoteLocRef[]): QuoteLocRef | null {
  const explicit = lookup(mapping.rooms, room);
  const target = explicit ?? room;
  const hit = locs.find((l) => l.names.some((n) => words(n) === words(target))) ?? locs.find((l) => l.names.some((n) => sortedWords(n) === sortedWords(target)));
  if (hit) return hit;
  // an explicit location the quote does not have yet: everything there counts 0 in the quote
  return explicit ? { key: `name:${words(explicit)}`, name: explicit, names: [explicit] } : null;
}

export type { DtQuoteItem };
