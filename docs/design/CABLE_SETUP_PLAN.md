# Division 27 cable setup — implementation plan

Companion to [CABLE_SETUP.md](CABLE_SETUP.md), which governs. This page records
what the code actually does today against each assumption the spec makes, the
decisions the mismatches force, and the exact file list for Phase 1. Written
2026-10-21 against fork commit `18c1f1d` (MCP source 0.9.98, 53 default tools).

Legend: **CONFIRMED** = the code does what the spec assumes. **DIFFERENT** =
the code does something else; the "Plan" column says what Phase 1 does about it.

## 1. Spec assumptions checked against the code

### 1.1 The roll-goods pattern (what the spec says to copy)

| Spec assumption | Status | What the code does |
|---|---|---|
| Roll goods is an optional `roll_setup` object on a condition; presence is the opt-in | CONFIRMED | `web/src/lib/rollTakeoff.js` `hasRollSetup` (object with `roll_width_ft > 0`; corrupt payloads read as opted out). Canvas opt-in select in `web/src/components/TakeoffsPanel.jsx:560-590`; MCP in `mcp/src/session.ts` `applyConditionKnobs`. |
| One pure library shared by canvas and MCP | DIFFERENT (two modules) | Roll goods is **two** pure modules: the engine `web/src/lib/rollgoods.js` (rings in feet) and the bridge `web/src/lib/rollTakeoff.js` (shapes/conditions → engine, report rows). Both are DOM-free and imported by `mcp/src/session.ts:66-67`. **Plan:** cable gets ONE module, `web/src/lib/cable.js`, holding both halves (defaults, sanitize, run resolution, math, rollups, unlinked detection, export rows). |
| Report/CSV/Excel columns for roll goods | CONFIRMED | `rollColProfile` in `web/src/lib/reportColumns.js:244` adds "Roll Order LF / Rolls / Seam LF" to the Conditions table, CSV and the workbook Conditions tab **only when some condition figures a layout** (so a project without roll goods exports byte-identically). `rollReportRows` (`rollTakeoff.js:138`) feeds the `roll_goods` array of `opentakeoff.report.v1` (`totals.js` `reportJson`), which is always emitted (empty array). |
| `roll_setup` on `edit_condition`, reply echoes the figured order | CONFIRMED | `mcp/src/tools.ts:517-541` (zod union: `null` opts out, object patches), `session.ts` `editCondition` + `applyConditionKnobs` (fresh opt-in mints defaults, same-material partial edits patch), journal op `condition` snapshots `before.roll_setup`, `undo_last` restores it. Output schema `editConditionOutput` in `mcp/src/outputs.ts:770`. |
| Roll goods tests | CONFIRMED | `web/test/rollgoods.test.ts`, `web/test/rollTakeoff.test.ts`, `web/test/seamLf.test.ts`; MCP in `mcp/test/tools.test.ts` and `conformance.test.ts` (`roll_goods` always `[]` without a setup). |
| Templates / profiles deep-copy `roll_setup` | CONFIRMED | `web/src/lib/canvasUtil.js:68` and `TakeoffCanvas.jsx:8374` copy it into condition templates. **Plan:** `cable_setup` and `role` copied the same way (one line each), Phase 2. |

### 1.2 Data model

| Spec assumption | Status | What the code does |
|---|---|---|
| Count conditions exist; device markers are count shapes | CONFIRMED | `measure_role: "count"`, `verts_norm: [[x, y]]`, `computed: { count: 1 }` — canvas `commitCount` (`TakeoffCanvas.jsx:5139`), MCP `placeCount` (`session.ts:2972`). No scale needed. |
| Conditions have a waste % field | CONFIRMED | `waste_pct` on every condition; `conditionTotals` applies it to SF and LF only, never EA (`totals.js:67-110`). Cable order LF will apply `waste_pct` inside `cable.js`. |
| Lengths stored in feet; metric converts on display | CONFIRMED | `web/src/lib/units.ts`; report columns convert through `applyUnits` + the `COL_DIM` map (`reportColumns.js:94-99`). New cable columns register in `COL_DIM` as `len`. |
| A condition can carry `role: "tr"` | CONFIRMED (field is free) | No condition field named `role` exists (the only `role` is `measure_role` on shapes). Canvas hydrate passes unknown condition keys through untouched (`sanitizeConditionAttrs` only rewrites `attrs`). MCP `Condition` interface (`session.ts:189-212`) is typed; `role?: "tr"` and `cable_setup?` get added. |
| TR marker has a `name` | DIFFERENT (no `name` field) | Shapes have no `name`. They DO have `label` (`Shape.label`, the per-room label the Report groups by; set in the canvas label field and by MCP `edit_shape { label }`, which accepts count shapes). **Plan:** the TR name IS `shape.label`. Zero new UI or MCP surface for naming. Side effect: a TR named "MDF" also appears as a "MDF" bucket in the Report's group-by-label view and the workbook's floor × room tab, carrying the TR condition's EA. Alternative if you dislike that: a dedicated `tr_name` field on the shape (needs its own edit path in Phase 2 and an `edit_shape` extension). **Decision for you — default: `label`.** |
| Runs are a new record family in the takeoff document | CONFIRMED (additive key) | The document writer `web/src/lib/takeoffDocument.js` is the one envelope (canvas autosave, file export, MCP `exportPayload`). Additive keys are omitted when empty (`stitches`, `approvals`, `rules` precedent), so old documents round-trip byte-for-byte. **Plan:** new top-level `cable_runs` array (see §3). |
| Run `id` locally minted, stable | CONFIRMED | `mintUuid` in `web/src/lib/provenance.js` (canvas) and the identical fallback in `session.ts:76-83` (MCP). Runs mint `run-<uuid>`. |
| Run `provenance` (actor, method, created, review status) | CONFIRMED vocabulary | Shapes carry `origin: { method, actor?, reviewed? }` + `created_at` + `author?`. Runs use the spec's field name `provenance` with the same vocabulary: `{ method: "manual", actor?: "agent", reviewed?: false, created_at, author? }`. |
| Full precision kept in storage | DIFFERENT (0.01 ft) | Every shape's `computed.perimeter_lf` is `toFixed(2)` at commit (`shapeMetrics.js:65`, `session.ts linearQty`). Measured route LF is therefore stored to 1/100 ft, not full float. Cable math keeps full precision from there on (no rounding until display/CSV `round2`), and Excel cells carry the unrounded cable numbers. The worked examples (87.5, 140.0) are exact in 0.01 ft, so the tests are unaffected. |

### 1.3 Quantity math inputs

