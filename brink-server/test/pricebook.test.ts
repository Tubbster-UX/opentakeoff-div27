// The price book in a local file store: keys, append-only history, dedupe,
// token search and newest-first lookup. All items and prices invented.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsStorage } from "../src/storage.ts";
import { StorePriceBook, priceKey, descriptionKey, normaliseKey, PRICEBOOK_KEY, type PriceEntryInput } from "../src/pricebook.ts";

const roots: string[] = [];
after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });
async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "brink-pricebook-"));
  roots.push(root);
  const storage = new FsStorage(root);
  return { storage, book: new StorePriceBook(storage) };
}

const e = (over: Partial<PriceEntryInput>): PriceEntryInput => ({
  description: "Invented CAT6A plenum cable, blue", unit: "box(1000ft)", price: 420, source: "https://supplier.example/cat6a", date: "2026-11-10", status: "live", ...over,
});

test("pricebook: key normaliser", () => {
  assert.equal(priceKey({ manufacturer: "Invented Co.", part: "CS-6A PL", description: "whatever" }), "mp:inventedco:cs6apl");
  assert.equal(priceKey({ manufacturer: "invented co", part: "cs6apl" }), "mp:inventedco:cs6apl");
  assert.equal(priceKey({ part: "CS-6A", description: "CAT6A  Jack, Blue" }), "desc:cat6a jack blue", "part without manufacturer falls back to the description");
  assert.equal(descriptionKey("Façade  Plate"), "desc:facade plate");
  assert.equal(normaliseKey("MP:Invented Co:CS-6A PL"), "mp:inventedco:cs6apl");
  assert.equal(normaliseKey("2 port plate"), "desc:2 port plate");
});

test("pricebook: record appends, never overwrites, dedupes exact repeats, validates", async () => {
  const { book, storage } = await store();
  assert.deepEqual((await book.all()).entries, []);
  const r1 = await book.record([e({}), e({ manufacturer: "Invented Co", part: "J-6A", description: "CAT6A jack", unit: "ea", price: 6.5, source: "quote INV-100", date: "2026-11-01", status: "estimate" })]);
  assert.equal(r1.added.length, 2);
  assert.equal(r1.added[0].key, "desc:invented cat6a plenum cable blue");
  assert.equal(r1.added[0].unit, "BOX(1000FT)");
  assert.equal(r1.added[1].key, "mp:inventedco:j6a");

  // the same price again: a duplicate; a new price for the same item: a new entry
  const r2 = await book.record([e({}), e({ price: 445, date: "2026-11-14" })]);
  assert.equal(r2.duplicates.length, 1);
  assert.equal(r2.added.length, 1);
  const all = await book.all();
  assert.equal(all.entries.length, 3, "history kept");
  assert.deepEqual(all.entries.map((x) => x.price), [420, 6.5, 445]);
  assert.ok(await storage.getBytes(PRICEBOOK_KEY));

  // validation: all or nothing
  for (const [bad, msg] of [
    [{ source: "" }, /source is required/],
    [{ date: "11/10/2026" }, /YYYY-MM-DD/],
    [{ status: "firm" }, /live, estimate or allowance/],
    [{ price: -1 }, /price must be/],
    [{ unit: "" }, /unit is required/],
    [{ description: " " }, /description is required/],
  ] as const) {
    await assert.rejects(book.record([e({ price: 1 }), e(bad as Partial<PriceEntryInput>)]), msg);
  }
  assert.equal((await book.all()).entries.length, 3, "a refused batch adds nothing");
});

test("pricebook: lookup newest first, live before estimate before allowance on a date; find by tokens", async () => {
  const { book } = await store();
  await book.record([
    e({ price: 400, date: "2026-10-01" }),
    e({ price: 430, date: "2026-11-12", status: "allowance" }),
    e({ price: 425, date: "2026-11-12", status: "live", source: "https://other.example/x" }),
    e({ price: 428, date: "2026-11-12", status: "estimate", source: "https://third.example/y" }),
    e({ manufacturer: "Invented Co", part: "FP-2", description: "2-port faceplate", unit: "EA", price: 1.2, source: "quote INV-7" }),
  ]);
  const hits = await book.lookup("desc:invented cat6a plenum cable blue");
  assert.deepEqual(hits.map((h) => h.price), [425, 428, 430, 400]);
  // a description key also finds entries recorded with manufacturer + part
  assert.equal((await book.lookup(descriptionKey("2-port faceplate")))[0]?.price, 1.2);
  assert.equal((await book.lookup("mp:Invented Co:FP 2"))[0]?.price, 1.2);

  assert.equal((await book.find("cat6a plenum")).length, 4);
  assert.equal((await book.find("cat6a plenum", { limit: 2 }))[0].price, 425);
  assert.equal((await book.find("fp2"))[0]?.description, "2-port faceplate", "part numbers match without the dash");
  assert.equal((await book.find("invented faceplate")).length, 1);
  assert.equal((await book.find("fiber")).length, 0);
});
