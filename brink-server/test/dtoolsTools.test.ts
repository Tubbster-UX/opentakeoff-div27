// The D-Tools MCP tools over an in-memory MCP connection, against the fake
// D-Tools API, with the real store, projects and workspace modules. The
// takeoff is the invented install fixture. Nothing here is a real client,
// product, price or credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FsStorage } from "../src/storage.ts";
import { StoreProjects } from "../src/projects.ts";
import { StoreSearch } from "../src/search.ts";
import { DiskWorkspace } from "../src/workspace.ts";
import { StorePriceBook } from "../src/pricebook.ts";
import { DTOOLS_TOOL_NAMES, registerDtoolsTools } from "../src/dtoolsTools.ts";
import { DtoolsStore } from "../src/dtools/store.ts";
import type { DtoolsClient } from "../src/dtools/client.ts";
import type { AppDeps, Config } from "../src/types.ts";
import type { OpenState } from "../src/projectTools.ts";
import { FakeDtools, inventedQuote } from "./dtoolsFake.ts";
import { installTakeoff } from "./installFixture.ts";

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const text = (r: Reply) => r.content.map((c) => c.text ?? "").join("\n");
const json = (r: Reply) => JSON.parse(r.content[0].text ?? "null");

async function setup(client: DtoolsClient | null) {
  const root = await mkdtemp(path.join(tmpdir(), "brink-dtools-"));
  const storage = new FsStorage(path.join(root, "store"));
  const projects = new StoreProjects(storage);
  const config = { publicUrl: "http://127.0.0.1", port: 0, dataDir: path.join(root, "data"), storage: { kind: "fs", root: path.join(root, "store") }, ownerPasswordHash: "x", sessionSecret: "x", maxUploadBytes: 1 << 30 } as Config;
  const deps: AppDeps = {
    config, storage, projects,
    ingest: { process: async () => { throw new Error("not in this test"); } },
    search: new StoreSearch({ storage, projects }),
    workspace: new DiskWorkspace({ storage, projects, dataDir: config.dataDir }),
  };
  const state: OpenState = { project: null, autosave: null };
  const server = new McpServer({ name: "dtools-test", version: "0" });
  registerDtoolsTools(server, { deps, session: { exportPayload: () => installTakeoff() }, state, pushOutputs: (p) => deps.workspace.syncOutputs(p), client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as Reply;
    assert.ok(!r.isError, `${name}: ${text(r)}`);
    return r;
  };
  const refuse = async (name: string, args: Record<string, unknown>) => {
    const r = (await mcp.callTool({ name, arguments: args })) as Reply;
    assert.ok(r.isError, `${name} should refuse: ${text(r)}`);
    return text(r);
  };
  return { root, storage, projects, deps, state, mcp, call, refuse, store: new DtoolsStore(storage, projects), close: async () => { await mcp.close(); await rm(root, { recursive: true, force: true }); } };
}

test("dtools tools without D-Tools configured reply \"not connected\" (not an error); mapping still works", async () => {
  const t = await setup(null);
  try {
    const names = (await t.mcp.listTools()).tools.map((x) => x.name);
    for (const n of DTOOLS_TOOL_NAMES) assert.ok(names.includes(n), `missing ${n}`);
    const p = await t.projects.create({ name: "Invented Offline Job" });
    for (const [name, args] of [["dtools_find", { kind: "clients", search: "x" }], ["dtools_sync", { project: p.id }], ["dtools_propose_prices", { entries: [{ productId: randomUUID(), unitPrice: 1, source: "s", date: "2026-11-24" }] }]] as const) {
      const r = await t.call(name, args as Record<string, unknown>);
      assert.match(text(r), /^D-Tools is not connected: add the API key in the server settings/);
    }
    const s = json(await t.call("dtools_status", { project: p.id }));
    assert.equal(s.connected, false);
    assert.match(s.note, /not connected/);
    await t.call("dtools_set_mapping", { project: p.id, conditions: { DO: { brand: "Invented Co", model: "DO-2" } } });
    assert.match(await t.refuse("dtools_set_mapping", { project: p.id, conditions: { X: { brand: "only brand" } } }), /brand, model\} or \{partNumber\}/);
    assert.equal((await t.store.getMapping(p.id)).conditions.DO.model, "DO-2");
  } finally {
    await t.close();
  }
});