| Spec assumption | Status | What the code does |
|---|---|---|
| Route LF = Σ length of linear shapes, each at its own sheet scale | DIFFERENT (verticals, #441) | A linear shape's `computed.perimeter_lf` is the TOTAL `plan + rise + drop` (Drop and Rise, #441): the condition's `rise_ft`/`drop_ft` defaults or the run's own legs. `computed.plan_lf` rides only when a vertical exists. **Plan:** route LF reads `plan_lf ?? perimeter_lf` (the plan trace only), so a route segment traced on a condition that carries rise/drop does NOT double-count a vertical against the cable setup's `vertical_ft`. A run whose segment carries legs is disclosed in its `notes` ("segment X carries 8 ft of rise/drop legs, ignored; vertical comes from the cable setup"). |
| Vertical, loops are per-condition constants; `vertical_ft` required | CONFIRMED (new) | Validation lives in `cable.js` `cableSetupProblems(setup)`: `device_type` in the enum, `cables_per_location` integer ≥ 1, `vertical_ft` finite ≥ 0, both loops finite ≥ 0. A condition whose setup has a problem withholds every run with the stated reason (the access-control-door case). |
| Pulls = linked runs; Cables = Σ cables | CONFIRMED (new) | EA (device count) stays the condition's existing `ea`; pulls and cables are new figured quantities beside it, the roll-goods precedent (order LF beside measured SF). |
| ×N multiplier | NOT IN SPEC | Every reported quantity applies the condition's `multiplier` (roll goods: "N identical units are N cuttings"). **Plan:** pulls, cables and cable LF are ×N in the summary rows; the per-run sheet stays unmultiplied (like per-shape exports). Flagging so you can veto. |
| Waste on the order quantity only | CONFIRMED | `cable_lf_order = location_lf × (1 + waste_pct/100)`; `cable_lf` (net) and route LF never carry waste. |

### 1.4 Scale, sheets, provenance, deletion

| Spec assumption | Status | What the code does |
|---|---|---|
| A route on an unscaled sheet refuses to link with the engine's message | CONFIRMED (gate exists) | MCP `measure_line` already refuses on an unscaled sheet (`session.ts:1859`, `scaleGate` message "… has no scale — call set_scale first …"); the canvas Linear tool refuses with "Set the scale for {sheet} first." (`TakeoffCanvas.jsx:4933`). A linear shape can still ARRIVE on an unscaled sheet by import, so `link_run` re-checks the sheet's `units_per_px` and refuses with the same `scaleGate` text. |
| Recalibrating updates every run on that sheet | CONFIRMED (by construction) | `recalibrateShapes` (`shapeMetrics.js:97`) rewrites `shape.computed` for the sheet; runs store NO lengths (they reference shape ids and are resolved at read time), so every reader sees the new length with nothing to update. The "recalibration changes one segment" test asserts exactly this. |
| Stitched sheets: one trace across the match line is one segment | CONFIRMED | A shape on a composite has `sheet_id = "stitch:<uid>"`; one shape. Note MCP omits stitches from export (`protocol/COMPATIBILITY.md`), unchanged. |
| One trace cannot span two grouped (unstitched) sheets | CONFIRMED | Shapes bind to one panel key at commit. |
| Device and TR on different sheets | CONFIRMED | Links are by shape id; nothing geometric. |
| Agent-made shapes land as pencil proposals | CONFIRMED | `commit()` stamps `origin.reviewed = false` on every agent commit (`session.ts:1455`); the canvas renders `reviewed === false` dashed and offers Accept. |
| Unaccepted agent shapes are "treated in totals exactly as the engine already treats them" | **VERIFIED: they COUNT** | `conditionTotals` never reads `origin.reviewed` (`totals.js:67-110`). Pending shapes are included in the Takeoffs-panel chips, the Report, CSV, XLSX, `report.v1`, `takeoff_summary` and the marked-set legend. What the engine does instead of excluding them is DISCLOSE: the canvas Accept pill and "Work · N" counter, `list_shapes.reviewed`, the marked-set cover's provenance split and "pending review" wording, `import_takeoff`'s `shapes_pending`. **Plan:** agent-made runs (`provenance.reviewed: false`) count in every cable total and are disclosed the same way: `review_status` column on the Cable runs sheet, a `pending` count in the Cable summary and in `list_runs` / `takeoff_summary`. |
| Accepting a run does not accept its route segments | CONFIRMED (separate records) | Shape review is the `review` shape command; runs carry their own `provenance.reviewed`. Phase 2 wires a run accept separate from the shape Accept pill. |
| Deleting a linked shape marks the run broken, never drops it | CONFIRMED (by construction) | Neither the canvas `delete` command nor MCP `delete_shape` cascades to referencing records (reconciled cutouts are left orphaned the same way, disclosed). The run record is untouched; resolution reports `status: "broken"` with `reason: "route shape shp-… was deleted"` and lists it under Unlinked. No hook into delete needed. |
| Every canvas action is on the undo stack | DIFFERENT for condition edits | Shape mutations go through `web/src/lib/shapeCommands.js` (undoable). Condition field edits (`updateCond`, `setCondParam`, `TakeoffCanvas.jsx:7815/7970`) write `setConditions` directly and are NOT undoable today; neither are `roll_setup` edits. Approval seals are undoable through family-tagged entries (`approvals.js`). **Plan (Phase 2):** link/unlink run are undoable through family-tagged entries (the approvals precedent); cable-setup field edits follow the condition editor's existing non-undoable convention, same as roll goods. Flagging the gap against the spec's "every action". |

### 1.5 Export, report, MCP

| Spec assumption | Status | What the code does |
|---|---|---|
| Excel gains two sheets | DIFFERENT (fixed-tab convention) | `reportWorkbook` (`xlsx.js:160`) keeps "a fixed tab list so a consumer never has to test for a sheet's existence" (five tabs, the floor × room tab is emitted even when empty). Always adding two tabs would change every existing project's workbook. **Plan:** your byte-for-byte rule wins: "Cable summary" and "Cable runs" tabs are appended only when at least one condition carries a `cable_setup` (the roll-column precedent). |
| CSV and JSON carry the same data | CONFIRMED (additive sections) | `totalsToCsv` appends sections conditionally (materials, by-sheet, by-label); the CSV golden (`web/test/report-csv-golden.test.ts`) pins the no-cable output and stays green. `reportJson` is additive-only; `roll_goods` was added as always-emitted (which changed every export once). **Plan:** the report.v1 `cable` block is emitted only when a cable condition exists (the `proposed_condition_edits` precedent), so `web/test/totals.test.ts:134`'s key pin and old exports stay byte-identical. |
| In-app Report shows the Cable summary + Unlinked list | CONFIRMED feasible | `ReportPanel.jsx` already receives `rollByCond` from the canvas; a `cableTakeoff` prop goes in the same way. UI table is Phase 2; Phase 1 only wires the three export handlers (`exportCsv`, `exportJson`, `exportXlsx` at `ReportPanel.jsx:326-338`), which is wiring, not UI. |
| `edit_condition` extended, `place_count` / `symbol_sweep` / `measure_line` unchanged | CONFIRMED | `symbol_sweep` commits through `placeCount` (`session.ts:3153`), so swept devices are ordinary count shapes. |
| New verbs `link_run`, `list_runs`, `unlink_run`; CI checks tool count and inventory | CONFIRMED | `mcp/scripts/check-tool-count.mjs` rewrites `<!--tool-count-->` markers in ten docs and `check-tool-inventory.mjs` regenerates `docs/MCP_TOOL_INDEX.md` and requires one `mcp/README.md` table row per tool. `mcp/src/staging.ts` `TOOL_STAGES` must partition the set (`staging.test.ts`). Counts go 53 → 56 default, 55 → 58 with the One-Click gate lifted, setup stays 11. |
| `takeoff_summary` / `export_takeoff` / `export_report` extended | CONFIRMED | `export_takeoff` is `exportPayload()` → `buildTakeoffDocument` (gets `cable_runs` for free once the writer knows the key). `export_report` is `reportJson` (gets the `cable` block). `takeoff_summary` gets an optional `cable` block; `takeoffSummaryOutput` in `outputs.ts` is `.passthrough()`-friendly but gets the field declared. |
| CI version guard | NOT IN SPEC | `.github/workflows/ci.yml` `mcp-version-guard` fails any PR that changes `mcp/` without bumping the MCP version in all seven fields (`mcp/package.json`, its lockfile ×2, `mcp/server.json` ×2, `web/public/.well-known/mcp.json` ×2); `check:tool-count` runs the same agreement check. **Plan:** bump 0.9.98 → 0.9.99 in Phase 1 (fork-local; renumber before any upstream conversation). |
| `node scripts/check-doc-links.mjs` | CONFIRMED | Scans top-level READMEs, `docs/*.md`, `docs/wiki`, `protocol/*.md`, `mcp/README.md` and friends; `docs/design/*.md` are not scanned but links INTO them from scanned docs are. |
| `web/bench/results.json` unchanged | CONFIRMED | Nothing in the plan imports or touches `oneclick.ts`, the bench or the gate. CI diffs `results.json` after `npm run bench`; Phase 1 verifies with `git diff --exit-code -- web/bench/results.json`. |
| Node toolchain | NOTE | CI runs Node 24 (`.nvmrc`); this container has Node 22. `npm ci` succeeded in `web`, `mcp`, `protocol`, and the baseline `npm run typecheck` (web, mcp) and `npm run check --prefix protocol` pass here. Any Node-version-only failure in the fuller suite gets reported, not patched. |

## 2. How unaccepted agent shapes are treated in totals today

Verified in code, not inferred:

- `web/src/lib/totals.js` `conditionTotals` / `sheetTotals` / the grouped views sum every shape handed to them; there is no `reviewed` check anywhere in `totals.js`, `reportColumns.js`, `xlsx.js` or `ReportPanel.jsx`.
- The canvas hands the full `shapes` array (or the visible subset for the panel chips) to those functions; the marked set does the same (`markedset.js:392`); MCP `summary()` and `exportReport()` do the same (`session.ts:3765`, `:4990`).
- What distinguishes pending work is disclosure, not exclusion: dashed rendering and the Accept pill in the canvas, `reviewed` on `list_shapes`, the marked-set cover's provenance/approval tallies, `shapes_pending` on import, and `takeoff_summary`'s proposals ledger.

So an agent-made run counts in pulls, cables and cable LF exactly as an agent-traced room counts in floor SF, and the feature discloses it the same way (a per-run review status, a pending count on the summary).

## 3. Where the records live in the takeoff document

```
opentakeoff.takeoff_canvas.v1
├─ conditions[]
│   ├─ cable_setup?: { device_type, cables_per_location, cable_type, vertical_ft, loop_device_ft, loop_tr_ft }
│   └─ role?: "tr"                      ← TR marker condition
├─ shapes[]
│   ├─ device marker  = { measure_role: "count", condition_id: <cable condition> }
│   ├─ TR marker      = { measure_role: "count", condition_id: <role:"tr" condition>, label: "MDF" }
│   └─ route segment  = { measure_role: "linear", computed.perimeter_lf (and plan_lf when legs exist) }
└─ cable_runs[]?                         ← NEW additive key, omitted when empty
    └─ { id: "run-<uuid>", device_shape_ids: [..], route_shape_ids: [..in order..], tr_id: <TR shape id>,
         cables_override?: n, provenance: { method, actor?, reviewed?, created_at, author? }, notes?: "" }
```

- `cable_runs` joins `TAKEOFF_DOCUMENT_KEYS` after `rules` (before `sheet_group`), emitted only when non-empty, so every document that never used the feature is byte-identical to today's.
- Lengths are never stored on a run: they are resolved from the referenced shapes at read time (recalibration and edit-in-place propagate for free; a deleted shape makes the run `broken`).
- Canvas hydrate adopts it through a sanitize gate (`sanitizeCableRuns`, the `sanitizeStitches` precedent: drop malformed entries, else-clear on load). Import merge (`importTakeoff.js`) appends runs by id. `device_shape_ids`, `route_shape_ids` and `tr_id` are shape ids, which import never re-mints, so no re-pointing is needed; a run whose shapes did not arrive stays and resolves as broken, never dropped.
- MCP `Session` gets `cableRuns: CableRun[]`, exported through `exportPayload`, adopted by `import_takeoff`, journaled for `undo_last`.

## 4. The cable library contract (`web/src/lib/cable.js`)

Pure, DOM-free, imported by `TakeoffCanvas.jsx`/`ReportPanel.jsx` (Phase 2/1) and `mcp/src/session.ts`.

```
DEVICE_TYPES            = ["wall_outlet","wap","camera","access_door","ceiling_other","custom"]
CABLE_DEFAULTS[type]    = { vertical_ft, loop_device_ft, loop_tr_ft, waste_pct }   // the spec's starting values; access_door.vertical_ft = null
mintCableSetup(type)    → a fresh setup with the type's starting values (custom: all blank)
hasCableSetup(cond)     → object with a device_type (corrupt → opted out)
isTrCondition(cond)     → cond.role === "tr"
cableSetupProblems(s)   → [] or ["vertical_ft is required", ...]   // the withhold reasons
sanitizeCableRuns(v)    → well-formed runs only (load gate)
resolveCableRuns(conditions, shapes, runs, {uppFor})
  → { runs: [{ id, condition_id, finish_tag, device_type, cable_type, tr_id, tr_name, sheet_ids,
               route_lf, vertical_ft, loop_device_ft, loop_tr_ft, per_cable_lf, cables, location_lf,
               status: "linked"|"withheld"|"broken", reason?, notes?, reviewed }],
      unlinked: { devices: [{shape_id, condition_id, sheet_id, reason}], routes: [...], runs: [...] } }
cableSummary(resolved, conditions)
  → rows [{ condition_id, finish_tag, device_type, cable_type, tr_id, tr_name, pulls, cables,
            route_lf, cable_lf, cable_lf_order, unlinked_devices, pending }] + subtotals by TR, by cable type + total
cableReportBlock(...)   → the report.v1 `cable` object; cableCsvSections(...); cableWorkbookTabs(...)
linkRunRefusal(...)     → the shared refusal text for link_run (MCP) and the Link Run tool (canvas)
```

Rules baked in: no routing factor, no estimated or default length, `location_lf` only from measured linear shapes, waste only on `cable_lf_order`, `cables = cables_override ?? cables_per_location`, route LF from `plan_lf ?? perimeter_lf` per segment summed in `route_shape_ids` order.

## 5. Phase 1 file list

### New files

| File | Purpose |
|---|---|
| `web/src/lib/cable.js` | The library (§4). |
| `web/test/cable.test.ts` | The spec's worked examples with exact values (wall outlet 130.5 / 261.0 / 292.32; camera 178.0 / 199.36; totals 2 pulls, 3 cables, 439.0, 491.68), two-sheet route at two scales, recalibration of one segment, unlinked device and route (excluded and listed), access-control door with no vertical (withheld, reason stated), broken run after a shape delete, override cables, ×N, sanitize gate, export → import round trip of a document with runs through `buildTakeoffDocument` + `parseTakeoffImport`/`mergeTakeoffImport`. |
| `docs/design/CABLE_SETUP.md` | The governing spec, copied in verbatim (it did not exist in the repo). |
| `docs/design/CABLE_SETUP_PLAN.md` | This page. |

### Changed files — web

| File | Change |
|---|---|
| `web/src/lib/takeoffDocument.js` | `cable_runs` in `TAKEOFF_DOCUMENT_KEYS` and `buildTakeoffDocument` (omit-when-empty). |
| `web/src/lib/importTakeoff.js` | Append imported runs by id (clean-replace path carries them; merge path appends unseen ids). |
| `web/src/lib/totals.js` | `reportJson` takes `cable` and emits the block only when present; `totalsToCsv` takes `cable` sections appended after by-label. |
| `web/src/lib/xlsx.js` | `reportWorkbook` appends "Cable summary" / "Cable runs" tabs when `cable` is passed. |
| `web/src/lib/reportColumns.js` | `cableColProfile` (Pulls / Cables / Cable LF / Cable LF w/Waste on the Conditions table, CSV, workbook) emitted only when a cable condition exists; `COL_DIM` entries for metric. |
| `web/src/components/ReportPanel.jsx` | Wiring only: accept a `cableTakeoff` prop and hand it to the three export calls. No visible UI (Phase 2). |
| `web/src/pages/TakeoffCanvas.jsx` | Wiring only: `cableRuns` state, hydrate through `sanitizeCableRuns`, `buildPayload` carries it, `useMemo` resolve, pass to `ReportPanel`. No tools, no panels (Phase 2). |
| `web/test/takeoffDocument.test.ts` | The "everything but units" key count and the additive-keys list gain `cable_runs`. |
| `web/test/totals.test.ts`, `web/test/xlsx.test.ts` | New cases: no-cable outputs unchanged (byte pins), cable outputs present when a setup exists. |

### Changed files — MCP

| File | Change |
|---|---|
| `mcp/src/session.ts` | `Condition.cable_setup?` / `role?`; `ConditionKnobPatch`/`applyConditionKnobs` accept `cable_setup` (null opts out, `device_type` change re-mints defaults, same-type partial edit patches) and `role`; journal `condition` snapshot carries both; `cableRuns` array; `linkRun` / `listRuns` / `unlinkRun` with journal ops `run_link` / `run_unlink` and `undo_last` inverses; `summary()` and `exportReport()` add the `cable` block; `exportPayload` carries `cable_runs`. |
| `mcp/src/importing.ts` | Adopt `payload.cable_runs`. |
| `mcp/src/tools.ts` | `edit_condition` input gains `cable_setup` (zod union null / object with the six fields) and `role` (`"tr"` or null); registers `link_run`, `list_runs`, `unlink_run` with the refusal texts in their descriptions; `takeoff_summary` / `export_report` descriptions mention the cable block. |
| `mcp/src/outputs.ts` | `editConditionOutput.cable_setup?`, `.role?`; `linkRunOutput`, `listRunsOutput`, `unlinkRunOutput`; `takeoffSummaryOutput.cable?`, `exportReportOutput.cable?`; `undoLastOutput` op enum gains `run_link` / `run_unlink`. |
| `mcp/src/staging.ts` | `TOOL_STAGES`: `link_run` → measure; `list_runs`, `unlink_run` → revise. |
| `mcp/test/cable.test.ts` (new) | Over the bundled demo PDF: setup + TR + devices + routes → `link_run` reply values; every refusal (not a linear shape, unscaled sheet, missing vertical, TR id not a TR marker, device already linked); `list_runs` unlinked list; `unlink_run` + `undo_last`; `export_takeoff` → `import_takeoff` round trip with runs; `export_report.cable`. |
| `mcp/test/conformance.test.ts`, `tools.test.ts` | Output-schema conformance rows for the three verbs; the `edit_condition` cable path. |
| `mcp/package.json`, `mcp/package-lock.json`, `mcp/server.json`, `web/public/.well-known/mcp.json` | 0.9.98 → 0.9.99 (seven fields). |

### Changed files — protocol and docs (CI-required)

| File | Change |
|---|---|
| `protocol/v1/condition.schema.json` | `cable_setup` (object/null) and `role` (`"tr"`) properties. |
| `protocol/v1/document-fields.schema.json` | `cable_runs` array with the run item schema inline (the `proposals` precedent; no new schema file, so the MCP resource allowlist is untouched). |
| `protocol/README.md` | Regenerated schema reference (`node protocol/scripts/check-docs.mjs --write`). |
| `protocol/INVENTORY.md` | Rows for `conditions[].cable_setup` / `role` and `cable_runs[]`. |
| `protocol/test/current-records.test.mjs` | A record case with a cable condition, a TR marker and one run validating against the draft schemas. |
| `mcp/src/protocol.generated.ts` | Regenerated (`npm run check:protocol-resources --prefix mcp -- --write`). |
| `docs/MCP_TOOL_INDEX.md` + the ten `<!--tool-count-->` docs | Regenerated (`npm run check:tool-count --prefix mcp -- --write`). |
| `mcp/README.md` | Three tool-table rows; `edit_condition` row mentions `cable_setup` / `role`. |
| `docs/MCP.md`, `docs/AGENT_GUIDE.md` | The reach-for-it list gains the three verbs; the refusal → next-move table gains `link_run`'s four refusals. |
| `docs/wiki/status.md`, `docs/wiki/mcp.md` | One row each ("Division 27 cable runs"), then `npm run check:wiki --prefix mcp -- --write` regenerates `mcp/src/wiki.generated.ts`. |
| `FEATURES.md`, `CHANGELOG.md` (Unreleased), `README.md` (What's in the box), `docs/USER_GUIDE.md` | The paper trail CONTRIBUTING requires; user-guide section is a stub pointing at Phase 2 until the canvas lands. |

### Not touched

`web/src/lib/oneclick.ts`, `web/src/lib/gate.js`, `web/bench/**`, `mcp/server.ts` initialize instructions (a new verb is not a new step in the standard finish), `docs/design/ONE_CLICK_GATE.md`.

## 6. Checks run before calling Phase 1 done

```
cd web      && npm run check                                  # typecheck, lint, test, bench, build, ocr-dist
git diff --exit-code -- web/bench/results.json                # One-Click numbers unmoved
cd mcp      && npm run typecheck && npm test && npm run check:tool-count && npm run check:protocol-resources && npm run check:wiki && npm run build && npm run smoke:dist
cd protocol && npm run check
node scripts/check-doc-links.mjs
```

## 7. Decisions (recorded Oct 21, 2026)

Plan approved. The review reply left four blanks (TR name field, access-door vertical, shared trunks, fork versus upstream); each was taken at the default stated here. Flip any of them and Phase 2 adjusts.

1. **TR name field:** `shape.label`. The group-by-label and floor × room side effect is documented in FEATURES.md.
2. **×N multiplier:** applies to pulls, cables and cable LF together in the Cable summary; the Cable runs sheet is unmultiplied with a Multiplier column.
3. **Conditional cable tabs, columns and blocks:** yes. Old documents export byte-for-byte.
4. **Route LF:** plan length only (`plan_lf ?? perimeter_lf`), legs ignored; a warning in the report, `list_runs` and the run note when a segment sits on a condition with nonzero rise or drop.
5. **Pending agent runs:** count, as the engine counts pending shapes; "Pending runs" column on the Cable summary, a pending-run count on the marked-set cover.
6. **MCP version:** 0.9.98 → 0.9.99 across all seven fields.
7. **Undo:** link and unlink are undoable (approvals-style entries, Phase 2); cable-setup field edits follow the condition editor's convention (not undoable).
8. **Access-control door vertical:** blank and required per job.
9. **Shared trunk segments:** allowed; route LF counted per run.
10. **Fork versus upstream:** stay in the fork; no upstream push or PR.
11. **Branch:** `claude/div27-cable-setup-c6t9wu`.

Additions from the review: device EA beside Pulls on the Cable summary; a required test that a run on a stitched sheet survives MCP import → export → import with its length intact and reads broken with a stated reason (stitches never round-trip through MCP).

## 8. Phase 1 as built

Everything in §5 landed, with these refinements found in the build:

- **Unlinked routes.** Which linear shapes are routes is now recorded: a linear condition flagged `role: "route"` (Phase 1 review, item 1). Every linear shape on a route condition that no linked run uses is reported unlinked, with its run's reason when a broken or withheld run references it; a line on any other condition (base, a transition, a wall) is never assumed to be a route. The inferred rule from the first cut is gone. Linking stays by shape id, so a segment on an unflagged condition still links; it just never appears in the unlinked list.
- **Withheld versus broken.** A run with a structural fault (a deleted or wrong-kind shape, a sheet with no scale answer) is `broken`; a run whose condition's setup lacks a required value is `withheld`. Both are excluded and listed with every reason; a broken run still reports its stored route LF.
- **`link_run` on a stitched segment** refuses in MCP (the session cannot answer the stitch's scale); an imported run that already references one resolves as broken with that reason and its length kept, as required.
- **`edit_condition` never writes `waste_pct` from a device-type pick.** The spec's 12% starting waste is a canvas pre-fill (Phase 2); an agent passes `waste_pct` explicitly in the same call.
- **Starting values over MCP are named** (Phase 1 review, item 2): a fresh opt-in or a type change still mints the device type's starting values for what the call did not state, and the reply's `cable.minted` lists each one with the note "starting values, not verified against spec". An explicit call mints nothing and carries no caveat. The review left the choice between this and refusing blank; this is the option taken.
- **Shared trunk segments stay allowed** (Phase 1 review, item 3; left blank, plan default kept).
- **Stitched sheets in the canvas** (Phase 1 review, item 4): confirmed. The Phase 2 Link Run tool links a segment on a `stitch:<uid>` surface because the canvas's `uppFor` knows the composite's scale; `web/test/cable.test.ts` ("a segment on a stitched sheet …") already shows the same run linking through the canvas's scale answer and reading broken through MCP's.
- **Marked-set cover** gained a `Cable runs: N pulls linked · M runs pending review · K unlinked devices` line (present only with a cable takeoff). Route chips and per-condition legend totals stay Phase 3.
- **Report Conditions table** gained Pulls / Cables / Cable LF / Cable LF w/Waste columns through the existing profile seam (the roll precedent), present only when a cable condition exists. The dedicated in-app Cable summary table and Unlinked list stay Phase 2.
- **Protocol:** `cable_setup` and `role` on the condition schema, `cable_runs` inline in the document-fields schema (no new schema file, so the MCP resource allowlist is untouched), inventory rows, a current-records case.
- **Tool counts:** 56 default, 58 with the One-Click gate lifted, setup 11; `link_run` is a measure-stage verb, `list_runs` and `unlink_run` revise-stage.

## 9. Try it on a plan over MCP

From the repo (`cd web && npm install && cd ../mcp && npm install`), point an MCP client at
`node --import tsx /abs/path/mcp/server.ts`, then with the bundled `demo/sample-plan.pdf`
(an invented layout works the same):

1. `load_plan { path }` → `set_scale { sheet, use_detected: true }`.
2. `place_count { sheet, points: [[200, 200]], condition: "TR" }` → `edit_condition { condition: "TR", role: "tr" }` → `edit_shape { shape_id, label: "MDF" }`.
3. `place_count` the devices under a device tag (or `symbol_sweep` them), then `edit_condition { condition: "DATA-1", waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } }`. The reply lists the setup, any missing value, and the condition's summary row (EA beside zero pulls until something links).
4. `measure_line { sheet, pts, condition: "ROUTE" }` for each route segment (several segments, on any sheets, are fine).
5. `link_run { device_shape_ids: [dev], route_shape_ids: [seg1, seg2], tr_id: tr }` → the reply gives route LF, per-cable LF and location LF. Try the refusals: a count id as a route, the TR id as the device, an `access_door` condition before its vertical is entered.
6. `list_runs` → runs with status and review, the unlinked list, the leg warnings, the summary by TR and by cable type. `takeoff_summary.cable` and `export_report.cable` carry the same figures; `export_takeoff` carries `cable_runs`.
7. `export_marked_pdf` → the cover reads `Cable runs: N pulls linked · M runs pending review · K unlinked devices`.
8. `unlink_run { run_id }` → `undo_last { n: 1 }` puts it back.

In the app, Sheet → Import takeoff… on the `export_takeoff` JSON lands the setups, the TR flag and the runs; Report → CSV / Excel / JSON then carry the Cable summary and Cable runs tables (and the Conditions table gains Pulls / Cables / Cable LF columns). Phase 2 adds the panels and the Link Run tool.

## 10. Phase 1 check record (Oct 21, 2026, this container: Node 22, root user)

| Check | Result |
|---|---|
| `web`: typecheck, lint, check:ort | pass |
| `web`: `npm test` | every cable, totals, workbook, document, import and marked-set case passes; `test/pictures.test.ts` hits the 20 s per-file timeout on this container **on the untouched baseline too** (24 of 24 subtests pass; passes with a 60 s timeout) |
| `web`: bench, `bench/results.json` | unchanged |
| `web`: build, check:ocr-dist | pass |
| `mcp`: typecheck, tests | 285 pass; `safewrite.test.ts` "an unreadable file fails CLOSED" fails **on the untouched baseline too** because the suite runs as root here (chmod 000 cannot withdraw root's read) |
| `mcp`: check:tool-count, check:protocol-resources, check:wiki, build, smoke:dist | pass (56 flat / 12 staged tools, 11 schemas, 9 wiki pages) |
| `protocol`: `npm run check` | pass |
| `node scripts/check-doc-links.mjs` | pass |

## 11. Phase 2 — canvas UI, as built (Oct 27, 2026)

`TakeoffCanvas.jsx` changes are mounting and wiring only: the cable undo family next to the
approvals one, the `W` key, `⏎` / `⌫` / `Esc` routing for the tool, the click dispatch, two rail
buttons, and the component mounts. Everything else is in new files.

| New file | What it is |
|---|---|
| `web/src/lib/cableLink.js` | The Link Run tool's pure click logic: what a click means (device → segments in order → TR), take-backs, and the live readout (which asks `cable.js` for every length). |
| `web/src/components/CableSetupEditor.jsx` | The **+ cable…** opt-in and the setup fields in the docked condition properties; required values left empty show inline. |
| `web/src/components/RunsPanel.jsx` | The docked Runs panel: totals, runs by condition with Accept and unlink, the unlinked list, TR name fields, ⌖ locate. |
| `web/src/components/CableOverlay.jsx` | Per-sheet SVG: amber cues on unlinked devices and routes, TR names, the Link Run draft in cobalt. |
| `web/src/components/CableLinkReadout.jsx` | The readout chip while Link Run is armed. |
| `web/src/components/CableReportSection.jsx` | The Report's Cable summary and Unlinked list (the same cell matrix as the CSV and workbook). |
| `web/test/cableLink.test.ts` | The click sequence, take-backs, refusals, readout values, and the run commands' exact inverses. |
| `web/scripts/make-cable-fixture.mts`, `web/scripts/verify-cable-runs.mjs` | The invented fixture (through the MCP `Session`) and the browser check. |

Changed: `cable.js` (`applyCableRunCommand`, the vertical reason worded by device type),
`canvasConstants.js` (the Link Run tool entry), `cursorSnap.ts` (Link Run picks with the raw
cursor), `TakeoffsPanel.jsx` and `ReportPanel.jsx` (one mount each), `canvasUtil.js` and the
canvas's template copy (`cable_setup` and `role` ride condition templates), `UserGuide.jsx`
and `docs/USER_GUIDE.md` (`W`), the `cableRun` icon.

Deviations and choices, all inside the spec's Canvas UI section (recorded in the spec's Decisions):
`W` as the shortcut; waste pre-filled only on a condition with none; the opt-in offered by what
a condition holds; the TR name field in the Runs panel; run Accept in the Runs panel. Setup
field edits stay off the undo stack (the Phase 1 review decision); link, unlink, accept and TR
renames are on it.

### Phase 2 check record (this container: Node 22, root)

| Check | Result |
|---|---|
| Browser: `web/scripts/verify-cable-runs.mjs` on the invented fixture | 19 of 19 checks; screenshots and `results.json` in [`docs/review/cable-runs-phase2/`](../review/cable-runs-phase2/README.md) |
| `web`: typecheck, lint, tests, bench (`results.json` unchanged), build, dist check | see the commit's report; the two environment-only failures from §10 are unchanged |
| `mcp`, `protocol`, doc links | see the commit's report |

To repeat the browser check:

```
cd web
npm run build
node --import tsx scripts/make-cable-fixture.mts /tmp/cable-fixture.json
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER_PATH=/path/to/chrome \
  node scripts/verify-cable-runs.mjs /tmp/cable-fixture.json ../docs/review/cable-runs-phase2/results.json
```

## 12. Follow-ups from the first real bid, as built (Oct 27, 2026)

The review of the user's bid outputs found six issues; the user asked for all six to be fixed
before Phase 3. The decisions are in the spec's Decisions section.

| Item | Change | Where |
|---|---|---|
| 1. By-TR undercount | A condition with no linked run lands in a no-TR group, so every summary quantity sums by TR to the total | `cable.js` `cableSummary`, `cableTables` |
| 2. Device and TR sheets | Runs carry `device_sheet_ids` and `tr_sheet_id`; the runs sheet gains *Device sheet* and *TR sheet* | `cable.js` `resolveCableRuns`, `cableRunRows`; MCP `link_run` / `list_runs` |
| 3. Unconfirmed scale | `resolveCableRuns` takes `scaleUnconfirmed` and `sheetLabel`; linked runs on such sheets are flagged, one warning names the sheets | `cable.js`; canvas memo reads the scale gate's map; MCP `cableInputs` |
| 4. Holds | `mintCableHold`, `holdRefusal`, `isCableHold`; held devices listed apart and counted in *Held devices*; MCP `hold_devices`; Runs panel **Hold**, Held list, grey cue; Report Held list | `cable.js`, `session.ts`, `tools.ts`, `outputs.ts`, `staging.ts`, `RunsPanel.jsx`, `CableOverlay.jsx`, `CableReportSection.jsx`, protocol schema |
| 5. 295 ft | `TIA_MAX_LINK_FT`; `over_length` per run, *Runs over 295 ft* column, one warning; Runs panel `>295` flag | `cable.js`, `RunsPanel.jsx`, MCP outputs |
| 6. Aliases | `DEVICE_TYPE_ALIASES`, `normalizeDeviceType`; `edit_condition` normalizes before comparing types | `cable.js`, `session.ts`, `tools.ts` |

Found while verifying item 4 in the browser and fixed: the canvas keyboard effect did not list
`cableRuns` as a dependency, so ⌘Z or ⇧⌘Z could apply a cable command to the run list as it
stood when the handler last subscribed, then set that stale list back. Redo after releasing a
hold reproduced it; `cableRuns` is now a dependency, as `approvals` already was.

## 13. Phase 3 — marked set, as built (Oct 27, 2026)

| File | What it is |
|---|---|
| `web/src/lib/cableMarks.js` (new) | Pure: `cableSheetMarks` decides the chips, device tags, rings and TR names for one sheet and places them (`placeLabels`, greedy, against markers and each other); `cableLegend` words the cover's meta line, per-condition cable lines, key and warnings; `wrapText`. |
| `web/src/lib/cable.js` | `runShortIds`: the six-hex short ID, lengthened until unique. |
| `web/src/lib/markedset.js` | Draws what `cableMarks.js` returns; `chip()` takes a size; a linked route's generic chip is suppressed. Every addition is gated on a cable takeoff. |
| `web/test/cableMarks.test.ts` (new) | Exact chip and tag text, placement, crowding, legend lines (×N, waste), wrap. |
| `mcp/test/cable.test.ts` | `export_marked_pdf` end to end: the PDF's text carries the chips, tags, TR name, cover lines and warning; the generic route chip is gone. |
| `web/scripts/make-cable-marked-sample.mts` (new) | An invented 12-run takeoff on the demo plan, exported as a marked set. |
| `web/scripts/verify-cable-runs.mjs` | Adds the over-295 flag, hold / release / redo, the Report's Held list, and the canvas marked set's text. |

### Check record (this container: Node 22, root)

| Check | Result |
|---|---|
| `web` tests | 3,562 tests: 3,552 pass, 0 fail, 6 cancelled. The cancellations are `pictures.test.ts` (20 s file timeout) and 5 in `stageOcrModel.test.ts`; both cancel identically on the untouched base commit here. |
| `web` typecheck, lint, ORT check, bench, build, OCR dist check | pass; `web/bench/results.json` unchanged |
| `mcp` all test files (as CI runs them) | 299 tests: 298 pass, 1 fail (`safewrite` "unreadable file fails CLOSED", which fails because this container runs as root, as in §10) |
| `mcp` typecheck, tool count (57 / 59 / 11), wiki, protocol resources, build, dist smoke | pass |
| `protocol` check, `node scripts/check-doc-links.mjs` | pass |
| A marked set with no cable work, base commit vs this branch, clock frozen | identical SHA-256 |
| Browser: `verify-cable-runs.mjs` | 30 of 30 checks, no console errors; [`docs/review/cable-runs-phase3/`](../review/cable-runs-phase3/README.md) |

To repeat:

```
cd web
npm run build
node --import tsx scripts/make-cable-fixture.mts /tmp/cable-fixture.json
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER_PATH=/path/to/chrome \
  node scripts/verify-cable-runs.mjs /tmp/cable-fixture.json /tmp/cable-ui/results.json
node --import tsx scripts/make-cable-marked-sample.mts /tmp/cable-marked-sample.pdf
```

## 14. Follow-ups after Phase 3 (Oct 27, 2026)

Items 1–5 of the post-Phase 3 list, built in parallel by five agents on separate branches from `d680c88` and merged on `claude/div27-cable-setup-c6t9wu`. Each subsection keeps its own check record from its branch; the combined check record is §14.6.

### 14.1 Auto-save

**Why.** The user's Claude Code session ended, and the stdio server stopped with it. A whole
bid's takeoff (81 linked cable runs) lived only in memory, and nothing had called
`export_takeoff`. Nothing on the MCP side persisted work.

**What.** From `load_plan` on, the session writes `<plan dir>/<plan> - takeoff autosave.json`
(the `export_marked_pdf` naming rule). The file is exactly `exportPayload()` with one extra
key, `autosave: { saved_at, tool, plan }`, placed second, right after `schema`, so a 512-byte
head identifies it. Both importers read fields by name and ignore the key, and
`export_takeoff` never carries it. No new tool: the count stays 57.

- **Triggers.** `Session.record()` (every journaled verb), `undo_last`, `import_takeoff`, and
  the writes the journal skips (a first `set_scale`, `annotate`, `link_annotation`). As a
  safety net, the tool registry also schedules a check after every successful call. A write
  only happens when the payload's bytes differ from the last write, so reads never write.
  `load_plan` sets the empty session as the baseline, so loading never writes.
- **Timing.** Trailing debounce 0.75 s, capped at 2 s after the first unsaved change. Timers
  are `unref`'d, and `installExitFlush` (wired only in `server.ts`'s entry point) writes
  synchronously on `exit`, SIGINT, SIGTERM and SIGHUP. A non-merge `load_plan` writes the
  outgoing plan's file first, and `takeoff_summary` flushes before it replies.
- **Atomic.** A temp file in the same directory, then rename.
- **Never fails a call.** A failed write is stored, logged once to stderr and reported as
  `takeoff_summary.autosave.error`. The next call, summary or plan switch tries again.
- **Never clobbers.** A file at the path without the schema-then-marker head (including a plain
  `export_takeoff` file) is never written over. `load_plan` and `takeoff_summary` both report it.
- **Resume, never silently.** When `load_plan` finds an autosave there, the reply carries
  `autosave.found` (time, tool, plan, shape, condition and linked-run counts) and a note telling
  the agent to `import_takeoff` it. Importing that path resumes it in place. If the session
  changes anything first, the found file is renamed to `… (before <time>).json` before the
  first write (named in `autosave.moved_aside`), so a session that ignores the notice cannot
  destroy the earlier bid.
- **Environment.** `OPENTAKEOFF_AUTOSAVE=0` (also `off`, `false`, `no`) turns it off;
  `=<file>` writes that file; `=<directory>` writes the default name there. A `Session` built
  without an attached `Autosave` (every test and script) writes nothing and replies exactly as
  before. The eval bench sets `OPENTAKEOFF_AUTOSAVE=0` so it never writes beside the repo's
  plans.

| File | Change |
|---|---|
| `mcp/src/autosave.ts` (new) | `Autosave` (debounce, compare, atomic write, foreign-file refusal, found-file move-aside, `flushSync`), `installExitFlush`, `autosaveModeFromEnv`, `defaultAutosavePath` |
| `mcp/src/session.ts` | `autosave` field, `changed()` from `record()` / `undoLast` / unjournaled writes, `load_plan` reply `autosave` and note, `summary().autosave` |
| `mcp/src/importing.ts` | `noteImport` + `changed("import_takeoff")` |
| `mcp/src/tools.ts` | after-call check in the registry facade; `takeoff_summary` flushes first; `load_plan` and `takeoff_summary` descriptions |
| `mcp/src/outputs.ts` | optional `autosave` on `load_plan` and `takeoff_summary` |
| `mcp/server.ts` | attach `Autosave` and the exit hook at the stdio entry point |
| `mcp/test/autosave.test.ts` (new) | 15 tests, listed below |
| Docs | `docs/MCP.md` (Auto-save), `mcp/README.md` (Auto-save, `load_plan` and `takeoff_summary` rows), `docs/AGENT_GUIDE.md` §3, `docs/CONNECT.md`, `docs/wiki/mcp.md` (+ regenerated `wiki.generated.ts`), `protocol/INVENTORY.md` (`autosave` row), `CHANGELOG.md` |

The tests cover: a write after a mutation (head, marker, the body byte-equal to
`exportPayload()`, no temp file left, the summary's `{path, saved_at}`); 30 calls in one burst
coalesced into 1 write, with reads writing nothing; the 2 s cap under a continuous burst;
`undo_last`, a conditions-only `import_takeoff` and the summary flush; `OPENTAKEOFF_AUTOSAVE=0`;
an explicit file and a directory; a foreign file and a markerless export left untouched and
reported, with the tool call still succeeding; a failed write reported and then cleared; a
round trip through `import_takeoff` (byte-equal export) and the app's
`parseTakeoffImport` / `mergeTakeoffImport`; `load_plan` finding an earlier autosave, resuming
by import, and moving it aside when ignored; `flushSync` and the plan-switch flush; merge
keeping the primary path; a bare `Session` writing nothing; and the real stdio server writing
the last change, inside the debounce window, when stdin closes and on SIGTERM.

#### Check record (this container: Node 22, root)

| Check | Result |
|---|---|
| `mcp/test/autosave.test.ts` | 15 of 15 pass |
| `mcp` all test files (as CI runs them) | 314 tests: 313 pass, 1 fail (`safewrite` "unreadable file fails CLOSED", root, as in §10) |
| `mcp` typecheck, `check:tool-count` (57 / 59 / 11), `check:wiki`, `check:protocol-resources`, build, `smoke:dist` | pass |
| `web` typecheck, lint | pass (no web code changed) |
| `protocol` check, `node scripts/check-doc-links.mjs` | pass |
| Built `dist/server.js` over real stdio: `load_plan`, one `place_count`, close stdin | the server exited in 46 ms, inside the debounce, and the file held the count, `tool: "place_count"` |

### 14.2 Trunk and branch routes, as built (Oct 27, 2026)

Item 2 of the follow-ups: the bid traced each run device-to-TR as one polyline, so route LF
could not give branch length and J-hooks were a lump allowance. A route condition now says
whether its segments are trunk or branch; the decisions are in the spec's Decisions section
("Recorded while building item 2").

| File | Change |
|---|---|
| `web/src/lib/cable.js` | `ROUTE_KINDS`, `routeKindOf`, `usesRouteKinds`; `resolveCableRuns` gives each segment its `kind` and each run `trunk_lf` / `branch_lf` / `other_lf`; `pathwayRollup` (pure); `computeCableTakeoff().pathway` (null until a route condition is tagged); `routeSplit`; the runs table gains *Branch LF* / *Trunk LF* before *Reason / notes* and a `pathway` matrix; `cableReportBlock` appends `pathway` |
| `web/src/lib/totals.js`, `web/src/lib/xlsx.js` | CSV *Pathway* section, Excel *Pathway* tab, both gated |
| `web/src/lib/cableMarks.js` | a tagged route condition's cover line names its kind and pathway LF |
| `web/src/lib/canvasUtil.js`, `TakeoffCanvas.jsx` (`condToTemplate`) | `route_kind` rides templates with the route role |
| `web/src/components/CableSetupEditor.jsx` | **Kind** (Unspecified / Trunk / Branch) on a cable-route condition; **Cable route: trunk / branch** in the opt-in; ✕ clears the kind with the role |
| `web/src/components/CableReportSection.jsx`, `RunsPanel.jsx` | the Report's Pathway table; the run tooltip shows the split |
| `mcp/src/session.ts`, `tools.ts`, `outputs.ts` | `edit_condition { route_kind }` (refused off a route condition before anything is written; null clears; leaving the route role drops it; journaled and undone with the other knobs; the reply echoes the pathway row); the split on `link_run` and `list_runs`; `pathway` on `list_runs`, `takeoff_summary.cable` and `export_report.cable`. No new tool (57) |
| `protocol/v1/condition.schema.json`, `protocol/INVENTORY.md` | `route_kind` enum, inventory row, a current-records case |
| Tests | `web/test/cableTrunkBranch.test.ts` (new, 9 tests); `mcp/test/cable.test.ts` (+2); `protocol/test/current-records.test.mjs` (+1 case) |

Exact values pinned: a 40 ft branch + shared 100 ft trunk → route 140, branch 40, trunk 100;
two runs sharing the trunk → pathway trunk LF 100 (once), cable route LF 280; J-hooks per 5 ft
on a 40 ft + 35 ft branch condition → 15, 30 at ×2; an untagged cable takeoff's CSV equals the
literal captured from `d680c88`, and its report JSON and workbook hash to the values taken there.

#### Check record (this container: Node 22, root, four other agents building in parallel)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` tests | 3,570 tests: 3,559 pass, 1 fail, 6 cancelled, 4 skipped. The cancellations are `pictures.test.ts` and 5 in `stageOcrModel.test.ts`, as in §13. The failure is `ocrPageRead.test.ts` "cancel shows Stopping… until the read settles", a timing test that passed on one of three solo reruns and failed on the others while the container was loaded; nothing in it touches cable code. Every `cable*.test.ts` passes (59 tests) |
| `web/bench/results.json` | not touched (the bench was not rerun; nothing here reaches the flood engine) |
| `mcp` typecheck; all test files as CI runs them | pass; 301 tests, 300 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root, as in §10) |
| `mcp` check:tool-count (57 / 59 / 11), check:wiki, check:protocol-resources | pass after `--write` |
| `protocol` `npm run check` | 62 tests pass; docs match 11 schemas |
| `node scripts/check-doc-links.mjs` | pass |
| Browser: `verify-cable-runs.mjs` on the invented fixture | 30 of 30, no console errors |
| Browser: tag the fixture's ROUTE as Trunk in the condition editor, open the Report | the Pathway table reads `ROUTE · Trunk · 3 · 99.99 · 33.33 · 66.66 · 1 · 1 · 99.99`, no console errors |

### 14.3 Duplicate device check (item 3), as built (Oct 27, 2026)

The first real bid counted 14 cameras twice: camera outlets on the comms plan T3.1 and CAM markers on the security plan T4.1, at one page size and scale, both on cable conditions. The check flags; it never merges, moves or deletes a marker, and no count changes. The thresholds and their reasons are in the spec's Decisions ("Recorded while building item 3").

| File | What it is |
|---|---|
| `web/src/lib/cableDupes.js` (new) | Pure: `findCableDuplicates(conditions, shapes, { sheetSize, uppFor, sheetLabel })` → `same_sheet`, `cross_sheet` (grouped by condition pair, `different_conditions`), `reference` (one side non-cable: detail only), `not_compared`, `warnings`, `count`, `thresholds`; `hasDuplicateFindings`; the named constants `SAME_SHEET_DUP_FT` (1.0), `SAME_SHEET_DUP_NORM` (0.0035), `PAGE_SIZE_TOL` (0.01), `SCALE_TOL` (0.01), `OVERLAY_POS_TOL` (0.0075), `OVERLAY_MIN_POSITIONS` (3), `OVERLAY_MIN_SHARE` (0.5). |
| `web/src/lib/cable.js` | The hook: `computeCableTakeoff` runs the check when `opts.sheetSize` is given, appends its warnings to `summary.warnings` and returns `duplicates` (null without `sheetSize`); `cableReportBlock` carries `duplicates` only when it found something. |
| `web/src/pages/TakeoffCanvas.jsx` | Wiring only: the cable memo passes `sheetSize` from the rendered sheets' dims (`panelImgs`, accumulated in a ref, since it holds only the open group) and lists `panelImgs` as a dependency. |
| `web/src/components/RunsPanel.jsx` | A **Possible duplicates** list, one row per condition pair or stacked spot, with ⌖ on each side; the warnings already render. |
| `mcp/src/session.ts` | `cableInputs().sheetSize` (each loaded sheet's image px); `list_runs.duplicates` always (null with no cable takeoff); `takeoff_summary.cable.duplicates` when it found something; `export_report.cable.duplicates` through the report block. |
| `mcp/src/outputs.ts`, `mcp/src/tools.ts` | `cableDuplicatesBlock` on `list_runs`, `takeoff_summary.cable` and `export_report.cable`; the `list_runs` description. No new tool (57 default). |
| `web/test/cableDupes.test.ts` (new) | 11 tests, exact values: 14 cameras across two equal sheets → one group of 14 and its warning; offsets 0.007 in, 0.008 out, the long-edge rule; ANSI D vs ARCH D, rotated, within 1%, unknown size → `not_compared`, disagreeing scales; 2 coinciding → none, 3 of 10 → none, 5 of 10 → reported; different cable conditions; a non-cable side → `reference` only; 0.5 ft flagged, 3 ft not, three stacked → one finding; the no-scale fallback and its wording; no cable conditions → nothing; no `sheetSize` → null and an unchanged report block. |
| `mcp/test/cable.test.ts` | Two `place_count` calls on one spot of DATA-1 → the same-sheet finding (0 ft, basis ft) and warning in `list_runs`, EA still 2, `takeoff_summary` and `export_report` carry it (and do not before). Cross-sheet over the wire: the demo plan copied to a tmp dir as `comm.pdf` and `sec.pdf`, loaded with `load_plan { merge: true }`, three CAM-1 markers on each → one group of 3, labels disambiguated as `A-101 (comm.pdf)` / `A-101 (sec.pdf)`; `edit_shape { condition: "CAM-REF" }` on the second set clears the warning and lists it under `reference`. |

The canvas compares only sheets rendered in this session, because page sizes are known only for those; a sheet with cable markers not yet opened is listed under `not_compared`, never guessed. Not done here: a browser check of the Runs panel list (no browser in this container).

#### Check record (this container: Node 22, root)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` `test/cableDupes.test.ts` + the four existing cable test files | 11 + 26 + 8 + 8 + 8 pass |
| `web` `npm test` | 3,540 tests: 3,522 pass, 2 fail, 12 cancelled with the MCP suite running beside it (all timeouts); the failing and timed-out files outside the known two (`hybridReplay`, `ocrPageRead`, `planSearch`, `resolutionInvariance`, `scheduleOcrReplay`, `sheetName`) re-run alone: 243 of 243 pass. Left: `pictures.test.ts` and `stageOcrModel.test.ts`, which also fail on the base commit here |
| `web/bench/results.json` | unchanged |
| `mcp` typecheck, all test files (as CI runs them) | 301 tests: 300 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root container, as in §10) |
| `mcp` check:tool-count (57 / 59 / 11), check:wiki, check:protocol-resources | pass, no `--write` needed |
| `protocol` check, `node scripts/check-doc-links.mjs` | pass (62 tests; 44 files) |

### 14.4 Per-run vertical (item 4), as built (Oct 27, 2026)

A run may state its own vertical, the `cables_override` pattern: `vertical_override` (feet,
≥ 0) replaces the condition's `vertical_ft` for that location only. The decisions are in the
spec's Decisions ("Recorded while building item 4"); this relaxes "one vertical per
condition".

| File | Change |
|---|---|
| `web/src/lib/cable.js` | `runVerticalOverride`; `mintCableRun` mints `vertical_override` when valid; `sanitizeCableRuns` keeps a valid one in place and drops an invalid one; `resolveCableRuns` uses the run's vertical, checks the setup with it (a condition missing only its vertical does not withhold a run that states one), reports `vertical_ft` used and `vertical_override` / `cables_override` when set, and notes `vertical 9 ft (run override; condition 23 ft)`; `cableRunRows` adds `vertical_override` only when set; `linkRunRefusal` takes `vertical_override` (refuses a negative one; the missing-vertical refusal names it as a next move); `applyCableRunCommand` gains `override` with an exact inverse (values and key order) |
| `web/src/components/RunsPanel.jsx` | **↕** per run opens the vertical / cables editor (display units, blank = the condition's, unchanged fields keep their stored value); an overridden run shows `run's own: …` under its row |
| `web/src/pages/TakeoffCanvas.jsx` | One prop: `onOverride` dispatches `{ type: "override" }` on the cable undo family |
| `web/src/components/CableReportSection.jsx` | Footnote wording (the vertical is the condition's or a run's own) |
| `mcp/src/tools.ts`, `session.ts`, `outputs.ts` | `link_run` takes optional `vertical_ft` (≥ 0, stored as `vertical_override`); `link_run` and `list_runs` rows carry `vertical_override` / `cables_override` when set; descriptions say to change a run by unlink and relink. No new tool (57 / 59 / 11) |
| `protocol/v1/document-fields.schema.json`, `INVENTORY.md`, `test/current-records.test.mjs` | `cable_runs[].vertical_override` (number, minimum 0); a conforming record and a negative one that does not |
| `web/test/cableRunVertical.test.ts` (new), `mcp/test/cable.test.ts` | See below |
| `web/scripts/verify-cable-runs.mjs` | 8 checks for the ↕ editor |

Tests (`web/test/cableRunVertical.test.ts`, 12 cases): a 23 ft wall outlet with one run at
9 ft gives 87.5 + 9 + 10 + 10 = 116.5 per cable, × 2 = 233, 260.96 at 12%, and its sibling
keeps 130.5; an access_door with no vertical withholds the run without an override (existing
reason) and links the one at 12 ft (97 LF); other missing values still withhold; 0 is a stated
value; invalid overrides drop at mint and at the load gate; the runs sheet keeps its columns
and marks the override in Reason / notes; the document round trip; an old document loads and
exports byte-identically; the command and its inverse, byte for byte, including a sanitized
record's key order; a withheld run released by its own vertical. `mcp/test/cable.test.ts`
adds `link_run vertical_ft` on an access_door with no vertical (refused without, linked with
12 and with 0), a negative value refused by the schema, `list_runs`, `export_takeoff` →
`import_takeoff`, and `undo_last`.

Old documents: the base commit's `cable.js` and this one were run side by side on the browser
fixture (three variants: as is, verticals cleared, ×2 with 300 ft) over the load gate, the
summary, the report block, the cable tables and the run rows: all 15 data outputs identical.
The only difference is the wording of the missing-vertical refusal, which now names the run's
own vertical as a next move.

#### Check record (this container: Node 22, root, shared with four other agents; load 13–20 on 4 cores)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` tests | 3,552 tests: 3,537 pass, 1 fail, 10 cancelled. Every failure and cancellation is a timing or per-file timeout under load: `sheetTree.test.ts` "a 5,000-sheet set builds … quickly" (128 ms against its budget) and the per-file timeouts in `hybridReplay`, `ocrPageRead`, `pictures`, `planSearch` and `sheetName`, which pass on their own with a 120 s timeout (sheetTree 15/15, sheetName 10/10, the rest 262/264 with two timing asserts under load); `stageOcrModel.test.ts` cancels 5, as on the base commit. Every cable test passes. |
| `web/bench/results.json` | unchanged |
| `mcp` typecheck; all test files as CI runs them | pass; 300 tests: 299 pass, 1 fail (`safewrite` "unreadable file fails CLOSED", root, as in §10) |
| `mcp` check:tool-count, check:wiki, check:protocol-resources | pass after `-- --write` (57 default / 59 gated / 11 setup) |
| `protocol` `npm run check` | pass after `node protocol/scripts/check-docs.mjs --write` |
| `node scripts/check-doc-links.mjs` | pass |
| Browser: `verify-cable-runs.mjs` | 38 of 38, no console errors; [`docs/review/cable-runs-run-vertical/`](../review/cable-runs-run-vertical/README.md) |

### 14.5 Parts per cable and per pull (item 5, Oct 27, 2026)

The bid workbook figured parts by hand: every DATA-1 location carries a jack and a patch cord
per cable and a faceplate per pull; every camera a mount per pull and an outdoor patch cord per
cable. A supporting-materials row could only key on the device count, so "jacks = cables" meant
`per = 1 ÷ cables per location`, which goes wrong on a run's `cables_override` and on every
unlinked or held device. Two new materials bases fix it: `cables` and `pulls`, the condition's
linked figures from the cable summary. Decisions are in the spec's Decisions ("Recorded while
building item 5"); `cable_lf` was considered and left out (the cable is already the summary's
net and order LF, and no materials basis carries waste).

| File | Change |
|---|---|
| `web/src/lib/cable.js` | `CABLE_MATERIAL_BASES`, `isCableMaterialBasis`, `cableQtyByShape` (linked pulls and cables per device shape, unmultiplied), `cableMaterialReason` (why a row reads 0). |
| `web/src/lib/totals.js` | `conditionTotals` takes `ctx.cableByShape` beside `ctx.seamByShape`; the `cables` / `pulls` bases; `reason` on a zero cables/pulls line only; `materialBasisLabel`, `materialCoverage`, `materialNote` shared by the CSV and the workbook; the grouped-row JSDoc. |
| `web/src/lib/xlsx.js` | The Materials tab reads the shared coverage and note cells. |
| `web/src/components/ReportPanel.jsx` | The cable map rides the Report's materials ctx (rows, grouped views, CSV, XLSX, JSON); the by-finish line prints a row's reason; the footnote names the rule when a cable/pull line exists. |
| `web/src/components/TakeoffsPanel.jsx` | The basis picker offers **cable** and **pull** only on a condition with a cable setup (kept visible on a row that already uses one); the row shows *N cables linked* / *N pulls linked*, or why it reads 0. The library picker shows them only on an entry promoted from such a row. |
| `web/src/pages/TakeoffCanvas.jsx` | Wiring only: the materials ctx memo moves below the cable takeoff memo and gains `cableByShape`. |
| `mcp/src/session.ts` | `MaterialRow.basis` gains the two values; `materialsCtx()` (seams + cables) for `takeoff_summary`; `export_report` hands the cable map in; `edit_materials` replies with `computed` on a condition the bases concern. |
| `mcp/src/tools.ts`, `mcp/src/outputs.ts` | The `edit_materials` basis enum and description ("per cable: 1 jack per cable → per 1, basis cables"); the output schemas carry the new bases, `computed` and `reason`. No new tool (57 default). |
| `protocol/v1/condition.schema.json`, `protocol/INVENTORY.md` | `materials[].basis` described (still a string, not an enum); an inventory row. Generated: `protocol/README.md`, `mcp/src/protocol.generated.ts`. |
| `web/test/cableMaterials.test.ts`, `web/test/fixtures/cableMaterials.noCable.ts` (new), `mcp/test/cable.test.ts` | Tests below. |
| Docs | `USER_GUIDE.md` (Supporting materials, Cable runs, the buy list), `AGENT_GUIDE.md` (two rows: use `cables` / `pulls`, never `per = 1 ÷ quantity`; a zero with a reason), `MCP.md`, `mcp/README.md`, `FEATURES.md`, `CHANGELOG.md`, the spec's Decisions. |

**Tests.** `web/test/cableMaterials.test.ts` (8): DATA-1 with three linked runs at 4 cables, one
run overridden to 2 (one of them a pending agent run), a device on a broken run and a held
device reads jacks 14, faceplates 4, patch cords 14 against a count row's 6; ×2 reads 28, 8, 28
and equals `cableByCondition`; non-1 coverage rounds up and `round:false` keeps two places; a
condition with no cable setup, one with no linked run, and a caller with no cable takeoff each
read 0 with their own reason; the by-sheet slice splits 8 / 6; the buy list, CSV, workbook and
report JSON carry the parts and the reason; and an invented takeoff with no cable work (area,
linear, count, seam_lf, basis-less, round:false and unnamed rows, by sheet and by label) hashes
to the SHA-256 the base commit `d680c88` printed for its report JSON, CSV and workbook, with no
cable ctx and with an empty one. `mcp/test/cable.test.ts` (+1): `edit_materials` adds jack,
faceplate and patch-cord rows on DATA-1 (2 linked runs, one overridden to 3, one device
unlinked) and the reply's `computed` reads 5 / 2 / 5; `export_report`'s buy list reads 5 / 2 / 5
and 10 / 4 / 10 at ×2; an unknown basis is refused by the schema; a VCT-1 row on `cables` reads 0
with its reason in the reply and the report; an ordinary `edit_materials` reply has no
`computed`; `undo_last` restores the rows.

#### Check record (this container: Node 22, root)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` tests | 3,436 tests: 3,421 pass, 0 fail, 11 cancelled. Six are the known environment-only ones (`pictures.test.ts`'s 20 s file timeout and 5 in `stageOcrModel.test.ts`); the other five files (`hybridReplay`, `ocrPageRead`, `planSearch`, `scheduleOcrReplay`, `sheetName`) timed out while the MCP suite ran beside them and pass alone (224 of 224). |
| `web/bench/results.json` | unchanged (not touched) |
| `mcp` typecheck; all test files as CI runs them | pass; 300 tests: 299 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root, as in §10) |
| `mcp` check:tool-count, check:wiki, check:protocol-resources | pass (57 default / 59 gated / 11 setup; 9 wiki pages; 11 schemas, after `--write`) |
| `protocol` `npm run check` | pass after `node protocol/scripts/check-docs.mjs --write` |
| `node scripts/check-doc-links.mjs` | pass |
| Browser, built app, invented fixture on the demo plan (scratch script, not committed) | 8 of 8: the Report's buy list reads RJ45 jack 5, Faceplate 2 against a count row's 3; the VCT-1 per-cable line reads 0 with its reason; DATA-1's picker offers cable and pull and its rows show *5 cables linked* / *2 pulls linked*; VCT-1's picker keeps its row's basis, offers no pull and says it reads 0; no console errors |

### 14.6 Combined check record (all five merged; Node 22, root, run alone)

| Check | Result |
|---|---|
| `web/test/cableCombined.test.ts` (new) | 1 of 1: one takeoff using a run's own vertical over branch + shared trunk, a hold, a double-clicked outlet and parts per cable and pull, exact values |
| `web` cable test files | 91 pass |
| `web` `npm test` | 3,603 tests: 3,593 pass, 0 fail, 6 cancelled (`pictures.test.ts` and 5 in `stageOcrModel.test.ts`, identical on the base commit) |
| `web` typecheck, lint, build, OCR dist check; `web/bench/results.json` | pass; unchanged |
| `mcp` all test files as CI runs them | 320 tests: 319 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root) |
| `mcp` typecheck, tool count (57 / 59 / 11), wiki, protocol resources, build, dist smoke | pass |
| `protocol` check, doc links | pass |
| Browser `verify-cable-runs.mjs` | 38 of 38, no console errors |
| A marked set with no cable work vs `d680c88`, clock frozen | identical SHA-256 |

