// Project manifests in the store (projects/<id>/project.json), with a
// per-project in-process write lock so read-modify-write never loses an update.

import type { ProjectId, ProjectManifest, Projects, Storage } from "./types.ts";

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PROJECT_PATH = 512;

export function isProjectId(id: unknown): id is ProjectId {
  return typeof id === "string" && PROJECT_ID_RE.test(id);
}

export function assertProjectId(id: string): ProjectId {
  if (!isProjectId(id)) throw new Error(`Invalid project id ${JSON.stringify(id)}: use 1-63 lowercase letters, digits and dashes, starting with a letter or digit`);
  return id;
}

/** "Fort Meade Bldg 9 — Telecom" → "fort-meade-bldg-9-telecom". */
export function slugify(name: string): ProjectId {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug || "project";
}

/**
 * Throws unless `path` is a safe project path: POSIX, relative (no leading
 * slash), no "." / ".." / empty segments, no backslashes or control
 * characters, at most 512 characters. Returns it unchanged.
 */
export function assertProjectPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw new Error("Project path is empty");
  if (path.length > MAX_PROJECT_PATH) throw new Error(`Project path is longer than ${MAX_PROJECT_PATH} characters`);
  if (path.startsWith("/")) throw new Error(`Project path must not start with "/": ${JSON.stringify(path)}`);
  if (path.includes("\\")) throw new Error(`Project path must not contain a backslash: ${JSON.stringify(path)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error(`Project path contains a control character: ${JSON.stringify(path)}`);
  if (/^[a-zA-Z]:/.test(path)) throw new Error(`Project path must not start with a drive letter: ${JSON.stringify(path)}`);
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`Project path has an empty, "." or ".." segment: ${JSON.stringify(path)}`);
  }
  return path;
}

export function isProjectPath(path: string): boolean {
  try {
    assertProjectPath(path);
    return true;
  } catch {
    return false;
  }
}

/** Store key inside a project: projectKey("abc", "files", "Drawings/E-101.pdf") → "projects/abc/files/Drawings/E-101.pdf". */
export function projectKey(id: ProjectId, ...parts: string[]): string {
  assertProjectId(id);
  if (parts.length === 0) return `projects/${id}`;
  const rest = parts.join("/");
  assertProjectPath(rest);
  return `projects/${id}/${rest}`;
}

/** Serialises async work per key (in-process). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function manifestKey(id: ProjectId): string {
  return `projects/${id}/project.json`;
}

export class StoreProjects implements Projects {
  private readonly storage: Storage;
  private readonly lock = new KeyedMutex();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async list(): Promise<ProjectManifest[]> {
    const objects = await this.storage.list("projects/");
    const ids = new Set<string>();
    for (const o of objects) {
      const m = /^projects\/([^/]+)\/project\.json$/.exec(o.key);
      if (m && isProjectId(m[1])) ids.add(m[1]);
    }
    const out: ProjectManifest[] = [];
    for (const id of ids) {
      const m = await this.get(id);
      if (m) out.push(m);
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id.localeCompare(b.id)));
    return out;
  }

  async get(id: ProjectId): Promise<ProjectManifest | null> {
    if (!isProjectId(id)) return null;
    const bytes = await this.storage.getBytes(manifestKey(id));
    if (!bytes) return null;
    const m = JSON.parse(Buffer.from(bytes).toString("utf8")) as ProjectManifest;
    if (m?.schema !== "brink.project.v1") throw new Error(`projects/${id}/project.json is not a brink.project.v1 manifest`);
    m.files ??= [];
    m.uploads ??= [];
    m.notes ??= "";
    return m;
  }

  async create(input: { name: string; id?: string; notes?: string }): Promise<ProjectManifest> {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("Project name is required");
    const id = input.id != null && input.id !== "" ? assertProjectId(input.id) : slugify(name);
    return this.lock.run(id, async () => {
      if (await this.storage.head(manifestKey(id))) throw new Error(`Project "${id}" already exists`);
      const now = new Date().toISOString();
      const m: ProjectManifest = { schema: "brink.project.v1", id, name, notes: input.notes ?? "", created: now, updated: now, files: [], uploads: [] };
      await this.save(m);
      return m;
    });
  }

  async update(id: ProjectId, fn: (m: ProjectManifest) => void | Promise<void>): Promise<ProjectManifest> {
    assertProjectId(id);
    return this.lock.run(id, async () => {
      const m = await this.get(id);
      if (!m) throw new Error(`Project "${id}" not found`);
      await fn(m);
      m.schema = "brink.project.v1";
      m.id = id;
      m.updated = new Date().toISOString();
      await this.save(m);
      return m;
    });
  }

  private async save(m: ProjectManifest): Promise<void> {
    await this.storage.put(manifestKey(m.id), JSON.stringify(m, null, 1), { contentType: "application/json" });
  }
}
