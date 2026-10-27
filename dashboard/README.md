# Brink app (dashboard/)

Internal Brink Design tool. It is never distributed and never shown to clients.

One website for every brink-merge project. It will host both the OpenTakeoff plan canvas and the EasySchematic editor for each project. **Phase 1 (this version) is the app shell: read-only and live.**

| Route | What it shows |
|---|---|
| `/` **Projects** | Every project: current-import time, BOM totals (devices, cables, net / order LF), error and warning counts, and the latest Portal push when the database has `brink_portal_pushes`. Updates live. |
| `/projects/:id/bom` **BOM & Issues** | The live view of the current import: BOM, issues, rooms, devices, connections. Changed rows flash; a re-import switches the page to the new import. |
| `/projects/:id/schematic` **Schematic** | Phase 2 placeholder (the EasySchematic editor mounts here), plus a read-only outline of the stored schematic: rooms, then devices, then each device's connections. |
| `/projects/:id/takeoff` **Takeoff** | Phase 3 placeholder (the OpenTakeoff canvas mounts here), plus the current import's source hashes. |

`/projects/:id` opens the BOM & Issues tab. The first dashboard's `/p/:id` links redirect.

> **No authentication.** Anyone who can reach the Worker can read every project. Do not deploy it without Cloudflare Access (or an equivalent access layer) on the route.

```
browser ──GET /api/projects, /api/projects/:id──▶ Worker ──Hyperdrive (pg)──▶ Supabase Postgres
   ▲                                                │
   ├──WebSocket /api/projects/:id/live (rows)──┐    │
   └──WebSocket /api/live (list "touch")───────┴──▶ RealtimeRelay (Durable Object)
                                                     │ ONE Supabase Realtime channel (service-role key)
                                                     └─ postgres_changes on the brink_* tables
```

## Stack

The shell uses EasySchematic's stack, so its editor can be mounted in Phase 2 without a second toolchain:
- React 19
- Vite 8
- Tailwind 4 (through PostCSS, as EasySchematic does)
- TypeScript 5.9
- react-router 7 for the routes

The Worker serves the build (`dist/`) through its assets binding. Unknown paths fall back to `index.html` (single-page app); `/api/*` always reaches the Worker.

## How it works

- **Reads.** The Worker queries Postgres through the Hyperdrive binding (`pg`). Every query is a SELECT, inside one `READ ONLY, REPEATABLE READ` transaction per request.
  - A project snapshot reads `current_import_id` and that import's rows at the same moment.
  - The project list totals each project's current-import BOM in SQL. The sums are brink-merge's own (`finalizeBom` in `brink-merge/src/bom.ts`):
    - devices: the quantity on `device` lines
    - cables, net LF and order LF: from the `cable` lines
  - Error and warning counts come from `brink_issues`.
  - The cable count lives in the `line` jsonb. The server copies out only `cables` and `pulls`, so the blob is never sent.
- **Optional tables.** `brink_portal_pushes` comes from brink-merge's Portal push migration, which not every database has.
  - The list query checks whether the table exists before it reads it.
  - The relay subscribes to the table only when it is in the `supabase_realtime` publication. Realtime rejects a whole channel that names a missing table.
  - Without the table, the Projects page says that Portal push status is not tracked.
- **Live updates.** brink-merge's tables have RLS on with no policies, so browsers cannot subscribe to Supabase Realtime. Instead, one `RealtimeRelay` Durable Object holds one Realtime subscription, opened with the service-role key. That key is a Worker secret and never reaches the browser.
  - **Project sockets** (`/api/projects/:id/live`). Each socket records its project and the import it shows. A change goes only to the sockets it concerns, projected to the app's columns.
  - **List sockets** (`/api/live`). These get a coalesced `touch` naming the tables that changed (at most one every 300 ms), never rows. The Projects page then re-reads `/api/projects`.
  - The upstream opens with the first browser and closes with the last. An alarm reopens it if the object restarts while browsers are still connected.
- **Ordering in the page** (`web/src/lib/projectStore.ts`).
  - Changes that arrive while a snapshot is being read are replayed after it.
  - Every "Live" status triggers a re-read, which covers changes made before the subscription was ready.
  - A change to `current_import_id` triggers a re-read. That happens on a re-import, or a `map_condition` re-merge.
  - All tabs of a project share one store, so switching tabs keeps the socket.

| Path | What it is |
|---|---|
| `src/index.ts` | Worker entry: the `/api` routes, then the static app |
| `src/api/router.ts` | Method + path router. A path served for another method answers 405 with `Allow`. |
| `src/db.ts` | Hyperdrive reads (project list with totals, snapshot, optional-table checks) |
| `src/relay.ts`, `src/realtime.ts` | `RealtimeRelay` Durable Object and its Supabase Realtime upstream |
| `src/shared/` | Table / column contract, routing and the change reducer, shared by the Worker and the page |
| `web/src/main.tsx` | Routes |
| `web/src/workspaces.ts` | The project tabs; later phases swap a placeholder for the real workspace here |
| `web/src/pages/`, `web/src/components/`, `web/src/lib/` | Pages, UI pieces, the live socket and the stores |
| `scripts/live-check.mjs` | Real-browser end-to-end check (Playwright); writes `docs/evidence/phase1/` |

**Schema.** brink-merge owns the schema (`brink-merge/supabase/migrations/`). The app only reads it. Phase 1 needed no schema change.

