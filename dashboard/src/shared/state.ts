// The browser's view of one project, and how a relayed row change updates it.
// Pure, so it is unit tested and shared by the page.
import { isImportTable, ORDER_COLUMN, rowKey, SNAPSHOT_TABLE, type Row, type RowChange, type Snapshot } from "./protocol.js";

export type ApplyResult =
  /** The snapshot changed; `key` names the row (for highlighting). */
  | { kind: "applied"; snapshot: Snapshot; key: string | null }
  /** Not this project's current import. */
  | { kind: "ignored" }
  /** The project now points at another import (re-import / re-merge) or was deleted: read it again. */
  | { kind: "resync"; reason: string };

export function applyChange(s: Snapshot, c: RowChange): ApplyResult {
  const projectId = s.project.id;
  const importId = s.import?.id ?? null;

  if (c.table === "brink_projects") {
    const r = c.record ?? c.old;
    if (!r || r.id !== projectId) return { kind: "ignored" };
    if (c.type === "DELETE") return { kind: "resync", reason: "project deleted" };
    const next = c.record!;
    if ((next.current_import_id ?? null) !== (s.project.current_import_id ?? null)) {
      return { kind: "resync", reason: "current import changed" };
    }
    return { kind: "applied", snapshot: { ...s, project: { ...s.project, ...next } }, key: rowKey("brink_projects", next) };
  }

  if (c.table === "brink_imports") {
    const r = c.record ?? c.old;
    if (!r || importId == null || r.id !== importId) return { kind: "ignored" };
    if (c.type === "DELETE") return { kind: "resync", reason: "current import deleted" };
    return { kind: "applied", snapshot: { ...s, import: { ...s.import, ...c.record } }, key: rowKey("brink_imports", c.record!) };
  }

  if (!isImportTable(c.table)) return { kind: "ignored" };
  const r = c.record ?? c.old;
  if (!r || importId == null || r.import_id !== importId) return { kind: "ignored" };
  const field = SNAPSHOT_TABLE[c.table];
  const key = rowKey(c.table, r);
  const rows = s[field].filter((x) => rowKey(c.table, x) !== key);
  if (c.type !== "DELETE") {
    const prev = s[field].find((x) => rowKey(c.table, x) === key);
    rows.push({ ...(prev ?? {}), ...c.record });
    const order = ORDER_COLUMN[c.table];
    rows.sort((a, b) => Number(a[order]) - Number(b[order]));
  }
  return { kind: "applied", snapshot: { ...s, [field]: rows }, key };
}

/** Totals shown in the header, recomputed from rows. */
export function summarize(s: Snapshot): { devices: number; rooms: number; connections: number; cableLf: number; errors: number; warnings: number; bomLines: number } {
  const lf = s.connections.reduce((t, c) => t + (Number(c.cable_length_ft) || 0), 0);
  return {
    devices: s.nodes.filter((n) => n.node_type === "device").length,
    rooms: s.nodes.filter((n) => n.node_type === "room").length,
    connections: s.connections.length,
    cableLf: Math.round(lf * 100) / 100,
    errors: s.issues.filter((i) => i.severity === "error").length,
    warnings: s.issues.filter((i) => i.severity === "warning").length,
    bomLines: s.bom.filter((l) => l.kind !== "issue").length,
  };
}

export type { Row };
