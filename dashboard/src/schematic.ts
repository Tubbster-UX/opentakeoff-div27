// The Schematic tab's server side: read the current import's schematic as
// people see it (brink-merge's rows + the project's edit layer), and write
// edits to that layer. The edit logic is brink-merge's own (src/edits.ts,
// imported here, not copied), so the app and every re-import agree on what an
// edit means. Rules: brink-merge/docs/schematic-edits.md.
//
// Writes run in one transaction per request, holding the project row lock
// (SELECT ... FOR UPDATE), so two editors' requests for one project are
// serialized. Each op is checked against the schematic with every earlier op
// applied; an op whose (target, kind) has a newer active edit than the one the
// editor saw (`expect`) is refused as a conflict: the saved edit wins and the
// editor's page reloads it.
import {
  ACTIVE_EDITS_SQL, applyEdits, editFromRow, INSERT_EDIT_SQL, isGeneratedEdge, parseEditInput, SUPERSEDE_EDIT_SQL, targetContext,
  type EditRow, type SchematicEdit,
} from "../../brink-merge/src/edits.js";
import { assembleSchematic, SCHEMATIC_EDGES_SQL, SCHEMATIC_META_SQL, SCHEMATIC_NODES_SQL, type SchematicMetaRow } from "../../brink-merge/src/render.js";
import type { ConnectionEdge, SchematicFile, SchematicNode } from "../../brink-merge/src/vendor/esTypes.js";
import type { Identity } from "./access.js";
import { HttpError } from "./http.js";
import type { Queryable } from "./db.js";
import type { EditRequest, EditResponse, EditResult, EditSummary, SchematicView } from "./shared/protocol.js";

const MAX_OPS = 200;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function summary(e: SchematicEdit): EditSummary {
  return { id: e.id, target_key: e.targetKey, kind: e.kind, payload: e.payload, editor_email: e.editorEmail, created_at: e.createdAt };
}

async function generated(db: Queryable, importId: string): Promise<SchematicFile | null> {
  const meta = (await db.query(SCHEMATIC_META_SQL, [importId])).rows[0] as SchematicMetaRow | undefined;
  if (!meta) return null;
  const nodes = (await db.query(SCHEMATIC_NODES_SQL, [importId])).rows as { node: SchematicNode; x: unknown; y: unknown }[];
  const edges = (await db.query(SCHEMATIC_EDGES_SQL, [importId])).rows as { edge: ConnectionEdge }[];
  return assembleSchematic(meta, nodes, edges);
}

async function activeEdits(db: Queryable, projectId: string): Promise<SchematicEdit[]> {
  return ((await db.query(ACTIVE_EDITS_SQL, [projectId])).rows as unknown as EditRow[]).map(editFromRow);
}

/** GET /api/projects/:id/schematic. null: no such project; `{ importId: null }`: no current import. */
export async function readSchematic(db: Queryable, projectId: string): Promise<SchematicView | { noImport: true } | null> {
  await db.query("begin transaction isolation level repeatable read read only");
  try {
    const p = (await db.query("select id, name, current_import_id from brink_projects where id = $1", [projectId])).rows[0];
    if (!p) return null;
    const importId = p.current_import_id as string | null;
    const file = importId ? await generated(db, importId) : null;
    if (!importId || !file) return { noImport: true };
    const edits = await activeEdits(db, projectId);
    const applied = applyEdits(file, edits);
    return {
      project_id: projectId,
      project_name: String(p.name),
      import_id: importId,
      file: applied.file as unknown as Record<string, unknown>,
      edits: edits.map(summary),
      issues: applied.issues.map((i) => ({ severity: i.severity, code: i.code, message: i.message, ...(i.refs ? { refs: i.refs } : {}) })),
      readAt: new Date().toISOString(),
    };
  } finally {
    await db.query("commit");
  }
}

