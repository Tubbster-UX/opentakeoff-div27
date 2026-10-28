// Schematic: the EasySchematic editor, mounted directly in the app (no frame).
//
// The workspace (web/src/es/workspace.tsx, loaded on first use) runs upstream
// EasySchematic's App with the Brink toolbar and panels in its layout slots, and
// saves to the project's edit layer exactly as Phase 2 did. This tab hands it:
//   - the project, its current import and name;
//   - the relayed brink_schematic_edits rows (so other people's saved edits appear live);
//   - the read-only outline of the generated rows, shown in its Rows panel.
import { lazy, Suspense, useCallback, useContext } from "react";
import { loadSchematicWorkspace } from "@brink/schematic-workspace";
import type { Row, RowChange } from "../../../../src/shared/protocol.js";
import { Loading, Notice } from "../../components/ui.js";
import { fmt, str } from "../../lib/format.js";
import { ProjectStoreContext, useProject } from "../../lib/projectContext.js";

const Workspace = lazy(loadSchematicWorkspace);

export function SchematicTab() {
  const { snap } = useProject();
  const store = useContext(ProjectStoreContext);
  const subscribeEdits = useCallback((cb: (c: RowChange) => void) => (store ? store.onChange(cb) : () => undefined), [store]);
  if (!snap) return null;
  const projectId = str(snap.project.id);
  const importId = (snap.import?.id as string | undefined) ?? null;
  if (!importId) return <Notice>This project has no import yet: import a takeoff with brink-merge first.</Notice>;
  return (
    <Suspense fallback={<Loading>Loading the schematic editor…</Loading>}>
      <Workspace key={projectId} projectId={projectId} importId={importId} projectName={str(snap.project.name)} subscribeEdits={subscribeEdits} outline={OUTLINE} />
    </Suspense>
  );
}

/** The Phase 1 read-only outline of the generated rows (the import as brink-merge wrote it, before edits). */
function Outline() {
  const { snap } = useProject();
  if (!snap) return null;
  const byId = new Map(snap.nodes.map((n) => [str(n.node_id), n]));
  const label = (id: unknown) => str(byId.get(str(id))?.label ?? id);
  const rooms = snap.nodes.filter((n) => n.node_type === "room");
  const devices = snap.nodes.filter((n) => n.node_type === "device");
  const roomIds = new Set(rooms.map((r) => str(r.node_id)));
  const out = new Map<string, Row[]>();
  for (const c of snap.connections) {
    const k = str(c.source_node);
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  const unplaced = devices.filter((d) => !roomIds.has(str(d.parent_id)));
  const groups: { key: string; title: string; devices: Row[] }[] = [
    ...rooms.map((r) => ({ key: str(r.node_id), title: label(r.node_id), devices: devices.filter((d) => str(d.parent_id) === str(r.node_id)) })),
    ...(unplaced.length ? [{ key: "__none", title: "No room", devices: unplaced }] : []),
  ];

  return (
    <div id="schematic-outline" className="text-sm">
      <p className="m-0 border-b border-line px-3 py-2 text-xs text-ink-3">
        The import as brink-merge generated it, before edits (read-only, live): <span className="num">{rooms.length} rooms · {devices.length} devices · {snap.connections.length} connections</span>
      </p>
        {groups.length === 0 ? (
          <p className="m-0 p-4 text-center text-ink-3">No schematic rows for this import.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {groups.map((g) => (
              <li key={g.key} className="border-b border-line">
                <div className="flex items-baseline gap-2 px-3 pt-2 pb-1 font-semibold">
                  <span>{g.title}</span>
                  <span className="num text-xs font-normal text-ink-3">{g.devices.length} devices</span>
                </div>
                <ul className="m-0 list-none pb-2 pl-5 pr-3">
                  {g.devices.map((d) => {
                    const conns = out.get(str(d.node_id)) ?? [];
                    return (
                      <li key={str(d.node_id)} data-node={str(d.node_id)} className="py-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span>{label(d.node_id)}</span>
                          <span className="font-num text-xs text-ink-3">{str(d.device_type)}</span>
                          {d.condition_key != null && <span className="font-num text-xs text-ink-3">{str(d.condition_key)}</span>}
                        </div>
                        {conns.length > 0 ? (
                          <ul className="m-0 list-none pl-3 font-num text-xs">
                            {conns.map((c) => (
                              <li key={str(c.edge_id)} className="[overflow-wrap:anywhere] text-ink-3">
                                → <span className="text-ink">{label(c.target_node)}</span> · {str(c.cable_type) || str(c.signal_type)} · {fmt(c.cable_length_ft)} ft
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="pl-3 font-num text-xs text-warn">no cable</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

const OUTLINE = <Outline />;