## 15. Second follow-up round (Oct 27, 2026)

Items 6–8 of the post-Phase 3 list, built in parallel by three agents on separate branches from `28ea3cc` and merged on `claude/div27-cable-setup-c6t9wu`. Each subsection keeps its own check record; the combined record is §15.4.

### 15.1 Cable medium and length limits

Item 6. Every linked run over 295 ft per cable carried the TIA-568 copper flag, whatever the
cable was, because the library could not tell the medium from free-text `cable_type`. A cable
setup can now state its `medium` (copper, fiber, coax) and a `max_link_ft`. A run is checked
against the stated limit, else 295 ft for copper or no medium (unchanged), else not at all for
fiber or coax. Nothing is inferred or minted, and the check never changes a quantity. The
decisions are in the spec's Decisions ("Recorded while building item 6").

| File | Change |
|---|---|
| `web/src/lib/cable.js` | `CABLE_MEDIA`, `LIMIT_SOURCES`, `isCableMedium`, `isLinkLimit`, `cableMediumOf`, `statedLinkLimit`, `cableLinkLimit`, `usesCableLimits` (the gate), `cableLimitText`, `normalizeCableMedium`, `cableLimitRefusal`, `withCableLimit`; `resolveCableRuns` checks each linked run against its own limit, adds `medium` / `limit_ft` / `limit_source` to runs once the gate is open, words a stated limit's note, groups the warning by limit and warns on an invalid stored value; `cableSummary` rows carry the condition's limit; `cableRunRows` adds the three fields; `cableTables` renames the summary column *Runs over length limit* and inserts *Limit ft* / *Limit source* before *Reason / notes*; `CABLE_SUMMARY_LIMIT_COLUMN`, `CABLE_RUNS_LIMIT_HEADER`, `limitSourceLabel`, `takeoffUsesLimits` |
| `web/src/lib/cableMarks.js` | The chip's over mark is the run's own limit (`>500`); the cover counts `N over their length limit per cable` once the gate is open |
| `web/src/components/CableSetupEditor.jsx` | **Medium** select and **Limit** field (display units, placeholder 295 or *none*), a line naming the check; a device-type change keeps both |
| `web/src/components/RunsPanel.jsx` | The `>N` flag and its tooltip use the run's own limit |
| `mcp/src/session.ts`, `tools.ts`, `outputs.ts` | `edit_condition { cable_setup: { medium, max_link_ft } }`: refused before anything is written unless valid or `null`; `null` clears; a type change keeps both; the reply's `cable.limit`; `limit_ft` / `limit_source` / `medium` on `link_run` and `list_runs` rows (and through the library on summary rows and `export_report`). Descriptions updated. No new tool (57 / 59 / 11) |
| `protocol/v1/condition.schema.json`, `protocol/INVENTORY.md`, `protocol/test/current-records.test.mjs` | `cable_setup.medium` (enum) and `max_link_ft` (number, exclusive minimum 0); an inventory row; a conforming record and two that do not. Generated: `protocol/README.md`, `mcp/src/protocol.generated.ts` |
| `web/test/cableMedium.test.ts` (new), `web/test/fixtures/cableMedium.fixture.ts`, `cableMedium.base.json` (new) | Below |
| `mcp/test/cable.test.ts` (+2), `mcp/test/fixtures/cableMediumScenario.ts`, `cableMediumScenario.base.json` (new) | Below |
| `web/scripts/verify-cable-runs.mjs` | 3 checks: Fiber with no Limit clears the flag; Limit 350 flags `>350` with the stated-limit warning; clearing both restores `>295` |
| Docs | the spec's data model, summary column and Decisions; `USER_GUIDE.md` (cable setup fields, *Flags you should not price past*, the chip); `AGENT_GUIDE.md` (two refusal-table rows: state medium and the spec's limit, never infer them); `MCP.md`; `mcp/README.md` (`edit_condition`, `link_run`, `list_runs` rows); `docs/wiki/status.md` (+ regenerated `wiki.generated.ts`); `FEATURES.md`; `CHANGELOG.md` |

