// D-Tools Cloud tools on the hosted takeoff MCP server (/mcp). The owner
// prices, proposes and runs projects in D-Tools Cloud; this server keeps what
// D-Tools lacks (bid-package intake, plan takeoff with measured cable, spec
// reading, federal documents) and stays in sync with it:
//
//   - Claude reads clients, opportunities, projects, quotes and products, and
//     creates / updates clients, opportunities and project details on its
//     own; every write is logged (system/dtools-log.jsonl, actor "claude").
//   - Catalog price changes are only PROPOSED (system/dtools-pending-prices.json);
//     the owner approves them on the phone page (src/dtoolsRoutes.ts).
//   - Quotes are read-only in the D-Tools API: dtools_quote_inputs writes the
//     catalog import CSV and the scope-by-location text the owner uses to
//     build the quote, and dtools_reconcile checks the quote against the takeoff.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "opentakeoff-core";
import type { AppDeps, ProjectId, ProjectManifest } from "./types.ts";
import { LINK_TTL_SEC, UserError, fail, linksForPushed, ok, okText, requireProject, type OpenState, type ToolReply } from "./projectTools.ts";
import { loadDtoolsConfig, NOT_CONNECTED } from "./dtools/config.ts";
import {
  DtoolsClient, DtoolsError, type DtAddress, type DtContact, type DtNewOpportunity, type DtOpportunityDetail, type DtProduct, type DtProjectDetail,
  type DtQuoteDetail, type DtUpdateOpportunity, type DtUpdateProject,
} from "./dtools/client.ts";
import { DtoolsStore, changedFields, checkProductRef, type DtoolsLinks, type ProductRef } from "./dtools/store.ts";
import { describeChanges, pick, SUMMARY_FIELDS, syncProject } from "./dtools/sync.ts";
import { quoteLines, reconcile, refKey, refLabel, refMatches, takeoffFacts, type ReconcileResult } from "./dtools/reconcile.ts";
import { catalogCsv, catalogRow, neededProducts, scopeText, type CatalogRow } from "./dtools/quoteInputs.ts";
import { readInstallDesign } from "./installApproval.ts";
import { StorePriceBook, priceKey } from "./pricebook.ts";
import { pricePerLineUnit } from "./bid/price.ts";

export const DTOOLS_TOOL_NAMES = [
  "dtools_status", "dtools_find", "dtools_link", "dtools_create_client", "dtools_create_opportunity", "dtools_update_opportunity",
  "dtools_update_project", "dtools_sync", "dtools_quote", "dtools_set_mapping", "dtools_reconcile", "dtools_quote_inputs", "dtools_propose_prices",
] as const;

/** Where dtools_quote_inputs / dtools_reconcile write, relative to the project's outputs. */
export const DTOOLS_OUTPUTS = { csv: "dtools/catalog-import.csv", scope: "dtools/scope-by-location.txt", reconcile: "dtools/reconcile.json" } as const;

export interface DtoolsToolsCtx {
  deps: AppDeps;
  /** This MCP connection's OpenTakeoff session (its takeoff is what reconcile / quote inputs read). */
  session: Pick<Session, "exportPayload">;
  state: OpenState;
  /** Push the project's outputs to the store now; returns the project paths pushed. */
  pushOutputs(project: ProjectId): Promise<string[]>;
  linkTtlSec?: number;
  /** The D-Tools client; undefined → from the environment (null when DTOOLS_API_KEY is unset). */
  client?: DtoolsClient | null;
  store?: DtoolsStore;
  priceBook?: StorePriceBook;
}

const run = (fn: (a: any) => Promise<ToolReply> | ToolReply) => async (a: any): Promise<ToolReply> => {
  try {
    return await fn(a);
  } catch (e) {
    return fail(e);
  }
};

const projectArg = z.string().describe("Project id from list_projects");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "a D-Tools id (uuid)");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "YYYY-MM-DD or an ISO date-time");
const addressSchema = z.object({
  name: z.string().max(200).optional(), addressLine1: z.string().max(200).optional(), addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(), state: z.string().max(100).optional(), postalCode: z.string().max(30).optional(), country: z.string().max(100).optional(),
});
const contactSchema = z.object({
  name: z.string().max(200).optional(), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), company: z.string().max(200).optional(),
  title: z.string().max(200).optional(), email: z.string().max(200).optional(), phone: z.string().max(60).optional(), mobile: z.string().max(60).optional(),
  notes: z.string().max(2000).optional(), isPrimary: z.boolean().optional(),
});
const productRefSchema = z.object({
  brand: z.string().max(200).optional(), model: z.string().max(200).optional(), partNumber: z.string().max(200).optional(),
  category: z.string().max(200).optional(), system: z.string().max(200).optional(), description: z.string().max(1000).optional(), supplier: z.string().max(200).optional(),
}).describe("{brand, model} or {partNumber}; category / system / description / supplier only feed the catalog import CSV");

