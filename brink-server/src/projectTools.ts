// Project and document tools on the hosted takeoff MCP server (/mcp): the
// bid's uploaded files as Claude sees them. Projects, search and the local
// workspace come from AppDeps (src/types.ts); the OpenTakeoff session is the
// one this MCP connection owns (src/mcp.ts builds it and hands it in).
//
// Everything Claude passes is untrusted: a project id must be a slug, and a
// file path must name a file in that project's manifest, so nothing here ever
// builds a disk path or store key from free text.
import path from "node:path";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Autosave, LoadPlanResult, Session } from "opentakeoff-core";
import type { AppDeps, FileKind, ProjectFile, ProjectId, ProjectManifest } from "./types.ts";

export type ToolReply = CallToolResult;

/** A message for Claude (bad input, missing project, ...): becomes an isError reply. */
export class UserError extends Error {}

export const ok = (payload: unknown): ToolReply => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
export const okText = (text: string): ToolReply => ({ content: [{ type: "text", text }] });
export const fail = (e: unknown): ToolReply => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
});

/** Download links stay valid this long (the phone opens them later). */
export const LINK_TTL_SEC = 24 * 60 * 60;
/** The suffix OpenTakeoff's auto-save gives its file (mcp/src/autosave.ts). */
export const AUTOSAVE_SUFFIX = " - takeoff autosave.json";
/** open_project loads at most this many PDFs into one session (memory). */
export const MAX_OPEN_FILES = 40;

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function checkProjectId(id: unknown): ProjectId {
  if (typeof id !== "string" || !PROJECT_ID.test(id)) {
    throw new UserError(`${JSON.stringify(id)} is not a project id (lowercase letters, digits and dashes). list_projects shows the ids.`);
  }
  return id;
}

/** A project path as Claude wrote it → the canonical form, or a refusal.
 * Never touches disk: the result is only ever compared with manifest paths. */
export function checkProjectPath(p: unknown): string {
  if (typeof p !== "string" || !p.trim()) throw new UserError("path must be a file path inside the project, e.g. \"Drawings/E-101.pdf\".");
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (s.includes("\0") || s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new UserError(`${JSON.stringify(p)} is not a path inside the project (no absolute paths, no "..").`);
  }
  return s.replace(/\/+/g, "/");
}

/** Where a manifest file lives in the store (layout in src/types.ts). An
 * output's path is relative to outputs/; a leading "outputs/" is tolerated. */
export function storeKeyFor(project: ProjectId, f: ProjectFile): string {
  if (f.kind === "output") return `projects/${project}/outputs/${f.path.replace(/^outputs\//, "")}`;
  return `projects/${project}/files/${f.path}`;
}

