# Agent playbook: OpenTakeoff takeoff to EasySchematic project

One agent drives two headless MCP servers. They hand off through files and never call each other.

| Server | Owns |
|---|---|
| `opentakeoff` | The takeoff: plan, scale, device markers, routes, cable runs |
| `brink` | The Brink BOM and the EasySchematic schematic, stored in Brink's database |

## Setup

Both servers are registered in the repository root `.mcp.json`.

**Division 27 verbs:** `link_run`, `list_runs`, `hold_devices` and the `cable_setup` / `role` options on `edit_condition` exist only on the fork branch `claude/div27-cable-setup-c6t9wu`. The published `opentakeoff-mcp` does not have them. Until that branch merges, point the `opentakeoff` entry at a checkout of it:

```json
"opentakeoff": { "command": "node", "args": ["<checkout>/mcp/node_modules/tsx/dist/cli.mjs", "<checkout>/mcp/server.ts"] }
```

**Database:** `brink` uses `DATABASE_URL` when it is set (local or hosted Supabase). Otherwise it uses a local PGlite database in `brink-merge/.data/pglite`.

## Flow

1. **Take off in `opentakeoff`.** Follow its server instructions:
   - `load_plan`, then `set_scale`
   - place device markers per device condition, and set `edit_condition { cable_setup }`
   - place TR markers under a `role: "tr"` condition, labeled with the TR name
   - trace routes under `role: "route"` conditions (trunk and branch)
   - `link_run` each device; `hold_devices` for devices that get no run by decision
   - check `list_runs`: every unlinked device and withheld run is a hole in the bid
2. **Export both files from the same session:**
   - `export_takeoff { path: "<job>.takeoff.json" }`
   - `export_report { path: "<job>.report.json" }`
   - The report is where cable lengths come from. A takeoff with cable runs and no report is refused.
3. **Import into `brink`:** `import_takeoff { takeoff_path, report_path, project }`. Read the issues it returns:
   - `unmapped_condition`: the finish tag has no catalog row. Propose one with `map_condition { ..., status: "proposed" }`; only Alexavier confirms.
   - `report_mismatch` or `route_lf_mismatch`: the two files came from different sessions or edits. Re-export both.
   - Warnings are OpenTakeoff's disclosures. Pass them to the estimator.
4. **Review:**
   - `bom` for the numbers: devices, cables (pulls, cables, net and order LF by cable type and TR), boxes, pathway, materials
   - `get_schematic` for the drawing
5. **Deliver:** call `export_bom { path, format: "csv" }` and `export_schematic { path }`, and give the user both paths. The schematic opens with EasySchematic's **Load**. Every cable connection carries its measured length, and the Cable Schedule and Pack List read from those.

## What the agent must not do

- **Invent or edit a quantity.** If a number is wrong, fix the takeoff in OpenTakeoff and re-export.
- **Confirm a mapping on its own.** `status: "confirmed"` needs the user's say-so.
- **Stitch sheets or estimate a length.** OpenTakeoff refuses both on purpose.
