// Shapes of the OpenTakeoff web libraries the bid pricing reads, declared so
// brink-server's tsc never typechecks the web sources (they have their own
// tsconfig and checks). src/bid/price.ts loads them at runtime by file URL
// (tsx runs the .js directly) and casts to these module types:
//
//   "opentakeoff-web-cable"  → ../../web/src/lib/cable.js
//   "opentakeoff-web-totals" → ../../web/src/lib/totals.js
//
// Only what brink-server uses is declared; the records are loose on purpose
// (the libraries are the source of truth for their fields).

declare module "opentakeoff-web-cable" {
  export interface ResolvedSegment { shape_id: string; sheet_id: string; length_lf: number; kind: "trunk" | "branch" | "other" }

  export interface ResolvedRun {
    id: string;
    condition_id: string | null;
    finish_tag: string;
    device_type: string;
    cable_type: string;
    device_shape_ids: string[];
    route_shape_ids: string[];
    tr_id: string;
    tr_name: string;
    /** Route sheets, in order of first appearance. */
    sheet_ids: string[];
    device_sheet_ids: string[];
    tr_sheet_id: string;
    segments: ResolvedSegment[];
    route_lf: number;
    status: "linked" | "withheld" | "broken";
    reason?: string;
    pending: boolean;
    per_cable_lf: number | null;
    cables: number | null;
    location_lf: number | null;
    over_length?: true;
    limit_ft?: number | null;
    limit_source?: "stated" | "tia_568_copper" | "none";
    medium?: string;
  }

  export interface CableSummaryRow {
    condition_id: string;
    finish_tag: string;
    device_type: string;
    cable_type: string;
    tr_id: string;
    multiplier: number;
    waste_pct: number;
    ea: number;
    pulls: number;
    cables: number;
    route_lf: number;
    cable_lf: number;
    cable_lf_order: number;
    unlinked_devices: number;
    held_devices: number;
    [k: string]: unknown;
  }

  export interface CableOrderRow {
    cable_type: string;
    order_lf: number;
    package_ft: number | null;
    boxes: number | null;
    purchased_lf: number | null;
    leftover_lf: number | null;
    conditions: string[];
    note?: string;
  }

  export interface CableTakeoff {
    resolved: {
      runs: ResolvedRun[];
      unlinked: { devices: { shape_id: string; condition_id: string; finish_tag: string; sheet_id: string; reason: string }[]; routes: unknown[] };
      held: { shape_id: string; condition_id: string; finish_tag: string; sheet_id: string; hold_id: string; reason: string }[];
      holds: unknown[];
      warnings: string[];
    };
    summary: { rows: CableSummaryRow[]; by_cable_type: (Record<string, number> & { cable_type: string })[]; totals: Record<string, number>; warnings: string[] };
    byCond: Map<string, Record<string, number>>;
    duplicates: unknown;
    pathway: unknown;
    order: { rows: CableOrderRow[] } | null;
  }

  export interface CableOpts {
    uppFor?: (sheetId: string) => number | null | undefined;
    scaleReason?: (sheetId: string) => string;
    scaleUnconfirmed?: (sheetId: string) => boolean;
    sheetLabel?: (sheetId: string) => string;
  }

  export const TIA_MAX_LINK_FT: number;
  export function computeCableTakeoff(conditions: unknown[], shapes: unknown[], runs: unknown[], opts?: CableOpts): CableTakeoff | null;
  export function cableQtyByShape(takeoff: CableTakeoff | null): Map<string, { pulls: number; cables: number }>;
  export function normalizeDeviceType(t: unknown): string | null;
  export function hasCableSetup(c: unknown): boolean;
  export function runShortIds(records: unknown[], min?: number): Map<string, string>;
}

declare module "opentakeoff-web-totals" {
  export interface MaterialRowTotal {
    name: string;
    unit: string;
    per: number;
    basis: string;
    round: boolean;
    note: string;
    basis_qty: number;
    qty: number;
    reason?: string;
  }
  export interface ConditionTotalRow {
    id: string;
    finish_tag: string;
    multiplier: number;
    shape_count: number;
    ea: number;
    lf: number;
    materials: MaterialRowTotal[];
    [k: string]: unknown;
  }
  export function conditionTotals(
    conditions: unknown[],
    shapes: unknown[],
    ctx?: { seamByShape?: Map<string, number>; cableByShape?: Map<string, { pulls: number; cables: number }> } | null,
  ): ConditionTotalRow[];
}
