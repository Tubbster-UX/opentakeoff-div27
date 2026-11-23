// Cable labels for the install design (src/installTypes.ts LabelScheme).
//
// A job's labeling section (27 05 53 / TIA-606) sets the scheme when it has
// one: Claude reads the spec and sets the pattern with its reference.
// Otherwise the default "{type}{seq:2}" (D01, V01, S01, F01, ...).
//
// Tokens: {type} kind letter, {seq} / {seq:N} running number per kind,
// {rack} rack id, {tr} TR number, {panel} patch panel letter (A, B, ... per
// rack, top down), {port} / {port:N} panel port, {device} device tag,
// {room} room name. {seq} counts per kind in a stable order: rack, then
// room, then device tag (then the device port).
import type { CableKind, InstallCable, InstallDevice, InstallEquipment, LabelScheme, Rack } from "../installTypes.ts";

export const CABLE_KINDS: readonly CableKind[] = ["data", "video", "fiber", "speaker", "audio", "control", "coax", "power", "other"];

export const DEFAULT_TYPE_LETTERS: Record<CableKind, string> = {
  data: "D", video: "V", fiber: "F", speaker: "S", audio: "A", control: "C", coax: "X", power: "P", other: "Z",
};

export const DEFAULT_PATTERN = "{type}{seq:2}";

export const DEFAULT_LABEL_SCHEME: LabelScheme = Object.freeze({
  source: "default",
  description: "Kind letter + running number per kind, e.g. D01, D02, F01 (no labeling section in the spec)",
  pattern: DEFAULT_PATTERN,
  typeLetters: Object.freeze({ ...DEFAULT_TYPE_LETTERS }),
}) as LabelScheme;

/** A fresh, mutable copy of the default scheme. */
export const defaultLabelScheme = (): LabelScheme => ({ ...DEFAULT_LABEL_SCHEME, typeLetters: { ...DEFAULT_TYPE_LETTERS } });

export const LABEL_TOKENS = ["type", "seq", "rack", "tr", "panel", "port", "device", "room"] as const;
type Token = (typeof LABEL_TOKENS)[number];
/** Tokens that take a zero-pad width (":N"). */
const PADDED = new Set<Token>(["seq", "port"]);

interface Part { lit?: string; token?: Token; pad?: number }

const TOKEN_RE = /\{([^{}]*)\}/g;

/** Split a pattern into literal text and tokens; unknown tokens are reported, not thrown. */
function parse(pattern: string): { parts: Part[]; errors: string[] } {
  const parts: Part[] = [];
  const errors: string[] = [];
  let last = 0;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    if (m.index! > last) parts.push({ lit: pattern.slice(last, m.index) });
    last = m.index! + m[0].length;
    const [name, padRaw, ...extra] = m[1].trim().split(":");
    const tok = name.trim().toLowerCase() as Token;
    if (!(LABEL_TOKENS as readonly string[]).includes(tok)) {
      errors.push(`unknown token {${m[1]}} (known: ${LABEL_TOKENS.map((t) => `{${t}}`).join(", ")})`);
      continue;
    }
    let pad: number | undefined;
    if (padRaw !== undefined || extra.length) {
      if (!PADDED.has(tok)) { errors.push(`{${m[1]}}: only {seq:N} and {port:N} take a width`); continue; }
      const n = Number(padRaw);
      if (extra.length || !Number.isInteger(n) || n < 1 || n > 6) { errors.push(`{${m[1]}}: the width must be a whole number from 1 to 6`); continue; }
      pad = n;
    }
    parts.push({ token: tok, ...(pad ? { pad } : {}) });
  }
  if (last < pattern.length) parts.push({ lit: pattern.slice(last) });
  const rest = parts.filter((p) => p.lit !== undefined).map((p) => p.lit).join("");
  if (/[{}]/.test(rest)) errors.push("unbalanced { or } in the pattern");
  return { parts, errors };
}

export interface LabelSchemeProblems {
  /** The scheme cannot be used (unknown token, cannot be unique, bad letters). */
  errors: string[];
  /** Usable, but labels may collide on some jobs (checked on the real labels by checkInstallDesign). */
  warnings: string[];
}

/** Validate a pattern (and the type letters, when given). */
export function validateLabelScheme(scheme: Pick<LabelScheme, "pattern"> & { typeLetters?: Partial<Record<CableKind, string>> }): LabelSchemeProblems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pattern = typeof scheme.pattern === "string" ? scheme.pattern : "";
  if (!pattern.trim()) return { errors: ["the pattern is empty"], warnings };
  if (pattern.length > 80) errors.push("the pattern is longer than 80 characters");
  const { parts, errors: pe } = parse(pattern);
  errors.push(...pe);
  const toks = new Set(parts.filter((p) => p.token).map((p) => p.token!));
  if (!toks.has("seq") && !toks.has("port")) {
    errors.push("the pattern cannot be unique: it has neither {seq} nor {port}");
  } else if (!toks.has("seq")) {
    if (!toks.has("panel")) warnings.push("{port} without {panel} repeats on every patch panel: two panels in one rack give the same labels");
    if (!toks.has("rack") && !toks.has("tr")) warnings.push("{port} without {rack} or {tr} repeats in every rack");
  } else if (!toks.has("type")) {
    warnings.push("{seq} counts per cable kind: without {type}, a data and a fiber cable can get the same number");
  }
  if (scheme.typeLetters) {
    for (const k of CABLE_KINDS) {
      const v = scheme.typeLetters[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || !/^[A-Za-z0-9]{1,3}$/.test(v)) errors.push(`typeLetters.${k} must be 1 to 3 letters or digits`);
    }
  }
  return { errors, warnings };
}

