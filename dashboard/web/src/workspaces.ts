// The tabs of a project, in display order. Each is a child route of
// /projects/:id: Takeoff (the OpenTakeoff canvas), Schematic (the EasySchematic
// editor), BOM & issues. A tab still being built carries a `phase` label.
import type { ComponentType } from "react";
import type { IconName } from "./design/index.js";
import { BomIssuesTab } from "./pages/tabs/BomIssuesTab.js";
import { SchematicTab } from "./pages/tabs/SchematicTab.js";
import { TakeoffTab } from "./pages/tabs/TakeoffTab.js";

export interface ProjectTab {
  /** Route segment under /projects/:id. */
  path: string;
  label: string;
  icon: IconName;
  /** Shown beside the label while the tab is a placeholder. */
  phase?: string;
  Component: ComponentType;
}

export const PROJECT_TABS: ProjectTab[] = [
  { path: "takeoff", label: "Takeoff", icon: "plan", Component: TakeoffTab },
  { path: "schematic", label: "Schematic", icon: "schematic", Component: SchematicTab },
  { path: "bom", label: "BOM & issues", icon: "list", Component: BomIssuesTab },
];

/** Where /projects/:id lands. */
export const DEFAULT_TAB = "bom";
