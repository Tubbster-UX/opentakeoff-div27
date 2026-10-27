// Brink dashboard Worker: a read-only JSON API over Hyperdrive, the live
// WebSocket (handed to the RealtimeRelay Durable Object), and the static app.
//
//   GET /api/health                 -> { ok, realtime: configured? }
//   GET /api/projects               -> projects with their current import
//   GET /api/projects/:id           -> snapshot of the current import (BOM, issues, schematic rows)
//   GET /api/projects/:id/live      -> WebSocket: row changes for that project
//
// NO AUTHENTICATION. This must not be reachable publicly without an access
// layer in front (e.g. Cloudflare Access); see dashboard/README.md.
import { listProjects, readSnapshot, withClient } from "./db.js";
import type { Env } from "./env.js";

export { RealtimeRelay } from "./relay.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One relay instance for the whole dashboard: one upstream subscription. */
const RELAY_NAME = "brink-realtime-relay";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method !== "GET") return json({ error: "read-only" }, 405);

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, realtime: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) });
      }
      if (url.pathname === "/api/projects") {
        return json(await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), listProjects));
      }
      const m = url.pathname.match(/^\/api\/projects\/([^/]+)(\/live)?$/);
      if (m) {
        const id = m[1]!;
        if (!UUID.test(id)) return json({ error: "project id must be a uuid" }, 400);
        if (m[2]) {
          const relay = env.RELAY.get(env.RELAY.idFromName(RELAY_NAME));
          const fwd = new URL(req.url);
          fwd.searchParams.set("project", id);
          return relay.fetch(new Request(fwd.toString(), req));
        }
        const snap = await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), (db) => readSnapshot(db, id));
        return snap ? json(snap) : json({ error: "no such project" }, 404);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error("api error", e);
      return json({ error: "database unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
