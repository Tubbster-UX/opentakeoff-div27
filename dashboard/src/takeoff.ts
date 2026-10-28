// The Takeoff tab's server side: the plan sheets (PDFs in Supabase Storage), the
// takeoff as people see it (the import's raw takeoff + the takeoff edit layer), and
// the edit writes, which re-run the project's import so the BOM and the schematic
// follow. The edit logic and the import pipeline are brink-merge's own
// (src/takeoffEdits.ts, src/pipeline.ts, src/db/repository.ts: imported here, not
// copied), so the app and every CLI / MCP import agree on what an edit means.
// Rules: brink-merge/docs/takeoff-edits.md.
//
// Writes run in one transaction per request, holding the project row lock (SELECT
// ... FOR UPDATE), so two editors' saves for one project are serialized. Each op
// carries `expect` (the active edit of its target the canvas last saw); an op whose
// target has a newer active edit is refused as a conflict: the saved edit wins and
// the canvas reloads it. Nothing is ever written into brink_imports.takeoff.
import { merge } from "../../brink-merge/src/pipeline.js";
import {
  loadActiveEdits, loadActiveTakeoffEdits, loadCatalog, loadImportInput, writeMerge,
} from "../../brink-merge/src/db/repository.js";
import type { Queryable as MergeQueryable } from "../../brink-merge/src/db/db.js";
import {
  applyTakeoffEdits, INSERT_TAKEOFF_EDIT_SQL, parseTakeoffEditInput, SUPERSEDE_TAKEOFF_EDIT_SQL, takeoffEditFromRow, takeoffTargetContext, targetTypeOf,
  type TakeoffEdit, type TakeoffEditRow,
} from "../../brink-merge/src/takeoffEdits.js";
import type { Identity } from "./access.js";
import type { Queryable } from "./db.js";
import type { Env } from "./env.js";
import { HttpError } from "./schematic.js";
import type { SheetSummary, SheetUploadResponse, TakeoffEditRequest, TakeoffEditResponse, TakeoffEditResult, TakeoffEditSummary, TakeoffView } from "./shared/protocol.js";
import { getObject, PLANS_BUCKET, putObject } from "./storage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OPS = 500;
/** Supabase Storage's bucket limit (the migration sets the same on the bucket). */
export const MAX_SHEET_BYTES = 100 * 1024 * 1024;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const asMerge = (db: Queryable) => db as unknown as MergeQueryable;

function editSummary(e: TakeoffEdit): TakeoffEditSummary {
  return { id: e.id, target_type: e.targetType, target_key: e.targetKey, kind: e.kind, editor_email: e.editorEmail, editor_auth: e.editorAuth, created_at: e.createdAt };
}

const SHEET_COLUMNS = "id, name, byte_size, sha256, page_count, rev, uploaded_by, created_at, storage_bucket, storage_path";

function sheetSummary(r: Record<string, unknown>): SheetSummary {
  return {
    id: String(r.id),
    name: String(r.name),
    byte_size: Number(r.byte_size),
    sha256: String(r.sha256),
    page_count: r.page_count == null ? null : Number(r.page_count),
    rev: Number(r.rev),
    uploaded_by: String(r.uploaded_by),
    created_at: iso(r.created_at),
  };
}

/** A project's current plan files, oldest first. */
export async function currentSheets(db: Queryable, projectId: string): Promise<SheetSummary[]> {
  const { rows } = await db.query(`select ${SHEET_COLUMNS} from brink_sheets where project_id = $1 and removed_at is null and replaced_by is null order by created_at, name`, [projectId]);
  return rows.map(sheetSummary);
}

