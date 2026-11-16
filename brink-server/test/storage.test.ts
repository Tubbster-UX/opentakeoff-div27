import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { AwsV4Signer } from "aws4fetch";
import { contentDisposition, FsStorage, parseListObjectsV2, R2Storage, setBucketCors, storageFromConfig } from "../src/storage.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "brink-storage-"));
}

async function streamToString(s: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

describe("FsStorage", () => {
  let root: string;
  let fs: FsStorage;
  before(async () => {
    root = await tempDir();
    fs = new FsStorage(root);
  });
  after(async () => rm(root, { recursive: true, force: true }));

  test("put / getBytes / getStream / head / delete round trip", async () => {
    await fs.put("projects/a/files/Drawings/E-101 (2).pdf", "hello");
    assert.equal(Buffer.from((await fs.getBytes("projects/a/files/Drawings/E-101 (2).pdf"))!).toString(), "hello");
    assert.equal(await streamToString((await fs.getStream("projects/a/files/Drawings/E-101 (2).pdf"))!), "hello");
    const h = await fs.head("projects/a/files/Drawings/E-101 (2).pdf");
    assert.equal(h?.size, 5);
    assert.equal(h?.contentType, "application/pdf");
    await fs.delete("projects/a/files/Drawings/E-101 (2).pdf");
    assert.equal(await fs.getBytes("projects/a/files/Drawings/E-101 (2).pdf"), null);
    assert.equal(await fs.getStream("projects/a/files/Drawings/E-101 (2).pdf"), null);
    assert.equal(await fs.head("projects/a/files/Drawings/E-101 (2).pdf"), null);
    // Empty parent directories are pruned.
    assert.equal(existsSync(path.join(root, "projects", "a")), false);
    await fs.delete("does/not/exist"); // no throw
  });

  test("streams are written atomically and overwrite", async () => {
    await fs.put("k/stream.bin", Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    assert.equal(Buffer.from((await fs.getBytes("k/stream.bin"))!).toString(), "abcd");
    await fs.put("k/stream.bin", new Uint8Array([120, 121]));
    assert.equal(Buffer.from((await fs.getBytes("k/stream.bin"))!).toString(), "xy");
    // A failing stream leaves the old object and no temp files behind.
    const bad = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    await assert.rejects(fs.put("k/stream.bin", bad), /boom/);
    assert.equal(Buffer.from((await fs.getBytes("k/stream.bin"))!).toString(), "xy");
    const tmp = path.join(root, ".fsstore", "tmp");
    assert.deepEqual(existsSync(tmp) ? await readdir(tmp) : [], []);
  });

  test("refuses unsafe keys", async () => {
    for (const key of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a\\..\\b", ".fsstore/tmp/x", "a/\u0000b"]) {
      await assert.rejects(fs.put(key, "x"), Error, `key ${JSON.stringify(key)} should be refused`);
      await assert.rejects(fs.getBytes(key), Error);
    }
    assert.equal(existsSync(path.join(path.dirname(root), "x")), false);
  });

  test("list returns every key under a prefix, string-prefix semantics, never the reserved dir", async () => {
    await fs.put("projects/p1/project.json", "{}");
    await fs.put("projects/p1/files/a.pdf", "a");
    await fs.put("projects/p1/files/sub/b.pdf", "bb");
    await fs.put("projects/p10/project.json", "{}");
    await fs.put("system/x", "x");
    assert.deepEqual((await fs.list("projects/p1/")).map((o) => o.key), ["projects/p1/files/a.pdf", "projects/p1/files/sub/b.pdf", "projects/p1/project.json"]);
    assert.deepEqual((await fs.list("projects/p1")).map((o) => o.key), ["projects/p1/files/a.pdf", "projects/p1/files/sub/b.pdf", "projects/p1/project.json", "projects/p10/project.json"]);
    const all = (await fs.list("")).map((o) => o.key);
    assert.ok(all.includes("system/x"));
    assert.ok(!all.some((k) => k.startsWith(".fsstore")));
    assert.deepEqual(await fs.list("nothing/here/"), []);
    assert.deepEqual(await fs.list("../"), []);
    assert.equal((await fs.list("projects/p1/files/sub/"))[0].size, 2);
  });

  test("presignGet returns an fsstore:// URL with the disposition", async () => {
    await fs.put("projects/p1/outputs/Marked Set.pdf", "pdf");
    const url = await fs.presignGet("projects/p1/outputs/Marked Set.pdf", 600, { filename: "Marked Set – é.pdf" });
    assert.match(url, /^fsstore:\/\/projects\/p1\/outputs\/Marked%20Set\.pdf\?/);
    const parsed = FsStorage.parsePresignedUrl(url);
    assert.equal(parsed.key, "projects/p1/outputs/Marked Set.pdf");
    assert.ok(parsed.expires > Date.now() / 1000);
    assert.match(parsed.disposition!, /filename\*=UTF-8''Marked%20Set%20%E2%80%93%20%C3%A9\.pdf/);
  });

  test("multipart: putPart, complete in order, ETag verified, abort cleans up", async () => {
    const key = "projects/p1/uploads/u1/Bid Package.zip";
    const { uploadId } = await fs.createMultipart(key, "application/zip");
    const urls = await fs.presignParts(key, uploadId, [1, 2, 3], 3600);
    assert.equal(urls.length, 3);
    const p2 = FsStorage.parsePresignedUrl(urls[1].url);
    assert.equal(p2.partNumber, 2);
    assert.equal(p2.uploadId, uploadId);
    assert.equal(p2.key, key);
    const e3 = await fs.putPart(key, uploadId, 3, Buffer.from("ccc"));
    const e1 = await fs.putPart(key, uploadId, 1, Buffer.from("a"));
    const e2 = await fs.putPart(key, uploadId, 2, Buffer.from("bb"));
    assert.equal(e1.etag, `"${createHash("md5").update("a").digest("hex")}"`);
    await assert.rejects(fs.completeMultipart(key, uploadId, [{ partNumber: 1, etag: e2.etag }]), /ETag/);
    await fs.completeMultipart(key, uploadId, [
      { partNumber: 3, etag: e3.etag },
      { partNumber: 1, etag: e1.etag },
      { partNumber: 2, etag: e2.etag.replace(/"/g, "") },
    ]);
    assert.equal(Buffer.from((await fs.getBytes(key))!).toString(), "abbccc");
    await assert.rejects(fs.putPart(key, uploadId, 4, Buffer.from("x")), /Unknown multipart/);

    const { uploadId: u2 } = await fs.createMultipart("projects/p1/uploads/u2/x.zip");
    await fs.putPart("projects/p1/uploads/u2/x.zip", u2, 1, Buffer.from("x"));
    await assert.rejects(fs.putPart("projects/p1/uploads/OTHER/x.zip", u2, 1, Buffer.from("x")), /different key/);
    await assert.rejects(fs.completeMultipart("projects/p1/uploads/u2/x.zip", u2, [{ partNumber: 2, etag: '"x"' }]), /never uploaded/);
    await fs.abortMultipart("projects/p1/uploads/u2/x.zip", u2);
    assert.equal(existsSync(path.join(root, ".fsstore", "multipart", u2)), false);
    await assert.rejects(fs.putPart("projects/p1/uploads/u2/x.zip", "../../etc", 1, Buffer.from("x")), /Unknown multipart/);
  });

  test("storageFromConfig", () => {
    assert.ok(storageFromConfig({ kind: "fs", root }) instanceof FsStorage);
    const r2 = storageFromConfig({ kind: "r2", accountId: "acc123", bucket: "plans", accessKeyId: "AK", secretAccessKey: "SK" });
    assert.ok(r2 instanceof R2Storage);
    assert.equal(r2.label, "r2:plans");
    assert.equal((r2 as R2Storage).objectUrl("projects/a/b c.pdf"), "https://acc123.r2.cloudflarestorage.com/plans/projects/a/b%20c.pdf");
  });
});

describe("contentDisposition and XML parsing", () => {
  test("RFC 5987 filename*", () => {
    assert.equal(contentDisposition('Bid "A" (rev).pdf'), `attachment; filename="Bid _A_ (rev).pdf"; filename*=UTF-8''Bid%20%22A%22%20%28rev%29.pdf`);
    assert.equal(contentDisposition("a/b/É.pdf"), `attachment; filename="_.pdf"; filename*=UTF-8''%C3%89.pdf`);
  });

  test("ListObjectsV2 parsing decodes entities and tolerates namespaces/CDATA", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated>
      <Contents><Key>a &amp; b/&lt;x&gt; &#233;&#x20AC;.pdf</Key><Size>12</Size><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents>
      <Contents><Key><![CDATA[c.pdf]]></Key><Size>0</Size></Contents>
      <NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
    const r = parseListObjectsV2(xml);
    assert.equal(r.truncated, true);
    assert.equal(r.nextToken, "tok&1");
    assert.equal(r.objects[0].key, "a & b/<x> é€.pdf");
    assert.equal(r.objects[0].size, 12);
    assert.equal(r.objects[0].etag, '"abc"');
    assert.equal(r.objects[0].modified, "2026-01-02T03:04:05.000Z");
    assert.equal(r.objects[1].key, "c.pdf");
  });
});

// ── R2Storage against a recording S3 stand-in ───────────────────────────────

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  sigOk: boolean | null;
}

const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** Recomputes the SigV4 signature of a received request (header or query auth). */
async function verifySignature(req: IncomingMessage, base: string): Promise<boolean | null> {
  const url = new URL(req.url!, base);
  const auth = req.headers.authorization;
  if (auth) {
    const m = /Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
    if (!m) return false;
    const headers: Record<string, string> = {};
    for (const h of m[2].split(";")) if (h !== "host") headers[h] = String(req.headers[h] ?? "");
    const signer = new AwsV4Signer({ method: req.method, url: url.toString(), headers, accessKeyId: AK, secretAccessKey: SK, service: "s3", region: "auto", datetime: String(req.headers["x-amz-date"]) });
    const signed = await signer.sign();
    return signed.headers.get("authorization") === auth;
  }
  const sig = url.searchParams.get("X-Amz-Signature");
  if (!sig) return null;
  url.searchParams.delete("X-Amz-Signature");
  const signer = new AwsV4Signer({ method: req.method, url: url.toString(), accessKeyId: AK, secretAccessKey: SK, service: "s3", region: "auto", datetime: url.searchParams.get("X-Amz-Date")!, signQuery: true });
  const signed = await signer.sign();
  return signed.url.searchParams.get("X-Amz-Signature") === sig;
}

describe("R2Storage (local recording server)", () => {
  let server: Server;
  let base: string;
  let r2: R2Storage;
  const recorded: Recorded[] = [];
  const objects = new Map<string, Buffer>();
  const parts = new Map<string, Buffer>();

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks);
        const sigOk = await verifySignature(req, base);
        recorded.push({ method: req.method!, url: req.url!, headers: req.headers, body, sigOk });
        const url = new URL(req.url!, base);
        const q = url.searchParams;
        const key = decodeURIComponent(url.pathname.replace(/^\/plans\/?/, ""));
        const send = (status: number, text = "", headers: Record<string, string> = {}) => {
          res.writeHead(status, headers);
          res.end(text);
        };
        if (!url.pathname.startsWith("/plans")) return send(404, "<Error><Code>NoSuchBucket</Code></Error>");
        if (req.method === "GET" && key === "" && q.get("list-type") === "2") {
          const token = q.get("continuation-token");
          if (!token) {
            return send(200, `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>projects/a/one &amp; two.pdf</Key><Size>3</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e1"</ETag></Contents><NextContinuationToken>next/page+1</NextContinuationToken></ListBucketResult>`);
          }
          assert.equal(token, "next/page+1");
          return send(200, `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>projects/a/three.pdf</Key><Size>5</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`);
        }
        if (req.method === "PUT" && key === "" && q.has("cors")) return send(200);
        if (req.method === "POST" && q.has("uploads")) return send(200, `<InitiateMultipartUploadResult><Bucket>plans</Bucket><Key>${key}</Key><UploadId>up-1&amp;2</UploadId></InitiateMultipartUploadResult>`);
        if (req.method === "PUT" && q.has("partNumber")) {
          parts.set(`${q.get("uploadId")}:${q.get("partNumber")}`, body);
          return send(200, "", { etag: `"etag-${q.get("partNumber")}"` });
        }
        if (req.method === "POST" && q.has("uploadId")) {
          const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => m[1]);
          objects.set(key, Buffer.concat(nums.map((n) => parts.get(`${q.get("uploadId")}:${n}`) ?? Buffer.alloc(0))));
          return send(200, `<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
        }
        if (req.method === "DELETE" && q.has("uploadId")) return send(204);
        if (req.method === "PUT") {
          objects.set(key, body);
          return send(200, "", { etag: '"put-etag"' });
        }
        if (req.method === "GET" || req.method === "HEAD") {
          const obj = objects.get(key);
          if (!obj) return send(404, req.method === "GET" ? "<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>" : "");
          res.writeHead(200, { "content-length": String(obj.length), "content-type": "application/pdf", etag: '"g"', "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" });
          return res.end(req.method === "GET" ? obj : undefined);
        }
        if (req.method === "DELETE") {
          objects.delete(key);
          return send(204);
        }
        send(400, "<Error><Code>Bad</Code></Error>");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    r2 = new R2Storage({ accountId: "acc", bucket: "plans", accessKeyId: AK, secretAccessKey: SK, endpoint: base, partSize: 5 * 1024 * 1024, multipartThreshold: 5 * 1024 * 1024 });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("put / get / head / delete: path-style URL, signed headers, valid signature", async () => {
    recorded.length = 0;
    await r2.put("projects/a/files/Drawings/E-101 (2).pdf", new Uint8Array([1, 2, 3]), { contentType: "application/pdf" });
    const put = recorded[0];
    assert.equal(put.method, "PUT");
    assert.equal(put.url, "/plans/projects/a/files/Drawings/E-101%20%282%29.pdf");
    assert.match(String(put.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(put.headers["content-type"], "application/pdf");
    assert.equal(put.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
    assert.equal(put.headers["content-length"], "3");
    assert.equal(put.sigOk, true);
    assert.deepEqual([...(await r2.getBytes("projects/a/files/Drawings/E-101 (2).pdf"))!], [1, 2, 3]);
    assert.equal(await streamToString((await r2.getStream("projects/a/files/Drawings/E-101 (2).pdf"))!), "\u0001\u0002\u0003");
    const h = await r2.head("projects/a/files/Drawings/E-101 (2).pdf");
    assert.equal(h?.size, 3);
    assert.equal(h?.contentType, "application/pdf");
    assert.equal(h?.modified, "2026-01-01T00:00:00.000Z");
    assert.equal(await r2.getBytes("missing"), null);
    assert.equal(await r2.getStream("missing"), null);
    assert.equal(await r2.head("missing"), null);
    await r2.delete("projects/a/files/Drawings/E-101 (2).pdf");
    assert.equal(recorded.at(-1)!.method, "DELETE");
    assert.ok(recorded.every((r) => r.sigOk === true), "every request carries a valid signature");
    await assert.rejects(r2.put("../x", "x"), /segment/);
  });

  test("list follows continuation and decodes keys", async () => {
    recorded.length = 0;
    const list = await r2.list("projects/a/");
    assert.deepEqual(list.map((o) => o.key), ["projects/a/one & two.pdf", "projects/a/three.pdf"]);
    assert.equal(recorded.length, 2);
    const u1 = new URL(recorded[0].url, base);
    assert.equal(u1.pathname, "/plans");
    assert.equal(u1.searchParams.get("list-type"), "2");
    assert.equal(u1.searchParams.get("prefix"), "projects/a/");
    assert.equal(new URL(recorded[1].url, base).searchParams.get("continuation-token"), "next/page+1");
    assert.ok(recorded.every((r) => r.sigOk === true));
  });

  test("presignGet: query-signed URL with expiry and RFC 5987 disposition, verifiable", async () => {
    const url = await r2.presignGet("projects/a/outputs/Marked Set.pdf", 900, { filename: "Marked Set é.pdf" });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, `${base}/plans/projects/a/outputs/Marked%20Set.pdf`);
    assert.equal(u.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(u.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.match(u.searchParams.get("X-Amz-Credential")!, /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    assert.equal(u.searchParams.get("response-content-disposition"), `attachment; filename="Marked Set _.pdf"; filename*=UTF-8''Marked%20Set%20%C3%A9.pdf`);
    assert.ok(!u.search.includes("+"), "spaces are %20, not +");
    objects.set("projects/a/outputs/Marked Set.pdf", Buffer.from("pdf"));
    recorded.length = 0;
    const res = await fetch(url);
    assert.equal(await res.text(), "pdf");
    assert.equal(recorded[0].sigOk, true);
    assert.equal(recorded[0].headers.authorization, undefined);

    const def = new R2Storage({ accountId: "acc9", bucket: "b", accessKeyId: AK, secretAccessKey: SK });
    assert.match(await def.presignGet("k/x.pdf", 60), /^https:\/\/acc9\.r2\.cloudflarestorage\.com\/b\/k\/x\.pdf\?.*X-Amz-Signature=[0-9a-f]{64}/);
  });

  test("browser multipart: create, presigned part URLs, complete XML, abort", async () => {
    recorded.length = 0;
    const key = "projects/a/uploads/u1/Bid Package.zip";
    const { uploadId } = await r2.createMultipart(key, "application/zip");
    assert.equal(uploadId, "up-1&2");
    assert.equal(recorded[0].method, "POST");
    assert.equal(recorded[0].url, "/plans/projects/a/uploads/u1/Bid%20Package.zip?uploads");
    assert.equal(recorded[0].headers["content-type"], "application/zip");
    const urls = await r2.presignParts(key, uploadId, [1, 2], 3600);
    const u1 = new URL(urls[0].url);
    assert.equal(u1.searchParams.get("partNumber"), "1");
    assert.equal(u1.searchParams.get("uploadId"), "up-1&2");
    assert.equal(u1.searchParams.get("X-Amz-Expires"), "3600");
    // The "browser" PUTs each part to its URL and reads the ETag.
    const etags: string[] = [];
    for (const [i, p] of urls.entries()) {
      const res = await fetch(p.url, { method: "PUT", body: Buffer.from(i === 0 ? "first-" : "second") });
      etags.push(res.headers.get("etag")!);
    }
    assert.ok(recorded.slice(1).every((r) => r.sigOk === true), "presigned part URLs verify");
    recorded.length = 0;
    await r2.completeMultipart(key, uploadId, [
      { partNumber: 2, etag: etags[1] },
      { partNumber: 1, etag: "etag-1" },
    ]);
    const done = recorded[0];
    assert.equal(done.method, "POST");
    assert.equal(new URL(done.url, base).searchParams.get("uploadId"), "up-1&2");
    assert.equal(
      done.body.toString(),
      `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&quot;</ETag></Part></CompleteMultipartUpload>`,
    );
    assert.equal(objects.get(key)?.toString(), "first-second");
    await r2.abortMultipart(key, uploadId);
    assert.equal(recorded.at(-1)!.method, "DELETE");
    assert.equal(new URL(recorded.at(-1)!.url, base).searchParams.get("uploadId"), "up-1&2");
    assert.ok(recorded.every((r) => r.sigOk === true));
  });

  test("a large Readable goes up as server-side multipart with equal parts", async () => {
    recorded.length = 0;
    const MiB = 1024 * 1024;
    const total = 11 * MiB + 123;
    let sent = 0;
    const src = new Readable({
      read() {
        if (sent >= total) return this.push(null);
        const n = Math.min(700 * 1024, total - sent);
        this.push(Buffer.alloc(n, sent % 251));
        sent += n;
      },
    });
    await r2.put("projects/a/files/big.pdf", src, { contentType: "application/pdf" });
    const partReqs = recorded.filter((r) => r.method === "PUT" && r.url.includes("partNumber="));
    assert.deepEqual(partReqs.map((r) => r.body.length), [5 * MiB, 5 * MiB, MiB + 123]);
    assert.equal(recorded[0].url, "/plans/projects/a/files/big.pdf?uploads");
    assert.equal(objects.get("projects/a/files/big.pdf")?.length, total);
    // Small streams use a single PUT.
    recorded.length = 0;
    await r2.put("projects/a/small.txt", Readable.from([Buffer.from("tiny")]));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].body.toString(), "tiny");
  });

  test("setBucketCors sends PutBucketCors XML with Content-MD5", async () => {
    recorded.length = 0;
    await setBucketCors(r2, ["https://brink.example.com", "http://localhost:8787"]);
    const r = recorded[0];
    assert.equal(r.method, "PUT");
    assert.equal(r.url, "/plans?cors");
    const xml = r.body.toString();
    assert.match(xml, /<AllowedOrigin>https:\/\/brink\.example\.com<\/AllowedOrigin><AllowedOrigin>http:\/\/localhost:8787<\/AllowedOrigin>/);
    for (const m of ["PUT", "GET", "HEAD"]) assert.ok(xml.includes(`<AllowedMethod>${m}</AllowedMethod>`));
    assert.ok(xml.includes("<AllowedHeader>*</AllowedHeader>"));
    assert.ok(xml.includes("<ExposeHeader>ETag</ExposeHeader>"));
    assert.equal(r.headers["content-md5"], createHash("md5").update(xml).digest("base64"));
    assert.equal(r.sigOk, true);
  });

  test("S3 errors surface code and status", async () => {
    const bad = new R2Storage({ accountId: "acc", bucket: "nobucket", accessKeyId: AK, secretAccessKey: SK, endpoint: base });
    await assert.rejects(bad.put("k", "x"), (err: Error & { status?: number; code?: string }) => err.status === 404 && err.code === "NoSuchBucket");
  });
});
