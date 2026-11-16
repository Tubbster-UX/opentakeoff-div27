// The bid workbook: formulas with cached results that match the BidDraft to
// the cent, named-range levers, and (when LibreOffice is installed) a headless
// recalculation that proves the formulas compute what was cached and that a
// changed lever flows through to the base bid.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";
import { renderBidWorkbook, workbookDifferences, workbookModel } from "../src/bid/workbook.ts";
import { approve, fixtureBid, fixtureProject } from "./bidFixture.ts";
import type { BidDraft } from "../src/bidTypes.ts";

const cents = (n: unknown) => Math.round(Number(n) * 100) / 100;

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return wb;
}

/** Column-A label → row number on a sheet. */
function rowsByLabel(ws: ExcelJS.Worksheet, col = "A"): Map<string, number> {
  const out = new Map<string, number>();
  ws.eachRow((row, n) => {
    const v = row.getCell(col).value;
    if (typeof v === "string") out.set(v, n);
  });
  return out;
}

function names(wb: ExcelJS.Workbook): Map<string, string> {
  const model = wb.definedNames.model as { name: string; ranges: string[] }[];
  return new Map(model.map((d) => [d.name, d.ranges[0]]));
}

/** The cell a named range points at. */
function named(wb: ExcelJS.Workbook, name: string): ExcelJS.Cell {
  const ref = names(wb).get(name);
  assert.ok(ref, `named range ${name} exists`);
  const [sheet, addr] = ref.split("!");
  return wb.getWorksheet(sheet.replace(/^'|'$/g, ""))!.getCell(addr.replace(/\$/g, ""));
}

const resultOf = (c: ExcelJS.Cell) => (c.value as ExcelJS.CellFormulaValue).result;
const formulaOf = (c: ExcelJS.Cell) => (c.value as ExcelJS.CellFormulaValue).formula;

function summaryValue(wb: ExcelJS.Workbook, label: string): ExcelJS.Cell {
  const ws = wb.getWorksheet("Summary")!;
  const row = rowsByLabel(ws).get(label);
  assert.ok(row, `Summary row "${label}"`);
  return ws.getCell(`B${row}`);
}

const SUMMARY: [string, (b: BidDraft) => number | null][] = [
  ["Material", (b) => b.totals.material],
  ["Material markup", (b) => b.totals.materialMarkup],
  ["Expenses", (b) => b.totals.expenses],
  ["Labor hours", (b) => b.totals.laborHours],
  ["Labor cost entry ($/h)", (b) => b.totals.laborCostRate],
  ["Labor cost", (b) => b.totals.laborCost],
  ["Subtotal", (b) => b.totals.subtotal],
  ["Overhead", (b) => b.totals.overhead],
  ["Profit", (b) => b.totals.profit],
  ["Excise", (b) => b.totals.excise],
  ["BASE BID", (b) => b.totals.baseBid],
  ["Bond (separate add)", (b) => b.totals.bond],
  ["Total with bond", (b) => b.totals.totalWithBond],
  ["True cost (labor at true cost rate)", (b) => b.totals.trueCost],
  ["Effective sell rate ($/h)", (b) => b.totals.effectiveSellRate],
  ["$ per link", (b) => b.ratios.dollarsPerLink],
  ["Hours per link", (b) => b.ratios.hoursPerLink],
];

