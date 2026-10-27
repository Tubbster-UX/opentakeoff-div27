// Auto-save — an MCP session's takeoff on disk while the agent works.
//
// A session's takeoff lives in memory, and an MCP stdio server lives exactly as
// long as its client: when the client's session ends, the server stops with it.
// Before this module, a whole bid's takeoff was lost that way because nothing
// had called export_takeoff yet. Nothing here adds a verb: the session writes
// the export_takeoff payload to a file as it changes, load_plan says where, and
// takeoff_summary says when it last landed.
//
// What is written is exactly session.exportPayload() — the
// "opentakeoff.takeoff_canvas.v1" document export_takeoff returns — with one
// extra top-level key, `autosave: { saved_at, tool, plan }`, placed right after
// `schema`. The key is what makes a file recognizable as an autosave this server
// wrote (the safewrite rule: never destroy a file OpenTakeoff did not write),
// and both importers ignore it: import_takeoff and the app's Import takeoff
// read their fields by name. export_takeoff never carries it.
//
// When it writes:
// - after every change the session journals (Session.record), after undo_last,
//   import_takeoff and a first set_scale, and as a safety net after every
//   successful tool call — a write only happens when the payload's bytes differ
//   from the last ones written, so a read never rewrites the file;
// - coalesced: a trailing debounce (DEBOUNCE_MS) capped by MAX_WAIT_MS, so a
//   burst of a hundred calls writes a handful of times and a crash loses at
//   most about MAX_WAIT_MS of work;
// - atomically: a temp file in the same directory, then rename;
// - synchronously at process exit (flushSync, wired in server.ts), so a normal
//   shutdown always leaves the last change on disk.
//
// What it never does:
// - fail a tool call (a failed write is stored and surfaced in takeoff_summary);
// - overwrite a file it did not write: a foreign file at the path is left alone
//   and reported;
// - import anything by itself: an autosave found at load_plan is named in the
//   reply, and the agent decides whether to import_takeoff it. If the session
//   changes something without importing it, the found file is first moved
//   aside to a dated sibling, so the earlier work is never lost.
import path from "node:path";
import { closeSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Session } from "./session.ts";

export const AUTOSAVE_ENV = "OPENTAKEOFF_AUTOSAVE";
export const AUTOSAVE_SUFFIX = " - takeoff autosave.json";
export const DEBOUNCE_MS = 750;
export const MAX_WAIT_MS = 2000;

/** The file next to the plan: `<plan dir>/<plan without .pdf> - takeoff autosave.json`
 * (the export_marked_pdf naming rule, `<plan> - marked set.pdf`). */
export function defaultAutosavePath(planPath: string): string {
  const base = path.basename(planPath).replace(/\.pdf$/i, "");
  return path.join(path.dirname(path.resolve(planPath)), `${base}${AUTOSAVE_SUFFIX}`);
}

/** How the environment configures auto-save: off, the default path, or an
 * explicit file (a directory means "this folder, default file name"). */
export type AutosaveMode = { kind: "off" } | { kind: "default" } | { kind: "file"; path: string } | { kind: "dir"; path: string };

export function autosaveModeFromEnv(value: string | undefined, cwd = process.cwd()): AutosaveMode {
  const v = (value ?? "").trim();
  if (!v || /^(1|on|true|yes)$/i.test(v)) return { kind: "default" };
  if (/^(0|off|false|no)$/i.test(v)) return { kind: "off" };
  const abs = path.resolve(cwd, v);
  if (/[\\/]$/.test(v)) return { kind: "dir", path: abs };
  try { if (statSync(abs).isDirectory()) return { kind: "dir", path: abs }; } catch { /* a file that does not exist yet */ }
  return { kind: "file", path: abs };
}

/** The `autosave` marker key's value. */
export interface AutosaveMarker { saved_at: string; tool: string; plan: string }

/** What load_plan reports about a file it found at the autosave path. */
export interface FoundAutosave {
  saved_at: string | null;
  tool: string | null;
  plan: string | null;
  shapes: number;
  conditions: number;
  cable_runs: number;
}

