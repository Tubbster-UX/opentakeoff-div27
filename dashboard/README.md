# Brink dashboard

Internal Brink Design tool. It is never distributed and never shown to clients.

A **read-only, live view of one brink-merge project**: its BOM lines, schematic rows (rooms, devices, connections) and issues, read from the brink-merge database. The page updates as rows change, with no reload. This version has no editing.

> **No authentication.** Anyone who can reach the Worker can read every project. Do not deploy it publicly without an access layer in front, such as Cloudflare Access on the route.

```
browser ──GET /api/projects/:id──────────▶ Worker ──Hyperdrive (pg)──▶ Supabase Postgres
   ▲                                          │
   └──WebSocket /api/projects/:id/live──▶ RealtimeRelay (Durable Object)
                                              │ ONE Supabase Realtime channel (service-role key)
                                              └─ postgres_changes on the six brink_* tables
```

## How it works

- **Reads.** The Worker queries Postgres through the Hyperdrive binding (`pg`). Every query is a SELECT.
  - A project snapshot is read in one `READ ONLY, REPEATABLE READ` transaction, so the project's `current_import_id` and that import's rows come from the same moment.
  - The project's current data is the set of rows whose `import_id` is `brink_projects.current_import_id`.
- **Live updates.** brink-merge's tables have RLS on with no policies, so browsers cannot subscribe to Supabase Realtime. Instead:
  - One `RealtimeRelay` Durable Object holds one Realtime subscription to `brink_projects`, `brink_imports`, `brink_bom_lines`, `brink_issues`, `brink_schematic_nodes` and `brink_schematic_connections`. It subscribes with the service-role key, a Worker secret that never reaches the browser.
  - The relay fans each change out to browser WebSockets through the hibernation API. Each socket records the project it opened and the import it shows. A change goes only to the sockets it concerns.
  - Changes are projected to the dashboard's columns before sending. The raw takeoff/report and the `node` / `edge` / `line` jsonb blobs are not sent.
  - The upstream opens with the first browser and closes with the last. An alarm reopens it if the object restarts while browsers are still connected.
- **Re-imports.** A re-import or a `map_condition` re-merge moves `current_import_id`. The relay points that project's sockets at the new import, and the page re-reads its snapshot.
  - Changes that arrive while the page is reading are replayed afterwards.
  - Every time the relay reports "Live" (first connect, or a reconnect), the page reads the snapshot again. This covers changes made before the subscription was ready.

| Path | What it is |
|---|---|
| `src/index.ts` | Worker: `/api/health`, `/api/projects`, `/api/projects/:id`, `/api/projects/:id/live`; everything else is the static app |
| `src/relay.ts` | `RealtimeRelay` Durable Object |
| `src/realtime.ts` | The upstream: `@supabase/realtime-js`, `postgres_changes` with `wait: true` |
| `src/db.ts` | Hyperdrive reads |
| `src/shared/` | Table/column contract, routing and the page's change reducer (shared by Worker and page) |
| `web/` | The page (Vite, no framework) |
| `scripts/live-check.mjs` | Real-browser end-to-end check (Playwright), writes `docs/evidence/` |

**Schema.** brink-merge owns the schema (`brink-merge/supabase/migrations/`). The dashboard only reads it, and needed no schema change.

## Run it locally

Requires Node 22+ and Docker (for local Supabase).

1. **Local Supabase** (Postgres + Realtime). From `brink-merge/`:
   ```bash
   cd brink-merge && npm ci
   npx supabase start
   npx supabase status -o env      # API_URL, SERVICE_ROLE_KEY
   ```
2. **Import the invented fixture**:
   ```bash
   node bin/brink-merge.mjs fixtures/div27-sample.takeoff.json --report fixtures/div27-sample.report.json \
     --db-url postgres://postgres:postgres@127.0.0.1:54322/postgres --out /tmp/x.json --bom /tmp/x.csv
   ```
3. **Secrets**. In `dashboard/`, run `cp .dev.vars.example .dev.vars`. Then set `SUPABASE_SERVICE_ROLE_KEY` to the `SERVICE_ROLE_KEY` from step 1. `.dev.vars` is gitignored.
4. **Run**:
   ```bash
   cd dashboard && npm ci
   npm run dev                     # vite build + wrangler dev on http://127.0.0.1:8787
   ```
   Hyperdrive uses `localConnectionString` from `wrangler.toml` (local Supabase, port 54322). To use another Postgres, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://…`.
5. **Open** <http://127.0.0.1:8787>, then pick the project. Change data and watch the page:
   ```bash
   psql postgres://postgres:postgres@127.0.0.1:54322/postgres \
     -c "update brink_bom_lines set qty = qty + 1 where line_no = 2 and import_id = (select current_import_id from brink_projects limit 1)"
   # or re-import (moves current_import_id; the page switches to the new import):
   (cd ../brink-merge && node bin/brink-merge.mjs fixtures/div27-sample.takeoff.json --report fixtures/div27-sample.report.json \
     --db-url postgres://postgres:postgres@127.0.0.1:54322/postgres --out /tmp/x.json --bom /tmp/x.csv)
   ```
6. **Browser check** (Playwright, with `npm run dev` running):
   ```bash
   npm run live-check              # writes docs/evidence/*.png, exits 1 on any failed check
   ```

A plain Postgres without Supabase also works for reads. The header then shows "Realtime down", or "Realtime not configured" when the secrets are missing.

## Tests

```bash
npm run check                     # typecheck (worker, page, tests) + vitest + build
DASHBOARD_TEST_DATABASE_URL=postgres://… npm test   # also the read API over Hyperdrive, on a database brink-merge imported into
```

`test/worker.test.ts` starts the real Worker and Durable Object in workerd (`wrangler dev`). It points the relay at a mock Supabase Realtime server (`test/mock-realtime.ts`, the Phoenix channel protocol realtime-js speaks). It then checks:
- one upstream subscription, opened with the service key
- routing per project and per import
- re-pointing when `current_import_id` moves
- closing the upstream when the last browser leaves

The genuine Realtime path is covered by `npm run live-check` against local Supabase.

## Before any deploy (owner decisions)

Nothing in this repository deploys the dashboard. Before a deploy, the owner needs to:

- **Access control.** Put Cloudflare Access (or equivalent) in front of the route; there is no auth in the Worker.
- **Hyperdrive.** Run `wrangler hyperdrive create` against the Supabase session pooler or direct connection, then put the config id in `wrangler.toml` in place of the all-zero placeholder.
  - Use a role that can SELECT the brink tables. They have RLS with no policies, so that means a role that bypasses RLS (the postgres/service connection) or a dedicated read-only role.
- **Secrets.** `wrangler secret put SUPABASE_URL` and `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`. Local runs used the legacy service-role JWT; the new `sb_secret_…` keys have not been tried with Realtime here.
