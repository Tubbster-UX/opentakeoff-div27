// A fake D-Tools Cloud API for the D-Tools tests: a local express app that
// implements the endpoints brink-server uses, with in-memory records shaped
// like D-Tools' published schemas, and checks X-API-Key and HTTP Basic auth
// on every request. Every record, name, key and password here is invented.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import { DtoolsClient } from "../src/dtools/client.ts";
import type { DtoolsConfig } from "../src/dtools/config.ts";

export const FAKE_KEY = "fake-key-0000-not-real";
export const FAKE_USER = "fake-basic-user";
export const FAKE_PASS = "fake-basic-pass-not-real";

type Rec = Record<string, any>;

export class FakeDtools {
  clients: Rec[] = [];
  opportunities: Rec[] = [];
  projects: Rec[] = [];
  products: Rec[] = [];
  quotes: Rec[] = [];
  /** Every request: method, path, query, body. */
  calls: { method: string; path: string; query: Rec; body: unknown }[] = [];
  /** path → failures to answer before succeeding. */
  failures = new Map<string, { status: number; count: number; retryAfter?: string }>();
  unauthorized = 0;
  url = "";
  private server: http.Server | null = null;

  config(over: Partial<DtoolsConfig> = {}): DtoolsConfig {
    return { baseUrl: `${this.url}/api/v1`, apiKey: FAKE_KEY, basicUser: FAKE_USER, basicPassword: FAKE_PASS, webhookToken: null, timeoutMs: 5000, ...over };
  }
  client(over: Partial<DtoolsConfig> = {}): DtoolsClient {
    return new DtoolsClient(this.config(over), { sleep: async () => {}, baseDelayMs: 1 });
  }
  callsTo(p: string) {
    return this.calls.filter((c) => c.path === p);
  }

