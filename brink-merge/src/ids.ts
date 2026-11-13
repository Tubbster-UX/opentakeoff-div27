// Stable EasySchematic node / edge ids, derived from OpenTakeoff's own ids so
// they survive a re-import of the same takeoff. The schematic edit layer
// (edits.ts) keys every edit on these, so they must never depend on the order
// in which shapes or runs appear in an export.
//   device node   dev-<shape id>-<copy>        (copy: 1..multiplier)
//   TR panel      tr-<TR shape id>
//   room          room-<slug>-<hash of the exact label>
//   cable         cable-<run id>-<copy>-<cable n>
//   note          note-brink
// Pure (no Node or DOM APIs): the Worker and the editor frame import it too.

/** 32-bit FNV-1a of a string, as 8 hex digits. Deterministic, not cryptographic. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";

export const deviceNodeId = (shapeId: string, copy: number): string => `dev-${shapeId}-${copy}`;
export const trNodeId = (shapeId: string): string => `tr-${shapeId}`;
export const roomNodeId = (label: string): string => `room-${slug(label)}-${fnv1a(label)}`;
export const cableEdgeId = (runId: string, copy: number, k: number): string => `cable-${runId}-${copy}-${k}`;
export const NOTE_NODE_ID = "note-brink";

/** The edit-layer key of a connection a person added: its two endpoints. One connection per endpoint pair. */
export const connectKey = (source: string, sourceHandle: string | null | undefined, target: string, targetHandle: string | null | undefined): string =>
  `conn|${source}|${sourceHandle ?? ""}|${target}|${targetHandle ?? ""}`;

/** The rendered edge id of an added connection (CSS-safe, derived from its key). */
export const connEdgeId = (key: string): string => `conn-${fnv1a(key)}${fnv1a(`${key}#`)}`;
