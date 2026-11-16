// In-memory fakes of the AppDeps contracts plus a server starter, for the
// auth/http tests. Fixtures are invented.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type express from "express";
import { buildApp, type BuildAppOptions } from "../src/http.ts";
import { hashPassword } from "../src/auth.ts";
import type {
  AppDeps,
  Config,
  Ingest,
  MountMcp,
  ObjectInfo,
  PresignedPart,
  ProjectManifest,
  Projects,
  Search,
  Storage,
  UploadRecord,
  Workspace,
} from "../src/types.ts";

export const PASSWORD = "correct horse battery staple";
let cachedHash: Promise<string> | null = null;
export const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD, { N: 2 ** 14 }));
export const SESSION_SECRET = crypto.randomBytes(48).toString("base64");

export class MemStorage implements Storage {
  readonly label = "mem:test";
  objects = new Map<string, { body: Buffer; modified: string; contentType?: string }>();
  multiparts = new Map<string, { key: string; parts: Map<number, { body: Buffer; etag: string }>; contentType?: string }>();
  presigned: { key: string; expiresSec: number; filename?: string }[] = [];

  async put(key: string, body: Uint8Array | string | Readable, opts?: { contentType?: string }) {
    let buf: Buffer;
    if (typeof body === "string") buf = Buffer.from(body);
    else if (body instanceof Uint8Array) buf = Buffer.from(body);
    else {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c));
      buf = Buffer.concat(chunks);
    }
    this.objects.set(key, { body: buf, modified: new Date().toISOString(), contentType: opts?.contentType });
  }
  async getBytes(key: string) {
    const o = this.objects.get(key);
    return o ? new Uint8Array(o.body) : null;
  }
  async getStream(key: string) {
    const o = this.objects.get(key);
    return o ? Readable.from([o.body]) : null;
  }
  async head(key: string): Promise<ObjectInfo | null> {
    const o = this.objects.get(key);
    return o ? { key, size: o.body.length, modified: o.modified, contentType: o.contentType } : null;
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    for (const [key, o] of this.objects) if (key.startsWith(prefix)) out.push({ key, size: o.body.length, modified: o.modified });
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async presignGet(key: string, expiresSec: number, opts?: { filename?: string }) {
    this.presigned.push({ key, expiresSec, filename: opts?.filename });
    return `https://store.test/${encodeURI(key)}?sig=fake&exp=${expiresSec}`;
  }
  async createMultipart(key: string, contentType?: string) {
    const uploadId = `mp-${crypto.randomBytes(6).toString("hex")}`;
    this.multiparts.set(uploadId, { key, parts: new Map(), contentType });
    return { uploadId };
  }
  async presignParts(key: string, uploadId: string, partNumbers: number[], expiresSec: number): Promise<PresignedPart[]> {
    const mp = this.multiparts.get(uploadId);
    if (!mp || mp.key !== key) throw new Error("no such multipart upload");
    return partNumbers.map((n) => ({ partNumber: n, url: `https://store.test/${encodeURI(key)}?uploadId=${uploadId}&partNumber=${n}&exp=${expiresSec}` }));
  }
  /** What a browser PUT to a presigned part URL does. Returns the ETag. */
  fakePutPart(uploadId: string, partNumber: number, body: Buffer): string {
    const mp = this.multiparts.get(uploadId);
    if (!mp) throw new Error("no such multipart upload");
    const etag = `"${crypto.createHash("md5").update(body).digest("hex")}"`;
    mp.parts.set(partNumber, { body, etag });
    return etag;
  }
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    const mp = this.multiparts.get(uploadId);
    if (!mp || mp.key !== key) throw new Error("no such multipart upload");
    const bufs: Buffer[] = [];
    for (const p of parts) {
      const got = mp.parts.get(p.partNumber);
      if (!got || got.etag !== p.etag) throw new Error(`part ${p.partNumber} missing or wrong etag`);
      bufs.push(got.body);
    }
    this.multiparts.delete(uploadId);
    await this.put(key, Buffer.concat(bufs), { contentType: mp.contentType });
  }
  async abortMultipart(_key: string, uploadId: string) {
    this.multiparts.delete(uploadId);
  }
}

