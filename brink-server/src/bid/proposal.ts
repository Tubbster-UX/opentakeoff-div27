// The GC / EC sub-bid: the owner's 3-page low-voltage quote as a PDF.
//   page 1  letterhead, LOW VOLTAGE QUOTE, project info grid, price callout, scope of work
//   page 2  products, responsibilities, project conditions
//   page 3  exclusions (shaded), clarifications, warranty, validity and payment, acceptance
// Long tables flow onto more pages. The words are Claude's (GcProposalContent);
// the price is the BidDraft's base bid; company facts and standard terms come
// from the settings copy inside the draft. A DRAFT stamp sits on every page
// until the owner approves. No OpenTakeoff marks (owner decision).
import { z } from "zod";
import type { BidDraft } from "../bidTypes.ts";
import type { ProjectManifest } from "../types.ts";
import { addDaysLabel, assertComplete, draftMark, money } from "./format.ts";
import { C, PdfFlow, companyContact, letterhead } from "./pdfKit.ts";

const text = (max = 2000) => z.string().trim().min(1).max(max);

export const GcProposalContentSchema = z.object({
  preparedFor: z.object({
    company: text(200),
    attention: text(200),
    email: z.string().trim().max(200).optional(),
  }),
  projectTitle: text(300),
  /** Plan set, specs and addenda the quote is based on. */
  documents: z.array(text(400)).max(60),
  quoteDate: text(60),
  bidDate: text(60),
  scopeItems: z.array(z.union([text(), z.object({ item: text(300), detail: z.string().trim().max(2000) })])).min(1).max(200),
  products: z.array(z.object({ item: text(300), model: z.string().trim().max(200), qty: z.union([z.number(), z.string().trim().max(40)]), basis: z.string().trim().max(400) })).max(300),
  responsibilities: z.array(z.object({ task: text(300), brink: z.boolean(), others: z.string().trim().max(300) })).max(100),
  projectConditions: z.array(text()).max(60),
  /** Job exclusions, printed after the standard exclusions in settings. */
  exclusions: z.array(text()).max(100),
  /** Job clarifications, printed after the standard clarifications in settings. */
  clarifications: z.array(text()).max(100),
  /** Under the price, e.g. "Flat rate · no taxes". */
  priceNote: z.string().trim().max(300),
});
export type GcProposalContent = z.infer<typeof GcProposalContentSchema>;

export interface GcProposalArgs {
  bid: BidDraft;
  project: ProjectManifest;
  content: GcProposalContent;
  logo?: Uint8Array;
  /** Render an incomplete bid (no base bid, or gaps) with the callout marked INCOMPLETE. */
  allowIncomplete?: boolean;
}

