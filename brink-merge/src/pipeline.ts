// The whole merge in one call: OpenTakeoff export (+ report) and the Brink
// catalog map in, rollup + BOM + EasySchematic file + issues out. Pure: no
// file or database I/O (cli.ts, db/ and mcp/ wrap it).
import { buildBom, finalizeBom, type Bom } from "./bom.js";
import { readCable, type CableData } from "./cable.js";
import { resolveMapping, type CatalogMap, type ResolvedMapping } from "./catalog.js";
import { Issues, type Issue } from "./issues.js";
import { checkInput, type LoadedInput } from "./load.js";
import { rollup, type ConditionRollup } from "./rollup.js";
import { buildSchematic, type SchematicBuild } from "./schematic.js";
import { validateSchematic } from "./validate.js";

export interface MergeResult {
  project: string;
  rollups: ConditionRollup[];
  cable: CableData;
  mapping: ResolvedMapping;
  bom: Bom;
  schematic: SchematicBuild;
  issues: Issue[];
}

export function merge(input: LoadedInput, map: CatalogMap, opts: { project?: string; date?: string } = {}): MergeResult {
  const issues = new Issues();
  const project = opts.project || input.takeoff.project_name || input.report?.project_name || "OpenTakeoff Division 27";
  checkInput(input, issues);
  const rollups = rollup(input.takeoff);
  const cable = readCable(input.takeoff, input.report, issues);
  const mapping = resolveMapping(rollups, map, issues);
  const draft = buildBom({ project, rollups, cable, mapping, takeoff: input.takeoff, report: input.report, issues });
  const schematic = buildSchematic({ project, takeoff: input.takeoff, rollups, runs: cable.runs, mapping, issues, date: opts.date });
  for (const p of validateSchematic(schematic.file)) issues.error("schematic_invalid", `emitted schematic: ${p}`);
  const bom = finalizeBom(draft, issues);
  return { project, rollups, cable, mapping, bom, schematic, issues: issues.list };
}
