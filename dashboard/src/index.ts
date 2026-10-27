// Brink app Worker: the JSON API over Hyperdrive, the live WebSockets (handed
// to the RealtimeRelay Durable Object), and the static single-page app
// (including the EasySchematic editor frame, es-frame.html).
//
//   GET  /api/health                         -> { ok, realtime: configured? }
//   GET  /api/me                             -> Me: the Cloudflare Access identity, or why there is none (always 200)
//   GET  /api/projects                       -> ProjectList: projects with current-import totals (and Portal push, when tracked)
//   GET  /api/projects/:id                   -> Snapshot of the current import (BOM, issues, schematic rows)
//   GET  /api/projects/:id/schematic         -> SchematicView: the EasySchematic file, rows + the edit layer
//   POST /api/projects/:id/schematic/edits   -> EditResponse: append edits to the layer (Access identity required)
//   GET  /api/projects/:id/live              -> WebSocket: row changes for that project
//   GET  /api/live                           -> WebSocket: "touch" notices for the project list
//
// Reads carry no identity check of their own: Cloudflare Access in front of
// the route is what keeps them private (dashboard/README.md). Writes verify the
// Access JWT here (src/access.ts) and record the editor's email.
import { identify } from "./access.js";
import { json, Router } from "./api/router.js";
import { listProjects, readSnapshot, withClient } from "./db.js";
import type { Env } from "./env.js";
import { HttpError, parseEditRequest, readSchematic, writeEdits } from "./schematic.js";

export { RealtimeRelay } from "./relay.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One relay instance for the whole app: one upstream subscription. */
const RELAY_NAME = "brink-realtime-relay";
/** A save carries at most a few hundred small ops. */
const MAX_BODY = 256 * 1024;

const api = new Router({ id: (v) => (UUID.test(v) ? null : "project id must be a uuid") })
  .get("/api/health", ({ env }) => json({ ok: true, realtime: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) }))
  .get("/api/projects", async ({ env, ctx }) => json(await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), listProjects)))
  .get("/api/projects/:id", async ({ env, ctx, params }) => {
    const snap = await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), (db) => readSnapshot(db, params.id!));
    return snap ? json(snap) : json({ error: "no such project" }, 404);
  })
  // A status query, not a protected resource: it says who would be recorded on a save, or why nobody would.
  .get("/api/me", async ({ req, env }) => {
    const who = await identify(req, env);
    return json(who.ok ? who.identity : { email: null, auth: null, error: who.error });
  })
  .get("/api/projects/:id/schematic", async ({ env, ctx, params }) => {
    const view = await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), (db) => readSchematic(db, params.id!));
    if (!view) return json({ error: "no such project" }, 404);
    if ("noImport" in view) return json({ error: "the project has no current import" }, 409);
    return json(view);
  })
  .add("POST", "/api/projects/:id/schematic/edits", async ({ req, env, ctx, url, params }) => {
    // Same-origin only: the editor frame posts JSON; a cross-site form cannot.
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "cross-origin write refused" }, 403);
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "send application/json" }, 415);
    const who = await identify(req, env);
    if (!who.ok) return json({ error: who.error }, who.status);
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "request too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "body is not JSON" }, 400);
    }
    try {
      const request = parseEditRequest(body);
      return json(await withClient(env.HYPERDRIVE.connectionString, (p) => ctx.waitUntil(p), (db) => writeEdits(db, params.id!, request, who.identity)));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      throw e;
    }
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
