# Schematic edits: the edit layer

People edit a project's schematic in the Brink app (the EasySchematic editor in the Schematic tab). brink-merge regenerates the schematic from scratch on every import. This page describes how the edits survive that.

**The rule:** edits are a layer over the generated schematic, never written into it.
- An import's rows (`brink_schematic_nodes`, `brink_schematic_connections`) stay exactly what brink-merge generated from the takeoff.
- Each edit is a row in `brink_schematic_edits`, keyed by a **stable target** that a re-import of the same takeoff reproduces.
- Every render applies the project's active edits on top of the rows. That includes the app, `get_schematic` / `export_schematic`, and the CLI's `--out` with `--db`.
- Every import applies them again. An edit the new import cannot carry becomes a **warning issue** on that import.
- An edit is never silently dropped, and never applied to something it was not made on.

Code: `src/ids.ts` (stable ids), `src/edits.ts` (apply, validate, the shared SQL), `src/render.ts` (rows to file), and `src/db/repository.ts` (`renderEdited`, `loadActiveEdits`, `recordEdit`, `revertEdit`). The app's Worker imports the same `edits.ts`, so there is one implementation.

## Stable ids

Node and edge ids come from OpenTakeoff's own ids, never from the order of shapes or runs in an export (`src/ids.ts`):

| Element | Id | From |
|---|---|---|
| Device | `dev-<shape id>-<copy>` | The OpenTakeoff count shape. `copy` is 1..multiplier. |
| TR patch panel | `tr-<TR shape id>` | The TR marker shape |
| Room | `room-<slug>-<fnv1a(label)>` | The room label (the shapes' label, or the TR's name) |
| Generated cable | `cable-<run id>-<copy>-<cable n>` | The OpenTakeoff cable run |
| Issues note | `note-brink` | |
| Connection a person added | key `conn\|<source>\|<sourceHandle>\|<target>\|<targetHandle>`, edge id `conn-<hash of key>` | Its two endpoints |

Imports made before this change used `device-<n>` / `edge-<run8>-<copy>-<k>` / `room-<n>`. Those imports' rows keep their old ids. Edits can only be made on the current import, which a re-import regenerates with the stable ids.

## The table

`supabase/migrations/20261027120000_brink_schematic_edits.sql` (additive; RLS on, no policies; in `supabase_realtime`).

| Column | Meaning |
|---|---|
| `id` | uuid |
| `project_id` | Edits belong to the project, not to an import, so they carry across imports. |
| `target_key` | The stable id above |
| `kind` | `move`, `rename`, `room_assign`, `connect`, `disconnect` (`property` is reserved; nothing writes it, and it is reported if found) |
| `payload` | jsonb; see below |
| `target_context` | What the target was when edited (label, node type, condition key, room / endpoint labels), for messages after it is gone |
| `editor_email` | From the verified Cloudflare Access JWT |
| `editor_auth` | `cloudflare-access`, `dev-bypass` (local `wrangler dev` only), or `brink-merge` (a brink-merge process: tests and scripts, never the app) |
| `client_ref` | Opaque id of the browser tab that wrote it, so that tab ignores its own realtime echo. Not an identity. |
| `base_import_id` | The import the editor was looking at |
| `created_at` | |
| `superseded_at`, `superseded_by` | Set when a newer edit of the same (target, kind) replaces this one |
| `reverted_at`, `reverted_by` | Set when someone reverts it |

The table is **append-only history**. An edit is *active* while it is neither superseded nor reverted, and the partial unique index allows one active edit per (project, target, kind). A rename followed by another rename leaves one active rename, and the first stays in the table with `superseded_by` pointing at the second.

## Kinds and payloads

| Kind | Target | Payload | Applies as |
|---|---|---|---|
| `rename` | Any node | `{ label }` | `data.label` |
| `room_assign` | Device or note | `{ room }` (room id, or null for none) | `parentId` |
| `move` | Any node | `{ x, y, parent, width?, height? }` | `position`, relative to `parent`; rooms may also carry a size |
| `disconnect` | Generated cable | `{}` | The edge is removed |
| `connect` | `conn\|…` key | `{ source, sourceHandle, target, targetHandle, signalType, label?, cableLength? }` | A new edge, `data.brink = { source: "edit", editId, editor }` |

Removing a connection a person added reverts its `connect` edit (no `disconnect` row).

Edits are applied in this order: renames, then room changes, then moves (positions are relative to the room), then disconnects, then connects. Within a kind they are applied oldest first. The result is deterministic.

## Re-import rules

On every import (CLI `--db`, MCP `import_takeoff`, and the re-merge `map_condition` runs), brink-merge loads the project's active edits and applies them to the new schematic (`merge(..., { edits })`). For each edit, exactly one thing happens:

| Situation | Result |
|---|---|
| The target and everything the edit names are in the new import | **Applied** |
| The target is gone (the device was deleted from the takeoff, a run was removed), or the room / port it names is gone | Warning **`schematic_edit_orphaned`**. The edit is not applied. |
| The target exists, but applying the edit would change its meaning: a move made inside a room the element is no longer in, or a connection to a port that now carries a generated cable | Warning **`schematic_edit_conflict`**. The edit is not applied. |

Either warning:
- names the editor, the date, what the edit did (using the stored `target_context`, since the target may be gone) and why it was not applied
- carries `refs: { editId, targetKey, kind, editor }`
- is stored in `brink_issues` for that import and appears on the BOM as an issue line, so it shows in the app's BOM & Issues tab
- counts toward the import's warnings (the CLI exits 0 unless `--strict`)

The edit itself **stays active**. When its target comes back in a later import (for example, the device is restored in the takeoff), it applies again. To drop it for good, revert it.

## Writing edits (the app)

The app writes through `POST /api/projects/:id/schematic/edits`; see `dashboard/README.md`. The Worker:
- **Identity.** Requires a verified Cloudflare Access identity, and takes `editor_email` from it.
- **Validation.**
  - Validates each op's shape (`parseEditInput`).
  - Checks the op against the current import's rendered schematic, with earlier ops of the same request applied. An op that would be an orphan or a conflict is refused, not stored.
- **Concurrency.** Each op says which active edit of its (target, kind) the editor last saw (`expect`). If another person's edit has landed since, the op is refused as a **conflict**: the newer saved edit wins, and the editor's page reloads it and says so.
- **Writes.** Supersedes and inserts in one transaction, with the shared SQL in `src/edits.ts`.

`recordEdit` / `revertEdit` in `src/db/repository.ts` use the same SQL. They are used by tests and scripts (`editor_auth = 'brink-merge'`).

## Database role for the app (owner)

The tables have RLS on with no policies. The app's Hyperdrive role therefore has to bypass RLS (or be the table owner). It needs:
- `SELECT` on the `brink_*` tables (Phase 1 reads)
- `INSERT` on `brink_schematic_edits`
- `UPDATE (superseded_at, superseded_by, reverted_at, reverted_by)` on `brink_schematic_edits`

Nothing in the migrations creates roles. The owner creates and grants one on the hosted database.
