// The price book (store: system/pricebook.json): every material price Claude
// looked up or the owner's quotes and past bids carried, each with its source
// and date. History is never overwritten: a new price for the same item is a
// new entry, and the bid takes the newest (src/bid/price.ts). Exact repeats
// (same item, price, unit, date, source, status, supplier) are dropped.
import type { Storage } from "./types.ts";
import type { PriceBook, PriceEntry, PriceStatus } from "./bidTypes.ts";
import { KeyedMutex } from "./projects.ts";

export const PRICEBOOK_KEY = "system/pricebook.json";
export const PRICE_STATUSES: readonly PriceStatus[] = ["live", "estimate", "allowance"];

/** Lowercase words, punctuation folded to single spaces ("CAT6A  Plenum, Blue" → "cat6a plenum blue"). */
const words = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Lowercase letters and digits only ("CS-6A PL" → "cs6apl"): part numbers are written with and without dashes. */
const tight = (s: string) => words(s).replace(/ /g, "");

/** The key for a description alone: "desc:<words>". */
export function descriptionKey(description: string): string {
  return `desc:${words(description ?? "")}`;
}

/**
 * The normalised price key: manufacturer + part when both are known
 * ("mp:<manufacturer>:<part>", letters and digits only), else the description
 * key ("desc:<words>"). The bid uses the same function for its lines, so a
 * price recorded once matches every later line naming the same item.
 */
export function priceKey(item: { manufacturer?: string | null; part?: string | null; description?: string | null }): string {
  const m = tight(item.manufacturer ?? "");
  const p = tight(item.part ?? "");
  if (m && p) return `mp:${m}:${p}`;
  return descriptionKey(item.description ?? "");
}

/** Newest first; among the same date live > estimate > allowance; then the later-recorded entry first. */
export function compareEntries(a: { e: PriceEntry; i: number }, b: { e: PriceEntry; i: number }): number {
  if (a.e.date !== b.e.date) return a.e.date < b.e.date ? 1 : -1;
  const r = PRICE_STATUSES.indexOf(a.e.status) - PRICE_STATUSES.indexOf(b.e.status);
  if (r) return r;
  return b.i - a.i;
}

/**
 * Entries for a key, best first (newest; live > estimate > allowance on the
 * same date). An entry matches when its key is the key, or when the key is a
 * description key and the entry's description reads the same: a price
 * recorded with manufacturer + part still prices a line that only names the
 * item by description.
 */
export function lookupEntries(book: PriceBook, key: string): PriceEntry[] {
  const isDesc = key.startsWith("desc:");
  return book.entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.key === key || (isDesc && descriptionKey(e.description) === key))
    .sort(compareEntries)
    .map(({ e }) => e);
}

/** Token search: every word of the query must appear in the entry's manufacturer, part, description, key or supplier. Newest first. */
export function findEntries(book: PriceBook, query: string, limit = 20): PriceEntry[] {
  const toks = words(query ?? "").split(" ").filter(Boolean);
  return book.entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      if (!toks.length) return true;
      const hay = words([e.manufacturer, e.part, e.description, e.key, e.supplier, e.part ? tight(e.part) : ""].filter(Boolean).join(" "));
      const tightHay = hay.replace(/ /g, "");
      return toks.every((t) => hay.includes(t) || tightHay.includes(t));
    })
    .sort(compareEntries)
    .slice(0, Math.max(1, limit))
    .map(({ e }) => e);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a caller hands record(): the key is optional (computed when absent). */
export type PriceEntryInput = Omit<PriceEntry, "key"> & { key?: string };