/** GET /api/projects/:id/takeoff. null: no such project; `{ noImport: true }`: no current import. */
export async function readTakeoff(db: Queryable, projectId: string): Promise<TakeoffView | { noImport: true } | null> {
  await db.query("begin transaction isolation level repeatable read read only");
  try {
    const p = (await db.query("select id, name, current_import_id from brink_projects where id = $1", [projectId])).rows[0];
    if (!p) return null;
    const importId = p.current_import_id as string | null;
    if (!importId) return { noImport: true };
    const input = await loadImportInput(asMerge(db), importId);
    const edits = await loadActiveTakeoffEdits(asMerge(db), projectId);
    const applied = applyTakeoffEdits(input.takeoff, edits);
    return {
      project_id: projectId,
      project_name: String(p.name),
      import_id: importId,
      document: applied.takeoff as unknown as Record<string, unknown>,
      edits: edits.map(editSummary),
      issues: applied.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message, ...(i.refs ? { refs: i.refs } : {}) })),
      sheets: await currentSheets(db, projectId),
      readAt: new Date().toISOString(),
    };
  } finally {
    await db.query("commit");
  }
}

/** Shape-check the request body (ops are checked one by one later). */
export function parseTakeoffEditRequest(body: unknown): TakeoffEditRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.importId !== "string" || !UUID.test(b.importId)) throw new HttpError(400, "importId must be the import's uuid");
  if (typeof b.clientRef !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.clientRef)) throw new HttpError(400, "clientRef must be 8-64 characters of [A-Za-z0-9_-]");
  if (!Array.isArray(b.ops) || b.ops.length === 0 || b.ops.length > MAX_OPS) throw new HttpError(400, `ops must be an array of 1-${MAX_OPS} edits`);
  for (const op of b.ops) {
    if (!op || typeof op !== "object" || Array.isArray(op)) throw new HttpError(400, "each op must be an object");
    const o = op as Record<string, unknown>;
    if (o.expect !== undefined && o.expect !== null && (typeof o.expect !== "string" || !UUID.test(o.expect))) throw new HttpError(400, "expect must be an edit id or null");
    if (o.kind === "revert" && (typeof o.edit !== "string" || !UUID.test(o.edit))) throw new HttpError(400, "revert needs the edit id");
  }
  return { importId: b.importId, clientRef: b.clientRef, ops: b.ops as TakeoffEditRequest["ops"] };
}

/**
 * POST /api/projects/:id/takeoff/edits. One transaction: lock the project, write each op to the layer, then (when
 * anything was saved or reverted) re-run the project's import from the current import's raw input with the
 * catalog, the schematic edits and the takeoff edits, and make it the current import.
 */
