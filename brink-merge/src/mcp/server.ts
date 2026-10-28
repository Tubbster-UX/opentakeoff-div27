// The headless brink MCP server: the EasySchematic half of the Division 27
// workflow, driven by an agent the way the OpenTakeoff MCP server drives a
// takeoff. The two servers link by file handoff, never by importing each
// other: OpenTakeoff's export_takeoff and export_report write the files,
// import_takeoff here reads them into the system of record (Postgres /
// Supabase, or local PGlite), and export_schematic renders an EasySchematic
// file from those rows.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bomToCsv } from "../bom.js";
import { catalogRowSchema, loadCatalogMap, rowEnumProblems, type CatalogRow } from "../catalog.js";
import { migrate, type Db } from "../db/db.js";
import {
  currentImport, listProjects, loadActiveEditsByName, loadActiveTakeoffEditsByName, loadBomLines, loadCatalog, loadImportInput, loadIssues, renderSchematic, saveMerge, seedCatalog, upsertCatalogRow, type ImportSummary,
} from "../db/repository.js";
import type { Issue } from "../issues.js";
import { loadInput, type LoadedInput } from "../load.js";
import { merge, projectNameFor, type MergeResult } from "../pipeline.js";
import { CURRENT_SCHEMA_VERSION } from "../vendor/esEnums.generated.js";

export const DEFAULT_MAP = new URL("../../data/catalog-map.json", import.meta.url).pathname;

export const INSTRUCTIONS = `brink: OpenTakeoff Division 27 takeoff -> priced-ready BOM + EasySchematic project (schema v${CURRENT_SCHEMA_VERSION}), stored in Brink's database.
Link with the opentakeoff MCP server by files: finish the takeoff there, then call its export_takeoff {path: "<job>.takeoff.json"} and export_report {path: "<job>.report.json"}, then call import_takeoff here with both paths.
Never invent quantities: device counts and cable lengths are OpenTakeoff's (measured per-cable LF from its cable runs). Read every issue import_takeoff returns: an error is a hole in the bid (an unmapped condition, a report that does not match its takeoff); fix it (map_condition, or re-export both files from one session) and import again. Warnings are OpenTakeoff's own disclosures (unlinked or held devices, over-length runs, unaccepted agent runs): report them to the estimator.
Mappings start "proposed"; only Alexavier confirms them (map_condition status "confirmed" on his say-so). Then export_bom and export_schematic, and give the user both paths.`;

type Text = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const reply = (v: Record<string, unknown>): Text => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }], structuredContent: v });
const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });

const issueCounts = (issues: Issue[]) => ({ errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length });

export interface BrinkState {
  db: Db;
  ready?: Promise<void>;
}

/** Migrate, and seed the catalog from data/catalog-map.json when the database has none. */
export async function prepare(state: BrinkState, mapPath = DEFAULT_MAP): Promise<void> {
  state.ready ??= (async () => {
    await migrate(state.db);
    const existing = await loadCatalog(state.db);
    if (!existing.rows.length) await seedCatalog(state.db, loadCatalogMap(mapPath));
  })();
  return state.ready;
}

async function runMerge(state: BrinkState, input: LoadedInput, project?: string): Promise<{ result: MergeResult; saved: ImportSummary }> {
  const map = await loadCatalog(state.db);
  // People's schematic edits survive: the project's edit layer is re-applied to the new import.
  const edits = await loadActiveEditsByName(state.db, projectNameFor(input, project));
  // And their takeoff edits (the app's takeoff canvas): re-applied over the export, which is stored as exported.
  const takeoffEdits = await loadActiveTakeoffEditsByName(state.db, projectNameFor(input, project));
  const result = merge(input, map, { project, edits, takeoffEdits });
  const saved = await saveMerge(state.db, input, result);
  return { result, saved };
}

function summarize(result: MergeResult, saved: ImportSummary) {
  const t = result.bom.totals;
  return {
    project: saved.project,
    import_id: saved.importId,
    totals: t,
    devices_by_condition: result.schematic.deviceCounts,
    connections: result.schematic.file.edges.length,
    schematic_edits: { applied: result.editsApplied.length, not_applied: result.issues.filter((i) => i.code === "schematic_edit_orphaned" || i.code === "schematic_edit_conflict").length },
    unmapped: result.mapping.unmapped,
    ...issueCounts(result.issues),
    issues: result.issues.map((i) => `${i.severity} [${i.code}] ${i.message}`),
  };
}

async function requireImport(state: BrinkState, project: string): Promise<ImportSummary> {
  const cur = await currentImport(state.db, project);
  if (!cur) {
    const names = (await listProjects(state.db)).map((p) => p.project);
    throw new Error(`no project named ${JSON.stringify(project)}${names.length ? `; projects: ${names.join(", ")}` : "; import_takeoff first"}`);
  }
  return cur;
}

