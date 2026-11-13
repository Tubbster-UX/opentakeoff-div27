# Takeoff edits: the edit layer

People edit a project's takeoff in the Brink app (the OpenTakeoff canvas in the Takeoff tab). The takeoff itself comes from OpenTakeoff or an agent, as an export (`export_takeoff` + `export_report`) that brink-merge imports. This page describes how a person's edits are kept without rewriting that export, and how the BOM and schematic follow them.

**The rule:** edits are a layer over the import's raw takeoff, never written into it.
- `brink_imports.takeoff` stays exactly the file that was imported: the **machine original**. Its `takeoff_sha256` is the hash of the exported file.
- Each edit is a row in `brink_takeoff_edits`, keyed by OpenTakeoff's own stable ids (shape, condition and sheet ids).
- The takeoff people see is the raw takeoff with the project's active edits applied (`applyTakeoffEdits`). The app renders it; so does `renderTakeoff` in `src/db/repository.ts`.
- Every import applies them: the app's save, the CLI's `--db` and the MCP `import_takeoff` / `map_condition` runs all pass the project's active takeoff edits to `merge(..., { takeoffEdits })`. The BOM and the schematic are built from the edited takeoff.
- An edit the new import cannot carry becomes a **warning issue** on that import. It is never silently dropped, and never applied to something it was not made on.

Code: `src/takeoffEdits.ts` (validate, apply, diff, the shared SQL), `src/pipeline.ts` (`merge`), `src/db/repository.ts` (`writeMerge`, `loadActiveTakeoffEdits`, `renderTakeoff`, `recordTakeoffEdit`, `revertTakeoffEdit`). The app's Worker and the canvas adapter in the browser import the same `takeoffEdits.ts`, so there is one implementation.

## The tables

`supabase/migrations/20261028120000_brink_takeoff.sql` (additive: two new tables and one bucket; RLS on, no policies; both tables in `supabase_realtime`).

### `brink_takeoff_edits`

| Column | Meaning |
|---|---|
| `id` | uuid |
| `project_id` | Edits belong to the project, not to an import, so they carry across imports. |
| `target_type`, `target_key` | `shape` + the shape id, `condition` + the condition id, or `sheet` + the sheet id (`plan.pdf`, `plan.pdf#2`) |
| `kind` | `shape_put`, `shape_delete`, `condition_put`, `sheet_scale` (the table checks that each kind goes with its target type) |
| `payload` | jsonb; see below |
| `target_context` | What the target was when edited: a hash of the machine original's record (`baseHash`, null when the target was not in the import), its finish tag, measure role and label, for messages |
| `editor_email` | From the verified Cloudflare Access JWT |
| `editor_auth` | `cloudflare-access`, `dev-bypass` (local `wrangler dev` only), or `brink-merge` (a brink-merge process: tests and scripts, never a person) |
| `client_ref` | Opaque id of the browser tab that wrote it, so that tab ignores its own realtime echo. Not an identity. |
| `base_import_id` | The import the editor was looking at |
| `created_at` | |
| `superseded_at`, `superseded_by` | Set when a newer edit of the same target replaces this one |
| `reverted_at`, `reverted_by` | Set when someone reverts it |

Append-only history, like `brink_schematic_edits`: one active edit per (project, target type, target). A shape that is reshaped twice has one active `shape_put`; the first stays in the table with `superseded_by` pointing at the second. Deleting it afterwards supersedes the put with a `shape_delete`.

### `brink_sheets`

The plan PDFs a project's takeoff is drawn on. The bytes are in Supabase Storage, in the private bucket `brink-plans`, at `<project id>/<sheet row id>/<sha256>.pdf`; this table is the index.

| Column | Meaning |
|---|---|
| `name` | The file name, which is OpenTakeoff's sheet key for page 1 (page n is `name#n`) |
| `storage_bucket`, `storage_path`, `content_type`, `byte_size`, `sha256` | The object |
| `page_count` | Pages in the file, as the uploader's pdf.js read it (null when not known) |
| `rev` | 1, then +1 each time a file of the same name with other bytes replaces it |
| `uploaded_by`, `uploaded_auth`, `client_ref` | Who uploaded it (the Access identity), as for edits |
| `replaced_by`, `removed_at`, `removed_by` | A replaced or removed file keeps its row and its object |

One current file per (project, name) (partial unique index). A sheet's **scale is not stored here**: it is part of the takeoff (`sheets[].units_per_px`), so a scale set in the app is a `sheet_scale` edit, and brink-merge reads it from the edited takeoff like any other.

The bucket: private (no public URLs), 100 MB per object, `application/pdf` only. With no `storage.objects` policies, only the service role reaches it. The app's Worker holds that key; browsers read a sheet through the Worker (`GET /api/projects/:id/sheets/:sheet/file`). The migration creates the bucket only where Supabase Storage is installed (not on a plain Postgres or PGlite).

## Kinds and payloads

| Kind | Payload | Applies as |
|---|---|---|
| `shape_put` | `{ shape }`: the whole OpenTakeoff shape record (`id` = the target, `sheet_id`, `condition_id`, `measure_role`, `verts_norm`, `computed`, `origin`, …) | Replaces the shape with that id, or adds it |
| `shape_delete` | `{}` | Removes the shape |
| `condition_put` | `{ condition }`: the whole condition record | Replaces the condition with that id, or adds it |
| `sheet_scale` | `{ units_per_px, scale_source?, scale_confirmed? }` (`units_per_px: null` clears it) | Sets the sheet's entry in `sheets[]` |

