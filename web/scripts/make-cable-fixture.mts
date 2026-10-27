// An invented Division 27 takeoff on the bundled demo/sample-plan.pdf, made
// through the MCP server's own Session (the same code an agent drives), for
// scripts/verify-cable-runs.mjs to import into the canvas. Nothing real.
//   cd web && node --import tsx scripts/make-cable-fixture.mts <out.json>
// Writes: a TR marker labeled MDF; three DATA-1 wall-outlet markers (2 Cat 6A
// per location, waste 12%); three straight ROUTE segments of 33.33 ft at
// 1/4" = 1'-0"; and ONE agent-linked run (pending review), so two devices and
// two routes are left unlinked for the UI to link.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Session } from "../../mcp/src/session.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node --import tsx scripts/make-cable-fixture.mts <out.json>");
const plan = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const K = "sample-plan.pdf";
const s = new Session();
await s.loadPlan(plan);
s.setScale(K, { upp: 1 / 36 });   // 36 px per foot at render scale 2.0
const tr = s.placeCount(K, [[300, 300]], { condition: "TR" });
s.editCondition("TR", { role: "tr" });
s.editShape(tr.shape_ids[0], { label: "MDF" });
const dev = s.placeCount(K, [[1500, 300], [1500, 700], [1500, 1000]], { condition: "DATA-1" });
s.editCondition("DATA-1", { waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A" } });
const routes = [300, 700, 1000].map((y) => s.measureLine(K, [[300, y], [1500, y]], { condition: "ROUTE" }));
s.editCondition("ROUTE", { role: "route" });
s.linkRun({ device_shape_ids: [dev.shape_ids[0]], route_shape_ids: [routes[0].shape_id!], tr_id: tr.shape_ids[0] });
const doc = s.exportPayload();
writeFileSync(out, JSON.stringify(doc));
console.log(`wrote ${out}: ${doc.shapes.length} shapes, ${doc.cable_runs?.length ?? 0} run(s), routes ${routes.map((r) => r.length_lf).join(" / ")} LF`);
