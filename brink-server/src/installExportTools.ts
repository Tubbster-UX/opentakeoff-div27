// export_install_package: the install drawings for the crews (11x17 PDF) and
// the pull schedule for label printing (CSV + XLSX), from the latest install
// design. DRAFT until the owner approves it on the project page; the approval
// route re-makes the files as ISSUED FOR CONSTRUCTION (rerenderInstallApproved).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps, ProjectId, ProjectManifest } from "./types.ts";
import type { InstallDesign } from "./installTypes.ts";
import { LINK_TTL_SEC, UserError, fail, ok, requireProject, type ToolReply } from "./projectTools.ts";
import { readInstallDesign } from "./installApproval.ts";
import { renderInstallPackage, installApproved } from "./install/render.ts";
import { renderPullScheduleCsv, renderPullScheduleXlsx } from "./install/schedule.ts";
import { StoreSettings } from "./settings.ts";
import { fileStem } from "./bid/format.ts";

export const INSTALL_EXPORT_TOOL_NAMES = ["export_install_package"] as const;
const DIR = "install";
const storeKey = (project: ProjectId, name: string) => `projects/${project}/outputs/${DIR}/${name}`;

/** "T-101 Telecom Plan.pdf#2" → the project file with that name and the 0-based page. */
function planFileFor(m: ProjectManifest, sheet: string): { path: string; pageIndex: number } | null {
  const i = sheet.lastIndexOf("#");
  const numbered = i > 0 && /^\d+$/.test(sheet.slice(i + 1));
  const file = numbered ? sheet.slice(0, i) : sheet;
  const page = numbered ? parseInt(sheet.slice(i + 1), 10) : 1;
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const hits = m.files.filter((f) => f.kind !== "output" && /\.pdf$/i.test(f.path) && base(f.path) === file);
  const pick = hits.find((f) => f.kind === "plan") ?? hits[0];
  return pick ? { path: pick.path, pageIndex: page - 1 } : null;
}

function sheetName(sheet: string): string {
  const i = sheet.lastIndexOf("#");
  const numbered = i > 0 && /^\d+$/.test(sheet.slice(i + 1));
  const file = (numbered ? sheet.slice(0, i) : sheet).replace(/\.pdf$/i, "");
  return numbered ? `${file} p.${sheet.slice(i + 1)}` : file;
}

const fileName = (m: ProjectManifest, d: InstallDesign, what: string, ext: string) =>
  `${fileStem(m.name)} - ${what} r${d.revision}${installApproved(d) ? "" : " DRAFT"}.${ext}`;

async function build(deps: AppDeps, m: ProjectManifest, d: InstallDesign) {
  const settings = await new StoreSettings(deps.storage).get();
  const company = settings.company;
  let logo: Uint8Array | undefined;
  if (company.logoKey) logo = (await deps.storage.getBytes(company.logoKey).catch(() => null)) ?? undefined;
  const sheets = [...new Set(d.devices.map((x) => x.sheet))];
  const sheetNames = Object.fromEntries(sheets.map((s) => [s, sheetName(s)]));
  const planPage = async (sheet: string) => {
    const f = planFileFor(m, sheet);
    if (!f) return null;
    try {
      const local = await deps.workspace.ensureFile(m.id, f.path);
      return { pdf: new Uint8Array(await readFile(local)), pageIndex: f.pageIndex };
    } catch {
      return null;
    }
  };
  const { pdf, sheets: index } = await renderInstallPackage({ design: d, project: m, company, logo, planPage, sheetNames });
  return {
    index,
    files: [
      { name: fileName(m, d, "install drawings", "pdf"), bytes: pdf },
      { name: fileName(m, d, "pull schedule", "csv"), bytes: new TextEncoder().encode(renderPullScheduleCsv(d)) },
      { name: fileName(m, d, "pull schedule", "xlsx"), bytes: await renderPullScheduleXlsx(d, m) },
    ],
  };
}

async function publish(deps: AppDeps, project: ProjectId, files: { name: string; bytes: Uint8Array }[], ttl: number) {
  const dir = path.join(deps.workspace.outputsDir(project), DIR);
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(path.join(dir, f.name), f.bytes);
  await deps.workspace.syncOutputs(project);
  const out: { path: string; url: string }[] = [];
  for (const f of files) out.push({ path: `outputs/${DIR}/${f.name}`, url: await deps.storage.presignGet(storeKey(project, f.name), ttl, { filename: f.name }) });
  return out;
}

async function loadDesign(deps: AppDeps, project: ProjectId): Promise<InstallDesign> {
  const d = await readInstallDesign(deps, project);
  if (!d) throw new UserError(`Project ${project} has no install design yet. Run install_draft first.`);
  return d;
}

export function registerInstallExportTools(server: McpServer, ctx: { deps: AppDeps; linkTtlSec?: number }): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;
  server.registerTool("export_install_package", {
    description: [
      "Write the install package for the crews from the latest install design: 11x17 drawings (cover and index, device plans with every tag and a legend, pull-label plans colored by rack, pull schedule by room, rack elevations with power and heat, signal flow per rack and per room, mounting details) plus the pull schedule as CSV (label printer) and XLSX.",
      "Stamped DRAFT until the owner approves the install design on the project page; then the files are re-made as ISSUED FOR CONSTRUCTION. Error-level issues (install_check) do not stop a draft export but block the owner's approval: name them to the user.",
      "Returns download links valid 24 hours; give them to the user.",
    ].join(" "),
    inputSchema: { project: z.string().describe("Project id from list_projects") },
  }, async ({ project }): Promise<ToolReply> => {
    try {
      const m = await requireProject(deps, project);
      const d = await loadDesign(deps, m.id);
      const { index, files } = await build(deps, m, d);
      const links = await publish(deps, m.id, files, ttl);
      const errors = d.issues.filter((i) => i.severity === "error");
      return ok({
        project: m.id,
        revision: d.revision,
        status: installApproved(d) ? `ISSUED FOR CONSTRUCTION r${d.revision}` : `DRAFT r${d.revision} — the owner approves on the project page`,
        sheets: index.map((s) => `${s.number} ${s.title}`),
        files: links,
        ...(errors.length ? { blocking_issues: errors.slice(0, 20).map((i) => i.message) } : {}),
        expires_in_hours: Math.round(ttl / 3600),
      });
    } catch (e) {
      return fail(e);
    }
  });
}

/** After the owner's approval (src/installApproval.ts): the package as ISSUED FOR CONSTRUCTION. Never called by a tool. */
export async function rerenderInstallApproved(deps: AppDeps, project: ProjectId, ttl = LINK_TTL_SEC): Promise<string[]> {
  const m = await requireProject(deps, project);
  const d = await loadDesign(deps, m.id);
  if (!installApproved(d)) throw new UserError(`Install revision ${d.revision} of ${project} is not approved.`);
  const { files } = await build(deps, m, d);
  return (await publish(deps, m.id, files, ttl)).map((f) => f.path);
}
