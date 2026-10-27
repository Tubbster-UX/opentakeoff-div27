// Turn a brink-merge import (BOM lines + issues) and the catalog map into a
// Portal push plan: which Portal parts, at what quantities, in what order.
// Pure; no network, no database. Fail loud: any line that would be pushed but
// is not confirmed, has no usable Portal partId, or has a non-integer
// quantity is an error, and a plan with any error is never sent.
import { createHash } from "node:crypto";
import type { BomLine } from "../bom.js";
import type { CablePart, CatalogMap } from "../catalog.js";
import type { Issue } from "../issues.js";
import {
  addAreaRequest, addPartItemRequest, basicInfoRequest, createProposalRequest, getProposalRequest, loginRequest, refreshRequest, requestUrl,
  type PortalConfig, type PortalRequest,
} from "./requests.js";

export type PlanErrorCode =
  | "import_error"
  | "unmapped"
  | "not_confirmed"
  | "missing_portal_sku"
  | "invalid_portal_sku"
  | "stale_import"
  | "non_integer_qty"
  | "negative_qty"
  | "cable_unmapped"
  | "cable_not_confirmed"
  | "cable_no_package"
  | "cable_package_mismatch"
  | "cable_unit_unset"
  | "cable_no_order_line"
  | "no_push_rule"
  | "nothing_to_push";

export interface PlanError {
  code: PlanErrorCode;
  message: string;
  lineNo?: number;
  conditionKey?: string;
}

export interface PlanItem {
  /** 1-based order of the item request. */
  seq: number;
  source: "device" | "tr" | "cable_order";
  lineNo: number;
  conditionKey: string;
  description: string;
  partId: number;
  itemQuantity: number;
  /** How itemQuantity was derived, in words. */
  quantityRule: string;
  /** Cable parts: the unitOfMeasure Portal must report for this part. */
  expectUnitOfMeasure?: string;
}

export interface NotPushed {
  lineNo: number;
  kind: BomLine["kind"];
  conditionKey: string;
  description: string;
  qty: number;
  unit: BomLine["unit"];
  reason: string;
}

export interface PushPlan {
  project: string;
  importId: string;
  proposalName: string;
  areaName: string;
  items: PlanItem[];
  notPushed: NotPushed[];
  errors: PlanError[];
  /** Import warnings, carried for the estimator; they do not block. */
  warnings: string[];
  /** Short hash of what would be written; live mode must be confirmed with it. */
  hash: string;
}

export interface PlanOptions {
  project: string;
  importId: string;
  lines: BomLine[];
  catalog: CatalogMap;
  /** Issues of the import (when absent, the BOM's issue lines are used). */
  issues?: Issue[];
  /** Leave every cable line out of the push, explicitly (listed as not pushed). */
  excludeCable?: boolean;
  proposalName?: string;
  areaName?: string;
}

export const DEFAULT_AREA_NAME = "Division 27";

