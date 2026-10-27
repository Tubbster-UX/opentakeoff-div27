import { describe, expect, it } from "vitest";
import { fromRealtimePayload, projectRow, selectList, type RowChange, type Snapshot } from "../src/shared/protocol.js";
import { route } from "../src/shared/routing.js";
import { applyChange, summarize } from "../src/shared/state.js";

const P = "11111111-1111-1111-1111-111111111111";
const I1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const I2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const snap = (): Snapshot => ({
  project: { id: P, name: "Invented", current_import_id: I1 },
  import: { id: I1, project_id: P, errors: 0, warnings: 1 },
  bom: [
    { import_id: I1, line_no: 1, kind: "device", qty: 2 },
    { import_id: I1, line_no: 2, kind: "cable", qty: 10.5 },
  ],
  issues: [{ import_id: I1, seq: 1, severity: "warning", code: "x", message: "m" }],
  nodes: [
    { import_id: I1, seq: 1, node_id: "room-1", node_type: "room" },
    { import_id: I1, seq: 2, node_id: "device-1", node_type: "device", parent_id: "room-1" },
  ],
  connections: [{ import_id: I1, seq: 1, edge_id: "e1", source_node: "device-1", target_node: "pp", cable_length_ft: 40.25 }],
  readAt: "2026-10-27T00:00:00Z",
});

const ch = (c: Partial<RowChange> & Pick<RowChange, "table" | "type">): RowChange => ({ record: null, old: null, commitTimestamp: null, ...c });

describe("projectRow / fromRealtimePayload", () => {
  it("drops heavy jsonb and coerces numerics", () => {
    const r = projectRow("brink_bom_lines", { import_id: I1, line_no: "3", qty: "1.5", line: { big: true } })!;
    expect(r).toEqual({ import_id: I1, line_no: 3, qty: 1.5 });
    expect(projectRow("brink_imports", { id: I1, takeoff: { huge: 1 }, errors: "2" })).toEqual({ id: I1, errors: 2 });
  });

  it("normalizes a realtime-js payload and ignores other tables", () => {
    const c = fromRealtimePayload({ table: "brink_issues", eventType: "DELETE", new: {}, old: { import_id: I1, seq: 1 }, commit_timestamp: "t" });
    expect(c).toEqual({ table: "brink_issues", type: "DELETE", record: null, old: { import_id: I1, seq: 1 }, commitTimestamp: "t" });
    expect(fromRealtimePayload({ table: "brink_catalog_map", eventType: "UPDATE", new: { a: 1 } })).toBeNull();
  });
});

describe("applyChange", () => {
  it("upserts and deletes rows of the current import, in order", () => {
    let s = snap();
    let r = applyChange(s, ch({ table: "brink_bom_lines", type: "UPDATE", record: { import_id: I1, line_no: 2, qty: 12 } }));
    expect(r.kind).toBe("applied");
    s = (r as { snapshot: Snapshot }).snapshot;
    expect(s.bom.map((l) => [l.line_no, l.qty, l.kind])).toEqual([[1, 2, "device"], [2, 12, "cable"]]);
    r = applyChange(s, ch({ table: "brink_bom_lines", type: "INSERT", record: { import_id: I1, line_no: 0, qty: 1 } }));
    s = (r as { snapshot: Snapshot }).snapshot;
    expect(s.bom.map((l) => l.line_no)).toEqual([0, 1, 2]);
    r = applyChange(s, ch({ table: "brink_issues", type: "DELETE", old: { import_id: I1, seq: 1 } }));
    expect((r as { snapshot: Snapshot }).snapshot.issues).toEqual([]);
  });

  it("ignores rows of another import", () => {
    expect(applyChange(snap(), ch({ table: "brink_bom_lines", type: "INSERT", record: { import_id: I2, line_no: 1 } })).kind).toBe("ignored");
  });

  it("asks for a resync when current_import_id moves", () => {
    const r = applyChange(snap(), ch({ table: "brink_projects", type: "UPDATE", record: { id: P, name: "Invented", current_import_id: I2 } }));
    expect(r).toEqual({ kind: "resync", reason: "current import changed" });
  });

  it("applies a rename without a resync", () => {
    const r = applyChange(snap(), ch({ table: "brink_projects", type: "UPDATE", record: { id: P, name: "Renamed", current_import_id: I1 } }));
    expect(r.kind === "applied" && r.snapshot.project.name).toBe("Renamed");
  });

  it("summarizes from rows", () => {
    expect(summarize(snap())).toMatchObject({ devices: 1, rooms: 1, connections: 1, cableLf: 40.25, warnings: 1, bomLines: 2 });
  });

  it("totals the BOM the way brink-merge does", () => {
    const s = snap();
    s.bom = [
      { import_id: I1, line_no: 1, kind: "device", qty: 3 },
      { import_id: I1, line_no: 2, kind: "cable", qty: 120.5, cables: 3, pulls: 3, net_lf: 120.5, order_lf: 132.55 },
      { import_id: I1, line_no: 3, kind: "tr", qty: 1 },
      { import_id: I1, line_no: 4, kind: "cable", qty: 10, cables: 1, net_lf: 10.004, order_lf: 11 },
      { import_id: I1, line_no: 5, kind: "cable_order", qty: 1, order_lf: 999 },
      { import_id: I1, line_no: 6, kind: "issue", qty: 0 },
    ];
    expect(summarize(s).bom).toEqual({ devices: 3, trs: 1, cables: 4, netLf: 130.5, orderLf: 143.55 });
  });
});