Order: conditions, then scales, then deletes, then puts; oldest first within a kind. A shape's quantities are the ones OpenTakeoff's canvas stored in `computed` when the person drew it; brink-merge recomputes nothing from geometry, as for an export.

## Machine originals and review

A shape is **machine work** when its `origin.actor` is `agent` or its `origin.method` is anything but `manual` (OpenTakeoff's own test, `web/src/lib/provenance.js`). When an edit changes machine work:
- the raw takeoff keeps the machine's record unchanged;
- the applied shape keeps the machine's `origin.actor` and `origin.method` (an edit cannot relabel agent work as a person's);
- it carries the machine's original ring in `origin.proposed_verts_norm`. OpenTakeoff's canvas freezes that ring on the first edit; if an edit arrives without it, the layer sets it from the original, and an original that already had a frozen ring keeps that one.

**Only a person accepts machine work.** `origin.reviewed` can be turned on only by an edit from a verified person (`cloudflare-access`, or `dev-bypass` locally). An edit written by a process (`brink-merge`) that tries is applied with `reviewed` left as it was, and a `takeoff_edit_review_refused` warning says so. Nothing in the layer creates approval seals; OpenTakeoff's `approvals` are not kept by it (see below). A schema-valid edit does not authenticate its author: the identity is the Access JWT the Worker verified, recorded in `editor_email` / `editor_auth`.

## Re-import rules

For each active edit, exactly one thing happens on an import:

| Situation | Result |
|---|---|
| The target (and, for a shape, its condition) is in the takeoff | **Applied** |
| `shape_delete` of a shape the takeoff does not have, or `shape_put` on a condition it does not have | Warning **`takeoff_edit_orphaned`**. Not applied. |
| The machine original changed since the edit was made (a later export of the same shape or condition: `baseHash` differs) | Applied, with warning **`takeoff_edit_base_changed`**: the person's edit wins over the newer machine version, and the issue says so |
| A process tried to mark machine work reviewed | Applied without that flag, warning **`takeoff_edit_review_refused`** |

The warnings carry `refs: { editId, target, kind, editor, reason? }`, are stored in `brink_issues` and show in the app's BOM & issues tab. The edit stays active: when its target comes back, it applies again. To drop it for good, revert it.

### What the BOM does with an edited takeoff

- **Counts** (devices, TRs) and route pathway LF come from the edited takeoff's shapes. A device or TR count that differs from OpenTakeoff's report because of an edit is a **`count_edited`** warning, not a `report_mismatch` error.
- **Cable lengths** come only from OpenTakeoff's report (`export_report`), which is not re-run here. A run whose route shapes were edited keeps the report's cable length, with a **`route_edited`** warning; a run whose device was deleted keeps its cables, with **`run_device_edited`**. Re-exporting the report from OpenTakeoff updates the cable math.
- The report-vs-takeoff pairing check runs on the raw export, as exported.

## Writing edits (the app)

The app's canvas autosaves its whole document. The adapter in the browser (`dashboard/web/src/ot/store.ts`) diffs it against the document it loaded (`diffTakeoff`) and sends only the changes to `POST /api/projects/:id/takeoff/edits`. The Worker (`dashboard/src/takeoff.ts`):
- **Identity.** Requires a verified Cloudflare Access identity, and takes `editor_email` from it.
- **Validation.** Each op's shape (`parseTakeoffEditInput`).
- **Concurrency.** Each op says which active edit of its target the editor last saw (`expect`). If someone else's edit landed since, the op is refused as a **conflict**: the saved edit wins, and the canvas reloads it and says so (last write per target is never silent).
- **Writes and the import.** In one transaction holding the project row lock: supersede + insert each edit, then re-run the project's import from the current import's stored raw input, with the catalog, the schematic edits and the takeoff edits, and make it the current import (`writeMerge`). The BOM & issues and Schematic tabs see the new import live through the relay.

What the canvas changes that the layer does **not** keep (markups, RFIs, approval seals, rules, estimate settings, condition columns, removing a condition) is listed in the canvas's status bar as "will not be saved", never dropped silently. Per-tab view state (open sheets, groups, the condition palette) stays in the browser tab.

`recordTakeoffEdit` / `revertTakeoffEdit` in `src/db/repository.ts` use the same SQL for tests and scripts (`editor_auth = 'brink-merge'`).

## Database role for the app (owner)

In addition to the schematic edit grants (`docs/schematic-edits.md`), the app's Hyperdrive role needs:
- `INSERT` on `brink_takeoff_edits`, and `UPDATE (superseded_at, superseded_by, reverted_at, reverted_by)` on it
- `INSERT` on `brink_sheets`, and `UPDATE (replaced_by, removed_at, removed_by)` on it
- `INSERT` on `brink_imports`, `brink_bom_lines`, `brink_issues`, `brink_schematics`, `brink_schematic_nodes`, `brink_schematic_connections`, and `UPDATE (current_import_id)` on `brink_projects`: a takeoff save re-runs the import

The Worker reaches Storage with the service-role key (`SUPABASE_SERVICE_ROLE_KEY`, a Worker secret), over Storage's REST API.
