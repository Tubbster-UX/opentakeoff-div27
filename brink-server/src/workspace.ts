// Local disk mirror the takeoff engine reads (<dataDir>/projects/<p>/files/…)
// and writes (<dataDir>/projects/<p>/outputs/…, or next to the plan inside
// files/). syncOutputs pushes what the tools wrote back to the store under
// projects/<p>/outputs/ and records it in the manifest as kind "output" with
// the path "outputs/<relative path>", so it never collides with an original.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertProjectId, assertProjectPath, KeyedMutex, projectKey } from "./projects.ts";
import { contentTypeFor } from "./storage.ts";
import type { ProjectFile, ProjectId, Projects, Storage, Workspace } from "./types.ts";

type FileWithHash = ProjectFile & { sha256?: string };

interface SyncStateEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** <dir>/.sync-state.json: what was last pushed (or downloaded) per manifest output path. */
interface SyncState {
  version: 1;
  outputs: Record<string, SyncStateEntry>;
}

const STATE_FILE = ".sync-state.json";

export interface WorkspaceDeps {
  storage: Storage;
  projects: Projects;
  /** Local data directory; the mirror lives under <dataDir>/projects/. */
  dataDir: string;
}

export class DiskWorkspace implements Workspace {
  private readonly storage: Storage;
  private readonly projects: Projects;
  private readonly root: string;
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly syncLock = new KeyedMutex();

  constructor(deps: WorkspaceDeps) {
    this.storage = deps.storage;
    this.projects = deps.projects;
    this.root = path.resolve(deps.dataDir, "projects");
  }

  dir(project: ProjectId): string {
    assertProjectId(project);
    return path.join(this.root, project);
  }

  outputsDir(project: ProjectId): string {
    const d = path.join(this.dir(project), "outputs");
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Local path for a manifest path ("outputs/…" for outputs, files/<path> otherwise). */
  private localPath(project: ProjectId, f: ProjectFile): { local: string; key: string } {
    const base = this.dir(project);
    let local: string;
    let key: string;
    if (f.kind === "output" && f.path.startsWith("outputs/")) {
      const rel = f.path.slice("outputs/".length);
      local = path.join(base, "outputs", ...rel.split("/"));
      key = projectKey(project, "outputs", rel);
    } else {
      local = path.join(base, "files", ...f.path.split("/"));
      key = projectKey(project, "files", f.path);
    }
    if (!local.startsWith(base + path.sep)) throw new Error(`Path escapes the workspace: ${f.path}`);
    return { local, key };
  }

  async ensureFile(project: ProjectId, filePath: string): Promise<string> {
    assertProjectId(project);
    assertProjectPath(filePath);
    const k = `${project}\u0000${filePath}`;
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.download(project, filePath).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async download(project: ProjectId, filePath: string): Promise<string> {
    const m = await this.projects.get(project);
    if (!m) throw new Error(`Project "${project}" not found`);
    const f = m.files.find((x) => x.path === filePath) as FileWithHash | undefined;
    if (!f) throw new Error(`File "${filePath}" not found in project "${project}"`);
    const { local, key } = this.localPath(project, f);
    try {
      const st = await fsp.lstat(local);
      if (st.isFile() && st.size === f.size) return local;
    } catch {
      /* missing */
    }
    const stream = await this.storage.getStream(key);
    if (!stream) throw new Error(`File "${filePath}" is in the manifest but missing from the store`);
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const tmp = path.join(path.dirname(local), `.${path.basename(local)}.${randomBytes(6).toString("hex")}.tmp`);
    const hash = createHash("sha256");
    try {
      await pipeline(stream, async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(tmp));
      await fsp.rename(tmp, local);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    if (f.kind === "output") {
      // A downloaded output is in sync by definition: do not push it back unchanged.
      const st = await fsp.stat(local);
      await this.syncLock.run(project, async () => {
        const state = await this.readState(project);
        state.outputs[f.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash.digest("hex") };
        await this.writeState(project, state);
      });
    }
    return local;
  }

  syncOutputs(project: ProjectId): Promise<string[]> {
    assertProjectId(project);
    return this.syncLock.run(project, () => this.sync(project));
  }

  private async sync(project: ProjectId): Promise<string[]> {
    const m = await this.projects.get(project);
    if (!m) throw new Error(`Project "${project}" not found`);
    const base = this.dir(project);
    const byPath = new Map(m.files.map((f) => [f.path, f as FileWithHash]));
    const state = await this.readState(project);

    // Candidates: manifest output path → local file. outputs/ wins over files/ on a clash.
    const candidates = new Map<string, string>();
    for (const rel of await walk(path.join(base, "files"))) {
      const orig = byPath.get(rel);
      const local = path.join(base, "files", ...rel.split("/"));
      if (orig && orig.kind !== "output") {
        const st = await fsp.stat(local);
        if (st.size === orig.size) continue; // unchanged original (or the same size; originals are never re-pushed)
      }
      candidates.set(`outputs/${rel}`, local);
    }
    for (const rel of await walk(path.join(base, "outputs"))) candidates.set(`outputs/${rel}`, path.join(base, "outputs", ...rel.split("/")));

    const pushed: FileWithHash[] = [];
    for (const [mpath, local] of candidates) {
      try {
        assertProjectPath(mpath);
      } catch {
        continue;
      }
      const existing = byPath.get(mpath);
      if (existing && existing.kind !== "output") continue; // never shadow an original
      let st;
      try {
        st = await fsp.stat(local);
      } catch {
        continue; // vanished mid-walk
      }
      const prev = state.outputs[mpath];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      const sha = await sha256File(local);
      if (prev && prev.sha256 === sha && prev.size === st.size) {
        state.outputs[mpath] = { ...prev, mtimeMs: st.mtimeMs };
        continue;
      }
      if (!prev && existing && existing.size === st.size && existing.sha256 === sha) {
        state.outputs[mpath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
        continue;
      }
      const rel = mpath.slice("outputs/".length);
      await this.storage.put(projectKey(project, "outputs", rel), createReadStream(local), { contentType: contentTypeFor(rel) });
      state.outputs[mpath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
      pushed.push({ path: mpath, kind: "output", size: st.size, contentType: contentTypeFor(rel), added: new Date().toISOString(), text: "none", textChars: 0, sha256: sha });
    }

    if (pushed.length) {
      await this.projects.update(project, (mm) => {
        const idx = new Map(mm.files.map((f, i) => [f.path, i]));
        for (const f of pushed) {
          const i = idx.get(f.path);
          if (i == null) idx.set(f.path, mm.files.push(f) - 1);
          else if (mm.files[i].kind === "output") mm.files[i] = f;
        }
      });
    }
    await this.writeState(project, state);
    return pushed.map((f) => f.path);
  }

  private async readState(project: ProjectId): Promise<SyncState> {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(this.dir(project), STATE_FILE), "utf8")) as SyncState;
      if (s?.version === 1 && s.outputs && typeof s.outputs === "object") return s;
    } catch {
      /* missing or corrupt: start over */
    }
    return { version: 1, outputs: {} };
  }

  private async writeState(project: ProjectId, state: SyncState): Promise<void> {
    const dir = this.dir(project);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${STATE_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, path.join(dir, STATE_FILE));
  }
}

/** Regular files under `dir` as POSIX relative paths; skips dot-names, *.tmp, symlinks and anything not a plain file. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const rec = async (abs: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.endsWith(".tmp")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(path.join(abs, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  await rec(dir, "");
  return out.sort();
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}