export class MemProjects implements Projects {
  m = new Map<string, ProjectManifest>();
  async list() {
    return [...this.m.values()].map((x) => structuredClone(x));
  }
  async get(id: string) {
    const x = this.m.get(id);
    return x ? structuredClone(x) : null;
  }
  async create(input: { name: string; id?: string; notes?: string }) {
    const id =
      input.id ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 63);
    if (this.m.has(id)) throw new Error(`project ${id} already exists`);
    const now = new Date().toISOString();
    const man: ProjectManifest = { schema: "brink.project.v1", id, name: input.name, notes: input.notes ?? "", created: now, updated: now, files: [], uploads: [] };
    this.m.set(id, man);
    return structuredClone(man);
  }
  async update(id: string, fn: (m: ProjectManifest) => void | Promise<void>) {
    const x = this.m.get(id);
    if (!x) throw new Error(`no project ${id}`);
    const copy = structuredClone(x);
    await fn(copy);
    this.m.set(id, copy);
    return structuredClone(copy);
  }
}

export class FakeIngest implements Ingest {
  calls: { project: string; uploadId: string }[] = [];
  failNext = false;
  constructor(private projects: MemProjects) {}
  async process(project: string, uploadId: string): Promise<UploadRecord> {
    this.calls.push({ project, uploadId });
    await new Promise((r) => setTimeout(r, 5));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("invented ingest failure");
    }
    const m = await this.projects.update(project, (man) => {
      const u = man.uploads.find((x) => x.uploadId === uploadId)!;
      u.status = "done";
      u.files = [`Drawings/${u.name}`];
      man.files.push({ path: `Drawings/${u.name}`, kind: "plan", size: u.size, contentType: "application/pdf", pages: 3, uploadId, added: new Date().toISOString(), text: "ok", textChars: 100 });
    });
    return m.uploads.find((x) => x.uploadId === uploadId)!;
  }
}

const fakeSearch: Search = {
  async search() {
    return [];
  },
  async read() {
    return null;
  },
};

const fakeWorkspace: Workspace = {
  dir: () => "/tmp/none",
  ensureFile: async () => "/tmp/none",
  outputsDir: () => "/tmp/none",
  syncOutputs: async () => [],
};

export const fakeMountMcp: MountMcp = (app: express.Express, _deps, guard) => {
  const ok = (req: express.Request, res: express.Response) =>
    res.json({ ok: true, path: req.path, clientId: (req as express.Request & { auth?: { clientId: string } }).auth?.clientId });
  app.all("/mcp", guard, ok);
  app.all("/mcp/brink", guard, ok);
  return { close: async () => {} };
};

export interface TestServer {
  url: string;
  storage: MemStorage;
  projects: MemProjects;
  ingest: FakeIngest;
  config: Config;
  built: ReturnType<typeof buildApp>;
  close(): Promise<void>;
}

export async function startServer(opts: BuildAppOptions & { config?: Partial<Config> } = {}): Promise<TestServer> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const storage = new MemStorage();
  const projects = new MemProjects();
  const ingest = new FakeIngest(projects);
  const config: Config = {
    publicUrl: url,
    port: 0,
    dataDir: "/tmp/brink-test",
    storage: { kind: "fs", root: "/tmp/brink-test-store" },
    ownerPasswordHash: await passwordHash(),
    sessionSecret: SESSION_SECRET,
    maxUploadBytes: 4 * 1024 ** 3,
    ...opts.config,
  };
  const deps: AppDeps = { config, storage, projects, ingest, search: fakeSearch, workspace: fakeWorkspace };
  const built = buildApp(deps, fakeMountMcp, {
    resumeIngest: opts.resumeIngest ?? false,
    auth: { sweepTimer: false, redirectHosts: ["claude.ai", "claude.com"], ...opts.auth },
  });
  server.on("request", built.app);
  return {
    url,
    storage,
    projects,
    ingest,
    config,
    built,
    async close() {
      await built.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Pulls "name=value" for the session cookie out of a response. */
export function sessionCookie(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    const m = /^((?:__Host-)?brink_session=[^;]+)/.exec(c);
    if (m && !m[1].endsWith("=")) return m[1];
  }
  return null;
}

export async function login(t: TestServer, password = PASSWORD, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${t.url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: t.url, ...extra },
    body: new URLSearchParams({ password, next: "/" }).toString(),
  });
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