**Tests.** `web/test/cableMedium.test.ts` (12): the vocabulary and the gate (invalid values
read as absent and do not open it; no device type mints either field); refusal wording, and
`withCableLimit` clearing back to the original setup, key order included; no medium: 295 ft per
cable not flagged, 296 flagged, today's note, warning, header, chip `>295` and cover line;
copper: the same flags and note, each run carrying `limit_ft: 295`, the grouped warning; fiber
with no limit: a 600 ft run unflagged, no warning, *Limit source* `none (fiber: no limit
stated)`, and the same fiber text in `cable_type` with no medium stated still checked as copper;
fiber with `max_link_ft` 500: the 600 ft run flagged `per cable 600 ft exceeds the stated 500 ft
limit for FIBER-1`, the exact warning, *Runs over length limit* with every other column in
place, the row note, the runs-sheet columns and cells, report JSON, CSV, workbook, chip `>500`,
cover, and metric *Limit m* 152.4; 1000 per cable not over a stated 1000, 1001 over it and
chipped `>1000`; coax unchecked without a limit and flagged with one; five media in one takeoff
grouped into one warning; an invalid stored value warned; a document and template round trip.
The byte-identity test runs `cableMediumOutputs` (resolved runs, summary, `byCond`, run rows,
tables imperial and metric, report JSON, CSV imperial and metric, workbook imperial and metric,
legend, sheet marks on two sheets, each plain and with a tagged trunk: 26 outputs) and
compares the full CSV, the warnings and 26 SHA-256 values with `cableMedium.base.json`,
captured by the same function from `28ea3cc`'s `web/src/lib` (extracted with `git archive`).
`mcp/test/cable.test.ts` adds: over the wire, a 600 ft camera run flagged with today's reply
and warning, then `medium: "Fiber"` (read as fiber, `cable.limit` none, unflagged, DATA-1's
run carrying 295), refusals of `"glass"`, `0` (with a waste % in the same call, nothing
written), `-300` and a string limit, `max_link_ft: 500` (flag, note, grouped warning, quantity
unchanged, `export_report`, `takeoff_summary`, chip `>500` and the cover in the marked PDF),
a type change keeping both, `null` clearing each, `undo_last`, and a fresh opt-in minting
neither; and a scripted session using neither field (seeded ids) whose `edit_condition`,
`link_run`, `hold_devices`, `list_runs`, `takeoff_summary.cable`, `export_report.cable` and
marked-set text equal, byte for byte, the replies captured from `28ea3cc`'s server.