/** Opportunity header fields Claude may change (D-Tools' UpdateOpportunity, without resources). */
const opportunityFields = {
  name: z.string().max(300).optional(), number: z.string().max(100).optional(), clientId: uuid.optional(),
  buildingType: z.string().max(200).optional(), marketSector: z.string().max(200).optional(), projectType: z.string().max(200).optional(),
  quoteType: z.string().max(200).optional(), quoteTemplate: z.string().max(200).optional(), priority: z.string().max(100).optional(),
  budget: z.number().int().min(0).optional().describe("Whole dollars"), probability: z.number().int().min(0).max(100).optional(),
  owner: z.string().max(200).optional(), projectArea: z.number().int().min(0).optional(), fulfillmentLocation: z.string().max(200).optional(),
  estimatedCloseDate: dateArg.optional(), actualCloseDate: dateArg.optional(), estimatedProjectStartDate: dateArg.optional(), estimatedProjectEndDate: dateArg.optional(),
  leadSource: z.string().max(200).optional(), lostReason: z.string().max(200).optional(), lostDescription: z.string().max(2000).optional(),
  billingAddress: addressSchema.optional(), siteAddress: addressSchema.optional(), contacts: z.array(contactSchema).max(50).optional(),
};
/** Project header fields Claude may change (D-Tools' UpdateProject, without resources). */
const projectFields = {
  name: z.string().max(300).optional(), number: z.string().max(100).optional(), clientId: uuid.optional(), priority: z.string().max(100).optional(),
  budget: z.number().int().min(0).optional().describe("Whole dollars"), salesperson: z.string().max(200).optional(), projectManager: z.string().max(200).optional(),
  opportunityWonDate: dateArg.optional(), startDate: dateArg.optional(), endDate: dateArg.optional(), completedDate: dateArg.optional(),
  billingAddress: addressSchema.optional(), siteAddress: addressSchema.optional(), contacts: z.array(contactSchema).max(50).optional(),
};
const UPDATE_OPPORTUNITY_KEYS = Object.keys(opportunityFields);
const UPDATE_PROJECT_KEYS = Object.keys(projectFields);
const DATE_KEYS = new Set(["estimatedCloseDate", "actualCloseDate", "estimatedProjectStartDate", "estimatedProjectEndDate", "opportunityWonDate", "startDate", "endDate", "completedDate"]);

/** "2026-12-01" → "2026-12-01T00:00:00Z" (D-Tools takes date-times). */
const dtDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
const ADDRESS_KEYS = ["name", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"] as const;
const CONTACT_KEYS = ["id", "name", "firstName", "lastName", "company", "title", "email", "secondaryEmail", "mobile", "phone", "fax", "addressLine1", "addressLine2", "city", "state", "postalCode", "country", "notes", "isActive", "isPrimary"] as const;
const address = (a: unknown): DtAddress | null => (a && typeof a === "object" ? (pick(a as Record<string, unknown>, [...ADDRESS_KEYS]) as DtAddress) : null);
const contacts = (cs: unknown): DtContact[] | null => (Array.isArray(cs) ? cs.map((c) => pick(c as Record<string, unknown>, [...CONTACT_KEYS]) as DtContact) : null);

/**
 * The full update body: the record's current values for every field the
 * update takes, with the requested fields over them. The API's PUT may
 * replace the whole header, so nothing is sent as "missing". Resources are
 * left out (the read returns them as people, the write wants names).
 */
function mergedBody<T>(current: Record<string, unknown>, keys: string[], fields: Record<string, unknown>): T {
  const body: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "billingAddress" || k === "siteAddress") body[k] = address(current[k]);
    else if (k === "contacts") body[k] = contacts(current[k]);
    else if (current[k] !== undefined) body[k] = current[k];
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    body[k] = DATE_KEYS.has(k) && typeof v === "string" ? dtDate(v) : v;
  }
  return body as T;
}

const lite = {
  client: (c: Record<string, unknown>) => pick(c, ["id", "name", "number", "type", "contactName", "email", "phone", "owner", "isActive"]),
  opportunity: (o: Record<string, unknown>) => pick(o, ["id", "name", "number", "clientId", "clientName", "stage", "price", "total", "budget", "owner", "estimatedCloseDate", "modifiedDate"]),
  project: (p: Record<string, unknown>) => pick(p, ["id", "name", "number", "clientId", "clientName", "stage", "price", "projectManager", "modifiedDate"]),
  product: (p: Record<string, unknown>) => pick(p, ["id", "brand", "model", "partNumber", "shortDescription", "category", "isLengthBased", "msrp", "unitCost", "unitPrice", "supplier", "isActive"]),
  quote: (q: Record<string, unknown>) => pick(q, ["id", "name", "number", "version", "state", "price", "modifiedDate"]),
};

/** Catalog products matching a reference (search by model / part number, then exact match). */
async function findInCatalog(client: DtoolsClient, ref: ProductRef): Promise<DtProduct | null> {
  const terms = [ref.model, ref.partNumber].filter((t): t is string => !!t);
  for (const search of terms) {
    const r = await client.getProducts({ search, pageSize: 50, includeInactive: true });
    const hit = (r?.products ?? []).find((p) => refMatches(ref, p));
    if (hit) return hit;
  }
  return null;
}

/** The server instructions' D-Tools section (src/mcp.ts appends it). */
export const DTOOLS_INSTRUCTIONS = [
  "D-TOOLS CLOUD: the owner prices, proposes and manages projects in D-Tools Cloud. Do NOT price bids or write proposals / workbooks on this server (price_bid, the bid exports) unless the owner asks for that specifically: pricing, the price book, proposals and the quote live in D-Tools.",
  "This server is for intake (the bid package), the plan takeoff with measured cable, reading specs and SOWs, federal documents, and keeping D-Tools in sync. Workflow per job:",
  "1. dtools_status {project}; dtools_find a client / opportunity, or dtools_create_client and dtools_create_opportunity {project} (links it). dtools_link links existing records. Claude may create and update clients, opportunities and project details on its own; every write is logged. Tell the owner what you changed.",
  "2. Take off as usual. dtools_set_mapping maps each takeoff condition and cable type to a D-Tools product (brand + model or part number) and takeoff rooms to quote locations. Never guess a product: ask or dtools_find products.",
  "3. dtools_quote_inputs {project}: the catalog import CSV (products D-Tools lacks) and the scope-by-location text. Give the owner both links: import the CSV in D-Tools (Catalog > My Products > Import/Export), then build the quote (Quote Assist takes the scope text). The API cannot write quote items.",
  "4. dtools_link the quote, then dtools_reconcile {project}: differences between the quote and the takeoff, biggest money first. Walk the owner through them.",
  "Price changes for the catalog: dtools_propose_prices only queues them with their source and date; the owner approves on the phone page. Never say a price was changed until the owner approved it.",
  "dtools_sync re-reads the linked records (the D-Tools webhook also refreshes them); dtools_quote reads the quote in small pages.",
].join("\n");

