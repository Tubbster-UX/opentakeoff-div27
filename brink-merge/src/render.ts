// The EasySchematic file from an import's schematic rows. Pure, so the app's
// Worker renders exactly what brink-merge renders (repository.ts runs the
// queries here; the Worker runs the same three over Hyperdrive).
import type { ConnectionEdge, SchematicFile, SchematicNode } from "./vendor/esTypes.js";

export interface SchematicMetaRow {
  name: string;
  version: number;
  title_block: SchematicFile["titleBlock"] | null;
  custom_templates: SchematicFile["customTemplates"] | null;
  extra: Record<string, unknown> | null;
}

export const SCHEMATIC_META_SQL = "select name, version, title_block, custom_templates, extra from brink_schematics where import_id = $1";
export const SCHEMATIC_NODES_SQL = "select node, x, y from brink_schematic_nodes where import_id = $1 order by seq";
export const SCHEMATIC_EDGES_SQL = "select edge from brink_schematic_connections where import_id = $1 order by seq";

/** Positions come from the x / y columns (not the node blob), so a row edit there is what opens. */
export function assembleSchematic(meta: SchematicMetaRow, nodes: { node: SchematicNode; x: unknown; y: unknown }[], edges: { edge: ConnectionEdge }[]): SchematicFile {
  return {
    ...(meta.extra ?? {}),
    version: Number(meta.version),
    name: meta.name,
    nodes: nodes.map((r) => ({ ...r.node, position: { x: Number(r.x), y: Number(r.y) } }) as SchematicNode),
    edges: edges.map((r) => r.edge),
    customTemplates: meta.custom_templates ?? [],
    ...(meta.title_block ? { titleBlock: meta.title_block } : {}),
  };
}