/** portal_sku holds Portal's numeric partId: a positive integer, nothing else. */
export function parsePartId(sku: string | null | undefined): number | null {
  if (sku == null) return null;
  const s = sku.trim();
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

const NOT_PUSHED_REASON: Partial<Record<BomLine["kind"], string>> = {
  pathway: "pathway LF: no Portal push rule for pathway",
  other: "plain condition: no Portal push rule",
  material: "supporting material: not pushed (no Portal mapping for materials)",
};

export function buildPushPlan(o: PlanOptions): PushPlan {
  const errors: PlanError[] = [];
  const items: Omit<PlanItem, "seq">[] = [];
  const notPushed: NotPushed[] = [];
  const rows = new Map(o.catalog.rows.map((r) => [r.conditionKey, r]));
  const cableParts = new Map((o.catalog.cableParts ?? []).map((c) => [c.cableType, c]));

  const issues: Pick<Issue, "severity" | "code" | "message" | "conditionKey">[] = o.issues
    ?? o.lines.filter((l) => l.kind === "issue").map((l) => ({ severity: l.severity!, code: l.code!, message: l.description, conditionKey: l.conditionKey || undefined }));
  for (const i of issues.filter((i) => i.severity === "error")) {
    errors.push({ code: "import_error", message: `the import carries an error: [${i.code}] ${i.message}`, ...(i.conditionKey ? { conditionKey: i.conditionKey } : {}) });
  }
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => `[${i.code}] ${i.message}`);

  const skip = (l: BomLine, reason: string) =>
    notPushed.push({ lineNo: l.lineNo, kind: l.kind, conditionKey: l.conditionKey, description: l.description, qty: l.qty, unit: l.unit, reason });
  const err = (l: BomLine, code: PlanErrorCode, message: string) =>
    errors.push({ code, message: `line ${l.lineNo} ${l.kind} ${l.conditionKey}: ${message}`, lineNo: l.lineNo, conditionKey: l.conditionKey });

  const cableTypesOnLines = new Set<string>();
  const cableTypesOrdered = new Set<string>();

  for (const l of o.lines) {
    if (l.kind === "issue") continue;

    if (l.kind === "device" || l.kind === "tr") {
      const row = rows.get(l.conditionKey);
      if (!row || l.mappingStatus === "unmapped") {
        err(l, "unmapped", "no catalog row; map and confirm it before pushing");
        continue;
      }
      if (row.status !== "confirmed" || l.mappingStatus !== "confirmed") {
        err(l, "not_confirmed", `catalog row is ${row.status}${l.mappingStatus !== row.status ? ` (the import was made with ${l.mappingStatus}; re-import)` : ""}; only confirmed rows are pushed`);
        continue;
      }
      if ((l.portalSku ?? null) !== (row.portalSku ?? null)) {
        err(l, "stale_import", `the import carries portal_sku ${JSON.stringify(l.portalSku ?? null)} but the catalog now has ${JSON.stringify(row.portalSku)}; re-import before pushing`);
        continue;
      }
      if (row.portalSku == null || row.portalSku.trim() === "") {
        err(l, "missing_portal_sku", "confirmed but portal_sku (Portal partId) is empty");
        continue;
      }
      const partId = parsePartId(row.portalSku);
      if (partId === null) {
        err(l, "invalid_portal_sku", `portal_sku ${JSON.stringify(row.portalSku)} is not a Portal partId (a positive integer)`);
        continue;
      }
      if (!Number.isInteger(l.qty)) {
        err(l, "non_integer_qty", `quantity ${l.qty} ${l.unit} is not a whole number`);
        continue;
      }
      if (l.qty < 0) {
        err(l, "negative_qty", `quantity ${l.qty} is negative`);
        continue;
      }
      if (l.qty === 0) {
        skip(l, "quantity 0");
        continue;
      }
      // the BOM count is pushed as is; held / unlinked devices inside it are named so the estimator sees them
      const inside = [l.heldQty ? `${l.heldQty} held` : "", l.unlinkedQty ? `${l.unlinkedQty} unlinked` : ""].filter(Boolean).join(", ");
      items.push({ source: l.kind, lineNo: l.lineNo, conditionKey: l.conditionKey, description: l.description, partId, itemQuantity: l.qty, quantityRule: `BOM ${l.kind} count (${l.qty} EA${inside ? `; includes ${inside}` : ""})` });
      continue;
    }

    if (l.kind === "cable") {
      if (l.cableType) cableTypesOnLines.add(l.cableType);
      skip(l, o.excludeCable ? "cable excluded by request" : "per-condition cable LF: cable is pushed from its cable order line");
      continue;
    }

    if (l.kind === "cable_order") {
      const type = l.cableType ?? "";
      cableTypesOrdered.add(type);
      if (o.excludeCable) {
        skip(l, "cable excluded by request");
        continue;
      }
      const item = cableItem(l, cableParts.get(type), (code, m) => err(l, code, m));
      if (item) items.push(item);
      continue;
    }

    // pathway, other, material: only pushed when a rule exists, and none does yet.
    const row = rows.get(l.conditionKey);
    if ((l.kind === "pathway" || l.kind === "other") && row?.portalSku) {
      err(l, "no_push_rule", `the catalog row has portal_sku ${JSON.stringify(row.portalSku)}, but brink-merge has no Portal push rule for ${l.kind} lines; clear portal_sku or ask for a rule`);
      continue;
    }
    skip(l, NOT_PUSHED_REASON[l.kind] ?? `${l.kind}: not pushed`);
  }

  if (!o.excludeCable) {
    for (const t of cableTypesOnLines) {
      if (!cableTypesOrdered.has(t)) errors.push({ code: "cable_no_order_line", message: `cable ${JSON.stringify(t)} has cable lines but no cable order line (box / reel rounding) in the import; re-export the OpenTakeoff report` });
    }
  }
  if (!errors.length && !items.length) errors.push({ code: "nothing_to_push", message: "no line of this import would become a Portal item" });

  const project = o.project;
  const proposalName = o.proposalName?.trim() || `${project} - Division 27`;
  const areaName = o.areaName?.trim() || DEFAULT_AREA_NAME;
  const numbered = items.map((it, i) => ({ seq: i + 1, ...it }));
  const hash = createHash("sha256")
    .update(JSON.stringify({ importId: o.importId, proposalName, areaName, items: numbered.map((i) => [i.source, i.conditionKey, i.partId, i.itemQuantity, i.expectUnitOfMeasure ?? null]) }))
    .digest("hex")
    .slice(0, 16);
  return { project, importId: o.importId, proposalName, areaName, items: numbered, notPushed, errors, warnings, hash };
}

