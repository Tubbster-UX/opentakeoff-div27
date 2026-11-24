// D-Tools routes:
//
//   dtoolsRoutes(deps, client)   the owner's (mounted on the /api router: owner
//                                cookie + CSRF, like the bid and install routes):
//     GET  /dtools/status                       connected?, linked projects, pending prices, recent log
//     GET  /dtools/pending-prices[?status=...]  the price changes Claude proposed
//     POST /dtools/pending-prices/:id/approve   applies it through UpdateProductPrices (actor owner);
//                                               on an API failure it stays pending with the error
//     POST /dtools/pending-prices/:id/reject
//
//   dtoolsWebhook(deps, client)  D-Tools' webhook (mounted on the app, NOT behind
//                                the owner cookie):
//     POST /webhooks/dtools   Authorization: Bearer <DTOOLS_WEBHOOK_TOKEN> (timing-safe),
//                             rate-limited, answers 202 at once; then, one event at a
//                             time, re-reads the named records through the API (the
//                             payload is never trusted), refreshes the cache of every
//                             project linked to them and logs it (actor webhook).
//
// mountDtools(app, api, deps) wires both from the environment.
import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { AppDeps } from "./types.ts";
import { loadDtoolsConfig, loadWebhookToken, NOT_CONNECTED } from "./dtools/config.ts";
import { DtoolsClient, DtoolsError } from "./dtools/client.ts";
import { DtoolsStore, type PendingPrice } from "./dtools/store.ts";
import { describeChanges, syncProject } from "./dtools/sync.ts";

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch((e) => {
    if (e instanceof RouteError) res.status(e.status).json({ error: e.code, message: e.message });
    else next(e);
  });

const PENDING_ID = /^pp-[0-9a-f]{6,20}$/;

export interface DtoolsRouteOptions {
  store?: DtoolsStore;
  /** Whether the webhook token is set (status page); default env DTOOLS_WEBHOOK_TOKEN. */
  webhookConfigured?: boolean;
}

export function dtoolsRoutes(deps: AppDeps, client: DtoolsClient | null, opts: DtoolsRouteOptions = {}): express.Router {
  const r = express.Router();
  const store = opts.store ?? new DtoolsStore(deps.storage, deps.projects);

  const pendingOf = async (req: Request): Promise<PendingPrice> => {
    const id = String(req.params.id ?? "");
    if (!PENDING_ID.test(id)) throw new RouteError(404, "not_found", "No such price change.");
    const p = (await store.listPending()).find((x) => x.id === id);
    if (!p) throw new RouteError(404, "not_found", "No such price change.");
    return p;
  };

  r.get("/dtools/status", wrap(async (_req, res) => {
    res.json({
      connected: !!client,
      ...(client ? {} : { message: NOT_CONNECTED }),
      webhook: opts.webhookConfigured ?? !!loadWebhookToken(),
      pendingPrices: (await store.listPending("pending")).length,
      linkedProjects: await store.linkedProjects(),
      recent: await store.readLog({ limit: 30 }),
    });
  }));

  r.get("/dtools/pending-prices", wrap(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !["pending", "applied", "rejected"].includes(status)) throw new RouteError(400, "bad_request", "status is pending, applied or rejected.");
    const list = await store.listPending(status as PendingPrice["status"] | undefined);
    list.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    res.json({ entries: list });
  }));

  r.post("/dtools/pending-prices/:id/approve", wrap(async (req, res) => {
    const p = await pendingOf(req);
    if (p.status !== "pending") throw new RouteError(409, "not_pending", `This price change was already ${p.status}.`);
    if (!client) throw new RouteError(503, "not_connected", NOT_CONNECTED);
    let current: Awaited<ReturnType<DtoolsClient["getProduct"]>>;
    try {
      // the catalog as it is now: fields the change leaves alone are sent back unchanged
      current = await client.getProduct(p.productId);
      const body = {
        id: p.productId,
        msrp: p.new.msrp !== undefined ? p.new.msrp : current.msrp ?? null,
        unitCost: p.new.unitCost !== undefined ? p.new.unitCost : current.unitCost ?? null,
        unitPrice: p.new.unitPrice !== undefined ? p.new.unitPrice : current.unitPrice ?? null,
      };
      await client.updateProductPrices([body]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await store.updatePending(p.id, (x) => { x.error = message.slice(0, 500); x.errorAt = new Date().toISOString(); });
      throw new RouteError(502, "dtools_failed", `D-Tools did not take the change; it is still pending. ${message}`);
    }
    const now = new Date().toISOString();
    const saved = await store.updatePending(p.id, (x) => { x.status = "applied"; x.decidedAt = now; delete x.error; delete x.errorAt; });
    const before = { msrp: current.msrp ?? null, unitCost: current.unitCost ?? null, unitPrice: current.unitPrice ?? null };
    const keys = Object.keys(p.new) as (keyof typeof before)[];
    await store.log({
      actor: "owner", action: "apply_price", entity: "product", id: p.productId,
      before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: { ...p.new },
      note: `${p.id}: ${[p.brand, p.model].filter(Boolean).join(" ")}; ${p.source} (${p.date})`,
    });
    res.json({ entry: saved });
  }));

  r.post("/dtools/pending-prices/:id/reject", wrap(async (req, res) => {
    const p = await pendingOf(req);
    if (p.status !== "pending") throw new RouteError(409, "not_pending", `This price change was already ${p.status}.`);
    const saved = await store.updatePending(p.id, (x) => { x.status = "rejected"; x.decidedAt = new Date().toISOString(); });
    await store.log({ actor: "owner", action: "reject_price", entity: "product", id: p.productId, after: { ...p.new }, note: `${p.id} rejected` });
    res.json({ entry: saved });
  }));

  return r;
}

