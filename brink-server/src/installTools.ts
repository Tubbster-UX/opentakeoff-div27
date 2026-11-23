// Install-phase tools on the hosted takeoff MCP server (/mcp): after a bid is
// won, Claude drafts the install design from the takeoff (device tags, cable
// labels, rack layouts, port assignments, signal flow, mounting details) into
// projects/<p>/outputs/install/design.json. Every saved change is a new DRAFT
// revision: only the owner approves it for construction, on the project page
// (src/installApproval.ts); no tool here can set or keep an approval.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "opentakeoff-core";
import type { AppDeps, ProjectId, ProjectManifest } from "./types.ts";
import type { InstallDesign, InstallIssue } from "./installTypes.ts";
import { LINK_TTL_SEC, UserError, fail, linksForPushed, ok, requireProject, type OpenState, type ToolReply } from "./projectTools.ts";
import { readBid } from "./approval.ts";
import { draftInstallDesign, TAKEOFF_ISSUE_CODES, type InstallTakeoff } from "./install/baseline.ts";
import { checkInstallDesign, sortIssues } from "./install/check.ts";
import { applyInstallOps, installOpSchema, OpError, portGroupSchema, portSchema, type InstallOp } from "./install/ops.ts";
import { designSummary, issueBrief, rackBrief } from "./install/summary.ts";
import { StoreEquipmentLibrary, type EquipmentSpecInput, type PortGroup } from "./equipmentLib.ts";

/** Where the design lives, relative to the project's outputs. */
export const INSTALL_OUTPUT = "install/design.json";

export const INSTALL_TOOL_NAMES = [
  "install_draft", "get_install_design", "update_install_design", "install_check", "record_equipment", "find_equipment",
] as const;

export interface InstallToolsCtx {
  deps: AppDeps;
  /** This MCP connection's OpenTakeoff session (its takeoff is what install_draft reads). */
  session: Session;
  state: OpenState;
  /** Push the project's outputs to the store now; returns the project paths pushed. */
  pushOutputs(project: ProjectId): Promise<string[]>;
  linkTtlSec?: number;
  equipment?: StoreEquipmentLibrary;
  now?: () => string;
}

const run = (fn: (a: any) => Promise<ToolReply> | ToolReply) => async (a: any): Promise<ToolReply> => {
  try {
    return await fn(a);
  } catch (e) {
    return fail(e instanceof OpError ? new UserError(e.message) : e);
  }
};

const projectArg = z.string().describe("Project id from list_projects");
const PARTS = ["devices", "cables", "racks", "equipment", "connections", "mounting", "issues"] as const;

const phaseGate = (m: ProjectManifest, what: string) => {
  const phase = m.phase ?? "bid";
  if (phase !== "install") {
    throw new UserError(`${what} works only in the install phase; project ${m.id} is in the ${phase} phase. The owner starts the install phase on the project page (it needs an approved bid): ask them to.`);
  }
};

