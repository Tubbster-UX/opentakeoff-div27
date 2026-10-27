// Reads through Hyperdrive with node-postgres. Read-only: every query is a
// SELECT, and the snapshot runs in one READ ONLY, REPEATABLE READ transaction
// so the project pointer and its rows come from the same moment.
import { Client } from "pg";
import { IMPORT_TABLES, ORDER_COLUMN, projectRow, SNAPSHOT_TABLE, TABLE_COLUMNS, type Row, type Snapshot, type TableName } from "./shared/protocol.js";

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export async function withClient<T>(connectionString: string, waitUntil: (p: Promise<unknown>) => void, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    waitUntil(client.end().catch(() => undefined));
  }
}

const cols = (t: TableName, alias?: string): string => TABLE_COLUMNS[t].map((c) => (alias ? `${alias}.${c}` : c)).join(", ");

export interface ProjectListItem {
  id: string;
  name: string;
  current_import_id: string | null;
  imported_at: string | null;
  errors: number | null;
  warnings: number | null;
}

export async function listProjects(db: Queryable): Promise<ProjectListItem[]> {
  const { rows } = await db.query(
    `select p.id, p.name, p.current_import_id, i.imported_at, i.errors, i.warnings
       from brink_projects p left join brink_imports i on i.id = p.current_import_id
      order by p.name`,
  );
  return rows.map((r) => ({ ...(r as unknown as ProjectListItem), imported_at: r.imported_at == null ? null : toIso(r.imported_at) }));
}

/** The project's current import and its rows; null when there is no such project. */
export async function readSnapshot(db: Queryable, projectId: string): Promise<Snapshot | null> {
  await db.query("begin transaction isolation level repeatable read read only");
  try {
    const project = (await db.query(`select ${cols("brink_projects")} from brink_projects where id = $1`, [projectId])).rows[0];
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
      const imp = (await db.query(`select ${cols("brink_imports")} from brink_imports where id = $1`, [importId])).rows[0];
      snap.import = imp ? clean("brink_imports", imp) : null;
      for (const t of IMPORT_TABLES) {
        const { rows } = await db.query(`select ${cols(t)} from ${t} where import_id = $1 order by ${ORDER_COLUMN[t]}`, [importId]);
        snap[SNAPSHOT_TABLE[t]] = rows.map((r) => clean(t, r));
      }
    }
    return snap;
  } finally {
    await db.query("commit");
  }
}

function clean(t: TableName, r: Row): Row {
  const out = projectRow(t, r)!;
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