function cableItem(l: BomLine, cp: CablePart | undefined, err: (code: PlanErrorCode, m: string) => void): Omit<PlanItem, "seq"> | null {
  const type = l.cableType ?? "";
  if (!cp) {
    err("cable_unmapped", `cable ${JSON.stringify(type)} has no Portal cable part (catalog cableParts / map_cable_part); map it, or push without cable explicitly`);
    return null;
  }
  if (cp.status !== "confirmed") {
    err("cable_not_confirmed", `the Portal cable part for ${JSON.stringify(type)} is ${cp.status}; only confirmed rows are pushed`);
    return null;
  }
  if (cp.portalSku == null || cp.portalSku.trim() === "") {
    err("missing_portal_sku", `the Portal cable part for ${JSON.stringify(type)} is confirmed but portal_sku is empty`);
    return null;
  }
  const partId = parsePartId(cp.portalSku);
  if (partId === null) {
    err("invalid_portal_sku", `portal_sku ${JSON.stringify(cp.portalSku)} for cable ${JSON.stringify(type)} is not a Portal partId (a positive integer)`);
    return null;
  }
  if (!cp.portalUnitOfMeasure) {
    err("cable_unit_unset", `the Portal cable part for ${JSON.stringify(type)} has no portalUnitOfMeasure; set it to the part's unitOfMeasure as Portal shows it so the quantity basis is checked`);
    return null;
  }
  let itemQuantity: number;
  let quantityRule: string;
  if (cp.orderBasis === "box") {
    if (l.boxes == null || l.packageFt == null) {
      err("cable_no_package", `ordered by the box, but OpenTakeoff stated no box / reel size for ${JSON.stringify(type)}; set one on the condition and re-export`);
      return null;
    }
    if (cp.packageFt != null && Math.abs(cp.packageFt - l.packageFt) > 1e-9) {
      err("cable_package_mismatch", `the Portal part is a ${cp.packageFt} ft package, but OpenTakeoff rounded to ${l.packageFt} ft boxes`);
      return null;
    }
    if (cp.packageFt == null) {
      err("cable_package_mismatch", `the Portal cable part for ${JSON.stringify(type)} is ordered by the box but states no packageFt to check against OpenTakeoff's ${l.packageFt} ft`);
      return null;
    }
    if (!Number.isInteger(l.boxes) || l.boxes <= 0) {
      err("non_integer_qty", `box count ${l.boxes} is not a positive whole number`);
      return null;
    }
    itemQuantity = l.boxes;
    quantityRule = `OpenTakeoff box count: ${l.boxes} x ${l.packageFt} ft (order ${l.orderLf} LF)`;
  } else {
    const lf = l.orderLf ?? l.qty;
    if (!(lf > 0)) {
      err("non_integer_qty", `order LF ${lf} is not positive`);
      return null;
    }
    itemQuantity = Math.ceil(lf - 1e-9);
    quantityRule = `OpenTakeoff order LF ${lf} rounded up to whole feet`;
  }
  return {
    source: "cable_order", lineNo: l.lineNo, conditionKey: l.conditionKey, description: l.description, partId, itemQuantity, quantityRule,
    expectUnitOfMeasure: cp.portalUnitOfMeasure,
  };
}

