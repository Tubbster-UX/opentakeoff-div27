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
