// The express app: health, owner login, the upload page and its JSON API,
// downloads, the OAuth authorization server, then the MCP endpoints.
//
// Uploads go phone → store directly: the API starts a multipart upload, hands
// out presigned part URLs, and on completion records the upload in the
// manifest and queues ingest. While an upload is in flight it lives in a
// pending record (memory + system/uploads/<project>/<uploadId>.json, so a
// deploy does not lose it), never in the manifest.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { buildAuth, type Auth, type BuildAuthDeps } from "./auth.ts";
import { FsStorage } from "./storage.ts";
import { bidRoutes, type BidHooks } from "./approval.ts";
import { installRoutes, type InstallHooks } from "./installApproval.ts";
import { mountDtools } from "./dtoolsRoutes.ts";
import type { AppDeps, MountMcp, ProjectManifest, UploadRecord } from "./types.ts";

const MiB = 1024 * 1024;
export const PART_SIZE = 16 * MiB;
export const MAX_PARTS = 10_000;
export const PRESIGN_BATCH = 100;
export const PRESIGN_EXPIRES_SEC = 6 * 3600;
export const DOWNLOAD_EXPIRES_SEC = 3600;

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UPLOAD_ID_RE = /^[a-z0-9]{8,40}$/;

/** Part size for a file: 16 MiB, or the next whole MiB that keeps parts ≤ 10000. */
export function partSizeFor(size: number): number {
  return Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

/**
 * A file name safe as the last segment of a store key: no directories, no
 * control characters, no leading dot, ≤ 180 characters (extension kept).
 * Returns null when nothing usable is left.
 */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  let s = name.normalize("NFC").replace(/\\/g, "/");
  s = s.slice(s.lastIndexOf("/") + 1);
  s = s.replace(/[^\p{L}\p{N} ._\-()[\],&+#'@!~=]/gu, "_").replace(/\s+/g, " ").trim();
  s = s.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  if (!s || /^_+$/.test(s)) return null;
  if (s.length > 180) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, 180 - ext.length).trimEnd() + ext;
  }
  return s;
}

function newUploadId(): string {
  return Date.now().toString(36) + crypto.randomBytes(8).toString("hex");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string, code = "bad_request") => new HttpError(400, code, message);
const notFound = (message: string) => new HttpError(404, "not_found", message);

interface PendingUpload {
  schema: "brink.pending-upload.v1";
  project: string;
  uploadId: string;
  name: string;
  size: number;
  contentType: string;
  key: string;
  multipartId: string;
  partSize: number;
  partCount: number;
  created: string;
}

// ── ingest queue ────────────────────────────────────────────────────────────

/** In-process FIFO: one ingest at a time, survives errors, dedupes. */
export class IngestQueue {
  private q: { project: string; uploadId: string }[] = [];
  private running: Promise<void> | null = null;
  private current: string | null = null;
  private stopped = false;
  constructor(private deps: Pick<AppDeps, "ingest" | "projects">) {}

  enqueue(project: string, uploadId: string): void {
    if (this.stopped) return;
    const id = `${project}/${uploadId}`;
    if (this.current === id || this.q.some((j) => `${j.project}/${j.uploadId}` === id)) return;
    this.q.push({ project, uploadId });
    if (!this.running) this.running = this.drain();
  }

  get length(): number {
    return this.q.length + (this.current ? 1 : 0);
  }