export async function renderGcProposalPdf(args: GcProposalArgs): Promise<Uint8Array> {
  const { bid, content: k, logo } = args;
  const incomplete = assertComplete(bid, args.allowIncomplete, "GC proposal");
  const s = bid.settings;
  const co = s.company;
  const draft = draftMark(bid);

  const f = await PdfFlow.create({
    title: `${k.projectTitle} — Low Voltage Quote`,
    author: co.brand || co.legalName,
    subject: `Low voltage quote for ${k.preparedFor.company}`,
  });

  // ── page 1 ──
  await letterhead(f, co, logo);
  f.space(6);
  f.y -= 22;
  f.draw("LOW VOLTAGE QUOTE", f.left, f.y, { font: f.bold, size: 22, color: C.navy });
  f.y -= 18;
  f.draw(k.projectTitle, f.left, f.y, { font: f.regular, size: 12, color: C.blue });
  f.y -= 14;

  const validity = s.proposal.validityDays;
  const until = validity != null ? addDaysLabel(k.quoteDate, validity) : null;
  const validText = validity == null ? "See terms" : `${validity} days from the quote date${until ? ` (through ${until})` : ""}`;
  const forLines = [k.preparedFor.company, `Attn: ${k.preparedFor.attention}`, k.preparedFor.email ?? ""].filter(Boolean).join("\n");
  const byLines = [co.brand || co.legalName, `${co.signerName}, ${co.signerTitle}`, [co.phone, co.email].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
  f.table(
    [{ header: "", width: 15 }, { header: "", width: 35 }, { header: "", width: 15 }, { header: "", width: 35 }],
    [
      ["Prepared for", forLines, "Prepared by", byLines],
      ["Project", k.projectTitle, "Documents", k.documents.length ? k.documents.join("\n") : "As listed in the bid invitation"],
      ["Quote date", k.quoteDate, "Bid date", k.bidDate],
      ["Valid for", validText, "Quote ref", `${args.project.id} r${bid.revision}`],
    ],
    { header: false, zebra: false, labelCols: [0, 2], size: 9 },
  );

  // price callout
  const boxH = 74;
  f.ensure(boxH + 10);
  const top = f.y;
  if (!incomplete) {
    f.page.drawRectangle({ x: f.left, y: top - boxH, width: f.width, height: boxH, color: C.navy });
    f.draw("BASE BID", f.left + 16, top - 22, { font: f.bold, size: 9, color: C.white });
    f.draw(money(bid.totals.baseBid), f.left + 16, top - 52, { font: f.bold, size: 28, color: C.white });
    const noteW = f.width * 0.42;
    const noteLines = f.wrap(k.priceNote, f.regular, 10, noteW);
    noteLines.slice(0, 4).forEach((line, i) => {
      f.draw(line, f.right - 16 - noteW, top - 30 - i * 13, { size: 10, color: C.white, align: "right", width: noteW });
    });
  } else {
    f.page.drawRectangle({ x: f.left, y: top - boxH, width: f.width, height: boxH, color: C.redFill, borderColor: C.red, borderWidth: 1.5 });
    f.draw("INCOMPLETE — not for submission", f.left + 16, top - 30, { font: f.bold, size: 18, color: C.red });
    const sofar = bid.totals.baseBid == null ? "The base bid is not priced." : `Priced so far: ${money(bid.totals.baseBid)} with ${bid.gaps.length} item${bid.gaps.length === 1 ? "" : "s"} unpriced.`;
    f.draw(sofar, f.left + 16, top - 54, { size: 10, color: C.red });
  }
  f.y = top - boxH - 6;

  f.heading("SCOPE OF WORK");
  const detailed = k.scopeItems.some((x) => typeof x !== "string");
  if (detailed) {
    f.table([{ header: "Item", width: 32 }, { header: "Detail", width: 68 }],
      k.scopeItems.map((x) => (typeof x === "string" ? [{ text: x, bold: true }, ""] : [{ text: x.item, bold: true }, x.detail])));
  } else {
    f.table([{ header: "#", width: 6, align: "center" }, { header: "Scope", width: 94 }],
      k.scopeItems.map((x, i) => [String(i + 1), x as string]));
  }

  // ── page 2 ──
  f.pageBreak();
  if (k.products.length) {
    f.heading("PRODUCTS");
    f.table(
      [{ header: "Item", width: 30 }, { header: "Model", width: 26 }, { header: "Qty", width: 9, align: "right" }, { header: "Basis", width: 35 }],
      k.products.map((p) => [p.item, p.model, String(p.qty), p.basis]),
    );
  }
  if (k.responsibilities.length) {
    f.heading("RESPONSIBILITIES");
    f.table(
      [{ header: "Task", width: 46 }, { header: co.brand || "Us", width: 16, align: "center" }, { header: "By others", width: 38 }],
      k.responsibilities.map((x) => [x.task, { text: x.brink ? "Yes" : "—", bold: x.brink, color: x.brink ? C.navy : C.muted }, x.others]),
    );
  }
  if (k.projectConditions.length) {
    f.heading("PROJECT CONDITIONS");
    f.bullets(k.projectConditions);
  }

  // ── page 3 ──
  f.pageBreak();
  const exclusions = [...s.proposal.standardExclusions, ...k.exclusions];
  if (exclusions.length) {
    f.heading("EXCLUSIONS");
    f.table([{ header: "", width: 4 }, { header: "", width: 96 }], exclusions.map((x) => [{ text: "•", color: C.blue }, x]),
      { header: false, fill: C.shade, borders: false, size: 9.5, pad: 3.5 });
  }
  const clarifications = [...s.proposal.standardClarifications, ...k.clarifications];
  if (clarifications.length) {
    f.heading("CLARIFICATIONS");
    f.bullets(clarifications, { size: 9.5 });
  }
  if (s.proposal.warranty.trim()) {
    f.heading("WARRANTY");
    f.paragraph(s.proposal.warranty, { size: 9.5 });
  }
  f.heading("VALIDITY AND PAYMENT TERMS");
  f.paragraph(`Valid for: ${validText}.`, { size: 9.5, after: 3 });
  if (s.proposal.paymentTerms.trim()) f.paragraph(`Payment terms: ${s.proposal.paymentTerms}`, { size: 9.5 });

  // acceptance: kept together
  f.ensure(170);
  f.heading("ACCEPTANCE", { keep: 120 });
  f.paragraph(`Accepted for ${k.preparedFor.company}. Signing below accepts this quote, its exclusions and its terms.`, { size: 9.5, after: 14 });
  const colW = (f.width - 30) / 2;
  const sigTop = f.y;
  const sigBlock = (x: number, heading: string, filled: string[]) => {
    let y = sigTop;
    f.draw(heading, x, y - 10, { font: f.bold, size: 9.5, color: C.navy });
    y -= 22;
    for (const label of ["Signature", "Printed name", "Title", "Date"]) {
      y -= 24;
      f.page.drawLine({ start: { x: x + 70, y }, end: { x: x + colW, y }, thickness: 0.6, color: C.text });
      f.draw(label, x, y + 2, { size: 8.5, color: C.muted });
      const pre = filled[["Signature", "Printed name", "Title", "Date"].indexOf(label)];
      if (pre) f.draw(pre, x + 74, y + 3, { size: 9.5 });
    }
    return y;
  };
  const yA = sigBlock(f.left, k.preparedFor.company, []);
  const yB = sigBlock(f.left + colW + 30, co.brand || co.legalName, ["", co.signerName, co.signerTitle, ""]);
  f.y = Math.min(yA, yB) - 10;

  return f.finish({ footerLeft: companyContact(co), draft: draft || undefined });
}
