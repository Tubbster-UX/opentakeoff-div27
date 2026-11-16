// The bid workbook in the owner's form (docs/design/HOSTED_SERVER.md, "Owner's
// quoting playbook"): a working model, so every number past the inputs is a
// formula, with the levers on an Assumptions tab under named ranges. Each
// formula cell also carries its cached result (computed here by the same math)
// so phones and previewers that never recalculate still show the numbers, and
// Excel recalculates everything on open.
//
// The cached results are checked against the BidDraft's own totals; any
// difference over a cent is listed on the Flags tab ("Workbook check") rather
// than hidden, because the formulas, not bid.json, are what the owner edits.
import ExcelJS from "exceljs";
import type { BidDraft, BidLine, ExpenseLine, HourLine } from "../bidTypes.ts";
import type { ProjectManifest } from "../types.ts";

/** Round to cents (half away from zero), as price.ts does at each money step. */
const c2 = (n: number): number => Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100;
import { approvedDate, isApproved, pctFraction, usDate } from "./format.ts";

type WS = ExcelJS.Worksheet;
type Result = number | string;

const NAVY = "FF1B3055";
const LIGHT = "FFE8EEF6";
const INPUT = "FFFFF4C2";
const DRAFT_FILL = "FFF9D9D9";
const OK_FILL = "FFDDF0DD";
const FMT = {
  money: '"$"#,##0.00',
  rate: '"$"#,##0.00',
  pct: "0.00%",
  num: "#,##0.##",
  hours: "#,##0.00",
  mult: "0.00000",
  int: "0",
};

/** The levers, in the order the Assumptions tab lists them. The name is the named range. */
const LEVERS = [
  { name: "BillRate", label: "Target bill rate", unit: "$ / hour", fmt: FMT.rate },
  { name: "TrueCostRate", label: "True cost rate (burdened)", unit: "$ / hour", fmt: FMT.rate },
  { name: "MaterialMarkupPct", label: "Material markup", unit: "% at the line", fmt: FMT.pct },
  { name: "OverheadPct", label: "Overhead", unit: "%", fmt: FMT.pct },
  { name: "ProfitPct", label: "Profit", unit: "%", fmt: FMT.pct },
  { name: "ExciseOn", label: "SD contractor's excise on", unit: "1 = on, 0 = off", fmt: FMT.int },
  { name: "ExcisePct", label: "Excise", unit: "% after profit", fmt: FMT.pct },
  { name: "BondOn", label: "Bond on", unit: "1 = on, 0 = off", fmt: FMT.int },
  { name: "BondPct", label: "Bond", unit: "% of base bid (separate add)", fmt: FMT.pct },
  { name: "CrewSize", label: "Crew", unit: "techs", fmt: FMT.num },
  { name: "HoursPerDay", label: "Hours per day", unit: "hours / tech / day", fmt: FMT.num },
  { name: "DriveHoursPerDay", label: "Drive hours per day", unit: "round trip / tech / site day", fmt: FMT.num },
  { name: "MilesPerDay", label: "Miles per day", unit: "round trip / vehicle / site day", fmt: FMT.num },
  { name: "Vehicles", label: "Vehicles", unit: "vehicles", fmt: FMT.num },
  { name: "MileageRate", label: "Mileage rate", unit: "$ / mile / vehicle", fmt: FMT.rate },
  { name: "PmPct", label: "Project management", unit: "% of field hours", fmt: FMT.pct },
  { name: "Links", label: "Certified links", unit: "links (for $/link)", fmt: FMT.num },
] as const;
type LeverName = (typeof LEVERS)[number]["name"];

/** Which job HourLine the Labor tab replaces with its own formula. */
function hourRole(h: HourLine): "pm" | "travel" | null {
  const keys = [h.id, h.unitId ?? ""].map((s) => s.toLowerCase());
  // price.ts writes "h-pm" and "h-travel".
  if (keys.some((k) => k === "pm" || k === "h-pm" || /^pm[_-]/.test(k) || k === "project_management")) return "pm";
  if (keys.some((k) => k === "travel" || k === "h-travel" || /^travel[_-]/.test(k))) return "travel";
  if (h.kind === "job" && /\bproject management\b|^pm\b/i.test(h.label)) return "pm";
  if (h.kind === "job" && /\btravel\b/i.test(h.label)) return "travel";
  return null;
}

const isMileage = (e: ExpenseLine) => /mileage/i.test(e.id) || /mileage/i.test(e.label);