  async start(): Promise<this> {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const basic = `Basic ${Buffer.from(`${FAKE_USER}:${FAKE_PASS}`).toString("base64")}`;
    app.use((req, res, next) => {
      const p = req.path.replace(/^\/api\/v1\//, "");
      this.calls.push({ method: req.method, path: p, query: { ...req.query }, body: req.body });
      if (req.get("x-api-key") !== FAKE_KEY || req.get("authorization") !== basic) {
        this.unauthorized++;
        res.status(401).json({ title: "Unauthorized", status: 401 });
        return;
      }
      const f = this.failures.get(p);
      if (f && f.count > 0) {
        f.count--;
        if (f.retryAfter) res.set("Retry-After", f.retryAfter);
        res.status(f.status).json({ title: f.status === 429 ? "Too Many Requests" : "Server error", status: f.status });
        return;
      }
      next();
    });
    const page = (rows: Rec[], req: Request) => {
      const p = Math.max(1, Number(req.query.page ?? 1));
      const size = Math.max(1, Number(req.query.pageSize ?? 20));
      return rows.slice((p - 1) * size, p * size);
    };
    const search = (rows: Rec[], req: Request, keys: string[]) => {
      const s = String(req.query.search ?? "").toLowerCase();
      return s ? rows.filter((r) => keys.some((k) => String(r[k] ?? "").toLowerCase().includes(s))) : rows;
    };
    const byId = (rows: Rec[], req: Request, res: Response) => {
      const r = rows.find((x) => x.id === req.query.id);
      if (!r) { res.status(404).json({ title: "Not Found", status: 404, detail: `No record ${String(req.query.id)}` }); return null; }
      return r;
    };
    const total = (req: Request, n: number) => (String(req.query.includeTotalCount) === "true" ? n : 0);
    const now = () => new Date().toISOString();
    const r = express.Router();

    r.get("/Clients/GetClients", (req, res) => { const rows = search(this.clients, req, ["name", "number", "email"]); res.json({ clients: page(rows, req), totalClients: total(req, rows.length) }); });
    r.get("/Clients/GetClient", (req, res) => { const c = byId(this.clients, req, res); if (c) res.json(c); });
    r.post("/Clients/CreateClient", (req, res) => {
      if (!req.body?.name) { res.status(400).json({ title: "Bad Request", detail: "name is required" }); return; }
      const id = randomUUID();
      this.clients.push({ ...req.body, id, isActive: true, createdDate: now(), modifiedDate: now() });
      res.json(id);
    });
    r.put("/Clients/UpdateClient", (req, res) => { const c = byId(this.clients, req, res); if (c) { Object.assign(c, req.body, { modifiedDate: now() }); res.json("Updated"); } });

    r.get("/Opportunities/GetOpportunities", (req, res) => { const rows = search(this.opportunities, req, ["name", "number", "clientName"]); res.json({ opportunities: page(rows, req), totalOpportunities: total(req, rows.length) }); });
    r.get("/Opportunities/GetOpportunity", (req, res) => { const o = byId(this.opportunities, req, res); if (o) res.json({ ...o, quoteIds: this.quotes.filter((q) => q.opportunityId === o.id).map((q) => q.id) }); });
    r.post("/Opportunities/CreateOpportunity", (req, res) => {
      const b = req.body ?? {};
      let clientId = b.clientId;
      if (!clientId && b.clientName) { clientId = randomUUID(); this.clients.push({ id: clientId, name: b.clientName, email: b.clientEmail ?? null, isActive: true }); }
      if (!clientId) { res.status(400).json({ title: "Bad Request", detail: "client required" }); return; }
      const id = randomUUID();
      const client = this.clients.find((c) => c.id === clientId);
      this.opportunities.push({ ...b, id, clientId, clientName: client?.name ?? null, stage: "New", stageGroup: "Open", price: 0, total: 0, createdDate: now(), modifiedDate: now(), isArchived: false });
      res.json(id);
    });
    r.put("/Opportunities/UpdateOpportunity", (req, res) => {
      const o = byId(this.opportunities, req, res);
      if (!o) return;
      // a full-replace PUT: every UpdateOpportunity field comes from the body
      for (const k of ["associatedProjectId", "clientId", "name", "number", "buildingType", "marketSector", "projectType", "quoteType", "quoteTemplate", "priority", "budget", "probability", "owner", "projectArea", "fulfillmentLocation", "estimatedCloseDate", "actualCloseDate", "estimatedProjectStartDate", "estimatedProjectEndDate", "leadSource", "lostReason", "lostDescription", "billingAddress", "siteAddress", "contacts"]) o[k] = req.body?.[k] ?? null;
      o.modifiedDate = now();
      res.json("Updated");
    });

    r.get("/Projects/GetProjects", (req, res) => { const rows = search(this.projects, req, ["name", "number"]); res.json({ projects: page(rows, req), totalProjects: total(req, rows.length) }); });
    r.get("/Projects/GetProject", (req, res) => { const p = byId(this.projects, req, res); if (p) res.json(p); });
    r.put("/Projects/UpdateProject", (req, res) => {
      const p = byId(this.projects, req, res);
      if (!p) return;
      for (const k of ["clientId", "name", "number", "priority", "budget", "salesperson", "projectManager", "opportunityWonDate", "startDate", "endDate", "completedDate", "billingAddress", "siteAddress", "contacts"]) p[k] = req.body?.[k] ?? null;
      p.modifiedDate = now();
      res.json("Updated");
    });

    r.get("/Products/GetProducts", (req, res) => { const rows = search(this.products, req, ["name", "brand", "model", "partNumber"]); res.json({ products: page(rows, req), totalProducts: total(req, rows.length) }); });
    r.get("/Products/GetProduct", (req, res) => { const p = byId(this.products, req, res); if (p) res.json(p); });
    r.put("/Products/UpdateProductPrices", (req, res) => {
      const list = Array.isArray(req.body) ? req.body : [];
      for (const e of list) {
        const p = this.products.find((x) => x.id === e.id);
        if (!p) { res.status(404).json({ title: "Not Found", detail: `product ${e.id}` }); return; }
      }
      for (const e of list) Object.assign(this.products.find((x) => x.id === e.id)!, { msrp: e.msrp, unitCost: e.unitCost, unitPrice: e.unitPrice, modifiedDate: now() });
      res.json("Updated");
    });

    r.get("/Quotes/GetQuotes", (req, res) => { res.json(this.quotes.filter((q) => q.opportunityId === req.query.opportunityId).map(({ id, name, number, version, state, price, modifiedDate }) => ({ id, name, number, version, state, price, modifiedDate }))); });
    r.get("/Quotes/GetQuote", (req, res) => { const q = byId(this.quotes, req, res); if (q) res.json(q); });

    app.use("/api/v1", r);
    app.use((_req, res) => { res.status(404).json({ title: "Not Found" }); });
    this.server = http.createServer(app);
    await new Promise<void>((ok) => this.server!.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((ok) => this.server!.close(() => ok()));
  }
}

/** An invented quote for the invented takeoff (test/installFixture.ts): see dtoolsReconcile.test.ts for what differs. */
export function inventedQuote(opportunityId: string, id: string = randomUUID()): Rec {
  const item = (n: number, x: Rec) => ({ id: n, catalogId: randomUUID(), type: "Product", quantity: 1, isLengthBased: false, unitCost: null, unitPrice: null, ...x });
  return {
    id, opportunityId, name: "Invented Clinic Quote", number: "Q-1001", version: 1, state: "Draft", price: 4321, isIncludedInTotal: true,
    createdDate: "2026-11-20T00:00:00Z", modifiedDate: "2026-11-20T00:00:00Z",
    locations: [
      { id: 1, name: "101 office", number: null, fullName: "101 office" },
      { id: 2, name: "Open Office Area", number: null, fullName: "Open Office Area" },
      { id: 3, name: "Conference", number: "201", fullName: "Conference 201" },
      { id: 4, name: "Lobby", number: null, fullName: "Lobby" },
    ],
    systems: [{ id: 1, name: "Structured Cabling" }], phases: [{ id: 1, name: "Rough-in" }], laborTypes: [{ id: 1, name: "Install" }],
    lengths: [{ id: 1, name: "1000 ft", length: 1000 }],
    items: [
      // data outlets: takeoff 2 in Office 101, 1 in Open Office, 1 in Storage 202 (4); quote 2 at "101 office" + 2 + 1 at Conference 201 = 5
      item(1, { brand: "Invented Co", model: "DO-2", partNumber: "IC-DO2", quantity: 2, locationId: 1, location: "101 office", unitPrice: 40 }),
      item(2, { brand: "Invented Co", model: "DO-2", partNumber: "IC-DO2", quantity: 2, locationId: 2, location: "Open Office Area", unitPrice: 40 }),
      item(3, { brand: "Invented Co", model: "DO-2", partNumber: "IC-DO2", quantity: 1, locationId: 3, location: "Conference 201", unitPrice: 40 }),
      // WAPs: takeoff 3 (one held); quote 1 at Open Office Area, matched by part number
      item(4, { brand: "Invented Wireless", model: "AP-9", partNumber: "IW-AP9", quantity: 1, locationId: 2, location: "Open Office Area", unitPrice: 600 }),
      // camera: in the takeoff (mapped) but not in the quote → missing_from_quote, priced from the catalog
      // CAT6A plenum: takeoff 1188 ft to order; quote 1 × 1000 ft
      item(5, { brand: "Invented Cable", model: "C6A-PL", partNumber: "ICC-6APL", quantity: 1, isLengthBased: true, lengthId: 1, length: 1000, unitPrice: 450, pricePerLength: 0.45, locationId: 4, location: "Lobby" }),
      // a quote-only item: a rack the takeoff has no condition mapped to
      item(6, { brand: "Invented Racks", model: "R-42", partNumber: "IR-42", quantity: 1, locationId: 4, location: "Lobby", unitPrice: 900 }),
      // labor, not compared
      item(7, { type: "Labor", name: "Install labor", quantity: 10, unitPrice: 85 }),
    ],
  };
}
