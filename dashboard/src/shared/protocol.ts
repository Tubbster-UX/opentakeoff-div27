// Shared by the Worker, the Durable Object relay and the browser: which
// brink-merge tables the app reflects, which of their columns it sends,
// and the messages on the browser WebSocket. brink-merge owns the schema
// (brink-merge/supabase/migrations/); this file only reads it.

/** Columns sent to the browser, per table. Heavy jsonb (raw takeoff, node / edge / line blobs) stays on the server. */
export const TABLE_COLUMNS = {
  brink_projects: ["id", "name", "current_import_id", "created_at"],
  brink_imports: ["id", "project_id", "takeoff_sha256", "report_sha256", "ot_schema", "es_schema_version", "errors", "warnings", "imported_at"],
  brink_bom_lines: ["import_id", "line_no", "kind", "condition_key", "description", "qty", "unit", "mapping_status", "es_device_type", "cable_type", "net_lf", "order_lf", "portal_sku", "severity", "code"],
  brink_issues: ["import_id", "seq", "severity", "code", "message", "condition_key", "refs"],
  brink_schematic_nodes: ["import_id", "seq", "node_id", "node_type", "parent_id", "label", "device_type", "condition_key", "template_id", "x", "y"],
  brink_schematic_connections: ["import_id", "seq", "edge_id", "source_node", "source_handle", "target_node", "target_handle", "signal_type", "cable_length_ft", "cable_type", "run_id"],
  // OPTIONAL: created by brink-merge's Portal push migration, which not every database has. The relay
  // subscribes to it only when it is in the supabase_realtime publication; the API reads it only when it exists.
  brink_portal_pushes: ["id", "project_id", "import_id", "dry_run", "status", "portal_proposal_id", "error", "created_at", "finished_at"],
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLES = Object.keys(TABLE_COLUMNS) as TableName[];
/** Tables that may be absent (a migration this database has not had). Never assumed present. */
export const OPTIONAL_TABLES: readonly TableName[] = ["brink_portal_pushes"];
/** Tables every brink-merge database has (the init migration). */
export const CORE_TABLES: readonly TableName[] = TABLES.filter((t) => !OPTIONAL_TABLES.includes(t));

/** Primary key of each table (brink-merge's migrations). Every child table's key starts with import_id. */
export const PRIMARY_KEY: Record<TableName, readonly string[]> = {
  brink_projects: ["id"],
  brink_imports: ["id"],
  brink_bom_lines: ["import_id", "line_no"],
  brink_issues: ["import_id", "seq"],
  brink_schematic_nodes: ["import_id", "node_id"],
  brink_schematic_connections: ["import_id", "edge_id"],
  brink_portal_pushes: ["id"],
};

/** Child tables: one import's rows. */
export const IMPORT_TABLES = ["brink_bom_lines", "brink_issues", "brink_schematic_nodes", "brink_schematic_connections"] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** Numeric columns (Postgres numeric / integer / bigint). Realtime and pg may hand them over as strings. */
const NUMERIC = new Set(["line_no", "qty", "net_lf", "order_lf", "seq", "x", "y", "cable_length_ft", "errors", "warnings", "es_schema_version", "portal_proposal_id", "cables", "pulls"]);

/**
 * Small values the app needs from a heavy jsonb column, copied out on the server so the blob itself
 * is never sent: a BOM cable line's cable and pull counts live only in `line`.
 */
const JSONB_EXTRAS: Partial<Record<TableName, { column: string; keys: readonly string[] }>> = {
  brink_bom_lines: { column: "line", keys: ["cables", "pulls"] },
};

export type Row = Record<string, unknown>;

export function isTable(t: unknown): t is TableName {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, t);
}

export function isImportTable(t: TableName): t is ImportTable {
  return (IMPORT_TABLES as readonly string[]).includes(t);
}

/** SQL select list for `t`: its columns, plus its jsonb extras as a slim object under the blob's own name (which projectRow unpacks). */
export function selectList(t: TableName, alias?: string): string {
  const a = alias ? `${alias}.` : "";
  const list: string[] = TABLE_COLUMNS[t].map((c) => `${a}${c}`);
  const x = JSONB_EXTRAS[t];
  if (x) list.push(`jsonb_build_object(${x.keys.map((k) => `'${k}', ${a}${x.column}->'${k}'`).join(", ")}) as ${x.column}`);
  return list.join(", ");
}

/** Keep only the app's columns (and jsonb extras), with numbers as numbers. Columns missing from the source are left out (a DELETE carries only the key). */
export function projectRow(table: TableName, row: Row | null | undefined): Row | null {
  if (!row) return null;
  const out: Row = {};
  for (const c of TABLE_COLUMNS[table]) {
    if (!(c in row)) continue;
    out[c] = num(c, row[c]);
  }
  const x = JSONB_EXTRAS[table];
  const blob = x ? row[x.column] : undefined;
  if (x && blob && typeof blob === "object") {
    for (const k of x.keys) {
      const v = (blob as Row)[k];
      if (v !== undefined && v !== null) out[k] = num(k, v);
    }
  }
  return out;
}

