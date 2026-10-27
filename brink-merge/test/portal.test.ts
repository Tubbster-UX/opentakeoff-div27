// Portal push: plan, request order, auth, aborts, and the push record. Every
// Portal response here is a mock; no test ever reaches api.portal.io.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { BomLine } from "../src/bom.js";
import type { CatalogMap } from "../src/catalog.js";
import { main } from "../src/cli.js";
import { migrate, openPglite, type Db } from "../src/db/db.js";
import { loadCatalog, saveMerge, seedCatalog, upsertCatalogRow } from "../src/db/repository.js";
import { merge } from "../src/pipeline.js";
import { PortalClient, jwtExp, redact, type FetchLike } from "../src/portal/client.js";
import { PushAborted, executeLivePush } from "../src/portal/execute.js";
import { buildPushPlan, parsePartId, requestPlan, type PushPlan } from "../src/portal/plan.js";
import { portalPush } from "../src/portal/push.js";
import { setItemQtyRequest, setItemSellPriceRequest } from "../src/portal/requests.js";
import { catalog, clone, load } from "./helpers.js";

const CFG = { baseUrl: "https://portal.test", appVersion: "9.9.9-test" };
const PART: Record<string, string> = { "DATA-1": "1001", "WAP-1": "1002", "CAM-1": "1003", "ACS-1": "1004", TR: "1005" };

/** The seed catalog with every device / TR row confirmed under a fake partId, and confirmed cable parts. */
function confirmedCatalog(): CatalogMap {
  const map = catalog();
  for (const r of map.rows) if (PART[r.conditionKey]) Object.assign(r, { status: "confirmed", portalSku: PART[r.conditionKey] });
  map.cableParts = [
    { cableType: "CAT6A CMP", portalSku: "2001", orderBasis: "box", packageFt: 1000, portalUnitOfMeasure: "Box", status: "confirmed" },
    { cableType: "CAT6 CMP", portalSku: "2002", orderBasis: "box", packageFt: 1000, portalUnitOfMeasure: "Box", status: "confirmed" },
    { cableType: "18/4 SHLD CMP", portalSku: "2003", orderBasis: "ft", packageFt: null, portalUnitOfMeasure: "Foot", status: "confirmed" },
  ];
  return map;
}

function sample(map: CatalogMap = confirmedCatalog()) {
  const result = merge(load("div27-sample"), map, { date: "2026-10-27" });
  return { map, result, lines: result.bom.lines };
}

const planFor = (map: CatalogMap = confirmedCatalog(), extra: Partial<Parameters<typeof buildPushPlan>[0]> = {}) => {
  const { result } = sample(map);
  return buildPushPlan({ project: result.project, importId: "imp-1", lines: result.bom.lines, issues: result.issues, catalog: map, ...extra });
};

const codes = (p: PushPlan) => p.errors.map((e) => `${e.code}:${e.conditionKey ?? ""}`);

// ---------- mock Portal ----------

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number, n: number) => `eyJhbGciOiJIUzI1NiJ9.${b64({ exp, n })}.sig${n}`;

interface Call { method: string; url: string; path: string; query: string; headers: Record<string, string>; body?: any }

function mockPortal(opts: {
  now: () => number;
  parts?: Record<number, Record<string, unknown> | 404>;
  fail?: (c: Call, n: number) => { status: number; body?: unknown } | null;
} ) {
  const calls: Call[] = [];
  let tokenN = 0;
  let itemId = 500;
  const parts: Record<number, Record<string, unknown> | 404> = opts.parts ?? defaultParts();
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const c: Call = { method: init.method, url, path: u.pathname, query: u.search, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(c);
    const res = (status: number, body?: unknown) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
    const forced = opts.fail?.(c, calls.length);
    if (forced) return res(forced.status, forced.body);
    if (c.path === "/authenticate/login") return res(200, { bearerToken: "b", refreshToken: "REFRESH-SECRET", sessionId: "s", userId: 1, userName: "u", displayName: "U", roles: [] });
    if (c.path === "/access-token") return res(200, { accessToken: jwt(Math.floor(opts.now() / 1000) + 300, ++tokenN) });
    const m = c.path.match(/^\/products\/basicinfo\/(\d+)$/);
    if (m) {
      const p = parts[Number(m[1])];
      return p === 404 || !p ? res(404, { message: "not found" }) : res(200, p);
    }
    if (c.method === "POST" && c.path === "/proposals") return res(200, { id: 777, name: c.body.name, status: "Draft" });
    if (c.method === "GET" && c.path === "/proposals/777") return res(200, { id: 777, proposalDates: { lastModified: "Tue, 27 Oct 2026 18:00:00 GMT" } });
    if (c.path === "/proposals/777/area") return res(200, { id: 31, name: c.body.name, areaType: "Area", itemOrder: 1, areaOptions: [{ id: 41, areaId: 31, status: "Draft" }] });
    if (c.path === "/proposals/777/items") return res(200, { proposalItemIds: [++itemId] });
    return res(599, { unexpected: c.path });
  };
  return { fetch, calls };
}

