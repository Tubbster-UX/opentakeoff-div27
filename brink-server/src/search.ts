// Page-level search and reading over the extracted text in the store
// (projects/<p>/text/<path>.json), with a small LRU of parsed text files.

import { assertProjectId, assertProjectPath, projectKey } from "./projects.ts";
import type { ExtractedText, FileKind, ProjectFile, ProjectId, Projects, Search, SearchHit, Storage } from "./types.ts";

const KIND_PRIORITY: Record<FileKind, number> = { sow: 0, spec: 1, form: 2, plan: 3, doc: 4, sheet: 5, image: 6, other: 7, output: 8 };

const SNIPPET_CHARS = 240;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 1_000_000;

interface CacheEntry {
  stamp: string;
  doc: ExtractedText;
  chars: number;
}

export interface SearchDeps {
  storage: Storage;
  projects: Projects;
  /** Parsed text files kept in memory. Default 64. */
  cacheEntries?: number;
  /** Total characters kept in memory. Default 50M. */
  cacheChars?: number;
}

/** Splits a query into lowercase terms; "quoted phrases" stay together. */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const t = normalize(m[1] ?? m[2] ?? "").replace(/^"+|"+$/g, "");
    if (t) terms.push(t);
  }
  return [...new Set(terms)];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function makeSnippet(text: string, at: number, len: number): string {
  const half = Math.floor((SNIPPET_CHARS - len) / 2);
  let start = Math.max(0, at - Math.max(0, half));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  start = Math.max(0, Math.min(start, end - SNIPPET_CHARS));
  let s = text.slice(start, end).trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s += "…";
  return s;
}

export class StoreSearch implements Search {
  private readonly storage: Storage;
  private readonly projects: Projects;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private cachedChars = 0;

  constructor(deps: SearchDeps) {
    this.storage = deps.storage;
    this.projects = deps.projects;
    this.maxEntries = deps.cacheEntries ?? 64;
    this.maxChars = deps.cacheChars ?? 50_000_000;
  }

  async search(project: ProjectId, query: string, opts: { kinds?: FileKind[]; path?: string; limit?: number } = {}): Promise<SearchHit[]> {
    assertProjectId(project);
    const m = await this.projects.get(project);
    if (!m) throw new Error(`Project "${project}" not found`);
    const terms = parseQuery(query ?? "");
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
    const scope = opts.path?.replace(/^\/+|\/+$/g, "") || null;
    const files = m.files.filter((f) => f.text === "ok" && (!kinds || kinds.has(f.kind)) && (!scope || f.path === scope || f.path.startsWith(scope + "/")));

    const scored: { hit: SearchHit; score: number; prio: number }[] = [];
    for (const f of files) {
      const doc = await this.load(project, f).catch(() => null);
      if (!doc) continue;
      for (const page of doc.pages) {
        const flat = page.text.replace(/\s+/g, " ").trim();
        const lower = flat.toLowerCase();
        let score = 0;
        let first = -1;
        let firstLen = 0;
        let all = true;
        for (const t of terms) {
          const at = lower.indexOf(t);
          if (at < 0) {
            all = false;
            break;
          }
          score += countOccurrences(lower, t);
          if (first < 0 || at < first) {
            first = at;
            firstLen = t.length;
          }
        }
        if (!all) continue;
        scored.push({ hit: { path: f.path, kind: f.kind, page: page.n, snippet: makeSnippet(flat, first, firstLen) }, score, prio: KIND_PRIORITY[f.kind] ?? 9 });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.prio - b.prio || a.hit.path.localeCompare(b.hit.path) || a.hit.page - b.hit.page);
    return scored.slice(0, limit).map((s) => s.hit);
  }

  async read(project: ProjectId, path: string, opts: { fromPage?: number; toPage?: number; maxChars?: number } = {}): Promise<{ text: string; pages: number; truncated: boolean } | null> {
    assertProjectId(project);
    assertProjectPath(path);
    const m = await this.projects.get(project);
    if (!m) throw new Error(`Project "${project}" not found`);
    const f = m.files.find((x) => x.path === path);
    if (!f) throw new Error(`File "${path}" not found in project "${project}"`);
    if (f.text !== "ok") return null;
    const doc = await this.load(project, f);
    if (!doc || doc.pages.length === 0) return null;
    const total = doc.pages.length;
    const from = Math.max(1, Math.floor(opts.fromPage ?? 1));
    const to = Math.min(total, Math.floor(opts.toPage ?? total));
    const maxChars = Math.max(1, Math.min(MAX_READ_CHARS, Math.floor(opts.maxChars ?? DEFAULT_READ_CHARS)));
    const multi = total > 1;
    let out = "";
    let truncated = false;
    for (const p of doc.pages) {
      if (p.n < from || p.n > to) continue;
      const head = multi ? `${out ? "\n\n" : ""}--- page ${p.n}${p.label ? ` (${p.label})` : ""} ---\n` : "";
      const chunk = head + p.text;
      if (out.length + chunk.length > maxChars) {
        out += chunk.slice(0, Math.max(0, maxChars - out.length));
        truncated = true;
        break;
      }
      out += chunk;
    }
    return { text: out, pages: total, truncated };
  }

  /** Parsed text for a file; cached until the file's manifest entry changes. */
  private async load(project: ProjectId, f: ProjectFile): Promise<ExtractedText | null> {
    const key = `${project}\u0000${f.path}`;
    const stamp = [f.size, f.added, f.text, f.textChars ?? 0, f.pages ?? 0, (f as { sha256?: string }).sha256 ?? ""].join("|");
    const hit = this.cache.get(key);
    if (hit && hit.stamp === stamp) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.doc;
    }
    if (hit) this.evict(key);
    const bytes = await this.storage.getBytes(projectKey(project, "text", `${f.path}.json`));
    if (!bytes) return null;
    const doc = JSON.parse(Buffer.from(bytes).toString("utf8")) as ExtractedText;
    if (!Array.isArray(doc?.pages)) return null;
    const chars = doc.pages.reduce((n, p) => n + (p.text?.length ?? 0), 0);
    if (chars <= this.maxChars) {
      this.cache.set(key, { stamp, doc, chars });
      this.cachedChars += chars;
      while (this.cache.size > this.maxEntries || this.cachedChars > this.maxChars) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.evict(oldest);
      }
    }
    return doc;
  }

  private evict(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    this.cachedChars -= e.chars;
    this.cache.delete(key);
  }
}
