// Which browser gets which change. The relay keeps, per browser socket, what it
// opened: one project (and the import it is showing), or the project list. It
// never needs the database to route.
import { changeScope, type RowChange } from "./protocol.js";

export type ClientState =
  /** A project page: row changes for that project's current import. */
  | { kind?: "project"; projectId: string; /** The import the page is showing (null until it has read its snapshot, or when the project has none). */ importId: string | null }
  /** The project list: told which tables changed (coalesced), never sent rows. */
  | { kind: "list" };

export type ProjectClient = Extract<ClientState, { projectId: string }>;

export function isListClient(c: ClientState): c is { kind: "list" } {
  return c.kind === "list";
}

/**
 * Decide whether a project `client` receives `change`, and the client's state afterwards.
 * When a project's current_import_id moves, the relay re-points its sockets at
 * the new import at once, so rows edited after the switch reach the page while
 * it is still re-reading its snapshot.
 */
export function route(change: RowChange, client: ProjectClient): { send: boolean; next: ProjectClient } {
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
  // Portal pushes feed the project list only (touch); the project page does not show them in Phase 1.
  if (change.table === "brink_portal_pushes") return { send: false, next: client };
  return { send: scope.importId !== undefined && scope.importId === client.importId, next: client };
}
