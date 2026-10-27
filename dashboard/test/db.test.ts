// listProjects against a scripted Queryable: the optional Portal push table is
// queried only when the database has it. (The real SQL runs in worker.test.ts
// with DASHBOARD_TEST_DATABASE_URL, and in the Phase 1 live check.)
import { describe, expect, it } from "vitest";
import { listProjects, type Queryable } from "../src/db.js";
import type { Row } from "../src/shared/protocol.js";

const P = "11111111-1111-4111-8111-111111111111";
const I1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I0 = "99999999-9999-4999-8999-999999999999";

function fakeDb(hasPushes: boolean, row: Row): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string) {
      sql.push(text);
      if (text.includes("pg_class")) return { rows: hasPushes ? [{ t: "brink_portal_pushes" }] : [] };
      if (text.includes("from brink_projects p")) return { rows: [row] };
      return { rows: [] };
    },
  };
}

const base: Row = {
  id: P, name: "Invented", created_at: new Date("2026-10-01T00:00:00Z"), current_import_id: I1,
  imported_at: new Date("2026-10-27T12:00:00Z"), ot_schema: "opentakeoff.takeoff/v1", es_schema_version: 3,
  bom_lines: "30", devices: "16", trs: "2", cables: "23", net_lf: "1795.13", order_lf: "2007.79", errors: "0", warnings: "14",
};

describe("listProjects", () => {
  it("never names brink_portal_pushes when the table is absent", async () => {
    const db = fakeDb(false, base);
    const list = await listProjects(db);
    expect(list.features).toEqual({ portalPushes: false });
    expect(db.sql.join("\n")).not.toMatch(/from brink_portal_pushes/);
    expect(db.sql[0]).toMatch(/read only/);
    expect(list.projects[0]).toMatchObject({
      id: P, devices: 16, trs: 2, cables: 23, net_lf: 1795.13, order_lf: 2007.79, warnings: 14, bom_lines: 30,
      imported_at: "2026-10-27T12:00:00.000Z", portal_push: null,
    });
  });

  it("reads the latest push when the table exists, and says whether it was for the current import", async () => {
    const db = fakeDb(true, {
      ...base, pp_id: "push-1", pp_import_id: I0, pp_dry_run: true, pp_status: "planned", pp_portal_proposal_id: null,
      pp_error: null, pp_created_at: new Date("2026-10-27T13:00:00Z"), pp_finished_at: null,
    });
    const list = await listProjects(db);
    expect(list.features).toEqual({ portalPushes: true });
    expect(db.sql.join("\n")).toMatch(/from brink_portal_pushes pp where pp.project_id = p.id/);
    expect(list.projects[0]!.portal_push).toEqual({
      id: "push-1", import_id: I0, is_current_import: false, dry_run: true, status: "planned",
      portal_proposal_id: null, error: null, created_at: "2026-10-27T13:00:00.000Z", finished_at: null,
    });
  });
});