const isPdf = (f: ProjectFile) => f.contentType === "application/pdf" || /\.pdf$/i.test(f.path);
const isAutosave = (p: string) => p.endsWith(AUTOSAVE_SUFFIX);
const firstLine = (s: string) => {
  const line = (s ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line.trim();
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The per-connection state the project tools share with src/mcp.ts. */
export interface OpenState {
  /** The project open in this MCP session, null before open_project. */
  project: ProjectId | null;
  /** The auto-save open_project attached (writes into the project's outputs dir). */
  autosave: Autosave | null;
}

export interface ProjectToolsCtx {
  deps: AppDeps;
  /** This MCP connection's OpenTakeoff session. */
  session: Session;
  state: OpenState;
  /** A fresh Autosave writing into `dir` (src/mcp.ts owns the engine import and the timings). */
  makeAutosave(dir: string): Autosave;
  /** Call one of the OpenTakeoff tools on this session, unwrapped (import_takeoff). */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolReply>;
  /** How many OTHER live MCP sessions have this project open. */
  othersWithProject(project: ProjectId): number;
  /** Push the outputs of the project this session had open before (switching projects). */
  flushProject(project: ProjectId): Promise<void>;
  /** The loaded sheets changed (takeoff://sheets subscribers). */
  resourcesChanged(): void;
  linkTtlSec?: number;
}

export async function requireProject(deps: AppDeps, id: unknown): Promise<ProjectManifest> {
  const pid = checkProjectId(id);
  const m = await deps.projects.get(pid);
  if (!m) throw new UserError(`No project "${pid}". list_projects shows the ids; create_project makes a new one.`);
  return m;
}

function findFile(m: ProjectManifest, p: unknown, opts: { outputs?: boolean } = {}): ProjectFile {
  const want = checkProjectPath(p);
  const files = m.files.filter((f) => (opts.outputs ?? true) || f.kind !== "output");
  const hit = files.find((f) => f.path === want)
    ?? files.find((f) => f.kind === "output" && f.path.replace(/^outputs\//, "") === want.replace(/^outputs\//, ""))
    ?? files.find((f) => f.path.toLowerCase() === want.toLowerCase());
  if (!hit) {
    const base = path.posix.basename(want).toLowerCase();
    const near = files.filter((f) => path.posix.basename(f.path).toLowerCase() === base).map((f) => f.path).slice(0, 5);
    throw new UserError(`No file "${want}" in project ${m.id}.${near.length ? ` Did you mean: ${near.join(", ")}?` : " project_info lists its files."}`);
  }
  return hit;
}

export async function linkFor(deps: AppDeps, project: ProjectId, f: ProjectFile, ttl = LINK_TTL_SEC): Promise<string> {
  return deps.storage.presignGet(storeKeyFor(project, f), ttl, { filename: path.posix.basename(f.path) });
}

/** Links for project paths just pushed by syncOutputs (auto-save files left out). */
export async function linksForPushed(deps: AppDeps, project: ProjectId, pushed: string[], ttl = LINK_TTL_SEC): Promise<{ path: string; url: string }[]> {
  const shown = pushed.filter((p) => !isAutosave(p));
  if (!shown.length) return [];
  const m = await deps.projects.get(project);
  const out: { path: string; url: string }[] = [];
  for (const p of shown) {
    const f = m?.files.find((x) => x.path === p || (x.kind === "output" && x.path.replace(/^outputs\//, "") === p.replace(/^outputs\//, "")))
      ?? { path: p, kind: "output" as FileKind, size: 0, contentType: "", added: "", text: "none" as const };
    out.push({ path: f.path, url: await linkFor(deps, project, f, ttl) });
  }
  return out;
}

const run = (fn: (a: any) => Promise<ToolReply> | ToolReply) => async (a: any): Promise<ToolReply> => {
  try {
    return await fn(a);
  } catch (e) {
    return fail(e);
  }
};

const KINDS = ["plan", "spec", "sow", "form", "doc", "sheet", "image", "other", "output"] as const;
const projectArg = z.string().describe("Project id from list_projects, e.g. \"fa4690-25-q-0012\"");

export const PROJECT_TOOL_NAMES = [
  "list_projects", "create_project", "project_info", "set_project_notes",
  "search_documents", "read_document", "open_project", "project_outputs", "download_link",
] as const;

export function registerProjectTools(server: McpServer, ctx: ProjectToolsCtx): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;

  server.registerTool("list_projects", {
    description: "Every bid project on the server, newest activity first: id, name, the first line of its notes (solicitation number, due date), file counts by kind, the last upload and when it changed. Start here; project_info has the detail.",
    inputSchema: {},
  }, run(async () => {
    const all = await deps.projects.list();
    all.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    const projects = all.map((m) => {
      const counts: Partial<Record<FileKind, number>> = {};
      for (const f of m.files) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
      const last = [...m.uploads].sort((a, b) => b.added.localeCompare(a.added))[0];
      return {
        id: m.id,
        name: m.name,
        notes: firstLine(m.notes),
        files: counts,
        last_upload: last ? { name: last.name, status: last.status, added: last.added } : null,
        updated: m.updated,
      };
    });
    return ok({ projects, ...(projects.length ? {} : { note: "No projects yet. create_project makes one; the owner uploads the bid package on the upload page." }) });
  }));

  server.registerTool("create_project", {
    description: "Create a bid project. The id is a slug of the name. Put the solicitation number, due date and other facts in notes (set_project_notes changes them later). Files arrive through the upload page.",
    inputSchema: {
      name: z.string().min(1).max(200).describe("Project name, e.g. \"Ellsworth AFB B-1 Hangar Data Cabling\""),
      notes: z.string().max(20000).optional().describe("Solicitation number, due date, site visit, questions deadline, bonding, scope notes"),
    },
  }, run(async ({ name, notes }) => {
    const m = await deps.projects.create({ name, notes });
    return ok({ id: m.id, name: m.name, created: m.created, note: `Created. Upload the bid package for ${m.id} on the upload page (${deps.config.publicUrl}).` });
  }));

  server.registerTool("project_info", {
    description: "One project in full: notes, every file grouped by kind (pages, whether its text was extracted), each upload with its status and the entries it skipped, and the outputs the tools wrote. A file with text \"none\" has no text layer (scanned drawings): search_documents cannot see it, but view_sheet after open_project shows its pages.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    const LIMIT = 300;
    const originals = m.files.filter((f) => f.kind !== "output").sort((a, b) => a.path.localeCompare(b.path));
    const byKind: Record<string, unknown[]> = {};
    for (const f of originals.slice(0, LIMIT)) {
      (byKind[f.kind] ??= []).push({
        path: f.path,
        ...(f.pages !== undefined ? { pages: f.pages } : {}),
        text: f.text,
        ...(f.textError ? { text_error: f.textError } : {}),
        size: f.size,
        ...(f.fromArchive ? { from: f.fromArchive } : {}),
      });
    }
    const outputs = m.files.filter((f) => f.kind === "output").map((f) => ({ path: f.path, size: f.size, added: f.added }));
    const scanned = originals.filter((f) => f.text === "none" && isPdf(f)).length;
    return ok({
      id: m.id,
      name: m.name,
      notes: m.notes,
      created: m.created,
      updated: m.updated,
      files: byKind,
      ...(originals.length > LIMIT ? { files_truncated: `${originals.length - LIMIT} more files not listed; search_documents with path narrows to a folder` } : {}),
      uploads: m.uploads.map((u) => ({
        upload_id: u.uploadId, name: u.name, status: u.status, ...(u.error ? { error: u.error } : {}),
        added: u.added, files: u.files.length, skipped: u.skipped,
      })),
      outputs,
      ...(scanned ? { note: `${plural(scanned, "PDF")} have no text layer (scanned). They cannot be searched; open_project {files: [...]} then view_sheet shows their pages.` } : {}),
    });
  }));

  server.registerTool("set_project_notes", {
    description: "Replace the project's notes. Keep the facts a bid turns on here so every later conversation sees them: solicitation number, due date and time, site visit, questions deadline, bonding, wage determination, scope inclusions and exclusions, open questions. Read project_info first and keep what is still true.",
    inputSchema: {
      project: projectArg,
      notes: z.string().max(20000).describe("The complete new notes (replaces the old)"),
    },
  }, run(async ({ project, notes }) => {
    const m0 = await requireProject(deps, project);
    const m = await deps.projects.update(m0.id, (mm) => { mm.notes = notes; });
    return ok({ id: m.id, notes: m.notes, updated: m.updated });
  }));

  server.registerTool("search_documents", {
    description: "Search the project's extracted text page by page (case-insensitive; every word must appear on the page). Read the SOW and specs this way before measuring: scope, quantities, cable types, testing, submittals, Davis-Bacon, bonding. Returns path, kind and page per hit with a snippet; read_document reads the page. Scanned PDFs have no text and never match.",
    inputSchema: {
      project: projectArg,
      query: z.string().min(1).max(300).describe("Words that must all be on the page, e.g. \"CAT6A plenum\""),
      kinds: z.array(z.enum(KINDS)).optional().describe("Only these file kinds, e.g. [\"spec\", \"sow\"]"),
      path: z.string().optional().describe("Only this file, or files under this folder"),
      limit: z.number().int().min(1).max(100).optional().describe("Most hits to return (default 20)"),
    },
  }, run(async ({ project, query, kinds, path: p, limit }) => {
    const m = await requireProject(deps, project);
    const scope = p !== undefined ? checkProjectPath(p) : undefined;
    const hits = await deps.search.search(m.id, query, { kinds, path: scope, limit: limit ?? 20 });
    const scanned = m.files.filter((f) => f.text === "none" && isPdf(f) && (!scope || f.path === scope || f.path.startsWith(`${scope.replace(/\/$/, "")}/`)));
    const pending = m.files.filter((f) => f.text === "pending").length;
    const notes: string[] = [];
    if (!hits.length) notes.push("No page matches every word. Try fewer or different words.");
    if (scanned.length) notes.push(`${plural(scanned.length, "PDF")} have no text layer and cannot be searched (${scanned.slice(0, 5).map((f) => f.path).join(", ")}${scanned.length > 5 ? ", ..." : ""}); open_project {files: [...]} then view_sheet shows their pages.`);
    if (pending) notes.push(`${plural(pending, "file")} are still being processed; search again shortly.`);
    return ok({ hits, ...(notes.length ? { note: notes.join(" ") } : {}) });
  }));

  server.registerTool("read_document", {
    description: "Read the extracted text of one project file, a page range at a time (default: from page 1 up to max_chars). Use it for the SOW, specs, forms and schedules; search_documents finds the pages. A scanned PDF has no text: open_project {files: [path]} then view_sheet shows its pages.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("File path as project_info or a search hit gives it"),
      from_page: z.number().int().min(1).optional(),
      to_page: z.number().int().min(1).optional(),
      max_chars: z.number().int().min(500).max(100000).optional().describe("Most characters to return (default 20000)"),
    },
  }, run(async ({ project, path: p, from_page, to_page, max_chars }) => {
    const m = await requireProject(deps, project);
    const f = findFile(m, p);
    if (f.text === "pending") return okText(`${f.path} is still being processed; try again shortly.`);
    if (f.text === "error") return okText(`Text extraction failed for ${f.path}${f.textError ? ` (${f.textError})` : ""}.${isPdf(f) ? " open_project {files: [path]} then view_sheet shows its pages." : ""}`);
    if (from_page && to_page && to_page < from_page) throw new UserError("to_page is before from_page.");
    const res = f.text === "none" ? null : await deps.search.read(m.id, f.path, { fromPage: from_page, toPage: to_page, maxChars: max_chars ?? 20000 });
    if (!res) {
      return okText(isPdf(f)
        ? `${f.path} has no text layer (a scanned drawing or image PDF${f.pages ? `, ${plural(f.pages, "page")}` : ""}). It cannot be read as text: open_project {project: "${m.id}", files: ["${f.path}"]} loads it, then view_sheet shows each page.`
        : `${f.path} (${f.kind}, ${f.contentType || "unknown type"}) has no readable text.`);
    }
    const from = from_page ?? 1;
    const to = Math.min(to_page ?? res.pages, res.pages);
    const head = `${f.path} (${f.kind}) — pages ${from}–${to} of ${res.pages}`;
    const tail = res.truncated ? `\n\n[truncated at ${max_chars ?? 20000} characters: call read_document again with a later from_page or a larger max_chars]` : "";
    return okText(`${head}\n\n${res.text}${tail}`);
  }));

  server.registerTool("open_project", {
    description: "Open a project's drawings in this takeoff session: use it instead of load_plan for uploaded projects. Default: every plan PDF in the project, merged into one working set; files picks specific PDFs (a spec or SOW too, to view_sheet a page). Auto-save then writes into the project, and the project's earlier takeoff auto-save is restored unless import_autosave is false. Replaces whatever this session had loaded. Exports (export_marked_pdf, export_report, export_estimate, export_proposal, ...) write into the project and come back with download links.",
    inputSchema: {
      project: projectArg,
      files: z.array(z.string()).min(1).max(MAX_OPEN_FILES).optional().describe("PDF paths in the project to open (default: every file of kind plan)"),
      import_autosave: z.boolean().default(true).describe("Restore the project's earlier takeoff auto-save when there is one (default true)"),
    },
  }, run(async ({ project, files, import_autosave }) => {
    const m = await requireProject(deps, project);
    let targets: ProjectFile[];
    if (files?.length) {
      targets = [];
      for (const p of files) {
        const f = findFile(m, p, { outputs: false });
        if (!isPdf(f)) throw new UserError(`${f.path} is not a PDF (${f.kind}); read_document reads its text.`);
        if (!targets.includes(f)) targets.push(f);
      }
    } else {
      targets = m.files.filter((f) => f.kind === "plan" && isPdf(f)).sort((a, b) => a.path.localeCompare(b.path));
      if (!targets.length) {
        const pdfs = m.files.filter((f) => f.kind !== "output" && isPdf(f)).map((f) => `${f.path} (${f.kind})`).slice(0, 20);
        throw new UserError(`Project ${m.id} has no plan PDFs.${pdfs.length ? ` Its PDFs: ${pdfs.join(", ")}. Pass files: [...] to open some.` : " Upload the drawings first."}`);
      }
      if (targets.length > MAX_OPEN_FILES) {
        throw new UserError(`Project ${m.id} has ${targets.length} plan PDFs; one session opens at most ${MAX_OPEN_FILES}. Pass files: [...] with the sheets this takeoff needs (project_info lists them).`);
      }
    }

    // the session's previous project: its last change lands and is pushed first
    const prev = ctx.state.project;
    if (ctx.state.autosave) await ctx.state.autosave.flush();
    if (prev) await ctx.flushProject(prev);

    const locals: { f: ProjectFile; local: string }[] = [];
    for (const f of targets) locals.push({ f, local: await deps.workspace.ensureFile(m.id, f.path) });

    // auto-save into the project's outputs dir, file named after the primary plan
    const outDir = deps.workspace.outputsDir(m.id);
    await mkdir(outDir, { recursive: true });
    const autosaveName = `${path.basename(locals[0].local).replace(/\.pdf$/i, "")}${AUTOSAVE_SUFFIX}`;
    const autosaveLocal = path.join(outDir, autosaveName);
    let restoredFromStore = false;
    if (!(await exists(autosaveLocal))) {
      const stored = m.files.filter((f) => f.kind === "output" && path.posix.basename(f.path) === autosaveName)
        .sort((a, b) => Number(b.path.replace(/^outputs\//, "") === autosaveName) - Number(a.path.replace(/^outputs\//, "") === autosaveName))[0];
      if (stored) {
        const got = await deps.workspace.ensureFile(m.id, stored.path);
        if (path.resolve(got) !== path.resolve(autosaveLocal)) await copyFile(got, autosaveLocal);
        restoredFromStore = true;
      }
    }
    const autosave = ctx.makeAutosave(outDir).attach(ctx.session);
    ctx.state.autosave = autosave;
    ctx.state.project = null;

    let loaded: LoadPlanResult = await ctx.session.loadPlan(locals[0].local);
    const found = loaded.autosave?.found ?? null;
    const skipped: { path: string; reason: string }[] = [];
    for (const { f, local } of locals.slice(1)) {
      try {
        loaded = await ctx.session.loadPlan(local, { merge: true });
      } catch (e) {
        skipped.push({ path: f.path, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    ctx.resourcesChanged();
    ctx.state.project = m.id;

    let restored: Record<string, unknown> | false = false;
    let restoreError: string | undefined;
    if (found && import_autosave !== false) {
      const r = await ctx.callTool("import_takeoff", { path: found.path });
      if (r.isError) {
        restoreError = textOf(r);
      } else {
        const sc = (r.structuredContent ?? {}) as Record<string, unknown>;
        restored = { saved_at: found.saved_at, shapes: found.shapes, conditions: found.conditions, cable_runs: found.cable_runs, ...(sc.shapes_added !== undefined ? { shapes_added: sc.shapes_added } : {}) };
      }
    }

    const others = ctx.othersWithProject(m.id);
    const notes: string[] = [
      `Opened ${plural(locals.length - skipped.length, "file")} of ${m.id} (${plural(loaded.sheets.length, "sheet")}). set_scale each sheet you measure.`,
    ];
    if (restored) notes.push(`Restored the earlier takeoff from the project's auto-save (saved ${found?.saved_at ?? "at an unknown time"}).`);
    else if (found && import_autosave === false) notes.push(`An earlier auto-save exists (saved ${found.saved_at ?? "?"}: ${plural(found.shapes, "shape")}) and was NOT imported; changing anything moves it aside, so it is kept.`);
    else if (restoreError) notes.push(`The earlier auto-save could not be restored: ${restoreError}`);
    else notes.push("No earlier takeoff for these drawings; starting fresh.");
    if (loaded.autosave?.error) notes.push(`Auto-save is NOT writing: ${loaded.autosave.error}`);
    if (others) notes.push(`WARNING: ${plural(others, "other conversation")} also ${others === 1 ? "has" : "have"} this project open. Both auto-save to the same file and the last save wins; keep one conversation working on a takeoff at a time.`);
    notes.push("Exports (export_marked_pdf, export_report with xlsx, export_estimate, export_proposal, export_takeoff with a path) write into the project and the reply carries a download link the user can open on the phone; project_outputs lists them all.");

    return ok({
      project: m.id,
      files: locals.filter(({ f }) => !skipped.some((s) => s.path === f.path)).map(({ f }) => f.path),
      sheets: loaded.sheets.map((s) => ({ sheet: s.sheet, ...(s.sheet_number ? { sheet_number: s.sheet_number } : {}), ...(s.detected_scale ? { detected_scale: s.detected_scale } : {}) })),
      ...(skipped.length ? { skipped } : {}),
      restored,
      ...(restoredFromStore && !restored ? { autosave_downloaded: true } : {}),
      autosave: `outputs/${autosaveName}`,
      note: notes.join(" "),
    });
  }));

  server.registerTool("project_outputs", {
    description: "What the tools wrote into the project (marked set, report, workbook, estimate, proposal, auto-save), each with a download link valid 24 hours. Give the user the links; they open on the phone.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    const outs = m.files.filter((f) => f.kind === "output").sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
    const outputs = [];
    for (const f of outs) outputs.push({ path: f.path, size: f.size, added: f.added, url: await linkFor(deps, m.id, f, ttl) });
    return ok({ project: m.id, outputs, ...(outputs.length ? { expires_in_hours: Math.round(ttl / 3600) } : { note: "No outputs yet. open_project, run the takeoff, then export_marked_pdf and export_report." }) });
  }));

  server.registerTool("download_link", {
    description: "A download link (valid 24 hours) for one project file or output. Give it to the user; it opens on the phone.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("File or output path as project_info or project_outputs gives it"),
    },
  }, run(async ({ project, path: p }) => {
    const m = await requireProject(deps, project);
    const f = findFile(m, p);
    return ok({ path: f.path, kind: f.kind, size: f.size, url: await linkFor(deps, m.id, f, ttl), expires_in_hours: Math.round(ttl / 3600) });
  }));
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export function textOf(r: ToolReply): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
}

/** The server instructions' project section (src/mcp.ts appends it to OpenTakeoff's). */
export const PROJECT_INSTRUCTIONS = [
  "HOSTED PROJECTS: this server holds the owner's bid projects (the solicitation, SOW, specs, drawings and forms uploaded from the phone).",
  "Start with list_projects, then project_info on the bid at hand. Keep the facts the bid turns on (solicitation number, due date, site visit, questions deadline, bonding, scope) in set_project_notes.",
  "Read the SOW and specs with search_documents and read_document BEFORE measuring: scope, cable types, testing, labeling and submittals decide the conditions.",
  "For uploaded drawings call open_project, not load_plan: it fetches the plan PDFs, points auto-save into the project and restores earlier work. Scanned PDFs have no text; view_sheet after open_project shows them.",
  "Exports write into the project and their replies carry download links; give the user those links (they open on the phone). project_outputs lists every output with a fresh link.",
].join("\n");
