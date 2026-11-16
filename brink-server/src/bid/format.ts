// Small helpers the bid exports share: money and date formatting, draft /
// approved status, the completeness rule and output file names. Nothing here
// knows a rate or a price; it only formats what the BidDraft carries.
import type { BidDraft } from "../bidTypes.ts";

/** Thrown when a document would go out with a missing number (see assertComplete). */
export class IncompleteBidError extends Error {}

/** Rendering refused because the content breaks a rule (blank matrix cell, ...). */
export class ContentError extends Error {}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : USD.format(n);
}

/** A percent field from settings as a fraction. Settings may hold 15 or 0.15 for 15 %;
 * values above 1 are read as whole percents. null stays null. */
export function pctFraction(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.abs(v) > 1 ? Number((v / 100).toPrecision(12)) : v;
}

/** Approved only when the owner approved THIS revision (the phone page sets both). */
export function isApproved(bid: BidDraft): boolean {
  return bid.status === "approved" && (bid.approved == null || bid.approved.revision === bid.revision);
}

export function approvedDate(bid: BidDraft): string {
  return bid.approved?.at ? isoDay(bid.approved.at) : "";
}

export function isoDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** "DRAFT — revision 3" while not approved, "" when approved. */
export function draftMark(bid: BidDraft): string {
  return isApproved(bid) ? "" : `DRAFT — revision ${bid.revision}`;
}

/** One-line status for tool replies and banners. */
export function statusLine(bid: BidDraft): string {
  if (isApproved(bid)) return `APPROVED r${bid.revision}${approvedDate(bid) ? ` on ${approvedDate(bid)}` : ""}`;
  return `DRAFT r${bid.revision} — the owner approves on the project page`;
}

/** Why the bid is not ready to send, or null when it is. */
export function incompleteReason(bid: BidDraft): string | null {
  const parts: string[] = [];
  if (bid.totals.baseBid == null) parts.push("the base bid is not priced (a rate or markup in settings is missing)");
  if (bid.gaps.length) {
    const shown = bid.gaps.slice(0, 5).map((g) => `${g.description} (${g.reason})`).join("; ");
    parts.push(`${bid.gaps.length} item${bid.gaps.length === 1 ? " has" : "s have"} no price: ${shown}${bid.gaps.length > 5 ? "; ..." : ""}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/** Refuse a customer document for an incomplete bid unless allowIncomplete. Returns true when incomplete. */
export function assertComplete(bid: BidDraft, allowIncomplete: boolean | undefined, what: string): boolean {
  const why = incompleteReason(bid);
  if (why && !allowIncomplete) {
    throw new IncompleteBidError(`Not rendering the ${what}: ${why}. Price the gaps (price_bid) first, or pass allow_incomplete to get a copy marked "INCOMPLETE — not for submission".`);
  }
  return why != null;
}

/** A project name safe as a file name on phones, Windows and the store. */
export function fileStem(name: string): string {
  const s = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (s || "Project").slice(0, 80).trim();
}

/** "<Project> - quote r3 DRAFT.pdf" ("DRAFT" dropped once approved). */
export function bidFileName(projectName: string, what: string, bid: BidDraft, ext: string): string {
  return `${fileStem(projectName)} - ${what} r${bid.revision}${isApproved(bid) ? "" : " DRAFT"}.${ext}`;
}

/** Days after an ISO-ish date, as "Month D, YYYY"; null when the date does not parse. */
export function addDaysLabel(date: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** "2026-10-19" → "10/19/2026" (the owner's price-note style); other strings unchanged. */
export function usDate(date: string | undefined): string {
  if (!date) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  return m ? `${+m[2]}/${+m[3]}/${m[1]}` : date;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
