// What brink-server keeps about D-Tools Cloud, in the object store:
//
//   projects/<p>/project.json                 manifest.dtools: the links (client,
//                                             opportunity, project, quote ids) + last sync
//   projects/<p>/dtools/{opportunity,project,quote}.json
//                                             the latest read of each linked entity, with fetchedAt
//   projects/<p>/dtools/mapping.json          takeoff condition / cable type → D-Tools product,
//                                             room → quote location (dtools_set_mapping)
//   system/dtools-log.jsonl                   append-only log of every D-Tools write and
//                                             webhook (time, actor, action, entity, id, before/after)
//   system/dtools-pending-prices.json         price changes Claude proposed, waiting for the
//                                             owner's OK on the phone page
//
// The store has no append, so the log is read-modify-written under a lock
// (one server process; the owner's volume is small).
import { randomBytes } from "node:crypto";
import type { Projects, ProjectId, Storage } from "../types.ts";
import { KeyedMutex } from "../projects.ts";

export const LOG_KEY = "system/dtools-log.jsonl";
export const PENDING_KEY = "system/dtools-pending-prices.json";
export const CACHE_KINDS = ["opportunity", "project", "quote"] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

export interface DtoolsLinks {
  clientId?: string;
  opportunityId?: string;
  projectId?: string;
  quoteId?: string;
  linkedAt: string;
  lastSync?: string;
}

export interface CachedEntity<T = Record<string, unknown>> {
  kind: CacheKind;
  id: string;
  fetchedAt: string;
  data: T;
}

export type DtoolsActor = "claude" | "owner" | "webhook";

export interface DtoolsLogEntry {
  time: string;
  actor: DtoolsActor;
  /** create, update, link, sync, webhook, propose_price, apply_price, reject_price, ... */
  action: string;
  /** client, opportunity, project, quote, product, ... */
  entity: string;
  id?: string;
  /** Our project the entry concerns, when there is one. */
  project?: string;
  /** Only the fields that changed. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
}

export interface PriceTriple {
  msrp?: number | null;
  unitCost?: number | null;
  unitPrice?: number | null;
}

export interface PendingPrice {
  id: string;
  productId: string;
  brand?: string | null;
  model?: string | null;
  partNumber?: string | null;
  /** The catalog's prices when Claude proposed the change. */
  old: PriceTriple;
  /** Only the fields Claude proposes to change. */
  new: PriceTriple;
  /** Where the new price comes from (URL, distributor quote reference, ...) and its date. */
  source: string;
  date: string;
  requestedAt: string;
  requestedBy: "claude";
  status: "pending" | "applied" | "rejected";
  decidedAt?: string;
  /** The last failed attempt to apply it (it stays pending). */
  error?: string;
  errorAt?: string;
}

/** A D-Tools catalog product, named by brand + model or by part number. Catalog hints feed the import CSV. */
export interface ProductRef {
  brand?: string;
  model?: string;
  partNumber?: string;
  category?: string;
  system?: string;
  description?: string;
  supplier?: string;
}

export interface DtoolsMapping {
  schema: "brink.dtools-mapping.v1";
  /** Takeoff condition (finish tag or id) → product. */
  conditions: Record<string, ProductRef>;
  /** Takeoff cable type (cable_setup.cable_type) → length-based product. */
  cables: Record<string, ProductRef>;
  /** Takeoff room → D-Tools quote location name. */
  rooms: Record<string, string>;
  updated?: string;
}

export const emptyMapping = (): DtoolsMapping => ({ schema: "brink.dtools-mapping.v1", conditions: {}, cables: {}, rooms: {} });

