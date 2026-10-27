import { describe, expect, it } from "vitest";
import { bomToCsv } from "../src/bom.js";
import { parseCatalogMap } from "../src/catalog.js";
import { merge } from "../src/pipeline.js";
import { formatEsLength } from "../src/schematic.js";
import { validateSchematic } from "../src/validate.js";
import { CURRENT_SCHEMA_VERSION, DEVICE_TYPES } from "../src/vendor/esEnums.generated.js";
import type { DeviceData } from "../src/vendor/esTypes.js";
import { catalog, clone, load } from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const brink = (data: unknown): Record<string, any> => (data as { brink: Record<string, any> }).brink;

const codes = (r: ReturnType<typeof merge>) => r.issues.map((i) => `${i.severity}:${i.code}`);

describe("cable data (report cross-check)", () => {
  it("takes every run from the report and finds its route LF in the takeoff", () => {
    const r = merge(load("div27-sample"), catalog());
    expect(r.cable.runs).toHaveLength(12);
    expect(codes(r)).not.toContain("error:route_lf_mismatch");
    const pole = r.cable.runs.find((x) => x.overLength)!;
    expect(pole).toMatchObject({ conditionKey: "CAM-1", perCableLf: 335.01, limitFt: 295 });
  });

  it("a report whose route LF drifted from the takeoff is an error", () => {
    const input = load("div27-sample");
    const report = clone(input.report!);
    report.cable!.runs[0].route_lf += 5;
    const r = merge({ ...input, report }, catalog());
    expect(codes(r)).toContain("error:route_lf_mismatch");
  });

  it("cable runs without a report are an error, not zero cable", () => {
    const r = merge(load("div27-sample", false), catalog());
    expect(codes(r)).toContain("error:report_missing");
    expect(r.bom.lines.filter((l) => l.kind === "cable")).toHaveLength(0);
  });

  it("a report from another takeoff is refused as a mismatch", () => {
    const r = merge({ ...load("div27-sample"), report: load("div27-minimal").report }, catalog());
    expect(codes(r)).toContain("error:report_mismatch");
  });

  it("surfaces OpenTakeoff's exclusions as warnings", () => {
    const c = codes(merge(load("div27-sample"), catalog()));
    for (const code of ["unlinked_device", "unlinked_route", "held_device", "over_length", "review_pending", "ot_warning"]) expect(c).toContain(`warning:${code}`);
  });
});

describe("catalog map (Task 3)", () => {
  it("every condition in every fixture resolves to a row or is reported unmapped", () => {
    for (const name of ["div27-sample", "div27-minimal"] as const) {
      const input = load(name);
      const r = merge(input, catalog());
      for (const c of input.takeoff.conditions) {
        expect(r.mapping.byCondition.has(c.id) || r.mapping.unmapped.includes(c.finish_tag), `${name} ${c.finish_tag}`).toBe(true);
      }
      expect(r.mapping.unmapped).toEqual([]);
    }
  });

  it("an unmapped condition is an error and keeps its quantities on the BOM", () => {
    const map = catalog();
    map.rows = map.rows.filter((r) => r.conditionKey !== "CAM-1");
    const r = merge(load("div27-sample"), map);
    expect(r.mapping.unmapped).toEqual(["CAM-1"]);
    expect(codes(r)).toContain("error:unmapped_condition");
    const line = r.bom.lines.find((l) => l.kind === "device" && l.conditionKey === "CAM-1")!;
    expect(line).toMatchObject({ qty: 3, mappingStatus: "unmapped", esDeviceType: null });
    expect(r.bom.lines.filter((l) => l.kind === "cable" && l.conditionKey === "CAM-1").length).toBe(2);
    expect(r.schematic.notDrawn).toEqual({ "CAM-1": 3 });
    const note = r.schematic.file.nodes.find((n) => n.type === "note")!;
    expect((note.data as { html: string }).html).toContain("Not drawn: 3 x CAM-1");
  });

  it("an invalid EasySchematic deviceType or connector is an error", () => {
    const map = clone(catalog());
    map.rows.find((r) => r.conditionKey === "WAP-1")!.esDeviceType = "wifi-thing";
    map.rows.find((r) => r.conditionKey === "CAM-1")!.port!.connectorType = "rj-45";
    const c = codes(merge(load("div27-sample"), parseCatalogMap(map)));
    expect(c).toContain("error:invalid_device_type");
    expect(c).toContain("error:invalid_connector_type");
  });

  it("a row whose kind disagrees with the condition is an error", () => {
    const map = clone(catalog());
    map.rows.find((r) => r.conditionKey === "TRUNK")!.kind = "device";
    expect(codes(merge(load("div27-sample"), map))).toContain("error:mapping_kind_mismatch");
  });

  it("flags a cable type different from the row's expectation", () => {
    // the minimal fixture's DATA-1 says CAT6A; the seed row expects CAT6A CMP
    expect(codes(merge(load("div27-minimal"), catalog()))).toContain("warning:cable_type_mismatch");
  });
});