export interface PlannedRequest {
  step: string;
  method: PortalRequest["method"];
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * The exact ordered requests a live push would make, with <placeholders> for
 * values Portal returns (ids, prices, lastModified). Secrets never appear.
 */
export function requestPlan(plan: PushPlan, cfg: PortalConfig, auth: "password" | "refresh_token" = "password"): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  const add = (step: string, r: PortalRequest) => out.push({
    step,
    method: r.method,
    url: requestUrl(cfg, r),
    headers: {
      ...(r.auth ? { Authorization: "Bearer <redacted>" } : {}),
      ...(r.method === "POST" ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
      ...(r.headers ?? {}),
    },
    ...(r.body !== undefined ? { body: r.secretBody ? "<redacted: credentials>" : r.body } : {}),
  });
  if (auth === "password") add("login", loginRequest("<PORTAL_USERNAME>", "<PORTAL_PASSWORD>"));
  add("access token (repeated before exp and once on a 401)", refreshRequest("<refresh token>"));
  const parts = [...new Set(plan.items.map((i) => i.partId))];
  for (const p of parts) add(`resolve part ${p}`, basicInfoRequest(p));
  add("create draft proposal", createProposalRequest(plan.proposalName));
  add("read proposal (lastModified)", getProposalRequest("<proposal.id>"));
  add("add area", addAreaRequest("<proposal.id>", plan.areaName, "<proposal.proposalDates.lastModified>"));
  for (const it of plan.items) {
    add(`add item ${it.seq}/${plan.items.length}: line ${it.lineNo} ${it.conditionKey} x${it.itemQuantity}`, addPartItemRequest(
      "<proposal.id>", it.partId,
      { supplierId: `<basicinfo ${it.partId}.supplierId>`, cost: `<basicinfo ${it.partId}.cost>`, sellPrice: `<basicinfo ${it.partId}.sellPrice>` },
      "<area.areaOptions[0].id>", it.itemQuantity,
    ));
  }
  return out;
}

/** Human-readable plan for the CLI. */
export function formatPlan(plan: PushPlan, requests: PlannedRequest[], opts: { live: boolean }): string {
  const out: string[] = [];
  out.push(`Portal push ${opts.live ? "LIVE" : "DRY RUN"}: ${plan.project} (import ${plan.importId})`);
  out.push(`proposal "${plan.proposalName}" (Draft), area "${plan.areaName}", customer left unset`);
  out.push("");
  out.push(`items (${plan.items.length}):`);
  for (const i of plan.items) out.push(`  ${i.seq}. line ${i.lineNo} ${i.source} ${i.conditionKey} -> Portal partId ${i.partId} x ${i.itemQuantity}  [${i.quantityRule}]${i.expectUnitOfMeasure ? ` (Portal unitOfMeasure must be ${JSON.stringify(i.expectUnitOfMeasure)})` : ""}`);
  out.push("");
  out.push(`not pushed (${plan.notPushed.length}):`);
  for (const n of plan.notPushed) out.push(`  line ${n.lineNo} ${n.kind} ${n.conditionKey}: ${n.qty} ${n.unit} ${n.description} -- ${n.reason}`);
  if (plan.warnings.length) {
    out.push("");
    out.push(`import warnings (${plan.warnings.length}, not blocking):`);
    for (const w of plan.warnings) out.push(`  ${w}`);
  }
  out.push("");
  if (plan.errors.length) {
    out.push(`ABORTED: ${plan.errors.length} error(s); nothing is sent to Portal:`);
    for (const e of plan.errors) out.push(`  ERROR [${e.code}] ${e.message}`);
    return out.join("\n");
  }
  out.push(`request plan (${requests.length} requests, in order; <...> = filled from Portal's responses at run time):`);
  requests.forEach((r, i) => {
    out.push(`  ${String(i + 1).padStart(2)}. ${r.method} ${r.url}    # ${r.step}`);
    const extra = Object.entries(r.headers).filter(([k]) => k !== "Accept" && k !== "Content-Type");
    if (extra.length) out.push(`      headers: ${extra.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    if (r.body !== undefined) out.push(`      body: ${JSON.stringify(r.body)}`);
  });
  out.push("");
  out.push(`plan hash ${plan.hash}`);
  return out.join("\n");
}