function defaultParts(): Record<number, Record<string, unknown>> {
  const out: Record<number, Record<string, unknown>> = {};
  const add = (partId: number, cost: number, sellPrice: number, unitOfMeasure = "Each") =>
    (out[partId] = { partId, brand: "Brand", model: `M${partId}`, modelShortDescription: "x", supplierId: 90 + (partId % 10), supplierName: "S", supplierSku: `S${partId}`, cost, sellPrice, sellPriceType: "Markup", unitOfMeasure, status: "Activated" });
  add(1001, 10, 15); add(1002, 200, 300); add(1003, 150, 225); add(1004, 80, 120); add(1005, 60, 90);
  add(2001, 400, 520, "Box"); add(2002, 250, 330, "Box"); add(2003, 0.4, 0.65, "Foot");
  return out;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method === "POST" && !["/authenticate/login", "/access-token"].includes(c.path));

// ---------- plan ----------

describe("Portal push plan", () => {
  it("parses portal_sku strictly as a positive integer partId", () => {
    expect(parsePartId("1001")).toBe(1001);
    expect(parsePartId(" 42 ")).toBe(42);
    for (const bad of [null, "", "0", "-3", "12.5", "1e3", "ABC-12", "0012", "99999999999999999999"]) expect(parsePartId(bad)).toBeNull();
  });

  it("maps the sample's confirmed device / TR lines and cable order lines to Portal items", () => {
    const plan = planFor();
    expect(plan.errors).toEqual([]);
    expect(plan.items.map((i) => [i.seq, i.source, i.conditionKey, i.partId, i.itemQuantity])).toEqual([
      [1, "tr", "TR", 1005, 2],
      [2, "device", "DATA-1", 1001, 7],
      [3, "device", "WAP-1", 1002, 4],
      [4, "device", "CAM-1", 1003, 3],
      [5, "device", "ACS-1", 1004, 2],
      [6, "cable_order", "DATA-1, WAP-1", 2001, 2],
      [7, "cable_order", "CAM-1", 2002, 1],
      [8, "cable_order", "ACS-1", 2003, 152],
    ]);
    expect(plan.items[7].quantityRule).toContain("151.47");
    // everything else is listed, never dropped silently
    expect(plan.notPushed.map((n) => `${n.lineNo}:${n.kind}`)).toEqual([
      "3:cable", "4:cable", "5:material", "6:material", "8:cable", "9:cable", "11:cable", "12:cable", "13:material", "15:cable", "16:pathway", "17:pathway",
    ]);
    expect(plan.proposalName).toBe("Brink Div 27 sample (invented) - Division 27");
    expect(plan.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(planFor().hash).toBe(plan.hash);
    expect(planFor(confirmedCatalog(), { areaName: "Other" }).hash).not.toBe(plan.hash);
  });

  it("builds the exact ordered request plan, with secrets redacted", () => {
    const plan = planFor();
    const reqs = requestPlan(plan, CFG);
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://portal.test/authenticate/login?skipInterceptors&appVersion=9.9.9-test",
      "POST https://portal.test/access-token?skipInterceptors&appVersion=9.9.9-test",
      ...[1005, 1001, 1002, 1003, 1004, 2001, 2002, 2003].map((p) => `GET https://portal.test/products/basicinfo/${p}?appVersion=9.9.9-test`),
      "POST https://portal.test/proposals?appVersion=9.9.9-test",
      "GET https://portal.test/proposals/<proposal.id>?excludeDescriptions=true&frameOnly=true&showAreaOptionDescription=true&appVersion=9.9.9-test",
      "POST https://portal.test/proposals/<proposal.id>/area?appVersion=9.9.9-test",
      ...Array(8).fill("POST https://portal.test/proposals/<proposal.id>/items?appVersion=9.9.9-test"),
    ]);
    expect(reqs[0].body).toBe("<redacted: credentials>");
    expect(reqs[0].headers.Authorization).toBeUndefined();
    expect(reqs[2].headers.Authorization).toBe("Bearer <redacted>");
    expect(reqs[10].body).toEqual({ name: plan.proposalName });
    expect(reqs[12].headers["If-Unmodified-Since"]).toBe("<proposal.proposalDates.lastModified>");
    expect(reqs[12].body).toEqual({ name: "Division 27" });
    expect(reqs[13].body).toEqual({
      items: [{
        referencedItemId: 1005, itemType: "Part", supplierId: "<basicinfo 1005.supplierId>", cost: "<basicinfo 1005.cost>", sellPrice: "<basicinfo 1005.sellPrice>",
        proposalAreaOptions: [{ proposalAreaOptionId: "<area.areaOptions[0].id>", itemQuantity: 2 }],
        isSupplierChanged: false, setDefaultSellPrice: false, parentProposalItemIds: [],
      }],
      includeAttachments: true,
    });
    // refresh-token auth skips the login step
    expect(requestPlan(plan, CFG, "refresh_token")[0].url).toContain("/access-token");
    // nothing that sends, finalizes or assigns a customer is ever planned
    expect(reqs.some((r) => /send|final|email|status|assignpeople/i.test(r.url))).toBe(false);
  });

  it("aborts on the seeded (proposed) catalog and lists every offending line", () => {
    const plan = planFor(catalog());
    expect(plan.items.length).toBe(0);
    expect(codes(plan)).toEqual([
      "not_confirmed:TR", "not_confirmed:DATA-1", "not_confirmed:WAP-1", "not_confirmed:CAM-1", "not_confirmed:ACS-1",
      "cable_not_confirmed:DATA-1, WAP-1", "cable_not_confirmed:CAM-1", "cable_not_confirmed:ACS-1",
    ]);
  });

  it("aborts on confirmed rows with a missing or invalid portal_sku", () => {
    const map = confirmedCatalog();
    map.rows.find((r) => r.conditionKey === "WAP-1")!.portalSku = null;
    map.rows.find((r) => r.conditionKey === "CAM-1")!.portalSku = "CAM-ABC";
    map.rows.find((r) => r.conditionKey === "ACS-1")!.portalSku = "12.5";
    map.cableParts![1].portalSku = "0";
    expect(codes(planFor(map))).toEqual(["missing_portal_sku:WAP-1", "invalid_portal_sku:CAM-1", "invalid_portal_sku:ACS-1", "invalid_portal_sku:CAM-1"]);
  });

  it("aborts when the import itself has errors (an unmapped condition)", () => {
    const map = confirmedCatalog();
    map.rows = map.rows.filter((r) => r.conditionKey !== "ACS-1");
    const plan = planFor(map);
    expect(codes(plan)).toEqual(["import_error:ACS-1", "unmapped:ACS-1"]);
  });

  it("aborts when the catalog changed after the import (stale portal_sku)", () => {
    const map = confirmedCatalog();
    const { lines, result } = sample(map);
    const now = clone(map);
    now.rows.find((r) => r.conditionKey === "DATA-1")!.portalSku = "1999";
    expect(codes(buildPushPlan({ project: "p", importId: "i", lines, issues: result.issues, catalog: now }))).toEqual(["stale_import:DATA-1"]);
  });

  it("aborts on a non-integer device quantity", () => {
    const { lines, result, map } = sample();
    const bad = clone(lines);
    bad.find((l: BomLine) => l.conditionKey === "WAP-1" && l.kind === "device")!.qty = 3.5;
    expect(codes(buildPushPlan({ project: "p", importId: "i", lines: bad, issues: result.issues, catalog: map }))).toEqual(["non_integer_qty:WAP-1"]);
  });

  it("maps cable only when unambiguous: box size, package match, unitOfMeasure, order line", () => {
    const map = confirmedCatalog();
    map.cableParts![2] = { ...map.cableParts![2], orderBasis: "box", packageFt: 500 }; // OT gave no box size for 18/4
    map.cableParts![0].packageFt = 500; // OT rounded CAT6A to 1000 ft boxes
    map.cableParts![1].portalUnitOfMeasure = null;
    expect(codes(planFor(map))).toEqual(["cable_package_mismatch:DATA-1, WAP-1", "cable_unit_unset:CAM-1", "cable_no_package:ACS-1"]);

    const unmapped = confirmedCatalog();
    unmapped.cableParts = unmapped.cableParts!.filter((c) => c.cableType !== "CAT6 CMP");
    expect(codes(planFor(unmapped))).toEqual(["cable_unmapped:CAM-1"]);

    const { lines, result } = sample();
    const noOrder = lines.filter((l) => !(l.kind === "cable_order" && l.cableType === "CAT6 CMP"));
    expect(codes(buildPushPlan({ project: "p", importId: "i", lines: noOrder, issues: result.issues, catalog: confirmedCatalog() }))).toEqual(["cable_no_order_line:"]);
  });

  it("--exclude-cable leaves every cable line out explicitly", () => {
    const map = confirmedCatalog();
    delete map.cableParts;
    const plan = planFor(map, { excludeCable: true });
    expect(plan.errors).toEqual([]);
    expect(plan.items.map((i) => i.source)).toEqual(["tr", "device", "device", "device", "device"]);
    expect(plan.notPushed.filter((n) => n.reason === "cable excluded by request").length).toBe(10);
  });

  it("refuses to ignore a Portal partId on a line it has no rule for (pathway)", () => {
    const map = confirmedCatalog();
    Object.assign(map.rows.find((r) => r.conditionKey === "TRUNK")!, { portalSku: "3001" });
    expect(codes(planFor(map))).toEqual(["no_push_rule:TRUNK"]);
  });
});

