// The shell's view of the Schematic workspace (web/src/es/load.ts). The shell and the
// editor are type-checked separately: the editor, with the vendored EasySchematic it
// imports, under upstream's compiler options (tsconfig.es.json); the shell under its
// own (tsconfig.json). This declaration is the contract between the two. vite.config.ts
// resolves "@brink/schematic-workspace" to web/src/es/load.ts.
declare module "@brink/schematic-workspace" {
  import type { ComponentType, ReactNode } from "react";
  type RowChange = import("../../src/shared/protocol.js").RowChange;

  export interface SchematicWorkspaceProps {
    projectId: string;
    importId: string | null;
    projectName: string;
    subscribeEdits: (cb: (c: RowChange) => void) => () => void;
    outline: ReactNode;
  }

  export function loadSchematicWorkspace(): Promise<{ default: ComponentType<SchematicWorkspaceProps> }>;
}
