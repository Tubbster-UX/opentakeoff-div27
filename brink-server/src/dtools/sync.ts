// Re-read a project's linked D-Tools records into the cache and say what
// changed since the last read. Used by dtools_sync, dtools_link and the
// webhook receiver (which always re-reads through the API instead of trusting
// the payload).
import type { ProjectId } from "../types.ts";
import { DtoolsError, type DtoolsClient, type DtOpportunityDetail, type DtProjectDetail, type DtQuoteDetail, type DtQuoteItem, type DtQuoteLite } from "./client.ts";
import { changedFields, type CacheKind, type DtoolsLinks, type DtoolsStore } from "./store.ts";

/** Header fields compared between reads (and shown in replies). */
export const SUMMARY_FIELDS: Record<CacheKind, string[]> = {
  opportunity: ["name", "number", "clientName", "stageGroup", "stage", "priority", "price", "total", "budget", "probability", "owner", "estimatedCloseDate", "quoteTemplate", "isArchived", "quoteIds"],
  project: ["name", "number", "clientName", "stageGroup", "stage", "priority", "price", "budget", "salesperson", "projectManager", "startDate", "endDate", "completedDate", "isArchived"],
  quote: ["name", "number", "version", "state", "price"],
};

export function pick(o: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

const itemDesc = (i: DtQuoteItem) => `${[i.brand, i.model].filter(Boolean).join(" ") || i.partNumber || i.name || `item ${i.id}`}${i.location ? ` @ ${i.location}` : ""}`;
const itemQty = (i: DtQuoteItem) => (i.isLengthBased ? `${i.quantity} × ${i.length ?? "?"} ft` : `${i.quantity}`);

/** Items added, removed or changed (quantity, length, price) between two reads of a quote. */
export function quoteItemChanges(before: DtQuoteDetail | null, after: DtQuoteDetail): { added: string[]; removed: string[]; changed: string[] } {
  const b = new Map((before?.items ?? []).map((i) => [i.id, i]));
  const a = new Map((after.items ?? []).map((i) => [i.id, i]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, i] of a) {
    const p = b.get(id);
    if (!p) { added.push(`${itemDesc(i)} ×${itemQty(i)}`); continue; }
    const diffs: string[] = [];
    if (p.quantity !== i.quantity || (p.length ?? null) !== (i.length ?? null)) diffs.push(`qty ${itemQty(p)} → ${itemQty(i)}`);
    if ((p.unitPrice ?? null) !== (i.unitPrice ?? null)) diffs.push(`price ${p.unitPrice ?? "-"} → ${i.unitPrice ?? "-"}`);
    if ((p.location ?? null) !== (i.location ?? null)) diffs.push(`location ${p.location ?? "-"} → ${i.location ?? "-"}`);
    if (diffs.length) changed.push(`${itemDesc(i)}: ${diffs.join(", ")}`);
  }
  for (const [id, p] of b) if (!a.has(id)) removed.push(`${itemDesc(p)} ×${itemQty(p)}`);
  return { added, removed, changed };
}

export interface SyncChange {
  entity: CacheKind;
  id: string;
  /** First read of this record (nothing cached to compare with). */
  first?: true;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  items?: { added: string[]; removed: string[]; changed: string[] };
}

export interface SyncReport {
  project: ProjectId;
  links: DtoolsLinks | null;
  syncedAt: string | null;
  changes: SyncChange[];
  unchanged: CacheKind[];
  errors: string[];
  /** The linked opportunity's quotes, when no quote is linked yet. */
  quotesAvailable?: { id: string; name: string | null; number: string | null; version?: number; price?: number }[];
}

const KIND_ID: Record<CacheKind, keyof DtoolsLinks> = { opportunity: "opportunityId", project: "projectId", quote: "quoteId" };

async function read(client: DtoolsClient, kind: CacheKind, id: string): Promise<Record<string, unknown>> {
  if (kind === "opportunity") return (await client.getOpportunity(id)) as DtOpportunityDetail as Record<string, unknown>;
  if (kind === "project") return (await client.getProject(id)) as DtProjectDetail as Record<string, unknown>;
  return (await client.getQuote(id)) as DtQuoteDetail as Record<string, unknown>;
}

/** Re-read every linked record of the project (or only `only`) into the cache; what changed since the cached read. */
export async function syncProject(client: DtoolsClient, store: DtoolsStore, project: ProjectId, opts: { only?: CacheKind[] } = {}): Promise<SyncReport> {
  const links = await store.links(project);
  const report: SyncReport = { project, links, syncedAt: null, changes: [], unchanged: [], errors: [] };
  if (!links) return report;
  for (const kind of opts.only ?? (["opportunity", "project", "quote"] as CacheKind[])) {
    const id = links[KIND_ID[kind]] as string | undefined;
    if (!id) continue;
    const prev = await store.getCache(project, kind);
    let fresh: Record<string, unknown>;
    try {
      fresh = await read(client, kind, id);
    } catch (e) {
      report.errors.push(e instanceof DtoolsError && e.notFound ? `${kind} ${id} is no longer in D-Tools (deleted or moved); the link is kept until you change it.` : `${kind} ${id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    await store.putCache(project, kind, id, fresh);
    const keys = SUMMARY_FIELDS[kind];
    if (!prev || prev.id !== id) {
      report.changes.push({ entity: kind, id, first: true, after: pick(fresh, keys) });
      continue;
    }
    const { before, after } = changedFields(pick(prev.data, keys), pick(fresh, keys), keys);
    const items = kind === "quote" ? quoteItemChanges(prev.data as unknown as DtQuoteDetail, fresh as unknown as DtQuoteDetail) : undefined;
    const itemsChanged = !!items && (items.added.length + items.removed.length + items.changed.length > 0);
    if (Object.keys(after).length || itemsChanged) report.changes.push({ entity: kind, id, before, after, ...(itemsChanged ? { items } : {}) });
    else report.unchanged.push(kind);
  }
  if (links.opportunityId && !links.quoteId) {
    try {
      const qs: DtQuoteLite[] = await client.getQuotes(links.opportunityId);
      report.quotesAvailable = qs.map((q) => ({ id: q.id, name: q.name ?? null, number: q.number ?? null, version: q.version, price: q.price }));
    } catch (e) {
      report.errors.push(`quotes of opportunity ${links.opportunityId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!opts.only) {
    const saved = await store.setLinks(project, { lastSync: new Date().toISOString() });
    report.links = saved;
    report.syncedAt = saved.lastSync ?? null;
  }
  return report;
}

/** A short line per change, for the log and replies. */
export function describeChanges(r: SyncReport): string[] {
  const out: string[] = [];
  for (const c of r.changes) {
    if (c.first) { out.push(`${c.entity} ${c.id}: first read`); continue; }
    const fields = Object.keys(c.after ?? {}).map((k) => `${k} ${JSON.stringify(c.before?.[k] ?? null)} → ${JSON.stringify(c.after?.[k] ?? null)}`);
    const items = c.items ? [...c.items.added.map((x) => `+ ${x}`), ...c.items.removed.map((x) => `- ${x}`), ...c.items.changed.map((x) => `~ ${x}`)] : [];
    out.push(`${c.entity} ${c.id}: ${[...fields, ...items.slice(0, 20), ...(items.length > 20 ? [`(${items.length - 20} more item changes)`] : [])].join("; ")}`);
  }
  return out;
}
