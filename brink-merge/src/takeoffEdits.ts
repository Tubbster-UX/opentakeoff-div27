// The takeoff edit layer: people's edits to an OpenTakeoff takeoff, made in the
// Brink app's takeoff canvas, kept apart from the import's raw takeoff (the
// machine original OpenTakeoff or an agent exported) and re-applied on every
// render and every import. Pure (no Node, DOM or database APIs): brink-merge,
// the app's Worker and the canvas adapter in the browser import this one
// implementation. Rules: docs/takeoff-edits.md.
//
// An edit names its target by OpenTakeoff's own stable id (shape id, condition
// id, sheet id), never by position. Applying an edit either succeeds, or yields
// a warning Issue; it is never silently dropped and never re-aimed:
//   takeoff_edit_orphaned       the target (or the condition a shape names) is
//                               not in this takeoff: a re-export removed it
//   takeoff_edit_base_changed   the machine original the person edited changed
//                               in a later import; the person's edit still wins,
//                               and this says so
//   takeoff_edit_review_refused an edit not made by a verified person tried to
//                               mark machine work reviewed; the flag is not taken
//
// Machine originals: an edit of a shape that an agent or a machine method made
// keeps the machine's own record. The import's raw takeoff is never rewritten,
// and the applied shape always carries the machine's original ring in
// origin.proposed_verts_norm (OpenTakeoff's own rule, lib/provenance.js
// stampEdit), plus the original actor and method: an edit cannot relabel agent
// work as a person's.
import { fnv1a } from "./ids.js";
import type { Issue } from "./issues.js";
import type { MeasureRole, OtCondition, OtShape, OtSheet, OtTakeoff } from "./ot/types.js";

export type TakeoffEditKind = "shape_put" | "shape_delete" | "condition_put" | "sheet_scale";
export type TakeoffTargetType = "shape" | "condition" | "sheet";
export const TAKEOFF_EDIT_KINDS: readonly TakeoffEditKind[] = ["shape_put", "shape_delete", "condition_put", "sheet_scale"];
/** Who wrote an edit. Only the first two are a person; `brink-merge` is a process (tests, scripts, agents' tools). */
export type EditorAuth = "cloudflare-access" | "dev-bypass" | "brink-merge";
export const HUMAN_AUTH: readonly EditorAuth[] = ["cloudflare-access", "dev-bypass"];

export function targetTypeOf(kind: TakeoffEditKind): TakeoffTargetType {
  return kind === "condition_put" ? "condition" : kind === "sheet_scale" ? "sheet" : "shape";
}

export interface SheetScalePayload {
  /** Feet (or the takeoff's unit) per stage pixel; null clears the scale. */
  units_per_px: number | null;
  scale_source?: string;
  scale_confirmed?: boolean;
}

export interface TakeoffTargetContext {
  /** fnv1a of the machine original's record when the edit was made (null: the target was not in the import). */
  baseHash?: string | null;
  finishTag?: string;
  measureRole?: string;
  label?: string;
}

export interface TakeoffEdit {
  id: string;
  targetType: TakeoffTargetType;
  targetKey: string;
  kind: TakeoffEditKind;
  payload: Record<string, unknown>;
  editorEmail: string;
  editorAuth: EditorAuth;
  createdAt: string;
  targetContext?: TakeoffTargetContext | null;
}

/** One requested edit. */
export interface TakeoffEditInput {
  kind: TakeoffEditKind;
  target: string;
  payload: Record<string, unknown>;
}

