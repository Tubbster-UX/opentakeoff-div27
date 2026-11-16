// The owner's review and approval of a priced bid (the phone project page).
//
// Only these routes approve, and they sit behind the owner's cookie and the
// CSRF check (mounted on the /api router in http.ts). No MCP tool can reach
// them: Claude prices and drafts, the owner approves. Re-pricing writes a new
// revision with status "draft", so an approval never carries over to numbers
// the owner has not seen.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { BidDraft } from "./bidTypes.ts";
import { assertProjectId } from "./projects.ts";
import type { AppDeps } from "./types.ts";

export const BID_PATH = "outputs/bid/bid.json";
export const bidKey = (project: string) => `projects/${project}/${BID_PATH}`;

export interface BidHooks {
  /** Re-render the bid documents for an approved revision (drops DRAFT); returns the output paths written. */
  onApproved?: (project: string, bid: BidDraft) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function readBid(deps: AppDeps, project: string): Promise<BidDraft | null> {
  const bytes = await deps.storage.getBytes(bidKey(project));
  if (!bytes) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as BidDraft;
}

async function writeBid(deps: AppDeps, project: string, bid: BidDraft): Promise<void> {
  const body = Buffer.from(JSON.stringify(bid, null, 1) + "\n", "utf8");
  await deps.storage.put(bidKey(project), body, { contentType: "application/json" });
  // Keep the local mirror in step so nothing re-pushes the old draft over it.
  const local = path.join(deps.workspace.outputsDir(project), "bid", "bid.json");
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  await deps.projects.update(project, (m) => {
    const f = m.files.find((x) => x.kind === "output" && (x.path === BID_PATH || x.path === "bid/bid.json"));
    if (f) {
      f.size = body.length;
      (f as { sha256?: string }).sha256 = sha256;
    }
  });
}

/** The bid as the phone page shows it: everything but the settings snapshot (rates and company stay server-side). */
function forPage(bid: BidDraft) {
  const { settings: _settings, ...rest } = bid;
  return rest;
}

export function bidRoutes(deps: AppDeps, hooks: BidHooks = {}): express.Router {
  const r = express.Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((e) => {
      if (e instanceof RouteError) res.status(e.status).json({ error: e.code, message: e.message });
      else next(e);
    });
  const project = async (req: Request) => {
    const id = String(req.params.id);
    try {
      assertProjectId(id);
    } catch {
      throw new RouteError(404, "not_found", "No such project.");
    }
    if (!(await deps.projects.get(id))) throw new RouteError(404, "not_found", "No such project.");
    return id;
  };
  const revisionOf = (req: Request) => {
    const n = (req.body as { revision?: unknown } | undefined)?.revision;
    if (!Number.isInteger(n) || (n as number) < 1) throw new RouteError(400, "bad_request", "Send the revision you reviewed: {\"revision\": n}.");
    return n as number;
  };

  r.get("/projects/:id/bid", wrap(async (req, res) => {
    const id = await project(req);
    const bid = await readBid(deps, id);
    if (!bid) throw new RouteError(404, "no_bid", "No bid yet. Ask Claude to price this project.");
    res.json(forPage(bid));
  }));

  r.post("/projects/:id/bid/approve", wrap(async (req, res) => {
    const id = await project(req);
    const revision = revisionOf(req);
    const bid = await readBid(deps, id);
    if (!bid) throw new RouteError(404, "no_bid", "No bid to approve.");
    if (bid.revision !== revision) throw new RouteError(409, "stale_revision", `Revision ${revision} is no longer current: Claude re-priced it as revision ${bid.revision}. Review that one first.`);
    if (bid.totals.baseBid == null || bid.gaps.length > 0) {
      throw new RouteError(409, "incomplete", `Revision ${revision} is not complete (${bid.gaps.length} unpriced item${bid.gaps.length === 1 ? "" : "s"}${bid.totals.baseBid == null ? ", no base bid" : ""}). Ask Claude to fill the gaps and re-price.`);
    }
    if (bid.status !== "approved") {
      bid.status = "approved";
      bid.approved = { at: new Date().toISOString(), revision };
      await writeBid(deps, id, bid);
    }
    let rerendered: string[] = [];
    let rerenderError: string | undefined;
    if (hooks.onApproved) {
      try {
        rerendered = await hooks.onApproved(id, bid);
      } catch (e) {
        rerenderError = `Approved, but the final documents could not be re-made: ${(e as Error).message}. Ask Claude to export them again.`;
      }
    }
    res.json({ bid: forPage(bid), rerendered, ...(rerenderError ? { warning: rerenderError } : {}) });
  }));

  r.post("/projects/:id/bid/withdraw", wrap(async (req, res) => {
    const id = await project(req);
    const revision = revisionOf(req);
    const bid = await readBid(deps, id);
    if (!bid) throw new RouteError(404, "no_bid", "No bid.");
    if (bid.revision !== revision) throw new RouteError(409, "stale_revision", `Revision ${revision} is no longer current.`);
    if (bid.status === "approved") {
      bid.status = "draft";
      delete bid.approved;
      await writeBid(deps, id, bid);
    }
    res.json({ bid: forPage(bid) });
  }));

  return r;
}
