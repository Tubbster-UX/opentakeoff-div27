// Upload → files/ (+ text/). Streams the upload to a temp file, unpacks zips
// entry by entry (nested zips too) under safety limits, keeps every original
// (a different file at a taken path gets " (2)"), classifies each file and
// extracts its text page by page.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { classify, extOf, extractFile, type ExtractLimits } from "./extract.ts";
import { assertProjectId, assertProjectPath, KeyedMutex, projectKey } from "./projects.ts";
import { contentTypeFor } from "./storage.ts";
import type { ExtractedText, Ingest, ProjectFile, ProjectId, ProjectManifest, Projects, Storage, UploadRecord } from "./types.ts";

export interface IngestLimits {
  /** Zip entries examined per upload, all nesting levels together. Default 5000. */
  maxEntries: number;
  /** Largest single file (uncompressed). Default 2 GiB. */
  maxFileBytes: number;
  /** Total uncompressed bytes per upload. Default 10 GiB. */
  maxTotalBytes: number;
  /** Largest uncompressed:compressed ratio for an entry of at least ratioMinBytes. Default 200. */
  maxRatio: number;
  ratioMinBytes: number;
  /** Zip nesting levels unpacked (the upload itself is level 1). Default 3. */
  maxDepth: number;
  /** Skipped entries recorded on the UploadRecord (the rest are summarised). Default 1000. */
  maxSkippedRecorded: number;
  /** Manifest is saved every this many files while unpacking. Default 25. */
  flushEvery: number;
  extract?: Partial<ExtractLimits>;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxEntries: 5000,
  maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: 10 * 1024 ** 3,
  maxRatio: 200,
  ratioMinBytes: 1024 * 1024,
  maxDepth: 3,
  maxSkippedRecorded: 1000,
  flushEvery: 25,
};

/** A manifest file entry with the content hash ingest uses to recognise duplicates (extra JSON field). */
export type StoredFile = ProjectFile & { sha256?: string };

/** Zip-based document formats that must stay whole even though their bytes start with PK. */
const ZIP_DOCUMENT_EXTS = new Set([
  "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "odt", "ods", "odp", "odg",
  "epub", "jar", "apk", "kmz", "dwfx", "xps", "oxps", "3mf", "vsdx", "ipa", "nupkg", "whl",
]);

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", "ehthumbs.db"]);

class LimitStop extends Error {}

interface RunCtx {
  project: ProjectId;
  uploadId: string;
  record: UploadRecord;
  byPath: Map<string, StoredFile>;
  pending: StoredFile[];
  sinceFlush: number;
  entries: number;
  totalBytes: number;
  skippedOverflow: number;
  workDir: string;
}

export interface IngestDeps {
  storage: Storage;
  projects: Projects;
  /** Local scratch directory for downloads and unpacked entries. */
  tmpDir: string;
  limits?: Partial<IngestLimits>;
}

export class StoreIngest implements Ingest {
  private readonly storage: Storage;
  private readonly projects: Projects;
  private readonly tmpDir: string;
  readonly limits: IngestLimits;
  private readonly lock = new KeyedMutex();
  private readonly running = new Map<string, Promise<UploadRecord>>();

  constructor(deps: IngestDeps) {
    this.storage = deps.storage;
    this.projects = deps.projects;
    this.tmpDir = deps.tmpDir;
    this.limits = { ...DEFAULT_INGEST_LIMITS, ...(deps.limits ?? {}) };
  }

