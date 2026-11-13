// A minimal database seam so the same repository runs on hosted or local
// Supabase / Postgres (DATABASE_URL, via pg) and on in-process PGlite (tests,
// and the MCP server's zero-setup default).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run several statements (no parameters). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    kind: "pglite",
    query: async <T>(sql: string, params: unknown[] = []) => ({ rows: (await pg.query<T>(sql, params)).rows }),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) => pg.transaction((tx) => fn({ query: async <T>(sql: string, params: unknown[] = []) => ({ rows: (await tx.query<T>(sql, params)).rows }) })),
    close: () => pg.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 4 });
  // numeric -> JS number (lengths and quantities are well inside double precision)
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  return {
    kind: "postgres",
    query: async <T>(sql: string, params: unknown[] = []) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: async <T>(sql: string, params: unknown[] = []) => ({ rows: (await client.query(sql, params)).rows as T[] }) });
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** DATABASE_URL -> Postgres; else PGlite (in memory, or BRINK_PGLITE_DIR on disk). */
export async function openDb(opts: { url?: string | null; pgliteDir?: string | null } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL ?? null;
  if (url) return openPostgres(url);
  return openPglite(opts.pgliteDir ?? process.env.BRINK_PGLITE_DIR ?? undefined);
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

/** Advisory-lock key that serializes migrate() across processes sharing one Postgres. */
const MIGRATE_LOCK = 727_274_019;

/** Apply supabase/migrations/*.sql in name order, once each (tracked in brink_schema_migrations).
 *  On Postgres the whole run is one transaction holding an advisory lock, so two processes
 *  migrating the same database at once (parallel test files, two CLI runs) cannot both
 *  apply the same file: the second waits, then sees it done. PGlite is one process. */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  if (db.kind === "postgres") {
    return db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [MIGRATE_LOCK]);
      await tx.query("create table if not exists brink_schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      const done = new Set((await tx.query<{ name: string }>("select name from brink_schema_migrations")).rows.map((r) => r.name));
      const applied: string[] = [];
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(name)) continue;
        await tx.query(readFileSync(`${dir}/${name}`, "utf8"));
        await tx.query("insert into brink_schema_migrations (name) values ($1)", [name]);
        applied.push(name);
      }
      return applied;
    });
  }
  await db.exec("create table if not exists brink_schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from brink_schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await db.exec(readFileSync(`${dir}/${name}`, "utf8"));
    await db.query("insert into brink_schema_migrations (name) values ($1)", [name]);
    applied.push(name);
  }
  return applied;
}
