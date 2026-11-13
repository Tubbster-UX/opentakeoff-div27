// Task 5: an EasySchematic SchematicFile from the mapped takeoff.
//   - one custom template per mapped device / TR condition
//   - one device node per counted unit (x N multiplier expanded as copies)
//   - one patch-panel node per TR marker, one port per cable homed there
//   - one connection per cable of each linked run, device -> TR patch panel,
//     with cableLength = OpenTakeoff's measured per-cable LF (ES's own
//     "<n.n> ft" format) and the OT cable_type as the line label
//   - room nodes from the shapes' labels; a simple grid layout (no plan
//     coordinates: real placement is Stage 1b)
//   - node and edge ids derived from OpenTakeoff's shape and run ids (ids.ts),
//     so the schematic edit layer (edits.ts) finds the same element after a re-import
// Devices that cannot be drawn (unmapped, invalid) are listed in a note node
// and in the issues; devices with no linked run are placed with no cable.
import type { CableRun } from "./cable.js";
import type { CatalogRow, ResolvedMapping } from "./catalog.js";
import type { Issues } from "./issues.js";
import type { OtCondition, OtTakeoff } from "./ot/types.js";
import type { ConditionRollup } from "./rollup.js";
import { cableEdgeId, deviceNodeId, NOTE_NODE_ID, roomNodeId, trNodeId } from "./ids.js";
import { CURRENT_SCHEMA_VERSION, ES_SOURCE_COMMIT } from "./vendor/esEnums.generated.js";
import type { ConnectionEdge, DeviceNode, DeviceTemplate, NoteNode, Port, RoomNode, SchematicFile, SignalType, ConnectorType } from "./vendor/esTypes.js";

/** ES device types whose ports are rear/front passthrough circuits (field cable lands on the rear). */
const PASSTHROUGH_TYPES = new Set(["wall-plate", "patch-panel"]);

const CELL_W = 260;
const CELL_H = 200;
const ROOM_PAD = 40;
const ROOM_HEADER = 60;
const ROOM_COLS = 4;
const ROOMS_PER_ROW = 3;
const ROOM_GAP = 120;

export interface SchematicBuild {
  file: SchematicFile;
  /** Device nodes per condition key (drawn devices, copies included). */
  deviceCounts: Record<string, number>;
  /** Device markers that could not be drawn, by condition key. */
  notDrawn: Record<string, number>;
}