#### Check record (this container: Node 22, root, shared with two other agents)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` `test/cable*.test.ts` | 103 pass (91 before + 12) |
| `web` `npm test` | 3,607 tests: 3,595 pass, 1 fail, 7 cancelled, 4 skipped. The failure is `sheetName.test.ts` "cost grows about linearly with the page's text" (a timing ratio under load) and one cancellation is `planSearch.test.ts` (20 s file timeout); both files pass alone (115 of 115). The rest are the known environment-only `pictures.test.ts` timeout and the 5 in `stageOcrModel.test.ts` |
| `web/bench/results.json`, `oneclick.ts`, `TakeoffCanvas.jsx` | unchanged |
| `mcp` typecheck; all test files as CI runs them | pass; 322 tests: 321 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root, as in §10) |
| `mcp` check:tool-count (57 / 59 / 11), check:wiki, check:protocol-resources | pass after `-- --write` |
| `protocol` `npm run check` | 62 tests pass; docs match 11 schemas; matrix 16 cases |
| `node scripts/check-doc-links.mjs` | pass (44 files) |
| Browser: `verify-cable-runs.mjs` on the invented fixture | 41 of 41 (the 38 existing + 3 for Medium and Limit), no console errors |

### 15.2 Cable box and reel rounding

Item 7: cable is bought in boxes (Cat 6A, 1000 ft) or reels (fiber, 1000 / 2000 ft), and the
estimator rounded the Cable summary's order LF to boxes by hand. A cable setup may now state
`package_ft`, and a **Cable order** table rounds each cable type's pooled order LF up to whole
packages. Built on `wip/div27-cable-boxes` from `28ea3cc`. The decisions are in the spec's
Decisions ("Recorded while building item 7").

