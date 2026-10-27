import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { validateSchematic } from "../src/validate.js";
import { catalog, fixture, MAP_PATH } from "./helpers.js";

describe("brink-merge CLI (Task 6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brink-cli-"));
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const args = (extra: string[] = [], map = MAP_PATH) => [
    fixture("div27-sample.takeoff.json"), "--report", fixture("div27-sample.report.json"), "--map", map,
    "--out", join(dir, "schematic.json"), "--bom", join(dir, "bom.csv"), "--bom-json", join(dir, "bom.json"), ...extra,
  ];

  it("runs end to end: a loadable schematic and a BOM; warnings only -> exit 0", async () => {
    expect(await main(args())).toBe(0);
    const file = JSON.parse(readFileSync(join(dir, "schematic.json"), "utf8"));
    expect(validateSchematic(file)).toEqual([]);
    const bom = JSON.parse(readFileSync(join(dir, "bom.json"), "utf8"));
    expect(bom.totals).toMatchObject({ devices: 16, cables: 23, cableNetLf: 1795.13, errors: 0 });
    expect(readFileSync(join(dir, "bom.csv"), "utf8")).toContain("CAT6A CMP to MDF");
  });

  it("--strict fails on warnings", async () => {
    expect(await main(args(["--strict"]))).toBe(1);
  });

  it("an unmapped condition still writes everything, and exits 1", async () => {
    const map = catalog();
    map.rows = map.rows.filter((r) => r.conditionKey !== "ACS-1");
    const mapPath = join(dir, "partial-map.json");
    writeFileSync(mapPath, JSON.stringify(map));
    expect(await main(args([], mapPath))).toBe(1);
    const csv = readFileSync(join(dir, "bom.csv"), "utf8");
    expect(csv).toMatch(/issue,ACS-1,"?ACS-1 \(device, 2 shape/);
  });

  it("--db persists to PGlite", async () => {
    expect(await main(args(["--db"]))).toBe(0);
    expect((console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join("\n")).toMatch(/saved import .* \(pglite\)/);
  });

  it("bad usage exits 2", async () => {
    expect(await main([])).toBe(2);
    expect(await main(["missing.json"])).toBe(2);
  });
});
