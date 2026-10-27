# brink-merge

Internal Brink Design tool. It is never distributed and never shown to clients.

brink-merge turns a finished OpenTakeoff Division 27 takeoff into two things:
1. **A priced-ready BOM:** device lines, measured cable footage, box and reel counts, pathway LF and supporting materials, every line tagged with where it came from.
2. **An EasySchematic project file** that opens with the devices and their cable connections already placed, each connection carrying its measured length.

The system of record is Postgres (Supabase), not a file. The EasySchematic file is rendered from those rows. A headless MCP server lets an agent drive the whole thing, the same way it drives an OpenTakeoff takeoff.

```
OpenTakeoff MCP / canvas
   export_takeoff  -> job.takeoff.json   (conditions, shapes, cable_runs)
   export_report   -> job.report.json    (cable math: per-run LF, summary, boxes)
        |
        v
brink-merge  (CLI, or the brink MCP server)
   rollup by condition -> join the Brink catalog map -> BOM + EasySchematic schematic + issues
        |                                         |
        v                                         v
   Postgres / Supabase (system of record)   bom.csv / bom.json, schematic.json (EasySchematic Load)
```

**Seams:**
- brink-merge does not import OpenTakeoff or EasySchematic code at runtime.
- EasySchematic's file types are vendored in `src/vendor/`. The enum lists and `CURRENT_SCHEMA_VERSION` are generated from a checkout by `scripts/vendor-es.mjs`, which also records the source commit.

## Rules it keeps

- **Fail loudly, never drop silently.**
  - An unmapped condition, an invalid EasySchematic enum, or a report that does not belong to its takeoff becomes an **error** on the BOM, and the CLI exits 1. The quantities stay on the BOM.
  - OpenTakeoff's own disclosures become **warnings**: unlinked or held devices, over-length runs, agent runs nobody accepted, unconfirmed scale.
- **Trust OpenTakeoff's numbers.**
  - Counts and LF come from each shape's stored `computed` block.
  - Cable lengths come from OpenTakeoff's per-run cable math in `export_report` (route plan LF + vertical + loops, × cables).
  - brink-merge recomputes nothing from geometry. It only cross-checks each run's route LF against the takeoff's stored shape lengths.
- **Waste never touches measured numbers.** Net and order quantities are reported separately.

Field details and the join-key decision are in [docs/div27-conditions.md](docs/div27-conditions.md).

## Install

Requires Node 22+.

```bash
cd brink-merge
npm install
```

## CLI

```bash
node bin/brink-merge.mjs job.takeoff.json --report job.report.json \
  --map data/catalog-map.json --out job.schematic.json --bom bom.csv [--bom-json bom.json] \
  [--project "Job name"] [--db] [--db-url postgres://...] [--strict]
```

**Exit codes:**
- `0`: written, no errors
- `1`: written, but the BOM carries errors (with `--strict`, warnings count too)
- `2`: bad usage or unreadable input

**Persisting with `--db`:** the run is saved to the database, chosen in this order:
1. `--db-url`
2. `DATABASE_URL`
3. local PGlite (`BRINK_PGLITE_DIR`, or in memory)

When persisting, the database's catalog map wins over `--map`. Rows from the file that the database lacks are added, and edited rows are never overwritten.

On `fixtures/div27-sample`:
```
Brink Div 27 sample (invented): 16 devices, 2 TR(s), 14 pulls, 23 cables, 1795.13 LF net / 2007.79 LF order
wrote job.schematic.json (18 device nodes, 23 connections), bom.csv
...
0 error(s), 14 warning(s)
```

## The brink MCP server (headless)

```bash
node bin/brink-merge-mcp.mjs     # stdio; DATABASE_URL or BRINK_PGLITE_DIR picks the database
```

The repository root `.mcp.json` registers `opentakeoff` and `brink` side by side. [docs/agent-playbook.md](docs/agent-playbook.md) walks an agent from takeoff to schematic.

| Tool | What it does |
|---|---|
| `import_takeoff` | Takes an OpenTakeoff export and report. Produces the rollup, BOM and schematic, stored as the project's current import, and returns totals and every issue. |
| `bom` | BOM lines (issues left out) |
| `list_issues` | Errors and warnings for the current import |
| `catalog` | The Brink catalog map |
| `map_condition` | Add or change one mapping (EasySchematic enums are validated), then re-merge every project |
| `get_schematic` | Compact view: rooms, devices, connections with lengths |
| `export_schematic` | Writes the EasySchematic file, rendered from the database |
| `export_bom` | Writes the BOM as CSV or JSON |
| `list_projects` | Projects and their current import |