const ROLES: readonly MeasureRole[] = ["floor_area", "deduct", "linear", "surface_area", "count"];
const MAX_ID = 300;
const MAX_SHAPE_BYTES = 256 * 1024;
const MAX_CONDITION_BYTES = 64 * 1024;
const MAX_VERTS = 50_000;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPoint = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/** JSON with object keys sorted, so two equal records always serialize the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A short, stable fingerprint of a record (for "the machine original changed since the edit"). */
export const recordHash = (v: unknown): string => {
  const s = stableJson(v);
  return `${fnv1a(s)}${fnv1a(`${s}#`)}`;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Validate one op. Returns the normalized input, or an error message. */
export function parseTakeoffEditInput(raw: unknown): TakeoffEditInput | string {
  if (!isObj(raw)) return "an edit must be an object";
  const kind = raw.kind as TakeoffEditKind;
  if (!TAKEOFF_EDIT_KINDS.includes(kind)) return `kind must be one of ${TAKEOFF_EDIT_KINDS.join(", ")}`;
  if (!isId(raw.target)) return "target must be an OpenTakeoff shape, condition or sheet id";
  const target = raw.target;
  const p = raw.payload ?? {};
  if (!isObj(p)) return "payload must be an object";
  switch (kind) {
    case "shape_put": {
      const s = p.shape;
      if (!isObj(s)) return "shape_put: payload.shape must be the shape record";
      if (s.id !== target) return "shape_put: the shape's id must be the target";
      if (!isId(s.sheet_id)) return "shape_put: sheet_id is required";
      if (!isId(s.condition_id)) return "shape_put: condition_id is required";
      if (!ROLES.includes(s.measure_role as MeasureRole)) return `shape_put: measure_role must be one of ${ROLES.join(", ")}`;
      if (!Array.isArray(s.verts_norm) || s.verts_norm.length < 1 || s.verts_norm.length > MAX_VERTS || !s.verts_norm.every(isPoint)) return "shape_put: verts_norm must be a list of [x, y] points";
      if (s.computed !== undefined) {
        if (!isObj(s.computed)) return "shape_put: computed must be an object";
        for (const [k, v] of Object.entries(s.computed)) {
          if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) return `shape_put: computed.${k} must be a finite, non-negative number`;
        }
      }
      if (JSON.stringify(s).length > MAX_SHAPE_BYTES) return "shape_put: the shape record is too large";
      return { kind, target, payload: { shape: clone(s) } };
    }
    case "shape_delete":
      return { kind, target, payload: {} };
    case "condition_put": {
      const c = p.condition;
      if (!isObj(c)) return "condition_put: payload.condition must be the condition record";
      if (c.id !== target) return "condition_put: the condition's id must be the target";
      if (typeof c.finish_tag !== "string" || !c.finish_tag.trim() || c.finish_tag.length > 120) return "condition_put: finish_tag must be 1-120 characters";
      if (c.multiplier !== undefined && !(typeof c.multiplier === "number" && Number.isFinite(c.multiplier) && c.multiplier > 0)) return "condition_put: multiplier must be a positive number";
      if (c.waste_pct !== undefined && !(typeof c.waste_pct === "number" && Number.isFinite(c.waste_pct))) return "condition_put: waste_pct must be a number";
      if (JSON.stringify(c).length > MAX_CONDITION_BYTES) return "condition_put: the condition record is too large";
      return { kind, target, payload: { condition: clone(c) } };
    }
    case "sheet_scale": {
      const u = p.units_per_px;
      if (!(u === null || (typeof u === "number" && Number.isFinite(u) && u > 0))) return "sheet_scale: units_per_px must be a positive number or null";
      if (p.scale_source !== undefined && !(typeof p.scale_source === "string" && p.scale_source.length <= 40)) return "sheet_scale: scale_source must be a short string";
      if (p.scale_confirmed !== undefined && typeof p.scale_confirmed !== "boolean") return "sheet_scale: scale_confirmed must be true or false";
      const out: Record<string, unknown> = { units_per_px: u };
      if (p.scale_source !== undefined) out.scale_source = p.scale_source;
      if (p.scale_confirmed !== undefined) out.scale_confirmed = p.scale_confirmed;
      return { kind, target, payload: out };
    }
  }
  return `kind ${String(kind)} is not writable`;
}

/** Machine work: an agent actor, or a method other than a person's manual trace (OpenTakeoff's own test, provenance.js). */
export function isMachineOrigin(shape: { origin?: unknown } | undefined): boolean {
  const o = shape?.origin as { actor?: unknown; method?: unknown } | undefined;
  return !!o && (o.actor === "agent" || (typeof o.method === "string" && o.method !== "manual"));
}

/** What the target is now, stored with the edit for later messages. */
export function takeoffTargetContext(base: OtTakeoff | null, input: TakeoffEditInput): TakeoffTargetContext {
  const ctx: TakeoffTargetContext = {};
  if (input.kind === "shape_put" || input.kind === "shape_delete") {
    const orig = base?.shapes.find((s) => s.id === input.target);
    ctx.baseHash = orig ? recordHash(orig) : null;
    const s = (input.payload.shape as OtShape | undefined) ?? orig;
    if (s) {
      ctx.measureRole = s.measure_role;
      const cond = base?.conditions.find((c) => c.id === s.condition_id);
      if (cond) ctx.finishTag = cond.finish_tag;
      if (typeof s.label === "string") ctx.label = s.label;
    }
  } else if (input.kind === "condition_put") {
    const orig = base?.conditions.find((c) => c.id === input.target);
    ctx.baseHash = orig ? recordHash(orig) : null;
    ctx.finishTag = String((input.payload.condition as OtCondition).finish_tag);
  } else {
    const orig = base?.sheets.find((s) => s.sheet_id === input.target);
    ctx.baseHash = orig ? recordHash({ units_per_px: orig.units_per_px ?? null, scale_source: orig.scale_source ?? null, scale_confirmed: orig.scale_confirmed ?? null }) : null;
  }
  return JSON.parse(JSON.stringify(ctx)) as TakeoffTargetContext;
}

