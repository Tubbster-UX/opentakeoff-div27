// A scripted Division 27 cable session that states NO medium and NO limit
// (item 6, docs/design/CABLE_SETUP_PLAN.md §15.1): edit_condition, link_run
// (one run over 295 ft per cable), hold_devices, list_runs, takeoff_summary,
// export_report and the marked set's text. mcp/test/cable.test.ts runs it
// against the current server and compares the replies with
// cableMediumScenario.base.json, which this same function wrote when handed
// 28ea3cc's buildServer and Session (before medium and max_link_ft existed):
// a cable session that uses neither field must reply byte-for-byte as before.
// Minted ids come from a seeded randomUUID and timestamps are replaced by a
// token, so the replies repeat exactly. Fixtures are invented.
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openPdf } from "../../src/pdf.ts";

const UPP = 1 / 36;

/** Timestamps and the cover's date → stable tokens (they differ on every
 *  run); every other byte verbatim. */
export function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>").replace(/Generated \d{1,2}\/\d{1,2}\/\d{4}/g, "Generated <date>");
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

/** Deterministic ids for the length of a scenario: every minted id (shape,
 *  run, hold) comes from crypto.randomUUID, so the replies, and the marked
 *  set's line wraps (which depend on the ids' glyph widths), repeat exactly. */
async function withSeededUuids<T>(fn: () => Promise<T>): Promise<T> {
  const c = globalThis.crypto as any;
  const own = Object.prototype.hasOwnProperty.call(c, "randomUUID");
  const prev = c.randomUUID;
  let n = 0;
  c.randomUUID = () => {
    const h = createHash("sha256").update(`cable-medium-${++n}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  try { return await fn(); } finally { if (own) c.randomUUID = prev; else delete c.randomUUID; }
}

export function cableMediumScenario(buildServer: any, Session: any, plan: string) {
  return withSeededUuids(() => scenario(buildServer, Session, plan));
}

async function scenario(buildServer: any, Session: any, plan: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session(), { oneClick: false });
  await server.connect(st);
  const client = new Client({ name: "cable-medium-base", version: "0.0.0" });
  await client.connect(ct);
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  const key = path.basename(plan);
  await ok("load_plan", { path: plan });
  await ok("set_scale", { sheet: key, upp: UPP });
  const tr = (await ok("place_count", { sheet: key, points: [[200, 200]], condition: "TR" })).shape_ids[0];
  await ok("edit_condition", { condition: "TR", role: "tr" });
  await ok("edit_shape", { shape_id: tr, label: "MDF" });
  const devW = (await ok("place_count", { sheet: key, points: [[1000, 1000]], condition: "DATA-1" })).shape_ids[0];
  const devX = (await ok("place_count", { sheet: key, points: [[1800, 1000]], condition: "DATA-1" })).shape_ids[0];
  const devC = (await ok("place_count", { sheet: key, points: [[1400, 1000]], condition: "CAM-1" })).shape_ids[0];
  await ok("place_count", { sheet: key, points: [[2200, 1000]], condition: "EAC-1" });
  const out: Record<string, unknown> = {};
  out.editData = await ok("edit_condition", { condition: "DATA-1", waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  out.editCam = await ok("edit_condition", { condition: "CAM-1", waste_pct: 12, multiplier: 2, cable_setup: { device_type: "camera", cable_type: "CAT6 outdoor", vertical_ft: 130.05 } });
  out.editDoor = await ok("edit_condition", { condition: "EAC-1", cable_setup: { device_type: "access_control", cable_type: "fiber" } });
  const rtW = (await ok("measure_line", { sheet: key, pts: [[200, 300], [3350, 300]], condition: "ROUTE" })).shape_id;
  const rtC = (await ok("measure_line", { sheet: key, pts: [[200, 400], [5240, 400]], condition: "ROUTE" })).shape_id;
  await ok("measure_line", { sheet: key, pts: [[200, 500], [1640, 500]], condition: "ROUTE" });
  await ok("edit_condition", { condition: "ROUTE", role: "route" });
  out.linkW = await ok("link_run", { device_shape_ids: [devW], route_shape_ids: [rtW], tr_id: tr });
  out.linkC = await ok("link_run", { device_shape_ids: [devC], route_shape_ids: [rtC], tr_id: tr });
  out.hold = await ok("hold_devices", { device_shape_ids: [devX], reason: "by others" });
  out.editPatch = await ok("edit_condition", { condition: "DATA-1", cable_setup: { loop_tr_ft: 12 } });
  out.listRuns = await ok("list_runs", {});
  out.summaryCable = (await ok("takeoff_summary", {})).cable;
  out.reportCable = (await ok("export_report", {})).cable;
  const dir = await mkdtemp(path.join(tmpdir(), "ot-cable-medium-"));
  const pdf = path.join(dir, "marked.pdf");
  await ok("export_marked_pdf", { path: pdf, project_name: "Invented Div 27" });
  const doc = await openPdf(pdf);
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push((await doc.page(n)).textContent.items.map((i: any) => i.str).join("\n"));
  await doc.destroy();
  out.markedText = pages;
  await client.close();
  return normalize(out);
}
