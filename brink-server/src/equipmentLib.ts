// The equipment library (store: system/equipment.json): rack units, watts and
// ports of the gear the install designs place, each from the manufacturer's
// spec sheet with its source and date. Like the price book (src/pricebook.ts),
// history is never overwritten: a new entry for the same manufacturer + model
// is appended and the newest wins; exact repeats are dropped.
import type { Storage } from "./types.ts";
import type { EquipmentLibrary, EquipmentPort, EquipmentSpec } from "./installTypes.ts";
import { KeyedMutex } from "./projects.ts";

export const EQUIPMENT_KEY = "system/equipment.json";

const words = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tight = (s: string) => words(s).replace(/ /g, "");

/** The normalised key: "<manufacturer>:<model>", letters and digits only ("Example Co", "SW-48P" → "exampleco:sw48p"). */
export function equipmentKey(manufacturer: string, model: string): string {
  return `${tight(manufacturer ?? "")}:${tight(model ?? "")}`;
}

/** A key as a caller wrote it → its normal form. */
export function normaliseEquipmentKey(k: string): string {
  const [m, ...rest] = String(k ?? "").split(":");
  return rest.length ? `${tight(m)}:${tight(rest.join(":"))}` : tight(m);
}

/** A run of numbered ports, e.g. {prefix: "p", count: 48, label: "PORT {n}", signal: "ethernet", poe: true}. */
export interface PortGroup {
  prefix: string;
  count: number;
  /** "{n}" is the number; default "<PREFIX> {n}". */
  label?: string;
  signal: string;
  connector?: string;
  direction?: "in" | "out" | "bidir";
  poe?: boolean;
  /** First number (default 1). */
  start?: number;
}

export function expandPortGroups(groups: PortGroup[]): EquipmentPort[] {
  const out: EquipmentPort[] = [];
  for (const g of groups) {
    const start = g.start ?? 1;
    for (let n = start; n < start + g.count; n++) {
      out.push({
        id: `${g.prefix}${n}`,
        label: (g.label ?? `${g.prefix.toUpperCase()} {n}`).replace(/\{n\}/g, String(n)),
        signal: g.signal,
        ...(g.connector ? { connector: g.connector } : {}),
        ...(g.direction ? { direction: g.direction } : {}),
        ...(g.poe !== undefined ? { poe: g.poe } : {}),
      });
    }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIRECTIONS = new Set(["in", "out", "bidir"]);

/** What a caller hands record(): key optional; ports and/or portGroups. */
export type EquipmentSpecInput = Omit<EquipmentSpec, "key" | "ports"> & { key?: string; ports?: EquipmentPort[]; portGroups?: PortGroup[] };

/** Validate and normalise one entry; throws with what is wrong. */
export function normaliseEquipment(raw: EquipmentSpecInput, at?: number): EquipmentSpec {
  const where = at !== undefined ? `entry ${at + 1}: ` : "";
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const manufacturer = str(raw?.manufacturer);
  const model = str(raw?.model);
  const description = str(raw?.description);
  const source = str(raw?.source);
  const date = str(raw?.date);
  if (!manufacturer) throw new Error(`${where}manufacturer is required`);
  if (!model) throw new Error(`${where}model is required`);
  if (!description) throw new Error(`${where}description is required`);
  if (!Number.isInteger(raw.ruHeight) || raw.ruHeight < 0 || raw.ruHeight > 60) throw new Error(`${where}ruHeight must be a whole number of rack units (0 for non-rack gear)`);
  if (raw.watts !== null && (typeof raw.watts !== "number" || !Number.isFinite(raw.watts) || raw.watts < 0)) throw new Error(`${where}watts must be the spec sheet's maximum draw (0 or more), or null when the sheet does not say`);
  if (!source) throw new Error(`${where}source is required (the spec sheet URL or document)`);
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`${where}date must be YYYY-MM-DD (the day the spec sheet was read)`);
  const ports = [...(raw.ports ?? []), ...expandPortGroups(raw.portGroups ?? [])].map((p, i) => {
    const id = str(p?.id);
    const label = str(p?.label) || id;
    const signal = str(p?.signal);
    if (!id) throw new Error(`${where}port ${i + 1} needs an id`);
    if (!signal) throw new Error(`${where}port ${id} needs a signal (ethernet, hdmi, speaker, fiber, ...)`);
    if (p.direction !== undefined && !DIRECTIONS.has(p.direction)) throw new Error(`${where}port ${id}: direction must be in, out or bidir`);
    return { id, label, signal, ...(str(p.connector) ? { connector: str(p.connector) } : {}), ...(p.direction ? { direction: p.direction } : {}), ...(typeof p.poe === "boolean" ? { poe: p.poe } : {}) } as EquipmentPort;
  });
  const ids = new Set<string>();
  for (const p of ports) {
    if (ids.has(p.id)) throw new Error(`${where}port id ${p.id} appears twice`);
    ids.add(p.id);
  }
  const e: EquipmentSpec = {
    key: str(raw.key) ? normaliseEquipmentKey(str(raw.key)) : equipmentKey(manufacturer, model),
    manufacturer, model, description,
    ruHeight: raw.ruHeight,
    watts: raw.watts,
    ports,
    source, date,
    ...(str(raw.notes) ? { notes: str(raw.notes) } : {}),
  };
  if (!/^[a-z0-9]+:[a-z0-9]+$/.test(e.key)) throw new Error(`${where}key ${JSON.stringify(e.key)} must read manufacturer:model`);
  return e;
}

/** Newest date first, then the later-recorded entry. */
const best = (a: { e: EquipmentSpec; i: number }, b: { e: EquipmentSpec; i: number }) => (a.e.date !== b.e.date ? (a.e.date < b.e.date ? 1 : -1) : b.i - a.i);

/** The newest entry for a key, or null. */
export function lookupEquipment(lib: EquipmentLibrary, key: string): EquipmentSpec | null {
  const k = normaliseEquipmentKey(key);
  return lib.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.key === k).sort(best)[0]?.e ?? null;
}