export interface TakeoffApplyResult {
  takeoff: OtTakeoff;
  /** Ids of the edits applied, in application order. */
  applied: string[];
  /** One warning per edit that was not applied as made (orphaned, or applied over a changed original). */
  issues: Issue[];
  /** Shapes whose geometry or record an edit changed, added or removed (for the cable cross-check's message). */
  editedShapeIds: Set<string>;
  /** Conditions an applied edit touched: their own record, or a shape on them (before or after the edit). */
  editedConditionIds: Set<string>;
}

/** Application order: conditions first (shapes name them), then scales, deletes, then puts. */
const ORDER: Record<TakeoffEditKind, number> = { condition_put: 0, sheet_scale: 1, shape_delete: 2, shape_put: 3 };

const q = (s: unknown): string => JSON.stringify(String(s ?? ""));

export function describeTakeoffEdit(e: TakeoffEdit): string {
  const c = e.targetContext ?? {};
  const what = `${c.finishTag ? `${q(c.finishTag)} ` : ""}${c.measureRole ? `${c.measureRole} ` : ""}${e.targetKey}`;
  switch (e.kind) {
    case "shape_put":
      return c.baseHash === null ? `shape ${what} added` : `edit of shape ${what}`;
    case "shape_delete":
      return `deletion of shape ${what}`;
    case "condition_put":
      return `edit of condition ${what}`;
    case "sheet_scale":
      return `scale of sheet ${e.targetKey}`;
  }
}

/**
 * The takeoff people see: `base` (an import's raw takeoff, never modified) with the project's active edits applied.
 * Pure; returns a new takeoff.
 */
export function applyTakeoffEdits(base: OtTakeoff, edits: readonly TakeoffEdit[]): TakeoffApplyResult {
  const out = clone(base);
  out.shapes = out.shapes ?? [];
  out.conditions = out.conditions ?? [];
  out.sheets = out.sheets ?? [];
  const original = new Map((base.shapes ?? []).map((s) => [s.id, s]));
  const issues: Issue[] = [];
  const applied: string[] = [];
  const editedShapeIds = new Set<string>();
  const editedConditionIds = new Set<string>();
  const warn = (code: Issue["code"], e: TakeoffEdit, message: string, extra: Record<string, unknown> = {}) =>
    issues.push({ severity: "warning", code, message, ...(e.targetContext?.finishTag ? { conditionKey: e.targetContext.finishTag } : {}), refs: { editId: e.id, target: e.targetKey, kind: e.kind, editor: e.editorEmail, ...extra } });

  const sorted = [...edits].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const e of sorted) {
    switch (e.kind) {
      case "condition_put": {
        const c = clone(e.payload.condition) as OtCondition;
        const i = out.conditions.findIndex((x) => x.id === e.targetKey);
        if (i >= 0) {
          if (e.targetContext?.baseHash && recordHash(base.conditions[i]) !== e.targetContext.baseHash) {
            warn("takeoff_edit_base_changed", e, `${describeTakeoffEdit(e)} by ${e.editorEmail} was made on an earlier export of this condition; the person's edit still applies over the newer one`);
          }
          out.conditions[i] = c;
        } else out.conditions.push(c);
        editedConditionIds.add(c.id);
        applied.push(e.id);
        break;
      }
      case "sheet_scale": {
        const p = e.payload as unknown as SheetScalePayload;
        let sheet = out.sheets.find((s) => s.sheet_id === e.targetKey);
        if (!sheet) {
          sheet = { sheet_id: e.targetKey } as OtSheet;
          out.sheets.push(sheet);
        }
        if (p.units_per_px == null) delete sheet.units_per_px;
        else sheet.units_per_px = p.units_per_px;
        if (p.scale_source !== undefined) sheet.scale_source = p.scale_source;
        if (p.scale_confirmed !== undefined) sheet.scale_confirmed = p.scale_confirmed;
        applied.push(e.id);
        break;
      }
      case "shape_delete": {
        const i = out.shapes.findIndex((s) => s.id === e.targetKey);
        if (i < 0) {
          warn("takeoff_edit_orphaned", e, `${describeTakeoffEdit(e)} by ${e.editorEmail} names a shape this takeoff does not have (a later export removed it); the edit is kept and not applied`, { reason: "shape not in this takeoff" });
          break;
        }
        editedConditionIds.add(out.shapes[i]!.condition_id);
        out.shapes.splice(i, 1);
        editedShapeIds.add(e.targetKey);
        applied.push(e.id);
        break;
      }
      case "shape_put": {
        const s = clone(e.payload.shape) as OtShape;
        if (!out.conditions.some((c) => c.id === s.condition_id)) {
          warn("takeoff_edit_orphaned", e, `${describeTakeoffEdit(e)} by ${e.editorEmail} is on condition ${s.condition_id}, which this takeoff does not have; the edit is kept and not applied`, { reason: "condition not in this takeoff" });
          break;
        }
        const orig = original.get(s.id);
        if (orig && e.targetContext?.baseHash && recordHash(orig) !== e.targetContext.baseHash) {
          warn("takeoff_edit_base_changed", e, `${describeTakeoffEdit(e)} by ${e.editorEmail} was made on an earlier export of this shape; the person's edit still applies over the newer machine version`);
        }
        const kept = keepMachineOriginal(orig, s, e, (m) => warn("takeoff_edit_review_refused", e, m));
        const i = out.shapes.findIndex((x) => x.id === s.id);
        if (i >= 0) {
          editedConditionIds.add(out.shapes[i]!.condition_id);
          out.shapes[i] = kept;
        } else out.shapes.push(kept);
        editedConditionIds.add(kept.condition_id);
        editedShapeIds.add(s.id);
        applied.push(e.id);
        break;
      }
    }
  }
  return { takeoff: out, applied, issues, editedShapeIds, editedConditionIds };
}