describe("selectList / jsonb extras", () => {
  it("selects the slim jsonb extras and unpacks them, never the blob", () => {
    expect(selectList("brink_bom_lines", "b")).toContain("jsonb_build_object('cables', b.line->'cables', 'pulls', b.line->'pulls') as line");
    expect(selectList("brink_issues")).toBe("import_id, seq, severity, code, message, condition_key, refs");
    const r = projectRow("brink_bom_lines", { import_id: I1, line_no: 2, kind: "cable", line: { cables: 3, pulls: "2", huge: "x".repeat(10) } })!;
    expect(r).toEqual({ import_id: I1, line_no: 2, kind: "cable", cables: 3, pulls: 2 });
  });
});

describe("route (relay fan-out)", () => {
  const client = { projectId: P, importId: I1 };

  it("sends child rows only to sockets showing that import", () => {
    expect(route(ch({ table: "brink_bom_lines", type: "UPDATE", record: { import_id: I1, line_no: 1 } }), client).send).toBe(true);
    expect(route(ch({ table: "brink_bom_lines", type: "UPDATE", record: { import_id: I2, line_no: 1 } }), client).send).toBe(false);
    expect(route(ch({ table: "brink_issues", type: "DELETE", old: { import_id: I1, seq: 3 } }), { projectId: P, importId: null }).send).toBe(false);
  });

  it("re-points a socket when its project switches imports", () => {
    const r = route(ch({ table: "brink_projects", type: "UPDATE", record: { id: P, current_import_id: I2 } }), client);
    expect(r).toEqual({ send: true, next: { projectId: P, importId: I2 } });
    expect(route(ch({ table: "brink_projects", type: "UPDATE", record: { id: "other", current_import_id: I2 } }), client).send).toBe(false);
  });

  it("routes import rows by project", () => {
    expect(route(ch({ table: "brink_imports", type: "INSERT", record: { id: I2, project_id: P } }), client).send).toBe(true);
    expect(route(ch({ table: "brink_imports", type: "INSERT", record: { id: I2, project_id: "other" } }), client).send).toBe(false);
  });

  it("keeps Portal push rows off project sockets", () => {
    expect(route(ch({ table: "brink_portal_pushes", type: "INSERT", record: { id: "x", project_id: P, import_id: I1 } }), client).send).toBe(false);
  });

  it("routes schematic edits by project, whatever import the socket shows", () => {
    const edit = fromRealtimePayload({ table: "brink_schematic_edits", eventType: "INSERT", new: { id: "e1", project_id: P, target_key: "dev-shp-1-1", kind: "move", payload: { x: 1 }, client_ref: "tab-1", editor_email: "a@b.c" } })!;
    expect(edit.record).toMatchObject({ project_id: P, payload: { x: 1 }, client_ref: "tab-1" });
    expect(route(edit, client).send).toBe(true);
    expect(route(edit, { projectId: P, importId: null }).send).toBe(true);
    expect(route(edit, { projectId: "other", importId: I1 }).send).toBe(false);
    // not part of the snapshot: applyChange leaves it alone
    expect(applyChange(snap(), edit).kind).toBe("ignored");
  });
});
