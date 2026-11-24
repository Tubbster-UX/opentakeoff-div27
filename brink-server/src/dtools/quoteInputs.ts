// Getting the takeoff into a D-Tools quote. The D-Tools API cannot write quote
// items, and D-Tools Cloud documents CSV import only for the product catalog,
// so dtools_quote_inputs writes two files:
//
//   catalog-import.csv   the products the takeoff needs that the catalog does
//                        not have yet, in the column names of D-Tools' own
//                        sample import file ("Importing products into D-Tools
//                        Cloud"; Brand and Model are required, products
//                        without either are skipped by the import);
//   scope-by-location.txt  "Office 101: 2 x Data outlet, 2-port (CAT6A) ..."
//                        for D-Tools' Quote Assist or to build the quote by hand.
//
// Pure: the tool looks the catalog and price book up and hands the results in.
import type { ProductRef, DtoolsMapping } from "./store.ts";
import type { TakeoffFacts } from "./reconcile.ts";
import { lookup, refKey, refLabel } from "./reconcile.ts";
import { UNKNOWN_ROOM } from "../install/baseline.ts";

/** D-Tools' sample product import file's columns, in its order (dimensions and power left out). */
export const CATALOG_COLUMNS = ["Brand", "Model", "Part Number", "Short Description", "Description", "Category", "Keywords", "MSRP", "Unit Cost", "Unit Price", "Taxable", "Supplier", "System", "Phase"] as const;
export type CatalogRow = Partial<Record<(typeof CATALOG_COLUMNS)[number], string | number | null>>;

/** One CSV field: quoted when it holds a comma, quote or line break; a leading = + @ is defused. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function catalogCsv(rows: CatalogRow[]): string {
  const lines = [CATALOG_COLUMNS.join(",")];
  for (const r of rows) lines.push(CATALOG_COLUMNS.map((c) => csvField(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export interface NeededProduct {
  key: string;
  ref: ProductRef;
  /** Takeoff conditions or cable types that need it. */
  uses: string[];
  /** Takeoff label of the first use ("Data outlet, 2-port (CAT6A plenum)"). */
  label: string;
  quantity: number;
  unit: "EA" | "FT";
}

/** The products the mapped takeoff needs, one per product (several conditions may share one). */
export function neededProducts(facts: TakeoffFacts, mapping: DtoolsMapping): { needed: NeededProduct[]; unmapped: string[] } {
  const out = new Map<string, NeededProduct>();
  const unmapped: string[] = [];
  for (const c of facts.conditions) {
    const ref = lookup(mapping.conditions, c.tag, c.id);
    if (!ref) { unmapped.push(`${c.tag} (${c.label}, ${c.ea} EA)`); continue; }
    const key = refKey(ref);
    const cur = out.get(key) ?? { key, ref, uses: [], label: c.label, quantity: 0, unit: "EA" as const };
    cur.uses.push(c.tag);
    cur.quantity += c.ea;
    out.set(key, cur);
  }
  for (const c of facts.cables) {
    const ref = c.cableType ? lookup(mapping.cables, c.cableType) : undefined;
    if (!ref) { unmapped.push(`cable ${c.cableType || "(no cable type)"} (${c.orderFt} ft)`); continue; }
    const key = refKey(ref);
    const cur = out.get(key) ?? { key, ref, uses: [], label: `${c.cableType} cable`, quantity: 0, unit: "FT" as const };
    cur.uses.push(c.cableType);
    cur.quantity = Math.round((cur.quantity + c.orderFt) * 10) / 10;
    out.set(key, cur);
  }
  return { needed: [...out.values()], unmapped };
}

