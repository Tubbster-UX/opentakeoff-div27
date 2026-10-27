import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite, type Db } from "../src/db/db.js";
import { buildServer } from "../src/mcp/server.js";
import { validateSchematic } from "../src/validate.js";
import { fixture } from "./helpers.js";

type CallResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text: string }[] };

describe("brink MCP server (headless)", () => {
  let db: Db;
  let client: Client;
  const out = mkdtempSync(join(tmpdir(), "brink-mcp-"));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallResult;
  const PROJECT = "Brink Div 27 sample (invented)";

  beforeAll(async () => {
    db = await openPglite();
    const server = buildServer({ db });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    await db.close();
  });

  it("lists its tools and tells the agent how to link with OpenTakeoff", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["bom", "catalog", "export_bom", "export_schematic", "get_schematic", "import_takeoff", "list_issues", "list_projects", "map_condition"]);
    expect(client.getInstructions()).toContain("export_takeoff");
  });

  it("imports an OpenTakeoff export pair and reports totals and issues", async () => {
    const r = await call("import_takeoff", { takeoff_path: fixture("div27-sample.takeoff.json"), report_path: fixture("div27-sample.report.json") });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ project: PROJECT, totals: { devices: 16, trs: 2, cables: 23, cableNetLf: 1795.13 }, connections: 23, schematic_edits: { applied: 0, not_applied: 0 }, unmapped: [], errors: 0 });
    expect(r.structuredContent!.issues.some((i: string) => i.includes("over_length"))).toBe(true);
  });

  it("refuses an import whose cable runs have no report", async () => {
    const r = await call("import_takeoff", { takeoff_path: fixture("div27-minimal.takeoff.json"), project: "no report" });
    expect(r.structuredContent).toMatchObject({ errors: 1 });
    expect(r.structuredContent!.issues[0]).toMatch(/report_missing/);
  });

  it("serves the BOM and issues from the database", async () => {
    const bom = await call("bom", { project: PROJECT });
    expect(bom.structuredContent!.lines.filter((l: { kind: string }) => l.kind === "cable")).toHaveLength(7);
    const errs = await call("list_issues", { project: PROJECT, severity: "error" });
    expect(errs.structuredContent).toMatchObject({ errors: 0 });
    expect((await call("bom", { project: "nope" })).isError).toBe(true);
  });

  it("map_condition refuses invalid EasySchematic values and writes nothing", async () => {
    const r = await call("map_condition", { condition_key: "CAM-1", kind: "device", es_device_type: "cctv-cam", status: "confirmed" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/refused, nothing written/);
    const rows = (await call("catalog")).structuredContent!.rows;
    expect(rows.find((x: { conditionKey: string }) => x.conditionKey === "CAM-1").esDeviceType).toBe("camera");
  });

  it("map_condition confirms a row and re-merges every project", async () => {
    const r = await call("map_condition", { condition_key: "CAM-1", kind: "device", es_device_type: "turret-camera", manufacturer: "Example", model_number: "T-100", cable_type: "CAT6 CMP", status: "confirmed" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.remerged.map((x: { project: string }) => x.project).sort()).toEqual([PROJECT, "no report"].sort());
    const s = (await call("get_schematic", { project: PROJECT })).structuredContent!;
    expect(s.templates).toContain("brink-cam-1: IP camera (turret-camera)");
  });

  it("exports a valid EasySchematic file and the BOM", async () => {
    const path = join(out, "job.schematic.json");
    const r = await call("export_schematic", { project: PROJECT, path });
    expect(r.structuredContent).toMatchObject({ path, devices: 18, connections: 23 });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(validateSchematic(file)).toEqual([]);
    expect(file.nodes.find((n: { data: { modelNumber?: string } }) => n.data.modelNumber === "T-100")).toBeTruthy();

    const csv = join(out, "bom.csv");
    expect((await call("export_bom", { project: PROJECT, path: csv })).structuredContent).toMatchObject({ format: "csv" });
    expect(readFileSync(csv, "utf8").split("\n")[0]).toMatch(/^lineNo,kind,conditionKey/);
  });
});
