// brink-merge <takeoff.json> --report <report.json> --map data/catalog-map.json
//             --out schematic.json --bom bom.csv [--bom-json bom.json]
//             [--project NAME] [--db] [--db-url URL] [--strict]
// Exit 0: written, no errors. Exit 1: written, but the output carries errors
// (or warnings with --strict). Exit 2: bad usage or unreadable input.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { bomToCsv } from "./bom.js";
import { loadCatalogMap, parseCatalogMap } from "./catalog.js";
import { migrate, openDb } from "./db/db.js";
import { loadActiveEditsByName, loadCatalog, saveMerge, seedCatalog } from "./db/repository.js";
import type { SchematicEdit } from "./edits.js";
import { loadInput } from "./load.js";
import { merge, projectNameFor } from "./pipeline.js";

const USAGE = `usage: brink-merge <takeoff.json> --report <report.json> [--map data/catalog-map.json]
                   [--out schematic.json] [--bom bom.csv] [--bom-json bom.json]
                   [--project NAME] [--db] [--db-url URL] [--strict]

  <takeoff.json>  OpenTakeoff export (export_takeoff / the canvas EXPORT)
  --report        OpenTakeoff export_report JSON (required when the takeoff has cable runs)
  --map           Brink catalog map (default data/catalog-map.json; with --db the database's map wins)
  --out           EasySchematic file to write (default schematic.json)
  --bom           BOM CSV to write (default bom.csv); --bom-json also writes JSON
  --db            persist to Postgres/Supabase: --db-url, else DATABASE_URL, else local PGlite (BRINK_PGLITE_DIR)
  --strict        exit 1 on warnings too`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        report: { type: "string" },
        map: { type: "string", default: "data/catalog-map.json" },
        out: { type: "string", default: "schematic.json" },
        bom: { type: "string", default: "bom.csv" },
        "bom-json": { type: "string" },
        project: { type: "string" },
        db: { type: "boolean", default: false },
        "db-url": { type: "string" },
        strict: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help || positionals.length !== 1) {
    console.error(USAGE);
    return v.help ? 0 : 2;
  }
  const wantsDb = v.db || v["db-url"] !== undefined;

  let input, map;
  try {
    input = loadInput(positionals[0], v.report ?? null);
    map = loadCatalogMap(v.map!);
  } catch (e) {
    console.error(`brink-merge: ${(e as Error).message}`);
    return 2;
  }

  let db = null;
  let edits: SchematicEdit[] = [];
  if (wantsDb) {
    db = await openDb({ url: v["db-url"] || null });
    await migrate(db);
    await seedCatalog(db, map); // adds rows the database lacks; never overwrites an edited row
    map = parseCatalogMap(await loadCatalog(db));
    // The project's schematic edit layer is re-applied to the new import (docs/schematic-edits.md).
    edits = await loadActiveEditsByName(db, projectNameFor(input, v.project));
  }

  const result = merge(input, map, { project: v.project, edits });
  writeFileSync(v.out!, JSON.stringify(result.edited, null, 2) + "\n");
  writeFileSync(v.bom!, bomToCsv(result.bom));
  if (v["bom-json"]) writeFileSync(v["bom-json"], JSON.stringify(result.bom, null, 2) + "\n");

  let saved = null;
  if (db) {
    saved = await saveMerge(db, input, result);
    await db.close();
  }

  const t = result.bom.totals;
  console.log(`${result.project}: ${t.devices} devices, ${t.trs} TR(s), ${t.pulls} pulls, ${t.cables} cables, ${t.cableNetLf} LF net / ${t.cableOrderLf} LF order`);
  console.log(`wrote ${v.out} (${result.schematic.file.nodes.filter((n) => n.type === "device").length} device nodes, ${result.schematic.file.edges.length} connections), ${v.bom}${v["bom-json"] ? `, ${v["bom-json"]}` : ""}`);
  if (saved) console.log(`saved import ${saved.importId} (${db!.kind})`);
  if (edits.length) console.log(`schematic edits: ${result.editsApplied.length} of ${edits.length} re-applied`);
  for (const i of result.issues) console.log(`${i.severity === "error" ? "ERROR" : "warning"} [${i.code}] ${i.message}`);
  console.log(`${t.errors} error(s), ${t.warnings} warning(s)`);
  return t.errors > 0 || (v.strict && t.warnings > 0) ? 1 : 0;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) process.exitCode = await main(process.argv.slice(2));
