// The GC sub-bid PDF, read back with pdfjs: price, sections, DRAFT stamp while a
// draft and gone once approved, no OpenTakeoff text, page count, long tables
// paginating, and the incomplete-bid refusal.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderGcProposalPdf } from "../src/bid/proposal.ts";
import { IncompleteBidError, money } from "../src/bid/format.ts";
import { approve, fixtureBid, fixtureProject, gcContent, tinyPng } from "./bidFixture.ts";
import { pdfText } from "./pdfText.ts";

const all = (pages: string[]) => pages.join("\n");

describe("renderGcProposalPdf", () => {
  test("draft: three pages, price, sections, DRAFT on every page, no OpenTakeoff", async () => {
    const bid = fixtureBid();
    const bytes = await renderGcProposalPdf({ bid, project: fixtureProject(), content: gcContent(), logo: tinyPng() });
    const { pages, info } = await pdfText(bytes);
    assert.equal(pages.length, 3);
    const text = all(pages);
    assert.ok(pages[0].includes(money(bid.totals.baseBid)), `price ${money(bid.totals.baseBid)} on page 1`);
    assert.ok(pages[0].includes("LOW VOLTAGE QUOTE"));
    assert.ok(pages[0].includes("SCOPE OF WORK") && pages[0].includes("Horizontal cabling"));
    assert.ok(pages[0].includes("Flat rate · no taxes"));
    assert.ok(pages[0].includes("Sample Builders Inc") && pages[0].includes("Attn: Jordan Estimator"));
    assert.ok(pages[0].includes("30 days from the quote date (through December 16, 2026)"));
    assert.ok(pages[1].includes("PRODUCTS") && pages[1].includes("RESPONSIBILITIES") && pages[1].includes("PROJECT CONDITIONS"));
    assert.ok(pages[1].includes("Example Mfg EX-6A-WH"));
    assert.ok(pages[2].includes("EXCLUSIONS") && pages[2].includes("CLARIFICATIONS") && pages[2].includes("WARRANTY") && pages[2].includes("ACCEPTANCE"));
    // standard exclusions come before the job's
    assert.ok(pages[2].indexOf("Permits and fees unless listed") < pages[2].indexOf("Wireless access points"));
    assert.ok(pages[2].indexOf("normal business hours") < pages[2].indexOf("One mobilization assumed"));
    assert.ok(pages[2].includes("Net 30 from invoice"));
    pages.forEach((p, i) => {
      assert.ok(p.includes(`Page ${i + 1} of 3`), `footer page ${i + 1}`);
      assert.ok(p.includes("DRAFT — revision 3"), `draft footer page ${i + 1}`);
      assert.match(p, /(^| )DRAFT( |$)/, `diagonal stamp page ${i + 1}`);
      assert.ok(p.includes("bids@example.com"), `contact footer page ${i + 1}`);
    });
    assert.doesNotMatch(text, /opentakeoff/i);
    assert.doesNotMatch(JSON.stringify(info), /opentakeoff|pdf-lib/i);
    assert.doesNotMatch(Buffer.from(bytes).toString("latin1"), /opentakeoff/i);
  });

  test("approved: no DRAFT anywhere", async () => {
    const bytes = await renderGcProposalPdf({ bid: approve(fixtureBid()), project: fixtureProject(), content: gcContent() });
    const { pages } = await pdfText(bytes);
    assert.equal(pages.length, 3);
    assert.doesNotMatch(all(pages), /draft/i);
    assert.ok(pages[2].includes("Page 3 of 3"));
  });

  test("long tables paginate with the header repeated", async () => {
    const products = Array.from({ length: 90 }, (_, i) => ({ item: `Test product ${i + 1} with a description long enough to wrap onto a second line in the item column`, model: `EX-${1000 + i}`, qty: i + 1, basis: "Spec 27 15 00" }));
    const bytes = await renderGcProposalPdf({ bid: fixtureBid(), project: fixtureProject(), content: gcContent({ products }) });
    const { pages } = await pdfText(bytes);
    assert.ok(pages.length >= 5, `${pages.length} pages`);
    const withProducts = pages.filter((p) => /Test product \d+/.test(p));
    assert.ok(withProducts.length >= 3, "products span pages");
    for (const p of withProducts) assert.ok(p.includes("Item") && p.includes("Model") && p.includes("Basis"), "header repeated");
    assert.ok(all(pages).includes("Test product 90 with"));
    assert.ok(pages.at(-1)!.includes("ACCEPTANCE"));
    pages.forEach((p, i) => assert.ok(p.includes(`Page ${i + 1} of ${pages.length}`)));
  });

  test("refuses an incomplete bid unless allowIncomplete, then says so in red", async () => {
    const bid = fixtureBid({ gap: true });
    await assert.rejects(renderGcProposalPdf({ bid, project: fixtureProject(), content: gcContent() }), (e: unknown) => e instanceof IncompleteBidError && /Firestop sleeve kit/.test(e.message));
    const noBase = fixtureBid();
    noBase.totals.baseBid = null;
    await assert.rejects(renderGcProposalPdf({ bid: noBase, project: fixtureProject(), content: gcContent() }), IncompleteBidError);
    const { pages } = await pdfText(await renderGcProposalPdf({ bid, project: fixtureProject(), content: gcContent(), allowIncomplete: true }));
    assert.ok(pages[0].includes("INCOMPLETE — not for submission"));
  });

  test("characters outside the standard fonts do not break the render", async () => {
    const bytes = await renderGcProposalPdf({ bid: fixtureBid(), project: fixtureProject(), content: gcContent({ priceNote: "Flat rate → no taxes ✓ \u{1F44D}" }) });
    const { pages } = await pdfText(bytes);
    assert.ok(pages[0].includes("Flat rate -> no taxes Yes ?"));
  });
});
