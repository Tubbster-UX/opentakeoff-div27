// Contracts for the install phase: the install design Claude drafts from the
// takeoff (device tags, cable labels, rack layouts, port assignments, signal
// flow, mounting details), the equipment library it draws on, and what the
// install package renders. The owner reviews on the phone and approves it for
// construction; tools never approve (same rule as the bid, src/approval.ts).
//
// Store: projects/<p>/outputs/install/design.json (InstallDesign),
//        system/equipment.json (EquipmentLibrary).
// Lengths are the takeoff's measured per-cable lengths (route + vertical +
// loops, no waste): never estimated. Nothing is invented to fill a gap: a
// missing value is null / absent and becomes an InstallIssue.

import type { ProjectId } from "./types.ts";

// ── labels ──────────────────────────────────────────────────────────────────

export type CableKind = "data" | "video" | "fiber" | "speaker" | "audio" | "control" | "coax" | "power" | "other";

export interface LabelScheme {
  /** "spec": read from the job's labeling section; "default": the fallback below. */
  source: "spec" | "default";
  /** Where the spec says it, e.g. "27 05 53 3.2.B". */
  reference?: string;
  /** Plain words for the crew, e.g. "Room-panel-port, e.g. 1A-A12". */
  description: string;
  /**
   * Tokens: {type} kind letter, {seq} / {seq:2} running number per kind (zero-padded),
   * {rack} rack id, {tr} TR number, {panel} patch panel letter, {port} / {port:2} panel port,
   * {device} device tag, {room} room name. Default "{type}{seq:2}" (D01, S01, F01).
   */
  pattern: string;
  /** Letter per kind for {type}. Default D data, V video, F fiber, S speaker, A audio, C control, X coax, P power, Z other. */
  typeLetters: Record<CableKind, string>;
}

// ── field devices (one per takeoff count marker) ────────────────────────────

export interface InstallDevice {
  /** Unique per project, e.g. "WAP-102" (prefix by type, floor digit, sequence). */
  tag: string;
  /** The OpenTakeoff count shape this device is. */
  shapeId: string;
  conditionId: string;
  /** Sheet key the marker is on, and its position in verts_norm space (normalized to the sheet's visual raster). */
  sheet: string;
  at: [number, number];
  room: string | null;
  /** cable_setup.device_type when set (wall_outlet, wap, camera, access_door, ...), else the condition's tag. */
  deviceType: string;
  description: string;
  manufacturer?: string;
  model?: string;
  /** Owner-furnished: install / terminate only. */
  ofe?: boolean;
  /** e.g. "Wall, flush" / "Ceiling". */
  mounting?: string;
  /** e.g. "18 in. AFF to center". */
  mountingHeight?: string;
  /** Rack id the device home-runs to (from its cable run's TR). */
  rack: string | null;
  notes?: string;
}

// ── cables ──────────────────────────────────────────────────────────────────

export interface CableEnd {
  /** Equipment tag (patch panel, switch, amp) at the rack end, or the device tag in the field. */
  equipment: string;
  port?: string;
  rack?: string;
  /** Room or rack location, e.g. "RK-101 MDF" / "Bedroom 2". */
  location: string;
}

export interface InstallCable {
  label: string;
  kind: CableKind;
  /** As the takeoff names it, e.g. "CAT6A plenum". */
  cableType: string;
  /** The OpenTakeoff cable run it belongs to (absent for in-rack or added cables). */
  runId?: string;
  /** Measured per-cable length (route + vertical + loops); null when the run has no measured route. */
  lengthFt: number | null;
  /** Rack end. */
  from: CableEnd;
  /** Field end. */
  to: CableEnd;
  spare?: boolean;
  notes?: string;
}

// ── equipment and signal flow ───────────────────────────────────────────────

export interface EquipmentPort {
  /** Stable within its equipment, e.g. "p12", "zone1L". */
  id: string;
  /** As printed on the gear, e.g. "PORT 12", "ZONE 1 L", "HDMI OUT". */
  label: string;
  /** ethernet, hdmi, speaker, line-audio, fiber, rs232, ir, relay, power, ... */
  signal: string;
  connector?: string;
  direction?: "in" | "out" | "bidir";
  poe?: boolean;
}

