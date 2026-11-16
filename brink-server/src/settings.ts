// The owner's bid settings (store: system/settings.json) and quoting playbook
// (system/playbook.md). Nothing here carries a rate, price or hour: a fresh
// server has every number null and the unit sets empty, and the bid reports
// each missing one as a gap until the owner (or Claude, from the playbook)
// fills it in.
//
// Percentages are FRACTIONS everywhere: 0.15 means 15%. A value above 1 is
// refused (it is almost always a percent typed as a percent), so a markup can
// never silently become 1500%.
import type { Storage } from "./types.ts";
import type { BidSettings, LaborPer, LaborUnit, LaborUnitSet } from "./bidTypes.ts";
import { KeyedMutex } from "./projects.ts";

export const SETTINGS_KEY = "system/settings.json";
export const PLAYBOOK_KEY = "system/playbook.md";
export const LABOR_PERS: readonly LaborPer[] = ["location_first", "cable_additional", "each", "link", "lf", "job"];
/** The changeLog keeps this many entries (newest last). */
export const CHANGELOG_MAX = 500;

/** Every percentage field, as a dotted path; each is a fraction 0..1 or null. */
export const PCT_FIELDS = ["labor.pmPctOfField", "markup.materialPct", "markup.overheadPct", "markup.profitPct", "markup.excisePct", "markup.bondPct"] as const;
/** Every other number field: ≥ 0 or null. */
export const NUM_FIELDS = ["labor.targetBillRate", "labor.trueCostRate", "labor.crewSize", "labor.hoursPerDay", "travel.mileageRate", "proposal.validityDays"] as const;

export function defaultSettings(now = new Date().toISOString()): BidSettings {
  return {
    schema: "brink.settings.v1",
    company: { legalName: "", brand: "", address: [], phone: "", email: "", web: "", signerName: "", signerTitle: "" },
    labor: {
      targetBillRate: null,
      trueCostRate: null,
      crewSize: null,
      hoursPerDay: null,
      pmPctOfField: null,
      defaultUnitSet: "standard",
      unitSets: [
        { id: "standard", label: "Standard", units: [] },
        { id: "lowered", label: "Lowered (open ceilings, short runs)", units: [] },
      ],
    },
    markup: { materialPct: null, overheadPct: null, profitPct: null, excisePct: null, bondPct: null },
    travel: { mileageRate: null },
    proposal: { validityDays: null, paymentTerms: "", warranty: "", standardExclusions: [], standardClarifications: [] },
    updated: now,
    changeLog: [],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace; undefined leaves the value. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(patch) || !isObj(base)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (isObj(a) ? a[k] : undefined), o);

/** Keys a patch may not set: they are the store's own bookkeeping. */
const LOCKED = ["schema", "updated", "changeLog"];

/** Every problem with a settings document (empty = valid). */
export function settingsProblems(s: BidSettings): string[] {
  const out: string[] = [];
  const num = (p: string, v: unknown, pct: boolean) => {
    if (v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v)) { out.push(`${p} must be a number or null`); return; }
    if (v < 0) out.push(`${p} must be 0 or more`);
    if (pct && v > 1) out.push(`${p} is a fraction: 0.15 means 15% (got ${v})`);
  };
  for (const p of PCT_FIELDS) num(p, get(s, p), true);
  for (const p of NUM_FIELDS) num(p, get(s, p), false);
  const crew = s.labor?.crewSize;
  if (typeof crew === "number" && crew > 0 && !Number.isInteger(crew)) out.push("labor.crewSize must be a whole number");
  const strs = (p: string, v: unknown) => { if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) out.push(`${p} must be a list of text lines`); };
  const str = (p: string, v: unknown, opt = false) => { if (opt && v === undefined) return; if (typeof v !== "string") out.push(`${p} must be text`); };
  const c = s.company as unknown as Record<string, unknown>;
  if (!isObj(c)) out.push("company must be an object");
  else {
    for (const k of ["legalName", "brand", "phone", "email", "web", "signerName", "signerTitle"]) str(`company.${k}`, c[k]);
    for (const k of ["uei", "cage", "logoKey"]) str(`company.${k}`, c[k], true);
    strs("company.address", c.address);
    if (c.extraIds !== undefined) strs("company.extraIds", c.extraIds);
  }
  const pr = s.proposal as unknown as Record<string, unknown>;
  if (!isObj(pr)) out.push("proposal must be an object");
  else {
    str("proposal.paymentTerms", pr.paymentTerms);
    str("proposal.warranty", pr.warranty);
    strs("proposal.standardExclusions", pr.standardExclusions);
    strs("proposal.standardClarifications", pr.standardClarifications);
  }
  const sets = s.labor?.unitSets;
  if (!Array.isArray(sets)) out.push("labor.unitSets must be a list");
  else {
    const ids = new Set<string>();
    sets.forEach((set: LaborUnitSet, i) => {
      const at = `labor.unitSets[${i}]`;
      if (!isObj(set)) { out.push(`${at} must be an object`); return; }
      if (typeof set.id !== "string" || !set.id.trim()) out.push(`${at}.id is required`);
      else if (ids.has(set.id)) out.push(`${at}.id "${set.id}" is used twice`);
      else ids.add(set.id);
      if (typeof set.label !== "string") out.push(`${at}.label must be text`);
      if (set.when !== undefined && typeof set.when !== "string") out.push(`${at}.when must be text`);
      if (!Array.isArray(set.units)) { out.push(`${at}.units must be a list`); return; }
      const uids = new Set<string>();
      set.units.forEach((u: LaborUnit, j) => {
        const ua = `${at}.units[${j}]`;
        if (!isObj(u)) { out.push(`${ua} must be an object`); return; }
        if (typeof u.id !== "string" || !u.id.trim()) out.push(`${ua}.id is required`);
        else if (uids.has(u.id)) out.push(`${ua}.id "${u.id}" is used twice in set ${set.id}`);
        else uids.add(u.id);
        if (typeof u.label !== "string") out.push(`${ua}.label must be text`);
        if (typeof u.hours !== "number" || !Number.isFinite(u.hours) || u.hours < 0) out.push(`${ua}.hours must be a number of 0 or more`);
        if (!LABOR_PERS.includes(u.per)) out.push(`${ua}.per must be one of ${LABOR_PERS.join(", ")}`);
      });
    });
    if (typeof s.labor.defaultUnitSet !== "string" || !ids.has(s.labor.defaultUnitSet)) out.push(`labor.defaultUnitSet "${s.labor?.defaultUnitSet}" is not one of the unit sets (${[...ids].join(", ")})`);
  }
  return out;
}