  process(project: ProjectId, uploadId: string): Promise<UploadRecord> {
    assertProjectId(project);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(uploadId) || uploadId.includes("..")) return Promise.reject(new Error(`Invalid upload id ${JSON.stringify(uploadId)}`));
    const key = `${project}/${uploadId}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    // One upload at a time per project: path choices and duplicate checks see a settled manifest.
    const p = this.lock.run(project, () => this.run(project, uploadId)).finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private async run(project: ProjectId, uploadId: string): Promise<UploadRecord> {
    const m = await this.projects.get(project);
    if (!m) throw new Error(`Project "${project}" not found`);
    const found = m.uploads.find((u) => u.uploadId === uploadId);
    if (!found) throw new Error(`Upload "${uploadId}" not found in project "${project}"`);
    if (found.status === "done") return found;

    const record: UploadRecord = { ...found, status: "processing", files: [], skipped: [] };
    delete record.error;
    const started = await this.projects.update(project, (mm) => {
      const r = mm.uploads.find((u) => u.uploadId === uploadId);
      if (!r) return;
      r.status = "processing";
      r.files = [];
      r.skipped = [];
      delete r.error;
    });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    const ctx: RunCtx = {
      project,
      uploadId,
      record,
      byPath: indexFiles(started),
      pending: [],
      sinceFlush: 0,
      entries: 0,
      totalBytes: 0,
      skippedOverflow: 0,
      workDir: await fsp.mkdtemp(path.join(this.tmpDir, "ingest-")),
    };
    try {
      const uploadKey = projectKey(project, "uploads", uploadId, record.name);
      const info = await this.storage.head(uploadKey);
      if (!info) throw new Error(`Upload bytes not found in the store (${uploadKey})`);
      const ceiling = Math.max(this.limits.maxFileBytes, this.limits.maxTotalBytes);
      if (info.size > ceiling) throw new Error(`Upload is ${info.size} bytes, more than the ${ceiling}-byte limit`);
      const stream = await this.storage.getStream(uploadKey);
      if (!stream) throw new Error(`Upload bytes not found in the store (${uploadKey})`);
      const local = path.join(ctx.workDir, "upload.bin");
      await pipeline(stream, byteLimit(ceiling, "upload"), createWriteStream(local));

      const zip = (await isZipFile(local, record.name)) ? await openZip(local).catch((err: unknown) => {
        this.skip(ctx, record.name, `could not open as a zip (${errMessage(err)}); kept as one file`);
        return null;
      }) : null;
      if (zip) {
        try {
          await this.unpackZip(ctx, zip, "", record.name, 1);
        } catch (err) {
          if (!(err instanceof LimitStop)) throw err;
        }
      } else {
        await this.addFile(ctx, local, looseName(record.name), record.name, undefined);
      }
      record.status = "done";
    } catch (err) {
      record.status = "error";
      record.error = errMessage(err);
    } finally {
      await fsp.rm(ctx.workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (ctx.skippedOverflow > 0) record.skipped.push({ name: `(${ctx.skippedOverflow} more)`, reason: "further skipped entries not listed" });
    await this.flush(ctx, true);
    return record;
  }

  // ── zips ──────────────────────────────────────────────────────────────────

  /**
   * Unpacks one zip, entry by entry. `prefix` is the project folder its entries
   * go under ("" for the upload itself); `label` names it in skipped/fromArchive.
   */
  private async unpackZip(ctx: RunCtx, zip: yauzl.ZipFile, prefix: string, label: string, depth: number): Promise<void> {
    const L = this.limits;
    let asyncError: Error | null = null;
    zip.on("error", (e: Error) => (asyncError = e));
    try {
      if (zip.entryCount > L.maxEntries * 4) {
        // Far beyond the limit: refuse outright rather than walk a bomb's directory.
        this.skip(ctx, label, `zip has ${zip.entryCount} entries, more than the ${L.maxEntries}-entry limit`);
        return;
      }
      for (;;) {
        const entry = await nextEntry(zip);
        if (asyncError) throw asyncError;
        if (!entry) break;
        const rawName = decodeEntryName(entry);
        const shown = `${label}/${rawName}`;
        if (rawName.endsWith("/")) continue; // directory
        if (++ctx.entries > L.maxEntries) {
          this.skip(ctx, label, `entry limit (${L.maxEntries}) reached; remaining entries not unpacked`);
          throw new LimitStop();
        }
        const safe = safeEntryPath(rawName);
        if ("reason" in safe) {
          this.skip(ctx, shown, safe.reason);
          continue;
        }
        if (isJunk(safe.path)) {
          this.skip(ctx, shown, "junk (OS metadata)");
          continue;
        }
        if (entry.isEncrypted()) {
          this.skip(ctx, shown, "encrypted entry");
          continue;
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          this.skip(ctx, shown, `unsupported compression method ${entry.compressionMethod}`);
          continue;
        }
        const usize = entry.uncompressedSize;
        if (usize === 0) {
          this.skip(ctx, shown, "empty file");
          continue;
        }
        if (usize > L.maxFileBytes) {
          this.skip(ctx, shown, `too large (${usize} bytes; limit ${L.maxFileBytes})`);
          continue;
        }
        if (usize >= L.ratioMinBytes && usize / Math.max(1, entry.compressedSize) > L.maxRatio) {
          this.skip(ctx, shown, `compression ratio ${Math.round(usize / Math.max(1, entry.compressedSize))}:1 exceeds ${L.maxRatio}:1 (zip bomb guard)`);
          continue;
        }
        if (ctx.totalBytes + usize > L.maxTotalBytes) {
          this.skip(ctx, shown, `total uncompressed size limit (${L.maxTotalBytes} bytes) reached; remaining entries not unpacked`);
          throw new LimitStop();
        }

        const tmp = path.join(ctx.workDir, `e-${randomBytes(8).toString("hex")}`);
        try {
          try {
            const rs = await openEntryStream(zip, entry);
            await pipeline(rs, byteLimit(Math.min(usize, L.maxFileBytes), shown), createWriteStream(tmp));
          } catch (err) {
            this.skip(ctx, shown, `unreadable entry: ${errMessage(err)}`);
            continue;
          }
          const { size } = await fsp.stat(tmp);
          ctx.totalBytes += size;
          const target = prefix ? `${prefix}/${safe.path}` : safe.path;
          // A nested zip that will not open is kept as a file.
          const inner = depth < L.maxDepth && (await isZipFile(tmp, safe.path)) ? await openZip(tmp).catch(() => null) : null;
          if (inner) {
            const innerPrefix = target.replace(/\.zip$/i, "") || target;
            try {
              await this.unpackZip(ctx, inner, innerPrefix, shown, depth + 1);
            } catch (err) {
              if (err instanceof LimitStop) throw err;
              this.skip(ctx, shown, `nested zip could not be fully unpacked: ${errMessage(err)}`);
            }
          } else {
            await this.addFile(ctx, tmp, target, shown, label);
          }
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => undefined);
        }
      }
    } finally {
      zip.close();
    }
  }

  // ── one file ──────────────────────────────────────────────────────────────

  private async addFile(ctx: RunCtx, tmp: string, wanted: string, shown: string, fromArchive: string | undefined): Promise<void> {
    const L = this.limits;
    const { size } = await fsp.stat(tmp);
    if (size === 0) return this.skip(ctx, shown, "empty file");
    if (size > L.maxFileBytes) return this.skip(ctx, shown, `too large (${size} bytes; limit ${L.maxFileBytes})`);
    let rel = wanted;
    // "outputs/..." is where tool outputs live in the manifest; keep originals out of it.
    if (rel.split("/")[0] === "outputs") rel = "outputs (original)" + rel.slice("outputs".length);
    try {
      assertProjectPath(rel);
    } catch (err) {
      return this.skip(ctx, shown, `unusable path: ${errMessage(err)}`);
    }
    const sha = await sha256File(tmp);

    let target: string | null = null;
    let alreadyStored = false;
    for (let i = 1; i <= 1000 && !target; i++) {
      const cand = i === 1 ? rel : withSuffix(rel, i);
      if (cand.length > 512) return this.skip(ctx, shown, "path too long");
      const existing = ctx.byPath.get(cand);
      if (existing) {
        if (existing.kind !== "output" && existing.size === size && (await this.fileSha(ctx, existing)) === sha) {
          if (existing.uploadId === ctx.uploadId) {
            // Ingested by an earlier attempt at this same upload: keep it, finish its text if needed.
            if (existing.text === "pending") {
              await this.extractInto(ctx, tmp, existing);
              ctx.pending.push(existing);
            }
            if (!ctx.record.files.includes(cand)) ctx.record.files.push(cand);
            return;
          }
          return this.skip(ctx, shown, `duplicate of ${cand}`);
        }
        continue;
      }
      // Not in the manifest; an object may still be there from an interrupted run.
      const head = await this.storage.head(projectKey(ctx.project, "files", cand));
      if (head) {
        if (head.size === size && (await this.storeSha(projectKey(ctx.project, "files", cand))) === sha) {
          target = cand;
          alreadyStored = true;
        }
        continue;
      }
      target = cand;
    }
    if (!target) return this.skip(ctx, shown, "no free path for this name");

    const contentType = contentTypeFor(target);
    if (!alreadyStored) await this.storage.put(projectKey(ctx.project, "files", target), createReadStream(tmp), { contentType });
    const file: StoredFile = {
      path: target,
      kind: "other",
      size,
      contentType,
      uploadId: ctx.uploadId,
      ...(fromArchive ? { fromArchive } : {}),
      added: new Date().toISOString(),
      text: "pending",
      sha256: sha,
    };
    ctx.byPath.set(target, file);
    await this.extractInto(ctx, tmp, file);
    ctx.record.files.push(target);
    ctx.pending.push(file);
    if (++ctx.sinceFlush >= L.flushEvery) await this.flush(ctx, false);
  }

  /** Extracts text and classifies, filling in `file` (kind, pages, text fields) and writing text/<path>.json. */
  private async extractInto(ctx: RunCtx, tmp: string, file: StoredFile): Promise<void> {
    const res = await extractFile(tmp, file.path, this.limits.extract);
    const first = res.pages[0]?.text ?? "";
    const firstText = first.length < 200 && res.pages[1] ? `${first}\n${res.pages[1].text}` : first;
    file.kind = classify(file.path, { maxPageDimPt: res.maxPageDimPt, firstText });
    if (res.pageCount != null) file.pages = res.pageCount;
    file.text = res.status;
    file.textChars = res.textChars;
    if (res.error) file.textError = res.error;
    else delete file.textError;
    if (res.status === "ok") {
      const doc: ExtractedText = { schema: "brink.text.v1", path: file.path, pages: res.pages };
      try {
        await this.storage.put(projectKey(ctx.project, "text", `${file.path}.json`), JSON.stringify(doc), { contentType: "application/json" });
      } catch (err) {
        file.text = "error";
        file.textError = `could not save extracted text: ${errMessage(err)}`;
        file.textChars = 0;
      }
    }
  }

  private async fileSha(ctx: RunCtx, f: StoredFile): Promise<string> {
    if (!f.sha256) f.sha256 = await this.storeSha(projectKey(ctx.project, "files", f.path));
    return f.sha256;
  }

  private async storeSha(key: string): Promise<string> {
    const s = await this.storage.getStream(key);
    if (!s) return "";
    const h = createHash("sha256");
    await pipeline(s, h);
    return h.digest("hex");
  }

  private skip(ctx: RunCtx, name: string, reason: string): void {
    if (ctx.record.skipped.length >= this.limits.maxSkippedRecorded) {
      ctx.skippedOverflow++;
      return;
    }
    ctx.record.skipped.push({ name: name.length > 600 ? name.slice(0, 600) + "…" : name, reason });
  }

  private async flush(ctx: RunCtx, final: boolean): Promise<void> {
    const pending = ctx.pending.splice(0);
    ctx.sinceFlush = 0;
    const rec = ctx.record;
    const saved = await this.projects.update(ctx.project, (m) => {
      const idx = new Map(m.files.map((f, i) => [f.path, i]));
      for (const f of pending) {
        const i = idx.get(f.path);
        if (i != null) m.files[i] = f;
        else idx.set(f.path, m.files.push(f) - 1);
      }
      const r = m.uploads.find((u) => u.uploadId === ctx.uploadId);
      if (r) {
        r.files = [...rec.files];
        r.skipped = [...rec.skipped];
        if (final) {
          r.status = rec.status;
          if (rec.error) r.error = rec.error;
          else delete r.error;
        }
      }
    });
    if (!final) ctx.byPath = indexFiles(saved);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function indexFiles(m: ProjectManifest): Map<string, StoredFile> {
  return new Map(m.files.map((f) => [f.path, f as StoredFile]));
}

/** "Drawings/E-101.pdf", 2 → "Drawings/E-101 (2).pdf". */
export function withSuffix(p: string, n: number): string {
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${dir}${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${dir}${base} (${n})`;
}