const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : v);

/** The workbook's math in JS: produces every cached result (mirrors the formulas). */
export function workbookModel(bid: BidDraft) {
  const s = bid.settings;
  const lever: Record<LeverName, number | null> = {
    BillRate: s.labor.targetBillRate,
    TrueCostRate: s.labor.trueCostRate,
    MaterialMarkupPct: pctFraction(s.markup.materialPct),
    OverheadPct: pctFraction(s.markup.overheadPct),
    ProfitPct: pctFraction(s.markup.profitPct),
    ExciseOn: bid.inputs.excise ? 1 : 0,
    ExcisePct: pctFraction(s.markup.excisePct),
    BondOn: bid.inputs.bond ? 1 : 0,
    BondPct: pctFraction(s.markup.bondPct),
    CrewSize: bid.inputs.crewSize ?? s.labor.crewSize,
    HoursPerDay: s.labor.hoursPerDay,
    DriveHoursPerDay: bid.inputs.driveHoursPerDay,
    MilesPerDay: bid.inputs.milesPerDay,
    Vehicles: bid.inputs.vehicles,
    MileageRate: s.travel.mileageRate,
    PmPct: pctFraction(s.labor.pmPctOfField),
    Links: bid.ratios.links,
  };
  const v = (k: LeverName) => n0(lever[k]);

  const lineExt = (l: BidLine) => (l.laborOnly || l.unitPrice == null ? 0 : l.qty * l.unitPrice);
  const material = bid.lines.reduce((a, l) => a + lineExt(l), 0);

  const fieldLines = bid.hours.filter((h) => h.kind === "field");
  const jobLines = bid.hours.filter((h) => h.kind === "job" && !hourRole(h));
  // Hours round to 0.01 per line and per sum, as price.ts does.
  const fieldHours = c2(fieldLines.reduce((a, h) => a + c2(h.qty * h.hoursPer), 0));
  const jobHours = c2(jobLines.reduce((a, h) => a + c2(h.qty * h.hoursPer), 0));
  const pmHours = c2(v("PmPct") * fieldHours);
  const perDay = v("CrewSize") * v("HoursPerDay");
  const siteDays = perDay > 0 ? Math.ceil(fieldHours / perDay - 1e-9) : 0;
  const travelHours = c2(siteDays * v("CrewSize") * v("DriveHoursPerDay"));
  const laborHours = c2(fieldHours + jobHours + pmHours + travelHours);
  const chain = (1 + v("OverheadPct")) * (1 + v("ProfitPct")) * (1 + v("ExcisePct") * v("ExciseOn"));
  // Money rounds to cents at each step, exactly as price.ts does (the cost
  // entry too: the owner types it to the cent, e.g. 85.22).
  const laborCostRate = chain ? c2(v("BillRate") / chain) : 0;
  const laborCost = c2(laborHours * laborCostRate);

  const otherExpenses = bid.expenses.filter((e) => !isMileage(e));
  const mileageQty = siteDays * v("Vehicles") * v("MilesPerDay");
  const mileage = mileageQty * v("MileageRate");
  const expenses = mileage + otherExpenses.reduce((a, e) => a + (e.unitCost == null ? 0 : e.qty * e.unitCost), 0);

  // Material AND equipment/expenses carry the markup at the line (the playbook's chain).
  const materialMarkup = c2(material * v("MaterialMarkupPct")) + c2(expenses * v("MaterialMarkupPct"));
  const subtotal = c2(material + materialMarkup + expenses + laborCost);
  const overhead = c2(subtotal * v("OverheadPct"));
  const profit = c2((subtotal + overhead) * v("ProfitPct"));
  const excise = c2((subtotal + overhead + profit) * v("ExcisePct") * v("ExciseOn"));
  const baseBid = c2(subtotal + overhead + profit + excise);
  const bond = c2(baseBid * v("BondPct") * v("BondOn"));
  const totalWithBond = c2(baseBid + bond);
  const trueCost = c2(material + expenses + c2(laborHours * v("TrueCostRate")));
  const effectiveSellRate = laborHours ? c2((laborCost * chain) / laborHours) : 0;
  const links = v("Links");
  return {
    lever, lineExt, fieldLines, jobLines, otherExpenses,
    material, fieldHours, jobHours, pmHours, siteDays, travelHours, laborHours, chain, laborCostRate, laborCost,
    mileageQty, mileage, expenses, materialMarkup, subtotal, overhead, profit, excise, baseBid, bond, totalWithBond,
    trueCost, margin: baseBid - trueCost, effectiveSellRate,
    dollarsPerLink: links ? c2(baseBid / links) : null,
    hoursPerLink: links ? c2(laborHours / links) : null,
  };
}
export type WorkbookModel = ReturnType<typeof workbookModel>;