describe("renderBidWorkbook", () => {
  test("every Summary formula's cached result equals the BidDraft to the cent", async () => {
    const bid = fixtureBid();
    assert.deepEqual(workbookDifferences(bid), []);
    const wb = await load(await renderBidWorkbook(bid, fixtureProject()));
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "Assumptions", "Material", "Labor", "Expenses", "Quotes Needed", "Flags"]);
    for (const [label, want] of SUMMARY) {
      const c = summaryValue(wb, label);
      assert.ok(formulaOf(c), `${label} is a formula`);
      assert.equal(cents(resultOf(c)), want(bid), `${label}: cached ${resultOf(c)} vs bid ${want(bid)}`);
    }
    assert.equal(cents(resultOf(named(wb, "Chain"))), cents(bid.totals.chain));
  });

  test("every formula cell on every tab carries a cached result (raw sheet XML)", async () => {
    // exceljs drops 0 and "" results when it reads a file back, so check the XML itself
    const zip = unzipSync(await renderBidWorkbook(fixtureBid({ gap: true }), fixtureProject()));
    let formulas = 0;
    for (const [name, data] of Object.entries(zip)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      for (const cell of strFromU8(data).match(/<c [^>]*>(?:(?!<\/c>).)*<f>(?:(?!<\/c>).)*<\/c>/g) ?? []) {
        formulas++;
        const f = /<f>(.*?)<\/f>/.exec(cell)![1];
        const v = /<v>(.*?)<\/v>/.exec(cell)?.[1];
        // a blank ("") result cannot be cached; only a formula that can yield "" may lack a value
        if (!v) assert.match(f, /&quot;&quot;/, `${name} ${cell} has a cached result`);
      }
    }
    assert.ok(formulas > 40, `${formulas} formulas`);
  });

  test("formulas reference the right cells and the levers by name", async () => {
    const bid = fixtureBid();
    const wb = await load(await renderBidWorkbook(bid, fixtureProject()));
    // levers on Assumptions with their values
    assert.equal(names(wb).get("BillRate"), "Assumptions!$B$5");
    assert.equal(named(wb, "BillRate").value, 95);
    assert.equal(named(wb, "MaterialMarkupPct").value, 0.15);
    assert.equal(named(wb, "ExcisePct").value, 0.02041);
    assert.equal(named(wb, "ExciseOn").value, 1);
    assert.equal(named(wb, "CrewSize").value, 2);
    for (const n of ["TrueCostRate", "OverheadPct", "ProfitPct", "BondOn", "BondPct", "HoursPerDay", "DriveHoursPerDay", "MilesPerDay", "Vehicles", "MileageRate", "PmPct"]) {
      assert.match(names(wb).get(n)!, /^Assumptions!\$B\$\d+$/, n);
    }
    // the dependency chain from the levers to the base bid
    assert.equal(formulaOf(named(wb, "Chain")), "(1+OverheadPct)*(1+ProfitPct)*(1+ExcisePct*ExciseOn)");
    assert.equal(formulaOf(named(wb, "LaborCostRate")), "IFERROR(BillRate/Chain,0)");
    assert.equal(formulaOf(named(wb, "LaborCost")), "LaborHours*LaborCostRate");
    assert.equal(formulaOf(named(wb, "LaborHours")), "FieldHours+JobHours+PmHours+TravelHours");
    assert.equal(formulaOf(named(wb, "SiteDays")), "IFERROR(ROUNDUP(FieldHours/(CrewSize*HoursPerDay),0),0)");
    assert.equal(formulaOf(named(wb, "TravelHours")), "SiteDays*CrewSize*DriveHoursPerDay");
    assert.equal(formulaOf(named(wb, "PmHours")), "PmPct*FieldHours");
    assert.equal(resultOf(named(wb, "SiteDays")), 6);
    assert.match(names(wb).get("BaseBid")!, /^Summary!/);
    const sum = wb.getWorksheet("Summary")!;
    const rows = rowsByLabel(sum);
    assert.equal(formulaOf(summaryValue(wb, "Material markup")), "MaterialTotal*MaterialMarkupPct");
    assert.equal(formulaOf(summaryValue(wb, "BASE BID")), `B${rows.get("Subtotal")}+B${rows.get("Overhead")}+B${rows.get("Profit")}+B${rows.get("Excise")}`);
    assert.equal(formulaOf(summaryValue(wb, "Excise")), `(B${rows.get("Subtotal")}+B${rows.get("Overhead")}+B${rows.get("Profit")})*ExcisePct*ExciseOn`);
    assert.equal(formulaOf(summaryValue(wb, "Bond (separate add)")), "BaseBid*BondPct*BondOn");

    // Material: unit price read from the Assumptions price list, extended = qty × price, subtotal sums them
    const mat = wb.getWorksheet("Material")!;
    const matRows = rowsByLabel(mat);
    const r1 = matRows.get("L1")!;
    assert.match(formulaOf(mat.getCell(`H${r1}`)), /Assumptions!\$C\$\d+/);
    const priceCell = /Assumptions!\$C\$(\d+)/.exec(formulaOf(mat.getCell(`H${r1}`)))![1];
    const assumptions = wb.getWorksheet("Assumptions")!;
    assert.equal(assumptions.getCell(`C${priceCell}`).value, 412.5);
    assert.match(String(assumptions.getCell(`E${priceCell}`).value), /^Example Supply quote 1001 10\/19\/2026: Example Cable Co EC-6AP-1000 CAT6A plenum cable, 1000 ft box \$412\.50$/);
    assert.equal(formulaOf(mat.getCell(`I${r1}`)), `IF(OR($N${r1}="labor only",H${r1}=""),0,F${r1}*H${r1})`);
    assert.equal(resultOf(mat.getCell(`I${r1}`)), 2475);
    const total = named(wb, "MaterialTotal");
    assert.equal(formulaOf(total), `SUM(I${matRows.get("L1")}:I${matRows.get("L6")})`);
    assert.equal(mat.getCell(`N${matRows.get("L6")}`).value, "labor only");
    assert.equal(resultOf(mat.getCell(`I${matRows.get("L6")}`)) ?? 0, 0); // exceljs reads a cached 0 back as undefined

    // Labor and Expenses
    const lab = wb.getWorksheet("Labor")!;
    const labRows = rowsByLabel(lab);
    const w = labRows.get("h-wall-first")!;
    assert.equal(formulaOf(lab.getCell(`G${w}`)), `D${w}*F${w}`);
    assert.equal(labRows.has("pm"), false, "the PM line is replaced by the PM % formula");
    assert.equal(labRows.has("travel"), false, "the travel line is replaced by the travel formula");
    const exp = wb.getWorksheet("Expenses")!;
    const er = rowsByLabel(exp).get("mileage")!;
    assert.equal(formulaOf(exp.getCell(`C${er}`)), "SiteDays*Vehicles*MilesPerDay");
    assert.equal(formulaOf(exp.getCell(`E${er}`)), "MileageRate");
    assert.equal(cents(resultOf(exp.getCell(`F${er}`))), 504);

    // Price As Sent: blank inputs and a variance formula against the base bid
    const sent = rows.get("Price As Sent")!;
    assert.equal(sum.getCell(`B${sent}`).value, null);
    assert.equal(sum.getCell(`D${sent}`).value, null);
    assert.equal(formulaOf(sum.getCell(`F${sent}`)), `IF(B${sent}="","",B${sent}-BaseBid)`);
  });

  test("percent settings as fractions give the same workbook numbers", async () => {
    const a = workbookModel(fixtureBid());
    const b = workbookModel(fixtureBid({ fractions: true }));
    assert.equal(cents(a.baseBid), cents(b.baseBid));
    assert.equal(cents(a.pmHours), cents(b.pmHours));
  });

  test("DRAFT banner with the revision; approved shows the date", async () => {
    const draft = await load(await renderBidWorkbook(fixtureBid(), fixtureProject()));
    assert.match(String(draft.getWorksheet("Summary")!.getCell("A1").value), /^DRAFT — revision 3/);
    const ok = await load(await renderBidWorkbook(approve(fixtureBid()), fixtureProject()));
    assert.equal(ok.getWorksheet("Summary")!.getCell("A1").value, "APPROVED 2026-11-20 — revision 3");
  });

  test("Quotes Needed lists estimate / allowance / missing lines; Flags keeps order then gaps", async () => {
    const bid = fixtureBid({ gap: true });
    const wb = await load(await renderBidWorkbook(bid, fixtureProject()));
    const q = rowsByLabel(wb.getWorksheet("Quotes Needed")!);
    assert.ok(q.has("L3") && q.has("L5") && q.has("L7"));
    assert.ok(!q.has("L1") && !q.has("L6"));
    const quotes = wb.getWorksheet("Quotes Needed")!;
    assert.match(String(quotes.getCell(`I${q.get("L7")}`).value), /^No price yet/);
    const flags = wb.getWorksheet("Flags")!;
    const msgs: string[] = [];
    flags.eachRow((row) => { const v = row.getCell("C").value; if (typeof v === "string") msgs.push(v); });
    assert.deepEqual(msgs.slice(1, 5), bid.flags.map((f) => f.message));
    assert.ok(msgs.indexOf("Firestop sleeve kit") > 3);
    const summaryText: string[] = [];
    wb.getWorksheet("Summary")!.eachRow((row) => summaryText.push(String(row.getCell("A").value)));
    assert.ok(summaryText.some((t) => /no price/.test(t)));
  });

  test("a bid.json that disagrees with the formulas is called out on Flags", async () => {
    const bid = fixtureBid();
    bid.totals.baseBid = (bid.totals.baseBid ?? 0) + 10;
    assert.equal(workbookDifferences(bid).length, 1);
    const wb = await load(await renderBidWorkbook(bid, fixtureProject()));
    const text: string[] = [];
    wb.getWorksheet("Flags")!.eachRow((row) => row.eachCell((c) => text.push(String(c.value))));
    assert.ok(text.some((t) => /^Workbook check/.test(t)));
    assert.ok(text.some((t) => /^base bid: workbook/.test(t)));
  });

  const soffice = ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"].find((p) => existsSync(p));
  test("LibreOffice recalculation matches the cached results and follows a changed lever", { skip: soffice ? false : "LibreOffice (soffice) is not installed" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brink-wb-"));
    try {
      const bid = fixtureBid({ gap: true });
      const bytes = await renderBidWorkbook(bid, fixtureProject());
      await writeFile(path.join(dir, "base.xlsx"), bytes);
      // the same workbook with one lever changed (bill rate 95 → 120)
      const edited = await load(bytes);
      named(edited, "BillRate").value = 120;
      await edited.xlsx.writeFile(path.join(dir, "lever.xlsx"));
      // a throwaway LibreOffice profile that always recalculates OOXML on load
      await mkdir(path.join(dir, "profile", "user"), { recursive: true });
      await writeFile(path.join(dir, "profile", "user", "registrymodifications.xcu"),
        `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`);
      execFileSync(soffice!, [`-env:UserInstallation=file://${path.join(dir, "profile")}`, "--headless", "--calc", "--convert-to", "xlsx",
        "--outdir", path.join(dir, "out"), path.join(dir, "base.xlsx"), path.join(dir, "lever.xlsx")], { timeout: 120_000, stdio: "ignore" });

      const mine = await load(bytes);
      const lo = await load(await readFile(path.join(dir, "out", "base.xlsx")));
      let compared = 0;
      for (const ws of mine.worksheets) {
        ws.eachRow((row) => row.eachCell((c) => {
          const v = c.value as ExcelJS.CellFormulaValue | null;
          if (!v || typeof v !== "object" || !("formula" in v)) return;
          // exceljs reads a cached 0 back as undefined; "" results are not stored at all
          if (v.result === undefined && v.formula.includes('""')) return;
          const mineN = Number(v.result ?? 0);
          const theirs = lo.getWorksheet(ws.name)!.getCell(c.address).value as ExcelJS.CellFormulaValue;
          assert.ok(Math.abs(Number(theirs.result ?? 0) - mineN) < 1e-6, `${ws.name}!${c.address} =${v.formula}: cached ${v.result}, LibreOffice ${theirs.result}`);
          compared++;
        }));
      }
      assert.ok(compared > 40, `${compared} formula results compared`);
      for (const [label, want] of SUMMARY) {
        const w = want(bid);
        if (w != null) assert.equal(cents(resultOf(summaryValue(lo, label))), w, `LibreOffice ${label}`);
      }

      const lever = await load(await readFile(path.join(dir, "out", "lever.xlsx")));
      const moved = structuredClone(bid);
      moved.settings.labor.targetBillRate = 120;
      const expect = workbookModel(moved);
      assert.ok(expect.baseBid > (bid.totals.baseBid ?? 0) + 100);
      assert.equal(cents(resultOf(summaryValue(lever, "BASE BID"))), cents(expect.baseBid));
      assert.equal(cents(resultOf(named(lever, "LaborCostRate"))), cents(expect.laborCostRate));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
