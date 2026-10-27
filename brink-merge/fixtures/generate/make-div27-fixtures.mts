// Generates brink-merge's test fixtures with the REAL OpenTakeoff engine: the
// Division 27 branch's MCP Session (the code an agent drives through MCP), run
// on the repository's bundled demo/sample-plan.pdf. The takeoffs are invented;
// the exports are what OpenTakeoff actually writes (export_takeoff's payload
// and export_report's JSON). No real project data.
//
// Run from an OpenTakeoff checkout of branch claude/div27-cable-setup-c6t9wu
// (web/ and mcp/ installed with npm ci):
//   cd <ot>/web && node --import tsx <this file> <ot> <out dir>
// See fixtures/generate/README.md for the recorded commit and commands.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [otDir, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!otDir || !outDir) throw new Error("usage: node --import tsx make-div27-fixtures.mts <opentakeoff dir> <out dir>");
const { Session } = await import(pathToFileURL(join(otDir, "mcp/src/session.ts")).href);
const PLAN = join(otDir, "demo/sample-plan.pdf");
const K = "sample-plan.pdf";
type Pt = [number, number];

function write(name: string, s: InstanceType<typeof Session>, project: string) {
  mkdirSync(outDir, { recursive: true });
  const takeoff = s.exportPayload();
  const report = s.exportReport(project);
  writeFileSync(join(outDir, `${name}.takeoff.json`), JSON.stringify(takeoff, null, 2) + "\n");
  writeFileSync(join(outDir, `${name}.report.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(`${name}: ${takeoff.shapes.length} shapes, ${takeoff.conditions.length} conditions, ${takeoff.cable_runs?.length ?? 0} run record(s)`);
}

// ── div27-minimal: the branch's own make-cable-fixture layout, hand-checkable.
// Three DATA-1 outlets (2 x CAT6A per location), three 1200 px routes at
// 36 px/ft = 33.33 ft each, ONE linked run; two devices and two routes unlinked.
{
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(K, { upp: 1 / 36 });
  const tr = s.placeCount(K, [[300, 300]], { condition: "TR" });
  s.editCondition("TR", { role: "tr" });
  s.editShape(tr.shape_ids[0], { label: "MDF" });
  const dev = s.placeCount(K, [[1500, 300], [1500, 700], [1500, 1000]], { condition: "DATA-1" });
  s.editCondition("DATA-1", { waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
  const routes = [300, 700, 1000].map((y) => s.measureLine(K, [[300, y], [1500, y]], { condition: "ROUTE" }));
  s.editCondition("ROUTE", { role: "route" });
  s.linkRun({ device_shape_ids: [dev.shape_ids[0]], route_shape_ids: [routes[0].shape_id!], tr_id: tr.shape_ids[0] });
  write("div27-minimal", s, "Brink Div 27 minimal (invented)");
}

// ── div27-sample: two TRs, trunk + branch pathway, five device conditions,
// room labels, a x2 multiplier, cable medium and box sizes (1000 ft), per-run verticals, an over-295 ft run, a hold,
// an unlinked device and an unlinked route, and cables/pulls materials rows.
{
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(K, { upp: 1 / 36 }); // 36 px per foot
  const TRUNK_Y = 800;
  const trs = s.placeCount(K, [[300, TRUNK_Y], [2400, TRUNK_Y]], { condition: "TR" }).shape_ids as string[];
  s.editCondition("TR", { role: "tr" });
  s.editShape(trs[0], { label: "MDF" });
  s.editShape(trs[1], { label: "IDF-1" });

  type Dev = { cond: string; at: Pt; room: string; tr: 0 | 1; vertical_ft?: number };
  const devs: Dev[] = [
    { cond: "DATA-1", at: [600, 520], room: "OPEN OFFICE 110", tr: 0 },
    { cond: "DATA-1", at: [900, 520], room: "OPEN OFFICE 110", tr: 0 },
    { cond: "DATA-1", at: [1200, 520], room: "OPEN OFFICE 110", tr: 0 },
    { cond: "DATA-1", at: [1500, 520], room: "CONFERENCE 120", tr: 1 },
    { cond: "DATA-1", at: [1800, 520], room: "CONFERENCE 120", tr: 1 },
    { cond: "WAP-1", at: [700, 1080], room: "CORRIDOR 100", tr: 0 },
    { cond: "WAP-1", at: [1900, 1080], room: "CORRIDOR 100", tr: 1 },
    { cond: "CAM-1", at: [1000, 1180], room: "CORRIDOR 100", tr: 0, vertical_ft: 280 }, // pole camera: over 295 ft per cable
    { cond: "CAM-1", at: [1600, 1180], room: "CORRIDOR 100", tr: 1 },
    { cond: "CAM-1", at: [2200, 1180], room: "LOBBY 101", tr: 1 },
    { cond: "ACS-1", at: [1400, 300], room: "CONFERENCE 120", tr: 1, vertical_ft: 9 },
    { cond: "ACS-1", at: [2000, 300], room: "LOBBY 101", tr: 1, vertical_ft: 12 },
  ];
  const ids = devs.map((d) => s.placeCount(K, [d.at], { condition: d.cond }).shape_ids[0] as string);
  devs.forEach((d, i) => s.editShape(ids[i], { label: d.room }));
  const held = s.placeCount(K, [[2250, 520]], { condition: "DATA-1" }).shape_ids[0] as string;
  s.editShape(held, { label: "LOBBY 101" });
  const unlinked = s.placeCount(K, [[2250, 300]], { condition: "DATA-1" }).shape_ids[0] as string;
  s.editShape(unlinked, { label: "LOBBY 101" });

  s.editCondition("DATA-1", { waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A CMP", vertical_ft: 23, loop_device_ft: 10, loop_tr_ft: 10, medium: "copper", package_ft: 1000 } });
  s.editCondition("WAP-1", { waste_pct: 12, multiplier: 2, cable_setup: { device_type: "wap", cables_per_location: 2, cable_type: "CAT6A CMP", vertical_ft: 13, loop_device_ft: 20, loop_tr_ft: 10 } });
  s.editCondition("CAM-1", { waste_pct: 12, cable_setup: { device_type: "camera", cables_per_location: 1, cable_type: "CAT6 CMP", vertical_ft: 13, loop_device_ft: 15, loop_tr_ft: 10, medium: "copper", package_ft: 1000 } });
  s.editCondition("ACS-1", { waste_pct: 10, cable_setup: { device_type: "access_door", cables_per_location: 1, cable_type: "18/4 SHLD CMP", loop_device_ft: 15, loop_tr_ft: 10 } });
  s.editMaterials("DATA-1", { add: [{ name: "CAT6A jack", per: 1, basis: "cables", unit: "EA" }, { name: "2-port faceplate", per: 1, basis: "pulls", unit: "EA" }] });
  s.editMaterials("CAM-1", { add: [{ name: "Camera mount", per: 1, basis: "pulls", unit: "EA" }] });

  // Trunk: traced once per span between branch junctions, so each run uses
  // only the spans between its junction and its TR.
  const junction = (d: Dev) => d.at[0];
  const trunkFor = new Map<number, string[]>();
  for (const side of [0, 1] as const) {
    const trX = side === 0 ? 300 : 2400;
    const xs = [...new Set(devs.filter((d) => d.tr === side).map(junction))].sort((a, b) => (side === 0 ? a - b : b - a));
    let prev = trX;
    const spans: string[] = [];
    for (const x of xs) {
      spans.push(s.measureLine(K, [[prev, TRUNK_Y], [x, TRUNK_Y]], { condition: "TRUNK" }).shape_id!);
      trunkFor.set(x * 10 + side, [...spans].reverse()); // junction → TR order
      prev = x;
    }
  }
  devs.forEach((d, i) => {
    const branch = s.measureLine(K, [d.at, [d.at[0], TRUNK_Y]], { condition: "BRANCH" }).shape_id!;
    s.linkRun({
      device_shape_ids: [ids[i]], route_shape_ids: [branch, ...trunkFor.get(junction(d) * 10 + d.tr)!], tr_id: trs[d.tr],
      ...(d.vertical_ft !== undefined ? { vertical_ft: d.vertical_ft } : {}),
    });
  });
  s.measureLine(K, [[2250, 300], [2250, 650]], { condition: "BRANCH" }); // stray branch: no run uses it
  s.editCondition("TRUNK", { role: "route", route_kind: "trunk" });
  s.editCondition("BRANCH", { role: "route", route_kind: "branch" });
  s.holdDevices({ device_shape_ids: [held], reason: "Furnished and installed by others" });
  write("div27-sample", s, "Brink Div 27 sample (invented)");
}