/** A catalog import row for a product the catalog lacks. unitCost comes from the price book when the tool found one. */
export function catalogRow(p: NeededProduct, extra: { unitCost?: number | null; supplier?: string | null } = {}): CatalogRow {
  const r = p.ref;
  return {
    Brand: r.brand ?? "",
    Model: r.model ?? r.partNumber ?? "",
    "Part Number": r.partNumber ?? "",
    "Short Description": p.label,
    Description: r.description ?? `${p.label} (takeoff: ${p.uses.join(", ")})`,
    Category: r.category ?? "",
    Keywords: p.uses.join(" "),
    MSRP: null,
    "Unit Cost": extra.unitCost ?? null,
    "Unit Price": null,
    Taxable: "",
    Supplier: r.supplier ?? extra.supplier ?? "",
    System: r.system ?? "",
    Phase: "",
  };
}

const fmtFt = (n: number) => `${Math.round(n).toLocaleString("en-US")} ft`;

/** The plain-text scope, room by room (D-Tools location names where mapped), then cable, then totals. */
export function scopeText(args: { projectName: string; date: string; facts: TakeoffFacts; mapping: DtoolsMapping }): string {
  const { facts, mapping } = args;
  const condById = new Map(facts.conditions.map((c) => [c.id, c]));
  const product = (tag: string, id: string) => {
    const ref = lookup(mapping.conditions, tag, id);
    return ref ? refLabel(ref) : null;
  };
  const itemText = (n: number, c: { tag: string; id: string; label: string }) => {
    const p = product(c.tag, c.id);
    return `${n} x ${c.label} [${c.tag}${p ? `; ${p}` : ""}]`;
  };
  const out: string[] = [
    `Scope by location: ${args.projectName} (from the takeoff, ${args.date})`,
    "Paste into D-Tools Quote Assist, or build the quote location by location. Counts are the takeoff's; cable feet include the takeoff's waste.",
    "",
  ];
  const placed = new Map<string, number>();
  if (facts.rooms?.length) {
    const byRoom = new Map<string, { id: string; n: number }[]>();
    for (const r of facts.rooms) {
      if (!condById.has(r.conditionId)) continue;
      byRoom.set(r.room, [...(byRoom.get(r.room) ?? []), { id: r.conditionId, n: r.count }]);
      placed.set(r.conditionId, (placed.get(r.conditionId) ?? 0) + r.count);
    }
    const rooms = [...byRoom.keys()].sort((a, b) => (a === UNKNOWN_ROOM ? 1 : b === UNKNOWN_ROOM ? -1 : a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })));
    for (const room of rooms) {
      const loc = lookup(mapping.rooms, room);
      const items = byRoom.get(room)!.sort((a, b) => condById.get(a.id)!.tag.localeCompare(condById.get(b.id)!.tag)).map((x) => itemText(x.n, condById.get(x.id)!));
      out.push(`${room === UNKNOWN_ROOM ? "No room (place these by hand)" : loc && loc !== room ? `${loc} (takeoff room ${room})` : room}: ${items.join(", ")}`);
    }
  }
  const unplaced = facts.conditions.map((c) => ({ c, n: c.ea - (placed.get(c.id) ?? 0) })).filter((x) => x.n > 0);
  if (unplaced.length) out.push(`${facts.rooms?.length ? "Not placed in a room" : "Items (the takeoff has no room data)"}: ${unplaced.map((x) => itemText(x.n, x.c)).join(", ")}`);
  if (facts.cables.length) {
    out.push("", "Cable (length-based items, order feet incl. waste):");
    for (const c of facts.cables) {
      const ref = c.cableType ? lookup(mapping.cables, c.cableType) : undefined;
      out.push(`  ${c.cableType || "(no cable type)"}: ${fmtFt(c.orderFt)} (${fmtFt(c.measuredFt)} measured)${ref ? ` [${refLabel(ref)}]` : ""}`);
    }
  }
  if (facts.conditions.length) {
    out.push("", "Takeoff totals:");
    for (const c of facts.conditions) out.push(`  ${itemText(c.ea, c)}`);
  }
  if (facts.notes.length) out.push("", "Notes:", ...facts.notes.map((n) => `  - ${n}`));
  return `${out.join("\n")}\n`;
}
