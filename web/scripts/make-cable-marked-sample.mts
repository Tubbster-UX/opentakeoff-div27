// Phase 3 evidence: an INVENTED Division 27 takeoff on the bundled
// demo/sample-plan.pdf, marked through the MCP server's own Session (the code
// an agent drives) and written as a marked set, so the route chips, device
// run tags, rings and legend lines can be looked at. Nothing real.
//   cd web && node --import tsx scripts/make-cable-marked-sample.mts <out.pdf>
// Layout: a TR (MDF) at the west end of one corridor trunk; six DATA-1 wall
// outlets north of it and three WAP-1 + three CAM-1 south, each homed by its
// own route polyline down to the trunk and west along it (so the trunk is
// crowded, the case the chip placer has to spread). One camera's vertical is
// set long enough to pass 295 ft per cable; one extra outlet is held "by
// others"; one is left unlinked.
import { Session } from "../../mcp/src/session.ts";
import { exportMarkedPdf } from "../../mcp/src/marked.ts";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) throw new Error("usage: node --import tsx scripts/make-cable-marked-sample.mts <out.pdf>");
const plan = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const K = "sample-plan.pdf";
const s = new Session();
await s.loadPlan(plan);
s.setScale(K, { upp: 1 / 36 });   // 1/4" = 1'-0" at render scale 2.0
const TRUNK_Y = 800, TR_X = 300;
const tr = s.placeCount(K, [[TR_X, TRUNK_Y]], { condition: "TR" }).shape_ids[0];
s.editCondition("TR", { role: "tr" });
s.editShape(tr, { label: "MDF" });
const devices: { cond: string; at: [number, number] }[] = [
  ...[600, 900, 1200, 1500, 1800, 2100].map((x) => ({ cond: "DATA-1", at: [x, 520] as [number, number] })),
  ...[700, 1300, 1900].map((x) => ({ cond: "WAP-1", at: [x, 1080] as [number, number] })),
  ...[1000, 1600, 2200].map((x) => ({ cond: "CAM-1", at: [x, 1180] as [number, number] })),
];
const ids = devices.map((d) => s.placeCount(K, [d.at], { condition: d.cond }).shape_ids[0]);
const held = s.placeCount(K, [[2250, 520]], { condition: "DATA-1" }).shape_ids[0];
s.placeCount(K, [[2250, 300]], { condition: "DATA-1" });   // left unlinked on purpose
s.editCondition("DATA-1", { waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 9, loop_device_ft: 3, loop_tr_ft: 26 } });
s.editCondition("WAP-1", { waste_pct: 12, cable_setup: { device_type: "wap", cables_per_location: 2, cable_type: "CAT6A", vertical_ft: 1, loop_device_ft: 20, loop_tr_ft: 26 } });
s.editCondition("CAM-1", { waste_pct: 12, cable_setup: { device_type: "camera", cables_per_location: 1, cable_type: "CAT6A", vertical_ft: 1, loop_device_ft: 15, loop_tr_ft: 26 } });
devices.forEach((d, i) => {
  const route = s.measureLine(K, [d.at, [d.at[0], TRUNK_Y], [TR_X, TRUNK_Y]], { condition: "ROUTE" }).shape_id!;
  s.linkRun({ device_shape_ids: [ids[i]], route_shape_ids: [route], tr_id: tr });
});
s.editCondition("ROUTE", { role: "route" });
s.holdDevices({ device_shape_ids: [held], reason: "Furnished and installed by others" });
// one camera past the TIA-568 copper limit: the far east camera's vertical
s.editCondition("CAM-1", { cable_setup: { vertical_ft: 200 } });
const r = await exportMarkedPdf(s, { path: out, project_name: "Invented Division 27 sample" });
console.log(`wrote ${out}: ${r.pages} pages`);
