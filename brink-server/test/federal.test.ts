// The federal quote package: .docx (unzipped) and PDF (pdfjs) from one content
// object — matrix rows, the closing exceptions sentence, UEI / CAGE, DRAFT
// while a draft, and the blank-matrix-cell refusal.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { NO_EXCEPTIONS, NO_OTHER_EXCEPTIONS, federalContentProblems, renderFederalPackage } from "../src/bid/federal.ts";
import { ContentError, IncompleteBidError, money } from "../src/bid/format.ts";
import { approve, federalContent, fixtureBid, fixtureProject, tinyPng } from "./bidFixture.ts";
import { pdfText } from "./pdfText.ts";

/** Visible text of a .docx: every part's <w:t> runs, entities decoded. */
function docxText(bytes: Uint8Array): { body: string; header: string; footer: string; all: string } {
  const zip = unzipSync(bytes);
  const textOf = (re: RegExp) => Object.entries(zip).filter(([n]) => re.test(n))
    .map(([, d]) => [...strFromU8(d).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" "))
    .join(" ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
  const all = Object.values(zip).map((d) => strFromU8(d)).join("\n");
  return { body: textOf(/^word\/document\.xml$/), header: textOf(/^word\/header\d*\.xml$/), footer: textOf(/^word\/footer\d*\.xml$/), all };
}

describe("renderFederalPackage", () => {
  test("docx and PDF carry the matrix, exceptions, assumptions, BOM, price, UEI / CAGE and DRAFT", async () => {
    const bid = fixtureBid();
    const k = federalContent();
    const out = await renderFederalPackage({ bid, project: fixtureProject(), content: k, logo: tinyPng(40, 16) });

    const tech = docxText(out.technicalDocx);
    for (const row of k.complianceMatrix) {
      assert.ok(tech.body.includes(row.requirement), row.requirement);
      assert.ok(tech.body.includes(row.reference) && tech.body.includes(row.offered));
    }
    assert.ok(tech.body.includes("Exception 1"));
    assert.ok(tech.body.includes(NO_OTHER_EXCEPTIONS));
    assert.ok(tech.body.includes("Corridor ceilings remain accessible. (see Exception 1)"));
    assert.ok(tech.body.includes("Room 101 Telecom") && tech.body.includes("EX-PP48"));
    assert.ok(tech.body.includes(`Firm-fixed price: ${money(bid.totals.baseBid)}`));
    assert.ok(tech.body.includes(k.priceStatement));
    assert.ok(tech.body.includes("UEI TESTUEI00000") && tech.body.includes("CAGE 0TEST"));
    assert.ok(tech.header.includes("DRAFT — revision 3 — not for submission"));
    assert.ok(tech.footer.includes("DRAFT — revision 3"));
    assert.doesNotMatch(tech.all, /opentakeoff/i);
    assert.ok(Object.keys(unzipSync(out.technicalDocx)).some((n) => n.startsWith("word/media/")), "logo embedded");

    const cover = docxText(out.coverDocx);
    assert.ok(cover.body.includes("RE: Solicitation TEST00-26-Q-0001, Sample Building Network Cabling"));
    for (const p of k.coverParagraphs) assert.ok(cover.body.includes(p));
    assert.ok(cover.body.includes("Alex Sample, Capt") && cover.body.includes("Contracting Officer") && cover.body.includes("robin.test@example.test"));
    assert.ok(cover.body.includes("UEI TESTUEI00000") && cover.body.includes(`Firm-fixed price: ${money(bid.totals.baseBid)}`));
    assert.ok(cover.body.includes("Pat Example") && cover.body.includes("Respectfully,"));
    assert.doesNotMatch(cover.all, /opentakeoff|SF 1449|1449/i);

    const techPdf = await pdfText(out.technicalPdf);
    const tp = techPdf.pages.join("\n");
    for (const row of k.complianceMatrix) assert.ok(tp.includes(row.reference) && tp.includes(row.offered), row.reference);
    assert.ok(tp.includes("Provide CAT6A plenum cable to each outlet"));
    assert.ok(tp.includes(NO_OTHER_EXCEPTIONS));
    assert.ok(tp.includes("UEI TESTUEI00000 · CAGE 0TEST"));
    assert.ok(tp.includes(`Firm-fixed price: ${money(bid.totals.baseBid)}`));
    techPdf.pages.forEach((p, i) => {
      assert.ok(p.includes("DRAFT — revision 3 — not for submission"), `header page ${i + 1}`);
      assert.ok(p.includes(`Page ${i + 1} of ${techPdf.pages.length}`));
    });
    assert.doesNotMatch(tp + JSON.stringify(techPdf.info), /opentakeoff|pdf-lib/i);
    const coverPdf = await pdfText(out.coverPdf);
    assert.equal(coverPdf.pages.length, 1);
    assert.ok(coverPdf.pages[0].includes("RE: Solicitation TEST00-26-Q-0001") && coverPdf.pages[0].includes("CAGE 0TEST"));
  });

  test("no exceptions closes with \"No exceptions are taken.\"", async () => {
    const k = federalContent({
      exceptions: [],
      assumptions: [{ text: "Work during normal duty hours." }],
      complianceMatrix: [{ requirement: "Provide CAT6A plenum cable", reference: "SOW 3.1", offered: "Example Cable EC-6AP", response: "Meets" }],
    });
    const out = await renderFederalPackage({ bid: fixtureBid(), project: fixtureProject(), content: k });
    const t = docxText(out.technicalDocx).body;
    assert.ok(t.includes(NO_EXCEPTIONS));
    assert.ok(!t.includes(NO_OTHER_EXCEPTIONS));
    assert.ok((await pdfText(out.technicalPdf)).pages.join(" ").includes(NO_EXCEPTIONS));
  });

  test("a blank compliance cell is refused, listing every empty one", async () => {
    const k = federalContent();
    k.complianceMatrix[0].offered = " ";
    k.complianceMatrix[2].reference = "";
    k.complianceMatrix.push({ requirement: "Label both ends", reference: "SOW 3.5", offered: "Printed labels", response: "Exception" });
    await assert.rejects(renderFederalPackage({ bid: fixtureBid(), project: fixtureProject(), content: k }), (e: unknown) => {
      assert.ok(e instanceof ContentError);
      assert.match(e.message, /row 1 \(SOW 3\.1\): offered/);
      assert.match(e.message, /row 3 \(Install cable in existing conduit only\): reference/);
      assert.match(e.message, /row 4 \(SOW 3\.5\): exceptionNo/);
      return true;
    });
    assert.deepEqual(federalContentProblems(federalContent()), []);
    assert.ok(federalContentProblems(federalContent({ assumptions: [{ text: "x", exceptionNo: 9 }] }))[0].includes("exception 9"));
  });

  test("approved: no DRAFT header or stamp in either format", async () => {
    const out = await renderFederalPackage({ bid: approve(fixtureBid()), project: fixtureProject(), content: federalContent() });
    const d = docxText(out.technicalDocx);
    assert.doesNotMatch(d.header + d.footer + d.body, /draft/i);
    const p = await pdfText(out.technicalPdf);
    assert.doesNotMatch(p.pages.join(" "), /draft/i);
    assert.doesNotMatch((await pdfText(out.coverPdf)).pages.join(" "), /draft/i);
  });

  test("incomplete bid refused unless allowIncomplete", async () => {
    const bid = fixtureBid({ gap: true });
    await assert.rejects(renderFederalPackage({ bid, project: fixtureProject(), content: federalContent() }), IncompleteBidError);
    const out = await renderFederalPackage({ bid, project: fixtureProject(), content: federalContent(), allowIncomplete: true });
    assert.ok(docxText(out.technicalDocx).body.includes("INCOMPLETE — not for submission"));
  });
});