| File | Change |
|---|---|
| `web/src/lib/cable.js` | `packageFt`, `usesPackageSizes` (the gate), `cableOrderRollup` (per `by_cable_type` group: pooled order LF, boxes = ceil(order / size), purchased, leftover; blank on conflicting sizes, an unsized type and the blank type; the two warnings); `computeCableTakeoff().order` (null until a size is stated, its warnings appended to `summary.warnings`); `cableReportBlock` appends `order`; `CABLE_ORDER_HEADER` and `cableTables().order` (lengths through `L` / `lengthUnit`, boxes a count) |
| `web/src/lib/totals.js`, `web/src/lib/xlsx.js` | CSV *Cable order* section and Excel *Cable order* tab, each after every other cable section and tab, both gated |
| `web/src/lib/cableMarks.js`, `web/src/lib/markedset.js` | `cableLegend().order` (one line per sized type, present only with a size); the cover draws it after the key |
| `web/src/components/CableReportSection.jsx` | The Report's Cable order table and footnote, under the Cable summary |
| `web/src/components/CableSetupEditor.jsx` | **Box/reel** field (ft, or m in metric; blank removes the key; a metric entry is rounded to a millionth of a foot); a device-type change keeps it |
| `mcp/src/session.ts` | `edit_condition { cable_setup: { package_ft } }`: refused unless a number > 0, `null` deletes the key, kept through a device-type change, never minted; the reply's `cable.order` is the condition's cable-type row; `list_runs.order` and `takeoff_summary.cable.order`; `export_report.cable.order` through the report block |
| `mcp/src/tools.ts`, `mcp/src/outputs.ts` | The `package_ft` input (null or positive), `cableOrderRow` / `cableOrderBlock` on the four replies, `package_ft` on the setup shape, three descriptions. No new tool (57 / 59 / 11) |
| `protocol/v1/condition.schema.json`, `protocol/INVENTORY.md`, `protocol/test/current-records.test.mjs` | `cable_setup.package_ft` (number, exclusive minimum 0), an inventory row, a conforming case and three that do not (0, −1, a string). Generated: `protocol/README.md`, `mcp/src/protocol.generated.ts` |
| `web/test/cableBoxes.test.ts`, `web/test/fixtures/cableBoxes.base.ts` (new), `mcp/test/cable.test.ts` | Tests below |
| Docs | `USER_GUIDE.md` (Boxes and reels), `AGENT_GUIDE.md` (two rows), `MCP.md`, `mcp/README.md` (`edit_condition` row), `docs/wiki/status.md` (+ regenerated `wiki.generated.ts`), `FEATURES.md`, `CHANGELOG.md`, the spec's Decisions |

