// The schematic edit layer: people's edits to a generated schematic, kept
// apart from the import's rows and re-applied on every render and every
// re-import. Pure (no Node, DOM or database APIs): brink-merge, the app's
// Worker and its editor frame all import this one implementation.
//
// An edit names its target by a STABLE key (ids.ts), never by position or
// order. Applying an edit either succeeds exactly, or yields an Issue:
//   schematic_edit_orphaned   the target (or the room / port it names) is not
//                             in this schematic: the device left the takeoff
//   schematic_edit_conflict   the target exists, but applying the edit would
//                             no longer mean what its author meant (the device
//                             is in another room than the move was made in, a
//                             port now carries a generated cable)
// Either way the edit stays in the database and is reported; it is never
// dropped and never re-aimed at something else. docs/schematic-edits.md.
import type { Issue } from "./issues.js";
import { connEdgeId, connectKey } from "./ids.js";
import type { ConnectionEdge, DeviceData, SchematicFile, SchematicNode, SignalType } from "./vendor/esTypes.js";

export type EditKind = "move" | "rename" | "room_assign" | "connect" | "disconnect" | "property";
export const EDIT_KINDS: readonly EditKind[] = ["move", "rename", "room_assign", "connect", "disconnect", "property"];
/** Kinds the app writes. `property` is reserved in the schema; an edit of it is reported, not applied. */
export const WRITABLE_KINDS: readonly EditKind[] = ["move", "rename", "room_assign", "connect", "disconnect"];

/** Position relative to `parent` (the room it was made in; null = the canvas). Rooms may also carry a size. */
export interface MovePayload {
  x: number;
  y: number;
  parent: string | null;
  width?: number;
  height?: number;
}
export interface RenamePayload {
  label: string;
}
/** room null = out of every room. */
export interface RoomAssignPayload {
  room: string | null;
}
export interface ConnectPayload {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  signalType: string;
  label?: string;
  cableLength?: string;
}
export type DisconnectPayload = Record<string, never>;

export interface TargetContext {
  label?: string;
  nodeType?: string;
  conditionKey?: string;
  /** room_assign: the room's label; connect: the endpoints' labels. */
  roomLabel?: string;
  sourceLabel?: string;
  targetLabel?: string;
}

export interface SchematicEdit {
  id: string;
  targetKey: string;
  kind: EditKind;
  payload: Record<string, unknown>;
  editorEmail: string;
  createdAt: string;
  targetContext?: TargetContext | null;
}

export interface ApplyResult {
  file: SchematicFile;
  /** Ids of the edits applied, in application order. */
  applied: string[];
  /** One warning per edit that was not applied. */
  issues: Issue[];
}

/** Application order: names first, then room membership, then positions (relative to that membership), then cables. */
const ORDER: Record<EditKind, number> = { rename: 0, room_assign: 1, move: 2, disconnect: 3, connect: 4, property: 5 };

const FACE = /-(in|out|rear|front)$/;

/** The port a handle names on a device node: "p3", "p3-rear", "p3-in". */
export function portForHandle(node: SchematicNode | undefined, handle: string | null): boolean {
  if (!node || node.type !== "device") return false;
  if (handle == null) return true;
  const ports = (node.data as DeviceData).ports ?? [];
  return ports.some((p) => p.id === handle) || ports.some((p) => p.id === handle.replace(FACE, ""));
}

const handleKey = (node: string, handle: string | null | undefined): string => `${node}:${handle ?? ""}`;

/** Every edge endpoint in use, as node:handle. */
export function usedHandles(edges: ConnectionEdge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) {
    s.add(handleKey(e.source, e.sourceHandle));
    s.add(handleKey(e.target, e.targetHandle));
  }
  return s;
}

/** The edge an applied connect edit renders as. */
export function connectEdge(edit: Pick<SchematicEdit, "id" | "editorEmail">, p: ConnectPayload): ConnectionEdge {
  const key = connectKey(p.source, p.sourceHandle, p.target, p.targetHandle);
  return {
    id: connEdgeId(key),
    source: p.source,
    ...(p.sourceHandle != null ? { sourceHandle: p.sourceHandle } : {}),
    target: p.target,
    ...(p.targetHandle != null ? { targetHandle: p.targetHandle } : {}),
    data: {
      signalType: p.signalType as SignalType,
      ...(p.label ? { label: p.label } : {}),
      ...(p.cableLength ? { cableLength: p.cableLength } : {}),
      brink: { source: "edit", editId: edit.id, editor: edit.editorEmail },
    },
  };
}

