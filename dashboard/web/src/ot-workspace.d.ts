// The shell's view of the Takeoff workspace (web/src/ot/load.ts). The shell and the
// canvas are type-checked separately: the workspace, with the vendored OpenTakeoff it
// imports, under upstream's compiler options (tsconfig.ot.json); the shell under its own
// (tsconfig.json). This declaration is the contract between the two. vite.config.ts
// resolves "@brink/takeoff-workspace" to web/src/ot/load.ts.
declare module "@brink/takeoff-workspace" {
  import type { ComponentType } from "react";
  type RowChange = import("../../src/shared/protocol.js").RowChange;

  export interface TakeoffWorkspaceProps {
    projectId: string;
    importId: string | null;
    projectName: string;
    /** Relayed rows of the project's tables (the project store's socket): takeoff edits and plan sheets are used. */
    subscribeChanges: (cb: (c: RowChange) => void) => () => void;
  }

  export function loadTakeoffWorkspace(): Promise<{ default: ComponentType<TakeoffWorkspaceProps> }>;
}