describe("BOM (Task 4)", () => {
  const r = merge(load("div27-sample"), catalog());
  const report = load("div27-sample").report!;

  it("device counts equal the rollup", () => {
    for (const roll of r.rollups.filter((x) => x.kind === "device" || x.kind === "tr")) {
      const line = r.bom.lines.find((l) => (l.kind === "device" || l.kind === "tr") && l.conditionKey === roll.finishTag)!;
      expect(line.qty, roll.finishTag).toBe(roll.net.count);
    }
    expect(r.bom.totals).toMatchObject({ devices: 16, trs: 2 });
  });

  it("cable LF equals OpenTakeoff's measured cable summary", () => {
    const t = report.cable!.totals;
    expect(r.bom.totals).toMatchObject({ pulls: t.pulls, cables: t.cables, cableNetLf: t.cable_lf, cableOrderLf: t.cable_lf_order });
    expect(r.bom.totals).toMatchObject({ pulls: 14, cables: 23, cableNetLf: 1795.13, cableOrderLf: 2007.79 });
    for (const l of r.bom.lines.filter((x) => x.kind === "cable")) expect(l.provenance).toMatchObject({ source: "opentakeoff", length: "measured" });
  });

  it("carries box rounding, pathway and materials from OpenTakeoff", () => {
    const cat6a = r.bom.lines.find((l) => l.kind === "cable_order" && l.cableType === "CAT6A CMP")!;
    expect(cat6a).toMatchObject({ qty: 2, unit: "BOX", packageFt: 1000, purchasedLf: 2000, orderLf: 1341.2 });
    const acs = r.bom.lines.find((l) => l.kind === "cable_order" && l.cableType === "18/4 SHLD CMP")!;
    expect(acs).toMatchObject({ boxes: null, unit: "LF", qty: 151.47 });
    expect(r.bom.lines.find((l) => l.kind === "pathway" && l.conditionKey === "TRUNK")).toMatchObject({ qty: 52.81, unit: "LF" });
    expect(r.bom.lines.find((l) => l.kind === "material" && l.description === "CAT6A jack")).toMatchObject({ qty: 10 });
  });

  it("every issue is a line; CSV has one row per line", () => {
    const issueLines = r.bom.lines.filter((l) => l.kind === "issue");
    expect(issueLines).toHaveLength(r.issues.length);
    const csv = bomToCsv(r.bom).trim().split("\n");
    expect(csv).toHaveLength(r.bom.lines.length + 1);
    expect(csv[0].split(",").slice(0, 6)).toEqual(["lineNo", "kind", "conditionKey", "description", "qty", "unit"]);
  });
});

describe("EasySchematic file (Task 5)", () => {
  const r = merge(load("div27-sample"), catalog(), { date: "2026-10-27" });
  const file = r.schematic.file;
  const devices = file.nodes.filter((n) => n.type === "device");

  it("targets the vendored live schema version and validates", () => {
    expect(file.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(validateSchematic(file)).toEqual([]);
    for (const d of devices) expect(DEVICE_TYPES as readonly string[]).toContain((d.data as DeviceData).deviceType);
  });

  it("device count matches the BOM", () => {
    for (const l of r.bom.lines.filter((x) => x.kind === "device" || x.kind === "tr")) {
      const n = devices.filter((d) => brink(d.data).conditionKey === l.conditionKey).length;
      expect(n, l.conditionKey).toBe(l.qty);
    }
    expect(devices).toHaveLength(18);
  });

  it("one connection per cable, each carrying its run's measured per-cable LF", () => {
    expect(file.edges).toHaveLength(r.bom.totals.cables);
    const runs = new Map(r.cable.runs.map((x) => [x.runId, x]));
    for (const e of file.edges) {
      const run = runs.get(brink(e.data).runId)!;
      expect(e.data!.cableLength).toBe(formatEsLength(run.perCableLf!));
      expect(e.data!.label).toBe(run.cableType);
    }
    expect(file.edges.some((e) => e.data!.cableLength === "335.0 ft")).toBe(true);
  });

  it("patch panels are sized to the cables homed at each TR", () => {
    const panels = devices.filter((d) => (d.data as DeviceData).deviceType === "patch-panel");
    const ports = Object.fromEntries(panels.map((p) => [brink(p.data).tr, (p.data as DeviceData).ports.length]));
    const homed = (tr: string) => file.edges.filter((e) => panels.find((p) => p.id === e.target && brink(p.data).tr === tr)).length;
    expect(ports).toEqual({ MDF: homed("MDF"), "IDF-1": homed("IDF-1") });
    expect(ports.MDF + ports["IDF-1"]).toBe(23);
  });

  it("groups devices into rooms from the takeoff's labels and expands x N copies", () => {
    const rooms = file.nodes.filter((n) => n.type === "room").map((n) => n.data.label);
    expect(rooms).toEqual(expect.arrayContaining(["MDF", "IDF-1", "OPEN OFFICE 110", "CONFERENCE 120", "LOBBY 101", "CORRIDOR 100 (copy 1 of 2)", "CORRIDOR 100 (copy 2 of 2)"]));
    for (const d of devices) expect(d.parentId).toMatch(/^room-/);
  });

  it("unlinked and held devices are drawn without a cable", () => {
    const noCable = devices.filter((d) => brink(d.data).cable === "no linked run");
    expect(noCable).toHaveLength(2);
  });
});
