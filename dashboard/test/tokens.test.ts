// The Brink colour tokens against the Brand Guidelines v1.0 and WCAG 2.1 AA.
// Parses web/src/design/tokens.css and checks every foreground / background pair the UI
// uses: 4.5:1 for text, 3:1 for borders, focus rings, status dots and icons. A token
// change that drops a pair below its threshold fails here.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../web/src/design/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Record<string, string> {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")}\\s*\\{([^}]*)\\}`);
  const m = CSS.match(re);
  if (!m) throw new Error(`no block ${selector}`);
  return Object.fromEntries([...m[2]!.matchAll(/(--bk-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1]!, x[2]!.toLowerCase()]));
}

const light = block(":root");
const dark = { ...light, ...block(":root.dark, .bk-inverse") };
const inverse = { ...dark, ...block(".bk-inverse") };
const THEMES = { light, dark, inverse } as const;

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const UI = 3;
const GROUNDS = ["canvas", "surface", "surface-2"];
/** [foreground, background(s), minimum]. Names are tokens without the --bk- prefix; "#fff" is literal white. */
const PAIRS: [string, string[], number][] = [
  ["ink", [...GROUNDS, "hover", "pressed", "flash", "accent-soft"], TEXT],
  ["ink-2", [...GROUNDS, "hover", "pressed"], TEXT],
  ["ink-3", [...GROUNDS, "hover", "pressed"], TEXT],
  ["accent", [...GROUNDS, "accent-soft", "hover"], TEXT],
  ["accent-hover", ["surface", "canvas"], TEXT],
  ["on-accent", ["accent", "accent-hover"], TEXT],
  ["#ffffff", ["accent-fill", "accent-fill-hover", "ok-fill", "warn-fill", "danger-fill"], TEXT],
  ["surface", ["warn"], TEXT], // the canvas's USB-C power badge (es-theme.css)
  ["on-primary", ["primary", "primary-hover"], TEXT],
  ["ok", ["surface", "surface-2", "ok-soft"], TEXT],
  ["warn", ["surface", "surface-2", "warn-soft"], TEXT],
  ["danger", ["surface", "surface-2", "danger-soft"], TEXT],
  ["ink", ["paper"], TEXT],
  // Non-text: input outlines, the focus ring, status dots, the primary button's edge.
  ["line-strong", [...GROUNDS], UI],
  ["focus", [...GROUNDS, "paper"], UI],
  ["primary", ["canvas", "surface"], UI],
];

const resolveToken = (t: Record<string, string>, name: string) => {
  if (name.startsWith("#")) return name;
  if (name === "focus") return t["--bk-accent"]!;
  const v = t[`--bk-${name}`];
  if (!v) throw new Error(`token --bk-${name} missing`);
  return v;
};

describe("brand palette (Brand Guidelines v1.0)", () => {
  it("names the guide's HEX values", () => {
    expect(light).toMatchObject({
      "--bk-brand-navy": "#0d161f",
      "--bk-brand-navy-700": "#1e2d3d",
      "--bk-brand-blue": "#1f5a96",
      "--bk-brand-white": "#ffffff",
      "--bk-brand-surface-raised": "#f3f5f7",
      "--bk-brand-line": "#d5dbe1",
      "--bk-brand-border-strong": "#6b7884",
      "--bk-brand-ink-muted": "#4e5b67",
    });
  });
  it("uses the guide's roles in the light theme", () => {
    expect(light["--bk-canvas"]).toBe("#ffffff");
    expect(light["--bk-ink"]).toBe("#0d161f");
    expect(light["--bk-accent"]).toBe("#1f5a96");
    expect(light["--bk-surface-2"]).toBe("#f3f5f7");
    expect(light["--bk-line"]).toBe("#d5dbe1");
    expect(light["--bk-line-strong"]).toBe("#6b7884");
    expect(light["--bk-ink-3"]).toBe("#4e5b67");
    expect(dark["--bk-canvas"]).toBe("#0d161f");
    expect(dark["--bk-surface"]).toBe("#1e2d3d");
    expect(inverse["--bk-surface"]).toBe("#0d161f");
  });
  it("has one accent hue: every accent token is Brink Blue or a tint / shade of it", () => {
    for (const t of Object.values(THEMES)) {
      for (const k of ["--bk-accent", "--bk-accent-hover", "--bk-accent-fill", "--bk-accent-fill-hover"]) {
        const h = hue(t[k]!);
        expect(Math.abs(h - hue("#1f5a96")), `${k} ${t[k]}`).toBeLessThan(8);
      }
    }
  });
  it("keeps Brink Productions amber out", () => {
    expect(CSS.toLowerCase()).not.toContain("#dea31e");
    for (const t of Object.values(THEMES)) expect(Math.abs(hue(t["--bk-warn"]!) - hue("#dea31e"))).toBeGreaterThan(12);
  });
  it("has no warm, cream or tan grounds", () => {
    for (const [name, t] of Object.entries(THEMES)) {
      for (const k of ["canvas", "surface", "surface-2", "hover", "pressed", "line", "paper", "paper-origin"]) {
        const v = t[`--bk-${k}`]!;
        const [r, , b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
        expect(b! >= r!, `${name} ${k} ${v} is warm`).toBe(true);
      }
    }
  });
  it("keeps ok, warn and danger distinct", () => {
    for (const t of Object.values(THEMES)) {
      const [ok, warn, danger] = ["--bk-ok", "--bk-warn", "--bk-danger"].map((k) => hue(t[k]!));
      expect(Math.abs(warn! - danger!)).toBeGreaterThan(15);
      expect(Math.abs(ok! - warn!)).toBeGreaterThan(60);
    }
  });
});

describe("contrast (WCAG 2.1 AA)", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const [fg, bgs, min] of PAIRS) {
      for (const bg of bgs) {
        it(`${theme}: ${fg} on ${bg} >= ${min}:1`, () => {
          const r = contrast(resolveToken(t, fg), resolveToken(t, bg));
          expect(r, `${resolveToken(t, fg)} on ${resolveToken(t, bg)} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(min);
        });
      }
    }
  }
  it("never pairs navy text with Navy 700, or white text with Surface Raised", () => {
    for (const t of Object.values(THEMES)) {
      for (const [fg, bgs] of PAIRS) {
        for (const bg of bgs) {
          const pair = `${resolveToken(t, fg)} on ${resolveToken(t, bg)}`;
          expect(pair).not.toBe("#0d161f on #1e2d3d");
          expect(pair).not.toBe("#ffffff on #f3f5f7");
        }
      }
    }
  });
  it("matches the guide's approved pairings", () => {
    expect(contrast("#0d161f", "#ffffff")).toBeCloseTo(18.2, 1);
    expect(contrast("#4e5b67", "#f3f5f7")).toBeCloseTo(6.4, 1);
    expect(contrast("#ffffff", "#1e2d3d")).toBeCloseTo(14.0, 1);
    expect(contrast("#1f5a96", "#ffffff")).toBeCloseTo(7.1, 1);
  });
});

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