export { HttpError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape-check the request body (ops are checked one by one later). */
export function parseEditRequest(body: unknown): EditRequest {
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
  return { importId: b.importId, clientRef: b.clientRef, ops: b.ops as EditRequest["ops"] };
}

/** POST /api/projects/:id/schematic/edits. Runs in its own transaction. */
export async function writeEdits(db: Queryable, projectId: string, req: EditRequest, who: Identity): Promise<EditResponse> {
  await db.query("begin");
  try {
    const p = (await db.query("select current_import_id from brink_projects where id = $1 for update", [projectId])).rows[0];
    if (!p) throw new HttpError(404, "no such project");
    const importId = p.current_import_id as string | null;
    if (!importId) throw new HttpError(409, "the project has no current import");
    // The editor was looking at another import: a re-import landed. Its edits carry over, but this request was
    // built against the old schematic, so the page reloads instead.
    if (importId !== req.importId) throw new HttpError(409, "the project was re-imported; reload the schematic", { currentImportId: importId });
    const base = await generated(db, importId);
    if (!base) throw new HttpError(409, "the current import has no schematic");
    const active = await activeEdits(db, projectId);
    const byKey = new Map(active.map((e) => [`${e.targetKey}|${e.kind}`, e]));
    let working = applyEdits(base, active).file;
    const results: EditResult[] = [];

    for (const [i, op] of req.ops.entries()) {
      if (op.kind === "revert") {
        const id = (op as { edit: string }).edit;
        const target = active.find((e) => e.id === id);
        if (!target) {
          results.push({ i, status: "conflict", error: "that edit is no longer active (already reverted or replaced)", current: null });
          continue;
        }
        await db.query("update brink_schematic_edits set reverted_at = now(), reverted_by = $2 where id = $1", [id, who.email]);
        active.splice(active.indexOf(target), 1);
        byKey.delete(`${target.targetKey}|${target.kind}`);
        working = applyEdits(base, active).file;
        results.push({ i, status: "reverted", edit: id });
        continue;
      }
      const input = parseEditInput(op);
      if (typeof input === "string") {
        results.push({ i, status: "invalid", error: input });
        continue;
      }
      const key = `${input.target}|${input.kind}`;
      const current = byKey.get(key) ?? null;
      const expect = (op as { expect?: string | null }).expect ?? null;
      if ((current?.id ?? null) !== expect) {
        results.push({ i, status: "conflict", error: current ? `${current.editorEmail} changed this at ${current.createdAt}` : "the edit you replaced was reverted", current: current ? summary(current) : null });
        continue;
      }
      if (input.kind === "disconnect") {
        const e = working.edges.find((x) => x.id === input.target);
        if (!e || !isGeneratedEdge(e)) {
          results.push({ i, status: "invalid", error: e ? "only a cable from the takeoff is disconnected; an added connection is reverted" : `no cable ${input.target}` });
          continue;
        }
      }
      const id = crypto.randomUUID();
      const trial = applyEdits(working, [{ id, targetKey: input.target, kind: input.kind, payload: input.payload, editorEmail: who.email, createdAt: new Date().toISOString() }]);
      if (trial.issues.length) {
        results.push({ i, status: "invalid", error: String(trial.issues[0]!.refs?.reason ?? trial.issues[0]!.message) });
        continue;
      }
      const context = targetContext(working, input);
      const old = (await db.query(SUPERSEDE_EDIT_SQL, [projectId, input.target, input.kind, id])).rows[0];
      const row = (await db.query(INSERT_EDIT_SQL, [
        id, projectId, input.target, input.kind, JSON.stringify(input.payload), JSON.stringify(context), who.email, who.auth, req.clientRef, importId,
      ])).rows[0] as unknown as EditRow;
      const saved = editFromRow({ ...row, created_at: iso(row.created_at) });
      if (current) active.splice(active.indexOf(current), 1);
      active.push(saved);
      byKey.set(key, saved);
      working = trial.file;
      results.push({ i, status: "saved", edit: summary(saved), superseded: (old?.id as string | undefined) ?? null });
    }
    await db.query("commit");
    return { importId, editor: who.email, results };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  }
}
