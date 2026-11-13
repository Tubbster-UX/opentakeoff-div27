// The Portal push against the system of record: read the project's current
// import and the catalog, build the plan, record the attempt in
// brink_portal_pushes, and (only with live + the plan-hash confirmation)
// execute it. Dry run is the default and makes no network request.
import type { Db, Queryable } from "../db/db.js";
import { currentImport, listProjects, loadBomLines, loadCatalog, loadIssues } from "../db/repository.js";
import { PortalClient, credentialsFromEnv, redact, type FetchLike } from "./client.js";
import { PushAborted, executeLivePush, type LiveResult } from "./execute.js";
import { buildPushPlan, requestPlan, type PlanError, type PlannedRequest, type PushPlan } from "./plan.js";
import { DEFAULT_BASE_URL, OBSERVED_APP_VERSION, type PortalConfig } from "./requests.js";

export interface PushOptions {
  project: string;
  live?: boolean;
  /** Live only: must equal the plan hash the dry run printed. */
  confirm?: string;
  /** Live only: allow a push when this project already has a live push on record. */
  newProposal?: boolean;
  excludeCable?: boolean;
  proposalName?: string;
  areaName?: string;
  appVersion?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => number;
}

export type PushOutcome = "planned" | "aborted" | "refused" | "succeeded" | "failed";

export interface PushReport {
  outcome: PushOutcome;
  pushId: string | null;
  plan: PushPlan;
  requests: PlannedRequest[];
  /** Why a live push was refused before it started (confirmation, prior push, credentials). */
  refusal?: string;
  result?: Partial<LiveResult>;
  error?: string;
}

export function portalConfig(o: Pick<PushOptions, "appVersion" | "baseUrl" | "env">): PortalConfig {
  const env = o.env ?? process.env;
  return { baseUrl: o.baseUrl ?? env.PORTAL_BASE_URL ?? DEFAULT_BASE_URL, appVersion: o.appVersion ?? env.PORTAL_APP_VERSION ?? OBSERVED_APP_VERSION };
}

interface PushRow { id: string; dry_run: boolean; status: string; portal_proposal_id: number | string | null; created_at: string }

export async function listPushes(db: Queryable, projectId: string): Promise<PushRow[]> {
  return (await db.query<PushRow>(
    "select id, dry_run, status, portal_proposal_id, created_at::text from brink_portal_pushes where project_id = $1 order by created_at", [projectId],
  )).rows;
}

async function record(db: Queryable, v: { projectId: string; importId: string; dryRun: boolean; status: string; plan: PushPlan; requests: PlannedRequest[]; errors: PlanError[]; appVersion: string; error?: string }): Promise<string> {
  const done = v.status !== "started";
  return (await db.query<{ id: string }>(
    `insert into brink_portal_pushes (project_id, import_id, dry_run, status, plan_hash, plan, errors, app_version, error, finished_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, ${done ? "now()" : "null"}) returning id`,
    [v.projectId, v.importId, v.dryRun, v.status, v.plan.hash, JSON.stringify({ ...v.plan, requests: v.requests }), JSON.stringify(v.errors), v.appVersion, v.error ?? null],
  )).rows[0].id;
}

