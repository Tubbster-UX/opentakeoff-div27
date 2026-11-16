// One whole invented bid through every piece, the way the owner will use it:
// settings and prices → takeoff with linked cable runs → price_bid with no gaps
// → the workbook's formulas agree with the pricing → GC quote and federal
// package as DRAFT → the owner approves on the phone page (the real route) →
// final files re-made without DRAFT. Nothing here is a real drawing, rate,
// price or company.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FsStorage } from "../src/storage.ts";
import { StoreProjects } from "../src/projects.ts";
import { StoreSearch } from "../src/search.ts";
import { DiskWorkspace } from "../src/workspace.ts";
import { createMountMcp } from "../src/mcp.ts";
import { bidRoutes } from "../src/approval.ts";
import { rerenderApproved } from "../src/bidExportTools.ts";
import { workbookDifferences } from "../src/bid/workbook.ts";
import { fixtureSettings, gcContent, federalContent } from "./bidFixture.ts";
import type { AppDeps, Config } from "../src/types.ts";
import type { BidDraft } from "../src/bidTypes.ts";

type Reply = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r: Reply) => JSON.parse(r.content[0].text ?? "null");

async function plan(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([2592, 1728]);
  page.drawText("T-101 TELECOM PLAN (INVENTED FIXTURE)", { x: 72, y: 1600, size: 24, font });
  return doc.save();
}

const UPP = 8 / 144; // 1/8" = 1'-0" at render scale 2.0

