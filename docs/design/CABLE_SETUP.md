# OpenTakeoff Division 27 Cable Setup — Design Spec

Oct 20, 2026 · @Alexavier · decisions recorded Oct 21, 2026 (see "Decisions" at the end; the plan in [CABLE_SETUP_PLAN.md](CABLE_SETUP_PLAN.md) carries the code check)

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

A point per TR with a name (MDF, IDF-1, TR-2) and the sheet it sits on. Stored as a count shape on a condition flagged `role: "tr"`, so it reuses existing placement, provenance and undo. **Decision:** the name is the shape's existing `label` field (the canvas label field and MCP `edit_shape { label }` set it); see the side effect under Decisions.

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

Pulls = count of linked runs. Cables = sum of cables across runs. Full precision is kept in storage and in Excel cells; rounding is display only. **As built:** a measured length is stored to 0.01 ft by the engine (every shape's `computed.perimeter_lf` is rounded at commit); the cable math keeps full precision from there. Route LF reads each segment's **plan** length (`plan_lf ?? perimeter_lf`): a segment that carries the engine's rise/drop legs (#441) is read without them, the run notes it, and the report, `list_runs` and the Cable summary row warn that the regular report's leg-inclusive LF for that condition is not a cable length. The condition's ×N multiplier applies to pulls, cables and cable LF together in the Cable summary; the Cable runs sheet stays unmultiplied and carries a Multiplier column.

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
- **Agent-made runs** land as pencil proposals, like any agent shape, and are treated in totals exactly as the engine already treats unaccepted agent shapes. **Verified:** unaccepted agent shapes COUNT in every total and are disclosed, never excluded; pending runs therefore count too, with a review status per run, a "Pending runs" column on the Cable summary and a pending-run count on the marked-set cover. Accepting a run does not accept its route segments; each keeps its own review status.
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
| Device EA | EA |
| Pulls | EA |
| Cables | EA |
| Measured route LF | LF |
| Cable LF (net) | LF |
| Cable LF (order, with waste) | LF |
| Unlinked devices | EA |
| Held devices | EA |
| Pending runs | EA |
| Runs over 295 ft | EA |

Device EA sits beside Pulls so an unlinked device shows as a gap, in addition to the Unlinked list; the gap is exactly unlinked + held devices. The by-TR subtotals sum to the totals: a condition with no linked run sits in a "(no TR — no linked run)" group. The cable tabs, columns and report blocks appear **only when a cable condition exists**, so a document that never used the feature exports byte-for-byte as before.

**Cable runs** (one row per run): run ID, condition, device type, cable type, TR, device sheet, route sheet(s), TR sheet, route LF, vertical, loop at device, loop at TR, per-cable LF, cables, location LF, multiplier, status (linked / withheld / broken with its reason), review status.

**In-app Report** shows the Cable summary table and an Unlinked list with a link that puts each item on screen.

**Marked set PDF** draws each route in its condition color with a chip showing run ID and per-cable LF, and adds pulls, cables and order LF per condition to the legend cover. **As built (Phase 3):** the chip reads `run ID · device condition · per-cable LF` with its border in the device condition's color, amber with `>295` over length and red with the status when withheld or broken; the run ID is the record id's first six hex digits, lengthened until unique. The same ID is printed beside the device marker, TRs print their names, unlinked devices get an amber ring and held devices a grey one, all placed clear of each other; a linked route's generic LF chip gives way to its run chips. The cover adds a line under each device condition (pulls, cables, net and order LF, unlinked and held), labels route and TR conditions, keys the marks and prints the cable warnings. A marked set with no cable work is byte-identical.

## MCP verbs

Reuse existing verbs wherever possible and add the minimum new ones; the repo's CI checks the tool count and inventory, so every addition updates that inventory in the same PR.

| Verb | New or extended | What it does |
| --- | --- | --- |
| `edit_condition` | Extended | Accepts `cable_setup`, mirroring `roll_setup`; accepts `role: "tr"` |
| `place_count` / `symbol_sweep` | Unchanged | Places device markers and TR markers |
| `measure_line` | Unchanged | Traces route segments |
| `link_run` | New | Takes device shape ID(s), ordered route shape IDs, TR ID, optional cable override; returns per-cable and location LF |
| `list_runs` | New | Runs with lengths, status, and the unlinked list |
| `unlink_run` | New | Removes a run or releases a hold; shapes stay |
| `hold_devices` | New (bid follow-up) | Records device locations that deliberately get no run, with the reason; excluded from totals, listed as held |
| `takeoff_summary` / `export_takeoff` / `export_report` | Extended | Include the cable summary and runs |

`link_run` refuses, with an actionable message, when a route ID is not a measured linear shape, a sheet is unscaled, the device condition lacks a required value, the TR ID is not a TR marker, or the device is already linked (one pull per location). An agent cannot submit a length; it can only link shapes that already carry measured geometry. A run whose route segment sits on a stitched surface (`stitch:<uid>`) survives MCP import → export → import with its stored length intact and is reported broken with a stated reason (stitches never round-trip through MCP), never dropped or zeroed.

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

## Decisions

Recorded from the plan review on Oct 21, 2026. The three spec decisions were left blank in the review reply and were taken at the plan's stated defaults; say so if any should flip.

- [x] **Access control door vertical.** Blank and required per job (the plan's default). Its runs are withheld with the stated reason until a vertical is entered.
- [x] **Shared trunk segments.** Allowed: one traced segment may belong to many runs (the plan's default; nothing in the data model prevents it and a refusal needs a rule not yet chosen). Route LF is counted per run, so a shared trunk's length appears in every run that uses it, which is the physical truth for cable. A wrong trunk is wrong for every run on it.
- [x] **Private fork or upstream.** Stay in the fork; no upstream push or PR either way until Alexavier says so.
- [x] **TR name field.** The shape's existing `label`. Side effect, documented in FEATURES.md: the Report's group-by-label view and the workbook's floor × room tab show a bucket per TR name carrying the TR condition's EA.
- [x] **×N multiplier.** Applies to pulls, cables and cable LF together in the Cable summary; the Cable runs sheet stays unmultiplied with a Multiplier column.
- [x] **Conditional tabs, columns and blocks.** Cable output appears only when a cable condition exists; old documents export byte-for-byte.
- [x] **Route LF.** Plan length only (`plan_lf ?? perimeter_lf`), legs ignored; a warning in the report, `list_runs` and the run note whenever a segment sits on a linear condition with nonzero rise or drop.
- [x] **Pending agent runs.** Count, as the engine counts pending shapes; "Pending runs" on the Cable summary, a pending-run count on the marked-set cover.
- [x] **MCP version.** 0.9.98 → 0.9.99 across all seven fields (the fork's CI guard).
- [x] **Undo.** Link and unlink are undoable; cable-setup field edits follow the condition editor's existing convention (not undoable), like roll goods.
- [x] **Branch.** `claude/div27-cable-setup-c6t9wu` on the fork.

Recorded from the Phase 1 review (Oct 21, 2026):

- [x] **Route conditions.** A linear condition flagged `role: "route"` (set with `edit_condition`, the same pattern as `role: "tr"`) holds the route segments. Every linear shape on a route condition that no linked run uses is reported unlinked; a line on any other condition (base, a transition, a wall) is never assumed to be a route. The earlier inferred rule is dropped. Linking stays by shape id.
- [x] **Cable setup over MCP.** A fresh opt-in or a device-type change keeps minting the device type's starting values for whatever the call does not state, and the `edit_condition` reply names every minted value under `cable.minted` with the note "starting values, not verified against spec". (The review left this choice blank; this is the less disruptive option and the canvas pre-fill in Phase 2 is unchanged either way.)
- [x] **Shared trunk segments.** Kept allowed. (Left blank in the review; unchanged from the plan default.)
- [x] **Stitched sheets in the canvas.** The Phase 2 Link Run tool links route segments on stitched surfaces: the library resolves a segment through the caller's scale answer, the canvas knows every stitch's scale, and `web/test/cable.test.ts` already proves a `stitch:<uid>` segment links there while the same run reads broken over MCP.

Recorded from the first real bid (Oct 27, 2026): the user asked for items 1–6 of the review to be fixed before Phase 3.

- [x] **By-TR subtotals sum to the totals.** A cable condition with no linked run sits in a no-TR group in `by_tr` and prints as "(no TR — no linked run)", so Device EA by TR reconciles (the bid read 103 against 111).
- [x] **Device and TR sheets on the runs sheet.** Columns *Device sheet*, *Route sheet(s)* and *TR sheet* replace the spec's single *sheet(s)*; JSON keeps `sheets` (the route sheets) and adds `device_sheets` and `tr_sheet`.
- [x] **Unconfirmed scale.** A linked run whose route sits on a sheet whose agent-set scale no person confirmed is flagged `scale_unconfirmed` with a note, and one warning names the sheets. It still counts; the scale gate is a flag, never a refusal. Every MCP `set_scale` lands unconfirmed, so every MCP takeoff warns until a person confirms in the canvas.
- [x] **Holds.** A record in `cable_runs` carrying `hold: { reason }` (no route, no TR) names device locations that deliberately get no run. Held devices are excluded from totals like unlinked ones and listed apart with the reason. A hold rides the run list so it reuses the load gate, import merge, undo family and protocol field. New MCP verb `hold_devices` (56 → 57 default tools); `unlink_run` releases a hold; the canvas holds from the Runs panel. An agent's hold lands pending.
- [x] **295 ft per cable.** `TIA_MAX_LINK_FT = 295` (TIA-568 copper permanent link, 90 m). A linked run over it counts, is flagged `over_length` with a note, and is named in one warning; the summary gains *Runs over 295 ft*. The check compares per-cable LF (route + vertical + loops) and is not medium-aware: the warning says fiber and coax are not bound by it rather than guessing from free-text `cable_type`.
- [x] **Device-type aliases.** `edit_condition` reads `access_control`, `card_reader`, `wireless_access_point`, `cctv`, `data_outlet`, `speaker` and a few others as the canonical type and says so in `cable.device_type_alias`; the document stores only the six types. An unknown name is refused with the list. One vertical per condition stays: devices with different verticals are separate conditions.
- [x] **Not done here:** splitting the branch LF of a shared trunk out of full-route polylines (it needs trunk segments traced as their own shapes, which the model already allows).

Recorded while building Phase 3 (Oct 27, 2026):

- [x] **Chip text and short run ID** as above; the full ID is in the Cable runs sheet.
- [x] **Device tags.** Not in the spec's sentence, added because the first bid traced pathway on the ceiling plan and devices on the comms plan, and nothing on paper connected the two.
- [x] **Generic route chips suppressed** for segments a run uses on that sheet; an unlinked route keeps its own chip.
- [x] **Route condition on the cover**: no "waste -> LF" allowance beside it, and a line saying it is pathway, not a cable quantity.
- [x] **Placement** is greedy against everything already placed (markers, TR names, tags, chips), trying points along each segment and beside it; with no room, the least-overlap point. Drawing text on the source sheet is not an obstacle.

Recorded while building Phase 2 (Oct 27, 2026), each within the spec's Canvas UI section:

- [x] **Link Run shortcut: `W`.** Checked against every binding in the app: A R L S C D ⇧D O K H N Y T G F Q M V and ? are taken, and P is deliberately unbound. W ("wire") was free.
- [x] **Device-type pick pre-fills waste only when the condition has none.** The spec's 12% starting waste is written when the condition's waste is 0; an estimator's existing waste is never overwritten.
- [x] **The cable opt-in is offered by what a condition holds.** Device types and Telecom room are offered on a condition with no area or linear shapes; Cable route on one with no area or count shapes; an empty condition is offered all three. (The app has no condition type field to read instead.)
- [x] **The TR name field lives in the Runs panel** (one per placed TR marker) and writes the marker's label through the existing, undoable label command.
- [x] **Accepting an agent-linked run** is a button on its row in the Runs panel (and Accept all), on the undo stack; it never touches the route segments' own review status.


Recorded while building item 3, the duplicate device check (Oct 27, 2026). The first real bid drew the same 14 cameras twice: camera outlets on the communications plan T3.1 and CAM markers on the security plan T4.1, one floor at one page size and scale. Both sets sat on cable conditions, so pulls, cable LF and price doubled with no warning; `scope_duplicates` compares floor-area polygons and cannot see count markers.

- [x] **A check, not a fix.** `web/src/lib/cableDupes.js` flags; it never merges, moves or deletes a marker and never changes a count. `computeCableTakeoff` carries its findings as `duplicates` and appends its warnings to the cable warnings, so they reach the Runs panel, the Report, CSV, the workbook, the marked-set cover, `list_runs`, `takeoff_summary` and `export_report` with no new path.
- [x] **Same sheet: 1.0 ft (`SAME_SHEET_DUP_FT`).** A device symbol is about 1/4" on paper (2 ft at 1/8" = 1'-0"); two clicks on one symbol, or a sweep's center and a click on its edge, land within half of it. Two real devices are not drawn that close: a two-gang location is one marker with its cable count, and back-to-back outlets sit either side of a wall. Feet are used only when the sheet's scale and page size are both known; otherwise the fallback is 0.35% of the sheet's long edge (`SAME_SHEET_DUP_NORM`, 1.0 ft at 1/8" on a 36" sheet), and the finding and the warning say which basis was used. Markers on two different cable conditions at one spot are flagged too, worded "CAM-1 + DATA-1".
- [x] **Overlay plans: page size within 1% (`PAGE_SIZE_TOL`), orientation included.** It absorbs page-box rounding and still separates ARCH D (36 × 24) from ANSI D (34 × 22, 5.5% off). When both sheets carry a scale they must agree within 1% (`SCALE_TOL`), so an enlarged plan on the same page size is not compared; a sheet with no scale does not block the comparison, since devices are counted without one.
- [x] **Position: 0.75% of the long edge (`OVERLAY_POS_TOL`).** That is 0.27" on a 36" sheet, about one device symbol, or 2.2 ft at 1/8": the same device drawn by two disciplines over one background lands within a symbol of itself. Matching is one-to-one, cable-to-cable pairs first, then nearest.
- [x] **Pattern: at least 3 positions and at least half of the smaller condition set (`OVERLAY_MIN_POSITIONS`, `OVERLAY_MIN_SHARE`).** One or two coincidences between dense sheets happen by chance (a card reader and a data outlet by the same door). The share is taken per condition on each sheet, not per sheet, so 14 cameras stay visible on a comms plan that also carries 200 data outlets. Findings group by condition pair: "T3.1 and T4.1 share 14 device positions: CAM-1 on T3.1 ↔ CAM-1 on T4.1 (14)"; a pair on different cable conditions says so ("two setups figure the same devices").
- [x] **A non-cable side is not a duplicate.** When one side of a coinciding pair sits on a condition with no cable setup, that is the fix already applied (a reference condition), so it is listed under `duplicates.reference` as detail and never warned.
- [x] **Where it runs.** The check runs when the caller supplies page geometry (`opts.sheetSize`). The MCP session knows every loaded sheet; the canvas knows every sheet rendered in this session (the open group's `panelImgs`, accumulated), so a sheet not yet opened is listed under `not_compared` instead of being guessed. A stitched surface is not loaded in MCP, so it is not compared there. A direct caller without `sheetSize` gets `duplicates: null`, and the report block and `takeoff_summary` carry `duplicates` only when there is a finding, so a cable takeoff with none exports as before.
- [x] **The fix stays with the estimator.** The warning tells them to move one sheet's set to a non-cable reference condition (MCP `edit_shape { condition }`, the canvas condition picker) when that sheet shows the devices for reference only, and to leave them when they are separate devices. An agent never deletes a marker on this alone.

Recorded while building item 5 (parts per cable and per pull, Oct 27, 2026):

- [x] **Two new materials bases, `cables` and `pulls`.** A supporting-materials row on a device condition can divide its linked cables (a jack or patch cord per cable: `per 1, basis cables`) or its linked pulls (a faceplate or camera mount per location: `per 1, basis pulls`). They are the Cable summary's figures (`cableByCondition`): ×N applied, `cables_override` honored, unlinked, held, withheld and broken devices excluded, pending runs counted like every pending shape. Quantities only; no price.
- [x] **No `cable_lf` basis.** The cable itself is already the Cable summary's net and order LF. A materials row on net cable LF would either print the same quantity twice or, for cable bought by the box, drop the waste, because no materials basis carries waste. Pathway hardware bought by length (J-hooks every N ft) belongs on the route condition's `linear` basis.
- [x] **Figured per device shape, like `seam_lf`.** `cableQtyByShape` puts each linked run's one pull and its cables on the run's first device marker, unmultiplied; `conditionTotals` sums them and applies ×N. The Report's by-sheet, by-label and floor × room slices therefore split the parts where the devices sit, and a condition's sum equals `cableByCondition`. The materials engine stays pure: the map is an input, beside the seam map, from every caller (canvas HUD and project roll-up, zone check, Report and its CSV/XLSX/JSON, MCP `takeoff_summary`, `export_report`, `edit_materials`).
- [x] **Honest zero with a reason.** A `cables` / `pulls` row on a condition with no cable setup, or with no linked run, reads 0 and its computed line carries `reason` (present only then, so every other line is byte-identical). The CSV and workbook print it in the Note cell and the Report in its by-finish line; a caller that hands in no cable takeoff says "not figured in this view" rather than blaming the runs. Revision diffs (`revisions.js`) and the contribution payload hand in neither seams nor cables, as before.
- [x] **Picker.** The basis picker offers **cable** and **pull** only on a condition with a cable setup, and keeps showing a row's basis if the setup is later removed (the row then reads 0 with its reason). The material library's picker shows them only on an entry promoted from such a row.
- [x] **`edit_materials` reply.** Gains `computed` (the condition's computed lines, the same math as `export_report`) only on a condition with a cable setup or a row on these bases, so every other reply is unchanged. The MCP tool count stays 57.
- [x] **Marked set.** It prints no materials, so nothing changes there.