/** Token search over manufacturer, model, description and key: the newest entry per key. */
export function findEquipment(lib: EquipmentLibrary, query: string, limit = 20): EquipmentSpec[] {
  const toks = words(query ?? "").split(" ").filter(Boolean);
  const seen = new Set<string>();
  return lib.entries
    .map((e, i) => ({ e, i }))
    .sort(best)
    .filter(({ e }) => {
      if (seen.has(e.key)) return false;
      const hay = words([e.manufacturer, e.model, e.description, e.key, tight(e.model)].join(" "));
      const tightHay = hay.replace(/ /g, "");
      const hit = toks.every((t) => hay.includes(t) || tightHay.includes(t));
      if (hit) seen.add(e.key);
      return hit;
    })
    .slice(0, Math.max(1, limit))
    .map(({ e }) => e);
}

const sameEntry = (a: EquipmentSpec, b: EquipmentSpec) => JSON.stringify({ ...a, notes: a.notes ?? "" }) === JSON.stringify({ ...b, notes: b.notes ?? "" });

export function emptyEquipmentLibrary(): EquipmentLibrary {
  return { schema: "brink.equipment.v1", entries: [] };
}

export class StoreEquipmentLibrary {
  private readonly lock = new KeyedMutex();
  constructor(private readonly storage: Storage, private readonly key = EQUIPMENT_KEY) {}

  async all(): Promise<EquipmentLibrary> {
    const bytes = await this.storage.getBytes(this.key);
    if (!bytes) return emptyEquipmentLibrary();
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as EquipmentLibrary;
    if (parsed?.schema !== "brink.equipment.v1" || !Array.isArray(parsed.entries)) throw new Error(`${this.key} is not a brink.equipment.v1 document`);
    return parsed;
  }

  async find(query: string, opts: { limit?: number } = {}): Promise<EquipmentSpec[]> {
    return findEquipment(await this.all(), query, opts.limit ?? 20);
  }

  /** The newest entry for a key (manufacturer:model), or null. */
  async lookup(key: string): Promise<EquipmentSpec | null> {
    return lookupEquipment(await this.all(), key);
  }

  /** Append entries (validated; exact repeats dropped). All or nothing on a bad entry. */
  async record(entries: EquipmentSpecInput[]): Promise<{ added: EquipmentSpec[]; duplicates: EquipmentSpec[] }> {
    const norm = entries.map((e, i) => normaliseEquipment(e, i));
    return this.lock.run(this.key, async () => {
      const lib = await this.all();
      const added: EquipmentSpec[] = [];
      const duplicates: EquipmentSpec[] = [];
      for (const e of norm) {
        if (lib.entries.some((x) => sameEntry(x, e)) || added.some((x) => sameEntry(x, e))) { duplicates.push(e); continue; }
        added.push(e);
      }
      if (added.length) {
        lib.entries.push(...added);
        await this.storage.put(this.key, `${JSON.stringify(lib, null, 1)}\n`, { contentType: "application/json" });
      }
      return { added, duplicates };
    });
  }
}