// ---------- live executor against a mock Portal ----------

describe("Portal live executor (mock fetch)", () => {
  it("makes exactly the planned requests, in order, with basicinfo prices and If-Unmodified-Since", async () => {
    let t = 1_800_000_000_000;
    const portal = mockPortal({ now: () => t });
    const client = new PortalClient(CFG, { userName: "est@brink.test", password: "PW-SECRET" }, { fetch: portal.fetch, now: () => t });
    const plan = planFor();
    const res = await executeLivePush(plan, client);
    expect(res).toMatchObject({ proposalId: 777, areaId: 31, areaOptionId: 41 });
    expect(res.items.map((i) => i.proposalItemId)).toEqual([501, 502, 503, 504, 505, 506, 507, 508]);

    // the live calls are the dry-run plan, with the placeholders filled in
    const planned = requestPlan(plan, CFG).map((r) => `${r.method} ${r.url.replace(/<proposal\.id>/g, "777")}`);
    expect(portal.calls.map((c) => `${c.method} ${c.url}`)).toEqual(planned);

    for (const c of portal.calls) {
      expect(c.query).toContain("appVersion=9.9.9-test");
      expect(c.headers.Cookie).toBeUndefined();
      expect(c.headers.Accept).toBe("application/json");
    }
    expect(portal.calls[0].body).toEqual({ userName: "est@brink.test", password: "PW-SECRET" });
    expect(portal.calls[1].body).toEqual({ refreshToken: "REFRESH-SECRET", useTokenCookie: false });
    expect(portal.calls[2].headers.Authorization).toBe(`Bearer ${jwt(Math.floor(t / 1000) + 300, 1)}`);
    const get = portal.calls[11];
    const area = portal.calls[12];
    expect(get.path).toBe("/proposals/777");
    expect(area.headers["If-Unmodified-Since"]).toBe("Tue, 27 Oct 2026 18:00:00 GMT");
    expect(area.body).toEqual({ name: "Division 27" });

    const items = portal.calls.slice(13);
    expect(items.map((c) => c.body.items.length)).toEqual(Array(8).fill(1));
    expect(items[0].body).toEqual({
      items: [{
        referencedItemId: 1005, itemType: "Part", supplierId: 95, cost: 60, sellPrice: 90,
        proposalAreaOptions: [{ proposalAreaOptionId: 41, itemQuantity: 2 }], isSupplierChanged: false, setDefaultSellPrice: false, parentProposalItemIds: [],
      }],
      includeAttachments: true,
    });
    expect(items[7].body.items[0]).toMatchObject({ referencedItemId: 2003, supplierId: 93, cost: 0.4, sellPrice: 0.65, proposalAreaOptions: [{ proposalAreaOptionId: 41, itemQuantity: 152 }] });
    expect(items.every((c) => c.headers["If-Unmodified-Since"] === undefined)).toBe(true);
  });

  it("refreshes the access token before it expires", async () => {
    let t = 1_800_000_000_000;
    const portal = mockPortal({ now: () => t });
    // each basicinfo call takes 100 s: the 300 s token must be renewed proactively (30 s margin)
    const timed: FetchLike = async (u, i) => {
      if (u.includes("/products/basicinfo/")) t += 100_000;
      return portal.fetch(u, i);
    };
    const client = new PortalClient(CFG, { refreshToken: "RT-ENV" }, { fetch: timed, now: () => t });
    await executeLivePush(planFor(), client);
    const seq = portal.calls.map((c) => c.path.replace(/\/products\/basicinfo\/\d+/, "basicinfo"));
    expect(seq.slice(0, 6)).toEqual(["/access-token", "basicinfo", "basicinfo", "basicinfo", "/access-token", "basicinfo"]);
    expect(seq).not.toContain("/authenticate/login");
    expect(portal.calls[0].body).toEqual({ refreshToken: "RT-ENV", useTokenCookie: false });
    expect(portal.calls.filter((c) => c.path === "/access-token").length).toBeGreaterThan(2);
    expect(jwtExp(jwt(123, 1))).toBe(123);
  });

  it("refreshes once and retries on a 401", async () => {
    const t = 1_800_000_000_000;
    let failed = false;
    const portal = mockPortal({
      now: () => t,
      fail: (c) => {
        if (!failed && c.path === "/proposals" && c.method === "POST") {
          failed = true;
          return { status: 401, body: { message: "expired" } };
        }
        return null;
      },
    });
    const client = new PortalClient(CFG, { refreshToken: "RT" }, { fetch: portal.fetch, now: () => t });
    const res = await executeLivePush(planFor(), client);
    expect(res.proposalId).toBe(777);
    const i = portal.calls.findIndex((c) => c.path === "/proposals" && c.method === "POST");
    expect(portal.calls.slice(i, i + 3).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /proposals", "POST /access-token", "POST /proposals"]);
    expect(portal.calls[i + 2].headers.Authorization).not.toBe(portal.calls[i].headers.Authorization);
    expect(writes(portal.calls).filter((c) => c.path === "/proposals").length).toBe(2); // the 401'd one plus its single retry
  });

  it("a second 401 is not retried again", async () => {
    const t = 1_800_000_000_000;
    const portal = mockPortal({ now: () => t, fail: (c) => (c.path === "/products/basicinfo/1005" ? { status: 401 } : null) });
    const client = new PortalClient(CFG, { refreshToken: "RT" }, { fetch: portal.fetch, now: () => t });
    await expect(executeLivePush(planFor(), client)).rejects.toThrow(/HTTP 401/);
    expect(portal.calls.filter((c) => c.path === "/products/basicinfo/1005").length).toBe(2);
    expect(writes(portal.calls)).toEqual([]);
  });

  it("aborts before any write when a part 404s, is not Activated, or has the wrong unitOfMeasure", async () => {
    const t = 1_800_000_000_000;
    const parts = defaultParts();
    parts[1002] = { ...parts[1002], status: "Discontinued" };
    parts[2003] = { ...parts[2003], unitOfMeasure: "Each" };
    const portal = mockPortal({ now: () => t, parts: { ...parts, 1003: 404 } });
    const client = new PortalClient(CFG, { refreshToken: "RT" }, { fetch: portal.fetch, now: () => t });
    const err = await executeLivePush(planFor(), client).catch((e) => e);
    expect(err).toBeInstanceOf(PushAborted);
    const msgs = (err as PushAborted).errors.map((e) => e.message);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatch(/1002 .*status "Discontinued"/);
    expect(msgs[1]).toMatch(/1003 was not found \(404\)/);
    expect(msgs[2]).toMatch(/2003 .*unitOfMeasure "Each" differs from the cable part's "Foot"/);
    expect(writes(portal.calls)).toEqual([]);
    // every part was still checked, so the estimator sees every problem at once
    expect(portal.calls.filter((c) => c.path.startsWith("/products/basicinfo/")).length).toBe(8);
  });

  it("a plan with errors never touches the network", async () => {
    const portal = mockPortal({ now: () => 0 });
    const client = new PortalClient(CFG, { refreshToken: "RT" }, { fetch: portal.fetch });
    await expect(executeLivePush(planFor(catalog()), client)).rejects.toBeInstanceOf(PushAborted);
    expect(portal.calls).toEqual([]);
  });

  it("adjustment requests always send setDefault / updateAllInstances false", () => {
    expect(setItemSellPriceRequest(1, 2, 9.5).body).toEqual({ sellPrice: 9.5, setDefault: false, updateAllInstances: false });
    expect(setItemQtyRequest(1, 2, 3).body).toEqual({ quantity: 3, includeAttachments: false });
  });

  it("redacts tokens and secrets from error text", async () => {
    expect(redact(`bad token ${jwt(1, 1)} and PW-SECRET`, ["PW-SECRET"])).toBe("bad token <redacted> and <redacted>");
    const t = 1_800_000_000_000;
    const portal = mockPortal({ now: () => t, fail: (c) => (c.path === "/proposals" && c.method === "POST" ? { status: 500, body: { echo: "RT-SECRET-VALUE" } } : null) });
    const client = new PortalClient(CFG, { refreshToken: "RT-SECRET-VALUE" }, { fetch: portal.fetch, now: () => t });
    const err = (await executeLivePush(planFor(), client).catch((e) => e)) as Error;
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).not.toContain("RT-SECRET-VALUE");
  });
});

// ---------- the push against the database ----------

describe("portal push with the system of record (PGlite)", () => {
  let db: Db;
  const PROJECT = "Brink Div 27 sample (invented)";
  const ENV = { PORTAL_REFRESH_TOKEN: "RT-ENV-SECRET" };
  const t = 1_800_000_000_000;

  beforeAll(async () => {
    db = await openPglite();
    await migrate(db);
    await seedCatalog(db, confirmedCatalog());
    const input = load("div27-sample");
    await saveMerge(db, input, merge(input, await loadCatalog(db), { date: "2026-10-27" }));
  });
  afterAll(() => db.close());

  const pushes = async () => (await db.query<{ dry_run: boolean; status: string; plan_hash: string; portal_proposal_id: string | null; portal_item_ids: number[]; errors: unknown[]; error: string | null; plan: Record<string, unknown> }>(
    "select dry_run, status, plan_hash, portal_proposal_id::text, portal_item_ids, errors, error, plan from brink_portal_pushes order by created_at")).rows;

  it("dry run records a planned push and sends nothing", async () => {
    const portal = mockPortal({ now: () => t });
    const r = await portalPush(db, { project: PROJECT, env: ENV, fetch: portal.fetch });
    expect(r.outcome).toBe("planned");
    expect(r.plan.items).toHaveLength(8);
    expect(r.requests).toHaveLength(21);
    expect(portal.calls).toEqual([]);
    const rows = await pushes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dry_run: true, status: "planned", plan_hash: r.plan.hash, portal_proposal_id: null });
    expect(JSON.stringify(rows[0].plan)).not.toContain("RT-ENV-SECRET");
  });

  it("live without --confirm, with a wrong hash, or without credentials is refused before any request", async () => {
    const portal = mockPortal({ now: () => t });
    const hash = (await portalPush(db, { project: PROJECT })).plan.hash;
    expect((await portalPush(db, { project: PROJECT, live: true, env: ENV, fetch: portal.fetch })).refusal).toMatch(/needs --confirm/);
    expect((await portalPush(db, { project: PROJECT, live: true, confirm: "0000000000000000", env: ENV, fetch: portal.fetch })).refusal).toMatch(/does not match/);
    expect((await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: {}, fetch: portal.fetch })).refusal).toMatch(/no Portal credentials/);
    expect(portal.calls).toEqual([]);
  });

  it("live with the confirmed hash creates one Draft proposal and records it; a re-run is refused", async () => {
    const portal = mockPortal({ now: () => t });
    const hash = (await portalPush(db, { project: PROJECT })).plan.hash;
    const r = await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: ENV, fetch: portal.fetch, now: () => t });
    expect(r.outcome).toBe("succeeded");
    expect(r.result).toMatchObject({ proposalId: 777, areaOptionId: 41 });
    const live = (await pushes()).filter((p) => !p.dry_run && p.status !== "aborted");
    expect(live).toEqual([expect.objectContaining({ status: "succeeded", portal_proposal_id: "777", portal_item_ids: [501, 502, 503, 504, 505, 506, 507, 508] })]);

    const again = mockPortal({ now: () => t });
    const r2 = await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: ENV, fetch: again.fetch, now: () => t });
    expect(r2.outcome).toBe("refused");
    expect(r2.refusal).toMatch(/already has a live Portal push: succeeded push .*Portal proposal 777/);
    expect(again.calls).toEqual([]);

    const r3 = await portalPush(db, { project: PROJECT, live: true, confirm: hash, newProposal: true, env: ENV, fetch: again.fetch, now: () => t });
    expect(r3.outcome).toBe("succeeded");
  });

  it("an abort during part resolution is recorded as aborted (nothing written)", async () => {
    await db.query("delete from brink_portal_pushes");
    const portal = mockPortal({ now: () => t, parts: { ...defaultParts(), 1001: 404 } });
    const hash = (await portalPush(db, { project: PROJECT })).plan.hash;
    const r = await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: ENV, fetch: portal.fetch, now: () => t });
    expect(r.outcome).toBe("aborted");
    expect(writes(portal.calls)).toEqual([]);
    expect((await pushes()).at(-1)).toMatchObject({ dry_run: false, status: "aborted" });
    expect((await pushes()).at(-1)!.error).toMatch(/1001 was not found/);
  });

  it("a failure after the proposal exists is recorded as failed with the proposal id, and blocks a silent re-run", async () => {
    await db.query("delete from brink_portal_pushes");
    let n = 0;
    const portal = mockPortal({ now: () => t, fail: (c) => (c.path === "/proposals/777/items" && ++n === 3 ? { status: 500, body: { message: "boom" } } : null) });
    const hash = (await portalPush(db, { project: PROJECT })).plan.hash;
    const r = await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: ENV, fetch: portal.fetch, now: () => t });
    expect(r.outcome).toBe("failed");
    expect((await pushes()).at(-1)).toMatchObject({ status: "failed", portal_proposal_id: "777", portal_item_ids: [501, 502] });
    expect((await portalPush(db, { project: PROJECT, live: true, confirm: hash, env: ENV, fetch: portal.fetch })).refusal).toMatch(/failed push .*Portal proposal 777/);
  });

  it("an unconfirmed row aborts the push and is recorded with every offending line", async () => {
    await upsertCatalogRow(db, { ...confirmedCatalog().rows.find((r) => r.conditionKey === "CAM-1")!, status: "proposed" });
    const r = await portalPush(db, { project: PROJECT });
    expect(r.outcome).toBe("aborted");
    // the import still says confirmed, the catalog now says proposed
    expect(r.plan.errors.map((e) => e.code)).toEqual(["not_confirmed"]);
    expect((await pushes()).at(-1)).toMatchObject({ dry_run: true, status: "aborted" });
  });
});

