import { createContext, useContext, useSyncExternalStore } from "react";
import type { ProjectState, ProjectStore } from "./projectStore.js";

export const ProjectStoreContext = createContext<ProjectStore | null>(null);

/** The current project's live state. Only inside /projects/:id (ProjectLayout provides the store). */
export function useProject(): ProjectState {
  const store = useContext(ProjectStoreContext);
  if (!store) throw new Error("useProject outside a project route");
  return useSyncExternalStore(store.subscribe, store.getState);
}
