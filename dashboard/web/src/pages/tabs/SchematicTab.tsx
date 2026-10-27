// Schematic: Phase 2 mounts the EasySchematic editor here. Until then, a
// read-only outline of the schematic rows brink-merge stored for the current
// import: rooms -> devices -> each device's connections.
import type { Row } from "../../../../src/shared/protocol.js";
import { Panel } from "../../components/ui.js";
import { Placeholder } from "../../components/Placeholder.js";
import { fmt, str } from "../../lib/format.js";
import { useProject } from "../../lib/projectContext.js";

export function SchematicTab() {
  const { snap } = useProject();
  if (!snap) return null;

  const byId = new Map(snap.nodes.map((n) => [str(n.node_id), n]));
  const label = (id: unknown) => str(byId.get(str(id))?.label ?? id);
  const rooms = snap.nodes.filter((n) => n.node_type === "room");
  const devices = snap.nodes.filter((n) => n.node_type === "device");
  const roomIds = new Set(rooms.map((r) => str(r.node_id)));
  const others = snap.nodes.filter((n) => n.node_type !== "room" && n.node_type !== "device");
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
    <>
      <Placeholder phase="Phase 2" title="EasySchematic editor">
        <p>
          The EasySchematic editor mounts in this tab: the project&apos;s schematic opened from the brink-merge rows (one node per device, one connection per cable, each
          with its measured length), editable in place, with edits saved back to the database.
        </p>
        <p className="text-muted">Phase 1 is read-only. Below is an outline of the stored schematic for the current import; it updates live.</p>
      </Placeholder>

      <Panel title="Schematic outline" count={`${rooms.length} rooms · ${devices.length} devices · ${snap.connections.length} connections`} id="schematic-outline">
        {groups.length === 0 ? (
          <p className="m-0 p-4 text-center text-muted">No schematic rows for this import.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {groups.map((g) => (
              <li key={g.key} className="border-b border-line last:border-b-0">
                <details open className="group">
                  <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-2 font-semibold">
                    <span>{g.title}</span>
                    <span className="font-mono text-xs font-normal text-muted">{g.devices.length} devices</span>
                  </summary>
                  <ul className="m-0 list-none pb-2 pl-6 pr-3">
                    {g.devices.map((d) => {
                      const conns = out.get(str(d.node_id)) ?? [];
                      return (
                        <li key={str(d.node_id)} data-node={str(d.node_id)} className="py-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span>{label(d.node_id)}</span>
                            <span className="font-mono text-xs text-muted">{str(d.device_type)}</span>
                            {d.condition_key != null && <span className="font-mono text-xs text-muted">{str(d.condition_key)}</span>}
                          </div>
                          {conns.length > 0 ? (
                            <ul className="m-0 list-none pl-4 font-mono text-xs">
                              {conns.map((c) => (
                                <li key={str(c.edge_id)} className="[overflow-wrap:anywhere] text-muted">
                                  → <span className="text-ink">{label(c.target_node)}</span> · {str(c.cable_type) || str(c.signal_type)} · {fmt(c.cable_length_ft)} ft
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="pl-4 font-mono text-xs text-warn">no cable</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {others.length > 0 && (
        <p className="m-0 text-xs text-muted">
          Also in the schematic: {others.length} other node{others.length === 1 ? "" : "s"} ({[...new Set(others.map((o) => str(o.node_type)))].join(", ")}).
        </p>
      )}
    </>
  );
}
