// Persistence for the system of record. A merge is written in one
// transaction: the raw OpenTakeoff files, the BOM, the issues and the
// schematic as rows (one per node and connection). The EasySchematic file is
// rendered back from those rows, so the database, not a file, is the truth.
import type { BomLine } from "../bom.js";
import { catalogRowSchema, parseCatalogMap, type CatalogMap, type CatalogRow } from "../catalog.js";
import type { Issue } from "../issues.js";
import { parseInput, type LoadedInput } from "../load.js";
import type { MergeResult } from "../pipeline.js";
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
  return db.transaction(async (tx) => {
    const project = (await tx.query<{ id: string }>(
      "insert into brink_projects (name) values ($1) on conflict (name) do update set name = excluded.name returning id",
      [result.project],
    )).rows[0];
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
        [imp.id, l.lineNo, l.kind, l.conditionKey, l.description, l.qty, l.unit, l.mappingStatus ?? null, l.esDeviceType ?? null, l.cableType ?? null, l.netLf ?? null, l.orderLf ?? null, l.portalSku ?? null, l.severity ?? null, l.code ?? null, json(l)],
      );
    }
    let seq = 0;
    for (const i of result.issues) {
      await tx.query(
        "insert into brink_issues (import_id, seq, severity, code, message, condition_key, refs) values ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        [imp.id, ++seq, i.severity, i.code, i.message, i.conditionKey ?? null, json(i.refs ?? null)],
      );
    }
    await writeSchematic(tx, imp.id, result.schematic.file);
    await tx.query("update brink_projects set current_import_id = $1 where id = $2", [imp.id, project.id]);
    return { importId: imp.id, projectId: project.id, project: result.project, importedAt: imp.imported_at, errors, warnings };
  });
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

/** Render the EasySchematic file from rows. Positions come from the x / y columns, so an edit there is what ES opens. */
export async function renderSchematic(db: Queryable, importId: string): Promise<SchematicFile> {
  const meta = (await db.query<{ name: string; version: number; title_block: SchematicFile["titleBlock"]; custom_templates: SchematicFile["customTemplates"]; extra: Record<string, unknown> }>(
    "select name, version, title_block, custom_templates, extra from brink_schematics where import_id = $1", [importId],
  )).rows[0];
  if (!meta) throw new Error(`no schematic for import ${importId}`);
  const nodes = (await db.query<{ node: SchematicNode; x: number; y: number }>(
    "select node, x, y from brink_schematic_nodes where import_id = $1 order by seq", [importId],
  )).rows.map((r) => ({ ...r.node, position: { x: Number(r.x), y: Number(r.y) } }) as SchematicNode);
  const edges = (await db.query<{ edge: ConnectionEdge }>(
    "select edge from brink_schematic_connections where import_id = $1 order by seq", [importId],
  )).rows.map((r) => r.edge);
  return {
    ...meta.extra,
    version: meta.version,
    name: meta.name,
    nodes,
    edges,
    customTemplates: meta.custom_templates ?? [],
    ...(meta.title_block ? { titleBlock: meta.title_block } : {}),
  };
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