`TakeoffCanvas.jsx` is not touched: the editor and the Report section are already mounted, and
condition templates copy the whole cable setup.

**Tests.** `web/test/cableBoxes.test.ts` (11): the field's validity and gate; CAT6A net
31,752.34 × 1.12 = 35,562.62 LF at 1000 ft → 36 boxes, 36,000 purchased, 437.38 left over, with
the summary rows and totals equal to the same takeoff without a size; three 400 LF conditions of
one CAT6A → 2 boxes pooled where per-condition rounding gives 3, and 600 + 700 → 2 either way;
one condition sizing its type, an exact multiple (2,000 at 1000 → 2, 0 left over), nothing linked
→ 0; conflicting 1000 / 500 → the row blank with `package_conflict`, the exact warning, the other
type unaffected (500 LF on a 2000 ft reel → 1, 1,500 left over), 304.8 m and 1000 ft the same
size, the CSV row blank not 0; an unsized type and the blank type blank, with the blank-type
warning only when it states a size; ×3 at 10% (400 → 1,320 → 2 boxes, 680 left over); metric
(`Order m` 10,839.49, `Box/reel m` 304.8, 36, 10,972.8, 133.31); the exports (the CSV section
appended after the base CSV, `cable.order` last in the JSON block, the *Cable order* tab last in
both workbooks, the cover lines); every export of an invented cable takeoff (CSV and workbook,
imperial and metric, report JSON, cable tables, cover legend) hashing to the SHA-256 printed on
`28ea3cc`, with no size and with each of 0, −1000 and `"1000"`; a document round trip.
`mcp/test/cable.test.ts` (+2): over the wire, three schema refusals writing nothing; a size on
DATA-1 → the reply's row and `order` on `list_runs`, `takeoff_summary` and `export_report` (CAT6A
292.32 → 1 box, 707.68 left over; CAT6 blank), totals unchanged; a type change keeps it; a 500 ft
conflict → blank and the warning; one size → the two conditions pool into one box; export →
import keeps it; the marked-set cover prints `Cable order: CAT6A: 1 box of 1,000 LF · …`; `null`
clears it and `list_runs`, `takeoff_summary.cable` and `export_report.cable` return to their bytes
from before; `undo_last` restores it. A direct `Session.editCondition` refuses 0, −5, NaN and a
string.

