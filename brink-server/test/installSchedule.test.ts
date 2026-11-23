// The pull schedule: stable order, printed port labels, a CSV that label
// printers (and this parser) read back exactly, and the workbook's tabs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { LENGTH_NOT_MEASURED, SCHEDULE_COLUMNS, naturalCompare, pullScheduleRows, renderPullScheduleCsv, renderPullScheduleXlsx } from "../src/install/schedule.ts";
import { fixtureDesign, fixtureProject } from "./installFixture.ts";

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r" && s[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function designWithTrickyNotes() {
  const d = fixtureDesign();
  d.cables[0].notes = 'Pull with "D02", same sleeve, then tag';
  d.cables[1].notes = "Two-line\nnote";
  return d;
}

describe("pull schedule rows", () => {
  test("one row per cable in rack, room, label order", () => {
    const d = fixtureDesign();
    const rows = pullScheduleRows(d);
    assert.equal(rows.length, d.cables.length);
    assert.deepEqual(new Set(rows.map((r) => r.label)), new Set(d.cables.map((c) => c.label)));
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const k = naturalCompare(a.fromRack, b.fromRack) || naturalCompare(a.toRoom, b.toRoom) || naturalCompare(a.label, b.label);
      assert.ok(k <= 0, `${a.label} before ${b.label}`);
    }
    // stable: the same design gives the same order
    assert.deepEqual(pullScheduleRows(fixtureDesign()).map((r) => r.label), rows.map((r) => r.label));
    assert.equal(rows[0].fromRack, "RK-101");
    assert.equal(rows[rows.length - 1].fromRack, "RK-201");
  });

  test("ports print as the gear labels them, rooms come from the device, spares and null lengths kept", () => {
    const rows = pullScheduleRows(fixtureDesign());
    const d01 = rows.find((r) => r.label === "D01")!;
    assert.equal(d01.fromEquipment, "PP-A");
    assert.equal(d01.fromPort, "1");
    assert.equal(d01.toDevice, "DO-101");
    assert.equal(d01.toRoom, "Office 101");
    const s01 = rows.find((r) => r.label === "S01")!;
    assert.equal(s01.fromPort, "ZONE 1");
    const unmeasured = rows.filter((r) => r.lengthFt == null);
    assert.equal(unmeasured.length, 1);
    assert.equal(unmeasured[0].toDevice, "CAM-203");
    assert.ok(unmeasured[0].notes.includes(LENGTH_NOT_MEASURED));
    assert.equal(rows.filter((r) => r.spare).length, 3);
    const f01 = rows.find((r) => r.label === "F01")!;
    assert.equal(f01.toDevice, "FIB-201");
    assert.equal(f01.toRoom, "RK-201 IDF", "a non-device far end keeps its location");
  });
});

describe("pull schedule CSV", () => {
  test("header row, one row per cable, round-trips exactly", () => {
    const d = designWithTrickyNotes();
    const csv = renderPullScheduleCsv(d);
    assert.ok(csv.endsWith("\r\n"));
    assert.ok(!csv.startsWith("﻿"));
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed[0], [...SCHEDULE_COLUMNS]);
    assert.deepEqual(parsed[0], ["Label", "Kind", "Cable type", "From rack", "From equipment", "From port", "To device", "To room", "Length ft", "Spare", "Notes"]);
    const rows = pullScheduleRows(d);
    assert.equal(parsed.length, rows.length + 1);
    parsed.slice(1).forEach((p, i) => {
      const r = rows[i];
      assert.equal(p.length, SCHEDULE_COLUMNS.length);
      assert.deepEqual(p, [r.label, r.kind, r.cableType, r.fromRack, r.fromEquipment, r.fromPort, r.toDevice, r.toRoom, r.lengthFt == null ? "" : String(Math.round(r.lengthFt * 10) / 10), r.spare ? "Yes" : "", r.notes.replace(/\s*\n\s*/g, " / ")]);
    });
    const tricky = parsed.find((p) => p[0] === d.cables[0].label)!;
    assert.equal(tricky[10], 'Pull with "D02", same sleeve, then tag');
    assert.equal(parsed.find((p) => p[0] === d.cables[1].label)![10], "Two-line / note", "one physical line per cable");
    assert.equal(csv.split("\r\n").length, rows.length + 2);
    const cam = parsed.find((p) => p[6] === "CAM-203")!;
    assert.equal(cam[8], "", "null length stays blank");
  });

  test("UTF-8 text survives", () => {
    const d = fixtureDesign();
    d.cables[0].to.location = "Salle 101 – Café";
    d.devices.find((x) => x.tag === d.cables[0].to.equipment)!.room = "Salle 101 – Café";
    const csv = renderPullScheduleCsv(d);
    const bytes = new TextEncoder().encode(csv);
    assert.ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("Salle 101 – Café"));
  });
});

describe("pull schedule workbook", () => {
  test("All cables plus one tab per rack, frozen header and filters", async () => {
    const d = fixtureDesign();
    const bytes = await renderPullScheduleXlsx(d, fixtureProject());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["All cables", "RK-101", "RK-201"]);
    const rows = pullScheduleRows(d);
    const all = wb.getWorksheet("All cables")!;
    assert.equal(all.rowCount, rows.length + 1);
    assert.deepEqual((all.getRow(1).values as unknown[]).slice(1), [...SCHEDULE_COLUMNS]);
    let total = 0;
    for (const ws of wb.worksheets) {
      assert.equal(ws.views[0]?.state, "frozen");
      assert.equal((ws.views[0] as { ySplit?: number }).ySplit, 1);
      assert.ok(ws.autoFilter, `${ws.name} has filters`);
      if (ws.name !== "All cables") {
        total += ws.rowCount - 1;
        ws.eachRow((row, n) => { if (n > 1) assert.equal(row.getCell(4).value, ws.name); });
      }
    }
    assert.equal(total, rows.length);
    // lengths are numbers, the unmeasured one empty; spares say Yes
    const byLabel = new Map<string, ExcelJS.Row>();
    all.eachRow((row, n) => { if (n > 1) byLabel.set(String(row.getCell(1).value), row); });
    assert.equal(typeof byLabel.get("D01")!.getCell(9).value, "number");
    const cam = rows.find((r) => r.toDevice === "CAM-203")!;
    assert.equal(byLabel.get(cam.label)!.getCell(9).value, null);
    const spare = rows.find((r) => r.spare)!;
    assert.equal(byLabel.get(spare.label)!.getCell(10).value, "Yes");
  });
});