export async function portalPush(db: Db, o: PushOptions): Promise<PushReport> {
  const cur = await currentImport(db, o.project);
  if (!cur) {
    const names = (await listProjects(db)).map((p) => p.project);
    throw new Error(`no project named ${JSON.stringify(o.project)}${names.length ? `; projects: ${names.join(", ")}` : ""}`);
  }
  const env = o.env ?? process.env;
  const cfg = portalConfig(o);
  const plan = buildPushPlan({
    project: cur.project, importId: cur.importId, lines: await loadBomLines(db, cur.importId), issues: await loadIssues(db, cur.importId),
    catalog: await loadCatalog(db), excludeCable: o.excludeCable, proposalName: o.proposalName, areaName: o.areaName,
  });
  const creds = o.live ? credentialsFromEnv(env) : null;
  const requests = requestPlan(plan, cfg, creds && "refreshToken" in creds ? "refresh_token" : "password");
  const base = { projectId: cur.projectId, importId: cur.importId, dryRun: !o.live, plan, requests, appVersion: cfg.appVersion };

  if (plan.errors.length) {
    const pushId = await record(db, { ...base, status: "aborted", errors: plan.errors });
    return { outcome: "aborted", pushId, plan, requests };
  }
  if (!o.live) {
    const pushId = await record(db, { ...base, status: "planned", errors: [] });
    return { outcome: "planned", pushId, plan, requests };
  }

  // live: every refusal below happens before any request to Portal
  const refuse = async (why: string): Promise<PushReport> => {
    const pushId = await record(db, { ...base, status: "aborted", errors: [], error: why });
    return { outcome: "refused", pushId, plan, requests, refusal: why };
  };
  if (o.confirm !== plan.hash) {
    return refuse(o.confirm ? `--confirm ${o.confirm} does not match this plan (hash ${plan.hash}); the plan changed since it was reviewed. Re-run the dry run and review it.` : `live mode needs --confirm ${plan.hash} (the hash of the plan you reviewed in the dry run)`);
  }
  if (!creds) return refuse("no Portal credentials: set PORTAL_REFRESH_TOKEN, or PORTAL_USERNAME and PORTAL_PASSWORD, in the environment");
  if (!o.fetch && typeof fetch !== "function") return refuse("no fetch available");

  // claim the push under a row lock so two runs cannot both create a proposal
  const claim = await db.transaction(async (tx) => {
    await tx.query("select id from brink_projects where id = $1 for update", [cur.projectId]);
    const prior = (await listPushes(tx, cur.projectId)).filter((p) => !p.dry_run && p.status !== "aborted");
    if (prior.length && !o.newProposal) {
      return { prior: prior.map((p) => `${p.status} push ${p.id} at ${p.created_at}${p.portal_proposal_id != null ? ` (Portal proposal ${p.portal_proposal_id})` : ""}`) };
    }
    return { pushId: await record(tx, { ...base, status: "started", errors: [] }) };
  });
  if ("prior" in claim) {
    return refuse(`this project already has a live Portal push: ${claim.prior!.join("; ")}. Pass --new-proposal only if a second Draft proposal is really wanted.`);
  }
  const pushId = claim.pushId!;

  const client = new PortalClient(cfg, creds, { fetch: o.fetch ?? (fetch as unknown as FetchLike), now: o.now });
  const result: Partial<LiveResult> & { itemIds: number[] } = { itemIds: [] };
  const secrets = Object.values(creds);
  let wrote = false;
  try {
    const done = await executeLivePush(plan, client, {
      beforeFirstWrite: async () => {
        wrote = true;
      },
      onProposalCreated: async (id) => {
        result.proposalId = id;
        await db.query("update brink_portal_pushes set portal_proposal_id = $2 where id = $1", [pushId, id]);
      },
      onAreaAdded: async (areaId, optionId) => {
        await db.query("update brink_portal_pushes set portal_area_id = $2, portal_area_option_id = $3 where id = $1", [pushId, areaId, optionId]);
      },
      onItemAdded: async (_seq, itemId) => {
        result.itemIds.push(itemId);
        await db.query("update brink_portal_pushes set portal_item_ids = $2::jsonb where id = $1", [pushId, JSON.stringify(result.itemIds)]);
      },
    });
    await db.query("update brink_portal_pushes set status = 'succeeded', finished_at = now() where id = $1", [pushId]);
    return { outcome: "succeeded", pushId, plan, requests, result: done };
  } catch (e) {
    const message = redact((e as Error).message, secrets);
    if (!wrote) {
      // nothing was written (bad part, auth failure, ...): Portal is unchanged
      const errors = e instanceof PushAborted ? e.errors : [];
      await db.query("update brink_portal_pushes set status = 'aborted', errors = $2::jsonb, error = $3, finished_at = now() where id = $1", [pushId, JSON.stringify(errors), message]);
      return { outcome: "aborted", pushId, plan: { ...plan, errors }, requests, error: message };
    }
    // a write may have happened: failed, never retried automatically
    await db.query("update brink_portal_pushes set status = 'failed', error = $2, finished_at = now() where id = $1", [pushId, message]);
    return { outcome: "failed", pushId, plan, requests, result, error: message };
  }
}