function num(c: string, v: unknown): unknown {
  return NUMERIC.has(c) && typeof v === "string" && v !== "" ? Number(v) : v;
}

export function rowKey(table: TableName, row: Row): string {
  return PRIMARY_KEY[table].map((c) => String(row[c])).join("|");
}

export type ChangeType = "INSERT" | "UPDATE" | "DELETE";

/** One row change, as the relay forwards it (already projected). */
export interface RowChange {
  table: TableName;
  type: ChangeType;
  /** New row (INSERT / UPDATE). */
  record: Row | null;
  /** Old row: for DELETE (and UPDATE without REPLICA IDENTITY FULL) only the primary key. */
  old: Row | null;
  commitTimestamp: string | null;
}

/** Normalize a Supabase Realtime postgres_changes payload (realtime-js shape). Returns null for tables the app does not reflect. */
export function fromRealtimePayload(p: {
  table?: string;
  eventType?: string;
  new?: Row;
  old?: Row;
  commit_timestamp?: string;
}): RowChange | null {
  if (!isTable(p.table)) return null;
  const type = p.eventType;
  if (type !== "INSERT" && type !== "UPDATE" && type !== "DELETE") return null;
  const rec = p.new && Object.keys(p.new).length ? p.new : null;
  const old = p.old && Object.keys(p.old).length ? p.old : null;
  return {
    table: p.table,
    type,
    record: type === "DELETE" ? null : projectRow(p.table, rec),
    old: projectRow(p.table, old),
    commitTimestamp: p.commit_timestamp ?? null,
  };
}

/** Which project a change concerns, when the row says so; which import, for child rows. */
export function changeScope(c: RowChange): { projectId?: string; importId?: string } {
  const r = c.record ?? c.old ?? {};
  switch (c.table) {
    case "brink_projects":
      return { projectId: r.id as string | undefined };
    case "brink_imports":
      return { projectId: r.project_id as string | undefined, importId: r.id as string | undefined };
    case "brink_portal_pushes":
      return { projectId: r.project_id as string | undefined, importId: r.import_id as string | undefined };
    default:
      return { importId: r.import_id as string | undefined };
  }
}

/** Upstream (DO -> Supabase Realtime) state, shown in the page header. */
export type UpstreamStatus = "connecting" | "live" | "down" | "unconfigured";

/**
 * Server -> browser. A project socket gets `change` (one projected row change). The project-list
 * socket gets `touch`: which tables changed since the last touch (coalesced), so it re-reads the list.
 */
export type ServerMessage =
  | { type: "status"; upstream: UpstreamStatus; detail?: string }
  | { type: "change"; change: RowChange }
  | { type: "touch"; tables: TableName[] };

/** Browser -> server: the import the page is currently showing, so child-row changes can be routed to it. */
export type ClientMessage = { type: "watch"; importId: string | null };

/** GET /api/projects/:id -> one consistent read of the project's current import. */
export interface Snapshot {
  project: Row;
  import: Row | null;
  bom: Row[];
  issues: Row[];
  nodes: Row[];
  connections: Row[];
  readAt: string;
}

/** One row of GET /api/projects: the project, its current import and that import's totals. */
export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string | null;
  current_import_id: string | null;
  imported_at: string | null;
  ot_schema: string | null;
  es_schema_version: number | null;
  /** Totals over the current import's BOM lines: the same sums brink-merge prints. */
  bom_lines: number;
  devices: number;
  trs: number;
  cables: number;
  net_lf: number;
  order_lf: number;
  /** Counted from brink_issues (live), not the import's stored counters. */
  errors: number;
  warnings: number;
  /** Latest Portal push for the project (any import); null when there is none, or the table is absent. */
  portal_push: PortalPushSummary | null;
}

export interface PortalPushSummary {
  id: string;
  import_id: string;
  /** True when the push was for the project's current import. */
  is_current_import: boolean;
  dry_run: boolean;
  status: string;
  portal_proposal_id: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** GET /api/projects. */
export interface ProjectList {
  projects: ProjectSummary[];
  /** Optional tables this database has. `portalPushes: false` means brink_portal_pushes is absent (not migrated). */
  features: { portalPushes: boolean };
  readAt: string;
}

export const SNAPSHOT_TABLE: Record<ImportTable, "bom" | "issues" | "nodes" | "connections"> = {
  brink_bom_lines: "bom",
  brink_issues: "issues",
  brink_schematic_nodes: "nodes",
  brink_schematic_connections: "connections",
};

export const ORDER_COLUMN: Record<ImportTable, string> = {
  brink_bom_lines: "line_no",
  brink_issues: "seq",
  brink_schematic_nodes: "seq",
  brink_schematic_connections: "seq",
};
