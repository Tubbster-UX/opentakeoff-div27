// Replaces OpenTakeoff's components/WorkspaceLayout.jsx (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream has two layouts: "classic" (its top bar, tool rail and docked panels) and an
// opt-in "premium workspace" (another header, sheet navigator and dock arrangement),
// chosen by a stored preference or ?workspace=calm. In the Brink app the layout is the
// Brink one (web/src/ot/workspace.tsx): the Brink toolbar, sheets panel, right panel and
// status bar drive the canvas, and upstream's classic chrome is hidden by the theme
// (design/ot-theme.css). So the preference is pinned to classic here, never stored;
// everything else is upstream's, re-exported unchanged.
import { DockHandle, DockTargets, WorkspaceLayoutDialog, useWorkspaceLayout as upstreamUseWorkspaceLayout } from "../../../../vendor/opentakeoff/src/components/WorkspaceLayout.jsx";

export { DockHandle, DockTargets, WorkspaceLayoutDialog };

export function useWorkspaceLayout() {
  const prefs = upstreamUseWorkspaceLayout();
  return { ...prefs, enabled: false, setEnabled: () => undefined };
}