test("dtools tools: create / update logged, link verifies ids, sync reports changes, quote, mapping, reconcile, quote inputs, price proposals", async () => {
  const fake = await new FakeDtools().start();
  const t = await setup(fake.client());
  try {
    const existing = randomUUID();
    fake.clients.push({ id: existing, name: "Invented Clinic Group", isActive: true });
    const dtProject = randomUUID();
    fake.projects.push({ id: dtProject, clientId: existing, name: "Invented Clinic (D-Tools project)", number: "P-77", stage: "Scheduled", price: 0, projectManager: null, startDate: null });
    const prodDO = randomUUID();
    const prodAP = randomUUID();
    fake.products.push(
      { id: prodDO, brand: "Invented Co", model: "DO-2", partNumber: "IC-DO2", isLengthBased: false, msrp: 55, unitCost: 22, unitPrice: 40, isActive: true },
      { id: prodAP, brand: "Invented Wireless", model: "AP-9", partNumber: "IW-AP9", isLengthBased: false, msrp: 800, unitCost: 410, unitPrice: 600, isActive: true },
    );
    const p = await t.projects.create({ name: "Invented Clinic Cabling", notes: "Invented RFQ 0000" });

    // clients: a duplicate name is refused, a new one created and logged
    assert.match(await t.refuse("dtools_create_client", { name: "invented clinic group" }), /already exists/);
    const cc = json(await t.call("dtools_create_client", { name: "Invented Ortho Partners", type: "Commercial", email: "office@ortho.invalid" }));
    assert.ok(fake.clients.some((c) => c.id === cc.id && c.name === "Invented Ortho Partners"));

    // opportunity from the project, linked
    const co = json(await t.call("dtools_create_opportunity", { project: p.id, clientId: existing, budget: 18000, estimatedCloseDate: "2026-12-15", siteAddress: { addressLine1: "1 Invented Way", city: "Nowhere", state: "SD" } }));
    const opp = fake.opportunities.find((o) => o.id === co.id)!;
    assert.equal(opp.name, "Invented Clinic Cabling", "name defaults to the project's");
    assert.equal(opp.estimatedCloseDate, "2026-12-15T00:00:00Z");
    assert.deepEqual([co.links.opportunityId, co.links.clientId], [co.id, existing]);
    assert.match(await t.refuse("dtools_create_opportunity", { project: p.id, clientId: existing }), /already linked/);

    // update: only the given fields change; the full-replace PUT keeps the rest
    const up = json(await t.call("dtools_update_opportunity", { project: p.id, fields: { budget: 25000, quoteTemplate: "Invented Commercial" } }));
    assert.deepEqual(up.changed.budget, { before: 18000, after: 25000 });
    assert.deepEqual(up.changed.quoteTemplate, { before: null, after: "Invented Commercial" });
    assert.equal(opp.name, "Invented Clinic Cabling");
    assert.equal(opp.siteAddress.addressLine1, "1 Invented Way");
    assert.equal(opp.estimatedCloseDate, "2026-12-15T00:00:00Z");

    // link verifies: an unknown id links nothing
    assert.match(await t.refuse("dtools_link", { project: p.id, projectId: randomUUID() }), /No project .* in D-Tools.*Nothing was linked/);
    json(await t.call("dtools_link", { project: p.id, projectId: dtProject }));
    const upp = json(await t.call("dtools_update_project", { project: p.id, fields: { projectManager: "Invented PM", startDate: "2027-01-04" } }));
    assert.deepEqual(upp.changed.projectManager, { before: null, after: "Invented PM" });
    assert.equal(fake.projects[0].name, "Invented Clinic (D-Tools project)");

    // every write is in the log as claude
    const log = await t.store.readLog({ limit: 50 });
    const writes = log.filter((e) => e.action === "create" || e.action === "update").map((e) => `${e.actor}:${e.action}:${e.entity}`);
    assert.deepEqual(writes.sort(), ["claude:create:client", "claude:create:opportunity", "claude:update:opportunity", "claude:update:project"]);
    assert.deepEqual(log.find((e) => e.action === "update" && e.entity === "opportunity")!.after, { budget: 25000, quoteTemplate: "Invented Commercial" });

    // sync: lists the opportunity's quotes until one is linked
    const quote = inventedQuote(co.id);
    fake.quotes.push(quote);
    const s1 = json(await t.call("dtools_sync", { project: p.id }));
    assert.equal(s1.quotes_available[0].id, quote.id);
    assert.match(await t.refuse("dtools_link", { project: p.id, quoteId: randomUUID() }), /No quote/);
    const ln = json(await t.call("dtools_link", { project: p.id, quoteId: quote.id }));
    assert.equal(ln.links.quoteId, quote.id);
    assert.equal(ln.links.opportunityId, co.id);
    // changes in D-Tools show up in the next sync
    opp.stage = "Proposal";
    quote.items[0].quantity = 3;
    quote.items.push({ id: 99, type: "Product", brand: "Invented Co", model: "FP-1", quantity: 4, location: "Lobby", locationId: 4, unitPrice: 3 });
    const s2 = json(await t.call("dtools_sync", { project: p.id }));
    const changes = s2.changes.join("\n");
    assert.match(changes, /opportunity .*stage "New" → "Proposal"/);
    assert.match(changes, /~ Invented Co DO-2 @ 101 office: qty 2 → 3/);
    assert.match(changes, /\+ Invented Co FP-1 @ Lobby ×4/);
    assert.deepEqual(s2.unchanged, ["project"]);
    const s3 = json(await t.call("dtools_sync", { project: p.id }));
    assert.equal(s3.note, "Nothing changed since the last sync.");
    quote.items[0].quantity = 2;
    quote.items.pop();

    // quote reads, small pages
    const qs = json(await t.call("dtools_quote", { project: p.id, fresh: true }));
    assert.deepEqual([qs.quote.number, qs.items, qs.labor_or_package_lines], ["Q-1001", 7, 1]);
    const qi = json(await t.call("dtools_quote", { project: p.id, part: "items", location: "open office area" }));
    assert.equal(qi.total_items, 2);
    const ql = json(await t.call("dtools_quote", { project: p.id, part: "locations" }));
    assert.ok(ql.locations.some((l: { location: string; value: number }) => l.location === "Lobby" && l.value === 1350));

    // mapping, then reconcile needs the takeoff open
    await t.call("dtools_set_mapping", {
      project: p.id,
      conditions: { DO: { brand: "Invented Co", model: "DO-2" }, WAP: { partNumber: "IW-AP9" }, CAM: { brand: "Invented Cams", model: "C-1", category: "Surveillance" } },
      cables: { "CAT6A plenum": { brand: "Invented Cable", model: "C6A-PL" } },
      rooms: { "Open Office": "Open Office Area", "Storage 202": "Conference 201" },
    });
    assert.match(await t.refuse("dtools_reconcile", { project: p.id }), /open_project/);
    t.state.project = p.id;
    fake.products.push({ id: randomUUID(), brand: "Invented Cams", model: "C-1-OLD", isLengthBased: false, unitPrice: 999, isActive: true }); // a near miss, not a match
    const rc = json(await t.call("dtools_reconcile", { project: p.id }));
    assert.match(rc.differences[0].message, /IW-AP9.*takeoff 3, quote 1/);
    assert.equal(rc.differences[0].impact, 1200);
    assert.ok(rc.differences.some((d: { kind: string; impact: number | null }) => d.kind === "missing_from_quote" && d.impact === null), "camera: not in the catalog, so no price");
    assert.ok(rc.download.some((d: { path: string }) => /dtools\/reconcile\.json$/.test(d.path)));
    assert.ok(await t.storage.getBytes(`projects/${p.id}/outputs/dtools/reconcile.json`));

    // quote inputs: CSV of the products the catalog lacks (camera, cable), scope text, links
    await new StorePriceBook(t.storage).record([{ description: "Camera", manufacturer: "Invented Cams", part: "C-1", unit: "EA", price: 199.5, source: "Invented Supply quote #9", date: "2026-11-20", status: "estimate" }]);
    const qin = json(await t.call("dtools_quote_inputs", { project: p.id }));
    assert.deepEqual(qin.catalog_import.products, ["Invented Cams C-1", "Invented Cable C6A-PL"]);
    assert.equal(qin.already_in_catalog.length, 2);
    assert.ok(qin.unmapped.some((u: string) => /^ACD/.test(u)));
    assert.match(qin.unit_costs[0], /Invented Cams C-1: Unit Cost 199\.5 from the price book \(Invented Supply quote #9, 2026-11-20\)/);
    assert.equal(qin.download.length, 2);
    const csv = Buffer.from((await t.storage.getBytes(`projects/${p.id}/outputs/dtools/catalog-import.csv`))!).toString("utf8").split("\r\n");
    assert.equal(csv[0], "Brand,Model,Part Number,Short Description,Description,Category,Keywords,MSRP,Unit Cost,Unit Price,Taxable,Supplier,System,Phase");
    assert.equal(csv[1], "Invented Cams,C-1,,Camera (CAT6 outdoor),Camera (CAT6 outdoor) (takeoff: CAM),Surveillance,CAM,,199.5,,,,,");
    assert.match(csv[2], /^Invented Cable,C6A-PL,,CAT6A plenum cable,/);
    const scope = Buffer.from((await t.storage.getBytes(`projects/${p.id}/outputs/dtools/scope-by-location.txt`))!).toString("utf8");
    assert.match(scope, /\nOffice 101: 2 x Data outlet, 2-port \(CAT6A plenum\) \[DO; Invented Co DO-2\]\n/);

    // price proposals: queued, never applied
    const pp = json(await t.call("dtools_propose_prices", { entries: [
      { productId: prodAP, unitCost: 395, unitPrice: 585, source: "https://distributor.invalid/iw-ap9", date: "2026-11-24" },
      { productId: prodDO, unitPrice: 40, source: "https://distributor.invalid/do2", date: "2026-11-24" },
      { productId: randomUUID(), unitPrice: 1, source: "x", date: "2026-11-24" },
    ] }));
    assert.equal(pp.queued.length, 1);
    assert.deepEqual(pp.queued[0].proposed, { unitCost: 395, unitPrice: 585 });
    assert.deepEqual(pp.queued[0].old, { msrp: 800, unitCost: 410, unitPrice: 600 });
    assert.equal(pp.skipped.length, 2);
    assert.match(pp.note, /owner approves/);
    assert.equal(fake.products.find((x) => x.id === prodAP)!.unitPrice, 600, "nothing applied");
    assert.equal(fake.callsTo("Products/UpdateProductPrices").length, 0);
    const pending = await t.store.listPending("pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, "https://distributor.invalid/iw-ap9");

    // status for the project
    const st = json(await t.call("dtools_status", { project: p.id }));
    assert.equal(st.connected, true);
    assert.deepEqual([st.links.opportunityId, st.links.projectId, st.links.quoteId], [co.id, dtProject, quote.id]);
    assert.ok(st.links.lastSync);
    assert.equal(st.pending_price_changes, 1);
    assert.deepEqual(st.mapping, { conditions: 3, cables: 1, rooms: 2 });
    assert.ok(st.recent.length >= 4);
    assert.equal(fake.unauthorized, 0);
  } finally {
    await t.close();
    await fake.stop();
  }
});