// ---------- CLI ----------

describe("brink-merge portal-push CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "brink-portal-"));
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(s));
    vi.spyOn(console, "error").mockImplementation((s: string) => void out.push(s));
  });
  afterEach(() => vi.restoreAllMocks());

  it("dry-runs from bom.json files and prints the plan", async () => {
    const map = confirmedCatalog();
    const { result } = sample(map);
    writeFileSync(join(dir, "bom.json"), JSON.stringify(result.bom));
    writeFileSync(join(dir, "map.json"), JSON.stringify(map));
    expect(await main(["portal-push", "--bom-json", join(dir, "bom.json"), "--map", join(dir, "map.json"), "--app-version", "1.2.3"])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Portal push DRY RUN");
    expect(text).toContain("POST https://api.portal.io/proposals?appVersion=1.2.3");
    expect(text).toContain("plan hash ");
    expect(text).not.toMatch(/eyJ/);
  });

  it("refuses --live from files and exits 1 on an aborted plan", async () => {
    const { result } = sample(catalog());
    writeFileSync(join(dir, "bom2.json"), JSON.stringify(result.bom));
    expect(await main(["portal-push", "--bom-json", join(dir, "bom2.json"), "--live"])).toBe(2);
    expect(await main(["portal-push", "--bom-json", join(dir, "bom2.json")])).toBe(1);
    expect(out.join("\n")).toContain("ABORTED: 8 error(s); nothing is sent to Portal");
    expect(await main(["portal-push"])).toBe(2);
  });
});
