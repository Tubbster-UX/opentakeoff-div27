// Persistence for the system of record. A merge is written in one
// transaction: the raw OpenTakeoff files, the BOM, the issues and the
// schematic as rows (one per node and connection). The EasySchematic file is
// rendered back from those rows, so the database, not a file, is the truth.
// People's edits to the schematic are a separate layer (brink_schematic_edits)
// applied on top of the rows when rendering; the rows stay as generated.
import type { BomLine } from "../bom.js";
import { catalogRowSchema, parseCatalogMap, type CatalogMap, type CatalogRow } from "../catalog.js";
import type { Issue } from "../issues.js";
import { parseInput, type LoadedInput } from "../load.js";
import type { MergeResult } from "../pipeline.js";
import {
  ACTIVE_EDITS_SQL, applyEdits, editFromRow, INSERT_EDIT_SQL, SUPERSEDE_EDIT_SQL,
  type ApplyResult, type EditInput, type EditRow, type SchematicEdit, type TargetContext,
} from "../edits.js";
import {
  ACTIVE_TAKEOFF_EDITS_SQL, applyTakeoffEdits, INSERT_TAKEOFF_EDIT_SQL, SUPERSEDE_TAKEOFF_EDIT_SQL, takeoffEditFromRow, takeoffTargetContext, targetTypeOf,
  type TakeoffApplyResult, type TakeoffEdit, type TakeoffEditInput, type TakeoffEditRow,
} from "../takeoffEdits.js";
import { assembleSchematic, SCHEMATIC_EDGES_SQL, SCHEMATIC_META_SQL, SCHEMATIC_NODES_SQL, type SchematicMetaRow } from "../render.js";
import type { ConnectionEdge, SchematicFile, SchematicNode } from "../vendor/esTypes.js";
import type { Db, Queryable } from "./db.js";

export interface ImportSummary {
  importId: string;
  projectId: string;
  project: string;
  importedAt: string;
  errors: number;
  warnings: number;
}

const json = (v: unknown): string => JSON.stringify(v ?? null);

export async function seedCatalog(db: Queryable, map: CatalogMap, opts: { overwrite?: boolean } = {}): Promise<number> {
  let n = 0;
  for (const r of map.rows) {
    const res = await db.query(
      `insert into brink_catalog_map (condition_key, kind, es_device_type, es_template_ref, label, port, cable_type, portal_sku, status, note)
       values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)
       on conflict (condition_key) do ${opts.overwrite ? `update set kind = excluded.kind, es_device_type = excluded.es_device_type, es_template_ref = excluded.es_template_ref,
         label = excluded.label, port = excluded.port, cable_type = excluded.cable_type, portal_sku = excluded.portal_sku, status = excluded.status, note = excluded.note, updated_at = now()` : "nothing"}
       returning condition_key`,
      [r.conditionKey, r.kind, r.esDeviceType, json(r.esTemplateRef), r.label ?? null, json(r.port ?? null), r.cableType ?? null, r.portalSku, r.status, r.note ?? null],
    );
    n += res.rows.length;
  }
  return n;
}

export async function upsertCatalogRow(db: Queryable, row: CatalogRow): Promise<void> {
  catalogRowSchema.parse(row);
  await seedCatalog(db, { version: 1, rows: [row] }, { overwrite: true });
}

interface CatalogDbRow {
  condition_key: string; kind: CatalogRow["kind"]; es_device_type: string | null; es_template_ref: CatalogRow["esTemplateRef"];
  label: string | null; port: CatalogRow["port"]; cable_type: string | null; portal_sku: string | null; status: CatalogRow["status"]; note: string | null;
}

