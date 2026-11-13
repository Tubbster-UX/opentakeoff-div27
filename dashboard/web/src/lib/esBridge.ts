// Messages between the Schematic tab and the editor's save / live sync
// (web/src/es/sync.ts). Since the editor mounts in the app itself (no frame),
// these are plain in-process calls; the message shapes are the ones Phase 2's
// frame bridge used, so the sync logic is unchanged.
import type { RowChange } from "../../../src/shared/protocol.js";

export type SaveState = "loading" | "saving" | "saved" | "pending" | "error" | "suspended";

/** Editor sync -> tab. */
export type EditorMessage =
  | {
      type: "es:status";
      state: SaveState;
      /** Saveable changes not yet saved. */
      pending: number;
      /** Changes in the editor that the edit layer does not keep (shown so they are not silently lost). */
      unsupported: string[];
      savedAt: string | null;
      editor: string | null;
      message?: string;
    }
  | { type: "es:notice"; tone: "info" | "warn" | "error"; text: string };

/** Tab -> editor sync. */
export type TabMessage =
  /** A row of brink_schematic_edits changed (relayed by the Worker). */
  | { type: "es:edit-change"; change: RowChange }
  /** The project's current import changed (re-import / re-merge). */
  | { type: "es:import-changed"; importId: string | null }
  /** Discard unsaved changes and reload the project schematic. */
  | { type: "es:reload" };

export type EditorStatus = Extract<EditorMessage, { type: "es:status" }>;
