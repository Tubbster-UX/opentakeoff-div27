// The owner's approval of a priced bid: owner-only, CSRF-checked, revision-
// exact, refused while the bid has gaps, re-renders through the hook, and
// withdrawable. Invented numbers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, login, sessionCookie } from "./fakes.ts";
import { bidKey } from "../src/approval.ts";
import type { BidDraft } from "../src/bidTypes.ts";

function draft(revision: number, over: Partial<BidDraft> = {}): BidDraft {
  return {
    schema: "brink.bid.v1", project: "hangar", created: "2026-11-16T00:00:00Z", revision,
    inputs: { excise: false, bond: false, unitSet: "standard", mobilizations: 1, driveHoursPerDay: 0, milesPerDay: 0, vehicles: 1, jobHours: [], extraLines: [], extraExpenses: [], laborOnlyConditions: [] },
    lines: [], hours: [], expenses: [],
    totals: { material: 100, materialMarkup: 15, expenses: 0, laborHours: 10, laborCostRate: 50, laborCost: 500, subtotal: 615, overhead: 61.5, profit: 101.48, excise: 0, baseBid: 777.98, bond: null, totalWithBond: null, trueCost: null, effectiveSellRate: 63.25, chain: 1.265 },
    ratios: { links: 4, dollarsPerLink: 194.5, hoursPerLink: 2.5 },
    flags: [{ kind: "long_link", message: "run-1: 262 ft per cable (over 250 ft)" }],
    gaps: [],
    settings: { company: { brand: "Example Design" } } as unknown as BidDraft["settings"],
    status: "draft",
    ...over,
  };
}

test("approve: owner only, exact revision, complete bids only, hook re-renders, withdraw", async () => {
  const rerendered: string[] = [];
  const t = await startServer({ bidHooks: { onApproved: async (p, bid) => { rerendered.push(`${p}:r${bid.revision}:${bid.status}`); return ["outputs/bid/Hangar - quote r2.pdf"]; } } });
  try {
    const cookie = sessionCookie(await login(t))!;
    const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${t.url}${path}`, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json", origin: t.url } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const proj = await (await api("POST", "/api/projects", { name: "Hangar" })).json();
    assert.equal((await api("GET", `/api/projects/${proj.id}/bid`)).status, 404, "no bid yet");

    await t.storage.put(bidKey(proj.id), JSON.stringify(draft(2)));
    const got = await (await api("GET", `/api/projects/${proj.id}/bid`)).json();
    assert.equal(got.revision, 2);
    assert.equal(got.settings, undefined, "rates and company stay server-side");

    // no cookie, cross-origin, wrong revision
    assert.equal((await fetch(`${t.url}/api/projects/${proj.id}/bid/approve`, { method: "POST", headers: { "content-type": "application/json", origin: t.url }, body: '{"revision":2}' })).status, 401);
    assert.equal((await api("POST", `/api/projects/${proj.id}/bid/approve`, { revision: 2 }, { origin: "https://evil.example" })).status, 403);
    const stale = await api("POST", `/api/projects/${proj.id}/bid/approve`, { revision: 1 });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).message, /revision 2/);

    // gaps block approval
    await t.storage.put(bidKey(proj.id), JSON.stringify(draft(2, { gaps: [{ ref: "l1", description: "CAT6A box", reason: "no price" }] })));
    assert.equal((await api("POST", `/api/projects/${proj.id}/bid/approve`, { revision: 2 })).status, 409);

    // a complete bid approves, the hook re-renders, the stored bid says approved
    await t.storage.put(bidKey(proj.id), JSON.stringify(draft(2)));
    const ok = await api("POST", `/api/projects/${proj.id}/bid/approve`, { revision: 2 });
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = await ok.json();
    assert.deepEqual(body.rerendered, ["outputs/bid/Hangar - quote r2.pdf"]);
    assert.deepEqual(rerendered, [`${proj.id}:r2:approved`]);
    const stored = JSON.parse(Buffer.from((await t.storage.getBytes(bidKey(proj.id)))!).toString()) as BidDraft;
    assert.equal(stored.status, "approved");
    assert.equal(stored.approved?.revision, 2);

    // withdraw
    assert.equal((await api("POST", `/api/projects/${proj.id}/bid/withdraw`, { revision: 2 })).status, 200);
    const back = JSON.parse(Buffer.from((await t.storage.getBytes(bidKey(proj.id)))!).toString()) as BidDraft;
    assert.equal(back.status, "draft");
    assert.equal(back.approved, undefined);
  } finally {
    await t.close();
  }
});