/** Anything drawn in a signal-flow diagram: rack gear or a field device (same tag as its InstallDevice). */
export interface InstallEquipment {
  tag: string;
  description: string;
  manufacturer?: string;
  model?: string;
  /** Rack id when rack-mounted, else the room. */
  location: string;
  rack?: string;
  ports: EquipmentPort[];
  /** Maximum draw in watts; null when unknown (an issue for rack power). */
  watts?: number | null;
  ofe?: boolean;
  /** Key into the equipment library entry it came from. */
  libraryKey?: string;
}

export interface ConnectionEnd {
  equipment: string;
  port: string;
}

export interface Connection {
  id: string;
  /** InstallCable label when this is a field cable; absent for an in-rack patch or jumper. */
  cable?: string;
  kind: CableKind | "patch" | "wireless";
  from: ConnectionEnd;
  to: ConnectionEnd;
  notes?: string;
}

// ── racks ───────────────────────────────────────────────────────────────────

export interface RackItem {
  /** Equipment tag, or a label for panels / blanks / vents / shelves / managers. */
  tag: string;
  kind: "equipment" | "panel" | "manager" | "shelf" | "blank" | "vent";
  /** Topmost RU it occupies (RU 1 at the bottom). */
  ruTop: number;
  ruHeight: number;
  label?: string;
}

export interface Rack {
  /** e.g. "RK-101". */
  id: string;
  name: string;
  location: string;
  /** The TR marker it stands at. */
  trShapeId?: string;
  model?: string;
  sizeRU: number;
  items: RackItem[];
  /** Branch circuits feeding it, e.g. [{label: "20A dedicated", amps: 20}, ...]. */
  circuits?: { label: string; amps: number; volts?: number }[];
  /** Fan / ventilation capacity in CFM, when known. */
  fanCfm?: number | null;
}

// ── mounting details ────────────────────────────────────────────────────────

export interface MountingDetail {
  /** Matches InstallDevice.deviceType. */
  deviceType: string;
  title: string;
  /** e.g. "18 in. AFF to center". */
  heightAff: string;
  /** e.g. "1-gang low-voltage mud ring (by EC)". */
  box: string;
  notes: string[];
  /** Spec clause or drawing note it comes from. */
  basis?: string;
}

// ── the design ──────────────────────────────────────────────────────────────

export interface InstallIssue {
  severity: "error" | "warning";
  /** e.g. "label_duplicate", "port_double_used", "ru_overlap", "power_unknown", "room_unknown", "length_unmeasured". */
  code: string;
  message: string;
  ref?: string;
}

export interface InstallDesign {
  schema: "brink.install.v1";
  project: ProjectId;
  /** Monotonic; every saved change by a tool is a new revision. */
  revision: number;
  created: string;
  /** The bid revision whose takeoff it was drawn from, when there is one. */
  bidRevision?: number;
  labelScheme: LabelScheme;
  devices: InstallDevice[];
  cables: InstallCable[];
  equipment: InstallEquipment[];
  connections: Connection[];
  racks: Rack[];
  mounting: MountingDetail[];
  /** The last check's findings, errors first. */
  issues: InstallIssue[];
  status: "draft" | "approved";
  /** Only the owner sets this (the phone page). Tools never do. */
  approved?: { at: string; revision: number };
}

// ── equipment library (store: system/equipment.json) ────────────────────────

export interface EquipmentSpec {
  /** Normalised manufacturer + model. */
  key: string;
  manufacturer: string;
  model: string;
  description: string;
  /** Rack units; 0 for non-rack gear. */
  ruHeight: number;
  /** Maximum draw in watts (from the spec sheet), when known. */
  watts: number | null;
  /** Ports as the gear presents them; copied into InstallEquipment when placed. */
  ports: EquipmentPort[];
  /** Spec sheet URL or document the facts came from. */
  source: string;
  /** YYYY-MM-DD. */
  date: string;
  notes?: string;
}

export interface EquipmentLibrary {
  schema: "brink.equipment.v1";
  entries: EquipmentSpec[];
}
