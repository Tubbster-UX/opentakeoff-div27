import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openPglite, openPostgres, type Db } from "../src/db/db.js";
import {
  currentImport, loadBomLines, loadCatalog, loadImportInput, loadIssues, moveNode, renderSchematic, saveMerge, seedCatalog, upsertCatalogRow,
} from "../src/db/repository.js";
import { merge } from "../src/pipeline.js";
import { catalog, load } from "./helpers.js";

// PGlite always; a real Postgres / local Supabase too when BRINK_TEST_DATABASE_URL names an EMPTY database.
const targets: [string, () => Promise<Db>][] = [["PGlite", () => openPglite()]];
if (process.env.BRINK_TEST_DATABASE_URL) targets.push(["Postgres", () => openPostgres(process.env.BRINK_TEST_DATABASE_URL!)]);

describe.each(targets)("system of record on %s", (_name, open) => {
  let db: Db;
  beforeAll(async () => {
    db = await open();
    expect(await migrate(db)).toEqual(["20261027000000_brink_merge_init.sql", "20261027120000_brink_schematic_edits.sql", "20261028120000_brink_takeoff.sql"]);
  });
  afterAll(() => db.close());

  it("migrations are idempotent and RLS is on with no policies", async () => {
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname like 'brink\\_%' and relkind = 'r' and relname <> 'brink_schema_migrations'")).rows;
    expect(tables.length).toBe(11); // init (8) + schematic edits + takeoff (sheets, takeoff edits)
    for (const t of tables) expect(t.relrowsecurity, t.relname).toBe(true);
    expect((await db.query("select * from pg_policies where tablename like 'brink\\_%'")).rows).toEqual([]);
  });

  it("seeds the catalog without overwriting edited rows", async () => {
    expect(await seedCatalog(db, catalog())).toBe(catalog().rows.length);
    const row = { ...catalog().rows.find((r) => r.conditionKey === "CAM-1")!, esDeviceType: "turret-camera", status: "confirmed" as const };
    await upsertCatalogRow(db, row);
    expect(await seedCatalog(db, catalog())).toBe(0);
    expect((await loadCatalog(db)).rows.find((r) => r.conditionKey === "CAM-1")).toMatchObject({ esDeviceType: "turret-camera", status: "confirmed" });
  });

  it("stores a merge and renders the identical EasySchematic file from rows", async () => {
    const input = load("div27-sample");
    const result = merge(input, await loadCatalog(db), { date: "2026-10-27" });
    const saved = await saveMerge(db, input, result);
    expect(saved).toMatchObject({ project: "Brink Div 27 sample (invented)", errors: 0 });
    expect(await renderSchematic(db, saved.importId)).toEqual(JSON.parse(JSON.stringify(result.schematic.file)));
    expect(await loadBomLines(db, saved.importId)).toEqual(JSON.parse(JSON.stringify(result.bom.lines)));
    expect(await loadIssues(db, saved.importId)).toEqual(result.issues);
    expect((await currentImport(db, saved.project))!.importId).toBe(saved.importId);

    const counts = (await db.query<{ n: number; lf: number }>("select count(*)::int as n, sum(cable_length_ft)::float8 as lf from brink_schematic_connections where import_id = $1", [saved.importId])).rows[0];
    expect(counts.n).toBe(23);
    // every connection carries its cable's measured length: together they are OpenTakeoff's net cable LF
    expect(Math.round(counts.lf * 100) / 100).toBe(result.bom.totals.cableNetLf);
    // the database copy of the turret-camera row reached the schematic
    expect(result.schematic.file.nodes.filter((n) => n.type === "device" && (n.data as { deviceType: string }).deviceType === "turret-camera")).toHaveLength(3);

    // the database is the truth: a moved node is what the next render opens
    const dev = result.schematic.file.nodes.find((n) => n.type === "device")!;
    expect(await moveNode(db, saved.importId, dev.id, 999, 111)).toBe(true);
    const moved = (await renderSchematic(db, saved.importId)).nodes.find((n) => n.id === dev.id)!;
    expect(moved.position).toEqual({ x: 999, y: 111 });
  });

  it("re-merges from the stored raw export with its original hashes", async () => {
    const input = load("div27-sample");
    const cur = (await currentImport(db, "Brink Div 27 sample (invented)"))!;
    const again = await loadImportInput(db, cur.importId);
    expect(again.takeoffSha256).toBe(input.takeoffSha256);
    expect(again.reportSha256).toBe(input.reportSha256);
    const a = merge(again, catalog(), { date: "x" });
    const b = merge(input, catalog(), { date: "x" });
    expect(a.bom).toEqual(b.bom);
  });
});
