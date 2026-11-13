// Loads the Schematic workspace for the app (web/src/es-workspace.d.ts types it for the
// shell). Order matters: EasySchematic's modules read localStorage when they first
// evaluate, so the editor's storage is installed before the editor is imported.
import { installEditorStorage } from "./storage";

export async function loadSchematicWorkspace() {
  installEditorStorage();
  return import("./workspace");
}