const q = (s: unknown): string => JSON.stringify(String(s ?? ""));

/** One line saying what an edit did, for issue messages. */
export function describeEdit(e: SchematicEdit): string {
  const c = e.targetContext ?? {};
  const what = c.label ? `${q(c.label)} (${e.targetKey})` : e.targetKey;
  const p = e.payload;
  switch (e.kind) {
    case "rename":
      return `rename of ${what} to ${q(p.label)}`;
    case "move":
      return `move of ${what}`;
    case "room_assign":
      return p.room == null ? `move of ${what} out of its room` : `move of ${what} into room ${c.roomLabel ? q(c.roomLabel) : String(p.room)}`;
    case "connect":
      return `added connection ${c.sourceLabel ? q(c.sourceLabel) : String(p.source)} ${p.sourceHandle ?? ""} -> ${c.targetLabel ? q(c.targetLabel) : String(p.target)} ${p.targetHandle ?? ""}`.replace(/ +/g, " ");
    case "disconnect":
      return `removal of cable ${what}`;
    default:
      return `${e.kind} edit of ${what}`;
  }
}

function issue(code: "schematic_edit_orphaned" | "schematic_edit_conflict", e: SchematicEdit, why: string): Issue {
  const by = `${e.editorEmail}, ${e.createdAt.slice(0, 10)}`;
  const tail = code === "schematic_edit_orphaned"
    ? "Not applied; the edit is kept and applies again if its target comes back."
    : "Not applied; the edit is kept. Redo it in the Schematic tab, or revert it.";
  return {
    severity: "warning",
    code,
    message: `Schematic edit (${by}): ${describeEdit(e)}: ${why}. ${tail}`,
    ...(e.targetContext?.conditionKey ? { conditionKey: e.targetContext.conditionKey } : {}),
    refs: { editId: e.id, targetKey: e.targetKey, kind: e.kind, editor: e.editorEmail },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Apply `edits` (a project's active edits) to a generated schematic. The input is not modified.
 * Deterministic: the same file and edits always give the same result.
 */
export function applyEdits(source: SchematicFile, edits: readonly SchematicEdit[]): ApplyResult {
  const file = clone(source);
  const nodes = new Map(file.nodes.map((n) => [n.id, n]));
  const applied: string[] = [];
  const issues: Issue[] = [];
  const sorted = [...edits].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  for (const e of sorted) {
    const p = e.payload;
    const node = nodes.get(e.targetKey);
    switch (e.kind) {
      case "rename": {
        if (!node) {
          issues.push(issue("schematic_edit_orphaned", e, `${e.targetKey} is not in this import`));
          continue;
        }
        (node.data as { label: string }).label = String(p.label);
        break;
      }
      case "room_assign": {
        if (!node) {
          issues.push(issue("schematic_edit_orphaned", e, `${e.targetKey} is not in this import`));
          continue;
        }
        if (node.type === "room") {
          issues.push(issue("schematic_edit_conflict", e, "a room cannot be put inside another room here"));
          continue;
        }
        const room = p.room == null ? null : String(p.room);
        if (room != null && nodes.get(room)?.type !== "room") {
          issues.push(issue("schematic_edit_orphaned", e, `room ${room} is not in this import`));
          continue;
        }
        if (room == null) delete node.parentId;
        else node.parentId = room;
        break;
      }
      case "move": {
        if (!node) {
          issues.push(issue("schematic_edit_orphaned", e, `${e.targetKey} is not in this import`));
          continue;
        }
        const parent = p.parent == null ? null : String(p.parent);
        if ((node.parentId ?? null) !== parent) {
          issues.push(issue("schematic_edit_conflict", e, `the position was set inside ${parent ?? "the canvas"}, but the element is now in ${node.parentId ?? "the canvas"}`));
          continue;
        }
        node.position = { x: Number(p.x), y: Number(p.y) };
        if (node.type === "room" && typeof p.width === "number" && typeof p.height === "number") {
          node.style = { ...(node.style ?? {}), width: p.width, height: p.height };
          node.width = p.width;
          node.height = p.height;
        }
        break;
      }
      case "disconnect": {
        const i = file.edges.findIndex((x) => x.id === e.targetKey);
        if (i < 0) {
          issues.push(issue("schematic_edit_orphaned", e, `cable ${e.targetKey} is not in this import`));
          continue;
        }
        file.edges.splice(i, 1);
        break;
      }
      case "connect": {
        const c = p as unknown as ConnectPayload;
        const missing = [[c.source, c.sourceHandle], [c.target, c.targetHandle]].filter(([n, h]) => !portForHandle(nodes.get(n as string), h as string | null));
        if (missing.length) {
          issues.push(issue("schematic_edit_orphaned", e, `${missing.map(([n, h]) => `${n}${h ? ` port ${h}` : ""}`).join(" and ")} ${missing.length > 1 ? "are" : "is"} not in this import`));
          continue;
        }
        const used = usedHandles(file.edges);
        const busy = [handleKey(c.source, c.sourceHandle), handleKey(c.target, c.targetHandle)].filter((k) => used.has(k));
        if (busy.length) {
          issues.push(issue("schematic_edit_conflict", e, `${busy.join(" and ")} already ${busy.length > 1 ? "carry" : "carries"} a cable`));
          continue;
        }
        file.edges.push(connectEdge(e, c));
        break;
      }
      default:
        issues.push(issue("schematic_edit_conflict", e, `edits of kind ${e.kind} are not supported by this version`));
        continue;
    }
    applied.push(e.id);
  }
  return { file, applied, issues };
}

// ---------------------------------------------------------------------------
// Writing edits. The SQL is shared by brink-merge (repository.ts) and the
// app's Worker, so both keep the same append-only rules.

/** Mark the active edit of (project, target, kind) superseded. $1 project, $2 target, $3 kind, $4 new edit id. Returns the old id. */
export const SUPERSEDE_EDIT_SQL = `update brink_schematic_edits set superseded_at = now(), superseded_by = $4
  where project_id = $1 and target_key = $2 and kind = $3 and superseded_at is null and reverted_at is null returning id`;

/** Insert one edit. $1 id, $2 project, $3 target, $4 kind, $5 payload, $6 target_context, $7 email, $8 auth, $9 client_ref, $10 base import. */
export const INSERT_EDIT_SQL = `insert into brink_schematic_edits
  (id, project_id, target_key, kind, payload, target_context, editor_email, editor_auth, client_ref, base_import_id)
  values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
  returning id, target_key, kind, payload, target_context, editor_email, editor_auth, client_ref, base_import_id, created_at`;

/** A project's active edits, oldest first. $1 project. */
export const ACTIVE_EDITS_SQL = `select id, target_key, kind, payload, target_context, editor_email, created_at
  from brink_schematic_edits where project_id = $1 and superseded_at is null and reverted_at is null order by created_at, id`;

export interface EditRow {
  id: string;
  target_key: string;
  kind: EditKind;
  payload: Record<string, unknown>;
  target_context: TargetContext | null;
  editor_email: string;
  created_at: string | Date;
}

export const editFromRow = (r: EditRow): SchematicEdit => ({
  id: r.id,
  targetKey: r.target_key,
  kind: r.kind,
  payload: r.payload,
  editorEmail: r.editor_email,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  targetContext: r.target_context,
});

// ---------------------------------------------------------------------------
// Input from the app: shape checks (the Worker validates every op with these
// before it touches the database), and the target's context for messages.

/** One requested edit. For connect, `target` is ignored and recomputed from the payload (connectKey). */
export interface EditInput {
  kind: EditKind;
  target: string;
  payload: Record<string, unknown>;
}

const MAX_ID = 300;
const MAX_LABEL = 200;
const MAX_COORD = 1e7;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isHandle = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0 && v.length <= 100);
const isCoord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_COORD;
const optText = (v: unknown, max: number): boolean => v === undefined || (typeof v === "string" && v.length <= max);

/** Validate one op's shape. Returns the normalized input (unknown payload fields dropped), or an error message. */
export function parseEditInput(raw: unknown): EditInput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "an edit must be an object";
  const r = raw as Record<string, unknown>;
  const kind = r.kind as EditKind;
  if (!WRITABLE_KINDS.includes(kind)) return `kind must be one of ${WRITABLE_KINDS.join(", ")}`;
  const p = (r.payload ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return "payload must be an object";
  if (kind !== "connect" && !isId(r.target)) return "target must be a node or cable id";
  const target = r.target as string;
  switch (kind) {
    case "move": {
      if (!isCoord(p.x) || !isCoord(p.y)) return "move: x and y must be finite numbers";
      if (!(p.parent === null || isId(p.parent))) return "move: parent must be a room id or null";
      if ((p.width !== undefined || p.height !== undefined) && !(isSize(p.width) && isSize(p.height))) return "move: width and height must be positive numbers, together";
      return { kind, target, payload: { x: p.x, y: p.y, parent: p.parent, ...(p.width !== undefined ? { width: p.width, height: p.height } : {}) } };
    }
    case "rename": {
      if (typeof p.label !== "string" || p.label.trim() === "" || p.label.length > MAX_LABEL) return `rename: label must be 1-${MAX_LABEL} characters`;
      return { kind, target, payload: { label: p.label } };
    }
    case "room_assign": {
      if (!(p.room === null || isId(p.room))) return "room_assign: room must be a room id or null";
      return { kind, target, payload: { room: p.room } };
    }
    case "connect": {
      if (!isId(p.source) || !isId(p.target)) return "connect: source and target must be node ids";
      if (!isHandle(p.sourceHandle) || !isHandle(p.targetHandle)) return "connect: handles must be port handles or null";
      if (typeof p.signalType !== "string" || !p.signalType || p.signalType.length > 60) return "connect: signalType is required";
      if (!optText(p.label, MAX_LABEL) || !optText(p.cableLength, 40)) return "connect: label / cableLength too long";
      if (p.source === p.target) return "connect: a connection needs two different devices";
      const payload: Record<string, unknown> = { source: p.source, sourceHandle: p.sourceHandle, target: p.target, targetHandle: p.targetHandle, signalType: p.signalType };
      if (p.label) payload.label = p.label;
      if (p.cableLength) payload.cableLength = p.cableLength;
      return { kind, target: connectKey(p.source, p.sourceHandle as string | null, p.target, p.targetHandle as string | null), payload };
    }
    case "disconnect":
      return { kind, target, payload: {} };
  }
  return `kind ${String(kind)} is not writable`;
}

const labelOf = (n: SchematicNode | undefined): string | undefined => (n ? String((n.data as { label?: unknown }).label ?? "") || undefined : undefined);
const conditionOf = (n: SchematicNode | undefined): string | undefined => (n?.data as { brink?: { conditionKey?: string } } | undefined)?.brink?.conditionKey;

/** What the target is now, stored with the edit for later messages. */
export function targetContext(file: SchematicFile, input: EditInput): TargetContext {
  const nodes = new Map(file.nodes.map((n) => [n.id, n]));
  const ctx: TargetContext = {};
  if (input.kind === "connect") {
    const p = input.payload as unknown as ConnectPayload;
    ctx.sourceLabel = labelOf(nodes.get(p.source));
    ctx.targetLabel = labelOf(nodes.get(p.target));
    ctx.conditionKey = conditionOf(nodes.get(p.source));
  } else if (input.kind === "disconnect") {
    const e = file.edges.find((x) => x.id === input.target);
    if (e) {
      ctx.label = `${labelOf(nodes.get(e.source)) ?? e.source} -> ${labelOf(nodes.get(e.target)) ?? e.target}`;
      ctx.conditionKey = conditionOf(nodes.get(e.source));
    }
  } else {
    const n = nodes.get(input.target);
    ctx.label = labelOf(n);
    ctx.nodeType = n?.type;
    ctx.conditionKey = conditionOf(n);
    if (input.kind === "room_assign" && input.payload.room != null) ctx.roomLabel = labelOf(nodes.get(String(input.payload.room)));
  }
  return JSON.parse(JSON.stringify(ctx)) as TargetContext;
}

/** Is this edge one brink-merge generated from the takeoff (a cable), rather than one a person added? */
export const isGeneratedEdge = (e: ConnectionEdge): boolean => (e.data as { brink?: { source?: string } } | undefined)?.brink?.source === "opentakeoff";
