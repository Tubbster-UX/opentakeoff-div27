# Brink app (dashboard/)

Internal Brink Design tool. It is never distributed and never shown to clients.

One website for every brink-merge project. It will host both the OpenTakeoff plan canvas and the EasySchematic editor for each project.
- **Phase 1** built the app shell: read-only and live.
- **Phase 2 (this version)** mounts the real EasySchematic editor in the Schematic tab. Edits are saved to the project's **schematic edit layer**, which survives re-imports (see [brink-merge/docs/schematic-edits.md](../brink-merge/docs/schematic-edits.md)).

**License.** The app includes EasySchematic, vendored in [`vendor/`](vendor/README.md) (AGPL-3.0). The app as a whole is AGPL-3.0, the license of this repository.

| Route | What it shows |
|---|---|
| `/` **Projects** | Every project: current-import time, BOM totals (devices, cables, net / order LF), error and warning counts, and the latest Portal push when the database has `brink_portal_pushes`. Updates live. |
| `/projects/:id/bom` **BOM & Issues** | The live view of the current import: BOM, issues, rooms, devices, connections. Changed rows flash; a re-import switches the page to the new import. |
| `/projects/:id/schematic` **Schematic** | The EasySchematic editor (upstream UI, unmodified), opened on the project's schematic: brink-merge's rows with the edit layer applied. Moves, renames, room changes and connections save as you work, under your Cloudflare Access email. They appear live in other open tabs, and are kept across re-imports. Below it: the read-only outline of the generated rows. |
| `/projects/:id/takeoff` **Takeoff** | Phase 3 placeholder (the OpenTakeoff canvas mounts here), plus the current import's source hashes. |

`/projects/:id` opens the BOM & Issues tab. The first dashboard's `/p/:id` links redirect.

