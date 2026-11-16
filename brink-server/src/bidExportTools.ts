// Bid export tools on the hosted MCP server: the owner's workbook, the GC
// sub-bid PDF and the federal quote package, rendered from the latest priced
// draft (projects/<p>/outputs/bid/bid.json, written by price_bid) and the
// proposal content Claude stored with set_proposal_content. Files land in the
// project's outputs under bid/, named with the project and revision ("DRAFT"
// until the owner approves on the project page), and the reply carries
// download links for the phone. Nothing here approves anything.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BidDraft } from "./bidTypes.ts";
import type { AppDeps, ProjectId, ProjectManifest } from "./types.ts";
import { LINK_TTL_SEC, UserError, fail, ok, requireProject, type ToolReply } from "./projectTools.ts";
import { renderBidWorkbook, workbookDifferences } from "./bid/workbook.ts";
import { GcProposalContentSchema, renderGcProposalPdf, type GcProposalContent } from "./bid/proposal.ts";
import { FederalContentSchema, federalContentProblems, renderFederalPackage, type FederalContent } from "./bid/federal.ts";
import { bidFileName, incompleteReason, isApproved, statusLine } from "./bid/format.ts";

export const BID_EXPORT_TOOL_NAMES = ["set_proposal_content", "export_bid_workbook", "export_gc_proposal", "export_federal_package"] as const;

export interface BidExportToolsCtx {
  deps: AppDeps;
  linkTtlSec?: number;
}

/** Folder under the project's outputs the bid files live in. */
export const BID_DIR = "bid";
const CONTENT_FILE = { gc: "proposal-gc.json", federal: "proposal-federal.json" } as const;
type Kind = keyof typeof CONTENT_FILE;

const storeKey = (project: ProjectId, name: string) => `projects/${project}/outputs/${BID_DIR}/${name}`;

/** A file under outputs/bid/: the store first (it survives restarts), then the local mirror. */
async function readBidFile(deps: AppDeps, project: ProjectId, name: string): Promise<Uint8Array | null> {
  const stored = await deps.storage.getBytes(storeKey(project, name));
  if (stored) return stored;
  try {
    return new Uint8Array(await readFile(path.join(deps.workspace.outputsDir(project), BID_DIR, name)));
  } catch {
    return null;
  }
}

async function loadBid(deps: AppDeps, project: ProjectId): Promise<BidDraft> {
  const bytes = await readBidFile(deps, project, "bid.json");
  if (!bytes) throw new UserError(`Project ${project} has no priced bid yet (outputs/${BID_DIR}/bid.json). Run price_bid first.`);
  let bid: BidDraft;
  try {
    bid = JSON.parse(Buffer.from(bytes).toString("utf8")) as BidDraft;
  } catch {
    throw new UserError(`outputs/${BID_DIR}/bid.json in ${project} is not valid JSON. Run price_bid again.`);
  }
  if (bid?.schema !== "brink.bid.v1") throw new UserError(`outputs/${BID_DIR}/bid.json in ${project} is not a brink.bid.v1 draft. Run price_bid again.`);
  return bid;
}

function issues(e: z.ZodError): string {
  return e.issues.slice(0, 12).map((i) => `${i.path.length ? i.path.join(".") : "(content)"}: ${i.message}`).join("; ")
    + (e.issues.length > 12 ? `; and ${e.issues.length - 12} more` : "");
}

function parseContent(kind: "gc", raw: unknown): GcProposalContent;
function parseContent(kind: "federal", raw: unknown): FederalContent;
function parseContent(kind: Kind, raw: unknown): GcProposalContent | FederalContent;
function parseContent(kind: Kind, raw: unknown): GcProposalContent | FederalContent {
  const schema = kind === "gc" ? GcProposalContentSchema : FederalContentSchema;
  const r = schema.safeParse(raw);
  if (!r.success) throw new UserError(`The ${kind} proposal content does not fit: ${issues(r.error)}.`);
  if (kind === "federal") {
    const problems = federalContentProblems(r.data as FederalContent);
    if (problems.length) throw new UserError(`The federal content breaks the package rules: ${problems.join(". ")}.`);
  }
  return r.data;
}

async function loadContent(deps: AppDeps, project: ProjectId, kind: "gc"): Promise<GcProposalContent>;
async function loadContent(deps: AppDeps, project: ProjectId, kind: "federal"): Promise<FederalContent>;
async function loadContent(deps: AppDeps, project: ProjectId, kind: Kind): Promise<GcProposalContent | FederalContent> {
  const bytes = await readBidFile(deps, project, CONTENT_FILE[kind]);
  if (!bytes) throw new UserError(`No ${kind === "gc" ? "GC proposal" : "federal package"} content for ${project} yet. Call set_proposal_content {project: "${project}", kind: "${kind}", content: {...}} first.`);
  return parseContent(kind, JSON.parse(Buffer.from(bytes).toString("utf8")));
}

