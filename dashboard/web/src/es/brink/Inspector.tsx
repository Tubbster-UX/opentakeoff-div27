// The Brink inspector: what is selected on the canvas, its properties, where it
// came from in the takeoff, and the edits the edit layer keeps (the name). It reads
// EasySchematic's store and calls its existing actions (updateDeviceLabel,
// updateRoomLabel, setEditingNodeId); upstream's full device / room editors open
// from here for everything else.
import { useEffect, useState, type ReactNode } from "react";
import { useReactFlow } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useSchematicStore } from "../../../../vendor/easyschematic/src/store";
import type { ConnectionEdge, SchematicNode } from "../../../../vendor/easyschematic/src/types";
import { Badge, Button, Field, Input, PropertyList } from "../../design/index.js";

type Brink = { source?: string; conditionKey?: string; shapeId?: string; copy?: number; runId?: string; tr?: string; cable?: string; editor?: string; review?: unknown; perCableLf?: number };
const brinkOf = (d: unknown): Brink => (((d as { brink?: Brink } | undefined)?.brink ?? {}) as Brink);
const label = (n: SchematicNode | undefined): string => String((n?.data as { label?: unknown } | undefined)?.label ?? n?.id ?? "");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-3">
      <h3 className="m-0 mb-2 text-2xs font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function NameField({ node }: { node: SchematicNode }) {
  const current = label(node);
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current, node.id]);
  const commit = () => {
    const v = value.trim();
    if (!v || v === current) return setValue(current);
    const s = useSchematicStore.getState();
    if (node.type === "room") s.updateRoomLabel(node.id, v);
    else s.updateDeviceLabel(node.id, v);
  };
  return (
    <Field label="Name" hint="Saved to the project's edit layer.">
      {(p) => (
        <Input
          {...p}
          value={value}
          data-inspector-name
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setValue(current);
          }}
        />
      )}
    </Field>
  );
}

function NodeInspector({ node, nodes, edges }: { node: SchematicNode; nodes: SchematicNode[]; edges: ConnectionEdge[] }) {
  const rf = useReactFlow();
  const d = (node.data ?? {}) as Record<string, unknown>;
  const b = brinkOf(d);
  const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
  const conns = edges.filter((e) => e.source === node.id || e.target === node.id).length;
  const ports = Array.isArray(d.ports) ? d.ports.length : null;
  const editable = node.type === "device" || node.type === "room";
  const kind = node.type === "device" ? "Device" : node.type === "room" ? "Room" : node.type === "note" ? "Note" : node.type === "annotation" ? "Shape" : String(node.type ?? "Element");
  const rows: [string, ReactNode][] = [];
  if (node.type === "device") {
    rows.push(["Type", String(d.deviceType ?? "")]);
    if (d.model) rows.push(["Model", String(d.model)]);
    if (d.manufacturer) rows.push(["Maker", String(d.manufacturer)]);
    rows.push(["Room", parent ? label(parent) : <span className="text-ink-3">none</span>]);
    if (ports != null) rows.push(["Ports", <span className="num">{ports}</span>]);
    rows.push(["Cables", <span className="num">{conns}</span>]);
  } else if (node.type === "room") {
    rows.push(["Devices", <span className="num">{nodes.filter((n) => n.parentId === node.id).length}</span>]);
  }
  const takeoff: [string, ReactNode][] = [];
  if (b.source === "opentakeoff") {
    if (b.conditionKey) takeoff.push(["Condition", <span className="font-num text-xs">{b.conditionKey}</span>]);
    if (b.shapeId) takeoff.push(["Shape", <span className="font-num text-xs">{b.shapeId}</span>]);
    if (b.copy != null) takeoff.push(["Copy", <span className="num">{b.copy}</span>]);
    if (b.runId) takeoff.push(["Cable run", <span className="font-num text-xs">{b.runId}</span>]);
    if (b.tr) takeoff.push(["Telecom room", b.tr]);
    if (b.cable) takeoff.push(["Cable", <span className="text-warn">{b.cable}</span>]);
  }
  return (
    <div data-inspector={node.id}>
      <Section title="Selection">
        <div className="mb-3 flex items-center gap-2">
          <Badge tone="accent">{kind}</Badge>
          <span className="min-w-0 truncate font-medium">{label(node)}</span>
        </div>
        {editable && <NameField node={node} />}
      </Section>
      {rows.length > 0 && (
        <Section title="Properties">
          <PropertyList rows={rows} />
        </Section>
      )}
      <Section title="From the takeoff">
        {takeoff.length ? <PropertyList rows={takeoff} /> : <p className="m-0 text-xs text-ink-3">Not from the takeoff: added in the editor.</p>}
      </Section>
      <div className="flex flex-wrap gap-2 px-3 py-3">
        {editable && (
          <Button size="sm" icon="settings" onClick={() => useSchematicStore.getState().setEditingNodeId(node.id)} data-action="open-editor">
            {node.type === "room" ? "Room settings…" : "Ports and details…"}
          </Button>
        )}
        <Button size="sm" variant="quiet" icon="eye" onClick={() => void rf.fitView({ nodes: [{ id: node.id }], duration: 250, padding: 0.6, maxZoom: 1.5 })}>
          Zoom to
        </Button>
      </div>
    </div>
  );
}

