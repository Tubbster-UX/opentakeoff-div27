// Shared by the Worker, the Durable Object relay and the browser: which
// brink-merge tables the dashboard reflects, which of their columns it sends,
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
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
export const TABLES = Object.keys(TABLE_COLUMNS) as TableName[];

/** Primary key of each table (brink-merge's migration). Every child table's key starts with import_id. */
export const PRIMARY_KEY: Record<TableName, readonly string[]> = {
  brink_projects: ["id"],
  brink_imports: ["id"],
  brink_bom_lines: ["import_id", "line_no"],
  brink_issues: ["import_id", "seq"],
  brink_schematic_nodes: ["import_id", "node_id"],
  brink_schematic_connections: ["import_id", "edge_id"],
};

/** Child tables: one import's rows. */
export const IMPORT_TABLES = ["brink_bom_lines", "brink_issues", "brink_schematic_nodes", "brink_schematic_connections"] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** Numeric columns (Postgres numeric / integer). Realtime and pg may hand them over as strings. */
const NUMERIC = new Set(["line_no", "qty", "net_lf", "order_lf", "seq", "x", "y", "cable_length_ft", "errors", "warnings", "es_schema_version"]);

export type Row = Record<string, unknown>;

export function isTable(t: unknown): t is TableName {
  return typeof t === "string" && Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, t);
}

export function isImportTable(t: TableName): t is ImportTable {
  return (IMPORT_TABLES as readonly string[]).includes(t);
}

/** Keep only the dashboard's columns, with numbers as numbers. Columns missing from the source are left out (a DELETE carries only the key). */
export function projectRow(table: TableName, row: Row | null | undefined): Row | null {
  if (!row) return null;
  const out: Row = {};
  for (const c of TABLE_COLUMNS[table]) {
    if (!(c in row)) continue;
    const v = row[c];
    out[c] = NUMERIC.has(c) && typeof v === "string" && v !== "" ? Number(v) : v;
  }
  return out;
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

/** Normalize a Supabase Realtime postgres_changes payload (realtime-js shape). Returns null for tables the dashboard does not reflect. */
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
    default:
      return { importId: r.import_id as string | undefined };
  }
}

/** Upstream (DO -> Supabase Realtime) state, shown in the page header. */
export type UpstreamStatus = "connecting" | "live" | "down" | "unconfigured";

/** Server -> browser. */
export type ServerMessage =
  | { type: "status"; upstream: UpstreamStatus; detail?: string }
  | { type: "change"; change: RowChange };

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