const sameRing = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/**
 * The shape an edit puts, with the machine's original kept: the original actor and method, and its ring in
 * origin.proposed_verts_norm (set from the original if the edit changed the geometry and does not already carry it;
 * never replaced). Review: only a person (HUMAN_AUTH) can turn origin.reviewed on.
 */
export function keepMachineOriginal(orig: OtShape | undefined, next: OtShape, e: Pick<TakeoffEdit, "editorAuth">, refuse: (message: string) => void): OtShape {
  const human = HUMAN_AUTH.includes(e.editorAuth);
  const out = clone(next);
  const o = (out.origin ?? undefined) as Record<string, unknown> | undefined;
  if (orig && isMachineOrigin(orig)) {
    const oo = orig.origin as Record<string, unknown>;
    const origin: Record<string, unknown> = { ...(o ?? {}), actor: oo.actor, method: oo.method };
    const frozen = oo.proposed_verts_norm ?? (sameRing(orig.verts_norm, next.verts_norm) ? undefined : orig.verts_norm);
    if (frozen !== undefined) origin.proposed_verts_norm = clone(frozen);
    if (oo.actor === undefined) delete origin.actor;
    if (oo.method === undefined) delete origin.method;
    out.origin = origin;
  }
  const wasReviewed = (orig?.origin as { reviewed?: unknown } | undefined)?.reviewed === true;
  const nowReviewed = (out.origin as { reviewed?: unknown } | undefined)?.reviewed === true;
  if (!human && nowReviewed && !wasReviewed) {
    (out.origin as Record<string, unknown>).reviewed = orig ? ((orig.origin as { reviewed?: unknown } | undefined)?.reviewed ?? false) : false;
    refuse(`an edit not made by a verified person marked shape ${next.id} reviewed; only a person accepts machine work, so it stays unreviewed`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The canvas side: what changed between the document the canvas loaded and the one it saves.

/** Top-level takeoff fields the edit layer keeps (shapes, conditions, sheet scales). */
export const KEPT_FIELDS = ["shapes", "conditions", "sheets"] as const;
/** Per-tab view state: kept in the browser tab, never reported as unsaved. */
export const VIEW_FIELDS = ["sheet_tabs", "sheet_group", "last_group", "palette", "split_view", "units", "schema"] as const;

export interface TakeoffDiff {
  ops: TakeoffEditInput[];
  /** Changes the layer does not keep, as short descriptions ("markups", "conditions removed: …"). */
  unsupported: string[];
}

const byId = <T extends { id: string }>(list: readonly T[] | undefined): Map<string, T> => new Map((list ?? []).filter((x) => x && typeof x.id === "string").map((x) => [x.id, x]));
const scaleOf = (s: OtSheet | undefined): SheetScalePayload => ({
  units_per_px: typeof s?.units_per_px === "number" && s.units_per_px > 0 ? s.units_per_px : null,
  ...(typeof s?.scale_source === "string" ? { scale_source: s.scale_source } : {}),
  ...(typeof s?.scale_confirmed === "boolean" ? { scale_confirmed: s.scale_confirmed } : {}),
});

/** The edit-layer ops that turn `before` into `after` (both OpenTakeoff takeoff documents), and what cannot be kept. */
export function diffTakeoff(before: Partial<OtTakeoff>, after: Partial<OtTakeoff>): TakeoffDiff {
  const ops: TakeoffEditInput[] = [];
  const unsupported: string[] = [];
  const bc = byId(before.conditions);
  const ac = byId(after.conditions);
  for (const [id, c] of ac) if (stableJson(bc.get(id)) !== stableJson(c)) ops.push({ kind: "condition_put", target: id, payload: { condition: clone(c) } });
  const goneConds = [...bc.values()].filter((c) => !ac.has(c.id)).map((c) => c.finish_tag || c.id);
  if (goneConds.length) unsupported.push(`conditions removed: ${goneConds.join(", ")}`);

  const bs = new Map((before.sheets ?? []).map((s) => [s.sheet_id, s]));
  const as = new Map((after.sheets ?? []).map((s) => [s.sheet_id, s]));
  for (const id of new Set([...bs.keys(), ...as.keys()])) {
    const a = scaleOf(as.get(id));
    if (stableJson(scaleOf(bs.get(id))) !== stableJson(a)) ops.push({ kind: "sheet_scale", target: id, payload: { ...a } });
  }

  const bsh = byId(before.shapes);
  const ash = byId(after.shapes);
  for (const [id] of bsh) if (!ash.has(id)) ops.push({ kind: "shape_delete", target: id, payload: {} });
  for (const [id, s] of ash) if (stableJson(bsh.get(id)) !== stableJson(s)) ops.push({ kind: "shape_put", target: id, payload: { shape: clone(s) } });

  const skip = new Set<string>([...KEPT_FIELDS, ...VIEW_FIELDS]);
  // Only fields the canvas writes: a field it does not carry at all (a Division 27 export's cable_runs on a canvas
  // without the cable setup) is not a change anyone made, and the layer keeps the export's value.
  for (const k of Object.keys(after)) {
    if (skip.has(k)) continue;
    const b = (before as Record<string, unknown>)[k];
    const a = (after as Record<string, unknown>)[k];
    const empty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0) || v === "";
    if (empty(a) && empty(b)) continue;
    if (stableJson(a) !== stableJson(b)) unsupported.push(k.replace(/_/g, " "));
  }
  return { ops, unsupported };
}

// ---------------------------------------------------------------------------
// SQL shared by brink-merge and the app's Worker.

/** Supersede the active edit of (project, target type, target). $1 project, $2 target type, $3 target, $4 the new edit's id. */
export const SUPERSEDE_TAKEOFF_EDIT_SQL = `update brink_takeoff_edits set superseded_at = now(), superseded_by = $4
  where project_id = $1 and target_type = $2 and target_key = $3 and superseded_at is null and reverted_at is null returning id`;

/** Insert one edit. $1 id, $2 project, $3 target type, $4 target, $5 kind, $6 payload, $7 target_context, $8 email, $9 auth, $10 client_ref, $11 base import. */
export const INSERT_TAKEOFF_EDIT_SQL = `insert into brink_takeoff_edits
  (id, project_id, target_type, target_key, kind, payload, target_context, editor_email, editor_auth, client_ref, base_import_id)
  values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
  returning id, target_type, target_key, kind, payload, target_context, editor_email, editor_auth, client_ref, base_import_id, created_at`;

/** A project's active takeoff edits, oldest first. $1 project. */
export const ACTIVE_TAKEOFF_EDITS_SQL = `select id, target_type, target_key, kind, payload, target_context, editor_email, editor_auth, created_at
  from brink_takeoff_edits where project_id = $1 and superseded_at is null and reverted_at is null order by created_at, id`;

export interface TakeoffEditRow {
  id: string;
  target_type: TakeoffTargetType;
  target_key: string;
  kind: TakeoffEditKind;
  payload: Record<string, unknown>;
  target_context: TakeoffTargetContext | null;
  editor_email: string;
  editor_auth: EditorAuth;
  created_at: string | Date;
}

export function takeoffEditFromRow(r: TakeoffEditRow): TakeoffEdit {
  return {
    id: r.id,
    targetType: r.target_type,
    targetKey: r.target_key,
    kind: r.kind,
    payload: r.payload,
    editorEmail: r.editor_email,
    editorAuth: r.editor_auth,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    targetContext: r.target_context,
  };
}
