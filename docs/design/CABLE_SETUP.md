# OpenTakeoff Division 27 Cable Setup — Design Spec

Oct 20, 2026 · @Alexavier

## Purpose, scope and non-goals

Add an opt-in **cable setup** to OpenTakeoff count conditions so a Division 27 takeoff produces a per-run cable schedule: pulls, cables and cable LF by device type, from traced routes plus fixed vertical and service-loop allowances. It follows the same pattern as roll goods: an optional setup on a condition, a pure tested library, and new export columns.

**In scope for v1**

- Cable setup on count conditions (device type, cables per location, cable type, vertical and loop allowances)
- Telecom room (TR) markers as run origins
- Runs that link device location(s) to one or more traced route segments and a TR
- Per-cable and per-location LF math, pull and cable counts
- Report, CSV and Excel output; MCP verbs; canvas UI for setup and linking

**Not in scope**

- Pricing, labor units, markup. Quantities leave the tool; pricing stays in the bid workbook.
- Auto-routing or any length estimated from a footprint or routing factor
- Fiber backbone, conduit fill, pathway sizing, ladder rack
- One-Click Area or any change to the flood engine

All repo paths and behavior below come from the public README. Claude Code verifies each one against the actual code before building, and reports any mismatch.

## Estimating rules the feature must preserve

These are Brink Design's takeoff rules. The feature exists to apply them consistently; any design choice that breaks one is wrong.

1. **Measure, do not model.** Horizontal length comes only from traced route shapes. Modeling from a footprint with a routing factor ran 14% high against measured routes.
2. **No routing factor on a traced route.** The traced line already contains the dodge. The tool has no routing-factor field.
3. **Per cable = (measured route + vertical + service loops) × waste.** Vertical and loops are per-device-type constants set on the condition.
4. **Pulls are per location, not per cable.** Two cables to one box is one pull. The tool reports pulls and cables separately so the workbook can apply per-pull labor.
5. **Waste stays out of the measured number.** Matches OpenTakeoff's existing convention: waste applies only to the order quantity in the report.
6. **Withhold, don't guess.** An unlinked device or route is reported as unlinked and excluded from totals, never assigned a default length.

## Data model: cable setup, telecom rooms, runs

Three additions to the takeoff document: a `cable_setup` object on count conditions, a TR marker, and a run record. Documents without them load and export exactly as today.

### Cable setup (on a count condition)

| Field | Type | Notes |
| --- | --- | --- |
| `device_type` | enum | wall\_outlet, wap, camera, access\_door, ceiling\_other, custom |
| `cables_per_location` | integer ≥ 1 | Default per condition; a run can override |
| `cable_type` | string | Free text, e.g. a manufacturer part number; groups the cable summary |
| `vertical_ft` | number | Required; no silent default |
| `loop_device_ft` | number | Service loop at the device end |
| `loop_tr_ft` | number | Service loop at the TR end |

Waste uses the condition's existing waste % field. Lengths are stored in feet internally; the metric display toggle converts on display only, as it does today.

### Starting values offered in the UI

These pre-fill when a device type is picked. The project spec governs; every value is editable per job.

| Device type | Vertical (ft) | Loop at device (ft) | Loop at TR (ft) | Waste |
| --- | --- | --- | --- | --- |
| Wall outlet | 23 | 10 | 10 | 12% |
| WAP | 13 | 20 | 10 | 12% |
| Camera | 13 | 15 | 10 | 12% |
| Access control door | — | 15 | 10 | 12% |
| Other ceiling device | 13 | 10 | 10 | 12% |

Access control door vertical has no starting value and must be entered before that condition's runs count.

### Telecom room marker

A point per TR with a `name` (MDF, IDF-1, TR-2) and the sheet it sits on. Stored as a count shape on a condition flagged `role: "tr"`, so it reuses existing placement, provenance and undo.

### Run

| Field | Notes |
| --- | --- |
| `id` | Locally minted, stable across sessions |
| `device_shape_ids` | One location; usually one count marker |
| `route_shape_ids` | One or more linear shapes, in order; segments may sit on different sheets |
| `tr_id` | The TR marker this run homes to |
| `cables_override` | Optional; replaces `cables_per_location` for this location |
| `provenance` | Actor (person or agent), method, created and review status |

## Quantity math with worked examples

Each linked run produces one pull, its cable count, and a cable length built only from measured route plus the condition's allowances.

```latex
\text{route}_{LF} = \sum_{s \in \text{segments}} \text{length}_s \text{ (each at its own sheet scale)}
```

```latex
\text{per cable}_{LF} = \text{route}_{LF} + \text{vertical} + \text{loop}_{device} + \text{loop}_{TR}
```

```latex
\text{location}_{LF} = \text{per cable}_{LF} \times \text{cables} \qquad \text{order}_{LF} = \text{location}_{LF} \times (1 + \text{waste})
```

Pulls = count of linked runs. Cables = sum of cables across runs. Full precision is kept in storage and in Excel cells; rounding is display only.

### Worked examples (these become unit tests)

| Run | Route LF | Vertical | Loops (dev + TR) | Per cable LF | Cables | Location LF | Order LF at 12% |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wall outlet | 87.5 | 23 | 10 + 10 | 130.5 | 2 | 261.0 | 292.32 |
| Camera | 140.0 | 13 | 15 + 10 | 178.0 | 1 | 178.0 | 199.36 |
| **Total** |  |  |  |  | **3** | **439.0** | **491.68** |

That sample is 2 pulls and 3 cables. Additional required test cases: a route split across two sheets at different scales; a recalibration that changes one segment; an unlinked device and an unlinked route (both excluded and listed); an access control door condition with no vertical entered (runs withheld with a stated reason).

## Multi-sheet, scale and provenance behavior