export function registerInstallTools(server: McpServer, ctx: InstallToolsCtx): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;
  const library = ctx.equipment ?? new StoreEquipmentLibrary(deps.storage);
  const now = ctx.now ?? (() => new Date().toISOString());
  const localFile = (project: ProjectId) => path.join(deps.workspace.outputsDir(project), ...INSTALL_OUTPUT.split("/"));

  /** The latest design: the store's copy, or the local one when it is newer (a push that has not landed yet). */
  const latest = async (project: ProjectId): Promise<InstallDesign | null> => {
    let stored: InstallDesign | null = null;
    const bytes = await deps.storage.getBytes(`projects/${project}/outputs/${INSTALL_OUTPUT}`);
    if (bytes) stored = JSON.parse(Buffer.from(bytes).toString("utf8")) as InstallDesign;
    let local: InstallDesign | null = null;
    try { local = JSON.parse(await readFile(localFile(project), "utf8")) as InstallDesign; } catch { /* none */ }
    if (local && (!stored || (local.revision ?? 0) > (stored.revision ?? 0))) return local;
    return stored;
  };
  const need = async (project: ProjectId) => {
    const d = await latest(project);
    if (!d) throw new UserError(`Project ${project} has no install design yet: open_project, then install_draft.`);
    return d;
  };

  /** Write, push, and say what happened to an earlier approval. */
  const save = async (project: ProjectId, design: InstallDesign, prev: InstallDesign | null) => {
    design.status = "draft";
    delete design.approved;
    const file = localFile(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(design, null, 1)}\n`);
    let links: { path: string; url: string }[] = [];
    let pushError: string | undefined;
    try {
      links = await linksForPushed(deps, project, await ctx.pushOutputs(project), ttl);
    } catch (e) {
      pushError = `design.json is written on the server but pushing it to the store failed (${e instanceof Error ? e.message : e}); the next tool call retries.`;
    }
    const approval = prev?.status === "approved" || prev?.approved
      ? `Revision ${design.revision} replaces revision ${prev.approved?.revision ?? prev.revision}, which the owner had approved for construction: that approval is cleared. Tell the owner the install design changed and needs their approval again on the project page.`
      : "Draft. Only the owner approves it for construction, on the project page; never tell the owner it is approved.";
    return { approval, output: `outputs/${INSTALL_OUTPUT}`, ...(links.length ? { download: links } : {}), ...(pushError ? { push_error: pushError } : {}) };
  };

  server.registerTool("install_draft", {
    description: "Draft (or re-draft) the install design from the takeoff open in this conversation (open_project first; the project must be in the install phase, which the owner starts on the project page): one device per count marker with a tag (prefix by type + floor + sequence, e.g. WAP-102) and its room from the labeled floor areas, one rack per TR marker (RK-101), patch panels per rack with ports assigned by room then device tag, one cable per cable of each linked run at the takeoff's measured per-cable length, labels by the job's label scheme, connections, and a mounting detail per device type. Re-drafting keeps everything set on the previous revision (tags, rooms, heights, models, rack layout, port assignments, label scheme) and lists removed items as issues. Writes outputs/install/design.json as a new DRAFT revision (clears an owner approval) and replies with the counts and the issues, errors first. Unlinked, held, withheld or broken runs are issues, not cables: fix them in the takeoff (link_run / hold_devices) and draft again.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    phaseGate(m, "install_draft");
    if (ctx.state.project !== m.id) {
      throw new UserError(`install_draft reads the takeoff open in this conversation: call open_project {project: "${m.id}"} first${ctx.state.project ? ` (this conversation has ${ctx.state.project} open)` : ""}.`);
    }
    const takeoff = ctx.session.exportPayload() as InstallTakeoff;
    const prev = await latest(m.id);
    const bid = await readBid(deps, m.id);
    const sheets = [...(ctx.session.sheets ?? new Map()).entries()].map(([key, s]) => ({ key, number: s?.sheetNumber ?? null }));
    const design = draftInstallDesign({
      takeoff, project: m.id, previous: prev, now: now(), sheets,
      ...(bid ? { bidRevision: bid.approved?.revision ?? bid.revision } : {}),
    });
    const saved = await save(m.id, design, prev);
    return ok({
      project: m.id,
      revision: design.revision,
      status: design.status,
      counts: designSummary(design).counts,
      issues: issueBrief(design.issues),
      labelScheme: `${design.labelScheme.pattern} (${design.labelScheme.source}${design.labelScheme.reference ? `, ${design.labelScheme.reference}` : ""})`,
      ...saved,
      next: design.issues.some((i) => i.severity === "error")
        ? "Fix the errors: takeoff holes in the takeoff then install_draft again; rack sizes, mounting heights, the spec's label scheme (read its 27 05 53 / labeling section) and equipment with update_install_design. Never invent a size, height or length: ask the owner when the documents do not say."
        : "No errors. Walk the owner through the warnings, then the install package.",
    });
  }));

  server.registerTool("get_install_design", {
    description: "The latest install design of a project (does not need the project open): by default a summary (revision, status, label scheme, counts, racks with their RU layout and power, issue counts). part = devices | cables | racks | equipment | connections | mounting | issues returns that full list, a page at a time (offset / limit).",
    inputSchema: {
      project: projectArg,
      part: z.enum(PARTS).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Rows per page (default 100)"),
    },
  }, run(async ({ project, part, offset, limit }) => {
    const m = await requireProject(deps, project);
    const d = await need(m.id);
    if (!part) return ok({ ...designSummary(d), phase: m.phase ?? "bid", racks: rackBrief(d), issues: issueBrief(d.issues, 15) });
    const rows: unknown[] = ({
      devices: () => d.devices.map((x) => ({ tag: x.tag, type: x.deviceType, room: x.room, rack: x.rack, sheet: x.sheet, ...(x.model ? { model: x.model } : {}), ...(x.manufacturer ? { manufacturer: x.manufacturer } : {}), ...(x.mounting ? { mounting: x.mounting } : {}), ...(x.mountingHeight ? { mountingHeight: x.mountingHeight } : {}), ...(x.ofe ? { ofe: true } : {}), ...(x.notes ? { notes: x.notes } : {}), shapeId: x.shapeId })),
      cables: () => d.cables.map((c) => ({ label: c.label, kind: c.kind, type: c.cableType, ft: c.lengthFt, from: `${c.from.equipment} ${c.from.port ?? ""} (${c.from.rack ?? "-"})`, to: `${c.to.equipment} ${c.to.port ?? ""} (${c.to.location})`, ...(c.spare ? { spare: true } : {}), ...(c.labelOverride ? { handLabel: true } : {}), ...(c.notes ? { notes: c.notes } : {}) })),
      racks: () => rackBrief(d),
      equipment: () => d.equipment.map((e) => ({ tag: e.tag, description: e.description, ...(e.manufacturer ? { manufacturer: e.manufacturer } : {}), ...(e.model ? { model: e.model } : {}), location: e.location, ...(e.rack ? { rack: e.rack } : {}), ports: e.ports.length, watts: e.watts ?? null, ...(e.libraryKey ? { libraryKey: e.libraryKey } : {}) })),
      connections: () => d.connections.map((c) => ({ id: c.id, kind: c.kind, ...(c.cable ? { cable: c.cable } : {}), from: `${c.from.equipment} ${c.from.port}`, to: `${c.to.equipment} ${c.to.port}`, ...(c.notes ? { notes: c.notes } : {}) })),
      mounting: () => d.mounting,
      issues: () => d.issues,
    } as Record<(typeof PARTS)[number], () => unknown[]>)[part as (typeof PARTS)[number]]();
    const from = offset ?? 0;
    const n = limit ?? 100;
    const page = rows.slice(from, from + n);
    return ok({ project: m.id, revision: d.revision, status: d.status, part, total: rows.length, offset: from, rows: page, ...(from + n < rows.length ? { next_offset: from + n } : {}) });
  }));

  server.registerTool("update_install_design", {
    description: "Change the install design with a list of ops, applied all or nothing (any invalid op refuses the whole call and nothing is saved): set_label_scheme (from the job's labeling section, 27 05 53 / TIA-606: source \"spec\" with its reference; every cable is relabeled), set_device (tag rename, room, manufacturer, model, mounting, mountingHeight, ofe, notes; cables and connections follow a rename), set_cable (hand label, spare, notes; never lengthFt: lengths come only from the takeoff), add_equipment (by equipment library key from find_equipment, or explicit description + ports + watts), remove_equipment, place_in_rack (RU height from the library), set_rack (name, model, sizeRU, circuits, fanCfm), connect / disconnect (ports must exist and be free), assign_port (move a field cable to another panel port in its rack), set_mounting (heights and boxes from the spec or the drawing legend). Every successful call saves a new DRAFT revision (an owner approval is cleared: say so) and replies with the issues, errors first. Never invent a value the documents do not give: ask the owner.",
    inputSchema: {
      project: projectArg,
      ops: z.array(installOpSchema).min(1).max(200),
    },
  }, run(async ({ project, ops }) => {
    const m = await requireProject(deps, project);
    phaseGate(m, "update_install_design");
    const prev = await need(m.id);
    const { design, changes, warnings } = applyInstallOps(prev, ops as InstallOp[], await library.all());
    design.revision = prev.revision + 1;
    design.created = now();
    const saved = await save(m.id, design, prev);
    return ok({
      project: m.id,
      revision: design.revision,
      status: design.status,
      changes,
      ...(warnings.length ? { warnings } : {}),
      issues: issueBrief(design.issues),
      ...saved,
    });
  }));

  server.registerTool("install_check", {
    description: "Check the latest install design (does not save anything): duplicate labels or tags, ports used twice, connections to missing equipment or ports, RU overlaps and items outside a rack, racks with no size, rack power against its circuits at 80% continuous (with the heat in BTU/hr), copper links over 295 ft, unmeasured lengths, devices with no room, missing mounting heights, a non-default label scheme with no spec reference. Plus the takeoff issues from the last install_draft. Errors first; the owner cannot approve while any error stands.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    const d = await need(m.id);
    const issues: InstallIssue[] = sortIssues([...d.issues.filter((i) => TAKEOFF_ISSUE_CODES.has(i.code)), ...checkInstallDesign(d)]);
    return ok({ project: m.id, revision: d.revision, status: d.status, issues: issueBrief(issues, 60), racks: rackBrief(d).map((r) => ({ id: r.id, sizeRU: r.sizeRU, power: r.power })) });
  }));

  server.registerTool("record_equipment", {
    description: "Add gear to the equipment library (system/equipment.json; history kept, the newest entry per manufacturer + model wins). Take every fact from the manufacturer's spec sheet: rack units (0 for non-rack gear), maximum watts (null when the sheet does not say), and the ports as printed (ports, or portGroups for numbered runs like 48 PoE ports). source is the spec sheet URL or document and date is the day you read it (YYYY-MM-DD). Never guess a figure.",
    inputSchema: {
      entries: z.array(z.object({
        manufacturer: z.string().min(1),
        model: z.string().min(1),
        description: z.string().min(1),
        ruHeight: z.number().int().min(0).max(60),
        watts: z.number().min(0).nullable(),
        ports: z.array(portSchema).optional(),
        portGroups: z.array(portGroupSchema).optional(),
        source: z.string().min(1).describe("Spec sheet URL or document"),
        date: z.string().describe("YYYY-MM-DD"),
        notes: z.string().optional(),
        key: z.string().optional().describe("Normally left out (manufacturer:model)"),
      })).min(1).max(100),
    },
  }, run(async ({ entries }) => {
    const { added, duplicates } = await library.record((entries as (EquipmentSpecInput & { portGroups?: PortGroup[] })[]));
    return ok({ added: added.map((e) => ({ key: e.key, model: `${e.manufacturer} ${e.model}`, ruHeight: e.ruHeight, watts: e.watts, ports: e.ports.length, date: e.date })), duplicates: duplicates.length, note: "add_equipment {key} places it in a design." });
  }));

  server.registerTool("find_equipment", {
    description: "Search the equipment library: every word must appear in the manufacturer, model, description or key. The newest entry per model, with RU height, watts, ports, source and date. When it is not there, look up the manufacturer's spec sheet and record_equipment it.",
    inputSchema: {
      query: z.string().max(300),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, run(async ({ query, limit }) => {
    const found = await library.find(query, { limit: limit ?? 20 });
    return ok({
      entries: found.map((e) => ({ key: e.key, manufacturer: e.manufacturer, model: e.model, description: e.description, ruHeight: e.ruHeight, watts: e.watts, ports: e.ports.length, portSample: e.ports.slice(0, 4).map((p) => p.id), source: e.source, date: e.date })),
      ...(found.length ? {} : { note: "No match. Look up the manufacturer's spec sheet (RU, maximum watts, ports) and record_equipment it with the URL and today's date." }),
    });
  }));
}

/** The server instructions' install section (src/mcp.ts appends it). */
export const INSTALL_INSTRUCTIONS = [
  "INSTALL: after a bid is won the owner starts the install phase on the project page; Claude drafts the install design, the owner approves it for construction. Workflow:",
  "1. open_project, then install_draft {project}: devices, racks, patch panels, cables at the takeoff's measured lengths, labels, connections, mounting details.",
  "2. Read the spec's labeling section (27 05 53 / TIA-606) and set_label_scheme with its reference; without one the default {type}{seq:2} (D01, F01) stands.",
  "3. Close the errors with update_install_design: rack sizes and circuits, mounting heights from the spec or legend, equipment from the library (find_equipment; else the manufacturer's spec sheet → record_equipment), place_in_rack, connect. Takeoff holes (unlinked, held, withheld runs) are fixed in the takeoff, then install_draft again.",
  "4. install_check before handing it to the owner.",
  "Nothing is invented: no assumed rack size, height, wattage or length (ask the owner). Every change is a new draft revision that clears an approval; never claim the design is approved.",
].join("\n");
