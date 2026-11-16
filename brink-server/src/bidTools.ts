// Bid tools on the hosted takeoff MCP server (/mcp): the owner's settings and
// playbook, the price book, and price_bid, which prices the takeoff open in
// this conversation (src/bid/price.ts) into projects/<p>/outputs/bid/bid.json.
// The bid is always a DRAFT: only the owner approves it, on the project page;
// no tool here can set or keep an approval.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "opentakeoff-core";
import type { AppDeps, ProjectId } from "./types.ts";
import type { BidDraft, BidJobInputs, BidLine, ExpenseLine } from "./bidTypes.ts";
import { LINK_TTL_SEC, UserError, fail, linksForPushed, ok, requireProject, type OpenState, type ToolReply } from "./projectTools.ts";
import { StoreSettings, PCT_FIELDS, NUM_FIELDS } from "./settings.ts";
import { StorePriceBook, PRICE_STATUSES } from "./pricebook.ts";
import { priceBid, DEFAULT_DEVICE_UNITS } from "./bid/price.ts";

/** Where the draft lives, relative to the project's outputs. */
export const BID_OUTPUT = "bid/bid.json";

export const BID_TOOL_NAMES = [
  "get_settings", "update_settings", "get_playbook", "set_playbook", "find_prices", "record_prices", "price_bid", "bid_summary",
] as const;

export interface BidToolsCtx {
  deps: AppDeps;
  /** This MCP connection's OpenTakeoff session (its takeoff is what price_bid prices). */
  session: Session;
  state: OpenState;
  /** Push the project's outputs to the store now; returns the project paths pushed. */
  pushOutputs(project: ProjectId): Promise<string[]>;
  linkTtlSec?: number;
  settings?: StoreSettings;
  priceBook?: StorePriceBook;
  now?: () => string;
}

const run = (fn: (a: any) => Promise<ToolReply> | ToolReply) => async (a: any): Promise<ToolReply> => {
  try {
    return await fn(a);
  } catch (e) {
    return fail(e);
  }
};
const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

const projectArg = z.string().describe("Project id from list_projects");
const SECTIONS = ["cable", "connectivity", "equipment", "pathway", "support", "allowance", "other"] as const;
const lineSchema = z.object({
  section: z.enum(SECTIONS),
  description: z.string().min(1).describe("What it is; also the price-book lookup name when no manufacturer + part"),
  manufacturer: z.string().optional(),
  part: z.string().optional(),
  qty: z.number().min(0),
  unit: z.string().min(1).describe("EA, FT, BOX(1000FT), LS, ..."),
  unitPrice: z.number().min(0).nullable().optional().describe("Leave out to look the price up in the price book; give it only for an allowance or a quoted lump sum"),
  priceStatus: z.enum(["live", "estimate", "allowance", "missing"]).optional(),
  source: z.string().optional(),
  priceDate: z.string().optional(),
  laborOnly: z.boolean().optional(),
  basis: z.string().optional().describe("Spec clause or drawing note that calls for it, e.g. \"27 15 00 2.1.A\""),
  conditionId: z.string().optional(),
});
const expenseSchema = z.object({
  label: z.string().min(1).describe("\"Lift rental\", \"Certifier rental\", \"Permit\", ..."),
  qty: z.number().min(0),
  unit: z.string().min(1),
  unitCost: z.number().min(0).nullable().optional(),
});
const inputsSchema = z.object({
  excise: z.boolean().optional().describe("true for South Dakota work without an exemption certificate (applies the contractor's excise after profit)"),
  bond: z.boolean().optional().describe("true when the job requires a bond (added on top of the base bid, shown separately)"),
  unitSet: z.string().optional().describe("Labor unit set id (default: settings.labor.defaultUnitSet). Pick a non-default set only when its `when` applies, and say why in unitSetReason"),
  unitSetReason: z.string().optional(),
  mobilizations: z.number().int().min(0).optional().describe("Trips to set up on site (phases)"),
  crewSize: z.number().int().min(1).optional().describe("Overrides settings.labor.crewSize for this job"),
  driveHoursPerDay: z.number().min(0).optional().describe("Round-trip drive hours per tech per site day (0 for local work)"),
  milesPerDay: z.number().min(0).optional().describe("Round-trip miles per vehicle per site day"),
  vehicles: z.number().int().min(0).optional(),
  jobHours: z.array(z.object({ label: z.string().min(1), hours: z.number().min(0) })).optional().describe("Fixed job hours: submittals, cleanup, as-builts, training, ..."),
  extraLines: z.array(lineSchema).optional().describe("Material or allowance lines the takeoff does not carry (patch panels, racks, ...)"),
  extraExpenses: z.array(expenseSchema).optional(),
  laborOnlyConditions: z.array(z.string()).optional().describe("Condition finish tags (or ids) the owner furnishes: material 0, labor kept"),
});
const REQUIRED_INPUTS = ["excise", "bond", "mobilizations", "driveHoursPerDay", "milesPerDay", "vehicles"] as const;