/** Where the workbook's numbers differ from bid.json by more than a cent (or 1e-6 for the chain). */
export function workbookDifferences(bid: BidDraft, m: WorkbookModel = workbookModel(bid)): string[] {
  const t = bid.totals;
  const pairs: [string, number | null, number | null, number][] = [
    ["material", m.material, t.material, 0.005],
    ["material markup", m.materialMarkup, t.materialMarkup, 0.005],
    ["expenses", m.expenses, t.expenses, 0.005],
    ["labor hours", m.laborHours, t.laborHours, 0.005],
    ["labor cost rate", m.laborCostRate, t.laborCostRate, 0.005],
    ["labor cost", m.laborCost, t.laborCost, 0.005],
    ["subtotal", m.subtotal, t.subtotal, 0.005],
    ["overhead", m.overhead, t.overhead, 0.005],
    ["profit", m.profit, t.profit, 0.005],
    ["excise", m.excise, t.excise, 0.005],
    ["base bid", m.baseBid, t.baseBid, 0.005],
    ["bond", m.bond, t.bond, 0.005],
    ["total with bond", m.totalWithBond, t.totalWithBond, 0.005],
    ["true cost", m.trueCost, t.trueCost, 0.005],
    ["effective sell rate", m.effectiveSellRate, t.effectiveSellRate, 0.005],
    ["chain", m.chain, t.chain, 1e-6],
    ["$/link", m.dollarsPerLink, bid.ratios.dollarsPerLink, 0.005],
    ["hours/link", m.hoursPerLink, bid.ratios.hoursPerLink, 0.005],
  ];
  const out: string[] = [];
  for (const [label, mine, theirs, tol] of pairs) {
    if (theirs == null || mine == null) continue;
    if (Math.abs(mine - theirs) > tol) out.push(`${label}: workbook ${round(mine, 4)} vs bid.json ${round(theirs, 4)}`);
  }
  return out;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// ── cell helpers ────────────────────────────────────────────────────────────

function put(ws: WS, addr: string, value: ExcelJS.CellValue, fmt?: string): ExcelJS.Cell {
  const c = ws.getCell(addr);
  c.value = value;
  if (fmt) c.numFmt = fmt;
  return c;
}

/** A formula cell with its cached result. */
function fx(ws: WS, addr: string, formula: string, result: Result | null, fmt?: string): ExcelJS.Cell {
  const c = ws.getCell(addr);
  c.value = { formula, result: result ?? "" } as ExcelJS.CellFormulaValue;
  if (fmt) c.numFmt = fmt;
  return c;
}

function header(ws: WS, row: number, labels: string[]): void {
  labels.forEach((l, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = l;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
}

function title(ws: WS, text: string, sub?: string): void {
  const c = ws.getCell("A1");
  c.value = text;
  c.font = { bold: true, size: 14, color: { argb: NAVY } };
  if (sub) {
    const s = ws.getCell("A2");
    s.value = sub;
    s.font = { italic: true, color: { argb: "FF555555" } };
  }
}

function totalRow(ws: WS, row: number, cols: number): void {
  for (let i = 1; i <= cols; i++) {
    const c = ws.getCell(row, i);
    c.font = { ...(c.font ?? {}), bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    c.border = { top: { style: "thin", color: { argb: NAVY } } };
  }
}

function widths(ws: WS, w: number[]): void {
  w.forEach((x, i) => { ws.getColumn(i + 1).width = x; });
}

const partOf = (l: { manufacturer?: string; part?: string }) => [l.manufacturer, l.part].filter(Boolean).join(" ");

/** "ADI 10/19/2026: Leviton 6AUJK-RW6 CAT6A jack $14.24" — the owner's price-note style. */
export function priceNote(l: Pick<BidLine, "source" | "priceDate" | "manufacturer" | "part" | "description" | "unitPrice">): string {
  const where = [l.source, usDate(l.priceDate)].filter(Boolean).join(" ");
  const what = [partOf(l), l.description].filter(Boolean).join(" ");
  const price = l.unitPrice == null ? "no price" : `$${l.unitPrice.toFixed(2)}`;
  return `${where ? `${where}: ` : ""}${what} ${price}`.trim();
}

// ── the workbook ────────────────────────────────────────────────────────────

export async function renderBidWorkbook(bid: BidDraft, project: ProjectManifest): Promise<Uint8Array> {
  const m = workbookModel(bid);
  const diffs = workbookDifferences(bid, m);
  const approved = isApproved(bid);

  const wb = new ExcelJS.Workbook();
  wb.creator = bid.settings.company.brand || bid.settings.company.legalName;
  wb.lastModifiedBy = wb.creator;
  wb.title = `${project.name} — bid r${bid.revision}`;
  wb.created = new Date(bid.created);
  wb.modified = new Date(bid.created);
  wb.calcProperties.fullCalcOnLoad = true;

  const summary = wb.addWorksheet("Summary", { properties: { tabColor: { argb: NAVY } } });
  const assumptions = wb.addWorksheet("Assumptions");
  const material = wb.addWorksheet("Material");
  const labor = wb.addWorksheet("Labor");
  const expenses = wb.addWorksheet("Expenses");
  const quotes = wb.addWorksheet("Quotes Needed");
  const flags = wb.addWorksheet("Flags");

  const name = (ws: WS, addr: string, rangeName: string) => {
    const abs = addr.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2");
    wb.definedNames.add(`${ws.name}!${abs}`, rangeName);
  };

  // ── Assumptions ──
  title(assumptions, `Assumptions — ${project.name}`, "Levers: change a value here and every tab follows. Percents are fractions shown as %.");
  header(assumptions, 4, ["Lever", "Value", "Unit / note", "Named range"]);
  let r = 5;
  for (const L of LEVERS) {
    put(assumptions, `A${r}`, L.label);
    const val = m.lever[L.name];
    const c = put(assumptions, `B${r}`, val == null ? null : val, L.fmt);
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
    put(assumptions, `C${r}`, val == null ? `${L.unit} — NOT SET in settings` : L.unit);
    put(assumptions, `D${r}`, L.name).font = { color: { argb: "FF777777" } };
    name(assumptions, `B${r}`, L.name);
    r++;
  }
  const unitSet = bid.settings.labor.unitSets.find((u) => u.id === bid.inputs.unitSet);
  put(assumptions, `A${r}`, "Labor unit set");
  put(assumptions, `B${r}`, unitSet?.label ?? bid.inputs.unitSet);
  put(assumptions, `C${r}`, bid.inputs.unitSetReason ?? "");
  r++;
  put(assumptions, `A${r}`, "Mobilizations");
  put(assumptions, `B${r}`, bid.inputs.mobilizations, FMT.num);
  r += 2;

  // price list: one row per distinct priced item; Material and Quotes Needed read prices from here
  put(assumptions, `A${r}`, "Price list").font = { bold: true, size: 12, color: { argb: NAVY } };
  r++;
  header(assumptions, r, ["Item", "Unit", "Price", "Status", "Source / date note"]);
  r++;
  const priceRow = new Map<string, number>();
  const lineRow = new Map<string, number>(); // line id → price list row
  for (const l of bid.lines) {
    if (l.laborOnly) continue;
    const key = JSON.stringify([l.manufacturer ?? "", l.part ?? "", l.description, l.unit, l.unitPrice, l.priceStatus, l.source ?? "", l.priceDate ?? ""]);
    let row = priceRow.get(key);
    if (row === undefined) {
      row = r++;
      priceRow.set(key, row);
      put(assumptions, `A${row}`, [partOf(l), l.description].filter(Boolean).join(" — "));
      put(assumptions, `B${row}`, l.unit);
      const pc = put(assumptions, `C${row}`, l.unitPrice, FMT.money);
      pc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
      put(assumptions, `D${row}`, l.priceStatus);
      put(assumptions, `E${row}`, priceNote(l));
      if (l.priceStatus === "missing") assumptions.getRow(row).font = { color: { argb: "FFB00020" } };
    }
    lineRow.set(l.id, row);
  }
  if (!priceRow.size) put(assumptions, `A${r++}`, "(no priced material lines)");
  widths(assumptions, [44, 14, 30, 20, 70]);
  assumptions.views = [{ state: "frozen", ySplit: 4 }];

  // ── Material ──
  title(material, `Material — ${project.name}`, "Qty × unit price; the price comes from the Assumptions price list. Labor-only lines carry no material.");
  header(material, 4, ["Line", "Section", "Description", "Manufacturer", "Part", "Qty", "Unit", "Unit price", "Extended", "Status", "Source", "Price date", "Basis", "Labor only"]);
  r = 5;
  const matFirst = r;
  for (const l of bid.lines) {
    put(material, `A${r}`, l.id);
    put(material, `B${r}`, l.section);
    put(material, `C${r}`, l.description);
    put(material, `D${r}`, l.manufacturer ?? "");
    put(material, `E${r}`, l.part ?? "");
    put(material, `F${r}`, l.qty, FMT.num);
    put(material, `G${r}`, l.unit);
    const pr = lineRow.get(l.id);
    if (pr !== undefined) {
      fx(material, `H${r}`, `IF(Assumptions!$C$${pr}="","",Assumptions!$C$${pr})`, l.unitPrice ?? "", FMT.money);
    } else {
      put(material, `H${r}`, l.unitPrice, FMT.money);
    }
    fx(material, `I${r}`, `IF(OR($N${r}="labor only",H${r}=""),0,F${r}*H${r})`, m.lineExt(l), FMT.money);
    put(material, `J${r}`, l.laborOnly ? "labor only" : l.priceStatus);
    put(material, `K${r}`, l.source ?? "");
    put(material, `L${r}`, l.priceDate ?? "");
    put(material, `M${r}`, l.basis ?? "");
    put(material, `N${r}`, l.laborOnly ? "labor only" : "");
    if (!l.laborOnly && l.priceStatus === "missing") material.getRow(r).font = { color: { argb: "FFB00020" } };
    r++;
  }
  const matLast = r - 1;
  put(material, `C${r}`, "Material subtotal (priced lines, labor-only excluded)");
  fx(material, `I${r}`, matLast >= matFirst ? `SUM(I${matFirst}:I${matLast})` : "0", m.material, FMT.money);
  totalRow(material, r, 14);
  name(material, `I${r}`, "MaterialTotal");
  widths(material, [12, 13, 42, 16, 18, 9, 8, 12, 14, 11, 28, 12, 22, 11]);
  material.views = [{ state: "frozen", ySplit: 4 }];

  // ── Labor ──
  title(labor, `Labor — ${project.name}`, "Qty × hours per unit. PM, site days, travel, the chain and the labor cost entry are formulas on the Assumptions levers.");
  header(labor, 4, ["Line", "Label", "Kind", "Qty", "Unit", "Hours per", "Hours", "Unit id"]);
  r = 5;
  const hourRow = (h: HourLine) => {
    put(labor, `A${r}`, h.id);
    put(labor, `B${r}`, h.label);
    put(labor, `C${r}`, h.kind);
    put(labor, `D${r}`, h.qty, FMT.num);
    put(labor, `E${r}`, h.unit);
    put(labor, `F${r}`, h.hoursPer, FMT.hours);
    fx(labor, `G${r}`, `ROUND(D${r}*F${r},2)`, c2(h.qty * h.hoursPer), FMT.hours);
    put(labor, `H${r}`, h.unitId ?? "");
    r++;
  };
  const fieldFirst = r;
  for (const h of m.fieldLines) hourRow(h);
  const fieldLast = r - 1;
  put(labor, `B${r}`, "Field hours");
  fx(labor, `G${r}`, fieldLast >= fieldFirst ? `ROUND(SUM(G${fieldFirst}:G${fieldLast}),2)` : "0", m.fieldHours, FMT.hours);
  totalRow(labor, r, 8);
  name(labor, `G${r}`, "FieldHours");
  r += 2;
  const jobFirst = r;
  for (const h of m.jobLines) hourRow(h);
  const jobLast = r - 1;
  put(labor, `B${r}`, "Job hours (mobilization, submittals, cleanup, ...)");
  fx(labor, `G${r}`, jobLast >= jobFirst ? `ROUND(SUM(G${jobFirst}:G${jobLast}),2)` : "0", m.jobHours, FMT.hours);
  totalRow(labor, r, 8);
  name(labor, `G${r}`, "JobHours");
  r += 2;
  const computed: [string, string, string, number, string][] = [
    ["PmHours", "Project management (PM % × field hours)", "ROUND(PmPct*FieldHours,2)", m.pmHours, FMT.hours],
    ["SiteDays", "Site days = ROUNDUP(field ÷ (crew × hours/day))", "IFERROR(ROUNDUP(FieldHours/(CrewSize*HoursPerDay),0),0)", m.siteDays, FMT.int],
    ["TravelHours", "Travel hours = site days × crew × drive hours", "ROUND(SiteDays*CrewSize*DriveHoursPerDay,2)", m.travelHours, FMT.hours],
    ["LaborHours", "Total labor hours", "ROUND(FieldHours+JobHours+PmHours+TravelHours,2)", m.laborHours, FMT.hours],
    ["Chain", "Chain = (1+overhead)(1+profit)(1+excise × on)", "(1+OverheadPct)*(1+ProfitPct)*(1+ExcisePct*ExciseOn)", m.chain, FMT.mult],
    ["LaborCostRate", "Labor cost entry = bill rate ÷ chain", "IFERROR(ROUND(BillRate/Chain,2),0)", m.laborCostRate, FMT.rate],
    ["LaborCost", "Labor cost = hours × cost entry", "ROUND(LaborHours*LaborCostRate,2)", m.laborCost, FMT.money],
  ];
  for (const [nm, label, f, val, fmt] of computed) {
    put(labor, `B${r}`, label);
    fx(labor, `G${r}`, f, val, fmt);
    put(labor, `H${r}`, nm).font = { color: { argb: "FF777777" } };
    name(labor, `G${r}`, nm);
    if (nm === "LaborHours" || nm === "LaborCost") totalRow(labor, r, 8);
    r++;
  }
  widths(labor, [14, 48, 8, 10, 11, 11, 14, 16]);
  labor.views = [{ state: "frozen", ySplit: 4 }];

  // ── Expenses ──
  title(expenses, `Expenses — ${project.name}`, "Mileage = site days × vehicles × miles per day × mileage rate.");
  header(expenses, 4, ["Line", "Label", "Qty", "Unit", "Unit cost", "Extended"]);
  r = 5;
  const expFirst = r;
  const mil = bid.expenses.find(isMileage);
  put(expenses, `A${r}`, mil?.id ?? "mileage");
  put(expenses, `B${r}`, mil?.label ?? "Mileage");
  fx(expenses, `C${r}`, "SiteDays*Vehicles*MilesPerDay", m.mileageQty, FMT.num);
  put(expenses, `D${r}`, "miles");
  fx(expenses, `E${r}`, "MileageRate", m.lever.MileageRate ?? 0, FMT.rate);
  fx(expenses, `F${r}`, `C${r}*E${r}`, m.mileage, FMT.money);
  r++;
  for (const e of m.otherExpenses) {
    put(expenses, `A${r}`, e.id);
    put(expenses, `B${r}`, e.label);
    put(expenses, `C${r}`, e.qty, FMT.num);
    put(expenses, `D${r}`, e.unit);
    put(expenses, `E${r}`, e.unitCost, FMT.money);
    fx(expenses, `F${r}`, `IF(E${r}="",0,C${r}*E${r})`, e.unitCost == null ? 0 : e.qty * e.unitCost, FMT.money);
    if (e.unitCost == null) expenses.getRow(r).font = { color: { argb: "FFB00020" } };
    r++;
  }
  const expLast = r - 1;
  put(expenses, `B${r}`, "Expenses total");
  fx(expenses, `F${r}`, `SUM(F${expFirst}:F${expLast})`, m.expenses, FMT.money);
  totalRow(expenses, r, 6);
  name(expenses, `F${r}`, "ExpensesTotal");
  widths(expenses, [14, 36, 10, 10, 12, 14]);
  expenses.views = [{ state: "frozen", ySplit: 4 }];

  // ── Summary ──
  summary.mergeCells("A1:F1");
  const banner = summary.getCell("A1");
  banner.value = approved
    ? `APPROVED ${approvedDate(bid)} — revision ${bid.revision}`
    : `DRAFT — revision ${bid.revision} — not for submission until the owner approves on the project page`;
  banner.font = { bold: true, size: 13, color: { argb: approved ? "FF1E6B1E" : "FFB00020" } };
  banner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: approved ? OK_FILL : DRAFT_FILL } };
  banner.alignment = { vertical: "middle", horizontal: "center" };
  summary.getRow(1).height = 24;
  put(summary, "A2", project.name).font = { bold: true, size: 14, color: { argb: NAVY } };
  put(summary, "A3", `Revision ${bid.revision} · priced ${bid.created.slice(0, 10)} · ${bid.settings.company.brand}`).font = { italic: true, color: { argb: "FF555555" } };
  header(summary, 5, ["Item", "Amount", "Formula"]);
  r = 6;
  const rowOf: Record<string, number> = {};
  const sumRows: [string, string, string, number | null, string, boolean?][] = [
    ["material", "Material", "MaterialTotal", m.material, FMT.money],
    ["markup", "Material + equipment markup", "ROUND(MaterialTotal*MaterialMarkupPct,2)+ROUND(ExpensesTotal*MaterialMarkupPct,2)", m.materialMarkup, FMT.money],
    ["expenses", "Expenses", "ExpensesTotal", m.expenses, FMT.money],
    ["hours", "Labor hours", "LaborHours", m.laborHours, FMT.hours],
    ["rate", "Labor cost entry ($/h)", "LaborCostRate", m.laborCostRate, FMT.rate],
    ["labor", "Labor cost", "LaborCost", m.laborCost, FMT.money],
    ["subtotal", "Subtotal", "ROUND(B{material}+B{markup}+B{expenses}+B{labor},2)", m.subtotal, FMT.money, true],
    ["overhead", "Overhead", "ROUND(B{subtotal}*OverheadPct,2)", m.overhead, FMT.money],
    ["profit", "Profit", "ROUND((B{subtotal}+B{overhead})*ProfitPct,2)", m.profit, FMT.money],
    ["excise", "Excise", "ROUND((B{subtotal}+B{overhead}+B{profit})*ExcisePct*ExciseOn,2)", m.excise, FMT.money],
    ["base", "BASE BID", "ROUND(B{subtotal}+B{overhead}+B{profit}+B{excise},2)", m.baseBid, FMT.money, true],
    ["bond", "Bond (separate add)", "ROUND(BaseBid*BondPct*BondOn,2)", m.bond, FMT.money],
    ["withbond", "Total with bond", "ROUND(BaseBid+B{bond},2)", m.totalWithBond, FMT.money],
    ["truecost", "True cost (labor at true cost rate)", "ROUND(MaterialTotal+ExpensesTotal+ROUND(LaborHours*TrueCostRate,2),2)", m.trueCost, FMT.money],
    ["margin", "Margin over true cost", "BaseBid-B{truecost}", m.margin, FMT.money],
    ["sell", "Effective sell rate ($/h)", "IFERROR(ROUND(LaborCost*Chain/LaborHours,2),0)", m.effectiveSellRate, FMT.rate],
    ["links", "Links", "Links", m.lever.Links ?? 0, FMT.num],
    ["perlink", "$ per link", "IFERROR(ROUND(BaseBid/Links,2),\"\")", m.dollarsPerLink, FMT.money],
    ["hperlink", "Hours per link", "IFERROR(ROUND(LaborHours/Links,2),\"\")", m.hoursPerLink, FMT.hours],
  ];
  for (const [key, , ] of sumRows) rowOf[key] = r++;
  for (const [key, label, f0, val, fmt, strong] of sumRows) {
    const row = rowOf[key];
    const f = f0.replace(/\{(\w+)\}/g, (_, k: string) => String(rowOf[k]));
    put(summary, `A${row}`, label);
    fx(summary, `B${row}`, f, val, fmt);
    put(summary, `C${row}`, f).font = { color: { argb: "FF888888" } };
    if (key === "base") name(summary, `B${row}`, "BaseBid");
    if (strong) totalRow(summary, row, 3);
    if (key === "base") {
      summary.getCell(`A${row}`).font = { bold: true, size: 13, color: { argb: NAVY } };
      summary.getCell(`B${row}`).font = { bold: true, size: 13, color: { argb: NAVY } };
    }
  }
  r += 1;
  const sentRow = r;
  put(summary, `A${sentRow}`, "Price As Sent").font = { bold: true };
  put(summary, `B${sentRow}`, null, FMT.money).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
  put(summary, `C${sentRow}`, "Date sent").font = { bold: true };
  put(summary, `D${sentRow}`, null, "yyyy-mm-dd").fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
  put(summary, `E${sentRow}`, "Variance vs base bid").font = { bold: true };
  fx(summary, `F${sentRow}`, `IF(B${sentRow}="","",B${sentRow}-BaseBid)`, "", FMT.money);
  name(summary, `B${sentRow}`, "PriceAsSent");
  r += 2;
  const notes: string[] = [];
  if (bid.gaps.length) notes.push(`${bid.gaps.length} item(s) have no price — the base bid is incomplete (Flags tab).`);
  if (bid.totals.baseBid == null) notes.push("bid.json carries no base bid: a rate or markup in settings is not set (Assumptions shows NOT SET).");
  if (diffs.length) notes.push(`The formulas differ from bid.json in ${diffs.length} place(s); see "Workbook check" on the Flags tab.`);
  for (const n of notes) put(summary, `A${r++}`, n).font = { color: { argb: "FFB00020" } };
  widths(summary, [36, 16, 52, 16, 20, 16]);

  // ── Quotes Needed ──
  title(quotes, `Quotes Needed — ${project.name}`, "Every line still on an estimate, an allowance or no price. Get these quoted before the price is sent.");
  header(quotes, 4, ["Line", "Description", "Manufacturer / part", "Qty", "Unit", "Current price", "Status", "Source / date", "What to get quoted"]);
  r = 5;
  for (const l of bid.lines) {
    if (l.laborOnly || l.priceStatus === "live") continue;
    put(quotes, `A${r}`, l.id);
    put(quotes, `B${r}`, l.description);
    put(quotes, `C${r}`, partOf(l));
    put(quotes, `D${r}`, l.qty, FMT.num);
    put(quotes, `E${r}`, l.unit);
    const pr = lineRow.get(l.id);
    if (pr !== undefined) fx(quotes, `F${r}`, `IF(Assumptions!$C$${pr}="","",Assumptions!$C$${pr})`, l.unitPrice ?? "", FMT.money);
    else put(quotes, `F${r}`, l.unitPrice, FMT.money);
    put(quotes, `G${r}`, l.priceStatus);
    put(quotes, `H${r}`, [l.source, usDate(l.priceDate)].filter(Boolean).join(" "));
    const item = `${l.qty} ${l.unit} ${[partOf(l), l.description].filter(Boolean).join(" ")}`;
    put(quotes, `I${r}`, l.priceStatus === "missing" ? `No price yet: get a supplier quote for ${item}`
      : l.priceStatus === "allowance" ? `Allowance only: get a firm quote for ${item}`
        : `Estimate: confirm with a supplier quote for ${item}`);
    r++;
  }
  for (const e of bid.expenses) {
    if (e.unitCost != null || isMileage(e)) continue;
    put(quotes, `A${r}`, e.id);
    put(quotes, `B${r}`, e.label);
    put(quotes, `D${r}`, e.qty, FMT.num);
    put(quotes, `E${r}`, e.unit);
    put(quotes, `G${r}`, "missing");
    put(quotes, `I${r}`, `No cost yet: get a quote for ${e.qty} ${e.unit} ${e.label}`);
    r++;
  }
  if (r === 5) put(quotes, "A5", "Nothing to quote: every line has a live price.");
  widths(quotes, [12, 40, 26, 9, 8, 13, 11, 26, 60]);
  quotes.views = [{ state: "frozen", ySplit: 4 }];

  // ── Flags ──
  title(flags, `Flags — ${project.name}`, "In review order: long links and floor crossings first, then the rest, then items with no price.");
  header(flags, 4, ["#", "Kind", "Message", "Ref"]);
  r = 5;
  bid.flags.forEach((f, i) => {
    put(flags, `A${r}`, i + 1);
    put(flags, `B${r}`, f.kind);
    put(flags, `C${r}`, f.message).alignment = { wrapText: true, vertical: "top" };
    put(flags, `D${r}`, f.ref ?? "");
    r++;
  });
  if (!bid.flags.length) put(flags, `C${r++}`, "No flags.");
  r++;
  put(flags, `A${r++}`, "Gaps (no price — the bid is incomplete while any remain)").font = { bold: true, color: { argb: "FFB00020" } };
  header(flags, r++, ["#", "Ref", "Description", "Reason"]);
  bid.gaps.forEach((g, i) => {
    put(flags, `A${r}`, i + 1);
    put(flags, `B${r}`, g.ref);
    put(flags, `C${r}`, g.description).alignment = { wrapText: true, vertical: "top" };
    put(flags, `D${r}`, g.reason);
    r++;
  });
  if (!bid.gaps.length) put(flags, `C${r++}`, "No gaps.");
  if (diffs.length) {
    r++;
    put(flags, `A${r++}`, "Workbook check (formulas vs bid.json)").font = { bold: true, color: { argb: "FFB00020" } };
    for (const d of diffs) put(flags, `C${r++}`, d);
  }
  widths(flags, [6, 18, 80, 24]);

  for (const ws of [summary, assumptions, material, labor, expenses, quotes, flags]) {
    ws.pageSetup = { orientation: ws === summary ? "portrait" : "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