function EdgeInspector({ edge, nodes }: { edge: ConnectionEdge; nodes: SchematicNode[] }) {
  const d = (edge.data ?? {}) as Record<string, unknown>;
  const b = brinkOf(d);
  const byId = (id: string) => nodes.find((n) => n.id === id);
  return (
    <div data-inspector={edge.id}>
      <Section title="Selection">
        <div className="flex items-center gap-2">
          <Badge tone="accent">Cable</Badge>
          <span className="min-w-0 truncate font-medium">{String(d.label ?? d.signalType ?? edge.id)}</span>
        </div>
      </Section>
      <Section title="Properties">
        <PropertyList
          rows={[
            ["From", label(byId(edge.source))],
            ["To", label(byId(edge.target))],
            ["Signal", String(d.signalType ?? "")],
            ["Length", <span className="num">{String(d.cableLength ?? "")}</span>],
          ]}
        />
      </Section>
      <Section title="From the takeoff">
        {b.source === "opentakeoff" ? (
          <PropertyList rows={[["Cable run", <span className="font-num text-xs">{b.runId ?? ""}</span>], ...(b.perCableLf != null ? ([["Per cable", <span className="num">{b.perCableLf} LF</span>]] as [string, ReactNode][]) : [])]} />
        ) : (
          <p className="m-0 text-xs text-ink-3">{b.source === "edit" ? `Added in the editor${b.editor ? ` by ${b.editor}` : ""}.` : "Added in the editor (not saved yet)."}</p>
        )}
      </Section>
    </div>
  );
}

export function Inspector() {
  const { nodes, edges } = useSchematicStore(useShallow((s) => ({ nodes: s.nodes, edges: s.edges })));
  const selNodes = nodes.filter((n) => n.selected);
  const selEdges = edges.filter((e) => e.selected);
  if (selNodes.length === 1 && selEdges.length === 0) return <NodeInspector node={selNodes[0]!} nodes={nodes} edges={edges} />;
  if (selEdges.length === 1 && selNodes.length === 0) return <EdgeInspector edge={selEdges[0]!} nodes={nodes} />;
  const devices = nodes.filter((n) => n.type === "device").length;
  const rooms = nodes.filter((n) => n.type === "room").length;
  return (
    <div data-inspector="">
      <Section title={selNodes.length + selEdges.length > 1 ? "Selection" : "Nothing selected"}>
        <p className="m-0 text-sm text-ink-2">
          {selNodes.length + selEdges.length > 1
            ? `${selNodes.length} element${selNodes.length === 1 ? "" : "s"} and ${selEdges.length} cable${selEdges.length === 1 ? "" : "s"} selected. Use Align in the toolbar to line them up.`
            : "Select a device, room or cable on the canvas to see its properties."}
        </p>
      </Section>
      <Section title="Schematic">
        <PropertyList
          rows={[
            ["Rooms", <span className="num">{rooms}</span>],
            ["Devices", <span className="num">{devices}</span>],
            ["Cables", <span className="num">{edges.length}</span>],
          ]}
        />
      </Section>
    </div>
  );
}