/** Settings fields still null (the gaps a fresh server starts with). */
function unsetSettings(s: unknown): string[] {
  const out: string[] = [...PCT_FIELDS, ...NUM_FIELDS].filter((p) => get(s, p) === null);
  const sets = (get(s, "labor.unitSets") as { id: string; units: unknown[] }[] | undefined) ?? [];
  for (const set of sets) if (!set.units?.length) out.push(`labor.unitSets[${set.id}].units (empty)`);
  return out;
}

const brief = (bid: BidDraft) => ({
  base_bid: bid.totals.baseBid,
  ...(bid.inputs.bond ? { total_with_bond: bid.totals.totalWithBond, bond: bid.totals.bond } : {}),
  gaps: { count: bid.gaps.length, items: bid.gaps.slice(0, 25), ...(bid.gaps.length > 25 ? { more: bid.gaps.length - 25 } : {}) },
  flags: { count: bid.flags.length, items: bid.flags.slice(0, 25).map((f) => `${f.kind}: ${f.message}`), ...(bid.flags.length > 25 ? { more: bid.flags.length - 25 } : {}) },
  ratios: bid.ratios,
  totals: bid.totals,
  hours: {
    field: Math.round(bid.hours.filter((h) => h.kind === "field").reduce((a, h) => a + h.hours, 0) * 100) / 100,
    job: Math.round(bid.hours.filter((h) => h.kind === "job").reduce((a, h) => a + h.hours, 0) * 100) / 100,
    total: bid.totals.laborHours,
  },
  lines: { count: bid.lines.length, unpriced: bid.lines.filter((l) => l.priceStatus === "missing").length },
});