## Database (Supabase / Postgres)

The schema is in `supabase/migrations/`. It is applied automatically by the CLI (`--db`) and by the MCP server.

**Tables:**

| Table | Holds |
|---|---|
| `brink_projects` | One row per project, pointing at its current import |
| `brink_imports` | The raw OpenTakeoff files, with their sha256 hashes |
| `brink_catalog_map` | The Brink catalog map |
| `brink_bom_lines` | BOM lines |
| `brink_issues` | Issues |
| `brink_schematics`, `brink_schematic_nodes`, `brink_schematic_connections` | The schematic, one row per node and per connection; `cable_length_ft` is the measured per-cable LF |
| `brink_schematic_edits` | People's edits to the schematic (moves, renames, room changes, connections), kept as a layer over every import and keyed by ids that survive a re-import; see [docs/schematic-edits.md](docs/schematic-edits.md) |

**Access:** every table has row-level security on and no policies, so only the service role can read or write.

**Realtime:** the tables join the `supabase_realtime` publication when it exists, ready for the combined OpenTakeoff + EasySchematic dashboard.

**Ways to run it:**
- **Local Supabase:** `npx supabase start` from `brink-merge/` (needs Docker). Then use `--db-url postgres://postgres:postgres@127.0.0.1:54322/postgres`.
- **Plain Postgres:** any database URL works, for example `postgres://brink:brink@localhost:5432/brink`.
- **Hosted Supabase (later):** put the project's service-role connection string in the environment as `DATABASE_URL` (Settings → Database). Nothing else changes.
- **No setup:** PGlite (Postgres compiled to WASM, in process) is the default, in memory or in `BRINK_PGLITE_DIR`.

## Catalog map

`data/catalog-map.json` has one row per OpenTakeoff condition, keyed on the finish tag:

```json
{ "conditionKey": "DATA-1", "kind": "device", "esDeviceType": "wall-plate",
  "esTemplateRef": { "manufacturer": null, "modelNumber": null }, "label": "Data outlet, 2-port keystone",
  "port": { "signalType": "ethernet", "connectorType": "rj45", "rearConnectorType": "punch-down-110" },
  "cableType": "CAT6A CMP", "portalSku": null, "status": "proposed" }
```

- **`kind`** is one of `device` (cable_setup), `tr` (role tr), `route` (role route) or `plain`. It must agree with the condition.
- **`esDeviceType`, `signalType` and connector types** must be EasySchematic's own values.
- **`portalSku`** is reserved for the Portal push and stays null.
- **`status`:** the seeded rows are `proposed` until Alexavier confirms them.

## What the EasySchematic file contains

- **Templates:** one custom template per mapped model (`customTemplates`).
- **Devices:** one device node per counted unit. A ×N multiplier is drawn as N labeled copies.
- **Patch panels:** one per TR marker, with one port per cable homed there.
- **Connections:** one per cable of every linked run, running from the device to the TR's patch panel.
  - `cableLength` is OpenTakeoff's measured per-cable LF, in EasySchematic's own `"76.3 ft"` format.
  - The OT `cable_type` is the line label.
- **Rooms:** taken from the takeoff's shape labels; each TR gets its own room.
- **Layout:** a plain grid. Placement at real plan coordinates is Stage 1b.
- **Issues note:** a note node lists the issues.

Devices with no linked run (unlinked or held) are drawn with no cable. Devices that cannot be drawn (unmapped) are listed in the note and the issues.

## Tests

```bash
npm run check                    # tsc + vitest (PGlite)
BRINK_TEST_DATABASE_URL=postgres://...empty-db npm test   # also against a real Postgres / local Supabase
ES_DIR=/path/to/EasySchematic npm test                     # also prove the vendored ES enums are current
```

Fixtures are real OpenTakeoff exports written by the Division 27 engine. [fixtures/generate/README.md](fixtures/generate/README.md) has the commit and the commands.

**Re-vendoring EasySchematic after an upstream update:**

```bash
node scripts/vendor-es.mjs --es /path/to/EasySchematic   # rewrites src/vendor/esEnums.generated.ts
```

**Checking that a file opens in the real EasySchematic** (starts its Vite dev server and loads the file through the app's Load input):

```bash
node scripts/es-open-check.mjs --es /path/to/EasySchematic --file job.schematic.json --out evidence/
```

## Not in this stage

- Real-coordinate placement (1b)
- Portal push (`portalSku` is reserved)
- Live mirroring into an EasySchematic tab
- The combined dashboard website