test("a whole invented bid: priced with no gaps, workbook agrees, drafts, owner approval re-makes finals without DRAFT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-full-"));
  const storage = new FsStorage(path.join(root, "store"));
  const projects = new StoreProjects(storage);
  const config = { publicUrl: "http://127.0.0.1", port: 0, dataDir: path.join(root, "data"), storage: { kind: "fs", root: path.join(root, "store") }, ownerPasswordHash: "x", sessionSecret: "x", maxUploadBytes: 1 << 30 } as Config;
  const deps: AppDeps = {
    config, storage, projects,
    ingest: { process: async () => { throw new Error("not in this test"); } },
    search: new StoreSearch({ storage, projects }),
    workspace: new DiskWorkspace({ storage, projects, dataDir: config.dataDir }),
  };
  const app = express();
  const mounted = createMountMcp({ syncDebounceMs: 50, autosave: { debounceMs: 20, maxWaitMs: 100 }, brink: false, log: () => {} })(app, deps, (_req, _res, next) => next());
  // the owner's approval route, as http.ts mounts it (cookie + CSRF are tested in approval.test.ts)
  app.use("/api", express.json(), bidRoutes(deps, { onApproved: (project) => rerenderApproved(deps, project) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: "full", version: "0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return r;
  };
  try {
    const p = await projects.create({ name: "Invented Hangar Cabling", notes: "Solicitation FA0000-00-Q-0000 (invented)" });
    const bytes = await plan();
    await storage.put(`projects/${p.id}/files/Drawings/T-101.pdf`, bytes);
    await projects.update(p.id, (m) => {
      m.files.push({ path: "Drawings/T-101.pdf", kind: "plan", size: bytes.length, contentType: "application/pdf", pages: 1, added: new Date().toISOString(), text: "none" });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

    // settings the way Claude fills them from the playbook (invented values)
    const unit = (id: string, hours: number, per: string) => ({ id, label: id, hours, per });
    const s = fixtureSettings();
    await call("update_settings", {
      patch: {
        company: s.company,
        labor: {
          targetBillRate: 100, trueCostRate: 35, crewSize: 2, hoursPerDay: 8, pmPctOfField: 0.08,
          unitSets: [
            { id: "standard", label: "Standard", units: [unit("wall_first", 1.2, "location_first"), unit("wall_add", 0.45, "cable_additional"), unit("cert", 0.1, "link"), unit("label", 0.135, "link"), unit("mobilization", 4, "job")] },
            { id: "lowered", label: "Lowered (open ceilings, short runs)", units: [] },
          ],
        },
        markup: { materialPct: 0.15, overheadPct: 0.1, profitPct: 0.15, excisePct: 0.02, bondPct: 0.015 },
        travel: { mileageRate: 0.7 },
        proposal: { validityDays: 45, paymentTerms: "Net 30 (invented)", warranty: "One year on installation (invented).", standardExclusions: ["Conduit and back boxes"], standardClarifications: ["Normal working hours"] },
      },
    });

    // the takeoff: two 2-cable wall outlets, both linked over one route to the TR
    const opened = json(await call("open_project", { project: p.id }));
    const sheet = opened.sheets[0].sheet as string;
    await call("set_scale", { sheet, upp: UPP });
    const dev = (await call("place_count", { sheet, points: [[600, 1200], [900, 1200]], condition: "DATA-2" })).structuredContent!.shape_ids as string[];
    const tr = (await call("place_count", { sheet, points: [[2400, 1200]], condition: "TR" })).structuredContent!.shape_ids as string[];
    const route = (await call("measure_line", { sheet, pts: [[600, 1300], [2300, 1300]], condition: "ROUTE" })).structuredContent!.shape_id as string;
    await call("edit_condition", { condition: "DATA-2", waste_pct: 12, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A-PL", package_ft: 1000, vertical_ft: 23, loop_device_ft: 10, loop_tr_ft: 10 } });
    await call("edit_condition", { condition: "TR", role: "tr" });
    await call("edit_condition", { condition: "ROUTE", role: "route" });
    await call("edit_materials", { condition: "DATA-2", add: [{ name: "CAT6A jack", per: 1, basis: "cables", unit: "EA" }, { name: "2-port faceplate", per: 1, basis: "pulls", unit: "EA" }] });
    await call("link_run", { device_shape_ids: [dev[0]], route_shape_ids: [route], tr_id: tr[0] });
    await call("link_run", { device_shape_ids: [dev[1]], route_shape_ids: [route], tr_id: tr[0] });
    await call("record_prices", {
      entries: [
        { description: "CAT6A-PL", unit: "BOX(1000FT)", price: 400, source: "https://supplier.example/cat6a-pl", date: new Date().toISOString().slice(0, 10), status: "live" },
        { description: "CAT6A jack", manufacturer: "Invented Co", part: "J-6A", unit: "EA", price: 9, source: "Invented Supply quote #42", date: new Date().toISOString().slice(0, 10), status: "live" },
        { description: "2-port faceplate", unit: "EA", price: 2.5, source: "https://supplier.example/fp2", date: new Date().toISOString().slice(0, 10), status: "live" },
      ],
    });

    const priced = json(await call("price_bid", { project: p.id, inputs: { excise: true, bond: false, mobilizations: 1, driveHoursPerDay: 0, milesPerDay: 20, vehicles: 1, jobHours: [{ label: "Cleanup", hours: 2 }] } }));
    assert.equal(priced.gaps.count ?? priced.gaps.items?.length ?? 0, 0, JSON.stringify(priced.gaps));
    assert.equal(typeof priced.base_bid, "number");
    const bidKey = `projects/${p.id}/outputs/bid/bid.json`;
    const bid = JSON.parse(Buffer.from((await storage.getBytes(bidKey))!).toString("utf8")) as BidDraft;
    assert.equal(bid.gaps.length, 0, JSON.stringify(bid.gaps));
    // labor per pull, not per cable: 2 locations × 1.2 + 2 additional cables × 0.45
    const pull = bid.hours.filter((h) => h.unitId === "wall_first" || h.unitId === "wall_add").reduce((n, h) => n + h.hours, 0);
    assert.equal(Math.round(pull * 100) / 100, 3.3);
    // the pricing and the workbook's own formulas agree to the cent
    assert.deepEqual(workbookDifferences(bid), []);

    // drafts
    await call("set_proposal_content", { project: p.id, kind: "gc", content: gcContent() });
    await call("set_proposal_content", { project: p.id, kind: "federal", content: federalContent() });
    const wb = json(await call("export_bid_workbook", { project: p.id }));
    assert.equal(wb.workbook_check, undefined, wb.workbook_check);
    const gc = json(await call("export_gc_proposal", { project: p.id }));
    const fed = json(await call("export_federal_package", { project: p.id }));
    for (const f of [...wb.files, ...gc.files, ...fed.files]) assert.match(f.path, /DRAFT/, f.path);
    assert.match(gc.status, /DRAFT r1/);

    // the owner approves revision 1 on the phone page; finals are re-made without DRAFT
    const res = await fetch(`${base}/api/projects/${p.id}/bid/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1 }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.warning, undefined, body.warning);
    assert.equal(body.rerendered.length, 6, JSON.stringify(body.rerendered)); // workbook + quote + 2 × (docx + pdf)
    for (const f of body.rerendered as string[]) assert.doesNotMatch(f, /DRAFT/, f);
    const quotePath = (body.rerendered as string[]).find((f) => /quote r1\.pdf$/.test(f))!;
    const quote = await storage.getBytes(`projects/${p.id}/${quotePath}`);
    assert.ok(quote && quote.length > 1000, "final quote in the store");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({ data: new Uint8Array(quote), useSystemFonts: true }).promise;
    let all = "";
    for (let i = 1; i <= doc.numPages; i++) all += (await (await doc.getPage(i)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
    assert.doesNotMatch(all, /DRAFT/);
    assert.doesNotMatch(all, /OpenTakeoff/);
    assert.match(all, new RegExp(bid.totals.baseBid!.toLocaleString("en-US", { minimumFractionDigits: 2 }).replace(/[.,$]/g, "\\$&")));
    // a re-price makes a new draft that needs approving again
    const again = json(await call("price_bid", { project: p.id }));
    assert.equal(again.revision, 2);
    assert.equal(again.status, "draft");
  } finally {
    await client.close().catch(() => {});
    await mounted.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