export function registerBidTools(server: McpServer, ctx: BidToolsCtx): void {
  const { deps } = ctx;
  const ttl = ctx.linkTtlSec ?? LINK_TTL_SEC;
  const settingsStore = ctx.settings ?? new StoreSettings(deps.storage);
  const book = ctx.priceBook ?? new StorePriceBook(deps.storage);
  const now = ctx.now ?? (() => new Date().toISOString());

  /** The latest draft: the store's copy, or the local one when it is newer (a push that has not landed yet). */
  const latestBid = async (project: ProjectId): Promise<BidDraft | null> => {
    let stored: BidDraft | null = null;
    const bytes = await deps.storage.getBytes(`projects/${project}/outputs/${BID_OUTPUT}`);
    if (bytes) stored = JSON.parse(Buffer.from(bytes).toString("utf8")) as BidDraft;
    let local: BidDraft | null = null;
    try { local = JSON.parse(await readFile(path.join(deps.workspace.outputsDir(project), ...BID_OUTPUT.split("/")), "utf8")) as BidDraft; } catch { /* none */ }
    if (local && (!stored || (local.revision ?? 0) > (stored.revision ?? 0))) return local;
    return stored;
  };

  server.registerTool("get_settings", {
    description: "The owner's bid settings: company profile (letterhead), labor (target bill rate, true cost rate, crew size, hours per day, PM % of field hours, labor unit sets with hours per pull / per cable / per link / per job), markups (material at the line, overhead, profit, SD excise, bond), mileage rate, proposal terms, and the change log. Percentages are FRACTIONS (0.15 = 15%). Read it with get_playbook at the start of every bid. unset lists what is still null: each is a gap in price_bid until it is filled from the owner's playbook or instructions (update_settings).",
    inputSchema: {},
  }, run(async () => {
    const s = await settingsStore.get();
    const unset = unsetSettings(s);
    return ok({
      settings: { ...s, changeLog: s.changeLog.slice(-20) },
      ...(s.changeLog.length > 20 ? { change_log_note: `last 20 of ${s.changeLog.length} changes shown` } : {}),
      unset,
      device_unit_map: DEFAULT_DEVICE_UNITS,
      note: `Percentages are fractions (0.15 = 15%). price_bid counts pull labor per location with the device type's first-cable unit plus an additional-cable unit per extra cable (device_unit_map: unit ids it looks up in the chosen unit set), "cert" and "label" per link, "mobilization" per trip.${unset.length ? " Unset fields are gaps: fill them from the playbook or ask the owner; never invent a rate." : ""}`,
    });
  }));

  server.registerTool("update_settings", {
    description: "Change the owner's bid settings with a partial patch: objects merge key by key, lists (address lines, exclusions, unit sets, a set's units) are replaced whole, null clears a number. Percentages are FRACTIONS: 0.15 means 15% (a value above 1 is refused). Numbers must be 0 or more. Fill settings only from the owner's playbook (get_playbook) or what the owner tells you, never from guesses; every change is logged with who made it. Labor unit sets: [{id, label, when?, units: [{id, label, hours, per}]}], per one of location_first, cable_additional, each, link, lf, job; the unit ids price_bid looks for are wall_first, wall_add, wap_first, wap_add, camera, door, cert, label, mobilization. Read get_settings first so a list you replace keeps what should stay.",
    inputSchema: {
      patch: z.record(z.string(), z.unknown()).describe("E.g. {\"markup\": {\"materialPct\": 0.15}, \"labor\": {\"crewSize\": 2}}. Sections: company, labor, markup, travel, proposal"),
    },
  }, run(async ({ patch }) => {
    const { settings, changes } = await settingsStore.update(patch, "claude");
    return ok({ changes, ...(changes.length ? {} : { note: "Nothing changed." }), unset: unsetSettings(settings) });
  }));

  server.registerTool("get_playbook", {
    description: "The owner's quoting playbook: how a Division 27 job is quoted (intake, takeoff rules, labor units, the markup chain, proposal formats, past-bid benchmarks). Read it at the start of every bid, before taking off or pricing, and follow it.",
    inputSchema: {},
  }, run(async () => {
    const text = await settingsStore.getPlaybook();
    return text == null
      ? ok({ playbook: null, note: "No playbook stored yet. Ask the owner for it (set_playbook stores the text they give you)." })
      : ok({ playbook: text, chars: text.length });
  }));

  server.registerTool("set_playbook", {
    description: "Replace the owner's quoting playbook with the full text (markdown). Use it to store the playbook the owner gives you, or a change the owner asks for; read get_playbook first and keep what still applies. Logged in the settings change log.",
    inputSchema: { text: z.string().min(1).max(500_000).describe("The complete playbook (replaces the old one)") },
  }, run(async ({ text }) => {
    await settingsStore.setPlaybook(text, "claude");
    return ok({ saved: true, chars: text.length });
  }));

  server.registerTool("find_prices", {
    description: "Search the price book: every word must appear in an entry's manufacturer, part, description or supplier. Newest first, each with its price, unit, status (live / estimate / allowance), source and date. Look here before looking a price up online; a price older than 30 days is flagged stale in the bid.",
    inputSchema: {
      query: z.string().max(300).describe("Words, e.g. \"cat6a plenum\" or a part number"),
      limit: z.number().int().min(1).max(100).optional().describe("Most entries (default 20)"),
    },
  }, run(async ({ query, limit }) => {
    const entries = await book.find(query, { limit: limit ?? 20 });
    return ok({ entries, ...(entries.length ? {} : { note: "No match. Look the price up (distributor or manufacturer site, the owner's uploaded quotes or past bids) and record_prices it with its source and date." }) });
  }));

  server.registerTool("record_prices", {
    description: "Add prices to the price book (history is kept; an exact repeat is skipped). Every entry needs a source and a date: a price you look up online → source is the page URL and date is today's date, status \"live\" for a listed price or \"estimate\" when inferred; a price from a distributor quote the owner uploaded → source is the quote reference (\"<distributor> quote #1234, <file path>\") and its date; from a past bid → \"past bid: <project>\". \"allowance\" is a placeholder number the owner accepts. Give manufacturer and part when known. The description should read like the bid line it prices: price_bid matches a cable line by the condition's cable_type and a material line by its name. unit is what the price is per (EA, FT, BOX(1000FT)); feet and boxes convert, other units must match the line.",
    inputSchema: {
      entries: z.array(z.object({
        description: z.string().min(1),
        manufacturer: z.string().optional(),
        part: z.string().optional(),
        unit: z.string().min(1),
        price: z.number().min(0),
        supplier: z.string().optional(),
        source: z.string().min(1).describe("URL, quote reference, or \"past bid: <project>\""),
        date: z.string().describe("YYYY-MM-DD the price was seen or quoted"),
        status: z.enum(PRICE_STATUSES as [string, ...string[]]),
        project: z.string().optional().describe("Project the price was found for"),
        notes: z.string().optional(),
        key: z.string().optional().describe("Normally left out (computed from manufacturer + part, else the description)"),
      })).min(1).max(500),
    },
  }, run(async ({ entries }) => {
    const { added, duplicates } = await book.record(entries);
    return ok({ added: added.map((e) => ({ key: e.key, description: e.description, price: e.price, unit: e.unit, status: e.status, date: e.date })), duplicates: duplicates.length, note: "Run price_bid again to use them." });
  }));

  server.registerTool("price_bid", {
    description: "Price the takeoff open in this conversation (open_project first) into a draft bid: cable by the box from the cable order, connectivity from the conditions' materials rows, pull labor per location plus per additional cable from the chosen unit set, certification and labeling per link, mobilization, PM %, travel and mileage from site days, then material markup, back-solved labor cost (labor sells at the target bill rate), overhead, profit, SD excise when inputs.excise, bond apart when inputs.bond. Writes outputs/bid/bid.json in the project (a new revision every run; a new revision always clears an owner approval, so the owner must approve again). The reply leads with the base bid, the GAPS (missing prices, settings, labor units, unlinked devices: the bid is incomplete while any exist) and the FLAGS in phone-review order (links over 250 ft, over 295 ft, floor crossings, unit set, price flags). Fix gaps with find_prices / record_prices / update_settings / the takeoff, then run it again. inputs: omitted fields reuse the previous revision's inputs; the first run must state excise, bond, mobilizations, driveHoursPerDay, milesPerDay and vehicles. The bid is a draft: never tell the owner it is approved.",
    inputSchema: {
      project: projectArg,
      inputs: inputsSchema.optional().describe("Job inputs (omitted fields reuse the previous revision's)"),
    },
  }, run(async ({ project, inputs }) => {
    const m = await requireProject(deps, project);
    if (ctx.state.project !== m.id) {
      throw new UserError(`price_bid prices the takeoff open in this conversation: call open_project {project: "${m.id}"} first${ctx.state.project ? ` (this conversation has ${ctx.state.project} open)` : ""}.`);
    }
    const takeoff = ctx.session.exportPayload();
    const prev = await latestBid(m.id);
    const given = (inputs ?? {}) as Partial<BidJobInputs> & { extraLines?: z.infer<typeof lineSchema>[]; extraExpenses?: z.infer<typeof expenseSchema>[] };
    const merged = { ...(prev?.inputs ?? {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as Partial<BidJobInputs>;
    const missing = REQUIRED_INPUTS.filter((k) => merged[k] === undefined);
    if (missing.length) throw new UserError(`price_bid needs inputs.${missing.join(", inputs.")} (no earlier revision to reuse). Ask the owner or take them from the solicitation: excise (SD work without an exemption certificate), bond, mobilizations, driveHoursPerDay, milesPerDay, vehicles.`);
    const settings = await settingsStore.get();
    const jobInputs: BidJobInputs = {
      excise: merged.excise!,
      bond: merged.bond!,
      unitSet: merged.unitSet || settings.labor.defaultUnitSet,
      ...(merged.unitSetReason ? { unitSetReason: merged.unitSetReason } : {}),
      mobilizations: merged.mobilizations!,
      ...(merged.crewSize ? { crewSize: merged.crewSize } : {}),
      driveHoursPerDay: merged.driveHoursPerDay!,
      milesPerDay: merged.milesPerDay!,
      vehicles: merged.vehicles!,
      jobHours: merged.jobHours ?? [],
      extraLines: (merged.extraLines ?? []).map((l) => ({
        ...l,
        unitPrice: l.unitPrice ?? null,
        priceStatus: l.priceStatus ?? (l.unitPrice != null ? "estimate" : "missing"),
      })) as Omit<BidLine, "id" | "extended">[],
      extraExpenses: (merged.extraExpenses ?? []).map((x) => ({ ...x, unitCost: x.unitCost ?? null })) as Omit<ExpenseLine, "id" | "extended">[],
      laborOnlyConditions: merged.laborOnlyConditions ?? [],
    };
    const sheetLabels: Record<string, string> = {};
    for (const [k, s] of ctx.session.sheets ?? []) if (s?.sheetNumber) sheetLabels[k] = s.sheetNumber;
    const bid = priceBid({
      takeoff, settings, priceBook: await book.all(), inputs: jobInputs, project: m.id,
      revision: (prev?.revision ?? 0) + 1, now: now(), sheetLabels,
    });
    const file = path.join(deps.workspace.outputsDir(m.id), ...BID_OUTPUT.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(bid, null, 1)}\n`);
    let links: { path: string; url: string }[] = [];
    let pushNote: string | undefined;
    try {
      links = await linksForPushed(deps, m.id, await ctx.pushOutputs(m.id), ttl);
    } catch (e) {
      pushNote = `bid.json is written on the server but pushing it to the store failed (${e instanceof Error ? e.message : e}); the next tool call retries.`;
    }
    const approval = prev?.status === "approved" || prev?.approved
      ? `Revision ${bid.revision} replaces revision ${prev.approved?.revision ?? prev.revision}, which the owner had approved: that approval is cleared. Tell the owner the bid changed and needs their approval again on the project page.`
      : "Draft. Only the owner approves, on the project page; never tell the owner the bid is approved.";
    return ok({
      project: m.id,
      revision: bid.revision,
      status: bid.status,
      ...brief(bid),
      approval,
      output: `outputs/${BID_OUTPUT}`,
      ...(links.length ? { download: links } : {}),
      ...(pushNote ? { push_error: pushNote } : {}),
      next: bid.gaps.length
        ? "Close the gaps: find_prices, else look the price up and record_prices it (URL + today's date, or the quote reference); update_settings for missing settings from the playbook or the owner; link_run / hold_devices for unlinked devices. Then price_bid again."
        : "No gaps. Walk the owner through the flags first (long links, floor crossings), then produce the bid exports.",
    });
  }));

  server.registerTool("bid_summary", {
    description: "The latest draft bid of a project (outputs/bid/bid.json): revision, status (draft, or approved when the owner approved it on the project page), base bid, gaps, flags, ratios, totals and the job inputs used, with a download link. Does not need the project open.",
    inputSchema: { project: projectArg },
  }, run(async ({ project }) => {
    const m = await requireProject(deps, project);
    const bid = await latestBid(m.id);
    if (!bid) return ok({ project: m.id, bid: null, note: "No bid yet. open_project, take off, then price_bid." });
    const f = m.files.find((x) => x.kind === "output" && x.path.replace(/^outputs\//, "") === BID_OUTPUT);
    const download = f ? await deps.storage.presignGet(`projects/${m.id}/outputs/${BID_OUTPUT}`, ttl, { filename: "bid.json" }) : undefined;
    return ok({
      project: m.id,
      revision: bid.revision,
      created: bid.created,
      status: bid.status,
      ...(bid.approved ? { approved: bid.approved } : {}),
      ...brief(bid),
      inputs: bid.inputs,
      ...(download ? { download } : {}),
      note: bid.status === "approved" ? `The owner approved revision ${bid.approved?.revision ?? bid.revision}. Pricing again makes a new draft revision and clears the approval.` : "Draft: not approved. Only the owner approves, on the project page.",
    });
  }));
}

/** The server instructions' bid section (src/mcp.ts appends it). */
export const BID_INSTRUCTIONS = [
  "BIDS: Claude prices the owner's bids as drafts. Workflow:",
  "1. get_playbook and get_settings first, every bid; follow the playbook. Fill unset settings only from the playbook or the owner (update_settings; percentages are fractions, 0.15 = 15%).",
  "2. Take off in the project (open_project, counts, cable_setup, routes, link_run) as the playbook says.",
  "3. price_bid {project, inputs}: it writes outputs/bid/bid.json and returns the base bid, gaps and flags.",
  "4. Close gaps: find_prices; else look the price up online and record_prices it (URL + today's date), or from the owner's uploaded distributor quotes (quote reference); fix settings and unlinked devices. price_bid again until no gaps remain.",
  "5. Then the bid exports (workbook, proposal) and the marked set.",
  "Never claim the bid is approved: only the owner approves, on the project page, and any new price_bid revision clears an approval. The engine's set_pricing / export_estimate are the generic estimate, not the owner's bid.",
].join("\n");