export function registerDtoolsTools(server: McpServer, ctx: DtoolsToolsCtx): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;
  const store = ctx.store ?? new DtoolsStore(deps.storage, deps.projects);
  const book = ctx.priceBook ?? new StorePriceBook(deps.storage);
  let client: DtoolsClient | null;
  if (ctx.client !== undefined) client = ctx.client;
  else {
    const cfg = loadDtoolsConfig(process.env);
    client = cfg ? new DtoolsClient(cfg) : null;
  }

  /** Tools that talk to D-Tools reply this (not an error) while it is not connected. */
  const connected = (fn: (a: any, c: DtoolsClient) => Promise<ToolReply>) => run(async (a: any) => (client ? fn(a, client) : okText(NOT_CONNECTED)));
  const needOpen = (m: ProjectManifest, tool: string) => {
    if (ctx.state.project !== m.id) {
      throw new UserError(`${tool} reads the takeoff open in this conversation: call open_project {project: "${m.id}"} first${ctx.state.project ? ` (this conversation has ${ctx.state.project} open)` : ""}.`);
    }
    return ctx.session.exportPayload();
  };
  const writeOutput = async (project: ProjectId, rel: string, body: string) => {
    const file = path.join(deps.workspace.outputsDir(project), ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  const pushAndLink = async (project: ProjectId, rels: string[]) => {
    let pushError: string | undefined;
    try {
      await ctx.pushOutputs(project);
    } catch (e) {
      pushError = `Written on the server, but pushing to the store failed (${e instanceof Error ? e.message : e}); the next tool call retries.`;
    }
    const download = pushError ? [] : await linksForPushed(deps, project, rels.map((r) => `outputs/${r}`), ttl);
    return { download, ...(pushError ? { push_error: pushError } : {}) };
  };

  server.registerTool("dtools_status", {
    description: "Whether D-Tools Cloud is connected, the price changes waiting for the owner, and recent D-Tools changes (Claude's writes, the owner's approvals, webhooks). With project: its D-Tools links (client, opportunity, project, quote), the last sync, its mapping size and the changes that concern it. Start every D-Tools task here.",
    inputSchema: { project: projectArg.optional() },
  }, run(async ({ project }) => {
    const pending = await store.listPending("pending");
    const base = { connected: !!client, ...(client ? {} : { note: NOT_CONNECTED }), pending_price_changes: pending.length };
    if (!project) {
      const linked = await store.linkedProjects();
      return ok({ ...base, linked_projects: linked.map((l) => ({ project: l.project, name: l.name, ...l.links })), recent: await store.readLog({ limit: 15 }) });
    }
    const m = await requireProject(deps, project);
    const links = m.dtools ?? null;
    const mapping = await store.getMapping(m.id);
    const cached: Record<string, unknown> = {};
    for (const k of ["opportunity", "project", "quote"] as const) {
      const c = await store.getCache(m.id, k);
      if (c) cached[k] = { id: c.id, fetchedAt: c.fetchedAt, ...pick(c.data, SUMMARY_FIELDS[k].filter((f) => f !== "quoteIds")), ...(k === "quote" ? { items: (c.data as unknown as DtQuoteDetail).items?.length ?? 0 } : {}) };
    }
    const ids = links ? [links.clientId, links.opportunityId, links.projectId, links.quoteId].filter((x): x is string => !!x) : [];
    return ok({
      ...base, project: m.id, links, cached,
      mapping: { conditions: Object.keys(mapping.conditions).length, cables: Object.keys(mapping.cables).length, rooms: Object.keys(mapping.rooms).length },
      recent: await store.readLog({ project: m.id, ids, limit: 15 }),
      next: !links ? "Not linked: dtools_find the opportunity (or dtools_create_opportunity {project}) and dtools_link it." : !links.quoteId ? "No quote linked yet: dtools_sync lists the opportunity's quotes; dtools_link {quoteId} once the owner has built one." : "dtools_sync to refresh, dtools_reconcile to check the quote against the takeoff.",
    });
  }));

  server.registerTool("dtools_find", {
    description: "Search D-Tools Cloud: clients, opportunities, projects or products by text (name, number, brand, model, ...), 20 per page. quotes: search is an opportunity id (its quotes), or text (quotes of the first matching opportunities). Read-only.",
    inputSchema: {
      kind: z.enum(["clients", "opportunities", "projects", "quotes", "products"]),
      search: z.string().max(200).describe("Text, or for quotes an opportunity id"),
      page: z.number().int().min(1).max(500).optional().describe("Page (from 1)"),
    },
  }, connected(async ({ kind, search, page }, c) => {
    const q = { search, page: page ?? 1, pageSize: 20 };
    if (kind === "clients") { const r = await c.getClients(q); return ok({ kind, page: q.page, total: r?.totalClients, results: (r?.clients ?? []).map((x) => lite.client(x as unknown as Record<string, unknown>)) }); }
    if (kind === "opportunities") { const r = await c.getOpportunities(q); return ok({ kind, page: q.page, total: r?.totalOpportunities, results: (r?.opportunities ?? []).map((x) => lite.opportunity(x as unknown as Record<string, unknown>)) }); }
    if (kind === "projects") { const r = await c.getProjects(q); return ok({ kind, page: q.page, total: r?.totalProjects, results: (r?.projects ?? []).map((x) => lite.project(x as unknown as Record<string, unknown>)) }); }
    if (kind === "products") { const r = await c.getProducts(q); return ok({ kind, page: q.page, total: r?.totalProducts, results: (r?.products ?? []).map((x) => lite.product(x as unknown as Record<string, unknown>)) }); }
    // quotes hang off opportunities
    const opps = uuid.safeParse(search).success
      ? [{ id: search, name: null as string | null }]
      : ((await c.getOpportunities({ search, page: 1, pageSize: 5 }))?.opportunities ?? []).map((o) => ({ id: o.id, name: o.name ?? null }));
    const results: Record<string, unknown>[] = [];
    for (const o of opps) for (const qt of await c.getQuotes(o.id)) results.push({ ...lite.quote(qt as unknown as Record<string, unknown>), opportunityId: o.id, ...(o.name ? { opportunityName: o.name } : {}) });
    return ok({ kind, results, ...(results.length ? {} : { note: "No quotes found. Quotes are listed per opportunity: dtools_find opportunities first." }) });
  }));

  server.registerTool("dtools_link", {
    description: "Link a project here to its D-Tools records (opportunity, project, quote; the client follows from the opportunity). Each id is verified by reading it from D-Tools and the read is cached; a quote also links its opportunity. Replaces the earlier link of the same kind.",
    inputSchema: { project: projectArg, opportunityId: uuid.optional(), projectId: uuid.optional(), quoteId: uuid.optional() },
  }, connected(async ({ project, opportunityId, projectId, quoteId }, c) => {
    const m = await requireProject(deps, project);
    if (!opportunityId && !projectId && !quoteId) throw new UserError("Give opportunityId, projectId and/or quoteId (dtools_find shows them).");
    const patch: Partial<DtoolsLinks> = {};
    const verified: Record<string, unknown> = {};
    const reads: { kind: "opportunity" | "project" | "quote"; id: string; data: Record<string, unknown> }[] = [];
    const get = async <T>(what: string, id: string, f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof DtoolsError && (e.status === 404 || e.status === 400)) throw new UserError(`No ${what} ${id} in D-Tools (${e.message}). Nothing was linked.`);
        throw e;
      }
    };
    if (quoteId) {
      const q = await get("quote", quoteId, () => c.getQuote(quoteId));
      patch.quoteId = q.id ?? quoteId;
      reads.push({ kind: "quote", id: patch.quoteId, data: q as unknown as Record<string, unknown> });
      verified.quote = lite.quote(q as unknown as Record<string, unknown>);
      if (!opportunityId && q.opportunityId) opportunityId = q.opportunityId;
    }
    if (opportunityId) {
      const o = await get("opportunity", opportunityId, () => c.getOpportunity(opportunityId));
      patch.opportunityId = o.id ?? opportunityId;
      if (o.clientId) patch.clientId = o.clientId;
      reads.push({ kind: "opportunity", id: patch.opportunityId, data: o as unknown as Record<string, unknown> });
      verified.opportunity = lite.opportunity(o as unknown as Record<string, unknown>);
      if (quoteId && o.quoteIds && !o.quoteIds.some((x) => x.toLowerCase() === quoteId.toLowerCase())) throw new UserError(`Quote ${quoteId} does not belong to opportunity ${opportunityId}. Nothing was linked.`);
    }
    if (projectId) {
      const p = await get("project", projectId, () => c.getProject(projectId));
      patch.projectId = p.id ?? projectId;
      if (!patch.clientId && p.clientId) patch.clientId = p.clientId;
      reads.push({ kind: "project", id: patch.projectId, data: p as unknown as Record<string, unknown> });
      verified.project = lite.project(p as unknown as Record<string, unknown>);
    }
    const before = m.dtools ?? null;
    const links = await store.setLinks(m.id, { ...patch, linkedAt: new Date().toISOString() });
    for (const r of reads) await store.putCache(m.id, r.kind, r.id, r.data);
    const { before: b, after: a } = changedFields(before as Record<string, unknown> | null, links as unknown as Record<string, unknown>, ["clientId", "opportunityId", "projectId", "quoteId"]);
    await store.log({ actor: "claude", action: "link", entity: "links", project: m.id, before: b, after: a });
    return ok({ project: m.id, links, verified, note: "Linked and cached. dtools_sync refreshes the cache; the D-Tools webhook keeps it current." });
  }));

  server.registerTool("dtools_create_client", {
    description: "Create a client in D-Tools Cloud (logged). Refuses when a client with the same name exists unless allowDuplicate. Reply: the new client id. Then dtools_create_opportunity {project, clientId}.",
    inputSchema: {
      name: z.string().min(1).max(300), type: z.string().max(100).optional().describe("D-Tools client type, e.g. Commercial / Residential / Government"),
      number: z.string().max(100).optional(), email: z.string().max(200).optional(), phone: z.string().max(60).optional(), mobile: z.string().max(60).optional(),
      website: z.string().max(300).optional(), owner: z.string().max(200).optional(), billingAddress: addressSchema.optional(), siteAddresses: z.array(addressSchema).max(20).optional(),
      contacts: z.array(contactSchema).max(50).optional(), allowDuplicate: z.boolean().optional(),
    },
  }, connected(async (a, c) => {
    const { allowDuplicate, ...body } = a;
    if (!allowDuplicate) {
      const same = ((await c.getClients({ search: body.name, pageSize: 20 }))?.clients ?? []).filter((x) => (x.name ?? "").trim().toLowerCase() === body.name.trim().toLowerCase());
      if (same.length) return fail(new UserError(`A client named "${body.name}" already exists (${same.map((x) => x.id).join(", ")}). Use it, or pass allowDuplicate: true if this is a different client.`));
    }
    const id = await c.createClient(body);
    await store.log({ actor: "claude", action: "create", entity: "client", id, after: pick(body, ["name", "type", "number", "email", "phone", "owner"]) });
    return ok({ created: "client", id, name: body.name, logged: true });
  }));

  server.registerTool("dtools_create_opportunity", {
    description: "Create a D-Tools opportunity for a project here and link it (logged). name defaults to the project's name; give the client by clientId (dtools_find clients / dtools_create_client) or clientName (+ clientEmail / clientPhone) for a new one. Header only: the API has no line items. Refuses when the project already has an opportunity unless replaceLink.",
    inputSchema: {
      project: projectArg, clientId: uuid.optional(), clientName: z.string().max(300).optional(), clientType: z.string().max(100).optional(),
      clientEmail: z.string().max(200).optional(), clientPhone: z.string().max(60).optional(),
      ...Object.fromEntries(Object.entries(opportunityFields).filter(([k]) => !["clientId", "probability", "actualCloseDate", "estimatedProjectStartDate", "estimatedProjectEndDate", "lostReason", "lostDescription"].includes(k))),
      type: z.string().max(100).optional().describe("Opportunity type, as set up in D-Tools"),
      replaceLink: z.boolean().optional(),
    },
  }, connected(async (a, c) => {
    const m = await requireProject(deps, a.project);
    if (m.dtools?.opportunityId && !a.replaceLink) throw new UserError(`Project ${m.id} is already linked to opportunity ${m.dtools.opportunityId}. dtools_update_opportunity changes it; pass replaceLink: true only for a genuinely new opportunity.`);
    if (!a.clientId && !a.clientName) throw new UserError("Give clientId (dtools_find clients) or clientName for a new client.");
    const { project: _p, replaceLink: _r, ...rest } = a;
    const body: DtNewOpportunity = { ...rest, name: rest.name ?? m.name };
    if (typeof body.estimatedCloseDate === "string") body.estimatedCloseDate = dtDate(body.estimatedCloseDate);
    const id = await c.createOpportunity(body);
    await store.log({ actor: "claude", action: "create", entity: "opportunity", id, project: m.id, after: pick(body as Record<string, unknown>, ["name", "number", "clientId", "clientName", "budget", "owner", "estimatedCloseDate", "quoteTemplate"]) });
    let read: DtOpportunityDetail | null = null;
    try { read = await c.getOpportunity(id); } catch { /* linked by id anyway */ }
    const links = await store.setLinks(m.id, { opportunityId: id, ...(read?.clientId ?? a.clientId ? { clientId: read?.clientId ?? a.clientId } : {}), linkedAt: new Date().toISOString(), ...(a.replaceLink ? { quoteId: null } : {}) });
    if (read) await store.putCache(m.id, "opportunity", id, read);
    return ok({ created: "opportunity", id, project: m.id, links, ...(read ? { opportunity: lite.opportunity(read as unknown as Record<string, unknown>) } : {}), logged: true, next: "Take off, map products (dtools_set_mapping), then dtools_quote_inputs for the owner to build the quote." });
  }));

  const updater = (kind: "opportunity" | "project") => connected(async ({ project, fields }, c) => {
    const m = await requireProject(deps, project);
    const id = kind === "opportunity" ? m.dtools?.opportunityId : m.dtools?.projectId;
    if (!id) throw new UserError(`Project ${m.id} has no linked D-Tools ${kind}: dtools_link {${kind}Id} first${kind === "opportunity" ? " (or dtools_create_opportunity)" : ""}.`);
    const given = Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined));
    if (!Object.keys(given).length) throw new UserError("fields is empty: give the fields to change.");
    const current = (kind === "opportunity" ? await c.getOpportunity(id) : await c.getProject(id)) as unknown as Record<string, unknown>;
    const keys = kind === "opportunity" ? UPDATE_OPPORTUNITY_KEYS : UPDATE_PROJECT_KEYS;
    if (kind === "opportunity") await c.updateOpportunity(id, mergedBody<DtUpdateOpportunity>(current, keys, given));
    else await c.updateProject(id, mergedBody<DtUpdateProject>(current, keys, given));
    const fresh = (kind === "opportunity" ? await c.getOpportunity(id) : await c.getProject(id)) as unknown as Record<string, unknown>;
    await store.putCache(m.id, kind, id, fresh);
    const { before, after } = changedFields(current, fresh, Object.keys(given));
    const notTaken = Object.keys(given).filter((k) => !(k in after) && JSON.stringify(current[k] ?? null) !== JSON.stringify(given[k]) && !(DATE_KEYS.has(k) && String(fresh[k] ?? "").startsWith(String(given[k]).slice(0, 10))));
    await store.log({ actor: "claude", action: "update", entity: kind, id, project: m.id, before, after });
    return ok({
      updated: kind, id, project: m.id,
      changed: Object.fromEntries(Object.keys(after).map((k) => [k, { before: before[k], after: after[k] }])),
      ...(Object.keys(after).length ? {} : { note: "D-Tools reports no change (the values were already set)." }),
      ...(notTaken.length ? { not_taken: notTaken, warning: `D-Tools did not keep: ${notTaken.join(", ")}. Check the values in D-Tools.` } : {}),
      logged: true,
    });
  });

  server.registerTool("dtools_update_opportunity", {
    description: "Change the linked D-Tools opportunity's header (logged): name, number, client, quote template, budget, owner, dates, site / billing address, contacts, stage-related fields D-Tools allows. Only the fields given change (the rest are sent back as D-Tools has them). Reply: each field before → after as D-Tools reads back. No line items: the API cannot write quotes.",
    inputSchema: { project: projectArg, fields: z.object(opportunityFields).describe("Only the fields to change") },
  }, updater("opportunity"));

  server.registerTool("dtools_update_project", {
    description: "Change the linked D-Tools project's details (logged): dates (start, end, completed, won), project manager, salesperson, budget, priority, addresses, contacts. Only the fields given change. Reply: each field before → after as D-Tools reads back.",
    inputSchema: { project: projectArg, fields: z.object(projectFields).describe("Only the fields to change") },
  }, updater("project"));

  server.registerTool("dtools_sync", {
    description: "Re-read the project's linked D-Tools opportunity, project and quote into the cache and report what changed since the last read (header fields; quote items added, removed or changed). Lists the opportunity's quotes when none is linked yet.",
    inputSchema: { project: projectArg },
  }, connected(async ({ project }, c) => {
    const m = await requireProject(deps, project);
    if (!m.dtools) throw new UserError(`Project ${m.id} is not linked to D-Tools: dtools_link it (or dtools_create_opportunity).`);
    const r = await syncProject(c, store, m.id);
    const lines = describeChanges(r);
    return ok({
      project: m.id, synced_at: r.syncedAt, changes: lines, ...(r.unchanged.length ? { unchanged: r.unchanged } : {}),
      ...(r.errors.length ? { errors: r.errors } : {}), ...(r.quotesAvailable ? { quotes_available: r.quotesAvailable } : {}),
      ...(lines.length || r.errors.length ? {} : { note: "Nothing changed since the last sync." }),
    });
  }));

  server.registerTool("dtools_quote", {
    description: "The linked D-Tools quote (read-only in the API). part summary (default): totals, locations, systems, item count; items: 25 items per page (brand, model, part number, qty, length, location, system, unit price); locations: item count and value per location. fresh re-reads it from D-Tools first (else the cached read).",
    inputSchema: {
      project: projectArg, part: z.enum(["summary", "items", "locations"]).optional(), page: z.number().int().min(1).max(1000).optional(),
      location: z.string().max(200).optional().describe("items: only this location"), fresh: z.boolean().optional(),
    },
  }, connected(async ({ project, part, page, location, fresh }, c) => {
    const m = await requireProject(deps, project);
    const qid = m.dtools?.quoteId;
    if (!qid) throw new UserError(`Project ${m.id} has no linked quote: dtools_sync lists the opportunity's quotes, then dtools_link {quoteId}.`);
    let cached = await store.getCache<DtQuoteDetail>(m.id, "quote");
    if (fresh || !cached || cached.id !== qid) cached = await store.putCache(m.id, "quote", qid, await c.getQuote(qid));
    const q = cached.data;
    const { lines, skipped } = quoteLines(q);
    const base = { project: m.id, quote: { id: q.id, name: q.name, number: q.number, version: q.version, state: q.state, price: q.price }, fetched_at: cached.fetchedAt };
    if ((part ?? "summary") === "summary") {
      return ok({ ...base, items: (q.items ?? []).length, product_lines: lines.length, labor_or_package_lines: skipped, locations: (q.locations ?? []).map((l) => l.fullName || l.name), systems: (q.systems ?? []).map((s) => s.name), phases: (q.phases ?? []).map((p) => p.name), scope_of_work: q.scopeOfWork ? String(q.scopeOfWork).slice(0, 600) : undefined });
    }
    if (part === "locations") {
      const acc = new Map<string, { location: string; lines: number; quantity: number; value: number }>();
      for (const l of lines) {
        const k = l.location || "(no location)";
        const cur = acc.get(k) ?? { location: k, lines: 0, quantity: 0, value: 0 };
        cur.lines++; cur.quantity += l.quantity; cur.value = Math.round((cur.value + l.quantity * (l.unitPrice ?? 0)) * 100) / 100;
        acc.set(k, cur);
      }
      return ok({ ...base, locations: [...acc.values()] });
    }
    const all = (q.items ?? []).filter((i) => !location || (i.location ?? "").toLowerCase() === location.toLowerCase());
    const p = page ?? 1;
    const rows = all.slice((p - 1) * 25, p * 25).map((i) => pick(i as unknown as Record<string, unknown>, ["id", "type", "brand", "model", "partNumber", "shortDescription", "quantity", "isLengthBased", "length", "location", "system", "phase", "unitPrice", "pricePerLength"]));
    return ok({ ...base, total_items: all.length, page: p, items: rows, ...(p * 25 < all.length ? { next_page: p + 1 } : {}) });
  }));

  server.registerTool("dtools_set_mapping", {
    description: "Set how the project's takeoff maps to D-Tools: conditions {finish tag or id: {brand, model} | {partNumber}}, cables {cable type: product} for length-based cable, rooms {takeoff room: D-Tools quote location}. Merges into the stored mapping; remove lists keys to drop. Only map a product you know (from dtools_find products, the spec or the owner): unmapped items are reported by dtools_reconcile, never guessed.",
    inputSchema: {
      project: projectArg,
      conditions: z.record(z.string().max(200), productRefSchema).optional(),
      cables: z.record(z.string().max(200), productRefSchema).optional(),
      rooms: z.record(z.string().max(200), z.string().min(1).max(200)).optional(),
      remove: z.object({ conditions: z.array(z.string()).optional(), cables: z.array(z.string()).optional(), rooms: z.array(z.string()).optional() }).optional(),
    },
  }, run(async ({ project, conditions, cables, rooms, remove }) => {
    const m = await requireProject(deps, project);
    const map = await store.getMapping(m.id);
    for (const [k, v] of Object.entries((conditions ?? {}) as Record<string, ProductRef>)) map.conditions[k.trim()] = checkProductRef(`conditions.${k}`, v);
    for (const [k, v] of Object.entries((cables ?? {}) as Record<string, ProductRef>)) map.cables[k.trim()] = checkProductRef(`cables.${k}`, v);
    for (const [k, v] of Object.entries((rooms ?? {}) as Record<string, string>)) map.rooms[k.trim()] = v.trim();
    for (const k of remove?.conditions ?? []) delete map.conditions[k];
    for (const k of remove?.cables ?? []) delete map.cables[k];
    for (const k of remove?.rooms ?? []) delete map.rooms[k];
    await store.putMapping(m.id, map);
    return ok({ project: m.id, mapping: { conditions: Object.fromEntries(Object.entries(map.conditions).map(([k, v]) => [k, refLabel(v)])), cables: Object.fromEntries(Object.entries(map.cables).map(([k, v]) => [k, refLabel(v)])), rooms: map.rooms } });
  }));

  /** reconcile() with catalog prices looked up for takeoff items the quote lacks. */
  const reconcileWithCatalog = async (c: DtoolsClient, facts: ReturnType<typeof takeoffFacts>, quote: DtQuoteDetail, mapping: Awaited<ReturnType<DtoolsStore["getMapping"]>>): Promise<ReconcileResult> => {
    const first = reconcile(facts, quote, mapping);
    const missing = first.differences.filter((d) => d.kind === "missing_from_quote" && d.unitPrice == null);
    if (!missing.length) return first;
    const prices: Record<string, number> = {};
    const refs = [...Object.values(mapping.conditions), ...Object.values(mapping.cables)];
    for (const d of missing.slice(0, 15)) {
      const ref = refs.find((r) => refLabel(r) === d.product);
      if (!ref) continue;
      try {
        const p = await findInCatalog(c, ref);
        const price = d.unit === "FT" ? (p?.pricePerLength as number | undefined) ?? null : p?.unitPrice ?? null;
        if (price != null) prices[refKey(ref)] = price;
      } catch { /* priced as unknown */ }
    }
    return Object.keys(prices).length ? reconcile(facts, quote, mapping, { catalogPrices: prices }) : first;
  };

  server.registerTool("dtools_reconcile", {
    description: "Check the linked D-Tools quote against the takeoff open in this conversation (open_project first): device counts per product and per room / quote location, cable feet per cable type vs the quote's length-based items, quote items with no takeoff counterpart, takeoff items missing from the quote, unmapped conditions. Re-reads the quote first. Differences are ordered by money (quantity difference × unit price). Writes outputs/dtools/reconcile.json with every difference.",
    inputSchema: { project: projectArg, quoteId: uuid.optional().describe("Reconcile this quote instead of the linked one (it is not linked)") },
  }, connected(async ({ project, quoteId }, c) => {
    const m = await requireProject(deps, project);
    const takeoff = needOpen(m, "dtools_reconcile");
    const qid = quoteId ?? m.dtools?.quoteId;
    if (!qid) throw new UserError(`Project ${m.id} has no linked quote: dtools_sync lists the opportunity's quotes, then dtools_link {quoteId}.`);
    const quote = await c.getQuote(qid);
    if (!quoteId || quoteId === m.dtools?.quoteId) await store.putCache(m.id, "quote", qid, quote);
    const mapping = await store.getMapping(m.id);
    const facts = takeoffFacts(takeoff, await readInstallDesign(deps, m.id));
    const r = await reconcileWithCatalog(c, facts, quote, mapping);
    await writeOutput(m.id, DTOOLS_OUTPUTS.reconcile, `${JSON.stringify({ schema: "brink.dtools-reconcile.v1", project: m.id, at: new Date().toISOString(), ...r }, null, 1)}\n`);
    const out = await pushAndLink(m.id, [DTOOLS_OUTPUTS.reconcile]);
    const counts: Record<string, number> = {};
    for (const d of r.differences) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    return ok({
      project: m.id, quote: r.quote, money_at_stake: r.moneyAtStake, room_source: r.roomSource,
      difference_counts: counts, matched: r.matched.length,
      differences: r.differences.slice(0, 25).map((d) => ({ kind: d.kind, impact: d.impact, message: d.message })),
      ...(r.differences.length > 25 ? { more: r.differences.length - 25 } : {}),
      ...(r.unmatchedRooms.length ? { unmatched_rooms: r.unmatchedRooms } : {}),
      notes: r.notes, ...out,
      next: r.differences.length ? "Walk the owner through the biggest differences first. Fix the takeoff here, or the owner fixes the quote in D-Tools; unmapped items need dtools_set_mapping." : "The quote matches the takeoff.",
    });
  }));

  server.registerTool("dtools_quote_inputs", {
    description: "What the owner needs to build the D-Tools quote from the takeoff open in this conversation (open_project first): outputs/dtools/catalog-import.csv (only the mapped products the D-Tools catalog lacks, looked up by model / part number, in D-Tools' import columns) and outputs/dtools/scope-by-location.txt (\"Office 101: 2 x Data outlet, 2-port (CAT6A)...\" for Quote Assist). Returns download links. Map products first (dtools_set_mapping).",
    inputSchema: { project: projectArg },
  }, connected(async ({ project }, c) => {
    const m = await requireProject(deps, project);
    const takeoff = needOpen(m, "dtools_quote_inputs");
    const mapping = await store.getMapping(m.id);
    const facts = takeoffFacts(takeoff, await readInstallDesign(deps, m.id));
    const { needed, unmapped } = neededProducts(facts, mapping);
    const rows: CatalogRow[] = [];
    const inCatalog: string[] = [];
    const costNotes: string[] = [];
    for (const p of needed) {
      const hit = await findInCatalog(c, p.ref);
      if (hit) { inCatalog.push(`${refLabel(p.ref)} (${hit.id})`); continue; }
      let unitCost: number | null = null;
      let supplier: string | null = null;
      if (p.unit === "EA") {
        const entry = (await book.lookup(priceKey({ manufacturer: p.ref.brand, part: p.ref.model ?? p.ref.partNumber, description: p.label }))).find((e) => pricePerLineUnit(e, "EA") != null);
        if (entry) {
          unitCost = pricePerLineUnit(entry, "EA");
          supplier = entry.supplier ?? null;
          costNotes.push(`${refLabel(p.ref)}: Unit Cost ${unitCost} from the price book (${entry.source}, ${entry.date})`);
        }
      }
      rows.push(catalogRow(p, { unitCost, supplier }));
    }
    const today = new Date().toISOString().slice(0, 10);
    await writeOutput(m.id, DTOOLS_OUTPUTS.csv, catalogCsv(rows));
    await writeOutput(m.id, DTOOLS_OUTPUTS.scope, scopeText({ projectName: m.name, date: today, facts, mapping }));
    const out = await pushAndLink(m.id, [DTOOLS_OUTPUTS.csv, DTOOLS_OUTPUTS.scope]);
    const noBrand = rows.filter((r) => !r.Brand).map((r) => r.Model);
    return ok({
      project: m.id,
      catalog_import: { rows: rows.length, products: rows.map((r) => `${r.Brand} ${r.Model}`.trim()), ...(rows.length ? {} : { note: "Every mapped product is already in the D-Tools catalog: the CSV has only its header." }) },
      already_in_catalog: inCatalog,
      ...(unmapped.length ? { unmapped, unmapped_note: "Not in the CSV (no product mapped); the scope text lists them by their takeoff names. dtools_set_mapping them for the next run." } : {}),
      ...(noBrand.length ? { warning: `No brand for ${noBrand.join(", ")}: D-Tools skips import rows without a brand. Map them with a brand.` } : {}),
      ...(costNotes.length ? { unit_costs: costNotes } : {}),
      prices_note: "Unit Price and MSRP are left for D-Tools (its price rules or the owner).",
      ...out,
      next: "Give the owner both links: import the CSV in D-Tools (Catalog > My Products > Import/Export > Import products), build the quote (paste the scope text into Quote Assist), then dtools_link {quoteId} and dtools_reconcile.",
    });
  }));

  server.registerTool("dtools_propose_prices", {
    description: "Propose catalog price changes (MSRP, unit cost, unit price) for D-Tools products. They are QUEUED, never applied: the owner approves or rejects each on the phone page. Every entry needs its source (URL, distributor quote reference) and date. Reply: the queued ids. Never tell the owner a price changed until they approved it.",
    inputSchema: {
      entries: z.array(z.object({
        productId: uuid, msrp: z.number().min(0).optional(), unitCost: z.number().min(0).optional(), unitPrice: z.number().min(0).optional(),
        source: z.string().min(1).max(500).describe("URL, \"<distributor> quote #1234\", ..."), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
      })).min(1).max(100),
    },
  }, connected(async ({ entries }, c) => {
    const queued: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const toAdd: Parameters<DtoolsStore["addPending"]>[0] = [];
    for (const e of entries as { productId: string; msrp?: number; unitCost?: number; unitPrice?: number; source: string; date: string }[]) {
      const proposed = Object.fromEntries((["msrp", "unitCost", "unitPrice"] as const).filter((k) => e[k] !== undefined).map((k) => [k, e[k]!]));
      if (!Object.keys(proposed).length) { skipped.push(`${e.productId}: no price given`); continue; }
      let p: DtProduct;
      try { p = await c.getProduct(e.productId); } catch (err) {
        if (err instanceof DtoolsError && (err.status === 404 || err.status === 400)) { skipped.push(`${e.productId}: no such product in D-Tools`); continue; }
        throw err;
      }
      const old = { msrp: p.msrp ?? null, unitCost: p.unitCost ?? null, unitPrice: p.unitPrice ?? null };
      const changes = Object.fromEntries(Object.entries(proposed).filter(([k, v]) => old[k as keyof typeof old] !== v));
      if (!Object.keys(changes).length) { skipped.push(`${p.brand ?? ""} ${p.model ?? e.productId}: already at those prices`); continue; }
      toAdd.push({ productId: p.id ?? e.productId, brand: p.brand ?? null, model: p.model ?? null, partNumber: p.partNumber ?? null, old, new: changes, source: e.source, date: e.date });
    }
    const added = toAdd.length ? await store.addPending(toAdd) : [];
    for (const a of added) {
      await store.log({ actor: "claude", action: "propose_price", entity: "product", id: a.productId, before: a.old as Record<string, unknown>, after: a.new as Record<string, unknown>, note: `queued ${a.id}: ${a.source} (${a.date})` });
      queued.push({ id: a.id, product: `${a.brand ?? ""} ${a.model ?? ""}`.trim() || a.productId, old: a.old, proposed: a.new, source: a.source, date: a.date });
    }
    return ok({
      queued, ...(skipped.length ? { skipped } : {}),
      note: queued.length ? "Queued: the owner approves or rejects each on the project page (phone). Nothing in D-Tools changed yet; do not say it did." : "Nothing queued.",
    });
  }));
}