## API (Phase 1: GET only)

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok, realtime }`, where `realtime` says whether the Supabase secrets are set |
| `GET /api/projects` | `{ projects: ProjectSummary[], features: { portalPushes }, readAt }` |
| `GET /api/projects/:id` | `Snapshot`: the current import's BOM, issues, schematic nodes and connections |
| `GET /api/projects/:id/live` | WebSocket: `status` and `change` messages |
| `GET /api/live` | WebSocket: `status` and `touch` messages |

The types are in `src/shared/protocol.ts`. Write endpoints (Phase 2/3) are added to the router in `src/index.ts`.

## Run it locally

Requires Node 22.12+ and Docker (for local Supabase).

1. **Start local Supabase** (Postgres + Realtime) from `brink-merge/`:
   ```bash
   cd brink-merge && npm ci
   npx supabase start
   npx supabase status -o env      # API_URL, SERVICE_ROLE_KEY
   ```
   Only the database, Realtime and the API gateway (Kong) are needed. If Docker Hub rate-limits image pulls, run:
   ```bash
   SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npx supabase start -x gotrue,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
   ```
   With gotrue excluded, `status` prints no keys. The local service-role key is then a JWT with `"role": "service_role"`, signed (HS256) with the Realtime container's `API_JWT_SECRET`.
2. **Import the invented fixtures**:
   ```bash
   node bin/brink-merge.mjs fixtures/div27-sample.takeoff.json --report fixtures/div27-sample.report.json \
     --db-url postgres://postgres:postgres@127.0.0.1:54322/postgres --out /tmp/x.json --bom /tmp/x.csv
   node bin/brink-merge.mjs fixtures/div27-minimal.takeoff.json --report fixtures/div27-minimal.report.json \
     --project "Brink Div 27 minimal (invented)" --db-url postgres://postgres:postgres@127.0.0.1:54322/postgres --out /tmp/m.json --bom /tmp/m.csv
   ```
3. **Set the secrets.** In `dashboard/`, run `cp .dev.vars.example .dev.vars`, then set `SUPABASE_SERVICE_ROLE_KEY`. `.dev.vars` is gitignored.
4. **Run**:
   ```bash
   cd dashboard && npm ci
   npm run dev                     # vite build + wrangler dev on http://127.0.0.1:8787
   npm run dev:web                 # optional: Vite with hot reload on :5173; it proxies /api (including the sockets) to :8787
   ```
   Hyperdrive uses `localConnectionString` from `wrangler.toml` (local Supabase, port 54322). To use another Postgres, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://…`.
5. **Open** <http://127.0.0.1:8787>. Change data and watch the page:
   ```bash
   psql postgres://postgres:postgres@127.0.0.1:54322/postgres \
     -c "update brink_bom_lines set qty = qty + 1 where line_no = 2 and import_id = (select current_import_id from brink_projects limit 1)"
   ```
6. **Browser check** (Playwright, with `npm run dev` running):
   ```bash
   npm run live-check              # writes docs/evidence/phase1/*.png and results.json; exits 1 on any failed check
   ```

A plain Postgres without Supabase also works for reads. The header then shows "Realtime down", or "Realtime not configured" when the secrets are missing.

## Tests

```bash
npm run check                     # typecheck (worker, app, tests) + vitest + build
DASHBOARD_TEST_DATABASE_URL=postgres://… npm test   # also the read API over Hyperdrive, on a database brink-merge imported into
```

- **`test/worker.test.ts`** starts the real Worker and Durable Object in workerd (`wrangler dev`). The relay points at a mock Supabase Realtime server (`test/mock-realtime.ts`). The test checks:
  - one upstream subscription, opened with the service key
  - routing per project and per import
  - re-pointing when `current_import_id` moves
  - coalesced `touch` messages, with no rows, on the list socket
  - closing the upstream when the last browser leaves
  - the API being read-only (405 with `Allow`)
  - the app shell served on client routes
- With a database, it also checks that the list's SQL totals equal the page's own totals and brink-merge's printed totals for the sample.
- **`test/db.test.ts`** checks that `brink_portal_pushes` is queried only when it exists.
- **`test/shared.test.ts`** covers the reducer, routing and the projection.

The genuine Realtime path is covered by `npm run live-check` against local Supabase.

## Evidence (Phase 1)

All of it is in `docs/evidence/phase1/` (`results.json` holds the check run). Every screenshot uses invented fixture data only.

| File | What it shows |
|---|---|
| `01-projects.png` | Projects page |
| `02-projects-live-change.png` | A BOM edit reaches the Projects row live |
| `03-bom-issues.png` | BOM & Issues tab |
| `04-bom-live-change.png`, `04b-…` | Live rows in BOM & Issues |
| `05-schematic.png` | Schematic tab |
| `06-takeoff.png` | Takeoff tab |
| `07-reimport-switched.png` | The page switched to a re-import |
| `08-phone-projects.png`, `09-phone-bom.png` | Phone width (390 px) |
| `10-…`, `11-…` | The Portal push column, against a throwaway local database that had brink-merge's unmerged Portal push migration applied for the check. Nothing in this repository adds that table. |

The first dashboard's screenshots are still in `docs/evidence/*.png`.

## Before any deploy (owner decisions)

Nothing in this repository deploys the app. Before a deploy, the owner needs to:

- **Access control.** Put Cloudflare Access on the route; there is no auth in the Worker. Phase 2/3 write endpoints will also need the Worker to verify the Access JWT (`Cf-Access-Jwt-Assertion`) and record who wrote.
- **Hyperdrive.** Run `wrangler hyperdrive create` against the Supabase session pooler or direct connection. Put the config id in `wrangler.toml` in place of the all-zero placeholder.
  - The role must be able to SELECT the brink tables. They have RLS with no policies, so that means a role that bypasses RLS, or a dedicated read-only role.
  - To show the Portal push status, the same role must also be able to read `pg_class` and `pg_publication_tables`.
- **Secrets.** Run `wrangler secret put SUPABASE_URL` and `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`. Local runs used the legacy service-role JWT; the new `sb_secret_…` keys have not been tried with Realtime here.
