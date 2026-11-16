// Object storage: FsStorage (a directory; tests and local runs) and R2Storage
// (Cloudflare R2 over the S3 API, SigV4 via aws4fetch). Both implement the
// Storage contract in types.ts the same way: POSIX keys, atomic writes, full
// listing under a prefix, presigned GET and browser-direct multipart upload.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";
import type { Config, ObjectInfo, PresignedPart, Storage } from "./types.ts";

// ── keys ────────────────────────────────────────────────────────────────────

const MAX_KEY_LENGTH = 1024;

/** Throws unless `key` is a safe relative POSIX key (no "..", ".", empty segments, backslashes or control chars). */
export function assertKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new Error("Storage key is empty");
  if (key.length > MAX_KEY_LENGTH) throw new Error(`Storage key is longer than ${MAX_KEY_LENGTH} characters`);
  if (key.startsWith("/")) throw new Error(`Storage key must be relative: ${JSON.stringify(key)}`);
  if (key.includes("\\")) throw new Error(`Storage key contains a backslash: ${JSON.stringify(key)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error(`Storage key contains a control character: ${JSON.stringify(key)}`);
  for (const seg of key.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`Storage key has an empty, "." or ".." segment: ${JSON.stringify(key)}`);
  }
  return key;
}

// ── content types ───────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  dxf: "image/vnd.dxf",
  dwg: "image/vnd.dwg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  svg: "image/svg+xml",
};

/** Content type from a file name's extension ("application/octet-stream" when unknown). */
export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** RFC 6266 / 5987 Content-Disposition for a download with this file name. */
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
  const base = filename.split(/[\\/]/).pop() || "download";
  // eslint-disable-next-line no-control-regex
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(base).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── FsStorage ───────────────────────────────────────────────────────────────

/** Reserved directory under the root for temp files and multipart staging; never listed, never a key. */
const FS_RESERVED = ".fsstore";

interface FsMultipartMeta {
  key: string;
  contentType?: string;
  created: string;
}

/**
 * The store as a directory tree: key "a/b/c.pdf" is <root>/a/b/c.pdf. Writes go
 * to a temp file and are renamed into place. Presigned URLs use the scheme
 * `fsstore://<key>?...` (nothing serves them; tests use putPart to play the browser).
 */
export class FsStorage implements Storage {
  readonly label: string;
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.label = `fs:${this.root}`;
  }

  private file(key: string): string {
    assertKey(key);
    if (key.split("/")[0] === FS_RESERVED) throw new Error(`Storage key uses the reserved ${FS_RESERVED}/ prefix`);
    const abs = path.resolve(this.root, ...key.split("/"));
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`Storage key escapes the store: ${JSON.stringify(key)}`);
    return abs;
  }

  private async tempFile(): Promise<string> {
    const dir = path.join(this.root, FS_RESERVED, "tmp");
    await fsp.mkdir(dir, { recursive: true });
    return path.join(dir, `${Date.now()}-${randomBytes(8).toString("hex")}.tmp`);
  }

  private async writeAtomic(abs: string, body: Uint8Array | string | Readable): Promise<void> {
    const tmp = await this.tempFile();
    try {
      if (body instanceof Readable) {
        await pipeline(body, createWriteStream(tmp, { flags: "wx" }));
      } else {
        await fsp.writeFile(tmp, body, { flag: "wx" });
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async put(key: string, body: Uint8Array | string | Readable, _opts?: { contentType?: string }): Promise<void> {
    await this.writeAtomic(this.file(key), body);
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fsp.readFile(this.file(key)));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    const abs = this.file(key);
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return createReadStream(abs);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const st = await fsp.stat(this.file(key));
      if (!st.isFile()) return null;
      return { key, size: st.size, modified: st.mtime.toISOString(), etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, contentType: contentTypeFor(key) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    // Walk the deepest directory the prefix names, then filter by string prefix (S3 semantics).
    const slash = prefix.lastIndexOf("/");
    const dirPart = slash >= 0 ? prefix.slice(0, slash) : "";
    let start = this.root;
    if (dirPart) {
      try {
        start = this.file(dirPart);
      } catch {
        return [];
      }
    }
    const out: ObjectInfo[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch (err) {
        if (isNotFound(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
        throw err;
      }
      for (const e of entries) {
        if (!rel && e.name === FS_RESERVED) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(abs, e.name);
        if (e.isDirectory()) {
          // Only descend where keys could still match the prefix.
          if (childRel.startsWith(prefix) || prefix.startsWith(childRel + "/")) await walk(childAbs, childRel);
        } else if (e.isFile() && childRel.startsWith(prefix)) {
          const st = await fsp.stat(childAbs);
          out.push({ key: childRel, size: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    await walk(start, dirPart);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  async delete(key: string): Promise<void> {
    const abs = this.file(key);
    await fsp.rm(abs, { force: true });
    // Prune now-empty parent directories (up to, not including, the root).
    let dir = path.dirname(abs);
    while (dir.startsWith(this.root + path.sep)) {
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  async presignGet(key: string, expiresSec: number, opts?: { filename?: string }): Promise<string> {
    this.file(key);
    const q = new URLSearchParams({ expires: String(Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSec))) });
    if (opts?.filename) q.set("response-content-disposition", contentDisposition(opts.filename));
    return `fsstore://${encodeKeyPath(key)}?${q.toString()}`;
  }

  /** Parses a URL from presignGet / presignParts back into its parts. */
  static parsePresignedUrl(url: string): { key: string; expires: number; uploadId?: string; partNumber?: number; disposition?: string } {
    if (!url.startsWith("fsstore://")) throw new Error("Not an fsstore:// URL");
    const rest = url.slice("fsstore://".length);
    const q = rest.indexOf("?");
    const key = decodeURIComponent(q >= 0 ? rest.slice(0, q) : rest);
    const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
    const partNumber = params.get("partNumber");
    return {
      key: assertKey(key),
      expires: Number(params.get("expires") ?? 0),
      uploadId: params.get("uploadId") ?? undefined,
      partNumber: partNumber == null ? undefined : Number(partNumber),
      disposition: params.get("response-content-disposition") ?? undefined,
    };
  }

  private multipartDir(uploadId: string): string {
    if (!/^[a-f0-9]{32}$/.test(uploadId)) throw new Error("Unknown multipart upload");
    return path.join(this.root, FS_RESERVED, "multipart", uploadId);
  }

  private async multipartMeta(key: string, uploadId: string): Promise<FsMultipartMeta> {
    let meta: FsMultipartMeta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(this.multipartDir(uploadId), "meta.json"), "utf8")) as FsMultipartMeta;
    } catch (err) {
      if (isNotFound(err)) throw new Error("Unknown multipart upload");
      throw err;
    }
    if (meta.key !== key) throw new Error("Multipart upload belongs to a different key");
    return meta;
  }

  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    this.file(key);
    const uploadId = randomBytes(16).toString("hex");
    const dir = this.multipartDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });
    const meta: FsMultipartMeta = { key, contentType, created: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
    return { uploadId };
  }

  async presignParts(key: string, uploadId: string, partNumbers: number[], expiresSec: number): Promise<PresignedPart[]> {
    await this.multipartMeta(key, uploadId);
    const expires = String(Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSec)));
    return partNumbers.map((n) => {
      assertPartNumber(n);
      const q = new URLSearchParams({ partNumber: String(n), uploadId, expires });
      return { partNumber: n, url: `fsstore://${encodeKeyPath(key)}?${q.toString()}` };
    });
  }

  /** What the browser does with a presigned part URL: store one part, get its ETag back. */
  async putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): Promise<{ etag: string }> {
    await this.multipartMeta(key, uploadId);
    assertPartNumber(partNumber);
    const dir = this.multipartDir(uploadId);
    const tmp = path.join(dir, `${partNumber}.${randomBytes(4).toString("hex")}.tmp`);
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, path.join(dir, `part-${partNumber}`));
    return { etag: `"${createHash("md5").update(bytes).digest("hex")}"` };
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    await this.multipartMeta(key, uploadId);
    if (parts.length === 0) throw new Error("completeMultipart needs at least one part");
    const dir = this.multipartDir(uploadId);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].partNumber === sorted[i - 1].partNumber) throw new Error(`Part ${sorted[i].partNumber} listed twice`);
    }
    // Verify every part's ETag before assembling (the browser could have re-sent a part).
    for (const p of sorted) {
      assertPartNumber(p.partNumber);
      const file = path.join(dir, `part-${p.partNumber}`);
      const hash = createHash("md5");
      try {
        await pipeline(createReadStream(file), hash);
      } catch (err) {
        if (isNotFound(err)) throw new Error(`Part ${p.partNumber} was never uploaded`);
        throw err;
      }
      const etag = `"${hash.digest("hex")}"`;
      if (normEtag(etag) !== normEtag(p.etag)) throw new Error(`Part ${p.partNumber} ETag does not match`);
    }
    const files = sorted.map((p) => path.join(dir, `part-${p.partNumber}`));
    async function* concat() {
      for (const f of files) yield* createReadStream(f);
    }
    await this.writeAtomic(this.file(key), Readable.from(concat()));
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.multipartMeta(key, uploadId);
    } catch {
      return;
    }
    await fsp.rm(this.multipartDir(uploadId), { recursive: true, force: true });
  }
}

