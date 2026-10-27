// brink-merge portal-push: build a Draft Portal proposal from a project's
// current import. DRY RUN by default (no network). Live needs --live AND
// --confirm <plan hash from the dry run>, plus credentials in the environment.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { BomLine } from "../bom.js";
import { loadCatalogMap } from "../catalog.js";
import { migrate, openDb } from "../db/db.js";
import { seedCatalog } from "../db/repository.js";
import { buildPushPlan, formatPlan, requestPlan } from "./plan.js";
import { portalConfig, portalPush, type PushReport } from "./push.js";

export const PORTAL_USAGE = `usage: brink-merge portal-push --project NAME [--db-url URL] [options]     (dry run: prints the request plan)
       brink-merge portal-push --project NAME --live --confirm <plan hash> [--new-proposal] [options]
       brink-merge portal-push --bom-json bom.json [--map data/catalog-map.json] [options]   (dry run from files, not recorded)

  --project         project whose current import is pushed (database: --db-url, DATABASE_URL, or BRINK_PGLITE_DIR)
  --exclude-cable   leave every cable line out of the push (listed as not pushed)
  --proposal-name   Draft proposal name (default "<project> - Division 27")
  --area            area name (default "Division 27")
  --app-version     Portal web app build sent as appVersion (default PORTAL_APP_VERSION, else the observed build)
  --live            really write to Portal; needs --confirm with the hash the dry run printed
  --new-proposal    live: allow a second Draft proposal when this project already has a live push
  --json            print the report as JSON
Credentials (live only) come from the environment, never from flags:
  PORTAL_REFRESH_TOKEN, or PORTAL_USERNAME and PORTAL_PASSWORD.`;

export async function portalPushMain(argv: string[], deps: { env?: Record<string, string | undefined> } = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        "bom-json": { type: "string" },
        map: { type: "string", default: "data/catalog-map.json" },
        "db-url": { type: "string" },
        "exclude-cable": { type: "boolean", default: false },
        "proposal-name": { type: "string" },
        area: { type: "string" },
        "app-version": { type: "string" },
        live: { type: "boolean", default: false },
        confirm: { type: "string" },
        "new-proposal": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${PORTAL_USAGE}`);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    console.log(PORTAL_USAGE);
    return 0;
  }
  if (!!v.project === !!v["bom-json"]) {
    console.error(`portal-push: give exactly one of --project or --bom-json\n\n${PORTAL_USAGE}`);
    return 2;
  }
  const env = deps.env ?? process.env;
  const common = { excludeCable: v["exclude-cable"], proposalName: v["proposal-name"], areaName: v.area };

  if (v["bom-json"]) {
    if (v.live) {
      console.error("portal-push: --live needs --project (a database import, so the push is recorded); --bom-json is dry run only");
      return 2;
    }
    let bom: { project: string; lines: BomLine[] }, catalog;
    try {
      bom = JSON.parse(readFileSync(v["bom-json"], "utf8"));
      catalog = loadCatalogMap(v.map!);
    } catch (e) {
      console.error(`portal-push: ${(e as Error).message}`);
      return 2;
    }
    const plan = buildPushPlan({ project: bom.project, importId: `file:${basename(v["bom-json"])}`, lines: bom.lines, catalog, ...common });
    const requests = requestPlan(plan, portalConfig({ appVersion: v["app-version"], env }));
    if (v.json) console.log(JSON.stringify({ outcome: plan.errors.length ? "aborted" : "planned", recorded: false, plan, requests }, null, 2));
    else {
      console.log(formatPlan(plan, requests, { live: false }));
      console.log("(from files: not recorded; push live from a --project import)");
    }
    return plan.errors.length ? 1 : 0;
  }

  const db = await openDb({ url: v["db-url"] || null });
  let report: PushReport;
  try {
    await migrate(db);
    // add the default cable-part rows the database lacks (never overwrites)
    try {
      const map = loadCatalogMap(v.map!);
      if (map.cableParts?.length) await seedCatalog(db, { version: 1, rows: [], cableParts: map.cableParts });
    } catch {
      /* no map file here: the database's rows are used as they are */
    }
    report = await portalPush(db, { project: v.project!, live: v.live, confirm: v.confirm, newProposal: v["new-proposal"], appVersion: v["app-version"], env, ...common });
  } catch (e) {
    console.error(`portal-push: ${(e as Error).message}`);
    await db.close();
    return 2;
  }
  await db.close();

  if (v.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatPlan(report.plan, report.requests, { live: !!v.live }));
    console.log("");
    if (report.outcome === "planned") {
      console.log(`DRY RUN: nothing was sent to Portal. Recorded as push ${report.pushId}.`);
      console.log(`To write it to Portal: brink-merge portal-push --project ${JSON.stringify(v.project)} --live --confirm ${report.plan.hash}${v["exclude-cable"] ? " --exclude-cable" : ""}`);
    } else if (report.outcome === "aborted") console.log(`ABORTED before any write to Portal${report.error ? `: ${report.error}` : ""}. Recorded as push ${report.pushId}.`);
    else if (report.outcome === "refused") console.log(`REFUSED, nothing sent: ${report.refusal}`);
    else if (report.outcome === "succeeded") console.log(`Draft proposal ${report.result!.proposalId} created with ${report.result!.items!.length} item(s). Recorded as push ${report.pushId}.`);
    else console.log(`FAILED after writing to Portal${report.result?.proposalId ? ` (Draft proposal ${report.result.proposalId} exists, partly filled)` : ""}: ${report.error}. Recorded as push ${report.pushId}; not retried.`);
  }
  if (report.outcome === "planned" || report.outcome === "succeeded") return 0;
  return report.outcome === "refused" && !v.confirm ? 2 : 1;
}
