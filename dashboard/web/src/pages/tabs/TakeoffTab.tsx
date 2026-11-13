// Takeoff: the OpenTakeoff plan canvas, mounted directly in the app (no frame).
//
// The workspace (web/src/ot/workspace.tsx, loaded on first use) runs upstream
// OpenTakeoff's canvas with its storage seam pointed at the Brink server (plan PDFs in
// Supabase Storage, the takeoff as brink-merge's import + the takeoff edit layer), and the
// Brink toolbar, sheets panel, right panel and status bar around it. This tab hands it:
//   - the project, its current import and name;
//   - the relayed rows of the project's tables (other people's takeoff edits and plan
//     uploads appear live; a re-import reloads the canvas).
import { lazy, Suspense, useCallback, useContext } from "react";
import { loadTakeoffWorkspace } from "@brink/takeoff-workspace";
import type { RowChange } from "../../../../src/shared/protocol.js";
import { Loading, Notice } from "../../components/ui.js";
import { str } from "../../lib/format.js";
import { ProjectStoreContext, useProject } from "../../lib/projectContext.js";

const Workspace = lazy(loadTakeoffWorkspace);

export function TakeoffTab() {
  const { snap } = useProject();
  const store = useContext(ProjectStoreContext);
  const subscribeChanges = useCallback((cb: (c: RowChange) => void) => (store ? store.onChange(cb) : () => undefined), [store]);
  if (!snap) return null;
  const projectId = str(snap.project.id);
  const importId = (snap.import?.id as string | undefined) ?? null;
  if (!importId) return <Notice>This project has no import yet: import a takeoff with brink-merge first.</Notice>;
  return (
    <Suspense fallback={<Loading>Loading the takeoff canvas…</Loading>}>
      <Workspace key={projectId} projectId={projectId} importId={importId} projectName={str(snap.project.name)} subscribeChanges={subscribeChanges} />
    </Suspense>
  );
}
