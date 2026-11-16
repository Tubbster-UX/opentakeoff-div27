import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { assertProjectPath, isProjectPath, KeyedMutex, projectKey, slugify, StoreProjects } from "../src/projects.ts";
import { FsStorage } from "../src/storage.ts";

describe("project helpers", () => {
  test("slugify", () => {
    assert.equal(slugify("Fort Meade Bldg 9 — Telecom"), "fort-meade-bldg-9-telecom");
    assert.equal(slugify("  Café Résumé!! "), "cafe-resume");
    assert.equal(slugify("FA4690-26-Q-0012"), "fa4690-26-q-0012");
    assert.equal(slugify("!!!"), "project");
    const long = slugify("a".repeat(40) + " " + "b".repeat(40));
    assert.ok(long.length <= 63 && /^[a-z0-9][a-z0-9-]{0,62}$/.test(long) && !long.endsWith("-"));
  });

  test("assertProjectPath accepts POSIX relative paths and refuses the rest", () => {
    for (const ok of ["Drawings/E-101.pdf", "a", "outputs/Marked Set (2).pdf", "x/y.z/w"]) assert.equal(assertProjectPath(ok), ok);
    const bad = ["", "/abs.pdf", "../x", "a/../b", "a//b", "./a", "a/.", "a\\b", "C:/x", "c:x", "a\u0000b", "a\nb", "x".repeat(513)];
    for (const p of bad) {
      assert.throws(() => assertProjectPath(p), Error, JSON.stringify(p));
      assert.equal(isProjectPath(p), false);
    }
    assert.equal(assertProjectPath("x".repeat(512)).length, 512);
  });

  test("projectKey", () => {
    assert.equal(projectKey("abc"), "projects/abc");
    assert.equal(projectKey("abc", "files", "Drawings/E-101.pdf"), "projects/abc/files/Drawings/E-101.pdf");
    assert.equal(projectKey("abc", "text", "a.pdf.json"), "projects/abc/text/a.pdf.json");
    assert.throws(() => projectKey("ABC", "files"));
    assert.throws(() => projectKey("../x", "files"));
    assert.throws(() => projectKey("abc", "files", "../../system/tokens.json"));
  });

  test("KeyedMutex serialises per key and survives a throwing task", async () => {
    const mu = new KeyedMutex();
    const log: string[] = [];
    const slow = (tag: string, ms: number) => mu.run("k", async () => {
      log.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${tag}`);
    });
    const failing = mu.run("k", async () => {
      throw new Error("x");
    });
    await Promise.all([slow("a", 20), failing.catch(() => undefined), slow("b", 1)]);
    assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
  });
});

describe("StoreProjects", () => {
  let root: string;
  let projects: StoreProjects;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "brink-projects-"));
    projects = new StoreProjects(new FsStorage(root));
  });
  after(async () => rm(root, { recursive: true, force: true }));

  test("create slugifies, stores the manifest, refuses duplicates and bad ids", async () => {
    const m = await projects.create({ name: "Fort Meade Telecom", notes: "Due 12/1" });
    assert.equal(m.id, "fort-meade-telecom");
    assert.equal(m.schema, "brink.project.v1");
    assert.equal(m.notes, "Due 12/1");
    assert.deepEqual(m.files, []);
    assert.deepEqual(m.uploads, []);
    const again = await projects.get("fort-meade-telecom");
    assert.deepEqual(again, m);
    await assert.rejects(projects.create({ name: "Fort Meade Telecom" }), /already exists/);
    await assert.rejects(projects.create({ name: "Other", id: "fort-meade-telecom" }), /already exists/);
    await assert.rejects(projects.create({ name: "X", id: "Bad Id" }), /Invalid project id/);
    await assert.rejects(projects.create({ name: "X", id: "../escape" }), /Invalid project id/);
    await assert.rejects(projects.create({ name: "  " }), /name is required/);
    const custom = await projects.create({ name: "Custom", id: "fa4690-26" });
    assert.equal(custom.id, "fa4690-26");
  });

  test("concurrent creates of one id: exactly one wins", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => projects.create({ name: "Race Job" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  test("get returns null for unknown or invalid ids", async () => {
    assert.equal(await projects.get("nope"), null);
    assert.equal(await projects.get("../../etc"), null);
    assert.equal(await projects.get(""), null);
  });

  test("update serialises read-modify-write and bumps updated", async () => {
    const before = (await projects.get("fort-meade-telecom"))!;
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        projects.update("fort-meade-telecom", async (m) => {
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          m.files.push({ path: `f${i}.txt`, kind: "doc", size: i, contentType: "text/plain", added: new Date().toISOString(), text: "pending" });
        }),
      ),
    );
    const after = (await projects.get("fort-meade-telecom"))!;
    assert.equal(after.files.length, 40, "no update was lost");
    assert.ok(after.updated > before.updated);
    assert.equal(after.created, before.created);
    // The callback cannot rename the project.
    const r = await projects.update("fort-meade-telecom", (m) => {
      m.id = "hijack";
    });
    assert.equal(r.id, "fort-meade-telecom");
    assert.equal(await projects.get("hijack"), null);
    await assert.rejects(projects.update("missing-project", () => undefined), /not found/);
    await assert.rejects(projects.update("Bad Id", () => undefined), /Invalid project id/);
    // A throwing callback saves nothing.
    await assert.rejects(projects.update("fort-meade-telecom", (m) => {
      m.notes = "changed";
      throw new Error("nope");
    }), /nope/);
    assert.equal((await projects.get("fort-meade-telecom"))!.notes, "Due 12/1");
  });

  test("list returns every project, newest update first", async () => {
    await projects.update("fa4690-26", (m) => {
      m.notes = "touched";
    });
    const list = await projects.list();
    assert.deepEqual(list.map((m) => m.id).sort(), ["fa4690-26", "fort-meade-telecom", "race-job"]);
    assert.equal(list[0].id, "fa4690-26");
  });
});