> **Reads are protected only by Cloudflare Access on the route.** The Worker does not check who reads, so anyone who can reach it can read every project. Do not deploy it without Cloudflare Access in front.
>
> **Writes** (schematic edits) are different. The Worker verifies the Access JWT itself (signature against the team's certs, plus the AUD tag) and records the email. With Access not configured, it refuses every write.

```
browser ──GET /api/projects, /api/projects/:id, …/schematic──▶ Worker ──Hyperdrive (pg)──▶ Supabase Postgres
   │  └ editor frame (es-frame.html): EasySchematic           │   ▲
   │       └─POST …/schematic/edits (Cf-Access-Jwt-Assertion)─┘   │ brink_schematic_edits
   ├──WebSocket /api/projects/:id/live (rows, edits)──┐            │
   └──WebSocket /api/live (list "touch")──────────────┴──▶ RealtimeRelay (Durable Object)
                                                            │ ONE Supabase Realtime channel (service-role key)
                                                            └─ postgres_changes on the brink_* tables
```

## Stack

The shell uses EasySchematic's stack, so its editor mounts without a second toolchain:
- React 19
- Vite 8
- Tailwind 4 (through PostCSS, as EasySchematic does)
- TypeScript 5.9
- react-router 7 for the routes

The Worker serves the build (`dist/`) through its assets binding.
- The build has two pages: the app (`index.html`) and the editor frame (`es-frame.html`).
- Unknown paths fall back to `index.html` (single-page app).
- `/api/*` always reaches the Worker.

EasySchematic adds `@xyflow/react`, `zustand`, `html-to-image` and `jspdf`, pinned to the versions its lock file resolved at the vendored commit.

## How it works

- **Reads.** The Worker queries Postgres through the Hyperdrive binding (`pg`). Every read is a SELECT, inside one `READ ONLY, REPEATABLE READ` transaction per request.
  - A project snapshot reads `current_import_id` and that import's rows at the same moment.
  - The project list totals each project's current-import BOM in SQL. The sums are brink-merge's own (`finalizeBom` in `brink-merge/src/bom.ts`):
    - devices: the quantity on `device` lines
    - cables, net LF and order LF: from the `cable` lines
  - Error and warning counts come from `brink_issues`.
  - The cable count lives in the `line` jsonb. The server copies out only `cables` and `pulls`, so the blob is never sent.
- **Optional tables.** `brink_portal_pushes` comes from brink-merge's Portal push migration, which not every database has. `brink_schematic_edits` is treated the same way, for databases brink-merge has not migrated since Phase 1.
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
  - Edit-layer rows (`brink_schematic_edits`) are routed by project, not by import. The store hands them to the Schematic tab, which forwards them to the editor frame.

### The Schematic tab (Phase 2)

**Where the editor runs.** The editor is upstream EasySchematic, vendored unmodified in `vendor/easyschematic` (`vendor/PATCHES.md` has every change the app makes around it). It runs in its own frame (`web/es-frame.html`, `web/src/es/`), so it keeps the document it expects: its CSS, window shortcuts, `document.title` and store. The tab and the frame talk by `postMessage` (`web/src/lib/esBridge.ts`).

**Load.**
- The frame reads `GET /api/projects/:id/schematic`: brink-merge's rows with the project's active edits applied, by brink-merge's own `applyEdits`, which the Worker imports.
- It hands that file to EasySchematic's `importFromJSON`.
- After the editor settles, the frame takes a **baseline** snapshot. Loading writes nothing.

**Save** (`web/src/es/sync.ts`). The frame watches EasySchematic's store and turns differences from the baseline into edit-layer ops:

| Change in the editor | Op |
|---|---|
| A name | `rename` |
| A device moved into or out of a room | `room_assign` + `move` |
| A position, or a room's size | `move` |
| A takeoff cable removed | `disconnect` |
| A connection added | `connect` |
| An added connection removed | `revert` |

- Saves are debounced (700 ms, never mid-drag). `Ctrl/Cmd+S` saves at once.
- Positions are saved on EasySchematic's 16 px grid, as its own load snaps them.
- The status bar shows the save state and the editor's email.
- Anything the layer does not keep is listed as "will not be saved", with a Discard button, never dropped silently. That covers deleting a takeoff device, adding library devices, port or cable details, and manual routes.

**Write** (`POST /api/projects/:id/schematic/edits`, `src/schematic.ts`).
- The request is refused unless it is same-origin JSON from a **verified Access identity** (`src/access.ts`).
- One transaction holds the project row lock. Each op is shape-checked, then applied to the schematic with the earlier ops applied. An op that would orphan or conflict is refused.
- Each op carries `expect`: the active edit of its (target, kind) that the editor last saw. If someone else saved since, the op is refused as a **conflict**. The saved edit wins, and the editor reloads it and says so.
- A request built on an older import is refused with `409 { currentImportId }`, and the frame reloads.

**Live.**
- Saved edits reach other tabs through the existing relay. The frame re-reads the server render and patches only the targets that changed.
- A tab ignores rows carrying its own `client_ref` (its own echo).
- A re-import (`current_import_id` moves) reloads the editor on the new import, with the edits re-applied.

| Path | What it is |
|---|---|
| `src/index.ts` | Worker entry: the `/api` routes, then the static app |
| `src/access.ts` | Cloudflare Access JWT verification (RS256 against the team's certs, AUD, issuer, expiry), and the local-only dev bypass |
| `src/schematic.ts` | `GET …/schematic` (rows + edit layer) and `POST …/schematic/edits` (the edit-layer writes), using brink-merge's `src/edits.ts` |
| `src/api/router.ts` | Method + path router. A path served for another method answers 405 with `Allow`. |
| `src/db.ts` | Hyperdrive reads (project list with totals, snapshot, optional-table checks) |
| `src/relay.ts`, `src/realtime.ts` | `RealtimeRelay` Durable Object and its Supabase Realtime upstream |
| `src/shared/` | Table / column contract, routing and the change reducer, shared by the Worker and the page |
| `web/src/main.tsx` | Routes |
| `web/src/workspaces.ts` | The project tabs; later phases swap a placeholder for the real workspace here |
| `web/es-frame.html`, `web/src/es/` | The EasySchematic editor frame: mount, storage, save / live sync, module overrides |
| `vendor/` | Vendored EasySchematic, its lock (commit + hashes), `PATCHES.md`; `scripts/sync-easyschematic.mjs` re-syncs and checks it |
| `web/src/pages/`, `web/src/components/`, `web/src/lib/` | Pages, UI pieces, the live socket and the stores |
| `scripts/live-check.mjs` | Real-browser end-to-end check of the shell (Playwright); writes `docs/evidence/phase1/` |
| `scripts/es-check.mjs` | Real-browser end-to-end check of the Schematic tab (Playwright, two Access users); writes `docs/evidence/phase2/` |

**Schema.** brink-merge owns the schema (`brink-merge/supabase/migrations/`).
- Phase 2 added one table, `brink_schematic_edits`, in an additive migration (`20261027120000_brink_schematic_edits.sql`).
- The app writes only that table, and only through `POST …/schematic/edits`. Every other table is read-only to the app.

## API

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok, realtime }`, where `realtime` says whether the Supabase secrets are set |
| `GET /api/me` | `Me`: the verified Access identity (`{ email, auth }`), or `{ email: null, error }`. Always 200. |
| `GET /api/projects` | `{ projects: ProjectSummary[], features: { portalPushes }, readAt }` |
| `GET /api/projects/:id` | `Snapshot`: the current import's BOM, issues, schematic nodes and connections |
| `GET /api/projects/:id/schematic` | `SchematicView`: the EasySchematic file (rows + edit layer), the active edits, and the edits this import cannot carry |
| `POST /api/projects/:id/schematic/edits` | `EditResponse`. Body `{ importId, clientRef, ops: [{ kind, target, payload, expect } \| { kind: "revert", edit }] }`; one result per op: `saved`, `reverted`, `conflict` or `invalid`. 401 / 503 without an identity, 403 cross-origin, 415 not JSON, 409 on an older import. |
| `GET /api/projects/:id/live` | WebSocket: `status` and `change` messages |
| `GET /api/live` | WebSocket: `status` and `touch` messages |

The types are in `src/shared/protocol.ts`.

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
   - **To edit locally without Cloudflare Access**, also set `DEV_ONLY_ACCESS_BYPASS_EMAIL=you@example.com` in `.dev.vars`. Edits are then recorded under that email with `editor_auth = 'dev-bypass'`.
   - The bypass works only when Access is **not** configured (no `ACCESS_TEAM_DOMAIN`) **and** the request came in on a loopback host (`127.0.0.1`, `localhost`, `[::1]`). No deployed route has such a host, and a test fails if `wrangler.toml` ever names the variable.
   - Without the bypass or Access, the editor opens, but changes are not saved (the status bar says why).
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
6. **Browser checks** (Playwright):
   ```bash
   npm run live-check              # with `npm run dev` running: the shell; writes docs/evidence/phase1/; exits 1 on any failed check
   npm run es-check                # self-contained: the Schematic tab; writes docs/evidence/phase2/
   ```
   - `es-check` builds the app and starts its own `wrangler dev` with Cloudflare Access configured against a local stand-in team (an RSA key and its JWKS), so every save goes through real JWT verification.
   - It drives two browser contexts as two Access users. It starts from the generated schematic: it reverts the project's active edits and re-imports the fixture.

A plain Postgres without Supabase also works for reads. The header then shows "Realtime down", or "Realtime not configured" when the secrets are missing.

## Tests

```bash
npm run check                     # typecheck (worker, app, tests) + vitest + build
DASHBOARD_TEST_DATABASE_URL=postgres://… npm test   # also the read API over Hyperdrive, on a database brink-merge imported into
```

- **`test/access.test.ts`** covers the Access JWT checks against a local stand-in team (`test/access-keys.ts`):
  - signature, AUD, issuer, expiry and not-before
  - service tokens, `alg: none`, and key rotation
  - the dev bypass rules (loopback only, never with Access configured, never named in `wrangler.toml`)
- **`test/worker.test.ts`** starts the real Worker and Durable Object in workerd (`wrangler dev`), with Access configured against that stand-in team and the bypass variable also set. The relay points at a mock Supabase Realtime server (`test/mock-realtime.ts`). The test checks:
  - one upstream subscription, opened with the service key
  - routing per project and per import
  - re-pointing when `current_import_id` moves
  - coalesced `touch` messages, with no rows, on the list socket
  - closing the upstream when the last browser leaves
  - the read routes being GET-only (405 with `Allow`)
  - the write route refusing cross-origin, non-JSON and unidentified requests (with the bypass set, but Access configured)
  - `/api/me` against verified and refused tokens
  - the app shell served on client routes
- With a database, it also checks that the list's SQL totals equal the page's own totals and brink-merge's printed totals for the sample. It then writes edits through Hyperdrive:
  - saved under the Access email
  - a stale `expect` refused as a conflict
  - invalid targets refused
  - an older import refused with 409
  - a revert
- **`test/db.test.ts`** checks that `brink_portal_pushes` is queried only when it exists.
- **`test/shared.test.ts`** covers the reducer, routing (edits by project) and the projection.
- **`npm run check`** also runs `check:vendor`, which fails if any vendored EasySchematic file differs from the locked upstream commit without a recorded patch. It typechecks the vendored source with upstream's compiler options (`web/tsconfig.es.json`) together with the frame code and overrides.

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

## Evidence (Phase 2)

All of it is in `docs/evidence/phase2/`; `results.json` holds the `npm run es-check` run. It ran against local Supabase (database, Realtime and Kong), so live updates went through genuine Supabase Realtime. Every screenshot uses invented fixture data only.

| File | What it shows |
|---|---|
| `01-editor-loaded.png` | The Schematic tab with the EasySchematic editor on the sample project; the menu bar shows the Access email |
| `02-device-moved.png`, `02b-…` | A device dragged in the editor, saved as a `move` edit |
| `03-rename-in-device-editor.png` | Renaming the device in EasySchematic's own device editor |
| `04-renamed-saved.png`, `04b-…` | The rename saved ("All changes saved") |
| `05-second-tab-live.png`, `05b-…` | The second user's tab, which received both edits live |
| `06-after-reload.png` | After a reload, both edits persist |
| `07-after-reimport.png`, `07b-…` | After a re-import of the takeoff, the edits are still applied |
| `08-orphaned-edit-issue.png`, `08b-issues-panel.png` | The renamed device deleted from a copy of the takeoff and re-imported: the orphaned edits are warning issues in BOM & Issues |
| `09-editor-device-deleted.png`, `09b-…` | The editor without the deleted device; nothing else took its name |
| `10-device-restored.png`, `10b-…` | The original takeoff re-imported: the device and its edits are back |
| `11-phone-schematic.png` | Phone width (390 px) |

## Before any deploy (owner decisions)

Nothing in this repository deploys the app. Before a deploy, the owner needs to:

- **Access control.**
  - Put Cloudflare Access on the route; reads are not checked by the Worker.
  - Set the Worker vars `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag). Without them, every edit is refused.
  - Never set `DEV_ONLY_ACCESS_BYPASS_EMAIL` outside `.dev.vars`. A deployed Worker ignores it in any case: it is honoured only with Access unconfigured, on a loopback host.
- **Hyperdrive.** Run `wrangler hyperdrive create` against the Supabase session pooler or direct connection. Put the config id in `wrangler.toml` in place of the all-zero placeholder.
  - The role must be able to SELECT the brink tables. Since Phase 2 it also needs `INSERT` on `brink_schematic_edits`, and `UPDATE (superseded_at, superseded_by, reverted_at, reverted_by)` on it.
  - The tables have RLS with no policies, so the role must bypass RLS (or own the tables). brink-merge's migrations create no roles.
  - To show the Portal push status, the same role must also be able to read `pg_class` and `pg_publication_tables`.
- **Secrets.** Run `wrangler secret put SUPABASE_URL` and `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`. Local runs used the legacy service-role JWT; the new `sb_secret_…` keys have not been tried with Realtime here.
