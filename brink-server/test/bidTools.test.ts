// The bid tools end to end over real Streamable HTTP with the real store
// modules: an invented project and plan, an invented playbook and rates,
// a takeoff with a cable run, prices recorded, price_bid writes bid.json and
// it is pushed as an output; a re-price after an owner approval clears it.
// Nothing here is a real drawing, rate or price.
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
import { BID_TOOL_NAMES } from "../src/bidTools.ts";
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

test("bid tools: settings and playbook, takeoff, record prices, price_bid → bid.json pushed with gaps and flags; re-price clears an approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brink-bid-"));
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
  const server = app.listen(0);
  const client = new Client({ name: "bid", version: "0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return r;
  };
  const refuse = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as Reply;
    assert.ok(r.isError, `${name} should refuse: ${text(r)}`);
    return text(r);
  };
  try {
    // an invented project with one plan sheet in the store
    const p = await projects.create({ name: "Invented Clinic Cabling", notes: "Solicitation FA0000-00-Q-0000 (invented)" });
    const bytes = await plan();
    await storage.put(`projects/${p.id}/files/Drawings/T-101.pdf`, bytes);
    await projects.update(p.id, (m) => {
      m.files.push({ path: "Drawings/T-101.pdf", kind: "plan", size: bytes.length, contentType: "application/pdf", pages: 1, added: new Date().toISOString(), text: "none" });
    });

    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of BID_TOOL_NAMES) assert.ok(names.includes(n), `tools/list lacks ${n}`);
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /BIDS:/);
    assert.match(instructions, /get_playbook and get_settings first/);
    assert.match(instructions, /Never claim the bid is approved/);

    // settings start empty; Claude fills them from the (invented) playbook
    const s0 = json(await call("get_settings"));
    assert.equal(s0.settings.markup.materialPct, null);
    assert.ok(s0.unset.includes("labor.targetBillRate"));
    assert.equal(json(await call("get_playbook")).playbook, null);
    await call("set_playbook", { text: "# Invented playbook\nMaterial markup 15%. Bill labor at 90/h." });
    assert.match(json(await call("get_playbook")).playbook, /Invented playbook/);
    assert.match(await refuse("update_settings", { patch: { markup: { materialPct: 15 } } }), /fraction/);
    const unit = (id: string, hours: number, per: string) => ({ id, label: id, hours, per });
    const upd = json(await call("update_settings", {
      patch: {
        labor: {
          targetBillRate: 90, trueCostRate: 40, crewSize: 2, hoursPerDay: 8, pmPctOfField: 0.1,
          unitSets: [
            { id: "standard", label: "Standard", units: [unit("wall_first", 1, "location_first"), unit("wall_add", 0.5, "cable_additional"), unit("cert", 0.25, "link"), unit("label", 0.1, "link"), unit("mobilization", 2, "job")] },
            { id: "lowered", label: "Lowered (open ceilings, short runs)", units: [] },
          ],
        },
        markup: { materialPct: 0.15, overheadPct: 0.1, profitPct: 0.15, excisePct: 0.02, bondPct: 0.03 },
        travel: { mileageRate: 0.7 },
      },
    }));
    assert.ok(upd.changes.length > 5);
    const stored = JSON.parse(Buffer.from((await storage.getBytes("system/settings.json"))!).toString("utf8"));
    assert.ok(stored.changeLog.length >= 2 && stored.changeLog.every((c: { by: string }) => c.by === "claude"), "every change logged as claude");

    // price_bid needs the project open in this conversation
    assert.match(await refuse("price_bid", { project: p.id, inputs: { excise: false, bond: false, mobilizations: 1, driveHoursPerDay: 0, milesPerDay: 0, vehicles: 0 } }), /open_project/);

    // the takeoff: two 2-cable wall outlets, a TR, one long route; d2 stays unlinked
    const opened = json(await call("open_project", { project: p.id }));
    const sheet = opened.sheets[0].sheet as string;
    await call("set_scale", { sheet, upp: UPP });
    const dev = (await call("place_count", { sheet, points: [[600, 1200], [900, 1200]], condition: "DATA-2" })).structuredContent!.shape_ids as string[];
    const tr = (await call("place_count", { sheet, points: [[4800, 1200]], condition: "TR" })).structuredContent!.shape_ids as string[];
    const route = (await call("measure_line", { sheet, pts: [[600, 1300], [4600, 1300]], condition: "ROUTE" })).structuredContent!.shape_id as string;
    await call("edit_condition", { condition: "DATA-2", waste_pct: 10, cable_setup: { device_type: "wall_outlet", cables_per_location: 2, cable_type: "CAT6A-PL", package_ft: 1000 } });
    await call("edit_condition", { condition: "TR", role: "tr" });
    await call("edit_condition", { condition: "ROUTE", role: "route" });
    await call("edit_materials", { condition: "DATA-2", add: [{ name: "CAT6A jack", per: 1, basis: "cables", unit: "EA" }, { name: "2-port faceplate", per: 1, basis: "pulls", unit: "EA" }] });
    await call("link_run", { device_shape_ids: [dev[0]], route_shape_ids: [route], tr_id: tr[0] });

    // prices: cable and jack recorded; the faceplate is left unpriced (a gap)
    assert.equal(json(await call("find_prices", { query: "cat6a" })).entries.length, 0);
    const rec = json(await call("record_prices", {
      entries: [
        { description: "CAT6A-PL", unit: "FT", price: 0.5, source: "https://supplier.example/cat6a-pl", date: "2026-11-16", status: "live" },
        { description: "CAT6A jack", manufacturer: "Invented Co", part: "J-6A", unit: "EA", price: 8, source: "Invented Supply quote #42", date: "2026-11-16", status: "estimate" },
      ],
    }));
    assert.equal(rec.added.length, 2);
    assert.match(await refuse("record_prices", { entries: [{ description: "x", unit: "EA", price: 1, source: "s", date: "yesterday", status: "live" }] }), /YYYY-MM-DD/);
    assert.equal(json(await call("find_prices", { query: "cat6a" })).entries.length, 2);

    // first run must state the job inputs
    assert.match(await refuse("price_bid", { project: p.id }), /inputs\.excise/);
    const r1 = json(await call("price_bid", { project: p.id, inputs: { excise: true, bond: true, mobilizations: 1, driveHoursPerDay: 1, milesPerDay: 40, vehicles: 1, jobHours: [{ label: "Submittals", hours: 2 }] } }));
    assert.equal(r1.revision, 1);
    assert.equal(r1.status, "draft");
    assert.equal(typeof r1.base_bid, "number");
    assert.ok(r1.base_bid > 0);
    assert.equal(typeof r1.total_with_bond, "number");
    const keys = Object.keys(r1);
    assert.ok(keys.indexOf("base_bid") < keys.indexOf("gaps") && keys.indexOf("gaps") < keys.indexOf("flags") && keys.indexOf("flags") < keys.indexOf("ratios"), keys.join(","));
    const gapText = JSON.stringify(r1.gaps.items);
    assert.match(gapText, /1 device with no linked cable run/);
    assert.match(gapText, /2-port faceplate/);
    // route 4000 px × 1/18 ft = 222.2 ft + 23 vertical + 10 + 10 = 265.2 ft per cable
    assert.match(r1.flags.items[0], /^long_link: .*265\.2 ft per cable/);
    assert.ok(r1.flags.items.some((f: string) => f.startsWith("unpriced:") && /faceplate/.test(f)));
    assert.ok(r1.flags.items.some((f: string) => f.startsWith("estimate_price:") && /jack/.test(f)));
    assert.equal(r1.ratios.links, 2);
    assert.match(r1.approval, /Draft/);
    assert.ok(r1.download?.some((d: { path: string; url: string }) => /bid\/bid\.json$/.test(d.path) && d.url.startsWith("fsstore://")), JSON.stringify(r1.download));

    // pushed: in the store and recorded as an output
    const key = `projects/${p.id}/outputs/bid/bid.json`;
    const bid1 = JSON.parse(Buffer.from((await storage.getBytes(key))!).toString("utf8")) as BidDraft;
    assert.equal(bid1.schema, "brink.bid.v1");
    assert.equal(bid1.revision, 1);
    assert.equal(bid1.totals.baseBid, r1.base_bid);
    assert.equal(bid1.lines.find((l) => l.section === "cable")?.unit, "BOX(1000FT)");
    assert.equal(bid1.lines.find((l) => l.description === "CAT6A jack")?.part, "J-6A");
    assert.ok((await projects.get(p.id))!.files.some((f) => f.kind === "output" && /bid\/bid\.json$/.test(f.path)));

    // the owner approves revision 1 on the phone page (simulated in the store)
    await storage.put(key, JSON.stringify({ ...bid1, status: "approved", approved: { at: "2026-11-16T18:00:00.000Z", revision: 1 } }));
    const sum1 = json(await call("bid_summary", { project: p.id }));
    assert.equal(sum1.status, "approved");

    // re-price with the faceplate priced: revision 2, inputs reused, approval cleared
    await call("record_prices", { entries: [{ description: "2-port faceplate", unit: "EA", price: 2.5, source: "https://supplier.example/fp2", date: "2026-11-16", status: "live" }] });
    const r2 = json(await call("price_bid", { project: p.id }));
    assert.equal(r2.revision, 2);
    assert.equal(r2.status, "draft");
    assert.match(r2.approval, /approval is cleared/);
    assert.ok(!JSON.stringify(r2.gaps.items).includes("faceplate"));
    const bid2 = JSON.parse(Buffer.from((await storage.getBytes(key))!).toString("utf8")) as BidDraft;
    assert.deepEqual([bid2.revision, bid2.status, bid2.approved], [2, "draft", undefined]);
    assert.equal(bid2.inputs.milesPerDay, 40, "inputs carried from revision 1");
    assert.ok(bid2.totals.material > bid1.totals.material);

    const sum2 = json(await call("bid_summary", { project: p.id }));
    assert.deepEqual([sum2.revision, sum2.status, sum2.base_bid], [2, "draft", r2.base_bid]);
    assert.match(sum2.note, /not approved/);
    await client.close();
  } finally {
    await client.close().catch(() => {});
    await mounted.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
