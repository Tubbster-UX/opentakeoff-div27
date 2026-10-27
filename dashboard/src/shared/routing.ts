// Which browser gets which change. The relay keeps, per browser socket, the
// project it opened and the import it is showing; it never needs the database
// to route.
import { changeScope, type RowChange } from "./protocol.js";

export interface ClientState {
  projectId: string;
  /** The import the page is showing (null until it has read its snapshot, or when the project has none). */
  importId: string | null;
}

/**
 * Decide whether `client` receives `change`, and the client's state afterwards.
 * When a project's current_import_id moves, the relay re-points its sockets at
 * the new import at once, so rows edited after the switch reach the page while
 * it is still re-reading its snapshot.
 */
export function route(change: RowChange, client: ClientState): { send: boolean; next: ClientState } {
  const scope = changeScope(change);
  if (change.table === "brink_projects") {
    if (scope.projectId !== client.projectId) return { send: false, next: client };
    const cur = change.record?.current_import_id;
    if (change.type !== "DELETE" && cur !== undefined && (cur ?? null) !== client.importId) {
      return { send: true, next: { ...client, importId: (cur as string | null) ?? null } };
    }
    return { send: true, next: client };
  }
  if (change.table === "brink_imports") {
    const mine = scope.projectId !== undefined ? scope.projectId === client.projectId : scope.importId === client.importId;
    return { send: mine, next: client };
  }
  return { send: scope.importId !== undefined && scope.importId === client.importId, next: client };
}