#### Check record (this container: Node 22, root, two other agents building in parallel)

| Check | Result |
|---|---|
| `web` typecheck, lint, build | pass |
| `web` cable test files (`test/cable*.test.ts`) | 102 of 102 pass (11 new) |
| `web` `npm test` | 3,608 tests: 3,596 pass, 1 fail, 7 cancelled, 4 skipped. `pictures.test.ts` and 5 in `stageOcrModel.test.ts` as on the base commit; `planSearch.test.ts` (file timeout) and `sheetName.test.ts` "cost grows about linearly" (13.4× for 4× under load) pass alone, 115 of 115 |
| `web/bench/results.json` | unchanged (not touched) |
| `mcp` typecheck; all test files as CI runs them | pass; 322 tests, 321 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root, as in §10) |
| `mcp` check:tool-count (57 / 59 / 11), check:wiki, check:protocol-resources | pass after `-- --write` |
| `protocol` `npm run check` | 62 tests pass; docs match 11 schemas (after `node protocol/scripts/check-docs.mjs --write`) |
| `node scripts/check-doc-links.mjs` | pass |
| Browser, built app, `make-cable-fixture.mts` fixture (scratch script, not committed) | 10 of 10: no Cable order table before a size; **Box/reel ft** blank; 1000 entered → the Report's table reads `CAT6A · 170.98 · 1000 · 1 · 1000 · 829.02`; a device-type change keeps 1000; clearing it removes the table; no console errors |

### 15.3 The workbook from MCP

Item 8: only the canvas Report wrote the `.xlsx` workbook, so a bidding agent rebuilt its tabs
from `export_report`'s JSON by hand. `export_report { xlsx: true }` (or `xlsx_path`) now writes the
same workbook, built by the same code: `reportWorkbook` for the tabs and `buildXlsx` for the
bytes, both in `web/src/lib/xlsx.js`, as `export_marked_pdf` calls `markedset.js`. The default
path is `<plan> - report.xlsx` beside the plan, after `export_marked_pdf`'s naming. The reply is
the unchanged report document plus `xlsx: { path, tabs }`; without the option the reply and the
files on disk are as before. No new tool (57 default / 59 gated / 11 setup).

| File | Change |
|---|---|
| `web/src/lib/xlsx.js` | `buildXlsx(sheets, { producer })`: an opt-in stamp in `docProps/core.xml` (`dc:creator`) and `docProps/app.xml` (`Application`), with their content types and root relationships. The canvas passes no producer, so its download is unchanged. `xlsxProvenance(bytes)` reads the stamp and `lastModifiedBy` back, inflating only the two `docProps` parts |
| `mcp/src/session.ts` | `reportBase()`, the prelude `exportReport` already ran (roll takeoff, cable takeoff, the materials ctx, the rows), now shared with `reportWorkbookArgs()`, which assembles what `ReportPanel.jsx`'s `exportXlsx` hands `reportWorkbook`: rows, BASE `sheetTotals`, `shapesDetail`, `sheetLabelGroupedRows` (floor × room), the cable takeoff, and the CSV profile at default visibility plus the spec, labor, roll and cable columns exactly when the canvas adds them. Sheet label: the sheet number, else the key (the cable block's label). Imperial, as `export_report` is |
| `mcp/src/workbook.ts` (new) | Default path, the overwrite check, build with producer `OpenTakeoff`, the sanitized tab names. A stale install without `fflate` gets an error that says to run `npm install` |
| `mcp/src/safewrite.ts` | `xlsx` kind and `XLSX_PRODUCER`: a workbook is ours only when it is a zip whose `dc:creator` and `Application` both read `OpenTakeoff` and that has no `lastModifiedBy`. Excel and LibreOffice rewrite `Application` and add `lastModifiedBy` on save, so a workbook the estimator priced and saved is refused, as is a canvas download (no stamp) |
| `mcp/src/tools.ts`, `mcp/src/outputs.ts` | `export_report` gains `xlsx` and `xlsx_path`; `overwrite` covers both files; every destination is checked before either file is written; `xlsx: false` with `xlsx_path` and one path for both files are refused. Output schema: optional `xlsx` |
| `mcp/package.json`, `mcp/package-lock.json` | `fflate` `^0.8.3`, already a web dependency at that version. The dist keeps packages external (`--packages=external`) and `buildXlsx` imports `fflate` lazily, so without the dependency the built server, run from `mcp/dist` with only `mcp/node_modules`, could not write a workbook. The lockfile entry is the one `npm install --package-lock-only --offline` produces; `npm ci --offline` from the edited lockfile installs `fflate` 0.8.3 |
| Docs | `docs/MCP.md`, `mcp/README.md` (`export_report` row; Writing to disk), `docs/AGENT_GUIDE.md` (the standard finish, the cable section, one refusal row), `CHANGELOG.md`, `FEATURES.md` |
| `mcp/test/xlsx.test.ts` (new, 6 tests) | Flooring session: the five tab names, and every cell of every tab equal to `reportWorkbook` for inputs assembled literally as `ReportPanel.jsx` does (CPT-1 150 SF, 165 with waste; Adhesive 3 gal; room 101 on floor × room); the JSON part of the reply equal to a plain `export_report`. The file: a zip read with `node:zlib` alone; `[Content_Types].xml`, `workbook.xml`, both `.rels`, every worksheet and both `docProps` parts well formed, every part with a content type. `xlsx_path` with `path`: the JSON file carries no `xlsx` block. Cable session: Cable summary and Cable runs after the five, cells equal, the summary's DATA-1 cable LF equal to the JSON's; tagging the route trunk adds Pathway, and the re-export replaces its own workbook. Refusals: a stranger's file (bytes untouched, the JSON not written either), a canvas download, a workbook re-saved by Excel (and with only `lastModifiedBy` added); `overwrite: true` replaces it; no plan loaded |
| `web/test/xlsx.test.ts` (+2) | No producer: no `docProps` parts, no `docProps` content types or relationships. Producer: the stamp, content types and relationships; `xl/` parts identical with and without it; `xlsxProvenance` on stamped, unstamped and non-zip bytes; the producer name escaped |

Not done: the session has no display-units setting, column picker, custom columns or label
vocabulary, so the workbook is imperial with the CSV's default columns, ad hoc room labels
sorted, as `export_report` is; a canvas workbook of the same takeoff with metric units or
a customized column set differs in exactly those ways. The canvas download is not stamped (it
is left byte-identical), so a canvas workbook at the MCP default path is refused rather than
replaced.

#### Check record (this container: Node 22, root, other agents building in parallel)

| Check | Result |
|---|---|
| `mcp/test/xlsx.test.ts` | 6 of 6 |
| `mcp` all test files as CI runs them | 326 tests: 325 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root) |
| `mcp` typecheck, check:tool-count (57 / 59 / 11), check:wiki, check:protocol-resources | pass; no regeneration needed |
| `mcp` build, smoke:dist | pass; `dist/server-core.js` imports `fflate` only through the two lazy `import("fflate")` calls in `buildXlsx` and `xlsxProvenance` |
| The dist with only mcp's dependencies | `npm ci --offline` from this branch's `mcp/package.json` and lockfile into a scratch folder, the built dist copied beside it, driven over stdio: `export_report { xlsx: true }` on a flooring + cable takeoff with a trunk route wrote the eight tabs, and a second export replaced it. The same dist against an install without `fflate` returns the `npm install` error and writes nothing |
| Canvas `buildXlsx` bytes, `28ea3cc` vs this branch, clock frozen | identical SHA-256 |
| `web` typecheck, lint, build | pass; `web/bench/results.json` and `oneclick.ts` untouched |
| `web/test/xlsx.test.ts` | 17 of 17 |
| `web` `npm test` | 3,597 tests: 3,584 pass, 1 fail, 8 cancelled, 4 skipped, at load 12. The fail is `sheetName.test.ts` "cost grows about linearly" (a timing test); the cancellations are `pictures.test.ts`, 5 in `stageOcrModel.test.ts`, and the `ocrPageRead.test.ts` and `planSearch.test.ts` file timeouts. Run alone: `sheetName` 10 of 10, `ocrPageRead` 96 of 96, `planSearch` 105 of 105 |
| `protocol` `npm run check`, `node scripts/check-doc-links.mjs` | pass (62 tests; 11 schemas); doc links pass |

### 15.4 Combined check record (items 6–8 merged; Node 22, root, run alone)

| Check | Result |
|---|---|
| `web/test/cableCombined.test.ts` | 2 of 2: round one, plus copper checked at 295 / fiber at its stated 500 / coax unchecked, boxes per cable type, and the workbook's Cable summary, Cable runs and Cable order tabs on one takeoff |
| `web` cable and workbook test files | 131 pass |
| `web` `npm test` | 3,629 tests: 3,618 pass, 1 fail, 6 cancelled. The fail is a timing test in `ocrPageRead.test.ts`, which also fails intermittently on `28ea3cc` here (a different test of the same file on a second run); the cancellations are `pictures.test.ts` and 5 in `stageOcrModel.test.ts`, as on the base |
| `web` typecheck, lint, build, OCR dist check; `web/bench/results.json` | pass; unchanged |
| `mcp` all test files as CI runs them | 330 tests: 329 pass, 1 fail (`safewrite` "an unreadable file fails CLOSED", root) |
| `mcp` typecheck, tool count (57 / 59 / 11), wiki, protocol resources, build, dist smoke | pass |
| `protocol` check, doc links | pass |
| Browser `verify-cable-runs.mjs` | 41 of 41, no console errors |
| A marked set with no cable work vs `28ea3cc`, clock frozen | identical SHA-256 |

After pulling, run `npm install` in `mcp/`: the workbook export needs `fflate` (the web app's own zip writer, same version).
