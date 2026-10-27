// Structural checks on an emitted SchematicFile against the vendored
// EasySchematic enums and schema version: what ES would reject or silently
// mis-render (unknown enums, dangling handles, a port double-connected).
import { CONNECTOR_TYPES, CURRENT_SCHEMA_VERSION, DEVICE_TYPES, SIGNAL_TYPES } from "./vendor/esEnums.generated.js";
import type { DeviceData, SchematicFile } from "./vendor/esTypes.js";

const deviceTypes = new Set<string>(DEVICE_TYPES);
const signalTypes = new Set<string>(SIGNAL_TYPES);
const connectorTypes = new Set<string>(CONNECTOR_TYPES);
const FACE = /-(in|out|rear|front)$/;

export function validateSchematic(file: SchematicFile): string[] {
  const problems: string[] = [];
  if (file.version !== CURRENT_SCHEMA_VERSION) problems.push(`version ${file.version} is not EasySchematic's current ${CURRENT_SCHEMA_VERSION}`);
  const ids = new Set<string>();
  const devices = new Map<string, DeviceData>();
  for (const n of file.nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (n.type === "device") devices.set(n.id, n.data as DeviceData);
  }
  for (const n of file.nodes) {
    if (n.parentId && !ids.has(n.parentId)) problems.push(`${n.id}: parent ${n.parentId} does not exist`);
    if (n.type !== "device") continue;
    const d = n.data as DeviceData;
    if (!deviceTypes.has(d.deviceType)) problems.push(`${n.id}: deviceType ${d.deviceType} is not an EasySchematic device type`);
    const portIds = new Set<string>();
    for (const p of d.ports) {
      if (portIds.has(p.id)) problems.push(`${n.id}: duplicate port id ${p.id}`);
      portIds.add(p.id);
      if (!signalTypes.has(p.signalType)) problems.push(`${n.id}/${p.id}: signalType ${p.signalType} is unknown`);
      for (const k of ["connectorType", "rearConnectorType", "frontConnectorType"] as const) {
        const v = p[k];
        if (v !== undefined && !connectorTypes.has(v)) problems.push(`${n.id}/${p.id}: ${k} ${v} is unknown`);
      }
    }
  }
  for (const t of file.customTemplates ?? []) {
    if (!deviceTypes.has(t.deviceType)) problems.push(`template ${t.id}: deviceType ${t.deviceType} is unknown`);
  }
  const edgeIds = new Set<string>();
  const usedHandles = new Set<string>();
  for (const e of file.edges) {
    if (edgeIds.has(e.id)) problems.push(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    if (e.data && !signalTypes.has(e.data.signalType)) problems.push(`${e.id}: signalType ${e.data.signalType} is unknown`);
    for (const [nodeId, handle] of [[e.source, e.sourceHandle], [e.target, e.targetHandle]] as const) {
      const d = devices.get(nodeId);
      if (!d) {
        problems.push(`${e.id}: endpoint ${nodeId} is not a device`);
        continue;
      }
      if (!handle) continue;
      const port = d.ports.find((p) => p.id === handle) ?? d.ports.find((p) => p.id === handle.replace(FACE, ""));
      if (!port) problems.push(`${e.id}: ${nodeId} has no port for handle ${handle}`);
      const key = `${nodeId}:${handle}`;
      if (usedHandles.has(key)) problems.push(`${e.id}: handle ${key} already carries a connection`);
      usedHandles.add(key);
    }
  }
  return problems;
}
