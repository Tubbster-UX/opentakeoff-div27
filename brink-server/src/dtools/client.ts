// A small typed client for the D-Tools Cloud API (v1, D-Tools' published
// OpenAPI spec). Every request carries the owner's X-API-Key header and the
// HTTP Basic credentials D-Tools publishes for all API users.
//
// - fetch with a per-request timeout;
// - retries with exponential backoff on 429 and 5xx (and network errors),
//   honoring Retry-After; a POST (create) is retried only on 429 and on a
//   connection that failed before any response, never after a 5xx, so a
//   create is not sent twice;
// - list endpoints page with page (from 1) / pageSize; paginate() walks them;
// - errors name the method, the endpoint and D-Tools' problem title/detail,
//   and never the key or the password (any echo is scrubbed).
//
// Only the request/response fields brink-server uses are typed; D-Tools
// returns more, kept as they come.
import type { DtoolsConfig } from "./config.ts";

// ── shapes (the fields we use) ──────────────────────────────────────────────

export interface DtAddress {
  name?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface DtContact {
  id?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  mobile?: string | null;
  phone?: string | null;
  notes?: string | null;
  isPrimary?: boolean | null;
  [k: string]: unknown;
}

export interface DtClientLite {
  id: string;
  type?: string | null;
  name?: string | null;
  number?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  owner?: string | null;
  isActive?: boolean;
  modifiedDate?: string;
}
export interface DtClientDetail extends DtClientLite {
  mobile?: string | null;
  website?: string | null;
  billingAddress?: DtAddress | null;
  siteAddresses?: DtAddress[] | null;
  contacts?: DtContact[] | null;
  [k: string]: unknown;
}
/** CreateClient / UpdateClient body. */
export interface DtClientInput {
  type?: string | null;
  name?: string | null;
  number?: string | null;
  email?: string | null;
  secondaryEmail?: string | null;
  mobile?: string | null;
  phone?: string | null;
  fax?: string | null;
  website?: string | null;
  owner?: string | null;
  isExemptFromTax?: boolean | null;
  isActive?: boolean | null;
  billingAddress?: DtAddress | null;
  siteAddresses?: DtAddress[] | null;
  contacts?: DtContact[] | null;
}

export interface DtOpportunityLite {
  id: string;
  clientId: string;
  clientName?: string | null;
  name?: string | null;
  number?: string | null;
  stageGroup?: string | null;
  stage?: string | null;
  price?: number;
  total?: number;
  budget?: number | null;
  owner?: string | null;
  estimatedCloseDate?: string | null;
  modifiedDate?: string;
  isArchived?: boolean;
}
export interface DtOpportunityDetail extends DtOpportunityLite {
  type?: string | null;
  buildingType?: string | null;
  marketSector?: string | null;
  projectType?: string | null;
  quoteType?: string | null;
  quoteTemplate?: string | null;
  priority?: string | null;
  probability?: number | null;
  projectArea?: number | null;
  fulfillmentLocation?: string | null;
  actualCloseDate?: string | null;
  estimatedProjectStartDate?: string | null;
  estimatedProjectEndDate?: string | null;
  leadSource?: string | null;
  lostReason?: string | null;
  lostDescription?: string | null;
  billingAddress?: DtAddress | null;
  siteAddress?: DtAddress | null;
  contacts?: DtContact[] | null;
  quoteIds?: string[] | null;
  [k: string]: unknown;
}
/** CreateOpportunity body (NewOpportunity). */
export interface DtNewOpportunity {
  type?: string | null;
  associatedProjectId?: string | null;
  clientId?: string | null;
  clientType?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  name?: string | null;
  number?: string | null;
  buildingType?: string | null;
  marketSector?: string | null;
  projectType?: string | null;
  quoteType?: string | null;
  quoteTemplate?: string | null;
  priority?: string | null;
  budget?: number | null;
  owner?: string | null;
  projectArea?: number | null;
  fulfillmentLocation?: string | null;
  estimatedCloseDate?: string | null;
  leadSource?: string | null;
  billingAddress?: DtAddress | null;
  siteAddress?: DtAddress | null;
  contacts?: DtContact[] | null;
  resources?: string[] | null;
}
/** UpdateOpportunity body. */
export interface DtUpdateOpportunity {
  associatedProjectId?: string | null;
  clientId?: string | null;
  name?: string | null;
  number?: string | null;
  buildingType?: string | null;
  marketSector?: string | null;
  projectType?: string | null;
  quoteType?: string | null;
  quoteTemplate?: string | null;
  priority?: string | null;
  budget?: number | null;
  probability?: number | null;
  owner?: string | null;
  projectArea?: number | null;
  fulfillmentLocation?: string | null;
  estimatedCloseDate?: string | null;
  actualCloseDate?: string | null;
  estimatedProjectStartDate?: string | null;
  estimatedProjectEndDate?: string | null;
  leadSource?: string | null;
  lostReason?: string | null;
  lostDescription?: string | null;
  billingAddress?: DtAddress | null;
  siteAddress?: DtAddress | null;
  contacts?: DtContact[] | null;
  resources?: string[] | null;
}

export interface DtProjectLite {
  id: string;
  clientId: string;
  clientName?: string | null;
  name?: string | null;
  number?: string | null;
  stageGroup?: string | null;
  stage?: string | null;
  price?: number;
  projectManager?: string | null;
  modifiedDate?: string;
  isArchived?: boolean;
}
export interface DtProjectDetail extends DtProjectLite {
  priority?: string | null;
  budget?: number | null;
  salesperson?: string | null;
  opportunityWonDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  completedDate?: string | null;
  scopeOfWork?: string | null;
  billingAddress?: DtAddress | null;
  siteAddress?: DtAddress | null;
  contacts?: DtContact[] | null;
  [k: string]: unknown;
}
/** UpdateProject body. */
export interface DtUpdateProject {
  clientId?: string | null;
  name?: string | null;
  number?: string | null;
  priority?: string | null;
  budget?: number | null;
  salesperson?: string | null;
  projectManager?: string | null;
  opportunityWonDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  completedDate?: string | null;
  billingAddress?: DtAddress | null;
  siteAddress?: DtAddress | null;
  contacts?: DtContact[] | null;
  resources?: string[] | null;
}

export interface DtProduct {
  id: string;
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  partNumber?: string | null;
  shortDescription?: string | null;
  category?: string | null;
  isLengthBased?: boolean;
  msrp?: number | null;
  unitCost?: number | null;
  unitPrice?: number | null;
  supplier?: string | null;
  system?: string | null;
  isActive?: boolean;
  modifiedDate?: string;
  [k: string]: unknown;
}
export interface DtProductPrice {
  id: string;
  msrp?: number | null;
  unitCost?: number | null;
  unitPrice?: number | null;
}

export interface DtQuoteLite {
  id: string;
  name?: string | null;
  number?: string | null;
  version?: number;
  state?: string | null;
  price?: number;
  modifiedDate?: string;
}
export interface DtQuoteLocation { id: number; name?: string | null; number?: string | null; fullName?: string | null; parentId?: number | null }
export interface DtQuoteNamed { id: number; name?: string | null }
export interface DtQuoteLength { id: number; name?: string | null; length: number }
export interface DtQuoteItem {
  id: number;
  catalogId?: string;
  type?: string | null;
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  partNumber?: string | null;
  shortDescription?: string | null;
  category?: string | null;
  quantity: number;
  isLengthBased?: boolean;
  lengthId?: number | null;
  length?: number | null;
  unitCost?: number | null;
  unitPrice?: number | null;
  costPerLength?: number | null;
  pricePerLength?: number | null;
  unitLaborTime?: number | null;
  unitLaborPrice?: number | null;
  locationId?: number | null;
  location?: string | null;
  systemId?: number | null;
  system?: string | null;
  phaseId?: number | null;
  phase?: string | null;
  parentId?: number | null;
  packageId?: number | null;
  isOptional?: boolean;
  [k: string]: unknown;
}
export interface DtQuoteDetail extends DtQuoteLite {
  opportunityId: string;
  scopeOfWork?: string | null;
  locations?: DtQuoteLocation[] | null;
  systems?: DtQuoteNamed[] | null;
  phases?: DtQuoteNamed[] | null;
  laborTypes?: DtQuoteNamed[] | null;
  lengths?: DtQuoteLength[] | null;
  items?: DtQuoteItem[] | null;
  [k: string]: unknown;
}

export interface ListQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  includeTotalCount?: boolean;
  [k: string]: string | number | boolean | string[] | undefined;
}