export const templateIdFor = (conditionKey: string): string => `brink-${conditionKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
export const formatEsLength = (ft: number): string => `${ft.toFixed(1)} ft`;

function makePorts(row: CatalogRow, n: number, prefix: string): Port[] {
  const spec = row.port ?? { signalType: "ethernet", connectorType: "rj45" };
  const passthrough = PASSTHROUGH_TYPES.has(row.esDeviceType ?? "");
  return Array.from({ length: Math.max(1, n) }, (_, i) => {
    const p: Port = {
      id: `p${i + 1}`,
      label: `${prefix}${i + 1}`,
      signalType: spec.signalType as SignalType,
      direction: passthrough ? "passthrough" : "bidirectional",
    };
    if (passthrough) {
      p.rearConnectorType = (spec.rearConnectorType ?? "punch-down-110") as ConnectorType;
      p.frontConnectorType = spec.connectorType as ConnectorType;
    } else {
      p.connectorType = spec.connectorType as ConnectorType;
    }
    p.templatePortId = `p${i + 1}`;
    return p;
  });
}

/** The handle a field cable lands on: the rear of a passthrough circuit, else the port's in/out face. */
function fieldHandle(row: CatalogRow, portId: string, end: "source" | "target"): string {
  if (PASSTHROUGH_TYPES.has(row.esDeviceType ?? "")) return `${portId}-rear`;
  return `${portId}-${end === "source" ? "out" : "in"}`;
}

function templateFor(row: CatalogRow, cables: number): DeviceTemplate {
  const ref = row.esTemplateRef;
  const t: DeviceTemplate = {
    id: templateIdFor(row.conditionKey),
    version: 1,
    deviceType: row.esDeviceType!,
    label: row.label ?? row.conditionKey,
    searchTerms: ["brink", row.conditionKey.toLowerCase()],
    ports: makePorts(row, cables, row.kind === "tr" ? "Port " : "Cable "),
  };
  if (ref && "manufacturer" in ref) {
    if (ref.manufacturer) t.manufacturer = ref.manufacturer;
    if (ref.modelNumber) t.modelNumber = ref.modelNumber;
  }
  return t;
}

interface PlacedDevice {
  node: DeviceNode;
  row: CatalogRow;
  roomKey: string;
}

export function buildSchematic(opts: {
  project: string;
  takeoff: OtTakeoff;
  rollups: ConditionRollup[];
  runs: CableRun[];
  mapping: ResolvedMapping;
  issues: Issues;
  date?: string;
}): SchematicBuild {
  const { takeoff, rollups, runs, mapping } = opts;
  const conditions = new Map<string, OtCondition>(takeoff.conditions.map((c) => [c.id, c]));
  const rollupById = new Map(rollups.map((r) => [r.conditionId, r]));
  const linkedByDevice = new Map<string, CableRun>();
  for (const r of runs) if (r.status === "linked") for (const id of r.deviceShapeIds) linkedByDevice.set(id, r);

  const templates = new Map<string, DeviceTemplate>();
  const deviceCounts: Record<string, number> = {};
  const notDrawn: Record<string, number> = {};
  const placed: PlacedDevice[] = [];
  const nodeByShapeCopy = new Map<string, DeviceNode>();

  // Devices: one node per counted unit and copy.
  for (const shape of takeoff.shapes) {
    if (shape.measure_role !== "count") continue;
    const roll = rollupById.get(shape.condition_id);
    if (!roll || roll.kind !== "device") continue;
    const row = mapping.byCondition.get(shape.condition_id);
    const units = (shape.computed?.count ?? 0) * roll.multiplier;
    if (!row) {
      notDrawn[roll.finishTag] = (notDrawn[roll.finishTag] ?? 0) + units;
      continue;
    }
    const cond = conditions.get(shape.condition_id)!;
    const run = linkedByDevice.get(shape.id);
    const cables = run?.cables || cond.cable_setup?.cables_per_location || 1;
    if (!templates.has(row.conditionKey)) templates.set(row.conditionKey, templateFor(row, cond.cable_setup?.cables_per_location || 1));
    const tpl = templates.get(row.conditionKey)!;
    const copies = Math.round(roll.multiplier);
    for (let copy = 1; copy <= copies; copy++) {
      const n = (deviceCounts[row.conditionKey] = (deviceCounts[row.conditionKey] ?? 0) + 1);
      const node: DeviceNode = {
        id: deviceNodeId(shape.id, copy),
        type: "device",
        position: { x: 0, y: 0 },
        data: {
          label: `${row.conditionKey}-${n}`,
          deviceType: row.esDeviceType!,
          ports: makePorts(row, cables, "Cable "),
          model: tpl.label,
          templateId: tpl.id,
          templateVersion: 1,
          ...(tpl.manufacturer ? { manufacturer: tpl.manufacturer } : {}),
          ...(tpl.modelNumber ? { modelNumber: tpl.modelNumber } : {}),
          brink: { source: "opentakeoff", conditionKey: row.conditionKey, shapeId: shape.id, copy, ...(run ? { runId: run.runId } : { cable: "no linked run" }) },
        },
      };
      const room = (shape.label || "(unlabeled)") + (copies > 1 ? ` (copy ${copy} of ${copies})` : "");
      placed.push({ node, row, roomKey: room });
      nodeByShapeCopy.set(`${shape.id}#${copy}`, node);
    }
    if (Math.round(roll.multiplier) !== roll.multiplier) {
      opts.issues.error("schematic_invalid", `${roll.finishTag}: multiplier ${roll.multiplier} is not a whole number; the schematic draws ${Math.round(roll.multiplier)} copies`, { conditionKey: roll.finishTag });
    }
  }

  // Cables homed to each TR shape, to size its patch panel.
  const cablesAtTr = new Map<string, number>();
  for (const r of runs) {
    if (r.status !== "linked") continue;
    const roll = rollupById.get(r.conditionId);
    if (!roll || !mapping.byCondition.has(r.conditionId)) continue;
    cablesAtTr.set(r.trId, (cablesAtTr.get(r.trId) ?? 0) + r.cables * Math.round(roll.multiplier));
  }

  // TR patch panels: one per TR marker.
  const panelByTr = new Map<string, { node: DeviceNode; row: CatalogRow; next: number }>();
  for (const shape of takeoff.shapes) {
    if (shape.measure_role !== "count") continue;
    const roll = rollupById.get(shape.condition_id);
    if (!roll || roll.kind !== "tr") continue;
    const row = mapping.byCondition.get(shape.condition_id);
    if (!row) {
      notDrawn[roll.finishTag] = (notDrawn[roll.finishTag] ?? 0) + (shape.computed?.count ?? 0);
      continue;
    }
    const ports = cablesAtTr.get(shape.id) ?? 0;
    if (!templates.has(row.conditionKey)) templates.set(row.conditionKey, templateFor(row, 24));
    const tpl = templates.get(row.conditionKey)!;
    const trName = shape.label || shape.id;
    const node: DeviceNode = {
      id: trNodeId(shape.id),
      type: "device",
      position: { x: 0, y: 0 },
      data: {
        label: `${trName} ${tpl.label}`,
        deviceType: row.esDeviceType!,
        ports: makePorts(row, ports, "Port "),
        model: tpl.label,
        templateId: tpl.id,
        templateVersion: 1,
        ...(tpl.manufacturer ? { manufacturer: tpl.manufacturer } : {}),
        ...(tpl.modelNumber ? { modelNumber: tpl.modelNumber } : {}),
        brink: { source: "opentakeoff", conditionKey: row.conditionKey, shapeId: shape.id, tr: trName, cablesHomed: ports },
      },
    };
    deviceCounts[row.conditionKey] = (deviceCounts[row.conditionKey] ?? 0) + 1;
    panelByTr.set(shape.id, { node, row, next: 1 });
    placed.push({ node, row, roomKey: trName });
  }

  // Connections: one per cable of each linked run (and copy).
  const edges: ConnectionEdge[] = [];
  for (const r of runs) {
    if (r.status !== "linked" || r.perCableLf == null) continue;
    const roll = rollupById.get(r.conditionId);
    const row = mapping.byCondition.get(r.conditionId);
    const panel = panelByTr.get(r.trId);
    if (!roll || !row || !panel) continue;
    const deviceShape = r.deviceShapeIds[0];
    for (let copy = 1; copy <= Math.round(roll.multiplier); copy++) {
      const dev = nodeByShapeCopy.get(`${deviceShape}#${copy}`);
      if (!dev) continue;
      for (let k = 1; k <= r.cables; k++) {
        const panelPort = `p${panel.next++}`;
        edges.push({
          id: cableEdgeId(r.runId, copy, k),
          source: dev.id,
          sourceHandle: fieldHandle(row, `p${k}`, "source"),
          target: panel.node.id,
          targetHandle: fieldHandle(panel.row, panelPort, "target"),
          data: {
            signalType: (row.port?.signalType ?? "ethernet") as SignalType,
            cableLength: formatEsLength(r.perCableLf),
            label: r.cableType,
            brink: { source: "opentakeoff", length: "measured", runId: r.runId, perCableLf: r.perCableLf, routeLf: r.routeLf, review: r.review },
          },
        });
      }
    }
  }

  // Rooms + grid layout.
  const roomOrder: string[] = [];
  const members = new Map<string, PlacedDevice[]>();
  for (const p of placed) {
    if (!members.has(p.roomKey)) {
      members.set(p.roomKey, []);
      roomOrder.push(p.roomKey);
    }
    members.get(p.roomKey)!.push(p);
  }
  // TR rooms first, so the head end reads first.
  roomOrder.sort((a, b) => Number(members.get(b)![0]!.row.kind === "tr") - Number(members.get(a)![0]!.row.kind === "tr"));
  const rooms: RoomNode[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  roomOrder.forEach((key, i) => {
    const list = members.get(key)!;
    const cols = Math.min(ROOM_COLS, list.length);
    const maxPorts = Math.max(...list.map((p) => p.node.data.ports.length));
    const cellH = Math.max(CELL_H, 80 + maxPorts * 22);
    const w = ROOM_PAD * 2 + cols * CELL_W;
    const h = ROOM_HEADER + ROOM_PAD + Math.ceil(list.length / ROOM_COLS) * cellH;
    if (i > 0 && i % ROOMS_PER_ROW === 0) {
      cursorX = 0;
      cursorY += rowH + ROOM_GAP;
      rowH = 0;
    }
    const id = roomNodeId(key);
    rooms.push({ id, type: "room", position: { x: cursorX, y: cursorY }, data: { label: key }, style: { width: w, height: h }, width: w, height: h, zIndex: -1 });
    list.forEach((p, j) => {
      p.node.parentId = id;
      p.node.position = { x: ROOM_PAD + (j % ROOM_COLS) * CELL_W, y: ROOM_HEADER + Math.floor(j / ROOM_COLS) * cellH };
    });
    cursorX += w + ROOM_GAP;
    rowH = Math.max(rowH, h);
  });

  const nodes: SchematicFile["nodes"] = [...rooms, ...placed.map((p) => p.node)];
  const note = noteNode(opts, notDrawn, cursorY + rowH + ROOM_GAP);
  nodes.push(note);

  const file: SchematicFile = {
    version: CURRENT_SCHEMA_VERSION,
    name: opts.project,
    nodes,
    edges,
    customTemplates: [...templates.values()],
    titleBlock: {
      showName: opts.project,
      venue: "",
      designer: "",
      engineer: "",
      date: opts.date ?? new Date().toISOString().slice(0, 10),
      drawingTitle: "Division 27: devices and cable from OpenTakeoff",
      company: "Brink Design",
      revision: "",
      logo: "",
      customFields: [],
    },
  };
  return { file, deviceCounts, notDrawn };
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function noteNode(opts: { issues: Issues; takeoff: OtTakeoff }, notDrawn: Record<string, number>, y: number): NoteNode {
  const errors = opts.issues.list.filter((i) => i.severity === "error");
  const warnings = opts.issues.list.filter((i) => i.severity === "warning");
  const lines = [
    `<div><b>Generated by brink-merge from an OpenTakeoff export</b></div>`,
    `<div>Cable lengths are OpenTakeoff's measured per-cable LF (route + vertical + loops), net of waste. Order LF and boxes are on the BOM.</div>`,
    `<div>EasySchematic schema v${CURRENT_SCHEMA_VERSION} (types vendored from ${ES_SOURCE_COMMIT.slice(0, 7)}). Layout is a grid by room label, not plan position.</div>`,
    `<div><br></div><div><b>${errors.length} error(s), ${warnings.length} warning(s)</b></div>`,
    ...Object.entries(notDrawn).map(([k, n]) => `<div>Not drawn: ${n} x ${esc(k)} (unmapped or invalid mapping)</div>`),
    ...errors.slice(0, 12).map((i) => `<div>ERROR ${esc(i.code)}: ${esc(i.message)}</div>`),
    ...warnings.slice(0, 12).map((i) => `<div>warning ${esc(i.code)}: ${esc(i.message)}</div>`),
    ...(errors.length + warnings.length > 24 ? [`<div>... the full list is in bom.json / bom.csv</div>`] : []),
  ];
  return { id: NOTE_NODE_ID, type: "note", position: { x: 0, y }, data: { html: lines.join("") }, style: { width: 640, height: 420 }, width: 640, height: 420 };
}