  private async drain(): Promise<void> {
    while (this.q.length && !this.stopped) {
      const job = this.q.shift()!;
      this.current = `${job.project}/${job.uploadId}`;
      const t0 = Date.now();
      try {
        console.error(`brink-server ingest: start ${this.current}`);
        const rec = await this.deps.ingest.process(job.project, job.uploadId);
        console.error(`brink-server ingest: ${this.current} ${rec.status} (${rec.files.length} files, ${rec.skipped.length} skipped) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`brink-server ingest: ${this.current} failed:`, e);
        try {
          await this.deps.projects.update(job.project, (m) => {
            const u = m.uploads.find((x) => x.uploadId === job.uploadId);
            if (u && (u.status === "received" || u.status === "processing")) {
              u.status = "error";
              u.error = msg.slice(0, 500);
            }
          });
        } catch (e2) {
          console.error("brink-server ingest: could not record the error", e2);
        }
      } finally {
        this.current = null;
      }
    }
    this.running = null;
  }

  /** Resolves when the queue is empty (or after `timeoutMs`). */
  async idle(timeoutMs = Infinity): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.running && Date.now() < until) {
      await Promise.race([this.running, new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, until - Date.now()))))]);
    }
  }

  /** Stop taking jobs; wait up to `timeoutMs` for the running one. Unprocessed uploads stay "received" and are re-queued at the next start. */
  async stop(timeoutMs: number): Promise<void> {
    this.stopped = true;
    this.q = [];
    await this.idle(timeoutMs);
  }
}

// ── app ─────────────────────────────────────────────────────────────────────

export interface BuildAppOptions {
  /** Passed through to buildAuth (tests shorten limits, disable timers). */
  auth?: Omit<BuildAuthDeps, "config" | "storage">;
  /** Re-queue uploads left "received"/"processing" at startup (default true). */
  resumeIngest?: boolean;
  /** What happens after the owner approves a bid (re-render the final documents). */
  bidHooks?: BidHooks;
  /** What happens after the owner approves an install design (re-render the package for construction). */
  installHooks?: InstallHooks;
}

/** fsstore:// links (local store) are served by the app itself at /_local-store. */
function localStoreUrl(u: string): string {
  return u.startsWith("fsstore://") ? `/_local-store?u=${encodeURIComponent(u)}` : u;
}
function forBrowser<T extends { url: string }>(parts: T[]): T[] {
  return parts.map((p) => ({ ...p, url: localStoreUrl(p.url) }));
}

export function buildApp(
  deps: AppDeps,
  mountMcp: MountMcp,
  opts: BuildAppOptions = {},
): { app: express.Express; close(): Promise<void>; auth: Auth; queue: IngestQueue } {
  const { config, storage, projects } = deps;
  const publicUrl = config.publicUrl.replace(/\/$/, "");
  const secure = publicUrl.startsWith("https://");
  const auth = buildAuth({ config, storage, ...opts.auth });
  const queue = new IngestQueue(deps);
  const pending = new Map<string, PendingUpload>();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("etag", false);

  const connectSrc = ["'self'"];
  if (config.storage.kind === "r2") {
    connectSrc.push(`https://${config.storage.accountId}.r2.cloudflarestorage.com`, "https://*.r2.cloudflarestorage.com");
  }
  const appCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // "same-origin", not "no-referrer": with no-referrer browsers send `Origin: null` on
    // form POSTs, which the login/consent origin check would refuse.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), screen-wake-lock=(self)");
    res.setHeader("Content-Security-Policy", appCsp);
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/") || req.path === "/api") res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ── public ──
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: VERSION, storage: storage.label });
  });

  app.get("/app.css", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.sendFile("app.css", { root: PUBLIC_DIR });
  });

  // Login, logout, OAuth endpoints and their well-known metadata.
  app.use(auth.router);

  // MCP endpoints (bearer-guarded inside).
  const mcp = mountMcp(app, deps, auth.guard);

  // ── JSON API (owner) ──
  const api = express.Router();
  api.use(auth.requireOwner, auth.csrf, express.json({ limit: "2mb" }));

  const projectId = (req: Request): string => {
    const id = String(req.params.id ?? "");
    if (!PROJECT_ID_RE.test(id)) throw notFound("No such project.");
    return id;
  };
  const uploadIdOf = (req: Request): string => {
    const id = String(req.params.uploadId ?? "");
    if (!UPLOAD_ID_RE.test(id)) throw notFound("No such upload.");
    return id;
  };
  const mustGet = async (id: string): Promise<ProjectManifest> => {
    const m = await projects.get(id);
    if (!m) throw notFound("No such project.");
    return m;
  };

  const pendingKey = (project: string, uploadId: string) => `system/uploads/${project}/${uploadId}.json`;
  const loadedPendingProjects = new Set<string>();

  async function getPending(project: string, uploadId: string): Promise<PendingUpload | null> {
    const mem = pending.get(`${project}/${uploadId}`);
    if (mem) return mem;
    const bytes = await storage.getBytes(pendingKey(project, uploadId));
    if (!bytes) return null;
    try {
      const p = JSON.parse(Buffer.from(bytes).toString("utf8")) as PendingUpload;
      if (p.project !== project || p.uploadId !== uploadId) return null;
      pending.set(`${project}/${uploadId}`, p);
      return p;
    } catch {
      return null;
    }
  }

  async function listPending(project: string): Promise<PendingUpload[]> {
    if (!loadedPendingProjects.has(project)) {
      loadedPendingProjects.add(project);
      for (const o of await storage.list(`system/uploads/${project}/`)) {
        const m = /\/([a-z0-9]{8,40})\.json$/.exec(o.key);
        if (m) await getPending(project, m[1]);
      }
    }
    return [...pending.values()].filter((p) => p.project === project);
  }

  async function dropPending(p: PendingUpload): Promise<void> {
    pending.delete(`${p.project}/${p.uploadId}`);
    await storage.delete(pendingKey(p.project, p.uploadId));
  }

  const pendingView = (p: PendingUpload) => ({
    uploadId: p.uploadId,
    name: p.name,
    size: p.size,
    status: "uploading" as const,
    added: p.created,
    partSize: p.partSize,
    partCount: p.partCount,
  });

  const summary = (m: ProjectManifest) => ({
    id: m.id,
    name: m.name,
    notes: m.notes,
    created: m.created,
    updated: m.updated,
    files: m.files.filter((f) => f.kind !== "output").length,
    outputs: m.files.filter((f) => f.kind === "output").length,
    uploads: m.uploads.length,
    processing: m.uploads.filter((u) => u.status === "received" || u.status === "processing").length,
  });

  const str = (v: unknown, field: string, max: number, required: boolean): string | undefined => {
    if (v === undefined || v === null) {
      if (required) throw bad(`${field} is required.`);
      return undefined;
    }
    if (typeof v !== "string") throw bad(`${field} must be text.`);
    const s = v.trim();
    if (required && !s) throw bad(`${field} is required.`);
    if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw bad(`${field} contains control characters.`);
    return s;
  };

  api.get("/projects", async (_req, res) => {
    const list = await projects.list();
    list.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    res.json({ projects: list.map(summary) });
  });

  api.post("/projects", async (req, res) => {
    const name = str(req.body?.name, "name", 200, true)!;
    const notes = str(req.body?.notes, "notes", 20_000, false) ?? "";
    if (!/[a-z0-9]/i.test(name)) throw bad("name needs at least one letter or digit.");
    try {
      const m = await projects.create({ name, notes });
      res.status(201).json(m);
    } catch (e) {
      if (e instanceof Error && /exist/i.test(e.message)) throw new HttpError(409, "exists", "A project with that name already exists.");
      throw e;
    }
  });

  api.get("/projects/:id", async (req, res) => {
    const id = projectId(req);
    const m = await mustGet(id);
    res.json({ ...m, pendingUploads: (await listPending(id)).map(pendingView) });
  });

  api.patch("/projects/:id", async (req, res) => {
    const id = projectId(req);
    const name = str(req.body?.name, "name", 200, false);
    const notes = str(req.body?.notes, "notes", 20_000, false);
    if (name !== undefined && !name) throw bad("name cannot be empty.");
    await mustGet(id);
    const m = await projects.update(id, (m) => {
      if (name !== undefined) m.name = name;
      if (notes !== undefined) m.notes = notes;
      m.updated = new Date().toISOString();
    });
    res.json(m);
  });

  api.post("/projects/:id/uploads", async (req, res) => {
    const id = projectId(req);
    await mustGet(id);
    const name = safeFileName(req.body?.name);
    if (!name) throw bad("That file name cannot be used.");
    const size = req.body?.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw bad("size must be a whole number of bytes (empty files are not accepted).");
    if (size > config.maxUploadBytes) {
      throw new HttpError(413, "too_large", `That file is ${fmtBytes(size)}; the limit is ${fmtBytes(config.maxUploadBytes)}.`);
    }
    let contentType = typeof req.body?.contentType === "string" ? req.body.contentType.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(contentType)) contentType = "application/octet-stream";
    const uploadId = newUploadId();
    const partSize = partSizeFor(size);
    const partCount = Math.max(1, Math.ceil(size / partSize));
    const key = `projects/${id}/uploads/${uploadId}/${name}`;
    const { uploadId: multipartId } = await storage.createMultipart(key, contentType);
    const p: PendingUpload = {
      schema: "brink.pending-upload.v1",
      project: id,
      uploadId,
      name,
      size,
      contentType,
      key,
      multipartId,
      partSize,
      partCount,
      created: new Date().toISOString(),
    };
    await storage.put(pendingKey(id, uploadId), JSON.stringify(p), { contentType: "application/json" });
    pending.set(`${id}/${uploadId}`, p);
    const first = Array.from({ length: Math.min(partCount, PRESIGN_BATCH) }, (_, i) => i + 1);
    const parts = forBrowser(await storage.presignParts(key, multipartId, first, PRESIGN_EXPIRES_SEC));
    res.status(201).json({ uploadId, name, partSize, partCount, parts, expiresInSec: PRESIGN_EXPIRES_SEC });
  });

  api.post("/projects/:id/uploads/:uploadId/parts", async (req, res) => {
    const id = projectId(req);
    const uploadId = uploadIdOf(req);
    const p = await getPending(id, uploadId);
    if (!p) throw notFound("No upload in progress with that id (it finished, was cancelled, or never started).");
    const nums = req.body?.partNumbers;
    if (!Array.isArray(nums) || nums.length < 1 || nums.length > PRESIGN_BATCH) throw bad(`partNumbers must list 1-${PRESIGN_BATCH} part numbers.`);
    const seen = new Set<number>();
    for (const n of nums) {
      if (!Number.isInteger(n) || n < 1 || n > p.partCount) throw bad(`part ${String(n)} is out of range (1-${p.partCount}).`);
      if (seen.has(n)) throw bad(`part ${n} is listed twice.`);
      seen.add(n);
    }
    const parts = forBrowser(await storage.presignParts(p.key, p.multipartId, [...seen], PRESIGN_EXPIRES_SEC));
    res.json({ parts, expiresInSec: PRESIGN_EXPIRES_SEC });
  });

  api.post("/projects/:id/uploads/:uploadId/complete", async (req, res) => {
    const id = projectId(req);
    const uploadId = uploadIdOf(req);
    const p = await getPending(id, uploadId);
    if (!p) {
      // Completing twice (a retried request) returns the recorded upload.
      const m = await mustGet(id);
      const rec = m.uploads.find((u) => u.uploadId === uploadId);
      if (rec) return void res.json(rec);
      throw notFound("No upload in progress with that id.");
    }
    const list = req.body?.parts;
    if (!Array.isArray(list) || list.length !== p.partCount) throw bad(`parts must list all ${p.partCount} parts with their ETags.`);
    const byNum = new Map<number, string>();
    for (const item of list) {
      const n = item?.partNumber;
      const etag = item?.etag;
      if (!Number.isInteger(n) || n < 1 || n > p.partCount) throw bad(`part ${String(n)} is out of range (1-${p.partCount}).`);
      if (typeof etag !== "string" || !/^[\x21-\x7e]{1,200}$/.test(etag)) throw bad(`part ${n} needs the ETag the store returned.`);
      if (byNum.has(n)) throw bad(`part ${n} is listed twice.`);
      byNum.set(n, etag);
    }
    const parts = [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag }));
    try {
      await storage.completeMultipart(p.key, p.multipartId, parts);
    } catch (e) {
      console.error(`brink-server upload: complete failed for ${id}/${uploadId}`, e);
      throw new HttpError(502, "complete_failed", "The store refused to assemble the upload (a part may be missing or its ETag wrong). Resume the upload to resend the missing parts.");
    }
    // A presigned PUT cannot cap a part's length, so check the assembled size.
    const info = await storage.head(p.key);
    if (!info || info.size !== p.size) {
      await storage.delete(p.key).catch(() => undefined);
      await dropPending(p);
      throw bad(`The assembled file is ${info ? fmtBytes(info.size) : "missing"}, expected ${fmtBytes(p.size)}. Upload it again.`, "size_mismatch");
    }
    const rec: UploadRecord = {
      uploadId,
      name: p.name,
      size: p.size,
      status: "received",
      added: new Date().toISOString(),
      files: [],
      skipped: [],
    };
    await projects.update(id, (m) => {
      if (!m.uploads.some((u) => u.uploadId === uploadId)) m.uploads.push(rec);
      m.updated = rec.added;
    });
    await dropPending(p);
    queue.enqueue(id, uploadId);
    console.error(`brink-server upload: ${id}/${uploadId} received (${p.name}, ${fmtBytes(p.size)})`);
    res.json(rec);
  });

  api.post("/projects/:id/uploads/:uploadId/abort", async (req, res) => {
    const id = projectId(req);
    const uploadId = uploadIdOf(req);
    const p = await getPending(id, uploadId);
    if (!p) throw notFound("No upload in progress with that id.");
    try {
      await storage.abortMultipart(p.key, p.multipartId);
    } catch (e) {
      console.error(`brink-server upload: abort failed for ${id}/${uploadId} (dropping it anyway)`, e);
    }
    await dropPending(p);
    res.json({ ok: true });
  });

  api.get("/projects/:id/uploads/:uploadId", async (req, res) => {
    const id = projectId(req);
    const uploadId = uploadIdOf(req);
    const m = await mustGet(id);
    const rec = m.uploads.find((u) => u.uploadId === uploadId);
    if (rec) return void res.json(rec);
    const p = await getPending(id, uploadId);
    if (p) return void res.json(pendingView(p));
    throw notFound("No such upload.");
  });

  api.get("/projects/:id/download", async (req, res) => {
    const id = projectId(req);
    const m = await mustGet(id);
    let key: string | null = null;
    let filename = "";
    if (typeof req.query.upload === "string") {
      const u = m.uploads.find((x) => x.uploadId === req.query.upload);
      if (u) {
        key = `projects/${id}/uploads/${u.uploadId}/${u.name}`;
        filename = u.name;
      }
    } else if (typeof req.query.path === "string") {
      const want = req.query.path;
      const f = m.files.find((x) => x.path === want);
      if (f) {
        if (f.kind === "output") key = f.path.startsWith("outputs/") ? `projects/${id}/${f.path}` : `projects/${id}/outputs/${f.path}`;
        else key = `projects/${id}/files/${f.path}`;
        filename = f.path.slice(f.path.lastIndexOf("/") + 1);
      }
    }
    if (!key) throw notFound("That file is not in this project.");
    const url = localStoreUrl(await storage.presignGet(key, DOWNLOAD_EXPIRES_SEC, { filename }));
    res.redirect(302, url);
  });

  // The owner's bid review and approval (owner cookie + CSRF, like the rest of /api).
  api.use(bidRoutes(deps, opts.bidHooks));
  // The install phase: start it, review the install design, approve it for construction.
  api.use(installRoutes(deps, opts.installHooks));
  // D-Tools Cloud: owner routes (pending price changes, status) on /api, and the
  // webhook D-Tools calls at /webhooks/dtools (its own Bearer token, not the owner cookie).
  const dtools = mountDtools(app, api, deps);

  api.use((_req, _res, next) => next(notFound("No such API route.")));
  app.use("/api", api);

  // Local file store (STORE_DIR, for local runs and tests): the browser cannot
  // PUT to an fsstore:// URL, so the server stands in for R2 at /_local-store,
  // owner-only and same-origin. With R2 these routes are never mounted.
  if (storage instanceof FsStorage) {
    const fs = storage;
    const parse = (u: unknown) => {
      if (typeof u !== "string") throw bad("missing u");
      const at = FsStorage.parsePresignedUrl(u);
      if (!(at.expires > Date.now() / 1000)) throw bad("This link has expired.");
      return at;
    };
    app.put("/_local-store", auth.requireOwner, express.raw({ type: () => true, limit: "200mb" }), async (req, res, next) => {
      try {
        if (req.get("origin") !== publicUrl) throw new HttpError(403, "cross_origin", "cross-origin request refused");
        const at = parse(req.query.u);
        if (!at.uploadId || !at.partNumber) throw bad("not a part upload link");
        const { etag } = await fs.putPart(at.key, at.uploadId, at.partNumber, new Uint8Array(req.body as Buffer));
        res.set("ETag", etag).set("Access-Control-Expose-Headers", "ETag").status(200).end();
      } catch (e) { next(e); }
    });
    app.get("/_local-store", auth.requireOwner, async (req, res, next) => {
      try {
        const at = parse(req.query.u);
        const stream = await fs.getStream(at.key);
        if (!stream) throw notFound("That file is not in the store.");
        if (at.disposition) res.set("Content-Disposition", at.disposition);
        res.set("Cache-Control", "no-store");
        stream.pipe(res);
      } catch (e) { next(e); }
    });
  }

  // ── pages (owner) ──
  app.use(auth.requireOwner);
  app.use(
    express.static(PUBLIC_DIR, {
      index: "index.html",
      dotfiles: "ignore",
      etag: true,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );
  app.use((_req, res) => {
    res.status(404).type("text").send("Not found");
  });

  // ── errors ──
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let code = "server_error";
    let message = "Something went wrong on the server. Try again; if it keeps happening, check the server log.";
    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.parse.failed") {
      status = 400;
      code = "bad_json";
      message = "The request body is not valid JSON.";
    } else if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large") {
      status = 413;
      code = "too_large";
      message = "The request body is too large.";
    } else {
      console.error(`brink-server: ${req.method} ${req.path} failed`, err);
    }
    if (res.headersSent) return;
    if (req.path.startsWith("/api/")) res.status(status).json({ error: code, message });
    else res.status(status).type("text").send(message);
  });

  // Re-queue uploads a restart interrupted (ingest is idempotent).
  if (opts.resumeIngest !== false) {
    void (async () => {
      try {
        for (const m of await projects.list()) {
          for (const u of m.uploads) if (u.status === "received" || u.status === "processing") queue.enqueue(m.id, u.uploadId);
        }
      } catch (e) {
        console.error("brink-server: could not re-queue unfinished ingests", e);
      }
    })();
  }

  return {
    app,
    auth,
    queue,
    async close() {
      auth.close();
      await Promise.allSettled([mcp.close(), queue.stop(20_000), dtools.webhook.idle()]);
    },
  };
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} bytes`;
}