/** Validate and normalise one entry; throws with what is wrong. */
export function normaliseEntry(raw: PriceEntryInput, at?: number): PriceEntry {
  const where = at !== undefined ? `entry ${at + 1}: ` : "";
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const description = str(raw?.description);
  const unit = str(raw?.unit).toUpperCase();
  const source = str(raw?.source);
  const date = str(raw?.date);
  if (!description) throw new Error(`${where}description is required`);
  if (!unit) throw new Error(`${where}unit is required (EA, FT, BOX(1000FT), ...)`);
  if (typeof raw.price !== "number" || !Number.isFinite(raw.price) || raw.price < 0) throw new Error(`${where}price must be a number of 0 or more`);
  if (!source) throw new Error(`${where}source is required (the URL, "CED quote #1234", "past bid: <project>")`);
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`${where}date must be YYYY-MM-DD (the day the price was seen or quoted)`);
  if (!PRICE_STATUSES.includes(raw.status)) throw new Error(`${where}status must be live, estimate or allowance`);
  const e: PriceEntry = {
    key: "",
    description,
    ...(str(raw.manufacturer) ? { manufacturer: str(raw.manufacturer) } : {}),
    ...(str(raw.part) ? { part: str(raw.part) } : {}),
    unit,
    price: Math.round(raw.price * 10000) / 10000,
    ...(str(raw.supplier) ? { supplier: str(raw.supplier) } : {}),
    source,
    date,
    status: raw.status,
    ...(str(raw.project) ? { project: str(raw.project) } : {}),
    ...(str(raw.notes) ? { notes: str(raw.notes) } : {}),
  };
  e.key = str(raw.key) ? normaliseKey(str(raw.key)) : priceKey(e);
  return e;
}

/** A key as a caller wrote it → its normal form (prefix kept, body folded). */
export function normaliseKey(k: string): string {
  const m = /^(mp|desc):(.*)$/i.exec(k.trim());
  if (!m) return descriptionKey(k);
  if (m[1].toLowerCase() === "desc") return descriptionKey(m[2]);
  const [mf, ...rest] = m[2].split(":");
  return `mp:${tight(mf)}:${tight(rest.join(":"))}`;
}

const sameEntry = (a: PriceEntry, b: PriceEntry) =>
  a.key === b.key && a.price === b.price && a.unit === b.unit && a.date === b.date && a.source === b.source && a.status === b.status && (a.supplier ?? "") === (b.supplier ?? "");

export function emptyPriceBook(): PriceBook {
  return { schema: "brink.pricebook.v1", entries: [] };
}

export class StorePriceBook {
  private readonly lock = new KeyedMutex();
  constructor(private readonly storage: Storage, private readonly key = PRICEBOOK_KEY) {}

  /** The whole book (empty when none is stored yet). */
  async all(): Promise<PriceBook> {
    const bytes = await this.storage.getBytes(this.key);
    if (!bytes) return emptyPriceBook();
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as PriceBook;
    if (parsed?.schema !== "brink.pricebook.v1" || !Array.isArray(parsed.entries)) throw new Error(`${this.key} is not a brink.pricebook.v1 document`);
    return parsed;
  }

  async find(query: string, opts: { limit?: number } = {}): Promise<PriceEntry[]> {
    return findEntries(await this.all(), query, opts.limit ?? 20);
  }

  /** Entries for a normalised key, best first (see lookupEntries). */
  async lookup(key: string): Promise<PriceEntry[]> {
    return lookupEntries(await this.all(), normaliseKey(key));
  }

  /** Append entries (validated; exact repeats dropped). Nothing is overwritten. All or nothing on a bad entry. */
  async record(entries: PriceEntryInput[]): Promise<{ added: PriceEntry[]; duplicates: PriceEntry[] }> {
    const norm = entries.map((e, i) => normaliseEntry(e, i));
    return this.lock.run(this.key, async () => {
      const book = await this.all();
      const added: PriceEntry[] = [];
      const duplicates: PriceEntry[] = [];
      for (const e of norm) {
        if (book.entries.some((x) => sameEntry(x, e)) || added.some((x) => sameEntry(x, e))) { duplicates.push(e); continue; }
        added.push(e);
      }
      if (added.length) {
        book.entries.push(...added);
        await this.storage.put(this.key, `${JSON.stringify(book, null, 1)}\n`, { contentType: "application/json" });
      }
      return { added, duplicates };
    });
  }
}