export interface LabelContext {
  devices: InstallDevice[];
  racks: Rack[];
  equipment: InstallEquipment[];
}

const pad = (v: string | number, n?: number) => (n ? String(v).padStart(n, "0") : String(v));
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const tilde = (s: string | null | undefined) => (s == null || s === "" ? "￿" : s);

/** The number in a port id or label ("p12" → 12), else the id. */
export function portNumber(port: string | undefined): string {
  if (!port) return "";
  const m = /(\d+)\s*$/.exec(port);
  return m ? String(Number(m[1])) : port;
}

/** Panel letters per rack: panels (rack items of kind "panel") top down → A, B, ...; panels not in a rack item keep equipment order after them. */
export function panelLetters(ctx: LabelContext): Map<string, string> {
  const out = new Map<string, string>();
  const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`);
  for (const r of ctx.racks) {
    const panels = r.items.filter((it) => it.kind === "panel").sort((a, b) => b.ruTop - a.ruTop).map((it) => it.tag);
    for (const e of ctx.equipment) if (e.rack === r.id && !panels.includes(e.tag) && /^(PP|FP)-/.test(e.tag)) panels.push(e.tag);
    panels.forEach((t, i) => out.set(t, letter(i)));
  }
  return out;
}

/** The TR number of a rack: the first number in its name ("IDF-2" → 2), else in its id ("RK-101" → 101). */
export function trNumber(rack: Rack | undefined): string {
  if (!rack) return "";
  const m = /\d+/.exec(rack.name ?? "") ?? /\d+/.exec(rack.id);
  return m ? String(Number(m[0])) : rack.id;
}

/**
 * The {seq} order: per kind, by rack id, then room, then device tag, then the
 * device port, then the cable's position. Returns the 1-based number of each cable.
 */
export function sequenceNumbers(cables: InstallCable[], ctx: LabelContext): number[] {
  const devByTag = new Map(ctx.devices.map((d) => [d.tag, d]));
  const roomOf = (c: InstallCable) => devByTag.get(c.to.equipment)?.room ?? null;
  const idx = cables.map((_, i) => i);
  idx.sort((a, b) => {
    const ca = cables[a], cb = cables[b];
    return natural(tilde(ca.from.rack), tilde(cb.from.rack))
      || natural(tilde(roomOf(ca)), tilde(roomOf(cb)))
      || natural(ca.to.equipment, cb.to.equipment)
      || natural(ca.to.port ?? "", cb.to.port ?? "")
      || a - b;
  });
  // A number once given is kept (InstallCable.seq): printed labels must not
  // move when the takeoff changes. New cables continue after the highest
  // number in use for their kind; a removed cable's number is not reused.
  const counters = new Map<CableKind, number>();
  for (const c of cables) {
    if (Number.isInteger(c.seq) && (c.seq as number) >= 1) counters.set(c.kind, Math.max(counters.get(c.kind) ?? 0, c.seq as number));
  }
  const taken = new Map<CableKind, Set<number>>();
  const out = new Array<number>(cables.length);
  for (const i of idx) {
    const c = cables[i];
    const set = taken.get(c.kind) ?? new Set<number>();
    taken.set(c.kind, set);
    if (Number.isInteger(c.seq) && (c.seq as number) >= 1 && !set.has(c.seq as number)) {
      out[i] = c.seq as number;
      set.add(out[i]);
      continue;
    }
    const n = (counters.get(c.kind) ?? 0) + 1;
    counters.set(c.kind, n);
    set.add(n);
    out[i] = n;
  }
  return out;
}

/**
 * Labels for every cable by the scheme (overrides are the caller's business:
 * it keeps a cable's own label when labelOverride is set). Throws when the
 * pattern does not validate.
 */
export function applyLabelScheme(scheme: LabelScheme, cables: InstallCable[], ctx: LabelContext): string[] {
  const problems = validateLabelScheme(scheme);
  if (problems.errors.length) throw new Error(`label pattern ${JSON.stringify(scheme.pattern)}: ${problems.errors.join("; ")}`);
  const { parts } = parse(scheme.pattern);
  const letters = { ...DEFAULT_TYPE_LETTERS, ...(scheme.typeLetters ?? {}) };
  const seq = sequenceNumbers(cables, ctx);
  const devByTag = new Map(ctx.devices.map((d) => [d.tag, d]));
  const rackById = new Map(ctx.racks.map((r) => [r.id, r]));
  const panels = panelLetters(ctx);
  return cables.map((c, i) => {
    const dev = devByTag.get(c.to.equipment);
    const vals: Record<Token, (p?: number) => string> = {
      type: () => letters[c.kind] ?? "Z",
      seq: (p) => pad(seq[i], p),
      rack: () => c.from.rack ?? "",
      tr: () => trNumber(rackById.get(c.from.rack ?? "")),
      panel: () => panels.get(c.from.equipment) ?? "",
      port: (p) => pad(portNumber(c.from.port), p),
      device: () => c.to.equipment,
      room: () => (dev?.room ?? "").replace(/\s+/g, " ").trim(),
    };
    return parts.map((p) => (p.lit !== undefined ? p.lit : vals[p.token!](p.pad))).join("").trim();
  });
}
