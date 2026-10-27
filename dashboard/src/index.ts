// Brink app Worker: the JSON API over Hyperdrive, the live WebSockets (handed
// to the RealtimeRelay Durable Object), and the static single-page app.
//
// Phase 1 is read-only: every route is a GET.
//   GET /api/health                 -> { ok, realtime: configured? }
//   GET /api/projects               -> ProjectList: projects with current-import totals (and Portal push, when tracked)
//   GET /api/projects/:id           -> Snapshot of the current import (BOM, issues, schematic rows)
//   GET /api/projects/:id/live      -> WebSocket: row changes for that project
//   GET /api/live                   -> WebSocket: "touch" notices for the project list
// Later phases add write routes to `api` below (router.add("POST", ...)).
//
// NO AUTHENTICATION. This must not be reachable publicly without an access
// layer in front (Cloudflare Access); see dashboard/README.md.
import { json, Router } from "./api/router.js";
import { listProjects, readSnapshot, withClient } from "./db.js";
import type { Env } from "./env.js";

export { RealtimeRelay } from "./relay.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One relay instance for the whole app: one upstream subscription. */
const RELAY_NAME = "brink-realtime-relay";

const api = new Router({ id: (v) => (UUID.test(v) ? null : "project id must be a uuid") })
  .get("/api/health", ({ env }) => json({ ok: true, realtime: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) }))
  .get("/api/projects", async ({ env, ctx }) => json(await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), listProjects)))
  .get("/api/projects/:id", async ({ env, ctx, params }) => {
    const snap = await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), (db) => readSnapshot(db, params.id!));
    return snap ? json(snap) : json({ error: "no such project" }, 404);
  })
  .get("/api/projects/:id/live", ({ req, env, params }) => toRelay(req, env, { project: params.id! }))
  .get("/api/live", ({ req, env }) => toRelay(req, env, { scope: "list" }));

function toRelay(req: Request, env: Env, query: Record<string, string>): Promise<Response> {
  const relay = env.RELAY.get(env.RELAY.idFromName(RELAY_NAME));
  const fwd = new URL(req.url);
  for (const [k, v] of Object.entries(query)) fwd.searchParams.set(k, v);
  return relay.fetch(new Request(fwd.toString(), req));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return (await api.handle(req, env, ctx)) ?? json({ error: "not found" }, 404);
    } catch (e) {
      console.error("api error", e);
      return json({ error: "database unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