/** Throws unless the reference names a product (brand + model, or a part number). */
export function checkProductRef(where: string, r: ProductRef): ProductRef {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const out: ProductRef = {};
  for (const k of ["brand", "model", "partNumber", "category", "system", "description", "supplier"] as const) if (s(r?.[k])) out[k] = s(r[k]);
  if (!(out.brand && out.model) && !out.partNumber) throw new Error(`${where}: give {brand, model} or {partNumber}`);
  return out;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 1)}\n`;
const parse = <T>(b: Uint8Array | null): T | null => (b ? (JSON.parse(Buffer.from(b).toString("utf8")) as T) : null);

export class DtoolsStore {
  private readonly lock = new KeyedMutex();
  constructor(private readonly storage: Storage, private readonly projects: Projects, private readonly now: () => string = () => new Date().toISOString()) {}

  // ── links ──
  async links(project: ProjectId): Promise<DtoolsLinks | null> {
    return (await this.projects.get(project))?.dtools ?? null;
  }

  /** Merge into the project's links (undefined keeps a value, null removes it). */
  async setLinks(project: ProjectId, patch: { [K in keyof DtoolsLinks]?: DtoolsLinks[K] | null }): Promise<DtoolsLinks> {
    const m = await this.projects.update(project, (man) => {
      const cur: DtoolsLinks = { ...(man.dtools ?? { linkedAt: this.now() }) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete (cur as unknown as Record<string, unknown>)[k];
        else (cur as unknown as Record<string, unknown>)[k] = v;
      }
      man.dtools = cur;
    });
    return m.dtools!;
  }

  // ── cache ──
  cacheKey(project: ProjectId, kind: CacheKind): string {
    return `projects/${project}/dtools/${kind}.json`;
  }
  async getCache<T = Record<string, unknown>>(project: ProjectId, kind: CacheKind): Promise<CachedEntity<T> | null> {
    return parse<CachedEntity<T>>(await this.storage.getBytes(this.cacheKey(project, kind)));
  }
  async putCache<T>(project: ProjectId, kind: CacheKind, id: string, data: T): Promise<CachedEntity<T>> {
    const c: CachedEntity<T> = { kind, id, fetchedAt: this.now(), data };
    await this.storage.put(this.cacheKey(project, kind), json(c), { contentType: "application/json" });
    return c;
  }
  async dropCache(project: ProjectId, kind: CacheKind): Promise<void> {
    await this.storage.delete(this.cacheKey(project, kind));
  }

  // ── mapping ──
  async getMapping(project: ProjectId): Promise<DtoolsMapping> {
    const m = parse<DtoolsMapping>(await this.storage.getBytes(`projects/${project}/dtools/mapping.json`));
    return m ? { ...emptyMapping(), ...m, conditions: m.conditions ?? {}, cables: m.cables ?? {}, rooms: m.rooms ?? {} } : emptyMapping();
  }
  async putMapping(project: ProjectId, m: DtoolsMapping): Promise<void> {
    await this.storage.put(`projects/${project}/dtools/mapping.json`, json({ ...m, updated: this.now() }), { contentType: "application/json" });
  }

  // ── log ──
  async log(entry: Omit<DtoolsLogEntry, "time"> & { time?: string }): Promise<DtoolsLogEntry> {
    const e: DtoolsLogEntry = { time: entry.time ?? this.now(), ...entry } as DtoolsLogEntry;
    await this.lock.run(LOG_KEY, async () => {
      const prev = await this.storage.getBytes(LOG_KEY);
      const head = prev ? Buffer.from(prev).toString("utf8") : "";
      await this.storage.put(LOG_KEY, `${head}${head && !head.endsWith("\n") ? "\n" : ""}${JSON.stringify(e)}\n`, { contentType: "application/x-ndjson" });
    });
    return e;
  }

  /** Newest first. */
  async readLog(opts: { project?: string; ids?: string[]; limit?: number } = {}): Promise<DtoolsLogEntry[]> {
    const b = await this.storage.getBytes(LOG_KEY);
    if (!b) return [];
    const ids = new Set((opts.ids ?? []).filter(Boolean));
    const out: DtoolsLogEntry[] = [];
    const lines = Buffer.from(b).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < (opts.limit ?? 50); i--) {
      if (!lines[i].trim()) continue;
      let e: DtoolsLogEntry;
      try {
        e = JSON.parse(lines[i]) as DtoolsLogEntry;
      } catch {
        continue;
      }
      if (opts.project || ids.size) {
        if (!(opts.project && e.project === opts.project) && !(e.id && ids.has(e.id))) continue;
      }
      out.push(e);
    }
    return out;
  }

  // ── pending price changes ──
  async listPending(status?: PendingPrice["status"]): Promise<PendingPrice[]> {
    const all = parse<{ entries: PendingPrice[] }>(await this.storage.getBytes(PENDING_KEY))?.entries ?? [];
    return status ? all.filter((p) => p.status === status) : all;
  }

  async addPending(entries: Omit<PendingPrice, "id" | "requestedAt" | "requestedBy" | "status">[]): Promise<PendingPrice[]> {
    return this.lock.run(PENDING_KEY, async () => {
      const all = await this.listPending();
      const added = entries.map((e): PendingPrice => ({ id: `pp-${randomBytes(5).toString("hex")}`, ...e, requestedAt: this.now(), requestedBy: "claude", status: "pending" }));
      all.push(...added);
      await this.storage.put(PENDING_KEY, json({ schema: "brink.dtools-pending-prices.v1", entries: all }), { contentType: "application/json" });
      return added;
    });
  }

  /** Read-modify-write one entry under the lock; null when there is no such id. */
  async updatePending(id: string, fn: (p: PendingPrice) => void | Promise<void>): Promise<PendingPrice | null> {
    return this.lock.run(PENDING_KEY, async () => {
      const all = await this.listPending();
      const p = all.find((x) => x.id === id);
      if (!p) return null;
      await fn(p);
      await this.storage.put(PENDING_KEY, json({ schema: "brink.dtools-pending-prices.v1", entries: all }), { contentType: "application/json" });
      return p;
    });
  }

  /** Projects linked to any of these D-Tools ids. */
  async projectsLinkedTo(ids: string[]): Promise<{ project: ProjectId; links: DtoolsLinks; matched: (keyof DtoolsLinks)[] }[]> {
    const want = new Set(ids.map((x) => x.toLowerCase()));
    const out: { project: ProjectId; links: DtoolsLinks; matched: (keyof DtoolsLinks)[] }[] = [];
    for (const m of await this.projects.list()) {
      const l = m.dtools;
      if (!l) continue;
      const matched = (["clientId", "opportunityId", "projectId", "quoteId"] as const).filter((k) => l[k] && want.has(String(l[k]).toLowerCase()));
      if (matched.length) out.push({ project: m.id, links: l, matched });
    }
    return out;
  }

  async linkedProjects(): Promise<{ project: ProjectId; name: string; links: DtoolsLinks }[]> {
    return (await this.projects.list()).filter((m) => m.dtools).map((m) => ({ project: m.id, name: m.name, links: m.dtools! }));
  }
}

/** The fields that differ between two flat records (values compared as JSON). */
export function changedFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined, keys?: string[]): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const ks = keys ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  for (const k of ks) {
    const x = before?.[k] ?? null;
    const y = after?.[k] ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      b[k] = x;
      a[k] = y;
    }
  }
  return { before: b, after: a };
}
