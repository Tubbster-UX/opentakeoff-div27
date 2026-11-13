// The live push. Order: resolve every part (read-only) and abort on any bad
// part BEFORE the first write; then create the Draft proposal, read it for
// lastModified, add one area, and add one Part item per request. It never
// sends, finalizes, emails or re-statuses a proposal and never assigns a
// customer.
import { PortalHttpError, type PortalClient } from "./client.js";
import type { PlanError, PushPlan } from "./plan.js";
import { addAreaRequest, addPartItemRequest, basicInfoRequest, createProposalRequest, getProposalRequest } from "./requests.js";

/** The only part status seen as usable in the captures. */
export const USABLE_PART_STATUSES = new Set(["Activated"]);

export interface PartInfo {
  partId: number;
  brand?: string;
  model?: string;
  supplierId: number | string;
  cost: number;
  sellPrice: number;
  unitOfMeasure?: string;
  status?: string;
}

export interface LiveProgress {
  beforeFirstWrite?(): Promise<void>;
  onProposalCreated?(proposalId: number): Promise<void>;
  onAreaAdded?(areaId: number, areaOptionId: number): Promise<void>;
  onItemAdded?(seq: number, proposalItemId: number): Promise<void>;
}

export interface LiveResult {
  proposalId: number;
  areaId: number;
  areaOptionId: number;
  items: { seq: number; partId: number; itemQuantity: number; proposalItemId: number; cost: number; sellPrice: number }[];
}

/** Errors found before any write: the push stops and Portal is unchanged. */
export class PushAborted extends Error {
  constructor(readonly errors: PlanError[]) {
    super(`aborted before any write to Portal: ${errors.map((e) => e.message).join("; ")}`);
  }
}

/** Read every part the plan uses; collect every problem, then abort if there are any. */
export async function resolveParts(plan: PushPlan, client: PortalClient): Promise<Map<number, PartInfo>> {
  const parts = new Map<number, PartInfo>();
  const errors: PlanError[] = [];
  for (const partId of new Set(plan.items.map((i) => i.partId))) {
    let info: Record<string, unknown> | null;
    try {
      info = await client.send<Record<string, unknown>>(basicInfoRequest(partId));
    } catch (e) {
      if (e instanceof PortalHttpError && e.status === 404) {
        errors.push({ code: "invalid_portal_sku", message: `Portal partId ${partId} was not found (404)` });
        continue;
      }
      throw e;
    }
    const problems: string[] = [];
    if (!info || typeof info !== "object") problems.push("empty response");
    else {
      if (info.partId !== partId) problems.push(`basicinfo answered for partId ${JSON.stringify(info.partId)}`);
      if (typeof info.status !== "string" || !USABLE_PART_STATUSES.has(info.status)) problems.push(`status ${JSON.stringify(info.status)} is not usable (needs ${[...USABLE_PART_STATUSES].join(" / ")})`);
      if (typeof info.cost !== "number" || !Number.isFinite(info.cost)) problems.push(`cost ${JSON.stringify(info.cost)} is not a number`);
      if (typeof info.sellPrice !== "number" || !Number.isFinite(info.sellPrice)) problems.push(`sellPrice ${JSON.stringify(info.sellPrice)} is not a number`);
      if (info.supplierId == null || info.supplierId === "") problems.push("no supplierId");
    }
    for (const it of plan.items.filter((i) => i.partId === partId && i.expectUnitOfMeasure)) {
      const uom = typeof info?.unitOfMeasure === "string" ? info.unitOfMeasure : null;
      if (!uom || uom.trim().toLowerCase() !== it.expectUnitOfMeasure!.trim().toLowerCase()) {
        problems.push(`unitOfMeasure ${JSON.stringify(uom)} differs from the cable part's ${JSON.stringify(it.expectUnitOfMeasure)} (line ${it.lineNo})`);
      }
    }
    if (problems.length) {
      const lines = plan.items.filter((i) => i.partId === partId).map((i) => `line ${i.lineNo} ${i.conditionKey}`).join(", ");
      errors.push({ code: "invalid_portal_sku", message: `Portal partId ${partId} (${lines}): ${problems.join("; ")}` });
      continue;
    }
    parts.set(partId, info as unknown as PartInfo);
  }
  if (errors.length) throw new PushAborted(errors);
  return parts;
}

export async function executeLivePush(plan: PushPlan, client: PortalClient, progress: LiveProgress = {}): Promise<LiveResult> {
  if (plan.errors.length) throw new PushAborted(plan.errors);
  const parts = await resolveParts(plan, client);

  // first write: from here on a failure may leave a Draft proposal behind
  await progress.beforeFirstWrite?.();
  const proposal = await client.send<{ id?: unknown; status?: unknown }>(createProposalRequest(plan.proposalName));
  const proposalId = intOrThrow(proposal?.id, "POST /proposals id");
  await progress.onProposalCreated?.(proposalId);
  if (proposal?.status !== "Draft") throw new Error(`Portal created proposal ${proposalId} with status ${JSON.stringify(proposal?.status)}, not "Draft"; stopping`);

  const read = await client.send<{ proposalDates?: { lastModified?: unknown } }>(getProposalRequest(proposalId));
  const lastModified = read?.proposalDates?.lastModified;
  if (typeof lastModified !== "string" || !lastModified) throw new Error(`GET /proposals/${proposalId} has no proposalDates.lastModified`);

  const area = await client.send<{ id?: unknown; areaOptions?: { id?: unknown }[] }>(addAreaRequest(proposalId, plan.areaName, lastModified));
  const areaId = intOrThrow(area?.id, "area id");
  const areaOptionId = intOrThrow(area?.areaOptions?.[0]?.id, "area areaOptions[0].id");
  await progress.onAreaAdded?.(areaId, areaOptionId);

  const items: LiveResult["items"] = [];
  for (const it of plan.items) {
    const p = parts.get(it.partId)!;
    const res = await client.send<{ proposalItemIds?: unknown }>(addPartItemRequest(proposalId, it.partId, { supplierId: p.supplierId, cost: p.cost, sellPrice: p.sellPrice }, areaOptionId, it.itemQuantity));
    const ids = res?.proposalItemIds;
    if (!Array.isArray(ids) || ids.length !== 1) throw new Error(`add item ${it.seq} (partId ${it.partId}): expected one proposalItemId, got ${JSON.stringify(ids)}`);
    const proposalItemId = intOrThrow(ids[0], `item ${it.seq} proposalItemId`);
    items.push({ seq: it.seq, partId: it.partId, itemQuantity: it.itemQuantity, proposalItemId, cost: p.cost, sellPrice: p.sellPrice });
    await progress.onItemAdded?.(it.seq, proposalItemId);
  }
  return { proposalId, areaId, areaOptionId, items };
}

function intOrThrow(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`Portal response: ${what} is ${JSON.stringify(v)}, not an integer`);
  return v;
}