/** A safe relative path for a zip entry, or why it is refused. "./a//b" normalises to "a/b". */
export function safeEntryPath(name: string): { path: string } | { reason: string } {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { reason: "unsafe path (control characters)" };
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return { reason: "unsafe path (absolute)" };
  const segs = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.some((s) => s === "..")) return { reason: "unsafe path (.. traversal)" };
  if (segs.some((s) => /^[a-zA-Z]:$/.test(s) || s.includes("\\"))) return { reason: "unsafe path" };
  if (segs.length === 0) return { reason: "unsafe path (empty name)" };
  const p = segs.map((s) => s.trim() || "_").join("/");
  return { path: p };
}

function isJunk(p: string): boolean {
  const segs = p.split("/");
  if (segs.some((s) => s === "__MACOSX")) return true;
  const base = segs[segs.length - 1].toLowerCase();
  return JUNK_NAMES.has(base) || base.startsWith("._");
}

/** File name for a loose (non-zip) upload: the last path segment, made safe. */
function looseName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "_");
  if (!clean || clean === "." || clean === "..") return `upload${extOf(name) ? "." + extOf(name) : ""}`;
  return clean.slice(-255);
}

async function isZipFile(file: string, name: string): Promise<boolean> {
  if (ZIP_DOCUMENT_EXTS.has(extOf(name))) return false;
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6) || (buf[2] === 7 && buf[3] === 8));
  } finally {
    await fh.close();
  }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

/** Pass-through that fails once more than `max` bytes went through. */
function byteLimit(max: number, what: string): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new Error(`${what} is larger than ${max} bytes`));
      else cb(null, chunk);
    },
  });
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? m.slice(0, 500) + "…" : m;
}

// yauzl, promisified. Strings are decoded here (decodeStrings: false) so a bad
// name skips one entry instead of aborting the whole archive.

type YauzlExtras = typeof yauzl & {
  getFileNameLowLevel(flags: number, raw: Buffer, extraFields: { id: number; data: Buffer }[], strict: boolean): string;
};

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zip) => (err || !zip ? reject(err ?? new Error("cannot open zip")) : resolve(zip))),
  );
}

function decodeEntryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer | string;
  if (typeof raw === "string") return raw.replace(/\\/g, "/");
  // strict=false turns backslashes into "/", so "..\\evil" is caught as ".." traversal.
  return (yauzl as YauzlExtras).getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields as { id: number; data: Buffer }[], false);
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (e: yauzl.Entry) => (cleanup(), resolve(e));
    const onEnd = () => (cleanup(), resolve(null));
    const onError = (err: Error) => (cleanup(), reject(err));
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error("cannot read entry")) : resolve(s))));
}