/** The head of an autosave this server wrote: the schema, then the marker. */
const OWN_HEAD = /^\s*\{\s*"schema"\s*:\s*"opentakeoff\.takeoff_canvas\.v1"\s*,\s*"autosave"\s*:\s*\{/;

function headSync(p: string, n: number): string {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const bytes = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function headAsync(p: string, n: number): Promise<string> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Does `p` hold an autosave this server wrote? Absent → "absent"; unreadable,
 * a directory, or anything else → "foreign" (an unknown file is exactly the
 * thing worth protecting). */
export async function autosaveFileKind(p: string): Promise<"absent" | "own" | "foreign"> {
  let st;
  try { st = await stat(p); } catch { return "absent"; }
  if (!st.isFile()) return "foreign";
  try { return OWN_HEAD.test(await headAsync(p, 512)) ? "own" : "foreign"; } catch { return "foreign"; }
}

function autosaveFileKindSync(p: string): "absent" | "own" | "foreign" {
  let st;
  try { st = statSync(p); } catch { return "absent"; }
  if (!st.isFile()) return "foreign";
  try { return OWN_HEAD.test(headSync(p, 512)) ? "own" : "foreign"; } catch { return "foreign"; }
}

/** Read the counts load_plan names for an existing autosave. */
export async function readFoundAutosave(p: string): Promise<FoundAutosave | null> {
  try {
    const doc = JSON.parse(await readFile(p, "utf8"));
    const arr = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    const m = doc?.autosave ?? {};
    return {
      saved_at: typeof m.saved_at === "string" ? m.saved_at : null,
      tool: typeof m.tool === "string" ? m.tool : null,
      plan: typeof m.plan === "string" ? m.plan : null,
      shapes: arr(doc.shapes),
      conditions: arr(doc.conditions),
      cable_runs: Array.isArray(doc.cable_runs) ? doc.cable_runs.filter((r: { hold?: unknown }) => r && !r.hold).length : 0,
    };
  } catch {
    return null;
  }
}

/** A free sibling name for a found autosave being moved aside. */
function asideName(p: string, savedAt: string | null, exists: (q: string) => boolean): string {
  const stamp = (savedAt ?? new Date().toISOString()).replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const stem = p.replace(/\.json$/i, "");
  let q = `${stem} (before ${stamp}).json`;
  for (let n = 2; exists(q); n++) q = `${stem} (before ${stamp}) ${n}.json`;
  return q;
}

const existsSync = (q: string) => { try { statSync(q); return true; } catch { return false; } };

/** The status takeoff_summary carries. */
export interface AutosaveStatus {
  path: string | null;
  saved_at: string | null;
  error?: string;
  pending?: true;
  disabled?: true;
  moved_aside?: string;
}

/** What load_plan's reply carries about auto-save. */
export interface AutosaveLoadInfo {
  path: string | null;
  disabled?: true;
  found?: FoundAutosave & { path: string };
  error?: string;
}

export interface AutosaveOptions {
  mode?: AutosaveMode;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => Date;
  /** Where write failures are logged (stderr by default; stdout is the MCP wire). */
  log?: (line: string) => void;
}

export class Autosave {
  readonly mode: AutosaveMode;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private session: Session | null = null;

  /** The file this session writes, null before a plan loads or when off. */
  private target: string | null = null;
  /** The payload body last written (or the baseline at load) — a write only
   * happens when the current body differs. */
  private lastBody: string | null = null;
  private lastTool = "";
  private dirtySince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private savedAt: string | null = null;
  private error: string | null = null;
  private loggedError: string | null = null;
  /** An autosave found at load_plan that this session has not imported: it is
   * moved aside before the first write replaces it. */
  private found: { path: string; saved_at: string | null } | null = null;
  private movedAside: string | null = null;
  private tmpSeq = 0;
  /** Completed writes, for tests and diagnostics. */
  writes = 0;

  constructor(opts: AutosaveOptions = {}) {
    this.mode = opts.mode ?? autosaveModeFromEnv(process.env[AUTOSAVE_ENV]);
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get enabled(): boolean { return this.mode.kind !== "off"; }
  get path(): string | null { return this.target; }

  attach(session: Session): this {
    this.session = session;
    session.autosave = this;
    return this;
  }

  private resolveTarget(planPath: string): string | null {
    switch (this.mode.kind) {
      case "off": return null;
      case "file": return this.mode.path;
      case "dir": return path.join(this.mode.path, path.basename(defaultAutosavePath(planPath)));
      default: return defaultAutosavePath(planPath);
    }
  }

  /** The payload body as written (no marker), or null with no plan loaded. */
  private body(): string | null {
    const s = this.session;
    if (!s || !s.file) return null;
    return JSON.stringify(s.exportPayload());
  }

  private serialize(body: string, tool: string, savedAt: string): string {
    // The marker goes right after `schema` so a 512-byte head identifies the
    // file; the rest is the export_takeoff body byte for byte.
    const marker: AutosaveMarker = { saved_at: savedAt, tool, plan: this.session?.file ?? "" };
    const schemaKey = /^\{"schema":"[^"]*"/.exec(body);
    if (!schemaKey) {
      const doc = JSON.parse(body);
      return JSON.stringify({ schema: doc.schema, autosave: marker, ...doc });
    }
    const rest = body.slice(schemaKey[0].length);
    return `${schemaKey[0]},"autosave":${JSON.stringify(marker)}${rest}`;
  }

  /** Called before a non-merge load_plan clears the session: the outgoing
   * plan's last change lands in ITS file before the state goes. */
  async beforeReplace(): Promise<void> {
    await this.flush();
    this.cancelTimer();
    this.target = null;
    this.lastBody = null;
    this.dirtySince = null;
    this.savedAt = null;
    this.error = null;
    this.found = null;
    this.movedAside = null;
  }

  /** Called after load_plan loaded its document. A merge keeps the primary
   * plan's target; a fresh load points at the new plan's file and reports any
   * autosave already there (never importing it). */
  async afterLoad(opts: { merged: boolean }): Promise<AutosaveLoadInfo> {
    const s = this.session;
    if (!this.enabled || !s?.filePath) return { path: null, disabled: true };
    // a merge adds a document but no takeoff record, so it keeps the target
    // and the baseline (unsaved or failed work stays due for its write)
    if (!opts.merged || !this.target) {
      this.target = this.resolveTarget(s.filePath);
      // the fresh session's empty payload is the baseline, so loading a plan
      // never writes (and never replaces an autosave the agent has not read)
      this.lastBody = this.body();
      this.dirtySince = null;
    }
    const target = this.target as string;
    const info: AutosaveLoadInfo = { path: target };
    if (opts.merged) return info;
    const kind = await autosaveFileKind(target);
    if (kind === "foreign") {
      info.error = `${target} exists and is not an OpenTakeoff autosave, so auto-save will not write there. Set ${AUTOSAVE_ENV}=<path> in the server's environment to save somewhere else, or move that file.`;
    } else if (kind === "own") {
      const found = await readFoundAutosave(target);
      if (found) {
        info.found = { path: target, ...found };
        this.found = { path: target, saved_at: found.saved_at };
      }
    }
    return info;
  }

  /** import_takeoff of the found autosave resumes it: later writes replace it
   * in place instead of moving it aside first. */
  noteImport(filePath: string): void {
    if (this.found && path.resolve(filePath) === path.resolve(this.found.path)) this.found = null;
  }

  /** Something may have changed. `weak` (the after-every-call safety net)
   * never overrides a tool name a real change already recorded. */
  touch(tool: string, opts: { weak?: boolean } = {}): void {
    if (!this.enabled || !this.target) return;
    if (!opts.weak || this.dirtySince === null) this.lastTool = tool;
    const t = this.now().getTime();
    if (this.dirtySince === null) this.dirtySince = t;
    this.cancelTimer();
    const wait = Math.max(0, Math.min(this.debounceMs, this.dirtySince + this.maxWaitMs - t));
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, wait);
    // never keep the process alive for a save — the exit hook flushes instead
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Write now if anything changed since the last write. Never throws. */
  async flush(): Promise<void> {
    this.cancelTimer();
    // one write at a time; changes that arrive during a write are picked up
    // by the loop's next pass
    while (this.inflight) await this.inflight;
    // after a failed write the work is still unsaved: an explicit flush (a
    // summary, a plan switch) tries again even with nothing new
    if (this.dirtySince === null && !this.error) return;
    this.inflight = this.writeAsync().finally(() => { this.inflight = null; });
    await this.inflight;
  }

  private async writeAsync(): Promise<void> {
    const target = this.target;
    this.dirtySince = null;
    let body: string | null;
    try { body = this.body(); } catch (e) { this.fail(target, e); return; }
    if (!target || body === null) return;
    // nothing unsaved (a change undone, say): whatever failed before no longer matters
    if (body === this.lastBody) { this.error = null; return; }
    const tool = this.lastTool;
    const savedAt = this.now().toISOString();
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${++this.tmpSeq}.tmp`);
    try {
      const kind = await autosaveFileKind(target);
      if (kind === "foreign") throw new Error(`${target} exists and is not an OpenTakeoff autosave; not overwriting it. Set ${AUTOSAVE_ENV}=<path> to save somewhere else, or call export_takeoff with a path.`);
      if (kind === "own" && this.found && path.resolve(this.found.path) === path.resolve(target)) {
        const aside = asideName(target, this.found.saved_at, existsSync);
        await rename(target, aside);
        this.movedAside = aside;
        this.found = null;
      }
      await writeFile(tmp, this.serialize(body, tool, savedAt));
      await rename(tmp, target);
      this.lastBody = body;
      this.savedAt = savedAt;
      this.writes++;
      this.error = null;
    } catch (e) {
      await unlink(tmp).catch(() => {});
      this.fail(target, e);
    }
  }

  /** The exit-time flush: synchronous, because a process "exit" handler cannot
   * wait on a promise. Same rules as the async write. Never throws. */
  flushSync(): void {
    this.cancelTimer();
    const target = this.target;
    if (!this.enabled || !target) return;
    let body: string | null;
    try { body = this.body(); } catch (e) { this.fail(target, e); return; }
    if (body === null) return;
    if (body === this.lastBody) { this.error = null; return; }
    const savedAt = this.now().toISOString();
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${++this.tmpSeq}.tmp`);
    try {
      const kind = autosaveFileKindSync(target);
      if (kind === "foreign") throw new Error(`${target} exists and is not an OpenTakeoff autosave; not overwriting it.`);
      if (kind === "own" && this.found && path.resolve(this.found.path) === path.resolve(target)) {
        const aside = asideName(target, this.found.saved_at, existsSync);
        renameSync(target, aside);
        this.movedAside = aside;
        this.found = null;
      }
      writeFileSync(tmp, this.serialize(body, this.lastTool || "exit", savedAt));
      renameSync(tmp, target);
      this.lastBody = body;
      this.savedAt = savedAt;
      this.writes++;
      this.dirtySince = null;
      this.error = null;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* never created */ }
      this.fail(target, e);
    }
  }

  private fail(target: string | null, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.error = msg;
    if (msg !== this.loggedError) {
      this.loggedError = msg;
      this.log(`opentakeoff: auto-save to ${target ?? "(no path)"} failed: ${msg}`);
    }
  }

  /** Wait for any scheduled or running write to finish (tests). */
  async idle(): Promise<void> {
    while (this.timer || this.inflight) {
      if (this.inflight) await this.inflight;
      else await new Promise((r) => setTimeout(r, 10));
    }
  }

  status(): AutosaveStatus {
    if (!this.enabled) return { path: null, saved_at: null, disabled: true };
    return {
      path: this.target,
      saved_at: this.savedAt,
      ...(this.error ? { error: this.error } : {}),
      ...(this.dirtySince !== null || this.inflight ? { pending: true as const } : {}),
      ...(this.movedAside ? { moved_aside: this.movedAside } : {}),
    };
  }
}

/** Wire the exit-time flush for the stdio entry point: a normal exit (stdin
 * closed, the event loop drained) and the usual termination signals all write
 * the last change before the process goes. Returns the uninstaller (tests). */
export function installExitFlush(autosave: Autosave, proc: NodeJS.Process = process): () => void {
  const onExit = () => autosave.flushSync();
  const signals: [NodeJS.Signals, number][] = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
  const handlers = signals.map(([sig, code]) => {
    const h = () => { autosave.flushSync(); proc.exit(code); };
    proc.on(sig, h);
    return [sig, h] as const;
  });
  proc.on("exit", onExit);
  return () => {
    proc.off("exit", onExit);
    for (const [sig, h] of handlers) proc.off(sig, h);
  };
}
