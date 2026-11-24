// Shared contracts for brink-server. Every module codes against these; the
// implementations live in their own files (see docs/design/HOSTED_SERVER.md
// for who owns what).
//
// Layout in the object store (Cloudflare R2 in production, a directory in
// tests and local runs). <project> is a ProjectId:
//
//   projects/<project>/project.json          ProjectManifest
//   projects/<project>/uploads/<uploadId>/<name>   raw uploads (zips, loose files), kept
//   projects/<project>/files/<path>          unpacked originals (never overwritten)
//   projects/<project>/text/<path>.json      ExtractedText for one file
//   projects/<project>/outputs/<path>        what the tools wrote (marked set, report, autosave, ...)
//   system/...                               server state (OAuth clients, tokens)

import type { Readable } from "node:stream";

// ── object store ────────────────────────────────────────────────────────────

export interface ObjectInfo {
  key: string;
  size: number;
  /** ISO time. */
  modified: string;
  etag?: string;
  contentType?: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface Storage {
  /** Human label for logs and /api/health, e.g. "r2:brink-plans" or "fs:/data/store". */
  readonly label: string;
  put(key: string, body: Uint8Array | string | Readable, opts?: { contentType?: string }): Promise<void>;
  /** Whole object, or null when it does not exist. For small objects (manifests, text). */
  getBytes(key: string): Promise<Uint8Array | null>;
  /** Streamed object, or null when it does not exist. For large objects (plan PDFs, zips). */
  getStream(key: string): Promise<Readable | null>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Every object under the prefix (follows continuation for you). */
  list(prefix: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
  /** A URL anyone holding it can GET for `expiresSec` seconds (downloads to the phone). */
  presignGet(key: string, expiresSec: number, opts?: { filename?: string }): Promise<string>;
  // Browser-direct multipart upload (phone → store, the server never carries the bytes).
  createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }>;
  presignParts(key: string, uploadId: string, partNumbers: number[], expiresSec: number): Promise<PresignedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

// ── projects ────────────────────────────────────────────────────────────────

/** Lowercase slug: [a-z0-9][a-z0-9-]{0,62}. */
export type ProjectId = string;

/**
 * plan:   a drawing PDF (plan sheets)          spec: a specification / project-manual PDF
 * sow:    statement of work / solicitation     form: SF 1449 / SF 30 / wage determination / reps & certs
 * doc:    other PDF / Word / text              sheet: Excel / CSV
 * image:  jpg / png / tif                      other: anything else (kept, not read)
 * output: written by the tools (marked set, report, estimate, proposal, autosave)
 */
export type FileKind = "plan" | "spec" | "sow" | "form" | "doc" | "sheet" | "image" | "other" | "output";

export interface ProjectFile {
  /** Path inside the project, POSIX, no leading slash, e.g. "Drawings/E-101.pdf". Unique per project. */
  path: string;
  kind: FileKind;
  size: number;
  /** "application/pdf", ... */
  contentType: string;
  /** Pages for PDFs. */
  pages?: number;
  /** The upload this came from (absent for outputs). */
  uploadId?: string;
  /** For a file that came out of a zip: the zip's own name. */
  fromArchive?: string;
  added: string;
  /** "ok" text extracted; "none" no text layer (scanned) or not a text format; "pending"; "error". */
  text: "ok" | "none" | "pending" | "error";
  textError?: string;
  /** Characters of extracted text (0 when none). */
  textChars?: number;
  /** Hex sha256 of the bytes (duplicate detection, unchanged-output skips). */
  sha256?: string;
}

export interface UploadRecord {
  uploadId: string;
  /** The name the phone gave it. */
  name: string;
  size: number;
  /** received: in the store, not unpacked yet; processing; done; error */
  status: "received" | "processing" | "done" | "error";
  error?: string;
  added: string;
  /** Paths of the ProjectFiles it produced. */
  files: string[];
  /** Entries skipped and why (junk, unsafe path, duplicate, too large). */
  skipped: { name: string; reason: string }[];
}

export interface ProjectManifest {
  schema: "brink.project.v1";
  id: ProjectId;
  name: string;
  /** Free text the owner or Claude keeps: solicitation number, due date, owner, notes. */
  notes: string;
  created: string;
  updated: string;
  files: ProjectFile[];
  uploads: UploadRecord[];
  /** Where the job stands; absent means "bid". Only the owner changes it (the phone page). */
  phase?: "bid" | "install" | "closeout";
  /** Links to D-Tools Cloud records (src/dtools/store.ts); absent until linked. */
  dtools?: { clientId?: string; opportunityId?: string; projectId?: string; quoteId?: string; linkedAt: string; lastSync?: string };
}

/** Text of one file, page by page (one "page" for non-paged formats; one per sheet for Excel). */
export interface ExtractedText {
  schema: "brink.text.v1";
  path: string;
  pages: { n: number; text: string; label?: string }[];
}

export interface SearchHit {
  path: string;
  kind: FileKind;
  page: number;
  /** ~240 chars around the match, whitespace collapsed. */
  snippet: string;
}

export interface Projects {
  list(): Promise<ProjectManifest[]>;
  get(id: ProjectId): Promise<ProjectManifest | null>;
  /** Slugifies `name` into the id unless `id` is given; throws if the id exists. */
  create(input: { name: string; id?: string; notes?: string }): Promise<ProjectManifest>;
  /** Read-modify-write under a per-project lock; returns the saved manifest. */
  update(id: ProjectId, fn: (m: ProjectManifest) => void | Promise<void>): Promise<ProjectManifest>;
}

// ── ingest / search / workspace ─────────────────────────────────────────────

export interface Ingest {
  /**
   * Unpack and index one upload already in the store at
   * projects/<project>/uploads/<uploadId>/<name>: zips (nested zips too) are
   * unpacked into files/, loose files are copied there, every file is
   * classified and its text extracted to text/. Updates the manifest's
   * UploadRecord as it goes. Safe to call again for the same upload (idempotent).
   */
  process(project: ProjectId, uploadId: string): Promise<UploadRecord>;
}

export interface Search {
  /** Case-insensitive; every word must appear on the page. */
  search(project: ProjectId, query: string, opts?: { kinds?: FileKind[]; path?: string; limit?: number }): Promise<SearchHit[]>;
  /** Text of a page range of one file; null when the file has no text. */
  read(project: ProjectId, path: string, opts?: { fromPage?: number; toPage?: number; maxChars?: number }): Promise<{ text: string; pages: number; truncated: boolean } | null>;
}

export interface Workspace {
  /** Local directory mirroring the project (files/ and outputs/ under it). */
  dir(project: ProjectId): string;
  /** Download (if missing or stale) one project file to the local mirror; returns its absolute local path. */
  ensureFile(project: ProjectId, path: string): Promise<string>;
  /** Directory the tools write into for this project (absolute). */
  outputsDir(project: ProjectId): string;
  /**
   * Push every file under dir(project) that is not an unchanged original — what
   * the tools wrote, wherever they wrote it (exports default to "next to the
   * plan", i.e. inside files/) — to projects/<project>/outputs/<path relative to
   * files/ or outputs/>, and record it in the manifest as kind "output". Only
   * new or changed files are pushed. Returns the project paths it pushed.
   */
  syncOutputs(project: ProjectId): Promise<string[]>;
}

// ── config ──────────────────────────────────────────────────────────────────

export interface Config {
  /** Public base URL, no trailing slash, e.g. "https://brink.example.com". */
  publicUrl: string;
  port: number;
  /** Local disk for the workspace mirror and temp files. */
  dataDir: string;
  storage:
    | { kind: "r2"; accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }
    | { kind: "fs"; root: string };
  /** scrypt hash "scrypt$N$r$p$saltB64$hashB64" of the owner password (scripts/hash-password.ts). */
  ownerPasswordHash: string;
  /** 32+ random bytes, base64: signs session cookies. */
  sessionSecret: string;
  /** Brink parts/schematic tools: Postgres URL; absent → PGlite in dataDir. */
  databaseUrl?: string;
  /** Largest single uploaded file accepted (bytes). */
  maxUploadBytes: number;
}

// ── wiring ──────────────────────────────────────────────────────────────────

export interface AppDeps {
  config: Config;
  storage: Storage;
  projects: Projects;
  ingest: Ingest;
  search: Search;
  workspace: Workspace;
}

/**
 * Mounts the MCP endpoints on the express app (src/mcp.ts): POST/GET/DELETE
 * /mcp (OpenTakeoff takeoff tools + project/document tools) and /mcp/brink
 * (Brink parts list / schematic tools). `guard` is the OAuth bearer middleware
 * from src/auth.ts; every MCP route sits behind it.
 */
export type MountMcp = (app: import("express").Express, deps: AppDeps, guard: import("express").RequestHandler) => { close(): Promise<void> };
