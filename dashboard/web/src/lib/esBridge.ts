// Messages between the Schematic tab (the app page) and the EasySchematic
// editor frame it embeds (es-frame.html). Same origin; both sides check the
// sender's origin and window before reading a message.
import type { RowChange } from "../../../src/shared/protocol.js";

export type SaveState = "loading" | "saving" | "saved" | "pending" | "error" | "suspended";

/** Frame -> page. */
export type FrameMessage =
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

/** Page -> frame. */
export type PageMessage =
  /** A row of brink_schematic_edits changed (relayed by the Worker). */
  | { type: "es:edit-change"; change: RowChange }
  /** The project's current import changed (re-import / re-merge). */
  | { type: "es:import-changed"; importId: string | null }
  /** Discard unsaved changes and reload the project schematic. */
  | { type: "es:reload" };

export function isFrameMessage(v: unknown): v is FrameMessage {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string" && (v as { type: string }).type.startsWith("es:");
}