export async function loadCatalog(db: Queryable): Promise<CatalogMap> {
  const { rows } = await db.query<CatalogDbRow>("select * from brink_catalog_map order by condition_key");
  return parseCatalogMap({
    version: 1,
    rows: rows.map((r) => ({
      conditionKey: r.condition_key, kind: r.kind, esDeviceType: r.es_device_type, esTemplateRef: r.es_template_ref, label: r.label,
      port: r.port, cableType: r.cable_type, portalSku: r.portal_sku, status: r.status, ...(r.note ? { note: r.note } : {}),
    })),
  });
}

export async function saveMerge(db: Db, input: LoadedInput, result: MergeResult): Promise<ImportSummary> {
  return db.transaction((tx) => writeMerge(tx, input, result));
}

/**
 * Write a merge as the project's new current import, inside the caller's transaction. The project is `projectId`
 * when given (the app's Worker re-running a project's import after a takeoff edit), else found or created by name.
 * The stored takeoff is always the raw input (the machine original), never the edited takeoff.
 */
export async function writeMerge(tx: Queryable, input: LoadedInput, result: MergeResult, opts: { projectId?: string } = {}): Promise<ImportSummary> {
  {
    const project = opts.projectId
      ? { id: opts.projectId }
      : (await tx.query<{ id: string }>(
          "insert into brink_projects (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
          [result.project],
        )).rows[0]!;
    const errors = result.issues.filter((i) => i.severity === "error").length;
    const warnings = result.issues.length - errors;
    const imp = (await tx.query<{ id: string; imported_at: string }>(
      `insert into brink_imports (project_id, takeoff, report, takeoff_sha256, report_sha256, ot_schema, es_schema_version, errors, warnings)
       values ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9) returning id, imported_at::text`,
      [project.id, json(input.takeoff), input.report ? json(input.report) : null, input.takeoffSha256, input.reportSha256, input.takeoff.schema, result.schematic.file.version, errors, warnings],
    )).rows[0];

    for (const l of result.bom.lines) {
      await tx.query(
        `insert into brink_bom_lines (import_id, line_no, kind, condition_key, description, qty, unit, mapping_status, es_device_type, cable_type, net_lf, order_lf, portal_sku, severity, code, line)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
        [imp!.id, l.lineNo, l.kind, l.conditionKey, l.description, l.qty, l.unit, l.mappingStatus ?? null, l.esDeviceType ?? null, l.cableType ?? null, l.netLf ?? null, l.orderLf ?? null, l.portalSku ?? null, l.severity ?? null, l.code ?? null, json(l)],
      );
    }
    let seq = 0;
    for (const i of result.issues) {
      await tx.query(
        "insert into brink_issues (import_id, seq, severity, code, message, condition_key, refs) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [imp!.id, ++seq, i.severity, i.code, i.message, i.conditionKey ?? null, json(i.refs ?? null)],
      );
    }
    await writeSchematic(tx, imp!.id, result.schematic.file);
    await tx.query("update brink_projects set current_import_id = $1 where id = $2", [imp!.id, project.id]);
    return { importId: imp!.id, projectId: project.id, project: result.project, importedAt: imp!.imported_at, errors, warnings };
  }
}

async function writeSchematic(tx: Queryable, importId: string, file: SchematicFile): Promise<void> {
  const { version, name, nodes, edges, customTemplates, titleBlock, ...extra } = file;
  await tx.query(
    "insert into brink_schematics (import_id, name, version, title_block, custom_templates, extra) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)",
    [importId, name, version, json(titleBlock ?? null), json(customTemplates ?? []), json(extra)],
  );
  let seq = 0;
  for (const n of nodes) {
    const d = n.data as Record<string, unknown>;
    const brink = (d.brink ?? {}) as Record<string, unknown>;
    await tx.query(
      `insert into brink_schematic_nodes (import_id, seq, node_id, node_type, parent_id, label, device_type, condition_key, template_id, x, y, node)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [importId, ++seq, n.id, n.type, n.parentId ?? null, (d.label as string) ?? null, (d.deviceType as string) ?? null, (brink.conditionKey as string) ?? null, (d.templateId as string) ?? null, n.position.x, n.position.y, json(n)],
    );
  }
  seq = 0;
  for (const e of edges) {
    const brink = (e.data?.brink ?? {}) as Record<string, unknown>;
    await tx.query(
      `insert into brink_schematic_connections (import_id, seq, edge_id, source_node, source_handle, target_node, target_handle, signal_type, cable_length_ft, cable_type, run_id, edge)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [importId, ++seq, e.id, e.source, e.sourceHandle ?? null, e.target, e.targetHandle ?? null, e.data?.signalType ?? null, (brink.perCableLf as number) ?? null, e.data?.label ?? null, (brink.runId as string) ?? null, json(e)],
    );
  }
}

/** The generated schematic of an import, from its rows (no edits). */
export async function renderGenerated(db: Queryable, importId: string): Promise<SchematicFile> {
  const meta = (await db.query<SchematicMetaRow>(SCHEMATIC_META_SQL, [importId])).rows[0];
  if (!meta) throw new Error(`no schematic for import ${importId}`);
  const nodes = (await db.query<{ node: SchematicNode; x: number; y: number }>(SCHEMATIC_NODES_SQL, [importId])).rows;
  const edges = (await db.query<{ edge: ConnectionEdge }>(SCHEMATIC_EDGES_SQL, [importId])).rows;
  return assembleSchematic(meta, nodes, edges);
}

/** An import's schematic as people see it: its rows with the project's active edit layer applied, and the edits it cannot carry. */
export async function renderEdited(db: Queryable, importId: string): Promise<ApplyResult & { edits: SchematicEdit[] }> {
  const imp = (await db.query<{ project_id: string }>("select project_id from brink_imports where id = $1", [importId])).rows[0];
  if (!imp) throw new Error(`no import ${importId}`);
  const edits = await loadActiveEdits(db, imp.project_id);
  return { ...applyEdits(await renderGenerated(db, importId), edits), edits };
}

/**
 * Render the EasySchematic file from rows. Positions come from the x / y columns, so an edit there is what ES opens.
 * The project's schematic edit layer is applied unless `edits: false`.
 */
export async function renderSchematic(db: Queryable, importId: string, opts: { edits?: boolean } = {}): Promise<SchematicFile> {
  if (opts.edits === false) return renderGenerated(db, importId);
  return (await renderEdited(db, importId)).file;
}

// ---------------------------------------------------------------------------
// The schematic edit layer (edits.ts, docs/schematic-edits.md).

/** A project's active edits (neither superseded nor reverted), oldest first. */
export async function loadActiveEdits(db: Queryable, projectId: string): Promise<SchematicEdit[]> {
  return (await db.query<EditRow>(ACTIVE_EDITS_SQL, [projectId])).rows.map(editFromRow);
}

/** The active edits of the project named `project`; none when there is no such project yet. */
export async function loadActiveEditsByName(db: Queryable, project: string): Promise<SchematicEdit[]> {
  const p = (await db.query<{ id: string }>("select id from brink_projects where name = $1", [project])).rows[0];
  return p ? loadActiveEdits(db, p.id) : [];
}

export interface RecordedEdit extends SchematicEdit {
  editorAuth: string;
  clientRef: string | null;
  baseImportId: string | null;
  /** The edit this one superseded, if any. */
  superseded: string | null;
}

/**
 * Append one edit, superseding the active edit of the same (target, kind). One transaction.
 * The app's Worker writes through the same SQL (edits.ts); this is for brink-merge processes and tests.
 */
export async function recordEdit(db: Db, e: { projectId: string; input: EditInput; editorEmail: string; editorAuth?: "brink-merge" | "dev-bypass" | "cloudflare-access"; clientRef?: string | null; baseImportId?: string | null; context?: TargetContext | null }): Promise<RecordedEdit> {
  return db.transaction(async (tx) => {
    const id = (await tx.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0]!.id;
    const old = (await tx.query<{ id: string }>(SUPERSEDE_EDIT_SQL, [e.projectId, e.input.target, e.input.kind, id])).rows[0];
    const row = (await tx.query<EditRow & { editor_auth: string; client_ref: string | null; base_import_id: string | null }>(INSERT_EDIT_SQL, [
      id, e.projectId, e.input.target, e.input.kind, json(e.input.payload), json(e.context ?? null), e.editorEmail, e.editorAuth ?? "brink-merge", e.clientRef ?? null, e.baseImportId ?? null,
    ])).rows[0]!;
    return { ...editFromRow(row), editorAuth: row.editor_auth, clientRef: row.client_ref, baseImportId: row.base_import_id, superseded: old?.id ?? null };
  });
}

// ---------------------------------------------------------------------------
// The takeoff edit layer (takeoffEdits.ts, docs/takeoff-edits.md).

/** A project's active takeoff edits (neither superseded nor reverted), oldest first. */
export async function loadActiveTakeoffEdits(db: Queryable, projectId: string): Promise<TakeoffEdit[]> {
  return (await db.query<TakeoffEditRow>(ACTIVE_TAKEOFF_EDITS_SQL, [projectId])).rows.map(takeoffEditFromRow);
}

/** The active takeoff edits of the project named `project`; none when there is no such project yet. */
export async function loadActiveTakeoffEditsByName(db: Queryable, project: string): Promise<TakeoffEdit[]> {
  const p = (await db.query<{ id: string }>("select id from brink_projects where name = $1", [project])).rows[0];
  return p ? loadActiveTakeoffEdits(db, p.id) : [];
}

/** An import's takeoff as people see it: the raw takeoff with the project's active takeoff edits applied. */
export async function renderTakeoff(db: Queryable, importId: string): Promise<TakeoffApplyResult & { edits: TakeoffEdit[]; base: LoadedInput["takeoff"] }> {
  const imp = (await db.query<{ project_id: string }>("select project_id from brink_imports where id = $1", [importId])).rows[0];
  if (!imp) throw new Error(`no import ${importId}`);
  const input = await loadImportInput(db, importId);
  const edits = await loadActiveTakeoffEdits(db, imp.project_id);
  return { ...applyTakeoffEdits(input.takeoff, edits), edits, base: input.takeoff };
}

/**
 * Append one takeoff edit, superseding the active edit of the same target. One transaction. The app's Worker writes
 * through the same SQL; this is for brink-merge processes and tests (editor_auth "brink-merge" by default, which can
 * never mark machine work reviewed).
 */
export async function recordTakeoffEdit(db: Db, e: { projectId: string; input: TakeoffEditInput; editorEmail: string; editorAuth?: "brink-merge" | "dev-bypass" | "cloudflare-access"; clientRef?: string | null; baseImportId?: string | null }): Promise<TakeoffEdit & { superseded: string | null }> {
  return db.transaction(async (tx) => {
    const base = e.baseImportId ? (await loadImportInput(tx, e.baseImportId)).takeoff : null;
    const id = (await tx.query<{ id: string }>("select gen_random_uuid()::text as id")).rows[0]!.id;
    const type = targetTypeOf(e.input.kind);
    const old = (await tx.query<{ id: string }>(SUPERSEDE_TAKEOFF_EDIT_SQL, [e.projectId, type, e.input.target, id])).rows[0];
    const row = (await tx.query<TakeoffEditRow>(INSERT_TAKEOFF_EDIT_SQL, [
      id, e.projectId, type, e.input.target, e.input.kind, json(e.input.payload), json(takeoffTargetContext(base, e.input)), e.editorEmail, e.editorAuth ?? "brink-merge", e.clientRef ?? null, e.baseImportId ?? null,
    ])).rows[0]!;
    return { ...takeoffEditFromRow(row), superseded: old?.id ?? null };
  });
}

/** Revert an active takeoff edit. Returns false when it was not active. */
export async function revertTakeoffEdit(db: Queryable, editId: string, by: string): Promise<boolean> {
  const r = await db.query("update brink_takeoff_edits set reverted_at = now(), reverted_by = $2 where id = $1 and superseded_at is null and reverted_at is null returning id", [editId, by]);
  return r.rows.length > 0;
}

/** Revert an active edit. Returns false when it was not active (already reverted or superseded). */
export async function revertEdit(db: Queryable, editId: string, by: string): Promise<boolean> {
  const r = await db.query("update brink_schematic_edits set reverted_at = now(), reverted_by = $2 where id = $1 and superseded_at is null and reverted_at is null returning id", [editId, by]);
  return r.rows.length > 0;
}

export async function currentImport(db: Queryable, project: string): Promise<ImportSummary | null> {
  const r = (await db.query<{ import_id: string; project_id: string; name: string; imported_at: string; errors: number; warnings: number }>(
    `select i.id as import_id, p.id as project_id, p.name, i.imported_at::text, i.errors, i.warnings
       from brink_projects p join brink_imports i on i.id = p.current_import_id where p.name = $1`, [project],
  )).rows[0];
  return r ? { importId: r.import_id, projectId: r.project_id, project: r.name, importedAt: r.imported_at, errors: r.errors, warnings: r.warnings } : null;
}

export async function listProjects(db: Queryable): Promise<ImportSummary[]> {
  const rows = (await db.query<{ import_id: string; project_id: string; name: string; imported_at: string; errors: number; warnings: number }>(
    `select i.id as import_id, p.id as project_id, p.name, i.imported_at::text, i.errors, i.warnings
       from brink_projects p join brink_imports i on i.id = p.current_import_id order by p.name`,
  )).rows;
  return rows.map((r) => ({ importId: r.import_id, projectId: r.project_id, project: r.name, importedAt: r.imported_at, errors: r.errors, warnings: r.warnings }));
}

export async function loadBomLines(db: Queryable, importId: string): Promise<BomLine[]> {
  return (await db.query<{ line: BomLine }>("select line from brink_bom_lines where import_id = $1 order by line_no", [importId])).rows.map((r) => r.line);
}

export async function loadIssues(db: Queryable, importId: string): Promise<Issue[]> {
  const rows = (await db.query<{ severity: Issue["severity"]; code: Issue["code"]; message: string; condition_key: string | null; refs: Record<string, unknown> | null }>(
    "select severity, code, message, condition_key, refs from brink_issues where import_id = $1 order by seq", [importId],
  )).rows;
  return rows.map((r) => ({ severity: r.severity, code: r.code, message: r.message, ...(r.condition_key ? { conditionKey: r.condition_key } : {}), ...(r.refs ? { refs: r.refs } : {}) }));
}

/** The stored OpenTakeoff input of an import, to re-merge after a catalog change. */
export async function loadImportInput(db: Queryable, importId: string): Promise<LoadedInput> {
  const r = (await db.query<{ takeoff: unknown; report: unknown; takeoff_sha256: string; report_sha256: string | null }>(
    "select takeoff, report, takeoff_sha256, report_sha256 from brink_imports where id = $1", [importId],
  )).rows[0];
  if (!r) throw new Error(`no import ${importId}`);
  // keep the hashes of the files as originally exported, not of the re-serialized jsonb
  return { ...parseInput(JSON.stringify(r.takeoff), r.report == null ? null : JSON.stringify(r.report)), takeoffSha256: r.takeoff_sha256, reportSha256: r.report_sha256 };
}

export async function moveNode(db: Queryable, importId: string, nodeId: string, x: number, y: number): Promise<boolean> {
  const res = await db.query("update brink_schematic_nodes set x = $3, y = $4 where import_id = $1 and node_id = $2 returning node_id", [importId, nodeId, x, y]);
  return res.rows.length > 0;
}
