// The whole merge in one call: OpenTakeoff export (+ report) and the Brink
// catalog map in, rollup + BOM + EasySchematic file + issues out. Pure: no
// file or database I/O (cli.ts, db/ and mcp/ wrap it).
import { buildBom, finalizeBom, type Bom } from "./bom.js";
import { readCable, type CableData } from "./cable.js";
import { resolveMapping, type CatalogMap, type ResolvedMapping } from "./catalog.js";
import { applyEdits, type SchematicEdit } from "./edits.js";
import { Issues, type Issue } from "./issues.js";
import { checkInput, type LoadedInput } from "./load.js";
import { rollup, type ConditionRollup } from "./rollup.js";
import { buildSchematic, type SchematicBuild } from "./schematic.js";
import { validateSchematic } from "./validate.js";
import type { SchematicFile } from "./vendor/esTypes.js";

export interface MergeResult {
  project: string;
  rollups: ConditionRollup[];
  cable: CableData;
  mapping: ResolvedMapping;
  bom: Bom;
  /** The generated schematic (what is stored as rows): never carries edits. */
  schematic: SchematicBuild;
  /** The schematic people see: the generated one with the project's edit layer applied (same as `schematic.file` without edits). */
  edited: SchematicFile;
  /** Ids of the edits applied to `edited`; the rest are issues. */
  editsApplied: string[];
  issues: Issue[];
}

/** The project name a merge of `input` is stored under. */
export function projectNameFor(input: LoadedInput, project?: string): string {
  return project || input.takeoff.project_name || input.report?.project_name || "OpenTakeoff Division 27";
}

/**
 * `edits`: the project's active schematic edits (db/repository.ts loadActiveEdits). They are re-applied
 * to the new schematic; one that cannot be applied becomes a warning issue (edits.ts), never dropped.
 */
export function merge(input: LoadedInput, map: CatalogMap, opts: { project?: string; date?: string; edits?: readonly SchematicEdit[] } = {}): MergeResult {
  const issues = new Issues();
  const project = projectNameFor(input, opts.project);
  checkInput(input, issues);
  const rollups = rollup(input.takeoff);
  const cable = readCable(input.takeoff, input.report, issues);
  const mapping = resolveMapping(rollups, map, issues);
  const draft = buildBom({ project, rollups, cable, mapping, takeoff: input.takeoff, report: input.report, issues });
  const schematic = buildSchematic({ project, takeoff: input.takeoff, rollups, runs: cable.runs, mapping, issues, date: opts.date });
  for (const p of validateSchematic(schematic.file)) issues.error("schematic_invalid", `emitted schematic: ${p}`);
  const layer = applyEdits(schematic.file, opts.edits ?? []);
  for (const i of layer.issues) issues.list.push(i);
  const bom = finalizeBom(draft, issues);
  return { project, rollups, cable, mapping, bom, schematic, edited: layer.file, editsApplied: layer.applied, issues: issues.list };
}