// ── webhook ─────────────────────────────────────────────────────────────────

export interface WebhookEvent {
  module: string | null;
  type: string | null;
  ids: string[];
  updatedOn: string | null;
}

const UUIDISH = /^[0-9a-z][0-9a-z-]{0,63}$/i;

/** Module / change type / ids from whatever JSON D-Tools sent (keys in any case; never the ApiKey). */
export function parseWebhook(body: unknown): WebhookEvent {
  const flat: Record<string, unknown> = {};
  const src = Array.isArray(body) ? body[0] : body;
  if (src && typeof src === "object") for (const [k, v] of Object.entries(src as Record<string, unknown>)) flat[k.toLowerCase()] = v;
  const str = (...ks: string[]) => {
    for (const k of ks) if (typeof flat[k] === "string" && (flat[k] as string).trim()) return (flat[k] as string).trim().slice(0, 60);
    return null;
  };
  const rawIds: unknown[] = [];
  for (const k of ["ids", "id", "entityids", "entityid", "recordids", "recordid", "objectid"]) {
    const v = flat[k];
    if (Array.isArray(v)) rawIds.push(...v);
    else if (v !== undefined && v !== null) rawIds.push(v);
  }
  const ids = [...new Set(rawIds.map((x) => String(x).trim()).filter((x) => UUIDISH.test(x)))].slice(0, 50);
  return { module: str("module", "entity", "entitytype", "object", "resource"), type: str("type", "changetype", "event", "eventtype", "action"), ids, updatedOn: str("updatedon", "timestamp", "time") };
}

/** "Opportunities" / "opportunity" / "Quote" → the cache kinds; null for modules we do not cache. */
function moduleKind(m: string | null): "opportunity" | "project" | "quote" | "client" | "product" | null {
  const s = (m ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.startsWith("opportunit")) return "opportunity";
  if (s.startsWith("project")) return "project";
  if (s.startsWith("quote")) return "quote";
  if (s.startsWith("client") || s.startsWith("customer")) return "client";
  if (s.startsWith("product") || s.startsWith("catalog")) return "product";
  return null;
}

export interface WebhookOptions {
  store?: DtoolsStore;
  /** The Bearer token; default env DTOOLS_WEBHOOK_TOKEN (unset → 503). */
  token?: string | null;
  /** Requests per minute, all senders together (default 120) and per IP (default 60). */
  perMinute?: number;
  perIpPerMinute?: number;
  log?: (line: string) => void;
}