// ── R2Storage ───────────────────────────────────────────────────────────────

export interface R2Options {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Override the S3 endpoint (no trailing slash), e.g. for tests. Default https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string;
  /** Readable bodies at or above this size go up as a server-side multipart upload. Default 64 MiB. */
  multipartThreshold?: number;
  /** Part size for server-side multipart (R2 wants equal parts except the last). Default 16 MiB. */
  partSize?: number;
}

/** Thrown for an S3 error response. */
export class S3Error extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

/**
 * Cloudflare R2 through its S3 API, path-style:
 * `<endpoint>/<bucket>/<key>`, region "auto", SigV4 (aws4fetch).
 */
export class R2Storage implements Storage {
  readonly label: string;
  readonly bucket: string;
  readonly endpoint: string;
  private readonly client: AwsClient;
  private readonly multipartThreshold: number;
  private readonly partSize: number;

  constructor(opts: R2Options) {
    if (!opts.bucket) throw new Error("R2 bucket is required");
    if (!opts.accessKeyId || !opts.secretAccessKey) throw new Error("R2 access key id and secret are required");
    if (!opts.endpoint && !opts.accountId) throw new Error("R2 account id is required");
    this.bucket = opts.bucket;
    this.endpoint = (opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
    this.label = `r2:${opts.bucket}`;
    this.client = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: "s3", region: "auto", retries: 0 });
    this.partSize = Math.max(5 * 1024 * 1024, opts.partSize ?? 16 * 1024 * 1024);
    this.multipartThreshold = Math.max(this.partSize, opts.multipartThreshold ?? 64 * 1024 * 1024);
  }

  /** Object URL (path-style), query appended verbatim. */
  objectUrl(key: string, query = ""): string {
    assertKey(key);
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}/${encodeKeyPath(key)}${query ? "?" + query : ""}`;
  }

  bucketUrl(query = ""): string {
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}${query ? "?" + query : ""}`;
  }

  /** Signed request. Byte bodies are retried on network errors and 5xx; streams are not. */
  async request(method: string, url: string, init: { body?: Uint8Array | string | Readable; headers?: Record<string, string>; okStatuses?: number[] } = {}): Promise<Response> {
    const replayable = !(init.body instanceof Readable);
    const attempts = replayable ? 3 : 1;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(200 * 2 ** i);
      try {
        let body: BodyInit | undefined;
        if (init.body instanceof Readable) body = Readable.toWeb(init.body) as unknown as ReadableStream;
        else if (typeof init.body === "string") body = init.body;
        else if (init.body) body = init.body as unknown as BodyInit;
        const signed = await this.client.sign(url, { method, headers: init.headers, body: init.body instanceof Readable ? undefined : body });
        const reqInit: RequestInit & { duplex?: "half" } = { method, headers: signed.headers, body };
        if (init.body instanceof Readable) reqInit.duplex = "half";
        const res = await fetch(signed.url, reqInit);
        if (res.status >= 500 && i < attempts - 1) {
          await res.body?.cancel();
          lastErr = new S3Error(`R2 ${method} returned ${res.status}`, res.status);
          continue;
        }
        if (!res.ok && !(init.okStatuses ?? []).includes(res.status)) throw await s3ErrorFrom(method, res);
        return res;
      } catch (err) {
        if (err instanceof S3Error && err.status < 500) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async put(key: string, body: Uint8Array | string | Readable, opts?: { contentType?: string }): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts?.contentType) headers["content-type"] = opts.contentType;
    if (!(body instanceof Readable)) {
      await drain(await this.request("PUT", this.objectUrl(key), { body, headers }));
      return;
    }
    // Buffer up to the threshold; small streams go up in one PUT (R2 wants a Content-Length).
    const reader = new ChunkReader(body);
    const first = await reader.read(this.multipartThreshold);
    if (first.length < this.multipartThreshold) {
      await drain(await this.request("PUT", this.objectUrl(key), { body: first, headers }));
      return;
    }
    const { uploadId } = await this.createMultipart(key, opts?.contentType);
    try {
      const parts: { partNumber: number; etag: string }[] = [];
      let partNumber = 1;
      const uploadPart = async (bytes: Uint8Array) => {
        const n = partNumber++;
        if (n > 10000) throw new Error("Object too large for 10000 parts");
        const res = await this.request("PUT", this.objectUrl(key, `partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`), { body: bytes });
        const etag = res.headers.get("etag");
        await drain(res);
        if (!etag) throw new Error(`R2 returned no ETag for part ${n}`);
        parts.push({ partNumber: n, etag });
      };
      for (let off = 0; off < first.length; off += this.partSize) await uploadPart(first.subarray(off, Math.min(first.length, off + this.partSize)));
      for (;;) {
        const chunk = await reader.read(this.partSize);
        if (chunk.length === 0) break;
        await uploadPart(chunk);
        if (chunk.length < this.partSize) break;
      }
      await this.completeMultipart(key, uploadId, parts);
    } catch (err) {
      await this.abortMultipart(key, uploadId).catch(() => undefined);
      body.destroy();
      throw err;
    }
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const res = await this.request("GET", this.objectUrl(key), { okStatuses: [404] });
    if (res.status === 404) {
      await drain(res);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async getStream(key: string): Promise<Readable | null> {
    const res = await this.request("GET", this.objectUrl(key), { okStatuses: [404] });
    if (res.status === 404 || !res.body) {
      await drain(res);
      return null;
    }
    return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const res = await this.request("HEAD", this.objectUrl(key), { okStatuses: [404] });
    await drain(res);
    if (res.status === 404) return null;
    const lm = res.headers.get("last-modified");
    return {
      key,
      size: Number(res.headers.get("content-length") ?? 0),
      modified: lm ? new Date(lm).toISOString() : new Date(0).toISOString(),
      etag: res.headers.get("etag") ?? undefined,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100000; page++) {
      const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
      if (token) q.set("continuation-token", token);
      const res = await this.request("GET", this.bucketUrl(q.toString()));
      const parsed = parseListObjectsV2(await res.text());
      out.push(...parsed.objects);
      if (!parsed.truncated || !parsed.nextToken) break;
      token = parsed.nextToken;
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    await drain(await this.request("DELETE", this.objectUrl(key), { okStatuses: [404] }));
  }

  private async presign(method: string, url: string, expiresSec: number): Promise<string> {
    const u = new URL(url);
    u.searchParams.set("X-Amz-Expires", String(Math.min(604800, Math.max(1, Math.floor(expiresSec)))));
    const signed = await this.client.sign(u.toString(), { method, aws: { signQuery: true } });
    // URLSearchParams serialises spaces as "+" (a literal "+" is always "%2B"); "%20" is unambiguous to S3.
    const out = new URL(signed.url);
    return out.origin + out.pathname + out.search.replace(/\+/g, "%20");
  }

  async presignGet(key: string, expiresSec: number, opts?: { filename?: string }): Promise<string> {
    const q = opts?.filename ? `response-content-disposition=${encodeURIComponent(contentDisposition(opts.filename))}` : "";
    return this.presign("GET", this.objectUrl(key, q), expiresSec);
  }

  async createMultipart(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    const res = await this.request("POST", this.objectUrl(key, "uploads"), { headers });
    const xml = await res.text();
    const uploadId = xmlTag(xml, "UploadId");
    if (!uploadId) throw new Error("R2 CreateMultipartUpload returned no UploadId");
    return { uploadId };
  }

  async presignParts(key: string, uploadId: string, partNumbers: number[], expiresSec: number): Promise<PresignedPart[]> {
    const out: PresignedPart[] = [];
    for (const n of partNumbers) {
      assertPartNumber(n);
      out.push({ partNumber: n, url: await this.presign("PUT", this.objectUrl(key, `partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`), expiresSec) });
    }
    return out;
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    if (parts.length === 0) throw new Error("completeMultipart needs at least one part");
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      sorted.map((p) => {
        assertPartNumber(p.partNumber);
        return `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(quoteEtag(p.etag))}</ETag></Part>`;
      }).join("") +
      `</CompleteMultipartUpload>`;
    const res = await this.request("POST", this.objectUrl(key, `uploadId=${encodeURIComponent(uploadId)}`), { body, headers: { "content-type": "application/xml" } });
    // S3 can answer 200 with an <Error> body.
    const text = await res.text();
    if (/<Error>/.test(text)) throw new S3Error(`R2 CompleteMultipartUpload failed: ${xmlTag(text, "Code") ?? ""} ${xmlTag(text, "Message") ?? ""}`.trim(), 200, xmlTag(text, "Code"));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await drain(await this.request("DELETE", this.objectUrl(key, `uploadId=${encodeURIComponent(uploadId)}`), { okStatuses: [404] }));
  }
}

/**
 * PutBucketCors: browsers on these origins may PUT (multipart parts), GET and
 * HEAD objects directly; ETag is exposed so the page can complete the upload.
 */
export async function setBucketCors(r2: R2Storage, allowedOrigins: string[]): Promise<void> {
  if (allowedOrigins.length === 0) throw new Error("setBucketCors needs at least one origin");
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule>` +
    allowedOrigins.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join("") +
    `<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>` +
    `<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>` +
    `</CORSRule></CORSConfiguration>`;
  const md5 = createHash("md5").update(body).digest("base64");
  await drain(await r2.request("PUT", r2.bucketUrl("cors"), { body, headers: { "content-type": "application/xml", "content-md5": md5 } }));
}

export function storageFromConfig(cfg: Config["storage"]): Storage {
  if (cfg.kind === "fs") return new FsStorage(cfg.root);
  if (cfg.kind === "r2") return new R2Storage({ accountId: cfg.accountId, bucket: cfg.bucket, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  throw new Error(`Unknown storage kind: ${(cfg as { kind: string }).kind}`);
}

// ── XML (S3 responses) ──────────────────────────────────────────────────────

/** Decodes the five XML entities and numeric character references. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Text of the first <tag>…</tag> (namespace prefixes tolerated), entity-decoded; undefined when absent. */
function xmlTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`);
  const m = re.exec(xml);
  if (m) return decodeXmlEntities(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1"));
  return undefined;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

/** Minimal ListObjectsV2 parser: objects, IsTruncated, NextContinuationToken. */
export function parseListObjectsV2(xml: string): { objects: ObjectInfo[]; truncated: boolean; nextToken?: string } {
  const objects: ObjectInfo[] = [];
  for (const block of xmlBlocks(xml, "Contents")) {
    const key = xmlTag(block, "Key");
    if (key == null) continue;
    const lm = xmlTag(block, "LastModified");
    const etag = xmlTag(block, "ETag");
    objects.push({ key, size: Number(xmlTag(block, "Size") ?? 0), modified: lm ? new Date(lm).toISOString() : new Date(0).toISOString(), ...(etag ? { etag } : {}) });
  }
  const truncated = (xmlTag(xml, "IsTruncated") ?? "").trim().toLowerCase() === "true";
  return { objects, truncated, nextToken: xmlTag(xml, "NextContinuationToken") };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Percent-encodes each key segment the way SigV4 canonicalises an S3 path. */
function encodeKeyPath(key: string): string {
  return key.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
}

function assertPartNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error(`Invalid part number ${n} (1..10000)`);
}

function normEtag(e: string): string {
  return e.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

function quoteEtag(e: string): string {
  return `"${normEtag(e)}"`;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

async function s3ErrorFrom(method: string, res: Response): Promise<S3Error> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 4000);
  } catch {
    /* ignore */
  }
  const code = xmlTag(text, "Code");
  const msg = xmlTag(text, "Message");
  return new S3Error(`R2 ${method} failed: ${res.status}${code ? " " + code : ""}${msg ? ": " + msg : ""}`, res.status, code);
}

/** Reads exact-size chunks from a Readable (the last one may be short; empty at the end). */
class ChunkReader {
  private readonly it: AsyncIterator<Buffer | string>;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private done = false;

  constructor(stream: Readable) {
    this.it = stream[Symbol.asyncIterator]();
  }

  async read(size: number): Promise<Uint8Array> {
    while (this.pendingLen < size && !this.done) {
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      const buf = typeof r.value === "string" ? Buffer.from(r.value) : r.value;
      this.pending.push(buf);
      this.pendingLen += buf.length;
    }
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingLen);
    const take = Math.min(size, all.length);
    const out = Buffer.from(all.subarray(0, take));
    const rest = all.subarray(take);
    this.pending = rest.length ? [rest] : [];
    this.pendingLen = rest.length;
    return out;
  }
}
