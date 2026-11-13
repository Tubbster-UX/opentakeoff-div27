// BOM & Issues: the live view of the project's current import (ported from
// the first dashboard page). Rows changed live flash; a re-import switches the
// page to the new import without a reload.
import type { ReactNode } from "react";
import { rowKey, type Row, type TableName } from "../../../../src/shared/protocol.js";
import { summarize } from "../../../../src/shared/state.js";
import { DataTable, Page, Panel, Stat, Stats, Tag } from "../../components/ui.js";
import { importLine } from "../ProjectLayout.js";
import { fmt, short, str, when } from "../../lib/format.js";
import { useProject } from "../../lib/projectContext.js";

export function BomIssuesTab() {
  const { snap, feed, flash } = useProject();
  if (!snap) return null;
  const sum = summarize(snap);

  const nodeLabel = new Map(snap.nodes.map((n) => [n.node_id, str(n.label ?? n.node_id)]));
  const roomOf = (n: Row): string => (n.parent_id ? nodeLabel.get(n.parent_id) ?? str(n.parent_id) : "");
  const bom = snap.bom.filter((l) => l.kind !== "issue");
  const devices = snap.nodes.filter((n) => n.node_type === "device");
  const rooms = snap.nodes.filter((n) => n.node_type === "room");
  const devRoom = new Map(devices.map((d) => [d.node_id, d.parent_id]));
  const lfByRoom = new Map<string, number>();
  for (const c of snap.connections) {
    const room = devRoom.get(c.source_node);
    if (room) lfByRoom.set(str(room), (lfByRoom.get(str(room)) ?? 0) + (Number(c.cable_length_ft) || 0));
  }

  /** One live row: data-k names it for checks, the flash sequence in its key restarts the highlight on a repeat change. */
  const row = (table: TableName, r: Row, cells: ReactNode) => {
    const k = `${table}:${rowKey(table, r)}`;
    const f = flash[k];
    return (
      <tr key={`${k}#${f ?? 0}`} data-k={k} className={f ? "flash" : undefined}>
        {cells}
      </tr>
    );
  };

  return (
    <Page title="BOM & issues" meta={importLine(snap.import)}>
      <Stats>
        <Stat k="BOM lines" v={fmt(sum.bomLines)} />
        <Stat k="Devices" v={fmt(sum.bom.devices)} />
        <Stat k="Cables" v={fmt(sum.bom.cables)} />
        <Stat k="Cable net LF" v={fmt(sum.bom.netLf)} />
        <Stat k="Cable order LF" v={fmt(sum.bom.orderLf)} />
        <Stat k="Rooms" v={fmt(sum.rooms)} />
        <Stat k="Connections" v={fmt(sum.connections)} />
        <Stat k="Errors" v={fmt(sum.errors)} tone={sum.errors ? "error" : undefined} />
        <Stat k="Warnings" v={fmt(sum.warnings)} tone={sum.warnings ? "warn" : undefined} />
      </Stats>

      <Panel title="Bill of materials" count={bom.length}>
        <DataTable
          columns={[{ label: "#", numeric: true }, { label: "Kind" }, { label: "Condition" }, { label: "Description" }, { label: "Qty", numeric: true }, { label: "Unit" }, { label: "Net LF", numeric: true }, { label: "Order LF", numeric: true }, { label: "Mapping" }]}
          empty="No BOM lines."
          rows={bom.map((l) =>
            row("brink_bom_lines", l, (
              <>
                <td className="num">{str(l.line_no)}</td>
                <td className="code">{str(l.kind)}</td>
                <td className="code">{str(l.condition_key)}</td>
                <td className="desc">{str(l.description)}</td>
                <td className="num">{fmt(l.qty)}</td>
                <td>{str(l.unit)}</td>
                <td className="num">{fmt(l.net_lf)}</td>
                <td className="num">{fmt(l.order_lf)}</td>
                <td>
                  <Tag v={l.mapping_status} />
                </td>
              </>
            )),
          )}
        />
      </Panel>

      <Panel title="Issues" count={snap.issues.length}>
        <DataTable
          columns={[{ label: "#", numeric: true }, { label: "Severity" }, { label: "Code" }, { label: "Condition" }, { label: "Message" }]}
          empty="No issues."
          rows={snap.issues.map((i) =>
            row("brink_issues", i, (
              <>
                <td className="num">{str(i.seq)}</td>
                <td>
                  <Tag v={i.severity} />
                </td>
                <td className="code">{str(i.code)}</td>
                <td className="code">{str(i.condition_key)}</td>
                <td className="desc">{str(i.message)}</td>
              </>
            )),
          )}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        <Panel title="Rooms" count={rooms.length}>
          <DataTable
            columns={[{ label: "Room" }, { label: "Devices", numeric: true }, { label: "Cable LF", numeric: true }]}
            empty="No rooms."
            rows={rooms.map((r) =>
              row("brink_schematic_nodes", r, (
                <>
                  <td>{str(r.label ?? r.node_id)}</td>
                  <td className="num">{fmt(devices.filter((d) => d.parent_id === r.node_id).length)}</td>
                  <td className="num">{fmt(lfByRoom.get(str(r.node_id)) ?? 0)}</td>
                </>
              )),
            )}
          />
        </Panel>
        <Panel title="Devices" count={devices.length}>
          <DataTable
            columns={[{ label: "Label" }, { label: "Type" }, { label: "Condition" }, { label: "Room" }]}
            empty="No devices."
            rows={devices.map((d) =>
              row("brink_schematic_nodes", d, (
                <>
                  <td>{str(d.label ?? d.node_id)}</td>
                  <td className="code">{str(d.device_type)}</td>
                  <td className="code">{str(d.condition_key)}</td>
                  <td>{roomOf(d)}</td>
                </>
              )),
            )}
          />
        </Panel>
      </div>

      <Panel title="Connections" count={snap.connections.length}>
        <DataTable
          columns={[{ label: "#", numeric: true }, { label: "From" }, { label: "To" }, { label: "Signal" }, { label: "Cable" }, { label: "Length ft", numeric: true }, { label: "Run" }]}
          empty="No connections."
          rows={snap.connections.map((c) =>
            row("brink_schematic_connections", c, (
              <>
                <td className="num">{str(c.seq)}</td>
                <td>{nodeLabel.get(c.source_node) ?? str(c.source_node)}</td>
                <td>{nodeLabel.get(c.target_node) ?? str(c.target_node)}</td>
                <td className="code">{str(c.signal_type)}</td>
                <td>{str(c.cable_type)}</td>
                <td className="num">{fmt(c.cable_length_ft)}</td>
                <td className="code">{short(str(c.run_id).replace(/^run-/, ""))}</td>
              </>
            )),
          )}
        />
      </Panel>

      <Panel title="Live changes" count={`read ${when(snap.readAt)}`}>
        <ul id="feed" className="m-0 list-none px-4 py-2 font-num text-xs text-ink-3">
          {feed.length ? (
            feed.map((f) => (
              <li key={f.id} className="py-0.5 [overflow-wrap:anywhere]">
                <b className="font-bold text-ink">{f.at}</b> {f.text}
              </li>
            ))
          ) : (
            <li>Waiting for changes…</li>
          )}
        </ul>
      </Panel>
    </Page>
  );
}