export type WebhookRouter = express.Router & { idle(): Promise<void> };

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function dtoolsWebhook(deps: AppDeps, client: DtoolsClient | null, opts: WebhookOptions = {}): WebhookRouter {
  const r = express.Router() as WebhookRouter;
  const store = opts.store ?? new DtoolsStore(deps.storage, deps.projects);
  const token = opts.token !== undefined ? opts.token : loadWebhookToken();
  const want = token ? digest(token) : null;
  const log = opts.log ?? ((l: string) => process.stderr.write(`[dtools] ${l}\n`));
  const perMinute = opts.perMinute ?? 120;
  const perIp = opts.perIpPerMinute ?? 60;
  let windowStart = Date.now();
  let total = 0;
  const byIp = new Map<string, number>();
  const allow = (ip: string) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; total = 0; byIp.clear(); }
    total++;
    const n = (byIp.get(ip) ?? 0) + 1;
    byIp.set(ip, n);
    return total <= perMinute && n <= perIp;
  };

  let chain: Promise<void> = Promise.resolve();
  r.idle = () => chain;

  const handle = async (ev: WebhookEvent) => {
    const kind = moduleKind(ev.module);
    const what = `${ev.type ?? "change"} ${ev.module ?? "(no module)"}${ev.ids.length ? ` ${ev.ids.join(", ")}` : ""}`;
    if (!client || !ev.ids.length || kind === "product" || !kind) {
      await store.log({ actor: "webhook", action: "webhook", entity: kind ?? (ev.module ?? "unknown"), ...(ev.ids[0] ? { id: ev.ids[0] } : {}), note: `${what}${!client ? "; D-Tools not connected, nothing re-read" : !ev.ids.length ? "; no ids, nothing re-read" : "; not cached, nothing re-read"}` });
      return;
    }
    // which of our projects does it touch? linked ids directly; a quote also by its opportunity
    const ids = [...ev.ids];
    if (kind === "quote") {
      for (const id of ev.ids) {
        try {
          const q = await client.getQuote(id);
          if (q?.opportunityId) ids.push(q.opportunityId);
        } catch (e) {
          log(`webhook: quote ${id} could not be read: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    const linked = await store.projectsLinkedTo(ids);
    if (!linked.length) {
      await store.log({ actor: "webhook", action: "webhook", entity: kind, id: ev.ids[0], note: `${what}; no project here is linked to it` });
      return;
    }
    for (const l of linked) {
      try {
        const rep = await syncProject(client, store, l.project);
        const lines = describeChanges(rep);
        await store.log({ actor: "webhook", action: "sync", entity: kind, id: ev.ids[0], project: l.project, note: `${what}: ${lines.length ? lines.join(" | ").slice(0, 2000) : "no change in the linked records"}${rep.errors.length ? `; errors: ${rep.errors.join("; ")}` : ""}` });
      } catch (e) {
        await store.log({ actor: "webhook", action: "sync", entity: kind, id: ev.ids[0], project: l.project, note: `${what}: refresh failed: ${e instanceof DtoolsError ? e.message : e instanceof Error ? e.message : String(e)}` });
      }
    }
  };

  r.post("/webhooks/dtools", express.text({ type: () => true, limit: "256kb" }), (req: Request, res: Response) => {
    if (!allow(req.ip ?? "?")) {
      res.set("Retry-After", "60").status(429).json({ error: "rate_limited" });
      return;
    }
    if (!want) {
      res.status(503).json({ error: "not_configured", message: "Set DTOOLS_WEBHOOK_TOKEN on the server." });
      return;
    }
    const h = req.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (!m || !timingSafeEqual(digest(m[1].trim()), want)) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(typeof req.body === "string" && req.body.trim() ? req.body : "{}");
    } catch {
      res.status(400).json({ error: "bad_json" });
      return;
    }
    const ev = parseWebhook(body);
    res.status(202).json({ accepted: true });
    chain = chain.then(() => handle(ev)).catch((e) => log(`webhook processing failed: ${e instanceof Error ? e.message : e}`));
  });

  return r;
}

/**
 * Wire D-Tools into the app from the environment: the owner routes on the
 * /api router (call before its 404 fallback) and the webhook on the app
 * (call before app.use(auth.requireOwner)).
 */
export function mountDtools(app: express.Express, api: express.Router, deps: AppDeps, env: Record<string, string | undefined> = process.env): { client: DtoolsClient | null; webhook: WebhookRouter } {
  const cfg = loadDtoolsConfig(env);
  const client = cfg ? new DtoolsClient(cfg) : null;
  const store = new DtoolsStore(deps.storage, deps.projects);
  const token = loadWebhookToken(env);
  api.use(dtoolsRoutes(deps, client, { store, webhookConfigured: !!token }));
  const webhook = dtoolsWebhook(deps, client, { store, token });
  app.use(webhook);
  return { client, webhook };
}