/** "a.b: old → new" for every leaf the patch changed. */
function describeChanges(before: unknown, after: unknown, prefix = ""): string[] {
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => describeChanges(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const show = (v: unknown) => {
    const t = JSON.stringify(v) ?? "undefined";
    return t.length > 60 ? `${t.slice(0, 57)}...` : t;
  };
  return [`${prefix}: ${show(before)} → ${show(after)}`];
}

export class StoreSettings {
  private readonly lock = new KeyedMutex();
  constructor(private readonly storage: Storage, private readonly now: () => string = () => new Date().toISOString()) {}

  /** The stored settings over the defaults (a field added later reads as its default). */
  async get(): Promise<BidSettings> {
    const bytes = await this.storage.getBytes(SETTINGS_KEY);
    const base = defaultSettings(this.now());
    if (!bytes) return base;
    const stored = JSON.parse(Buffer.from(bytes).toString("utf8")) as BidSettings;
    if (stored?.schema !== "brink.settings.v1") throw new Error(`${SETTINGS_KEY} is not a brink.settings.v1 document`);
    return deepMerge(base, stored);
  }

  /**
   * Deep-merge `patch` (objects merge, arrays replace), validate the result
   * (numbers ≥ 0, percentages as fractions 0..1, unit sets well formed), save
   * and log what changed. Throws on an invalid result, saving nothing.
   */
  async update(patch: unknown, by: "owner" | "claude"): Promise<{ settings: BidSettings; changes: string[] }> {
    if (!isObj(patch)) throw new Error("patch must be an object, e.g. {\"markup\": {\"materialPct\": 0.15}}");
    const locked = LOCKED.filter((k) => k in patch);
    if (locked.length) throw new Error(`${locked.join(", ")} cannot be set; they are kept by the server`);
    const unknown = Object.keys(patch).filter((k) => !(k in defaultSettings()));
    if (unknown.length) throw new Error(`unknown settings section${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (sections: company, labor, markup, travel, proposal)`);
    return this.lock.run(SETTINGS_KEY, async () => {
      const before = await this.get();
      const merged = deepMerge(before, patch);
      const problems = settingsProblems(merged);
      if (problems.length) throw new Error(`settings not saved: ${problems.join("; ")}`);
      const changes = describeChanges({ ...before, updated: null, changeLog: null }, { ...merged, updated: null, changeLog: null });
      if (!changes.length) return { settings: before, changes };
      const at = this.now();
      merged.updated = at;
      merged.changeLog = [...before.changeLog, { at, by, what: changes.join("; ") }].slice(-CHANGELOG_MAX);
      await this.save(merged);
      return { settings: merged, changes };
    });
  }

  /** The playbook text, or null when none is stored. */
  async getPlaybook(): Promise<string | null> {
    const bytes = await this.storage.getBytes(PLAYBOOK_KEY);
    return bytes ? Buffer.from(bytes).toString("utf8") : null;
  }

  /** Replace the playbook text; the settings changeLog records it. */
  async setPlaybook(text: string, by: "owner" | "claude"): Promise<void> {
    if (typeof text !== "string") throw new Error("playbook text must be text");
    await this.storage.put(PLAYBOOK_KEY, text, { contentType: "text/markdown; charset=utf-8" });
    await this.lock.run(SETTINGS_KEY, async () => {
      const s = await this.get();
      const at = this.now();
      s.updated = at;
      s.changeLog = [...s.changeLog, { at, by, what: `playbook replaced (${text.length} characters)` }].slice(-CHANGELOG_MAX);
      await this.save(s);
    });
  }

  private async save(s: BidSettings): Promise<void> {
    await this.storage.put(SETTINGS_KEY, `${JSON.stringify(s, null, 1)}\n`, { contentType: "application/json" });
  }
}
