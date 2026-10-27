// The tabs of a project, in display order. Each is a child route of
// /projects/:id. Later phases replace a placeholder's element with the real
// workspace (Phase 2: the EasySchematic editor; Phase 3: the OpenTakeoff
// canvas) and drop its `phase` label; nothing else in the shell changes.
import type { ComponentType } from "react";
import { BomIssuesTab } from "./pages/tabs/BomIssuesTab.js";
import { SchematicTab } from "./pages/tabs/SchematicTab.js";
import { TakeoffTab } from "./pages/tabs/TakeoffTab.js";

export interface ProjectTab {
  /** Route segment under /projects/:id. */
  path: string;
  label: string;
  /** Shown beside the label while the tab is a placeholder. */
  phase?: string;
  Component: ComponentType;
}

export const PROJECT_TABS: ProjectTab[] = [
  { path: "takeoff", label: "Takeoff", phase: "Phase 3", Component: TakeoffTab },
  { path: "schematic", label: "Schematic", phase: "Phase 2", Component: SchematicTab },
  { path: "bom", label: "BOM & Issues", Component: BomIssuesTab },
];

/** Where /projects/:id lands: the one tab with real content in Phase 1. */
export const DEFAULT_TAB = "bom";
