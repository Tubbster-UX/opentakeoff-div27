// The owner's review and approval of the install design, and the project
// phase (the phone project page). Mirrors src/approval.ts: these routes sit
// behind the owner's cookie and the CSRF check (http.ts mounts them on the
// /api router). No MCP tool reaches them: Claude drafts, the owner approves
// for construction. Any tool change writes a new draft revision, so an
// approval never carries over to a design the owner has not seen.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { InstallDesign } from "./installTypes.ts";
import type { AppDeps, ProjectManifest } from "./types.ts";
import { assertProjectId } from "./projects.ts";
import { readBid } from "./approval.ts";
import { designSummary, issueBrief, rackBrief } from "./install/summary.ts";

export const INSTALL_PATH = "outputs/install/design.json";
export const installKey = (project: string) => `projects/${project}/${INSTALL_PATH}`;
export const PHASES = ["bid", "install", "closeout"] as const;
export type Phase = (typeof PHASES)[number];

export interface InstallHooks {
  /** Re-render the install package for an approved revision (drops DRAFT); returns the output paths written. */
  onApproved?: (project: string, design: InstallDesign) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function readInstallDesign(deps: AppDeps, project: string): Promise<InstallDesign | null> {
  const bytes = await deps.storage.getBytes(installKey(project));
  if (!bytes) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as InstallDesign;
}

/** Store copy, the local mirror and the manifest entry, in step. */
export async function writeInstallDesign(deps: AppDeps, project: string, design: InstallDesign): Promise<void> {
  const body = Buffer.from(JSON.stringify(design, null, 1) + "\n", "utf8");
  await deps.storage.put(installKey(project), body, { contentType: "application/json" });
  const local = path.join(deps.workspace.outputsDir(project), "install", "design.json");
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  await deps.projects.update(project, (m) => {
    const f = m.files.find((x) => x.kind === "output" && (x.path === INSTALL_PATH || x.path === "install/design.json"));
    if (f) {
      f.size = body.length;
      f.sha256 = sha256;
    }
  });
}

/** What the phone page shows: the summary, every issue, and the racks. */
export function installForPage(design: InstallDesign) {
  return { ...designSummary(design), issues: design.issues, issueCounts: issueBrief(design.issues, 0), racks: rackBrief(design) };
}

export function installRoutes(deps: AppDeps, hooks: InstallHooks = {}): express.Router {
  const r = express.Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((e) => {
      if (e instanceof RouteError) res.status(e.status).json({ error: e.code, message: e.message });
      else next(e);
    });
  const project = async (req: Request): Promise<ProjectManifest> => {
    const id = String(req.params.id);
    try {
      assertProjectId(id);
    } catch {
      throw new RouteError(404, "not_found", "No such project.");
    }
    const m = await deps.projects.get(id);
    if (!m) throw new RouteError(404, "not_found", "No such project.");
    return m;
  };
  const revisionOf = (req: Request) => {
    const n = (req.body as { revision?: unknown } | undefined)?.revision;
    if (!Number.isInteger(n) || (n as number) < 1) throw new RouteError(400, "bad_request", "Send the revision you reviewed: {\"revision\": n}.");
    return n as number;
  };

  r.get("/projects/:id/install", wrap(async (req, res) => {
    const m = await project(req);
    const design = await readInstallDesign(deps, m.id);
    if (!design) throw new RouteError(404, "no_install_design", (m.phase ?? "bid") === "install" ? "No install design yet. Ask Claude to draft it (install_draft)." : "No install design yet. Start the install phase once the bid is approved, then ask Claude to draft it.");
    res.json({ phase: m.phase ?? "bid", design: installForPage(design) });
  }));

  r.post("/projects/:id/install/approve", wrap(async (req, res) => {
    const m = await project(req);
    const revision = revisionOf(req);
    const design = await readInstallDesign(deps, m.id);
    if (!design) throw new RouteError(404, "no_install_design", "No install design to approve.");
    if (design.revision !== revision) throw new RouteError(409, "stale_revision", `Revision ${revision} is no longer current: Claude changed it to revision ${design.revision}. Review that one first.`);
    const errors = design.issues.filter((i) => i.severity === "error");
    if (errors.length) {
      throw new RouteError(409, "has_errors", `Revision ${revision} has ${errors.length} error${errors.length === 1 ? "" : "s"} (first: ${errors[0].message}). Ask Claude to fix them; warnings do not block approval.`);
    }
    if (design.status !== "approved") {
      design.status = "approved";
      design.approved = { at: new Date().toISOString(), revision };
      await writeInstallDesign(deps, m.id, design);
    }
    let rerendered: string[] = [];
    let rerenderError: string | undefined;
    if (hooks.onApproved) {
      try {
        rerendered = await hooks.onApproved(m.id, design);
      } catch (e) {
        rerenderError = `Approved, but the install package could not be re-made: ${(e as Error).message}. Ask Claude to build it again.`;
      }
    }
    res.json({ design: installForPage(design), rerendered, ...(rerenderError ? { warning: rerenderError } : {}) });
  }));

  r.post("/projects/:id/install/withdraw", wrap(async (req, res) => {
    const m = await project(req);
    const revision = revisionOf(req);
    const design = await readInstallDesign(deps, m.id);
    if (!design) throw new RouteError(404, "no_install_design", "No install design.");
    if (design.revision !== revision) throw new RouteError(409, "stale_revision", `Revision ${revision} is no longer current.`);
    if (design.status === "approved") {
      design.status = "draft";
      delete design.approved;
      await writeInstallDesign(deps, m.id, design);
    }
    res.json({ design: installForPage(design) });
  }));

  r.post("/projects/:id/phase", wrap(async (req, res) => {
    const m = await project(req);
    const phase = (req.body as { phase?: unknown } | undefined)?.phase;
    if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) throw new RouteError(400, "bad_request", "Send {\"phase\": \"bid\" | \"install\" | \"closeout\"}.");
    if (phase === "install" && (m.phase ?? "bid") !== "install") {
      const bid = await readBid(deps, m.id);
      if (!bid || bid.status !== "approved" || !bid.approved) {
        throw new RouteError(409, "bid_not_approved", `The install phase starts from an approved bid: ${bid ? `bid revision ${bid.revision} is a draft. Approve it first` : "this project has no bid yet. Ask Claude to price it, then approve it"}.`);
      }
    }
    const saved = await deps.projects.update(m.id, (x) => {
      x.phase = phase as Phase;
    });
    res.json({ project: saved.id, phase: saved.phase ?? "bid" });
  }));

  return r;
}