Runs inherit the engine's existing scale gate and provenance rules; nothing here relaxes them.

- **Scale.** Route segments on an unscaled sheet refuse to link, with the engine's existing refusal message. Recalibrating a sheet updates every run that uses a segment on it.
- **Stitched sheets.** A route traced across a stitched match line is one segment, as today.
- **Unstitched sheets.** A run may list segments from several sheets (a device on the second floor homing to a first-floor TR). Each segment is measured at its own sheet's scale. The engine's rule that one trace can't span two grouped sheets stays in force.
- **Device and TR on different sheets.** Allowed; the link is by ID, not by geometry.
- **Agent-made runs** land as pencil proposals, like any agent shape, and are treated in totals exactly as the engine already treats unaccepted agent shapes (verify which that is). Accepting a run does not accept its route segments; each keeps its own review status.
- **Deleting a linked shape** marks the run broken and lists it as unlinked. It never silently drops the run or its length.

## Report and export output

The Excel export gains two sheets built for a bid workbook to reference directly; CSV and JSON carry the same data.

**Cable summary** (one row per device condition, subtotaled by TR and by cable type)

| Column | Unit |
| --- | --- |
| Condition | — |
| Device type | — |
| Cable type | — |
| TR | — |
| Pulls | EA |
| Cables | EA |
| Measured route LF | LF |
| Cable LF (net) | LF |
| Cable LF (order, with waste) | LF |
| Unlinked devices | EA |

**Cable runs** (one row per run): run ID, condition, device type, cable type, TR, sheet(s), route LF, vertical, loop at device, loop at TR, per-cable LF, cables, location LF, review status.

**In-app Report** shows the Cable summary table and an Unlinked list with a link that puts each item on screen.

**Marked set PDF** draws each route in its condition color with a chip showing run ID and per-cable LF, and adds pulls, cables and order LF per condition to the legend cover.

## MCP verbs

Reuse existing verbs wherever possible and add the minimum new ones; the repo's CI checks the tool count and inventory, so every addition updates that inventory in the same PR.

| Verb | New or extended | What it does |
| --- | --- | --- |
| `edit_condition` | Extended | Accepts `cable_setup`, mirroring `roll_setup`; accepts `role: "tr"` |
| `place_count` / `symbol_sweep` | Unchanged | Places device markers and TR markers |
| `measure_line` | Unchanged | Traces route segments |
| `link_run` | New | Takes device shape ID(s), ordered route shape IDs, TR ID, optional cable override; returns per-cable and location LF |
| `list_runs` | New | Runs with lengths, status, and the unlinked list |
| `unlink_run` | New | Removes a run; shapes stay |
| `takeoff_summary` / `export_takeoff` / `export_report` | Extended | Include the cable summary and runs |

`link_run` refuses, with an actionable message, when a route ID is not a measured linear shape, a sheet is unscaled, the device condition lacks a required value, or the TR ID is not a TR marker. An agent cannot submit a length; it can only link shapes that already carry measured geometry.

## Canvas UI

The UI lives in new component files; edits to `TakeoffCanvas.jsx` are limited to mounting points and event wiring.

1. **Cable setup panel** in the condition editor, shown for count conditions: device type picker (pre-fills the starting values), cables per location, cable type, vertical, both loops. Required fields left empty show inline.
2. **TR flag** on a condition, plus a name field on each placed TR marker.
3. **Link Run tool:** click the device marker, click route segment(s) in order, click the TR, press Enter. Live readout shows route LF and per-cable LF before commit. Shortcut key chosen after checking the existing shortcut map for conflicts.
4. **Runs panel** (docked like the Roll panel): runs grouped by condition with per-cable LF, plus the Unlinked list; clicking an item puts it on screen.
5. **On-canvas cue:** linked routes draw in the condition color; unlinked devices and routes get a visible marker so they're caught before export.

Every action is on the undo stack.

## Architecture, testing and phasing

All cable math lives in one pure library with no React or DOM, imported by both the canvas and the MCP server, the same way `rollgoods.js` and `oneclick.ts` are shared today.

**Architecture**

- `web/src/lib/cable.ts` (or `.js`, matching `rollgoods.js`): run resolution, per-cable and location math, summary rollups, unlinked detection
- Takeoff document schema: new optional fields only; old documents round-trip unchanged
- Protocol draft (`protocol/`): add the cable setup and run records if the repo expects record changes documented there
- UI in new components; minimal `TakeoffCanvas.jsx` changes

**Testing (all must pass `npm run check`)**

- Unit tests for every case in the worked-examples section
- Export → import round trip with runs, on a clean load
- MCP tests for each new or extended verb, including each refusal
- `web/bench/results.json` unchanged (this feature must not move One-Click numbers)
- `node scripts/check-doc-links.mjs` passes after doc updates
- No real construction plans committed; test fixtures are invented

**Phasing (stop for review after each)**

1. **Headless:** library, schema, MCP verbs, CSV/Excel/JSON export
2. **Canvas:** setup panel, TR flag, Link Run tool, Runs panel
3. **Marked set:** route chips and legend totals

Work happens on a branch in a private fork. Nothing is pushed upstream or opened as a PR without Alexavier's go-ahead.

## Open decisions for Alexavier

Three calls change what gets built; everything else in this spec is settled.

- [ ] **Access control door vertical.** Enter a starting value, or keep it blank and required per job.
- [ ] **Shared trunk segments.** Allow one traced segment to belong to many runs (trace a corridor trunk once, branch to each device), or require one full route per location as in the current Bluebeam method. Shared segments save tracing; they also make a wrong trunk wrong for every run on it.
- [ ] **Private fork or upstream.** Keep it in a private fork, or open an RFC issue with the maintainer first and contribute it back under their CLA.