export function buildServer(state: BrinkState): McpServer {
  const server = new McpServer({ name: "brink", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const run = <A>(fn: (args: A) => Promise<Text>) => async (args: A): Promise<Text> => {
    try {
      await prepare(state);
      return await fn(args);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  server.registerTool("import_takeoff", {
    description: "Read an OpenTakeoff takeoff export and its export_report JSON (write both with the opentakeoff server's export_takeoff / export_report path), roll quantities up by condition, join them to the Brink catalog map, and store the BOM and the EasySchematic schematic as the project's current import. Returns totals, devices per condition, and every issue. The report is required whenever the takeoff has Division 27 cable runs: cable lengths come only from it.",
    inputSchema: {
      takeoff_path: z.string().describe("Path of the OpenTakeoff takeoff export (*.takeoff.json)"),
      report_path: z.string().optional().describe("Path of OpenTakeoff's export_report JSON for the same session"),
      project: z.string().optional().describe("Project name (default: the export's project_name)"),
    },
  }, run(async ({ takeoff_path, report_path, project }: { takeoff_path: string; report_path?: string; project?: string }) => {
    const input = loadInput(resolve(takeoff_path), report_path ? resolve(report_path) : null);
    const { result, saved } = await runMerge(state, input, project);
    return reply(summarize(result, saved));
  }));

  server.registerTool("list_projects", {
    description: "Projects in the database with their current import's time and issue counts.",
    inputSchema: {},
  }, run(async () => reply({ projects: await listProjects(state.db) })));

  server.registerTool("bom", {
    description: "The current import's BOM: device lines (model, EasySchematic deviceType, qty), cable lines (cable type, TR, pulls, cables, measured net and order LF), box/reel order lines, pathway LF and supporting materials. Issue lines are left out here; list_issues has them.",
    inputSchema: { project: z.string() },
  }, run(async ({ project }: { project: string }) => {
    const cur = await requireImport(state, project);
    const lines = (await loadBomLines(state.db, cur.importId)).filter((l) => l.kind !== "issue");
    return reply({ project, import_id: cur.importId, lines });
  }));

  server.registerTool("list_issues", {
    description: "Every issue on the current import: errors (unmapped or invalid mappings, a report that does not match its takeoff) and warnings (OpenTakeoff's unlinked / held / over-length / unaccepted disclosures, proposed mappings).",
    inputSchema: { project: z.string(), severity: z.enum(["error", "warning"]).optional() },
  }, run(async ({ project, severity }: { project: string; severity?: "error" | "warning" }) => {
    const cur = await requireImport(state, project);
    const issues = (await loadIssues(state.db, cur.importId)).filter((i) => !severity || i.severity === severity);
    return reply({ project, ...issueCounts(issues), issues });
  }));

  server.registerTool("catalog", {
    description: "The Brink catalog map: one row per OpenTakeoff condition (finish tag) with its EasySchematic deviceType, model, port, expected cable type, reserved Portal SKU and status (proposed / confirmed).",
    inputSchema: {},
  }, run(async () => reply({ rows: (await loadCatalog(state.db)).rows })));

  server.registerTool("map_condition", {
    description: `Add or change one catalog row (optional fields left out keep the existing row's values), then re-merge every project's current import against the new map (a new import each; the old ones stay). es_device_type, signal_type and connector types must be EasySchematic's own values (refused otherwise). Set status "confirmed" only when the user has confirmed the mapping. kind: device (a condition with a cable_setup), tr (role tr: one patch panel per TR marker), route (role route: pathway LF, no device; es_device_type null), plain (anything else).`,
    inputSchema: {
      condition_key: z.string().describe("The OpenTakeoff condition's finish tag, e.g. DATA-1"),
      kind: z.enum(["device", "tr", "route", "plain"]),
      es_device_type: z.string().nullable().describe("EasySchematic deviceType, e.g. wall-plate, access-point, camera, patch-panel; null for a route"),
      label: z.string().optional(),
      manufacturer: z.string().nullable().optional(),
      model_number: z.string().nullable().optional(),
      template_id: z.string().optional().describe("An EasySchematic library template id instead of manufacturer / model"),
      signal_type: z.string().optional().describe("Signal on the port each cable lands on (default ethernet)"),
      connector_type: z.string().optional().describe("Connector of that port (default rj45)"),
      rear_connector_type: z.string().optional().describe("Wall plates / patch panels: field-termination face (default punch-down-110)"),
      cable_type: z.string().nullable().optional().describe("Expected OpenTakeoff cable_type; a different value is flagged"),
      portal_sku: z.string().nullable().optional().describe("Reserved for the Portal push"),
      status: z.enum(["proposed", "confirmed"]),
      note: z.string().optional(),
    },
  }, run(async (a: {
    condition_key: string; kind: CatalogRow["kind"]; es_device_type: string | null; label?: string; manufacturer?: string | null; model_number?: string | null; template_id?: string;
    signal_type?: string; connector_type?: string; rear_connector_type?: string; cable_type?: string | null; portal_sku?: string | null; status: CatalogRow["status"]; note?: string;
  }) => {
    // Fields the call leaves out keep the existing row's values.
    const prev = (await loadCatalog(state.db)).rows.find((r) => r.conditionKey === a.condition_key);
    const prevRef = prev?.esTemplateRef && "manufacturer" in prev.esTemplateRef ? prev.esTemplateRef : null;
    const prevPort = prev?.port ?? null;
    const row: CatalogRow = catalogRowSchema.parse({
      conditionKey: a.condition_key,
      kind: a.kind,
      esDeviceType: a.es_device_type,
      esTemplateRef: a.kind === "route" ? null
        : a.template_id ? { templateId: a.template_id }
        : a.manufacturer === undefined && a.model_number === undefined && prev?.esTemplateRef && "templateId" in prev.esTemplateRef ? prev.esTemplateRef
        : { manufacturer: a.manufacturer !== undefined ? a.manufacturer : prevRef?.manufacturer ?? null, modelNumber: a.model_number !== undefined ? a.model_number : prevRef?.modelNumber ?? null },
      label: a.label ?? prev?.label ?? null,
      port: a.kind === "route" ? null : {
        signalType: a.signal_type ?? prevPort?.signalType ?? "ethernet",
        connectorType: a.connector_type ?? prevPort?.connectorType ?? "rj45",
        ...((a.rear_connector_type ?? prevPort?.rearConnectorType) ? { rearConnectorType: a.rear_connector_type ?? prevPort?.rearConnectorType } : {}),
      },
      cableType: a.cable_type !== undefined ? a.cable_type : prev?.cableType ?? null,
      portalSku: a.portal_sku !== undefined ? a.portal_sku : prev?.portalSku ?? null,
      status: a.status,
      ...((a.note ?? prev?.note) ? { note: a.note ?? prev?.note } : {}),
    });
    const problems = rowEnumProblems(row);
    if ((row.kind === "device" || row.kind === "tr") && !row.esDeviceType) problems.push({ code: "invalid_device_type", message: `a ${row.kind} row needs es_device_type` });
    if (problems.length) return fail(`refused, nothing written: ${problems.map((p) => p.message).join("; ")}`);
    await upsertCatalogRow(state.db, row);
    const remerged = [];
    for (const p of await listProjects(state.db)) {
      const input = await loadImportInput(state.db, p.importId);
      const { result, saved } = await runMerge(state, input, p.project);
      remerged.push({ project: p.project, import_id: saved.importId, ...issueCounts(result.issues), unmapped: result.mapping.unmapped });
    }
    return reply({ row, remerged });
  }));

  server.registerTool("get_schematic", {
    description: "A compact view of the current import's EasySchematic schematic, with the edits people made in the Brink app applied: rooms with their devices, connections with measured cable lengths, and templates. export_schematic writes the full file.",
    inputSchema: { project: z.string() },
  }, run(async ({ project }: { project: string }) => {
    const cur = await requireImport(state, project);
    const file = await renderSchematic(state.db, cur.importId);
    const rooms = file.nodes.filter((n) => n.type === "room").map((r) => ({
      room: r.data.label,
      devices: file.nodes.filter((n) => n.type === "device" && n.parentId === r.id).map((n) => `${n.id} ${n.data.label} (${(n.data as { deviceType: string }).deviceType}, ${(n.data as { ports: unknown[] }).ports.length} port(s))`),
    }));
    const connections = file.edges.map((e) => `${e.id}: ${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle} ${e.data?.label ?? ""} ${e.data?.cableLength ?? ""}`);
    return reply({ project, import_id: cur.importId, version: file.version, rooms, connections, templates: (file.customTemplates ?? []).map((t) => `${t.id}: ${t.label} (${t.deviceType})`) });
  }));

  server.registerTool("export_schematic", {
    description: "Render the current import's schematic from the database (generated rows plus the edits people made in the Brink app) and write it as an EasySchematic project file (open it with EasySchematic's Load). Give the user the path.",
    inputSchema: { project: z.string(), path: z.string() },
  }, run(async ({ project, path }: { project: string; path: string }) => {
    const cur = await requireImport(state, project);
    const file = await renderSchematic(state.db, cur.importId);
    const out = resolve(path);
    writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
    return reply({ path: out, version: file.version, devices: file.nodes.filter((n) => n.type === "device").length, connections: file.edges.length });
  }));

  server.registerTool("export_bom", {
    description: "Write the current import's BOM (issue lines included) as CSV or JSON. Give the user the path.",
    inputSchema: { project: z.string(), path: z.string(), format: z.enum(["csv", "json"]).default("csv") },
  }, run(async ({ project, path, format }: { project: string; path: string; format?: "csv" | "json" }) => {
    const cur = await requireImport(state, project);
    const lines = await loadBomLines(state.db, cur.importId);
    const out = resolve(path);
    writeFileSync(out, format === "json" ? JSON.stringify({ project, import_id: cur.importId, lines }, null, 2) + "\n" : bomToCsv({ lines }));
    return reply({ path: out, format: format ?? "csv", lines: lines.length });
  }));

  return server;
}