// ── errors ──────────────────────────────────────────────────────────────────

export class DtoolsError extends Error {
  constructor(
    message: string,
    /** HTTP status, 0 for a network failure or timeout. */
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "DtoolsError";
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

// ── client ──────────────────────────────────────────────────────────────────

export interface DtoolsClientOptions {
  fetch?: typeof fetch;
  /** Wait between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt (default 4). */
  maxRetries?: number;
  /** First backoff (default 500 ms; doubles each retry, ±25 % jitter). */
  baseDelayMs?: number;
  /** Longest wait honored from Retry-After or the backoff (default 30 s). */
  maxDelayMs?: number;
}

type Method = "GET" | "POST" | "PUT";
type Query = Record<string, string | number | boolean | string[] | undefined | null>;

const RETRYABLE_STATUS = (s: number) => s === 429 || s >= 500;

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  const s = h.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export class DtoolsClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly secrets: string[];
  /** Requests sent (attempts, retries included): tests and the status page. */
  requests = 0;

  constructor(private readonly cfg: DtoolsConfig, opts: DtoolsClientOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.secrets = [cfg.apiKey, cfg.basicPassword ?? "", cfg.basicUser && cfg.basicPassword ? Buffer.from(`${cfg.basicUser}:${cfg.basicPassword}`).toString("base64") : ""].filter((s) => s.length >= 4);
  }

  /** Removes any echo of the key, the password or the Basic header from a message. */
  scrub(s: string): string {
    let out = s;
    for (const v of this.secrets) out = out.split(v).join("***");
    return out;
  }

  private headers(body: boolean): Record<string, string> {
    const h: Record<string, string> = { "X-API-Key": this.cfg.apiKey, Accept: "application/json" };
    if (this.cfg.basicUser && this.cfg.basicPassword) h.Authorization = `Basic ${Buffer.from(`${this.cfg.basicUser}:${this.cfg.basicPassword}`).toString("base64")}`;
    if (body) h["Content-Type"] = "application/json";
    return h;
  }

  private url(path: string, query?: Query): string {
    const u = new URL(`${this.cfg.baseUrl}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private delay(attempt: number, retryAfter: number | null): number {
    if (retryAfter != null) return Math.min(this.maxDelayMs, retryAfter);
    const base = this.baseDelayMs * 2 ** attempt;
    return Math.min(this.maxDelayMs, Math.round(base * (0.75 + Math.random() * 0.5)));
  }

  /** One API call with retries; the parsed JSON body (a bare string for the create/update endpoints). */
  async request<T>(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const endpoint = `${method} ${path}`;
    let attempt = 0;
    for (;;) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
      let res: Response;
      try {
        this.requests++;
        res = await this.fetchFn(this.url(path, opts.query), {
          method,
          headers: this.headers(opts.body !== undefined),
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const timedOut = ctl.signal.aborted;
        if (attempt < this.maxRetries) {
          await this.sleep(this.delay(attempt++, null));
          continue;
        }
        throw new DtoolsError(this.scrub(`D-Tools ${endpoint} ${timedOut ? `timed out after ${this.cfg.timeoutMs} ms` : `failed: ${e instanceof Error ? e.message : String(e)}`}`), 0, endpoint);
      }
      let text = "";
      try {
        text = await res.text();
      } catch {
        /* empty body */
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      const canRetry = RETRYABLE_STATUS(res.status) && (method !== "POST" || res.status === 429);
      if (canRetry && attempt < this.maxRetries) {
        await this.sleep(this.delay(attempt++, retryAfterMs(res.headers.get("retry-after"))));
        continue;
      }
      throw new DtoolsError(this.scrub(`D-Tools ${endpoint} returned ${res.status}${problem(text)}`), res.status, endpoint);
    }
  }

  /** Walk a paged list endpoint: page 1, 2, ... until a short page, the total, or maxItems. */
  async paginate<T>(path: string, key: string, query: ListQuery = {}, opts: { pageSize?: number; maxItems?: number } = {}): Promise<T[]> {
    const pageSize = Math.min(Math.max(1, opts.pageSize ?? query.pageSize ?? 100), 500);
    const maxItems = opts.maxItems ?? 5000;
    const out: T[] = [];
    for (let page = query.page ?? 1; out.length < maxItems; page++) {
      const r = await this.request<Record<string, unknown>>("GET", path, { query: { ...query, page, pageSize, includeTotalCount: true } });
      const rows = (Array.isArray(r?.[key]) ? r[key] : []) as T[];
      out.push(...rows);
      const total = Object.entries(r ?? {}).find(([k, v]) => k.startsWith("total") && typeof v === "number")?.[1] as number | undefined;
      if (rows.length < pageSize || (total !== undefined && out.length >= total)) break;
    }
    return out.slice(0, maxItems);
  }

  // ── clients ──
  getClients(q: ListQuery = {}) {
    return this.request<{ clients: DtClientLite[] | null; totalClients: number }>("GET", "Clients/GetClients", { query: { includeTotalCount: true, ...q } });
  }
  getClient(id: string) {
    return this.request<DtClientDetail>("GET", "Clients/GetClient", { query: { id } });
  }
  async createClient(body: DtClientInput): Promise<string> {
    return idOf(await this.request<unknown>("POST", "Clients/CreateClient", { body }));
  }
  updateClient(id: string, body: DtClientInput) {
    return this.request<unknown>("PUT", "Clients/UpdateClient", { query: { id }, body });
  }

  // ── opportunities ──
  getOpportunities(q: ListQuery = {}) {
    return this.request<{ opportunities: DtOpportunityLite[] | null; totalOpportunities: number }>("GET", "Opportunities/GetOpportunities", { query: { includeTotalCount: true, ...q } });
  }
  getOpportunity(id: string) {
    return this.request<DtOpportunityDetail>("GET", "Opportunities/GetOpportunity", { query: { id } });
  }
  async createOpportunity(body: DtNewOpportunity): Promise<string> {
    return idOf(await this.request<unknown>("POST", "Opportunities/CreateOpportunity", { body }));
  }
  updateOpportunity(id: string, body: DtUpdateOpportunity) {
    return this.request<unknown>("PUT", "Opportunities/UpdateOpportunity", { query: { id }, body });
  }

  // ── projects ──
  getProjects(q: ListQuery = {}) {
    return this.request<{ projects: DtProjectLite[] | null; totalProjects: number }>("GET", "Projects/GetProjects", { query: { includeTotalCount: true, ...q } });
  }
  getProject(id: string) {
    return this.request<DtProjectDetail>("GET", "Projects/GetProject", { query: { id } });
  }
  updateProject(id: string, body: DtUpdateProject) {
    return this.request<unknown>("PUT", "Projects/UpdateProject", { query: { id }, body });
  }

  // ── products ──
  getProducts(q: ListQuery = {}) {
    return this.request<{ products: DtProduct[] | null; totalProducts: number }>("GET", "Products/GetProducts", { query: { includeTotalCount: true, ...q } });
  }
  getProduct(id: string) {
    return this.request<DtProduct>("GET", "Products/GetProduct", { query: { id } });
  }
  updateProductPrices(prices: DtProductPrice[]) {
    return this.request<unknown>("PUT", "Products/UpdateProductPrices", { body: prices });
  }
  updateProductStatuses(statuses: { id: string; [k: string]: unknown }[]) {
    return this.request<unknown>("PUT", "Products/UpdateProductStatuses", { body: statuses });
  }
  updateProductBarcodes(barcodes: { id: string; [k: string]: unknown }[]) {
    return this.request<unknown>("PUT", "Products/UpdateProductBarcodes", { body: barcodes });
  }

  // ── quotes (read-only in the API) ──
  async getQuotes(opportunityId: string): Promise<DtQuoteLite[]> {
    return (await this.request<DtQuoteLite[] | null>("GET", "Quotes/GetQuotes", { query: { opportunityId } })) ?? [];
  }
  getQuote(id: string) {
    return this.request<DtQuoteDetail>("GET", "Quotes/GetQuote", { query: { id } });
  }

  // ── read-only extras (not used by the tools yet) ──
  getChangeOrders(projectId: string) {
    return this.request<Record<string, unknown>[]>("GET", "ChangeOrders/GetChangeOrders", { query: { projectId } });
  }
  getChangeOrder(id: string) {
    return this.request<Record<string, unknown>>("GET", "ChangeOrders/GetChangeOrder", { query: { id } });
  }
  getFile(id: string) {
    return this.request<Record<string, unknown>>("GET", "Files/GetFile", { query: { id } });
  }
  getPurchaseOrders(q: ListQuery = {}) {
    return this.request<Record<string, unknown>>("GET", "PurchaseOrders/GetPurchaseOrders", { query: q });
  }
  getPurchaseOrder(id: string) {
    return this.request<Record<string, unknown>>("GET", "PurchaseOrders/GetPurchaseOrder", { query: { id } });
  }
  getServiceContracts(q: ListQuery = {}) {
    return this.request<Record<string, unknown>>("GET", "ServiceContracts/GetServiceContracts", { query: q });
  }
  getServiceContract(id: string) {
    return this.request<Record<string, unknown>>("GET", "ServiceContracts/GetServiceContract", { query: { id } });
  }
  getTimeEntries(q: ListQuery = {}) {
    return this.request<Record<string, unknown>>("GET", "TimeEntries/GetTimeEntries", { query: q });
  }
}

/** ": <title> — <detail>" from a ProblemDetails body, else a short excerpt. */
function problem(text: string): string {
  if (!text) return "";
  try {
    const p = JSON.parse(text) as { title?: unknown; detail?: unknown; errors?: unknown };
    const parts = [p.title, p.detail].filter((x): x is string => typeof x === "string" && !!x.trim());
    if (p.errors && typeof p.errors === "object") parts.push(JSON.stringify(p.errors).slice(0, 300));
    if (parts.length) return `: ${parts.join(" — ").slice(0, 500)}`;
  } catch {
    /* not JSON */
  }
  return `: ${text.replace(/\s+/g, " ").slice(0, 200)}`;
}

/** The uuid a create endpoint returns (a JSON string, or plain text). */
function idOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/^"|"$/g, "") : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "";
  if (!s) throw new DtoolsError("D-Tools created the record but returned no id", 200, "create");
  return s;
}