async function loadLogo(deps: AppDeps, bid: BidDraft): Promise<Uint8Array | undefined> {
  const key = bid.settings.company.logoKey;
  if (!key) return undefined;
  try {
    return (await deps.storage.getBytes(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Write files into outputs/bid/, push them to the store, and return their links. */
async function publish(deps: AppDeps, project: ProjectId, files: { name: string; bytes: Uint8Array }[], ttl: number) {
  const dir = path.join(deps.workspace.outputsDir(project), BID_DIR);
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(path.join(dir, f.name), f.bytes);
  await deps.workspace.syncOutputs(project);
  const out: { path: string; url: string }[] = [];
  for (const f of files) {
    out.push({ path: `outputs/${BID_DIR}/${f.name}`, url: await deps.storage.presignGet(storeKey(project, f.name), ttl, { filename: f.name }) });
  }
  return out;
}

const run = (fn: (a: any) => Promise<ToolReply>) => async (a: any): Promise<ToolReply> => {
  try {
    return await fn(a);
  } catch (e) {
    return fail(e);
  }
};

const projectArg = z.string().describe("Project id from list_projects, e.g. \"fa4690-25-q-0012\"");
const allowArg = z.boolean().optional().describe("Render even though the bid has unpriced items or no base bid; the price then reads \"INCOMPLETE — not for submission\". Default false.");

function reply(m: ProjectManifest, bid: BidDraft, files: { path: string; url: string }[], ttl: number, extra: Record<string, unknown> = {}): ToolReply {
  return ok({
    project: m.id,
    revision: bid.revision,
    status: statusLine(bid),
    files,
    expires_in_hours: Math.round(ttl / 3600),
    ...extra,
    note: isApproved(bid)
      ? "Approved revision: these are the final files. Give the user the links."
      : "Draft: give the user the links to review on the phone. Only the owner approves, on the project page; re-export after approval to get the final files without DRAFT.",
  });
}

export function registerBidExportTools(server: McpServer, ctx: BidExportToolsCtx): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;

  server.registerTool("set_proposal_content", {
    description: [
      "Store the words of a proposal for export_gc_proposal (kind \"gc\") or export_federal_package (kind \"federal\"). Replaces the stored content of that kind; the price always comes from the latest price_bid, company facts and standard terms from settings.",
      "gc content: preparedFor {company, attention, email?}, projectTitle, documents [plan set, specs, addenda], quoteDate, bidDate, scopeItems [string | {item, detail}], products [{item, model, qty, basis}], responsibilities [{task, brink: true when we do it, others}], projectConditions [], exclusions [] (printed after the standard exclusions), clarifications [] (after the standard ones), priceNote (e.g. \"Flat rate · no taxes\").",
      "federal content: solicitation {number, title, agency, office}, date?, recipients [{name, rank?, role (\"Contracting Officer\" / \"Contract Specialist\"), email}], coverParagraphs [] in the owner's federal voice (third person, the company name), complianceMatrix [{requirement (quoted SOW text), reference (SOW §), offered (make/model), response \"Meets\" | \"Exceeds\" | \"Exception\", exceptionNo (with Exception)}], exceptions [{no, sowSays, conflict, brinkDoes, offRamp}], assumptions [{text, exceptionNo?}], bomByRoom [{room, items [{description, manufacturer, model, qty, taa?}]}], priceStatement, deliveryTerms?, closing?.",
      "Every compliance cell must be filled. Do not write the firm-fixed price, the \"No other exceptions are taken.\" sentence or the federal forms: the renderer adds the first two and the owner fills and signs the forms.",
    ].join(" "),
    inputSchema: {
      project: projectArg,
      kind: z.enum(["gc", "federal"]).describe("\"gc\" for the GC / EC sub-bid, \"federal\" for the cover letter + technical package"),
      content: z.record(z.string(), z.unknown()).describe("The content object for that kind (fields above)"),
    },
  }, run(async ({ project, kind, content }) => {
    const m = await requireProject(deps, project);
    const k = kind as Kind;
    const parsed = parseContent(k, content);
    const name = CONTENT_FILE[k];
    const [file] = await publish(deps, m.id, [{ name, bytes: new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`) }], ttl);
    return ok({
      project: m.id,
      kind: k,
      stored: file.path,
      note: k === "gc" ? "Stored. export_gc_proposal renders the quote PDF." : "Stored. export_federal_package renders the cover letter and technical package (.docx and PDF).",
    });
  }));

  server.registerTool("export_bid_workbook", {
    description: "Write the bid workbook (.xlsx) from the latest price_bid: Summary, Assumptions (the levers as named ranges, the price list with source and date), Material, Labor, Expenses, Quotes Needed and Flags, all as live formulas the owner can change. Returns a download link valid 24 hours; give it to the user.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    const bid = await loadBid(deps, m.id);
    const bytes = await renderBidWorkbook(bid, m);
    const files = await publish(deps, m.id, [{ name: bidFileName(m.name, "bid", bid, "xlsx"), bytes }], ttl);
    const diffs = workbookDifferences(bid);
    const why = incompleteReason(bid);
    return reply(m, bid, files, ttl, {
      ...(why ? { incomplete: why } : {}),
      ...(diffs.length ? { workbook_check: `The workbook formulas differ from bid.json: ${diffs.join("; ")}. The Flags tab lists them.` } : {}),
    });
  }));

  server.registerTool("export_gc_proposal", {
    description: "Write the GC / EC sub-bid quote PDF (3 pages: price and scope; products, responsibilities and conditions; exclusions, clarifications, warranty, terms and acceptance) from the latest price_bid and the content stored with set_proposal_content kind \"gc\". Stamped DRAFT until the owner approves. Refuses while the bid has unpriced items unless allow_incomplete. Returns a download link valid 24 hours.",
    inputSchema: { project: projectArg, allow_incomplete: allowArg },
  }, run(async ({ project, allow_incomplete }) => {
    const m = await requireProject(deps, project);
    const bid = await loadBid(deps, m.id);
    const content = await loadContent(deps, m.id, "gc");
    const bytes = await renderGcProposalPdf({ bid, project: m, content, logo: await loadLogo(deps, bid), allowIncomplete: allow_incomplete === true });
    const files = await publish(deps, m.id, [{ name: bidFileName(m.name, "quote", bid, "pdf"), bytes }], ttl);
    const why = incompleteReason(bid);
    return reply(m, bid, files, ttl, why ? { incomplete: `${why}. The price reads INCOMPLETE — not for submission.` } : {});
  }));

  server.registerTool("export_federal_package", {
    description: "Write the federal quote package from the latest price_bid and the content stored with set_proposal_content kind \"federal\": the cover letter and the technical package (compliance matrix, exceptions, assumptions, BOM by room, firm-fixed price), each as .docx and PDF, with UEI and CAGE from settings. DRAFT until the owner approves. The owner fills and signs the SF 1449 and reps and certs. Refuses while the bid has unpriced items unless allow_incomplete. Returns four download links valid 24 hours.",
    inputSchema: { project: projectArg, allow_incomplete: allowArg },
  }, run(async ({ project, allow_incomplete }) => {
    const m = await requireProject(deps, project);
    const bid = await loadBid(deps, m.id);
    const content = await loadContent(deps, m.id, "federal");
    const out = await renderFederalPackage({ bid, project: m, content, logo: await loadLogo(deps, bid), allowIncomplete: allow_incomplete === true });
    const files = await publish(deps, m.id, [
      { name: bidFileName(m.name, "cover letter", bid, "docx"), bytes: out.coverDocx },
      { name: bidFileName(m.name, "cover letter", bid, "pdf"), bytes: out.coverPdf },
      { name: bidFileName(m.name, "technical package", bid, "docx"), bytes: out.technicalDocx },
      { name: bidFileName(m.name, "technical package", bid, "pdf"), bytes: out.technicalPdf },
    ], ttl);
    const why = incompleteReason(bid);
    return reply(m, bid, files, ttl, why ? { incomplete: `${why}. The price reads INCOMPLETE — not for submission.` } : {});
  }));
}

/**
 * After the owner approves (src/approval.ts), make the final files: the
 * workbook always, and each proposal whose content Claude stored. The approved
 * bid's file names drop DRAFT. Returns the project paths written. Never called
 * by a tool: only the owner's approval route reaches it.
 */
export async function rerenderApproved(deps: AppDeps, project: ProjectId, ttl = LINK_TTL_SEC): Promise<string[]> {
  const m = await requireProject(deps, project);
  const bid = await loadBid(deps, m.id);
  if (!isApproved(bid)) throw new UserError(`Revision ${bid.revision} of ${project} is not approved.`);
  const logo = await loadLogo(deps, bid);
  const files: { name: string; bytes: Uint8Array }[] = [{ name: bidFileName(m.name, "bid", bid, "xlsx"), bytes: await renderBidWorkbook(bid, m) }];
  if (await readBidFile(deps, m.id, CONTENT_FILE.gc)) {
    const content = await loadContent(deps, m.id, "gc");
    files.push({ name: bidFileName(m.name, "quote", bid, "pdf"), bytes: await renderGcProposalPdf({ bid, project: m, content, logo }) });
  }
  if (await readBidFile(deps, m.id, CONTENT_FILE.federal)) {
    const content = await loadContent(deps, m.id, "federal");
    const out = await renderFederalPackage({ bid, project: m, content, logo });
    files.push(
      { name: bidFileName(m.name, "cover letter", bid, "docx"), bytes: out.coverDocx },
      { name: bidFileName(m.name, "cover letter", bid, "pdf"), bytes: out.coverPdf },
      { name: bidFileName(m.name, "technical package", bid, "docx"), bytes: out.technicalDocx },
      { name: bidFileName(m.name, "technical package", bid, "pdf"), bytes: out.technicalPdf },
    );
  }
  return (await publish(deps, m.id, files, ttl)).map((f) => f.path);
}
