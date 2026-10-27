// Vendored subset of EasySchematic's file types (src/types.ts), copied by hand
// from github.com/duremovich/EasySchematic (AGPL-3.0) at the commit recorded in
// esEnums.generated.ts (ES_SOURCE_COMMIT). Only the fields brink-merge writes
// are kept; every interface stays open ([key: string]: unknown) like upstream,
// so a field ES adds later does not break this seam. Enum key lists and the
// schema version are generated (scripts/vendor-es.mjs), never typed by hand.
import type { CONNECTOR_TYPES, DEVICE_TYPES, SIGNAL_TYPES } from "./esEnums.generated.js";

export type DeviceType = (typeof DEVICE_TYPES)[number];
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export type PortDirection = "input" | "output" | "bidirectional" | "passthrough";

export interface Port {
  [key: string]: unknown;
  id: string;
  label: string;
  signalType: SignalType;
  direction: PortDirection;
  section?: string;
  connectorType?: ConnectorType;
  /** Passthrough ports: rear face (field termination) and front face (patch side). */
  rearConnectorType?: ConnectorType;
  frontConnectorType?: ConnectorType;
  /** Set on instance ports placed from a template. */
  templatePortId?: string;
}

export interface DeviceTemplate {
  [key: string]: unknown;
  id?: string;
  version?: number;
  deviceType: string;
  category?: string;
  label: string;
  shortName?: string;
  ports: Port[];
  color?: string;
  headerColor?: string;
  searchTerms?: string[];
  manufacturer?: string;
  modelNumber?: string;
  referenceUrl?: string;
  powerDrawW?: number;
  poeDrawW?: number;
  unitCost?: number;
}

export interface DeviceData {
  [key: string]: unknown;
  label: string;
  deviceType: string;
  ports: Port[];
  /** Permanent template identity, used for pack-list grouping. */
  model?: string;
  templateId?: string;
  templateVersion?: number;
  manufacturer?: string;
  modelNumber?: string;
  category?: string;
  unitCost?: number;
}

export interface RoomData {
  [key: string]: unknown;
  label: string;
  color?: string;
  borderStyle?: "dashed" | "solid" | "dotted";
}

export interface NoteData {
  [key: string]: unknown;
  /** HTML content. */
  html: string;
  color?: string;
}

export interface XY { x: number; y: number }

interface NodeBase<T, K extends string> {
  [key: string]: unknown;
  id: string;
  type: K;
  position: XY;
  data: T;
  /** Room membership: position is then relative to the parent room. */
  parentId?: string;
  style?: { width?: number; height?: number };
  zIndex?: number;
}

export type DeviceNode = NodeBase<DeviceData, "device">;
export type RoomNode = NodeBase<RoomData, "room">;
export type NoteNode = NodeBase<NoteData, "note">;
export type SchematicNode = DeviceNode | RoomNode | NoteNode;

export interface ConnectionData {
  [key: string]: unknown;
  signalType: SignalType;
  /** Free-text physical length shown in the cable schedule and pack list. */
  cableLength?: string;
  /** Label drawn on the connection line. */
  label?: string;
}

export interface ConnectionEdge {
  [key: string]: unknown;
  id: string;
  source: string;
  target: string;
  /** Port id, or "<portId>-rear" / "-front" on passthrough ports, "-in" / "-out" on bidirectional ones. */
  sourceHandle?: string;
  targetHandle?: string;
  data?: ConnectionData;
}

export interface TitleBlock {
  [key: string]: unknown;
  showName: string;
  venue: string;
  designer: string;
  engineer: string;
  date: string;
  drawingTitle: string;
  company: string;
  revision: string;
  logo: string;
  customFields: { label: string; value: string }[];
}

export interface SchematicFile {
  [key: string]: unknown;
  version: number;
  name: string;
  nodes: SchematicNode[];
  edges: ConnectionEdge[];
  customTemplates?: DeviceTemplate[];
  titleBlock?: TitleBlock;
}