export async function writeTakeoffEdits(db: Queryable, projectId: string, req: TakeoffEditRequest, who: Identity): Promise<TakeoffEditResponse> {
  await db.query("begin");
  try {
    const p = (await db.query("select current_import_id from brink_projects where id = $1 for update", [projectId])).rows[0];
    if (!p) throw new HttpError(404, "no such project");
    const importId = p.current_import_id as string | null;
    if (!importId) throw new HttpError(409, "the project has no current import");
    const input = await loadImportInput(asMerge(db), importId);
    const active = await loadActiveTakeoffEdits(asMerge(db), projectId);
    const byTarget = new Map(active.map((e) => [`${e.targetType}|${e.targetKey}`, e]));
    const results: TakeoffEditResult[] = [];
    let changed = 0;

    for (const [i, op] of req.ops.entries()) {
      if (op.kind === "revert") {
        const id = (op as { edit: string }).edit;
        const target = active.find((e) => e.id === id);
        if (!target) {
          results.push({ i, status: "conflict", error: "that edit is no longer active (already reverted or replaced)", current: null });
          continue;
        }
        await db.query("update brink_takeoff_edits set reverted_at = now(), reverted_by = $2 where id = $1", [id, who.email]);
        active.splice(active.indexOf(target), 1);
        byTarget.delete(`${target.targetType}|${target.targetKey}`);
        results.push({ i, status: "reverted", edit: id });
        changed++;
        continue;
      }
      const parsed = parseTakeoffEditInput(op);
      if (typeof parsed === "string") {
        results.push({ i, status: "invalid", error: parsed });
        continue;
      }
      const type = targetTypeOf(parsed.kind);
      const key = `${type}|${parsed.target}`;
      const current = byTarget.get(key) ?? null;
      const expect = (op as { expect?: string | null }).expect ?? null;
      if ((current?.id ?? null) !== expect) {
        results.push({ i, status: "conflict", error: current ? `${current.editorEmail} changed this at ${current.createdAt}` : "the edit you replaced was reverted", current: current ? editSummary(current) : null });
        continue;
      }
      if (parsed.kind === "shape_delete" && !input.takeoff.shapes.some((s) => s.id === parsed.target)) {
        // A shape that exists only as an edit (added in the app) is removed by reverting its put, not by a delete.
        if (current?.kind === "shape_put") {
          await db.query("update brink_takeoff_edits set reverted_at = now(), reverted_by = $2 where id = $1", [current.id, who.email]);
          active.splice(active.indexOf(current), 1);
          byTarget.delete(key);
          results.push({ i, status: "reverted", edit: current.id });
          changed++;
          continue;
        }
        results.push({ i, status: "invalid", error: `no shape ${parsed.target} in this takeoff` });
        continue;
      }
      const id = crypto.randomUUID();
      const context = takeoffTargetContext(input.takeoff, parsed);
      const old = (await db.query(SUPERSEDE_TAKEOFF_EDIT_SQL, [projectId, type, parsed.target, id])).rows[0];
      const row = (await db.query(INSERT_TAKEOFF_EDIT_SQL, [
        id, projectId, type, parsed.target, parsed.kind, JSON.stringify(parsed.payload), JSON.stringify(context), who.email, who.auth, req.clientRef, importId,
      ])).rows[0] as unknown as TakeoffEditRow;
      const saved = takeoffEditFromRow({ ...row, created_at: iso(row.created_at) });
      if (current) active.splice(active.indexOf(current), 1);
      active.push(saved);
      byTarget.set(key, saved);
      results.push({ i, status: "saved", edit: editSummary(saved), superseded: (old?.id as string | undefined) ?? null });
      changed++;
    }

    let reimport: TakeoffEditResponse["reimport"] = null;
    let nowImport = importId;
    if (changed) {
      // The import path, re-run: the stored raw export (never modified), today's catalog, both edit layers.
      const map = await loadCatalog(asMerge(db));
      const edits = await loadActiveEdits(asMerge(db), projectId);
      const takeoffEdits = await loadActiveTakeoffEdits(asMerge(db), projectId);
      const name = (await db.query("select name from brink_projects where id = $1", [projectId])).rows[0]!.name as string;
      const result = merge(input, map, { project: name, edits, takeoffEdits });
      const saved = await writeMerge(asMerge(db), input, result, { projectId });
      nowImport = saved.importId;
      reimport = { errors: saved.errors, warnings: saved.warnings };
    }
    await db.query("commit");
    return { importId: nowImport, editor: who.email, results, reimport };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Plan sheets.

/** A sheet name is OpenTakeoff's sheet key for page 1: a file name, without "#" (page keys use it) or path separators. */
export function checkSheetName(name: unknown): string {
  if (typeof name !== "string") throw new HttpError(400, "name is required");
  const n = name.trim();
  if (!n || n.length > 200) throw new HttpError(400, "name must be 1-200 characters");
  // eslint-disable-next-line no-control-regex
  if (/[#/\\\u0000-\u001f]/.test(n)) throw new HttpError(400, "name cannot contain #, / or \\");
  if (!/\.pdf$/i.test(n)) throw new HttpError(400, "name must end in .pdf");
  return n;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /api/projects/:id/sheets. The same bytes under the same name: unchanged. Other bytes: a new revision
 * (the old row and object stay, `replaced_by` points at the new row). The object is written before the row.
 */
export async function uploadSheet(env: Env, db: Queryable, projectId: string, nameRaw: unknown, pagesRaw: unknown, bytes: ArrayBuffer, who: Identity, clientRef: string | null): Promise<SheetUploadResponse> {
  const name = checkSheetName(nameRaw);
  if (bytes.byteLength === 0) throw new HttpError(400, "the file is empty");
  if (bytes.byteLength > MAX_SHEET_BYTES) throw new HttpError(413, "plan files are limited to 100 MB");
  const head = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength)));
  if (!head.includes("%PDF-")) throw new HttpError(415, "only PDF plans are stored; convert images and plan sets to PDF first");
  const pages = pagesRaw == null || pagesRaw === "" ? null : Number(pagesRaw);
  if (pages !== null && !(Number.isInteger(pages) && pages > 0 && pages < 100_000)) throw new HttpError(400, "pages must be a positive whole number");
  const sha = await sha256Hex(bytes);

  const prev = (await db.query(`select ${SHEET_COLUMNS} from brink_sheets where project_id = $1 and name = $2 and removed_at is null and replaced_by is null`, [projectId, name])).rows[0];
  if (prev && prev.sha256 === sha) return { sheet: sheetSummary(prev), unchanged: true };
  const id = crypto.randomUUID();
  const path = `${projectId}/${id}/${sha}.pdf`;
  await putObject(env, PLANS_BUCKET, path, bytes, "application/pdf");

  await db.query("begin");
  try {
    if (!(await db.query("select id from brink_projects where id = $1 for update", [projectId])).rows[0]) throw new HttpError(404, "no such project");
    const cur = (await db.query("select id, rev, sha256 from brink_sheets where project_id = $1 and name = $2 and removed_at is null and replaced_by is null", [projectId, name])).rows[0];
    if (cur) await db.query("update brink_sheets set replaced_by = $2 where id = $1", [cur.id, id]);
    const row = (await db.query(
      `insert into brink_sheets (id, project_id, name, storage_bucket, storage_path, content_type, byte_size, sha256, page_count, rev, uploaded_by, uploaded_auth, client_ref)
       values ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, $9, $10, $11, $12) returning ${SHEET_COLUMNS}`,
      [id, projectId, name, PLANS_BUCKET, path, bytes.byteLength, sha, pages, cur ? Number(cur.rev) + 1 : 1, who.email, who.auth, clientRef],
    )).rows[0]!;
    await db.query("commit");
    return { sheet: sheetSummary(row), ...(cur ? { revised: true as const, prevRev: Number(cur.rev) } : {}) };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  }
}

/** GET /api/projects/:id/sheets/:sheet/file: the object, proxied (the browser never holds a Storage credential). */
export async function sheetFile(env: Env, db: Queryable, projectId: string, sheetId: string): Promise<Response> {
  const row = (await db.query("select storage_bucket, storage_path, sha256, name from brink_sheets where id = $1 and project_id = $2", [sheetId, projectId])).rows[0];
  if (!row) throw new HttpError(404, "no such sheet");
  const obj = await getObject(env, String(row.storage_bucket), String(row.storage_path));
  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      // A sheet row's bytes never change (a new revision is a new row): cache it privately.
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${String(row.sha256)}"`,
      "content-disposition": `inline; filename="${String(row.name).replace(/["\\]/g, "_")}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

/** DELETE /api/projects/:id/sheets/:sheet: out of the plan set (row and object kept; takeoffs on it stay in the takeoff). */
export async function removeSheet(db: Queryable, projectId: string, sheetId: string, who: Identity): Promise<{ removed: boolean }> {
  const r = await db.query("update brink_sheets set removed_at = now(), removed_by = $3 where id = $1 and project_id = $2 and removed_at is null and replaced_by is null returning id", [sheetId, projectId, who.email]);
  return { removed: r.rows.length > 0 };
}
