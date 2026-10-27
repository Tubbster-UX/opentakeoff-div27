import { describe, expect, it } from "vitest";
import { rollup } from "../src/rollup.js";
import { clone, load } from "./helpers.js";

const byTag = (rs: ReturnType<typeof rollup>) => Object.fromEntries(rs.map((r) => [r.finishTag, r]));

describe("rollup (Task 2)", () => {
  it("div27-minimal: exact hand-checked totals", () => {
    // 1 TR, 3 DATA-1 markers, 3 ROUTE lines of 1200 px at 36 px/ft = 33.33 ft each.
    const r = byTag(rollup(load("div27-minimal").takeoff));
    expect(r["TR"]).toMatchObject({ kind: "tr", measured: { count: 1 }, net: { count: 1 } });
    expect(r["DATA-1"]).toMatchObject({ kind: "device", wastePct: 12, measured: { count: 3 }, net: { count: 3 }, order: { count: 3.36 } });
    expect(r["ROUTE"]).toMatchObject({ kind: "route", measured: { linearLf: 99.99, planLf: 99.99, verticalLf: 0 }, net: { linearLf: 99.99 } });
  });

  it("div27-sample: exact totals, multiplier applied to net, waste only to order", () => {
    const r = byTag(rollup(load("div27-sample").takeoff));
    expect(r["DATA-1"].measured.count).toBe(7); // 5 linked + 1 held + 1 unlinked
    expect(r["WAP-1"]).toMatchObject({ multiplier: 2, measured: { count: 2 }, net: { count: 4 }, order: { count: 4.48 } });
    expect(r["CAM-1"].net.count).toBe(3);
    expect(r["ACS-1"].net.count).toBe(2);
    expect(r["TR"].countByLabel).toEqual({ MDF: 1, "IDF-1": 1 });
    expect(r["DATA-1"].countByLabel).toEqual({ "OPEN OFFICE 110": 3, "CONFERENCE 120": 2, "LOBBY 101": 2 });
    expect(r["TRUNK"].measured.linearLf).toBe(52.81);
    expect(r["BRANCH"].measured.linearLf).toBe(123.64);
  });

  it("agrees with OpenTakeoff's own report (EA and LF, multiplier applied)", () => {
    const { takeoff, report } = load("div27-sample");
    for (const r of rollup(takeoff)) {
      const rep = report!.conditions.find((c) => c.id === r.conditionId)!;
      expect(r.net.count, r.finishTag).toBe(rep.ea);
      expect(r.net.linearLf, r.finishTag).toBe(rep.lf);
    }
  });

  it("reads computed quantities, never geometry", () => {
    const input = load("div27-sample");
    const moved = clone(input.takeoff);
    for (const s of moved.shapes) (s as { verts_norm?: number[][] }).verts_norm = [[0, 0], [1, 1]];
    expect(rollup(moved)).toEqual(rollup(input.takeoff));
  });

  it("uses perimeter_lf (rise + drop included) for a linear shape's LF and keeps plan LF apart", () => {
    const input = load("div27-minimal");
    const t = clone(input.takeoff);
    const line = t.shapes.find((s) => s.measure_role === "linear")!;
    line.computed = { perimeter_lf: 53.33, plan_lf: 33.33, vertical_lf: 20 };
    const r = byTag(rollup(t))["ROUTE"];
    expect(r.measured).toMatchObject({ linearLf: 119.99, planLf: 99.99, verticalLf: 20 });
  });
});
