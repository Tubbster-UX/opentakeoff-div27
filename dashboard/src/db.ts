// Reads through Hyperdrive with node-postgres. Read-only: every query is a
// SELECT, and each read runs in one READ ONLY, REPEATABLE READ transaction so
// a project's pointer and its rows come from the same moment.
//
// Optional tables (OPTIONAL_TABLES, e.g. brink_portal_pushes from an unmerged
// brink-merge migration) are looked up first and only queried when present.
import { Client } from "pg";
import {
  IMPORT_TABLES,
  OPTIONAL_TABLES,
  ORDER_COLUMN,
  projectRow,
  selectList,
  SNAPSHOT_TABLE,
  type PortalPushSummary,
  type ProjectList,
  type ProjectSummary,
  type Row,
  type Snapshot,
  type TableName,
} from "./shared/protocol.js";

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export async function withClient<T>(connectionString: string, waitUntil: (p: Promise<unknown>) => void, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    waitUntil(client.end().catch(() => undefined));
  }
}

async function readOnly<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  await db.query("begin transaction isolation level repeatable read read only");
  try {
    return await fn();
  } finally {
    await db.query("commit");
  }
}

/** Which optional tables exist in this database (public schema). */
export async function presentOptionalTables(db: Queryable): Promise<Set<TableName>> {
  const { rows } = await db.query(
    `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($1::text[])`,
    [OPTIONAL_TABLES],
  );
  return new Set(rows.map((r) => r.t as TableName));
}

/** Which of `tables` are in Supabase's realtime publication (none on a plain Postgres). */
export async function publishedTables(db: Queryable, tables: readonly TableName[]): Promise<Set<TableName>> {
  const { rows } = await db.query(
    `select tablename as t from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = any($1::text[])`,
    [tables],
  );
  return new Set(rows.map((r) => r.t as TableName));
}

/** GET /api/projects: every project with its current import's totals and, when the table exists, its latest Portal push. */
export async function listProjects(db: Queryable): Promise<ProjectList> {
  return readOnly(db, async () => {
    const portalPushes = (await presentOptionalTables(db)).has("brink_portal_pushes");
    const push = portalPushes
      ? `left join lateral (
           select ${selectList("brink_portal_pushes", "pp")}
             from brink_portal_pushes pp where pp.project_id = p.id
            order by pp.created_at desc limit 1) pp on true`
      : "";
    const pushCols = portalPushes
      ? `, pp.id as pp_id, pp.import_id as pp_import_id, pp.dry_run as pp_dry_run, pp.status as pp_status,
           pp.portal_proposal_id as pp_portal_proposal_id, pp.error as pp_error, pp.created_at as pp_created_at, pp.finished_at as pp_finished_at`
      : "";
    // The BOM sums are brink-merge's own totals (src/bom.ts finalizeBom): devices and TRs are the
    // device / tr lines' qty; cables, net and order LF come from the cable lines.
    const { rows } = await db.query(
      `select p.id, p.name, p.created_at, p.current_import_id,
              i.imported_at, i.ot_schema, i.es_schema_version,
              coalesce(b.bom_lines, 0) as bom_lines, coalesce(b.devices, 0) as devices, coalesce(b.trs, 0) as trs,
              coalesce(b.cables, 0) as cables, coalesce(b.net_lf, 0) as net_lf, coalesce(b.order_lf, 0) as order_lf,
              coalesce(s.errors, 0) as errors, coalesce(s.warnings, 0) as warnings${pushCols}
         from brink_projects p
         left join brink_imports i on i.id = p.current_import_id
         left join lateral (
           select count(*) filter (where kind <> 'issue') as bom_lines,
                  sum(qty) filter (where kind = 'device') as devices,
                  sum(qty) filter (where kind = 'tr') as trs,
                  sum(coalesce((line->>'cables')::numeric, 0)) filter (where kind = 'cable') as cables,
                  sum(coalesce(net_lf, 0)) filter (where kind = 'cable') as net_lf,
                  sum(coalesce(order_lf, 0)) filter (where kind = 'cable') as order_lf
             from brink_bom_lines where import_id = p.current_import_id) b on true
         left join lateral (
           select count(*) filter (where severity = 'error') as errors,
                  count(*) filter (where severity = 'warning') as warnings
             from brink_issues where import_id = p.current_import_id) s on true
         ${push}
        order by p.name`,
    );
    return { projects: rows.map(toSummary), features: { portalPushes }, readAt: new Date().toISOString() };
  });
}

const n = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function toSummary(r: Row): ProjectSummary {
  const push: PortalPushSummary | null =
    r.pp_id == null
      ? null
      : {
          id: String(r.pp_id),
          import_id: String(r.pp_import_id),
          is_current_import: r.pp_import_id === r.current_import_id,
          dry_run: Boolean(r.pp_dry_run),
          status: String(r.pp_status),
          portal_proposal_id: r.pp_portal_proposal_id == null ? null : Number(r.pp_portal_proposal_id),
          error: (r.pp_error as string | null) ?? null,
          created_at: iso(r.pp_created_at)!,
          finished_at: iso(r.pp_finished_at),
        };
  return {
    id: String(r.id),
    name: String(r.name),
    created_at: iso(r.created_at),
    current_import_id: (r.current_import_id as string | null) ?? null,
    imported_at: iso(r.imported_at),
    ot_schema: (r.ot_schema as string | null) ?? null,
    es_schema_version: r.es_schema_version == null ? null : Number(r.es_schema_version),
    bom_lines: n(r.bom_lines),
    devices: n(r.devices),
    trs: n(r.trs),
    cables: n(r.cables),
    net_lf: n(r.net_lf),
    order_lf: n(r.order_lf),
    errors: n(r.errors),
    warnings: n(r.warnings),
    portal_push: push,
  };
}

/** The project's current import and its rows; null when there is no such project. */
export async function readSnapshot(db: Queryable, projectId: string): Promise<Snapshot | null> {
  return readOnly(db, async () => {
    const project = (await db.query(`select ${selectList("brink_projects")} from brink_projects where id = $1`, [projectId])).rows[0];
    if (!project) return null;
    const importId = project.current_import_id as string | null;
    const snap: Snapshot = {
      project: clean("brink_projects", project),
      import: null,
      bom: [],
      issues: [],
      nodes: [],
      connections: [],
      readAt: new Date().toISOString(),
    };
    if (importId) {
      const imp = (await db.query(`select ${selectList("brink_imports")} from brink_imports where id = $1`, [importId])).rows[0];
      snap.import = imp ? clean("brink_imports", imp) : null;
      for (const t of IMPORT_TABLES) {
        const { rows } = await db.query(`select ${selectList(t)} from ${t} where import_id = $1 order by ${ORDER_COLUMN[t]}`, [importId]);
        snap[SNAPSHOT_TABLE[t]] = rows.map((r) => clean(t, r));
      }
    }
    return snap;
  });
}

function clean(t: TableName, r: Row): Row {
  const out = projectRow(t, r)!;
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out;
}
