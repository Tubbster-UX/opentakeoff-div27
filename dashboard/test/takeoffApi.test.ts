// The Takeoff tab's API (src/takeoff.ts, src/storage.ts) on PGlite with brink-merge's
// migrations, and a stand-in for Supabase Storage's object API. Covers what the routes
// do behind the Access check (test/worker.test.ts covers the HTTP layer): the takeoff as
// raw export + edit layer, edits under the editor's identity with per-target conflicts,
// the re-run import (BOM follows, machine original and its hash unchanged, schematic
// edits carried), and plan files stored, revised, served and removed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openPglite, type Db } from "../../brink-merge/src/db/db.js";
import { loadBomLines, loadCatalog, loadImportInput, loadIssues, recordEdit, renderEdited, saveMerge, seedCatalog } from "../../brink-merge/src/db/repository.js";
import { loadCatalogMap } from "../../brink-merge/src/catalog.js";
import { parseInput } from "../../brink-merge/src/load.js";
import { merge } from "../../brink-merge/src/pipeline.js";
import type { OtShape, OtTakeoff } from "../../brink-merge/src/ot/types.js";
import type { Identity } from "../src/access.js";
import { HttpError } from "../src/http.js";
import { StorageError, type StorageEnv } from "../src/storage.js";
import { checkSheetName, currentSheets, parseTakeoffEditRequest, readTakeoff, removeSheet, sheetFile, uploadSheet, writeTakeoffEdits } from "../src/takeoff.js";
import type { Queryable } from "../src/db.js";
import type { TakeoffView } from "../src/shared/protocol.js";

const fx = (n: string) => fileURLToPath(new URL(`../../brink-merge/fixtures/${n}`, import.meta.url));
const TAKEOFF_TEXT = readFileSync(fx("div27-sample.takeoff.json"), "utf8");
const input = () => parseInput(TAKEOFF_TEXT, readFileSync(fx("div27-sample.report.json"), "utf8"));
const ALEX: Identity = { email: "alex@brink.test", auth: "cloudflare-access" };
const SAM: Identity = { email: "sam@brink.test", auth: "cloudflare-access" };
const CLIENT = "ot-test-client-1";
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let db: Db;
let q: Queryable;
let projectId: string;
let storage: Server;
let objects: Map<string, { bytes: Buffer; type: string; auth: string }>;
let env: StorageEnv;
const PDF = Buffer.from("%PDF-1.4\n% invented test plan\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const PDF2 = Buffer.from("%PDF-1.4\n% invented test plan, revision 2\n%%EOF\n");

const view = async (): Promise<TakeoffView> => {
  const v = await readTakeoff(q, projectId);
  if (!v || "noImport" in v) throw new Error("no view");
  return v;
};
const current = async () => (await db.query<{ current_import_id: string }>("select current_import_id from brink_projects where id = $1", [projectId])).rows[0]!.current_import_id;
const devQty = async (importId: string, tag: string) => (await loadBomLines(db, importId)).find((l) => l.kind === "device" && l.conditionKey === tag)?.qty;
const tagId = (t: OtTakeoff, tag: string) => t.conditions.find((c) => c.finish_tag === tag)!.id;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  await seedCatalog(db, loadCatalogMap(fileURLToPath(new URL("../../brink-merge/data/catalog-map.json", import.meta.url))));
  const saved = await saveMerge(db, input(), merge(input(), await loadCatalog(db), { date: "x" }));
  projectId = saved.projectId;
  q = db as unknown as Queryable;
  // A stand-in for Supabase Storage's object API (POST / GET /storage/v1/object/<bucket>/<path>), checking the service key.
  objects = new Map();
  storage = createServer((req, res) => {
    const m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(req.url ?? "");
    const auth = String(req.headers.authorization ?? "");
    if (!m || auth !== "Bearer test-service-key") return res.writeHead(m ? 401 : 404).end(JSON.stringify({ error: "nope" }));
    const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (objects.has(key)) return res.writeHead(400).end(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }));
        objects.set(key, { bytes: Buffer.concat(chunks), type: String(req.headers["content-type"]), auth });
        res.writeHead(200).end(JSON.stringify({ Key: key }));
      });
      return;
    }
    const o = objects.get(key);
    if (!o) return res.writeHead(400).end(JSON.stringify({ statusCode: "404", error: "not_found" }));
    res.writeHead(200, { "content-type": o.type }).end(o.bytes);
  });
  await new Promise<void>((r) => storage.listen(0, "127.0.0.1", () => r()));
  env = { SUPABASE_URL: `http://127.0.0.1:${(storage.address() as { port: number }).port}`, SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
});
afterAll(async () => {
  await db.close();
  await new Promise<void>((r) => storage.close(() => r()));
});

describe("GET /api/projects/:id/takeoff (readTakeoff)", () => {
  it("is the import's raw takeoff while the layer is empty; no project and no import are distinct", async () => {
    const v = await view();
    expect(v.document).toEqual(JSON.parse(TAKEOFF_TEXT));
    expect(v.edits).toEqual([]);
    expect(v.sheets).toEqual([]);
    expect(await readTakeoff(q, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const p = (await db.query<{ id: string }>("insert into brink_projects (name) values ('no import yet') returning id")).rows[0]!;
    expect(await readTakeoff(q, p.id)).toEqual({ noImport: true });
  });
});

describe("POST /api/projects/:id/takeoff/edits (writeTakeoffEdits)", () => {
  it("validates the request body before touching the database", () => {
    const ok = { importId: "00000000-0000-4000-8000-000000000001", clientRef: CLIENT, ops: [{ kind: "shape_delete", target: "shp-1" }] };
    expect(parseTakeoffEditRequest(ok)).toEqual(ok);
    for (const bad of [null, [], { ...ok, importId: "x" }, { ...ok, clientRef: "short" }, { ...ok, ops: [] }, { ...ok, ops: [1] }, { ...ok, ops: [{ kind: "shape_delete", target: "s", expect: "nope" }] }, { ...ok, ops: [{ kind: "revert" }] }]) {
      expect(() => parseTakeoffEditRequest(bad)).toThrow(HttpError);
    }
  });

  it("saves a drawn count under the editor's identity, re-runs the import, and the BOM follows; the stored takeoff stays the export", async () => {
    const v = await view();
    const before = await current();
    const doc = v.document as unknown as OtTakeoff;
    const data = doc.shapes.find((s) => s.condition_id === tagId(doc, "DATA-1") && s.measure_role === "count")!;
    const drawn: OtShape = { ...clone(data), id: "shp-drawn-in-app", verts_norm: [[0.31, 0.79]], origin: { method: "manual" }, author: ALEX.email };
    const res = await writeTakeoffEdits(q, projectId, { importId: v.import_id, clientRef: CLIENT, ops: [{ kind: "shape_put", target: drawn.id, payload: { shape: drawn }, expect: null }] }, ALEX);
    expect(res.results).toEqual([{ i: 0, status: "saved", edit: expect.objectContaining({ target_type: "shape", target_key: drawn.id, kind: "shape_put", editor_email: ALEX.email, editor_auth: "cloudflare-access" }), superseded: null }]);
    expect(res.importId).not.toBe(before);
    expect(await current()).toBe(res.importId);
    expect(res.reimport).toEqual({ errors: expect.any(Number), warnings: expect.any(Number) });
    expect(await devQty(res.importId, "DATA-1")).toBe((await devQty(before, "DATA-1"))! + 1);
    const row = (await db.query("select editor_email, editor_auth, client_ref, base_import_id, target_context from brink_takeoff_edits where target_key = $1", [drawn.id])).rows[0];
    expect(row).toMatchObject({ editor_email: ALEX.email, editor_auth: "cloudflare-access", client_ref: CLIENT, base_import_id: before, target_context: { baseHash: null, measureRole: "count", finishTag: "DATA-1" } });
    const raw = await loadImportInput(db, res.importId);
    expect(raw.takeoff).toEqual(JSON.parse(TAKEOFF_TEXT));
    expect(raw.takeoffSha256).toBe(sha(Buffer.from(TAKEOFF_TEXT)));
    expect((await loadIssues(db, res.importId)).map((i) => i.code)).toContain("count_edited");
    expect(((await view()).document as unknown as OtTakeoff).shapes.some((s) => s.id === drawn.id)).toBe(true);
  });

  it("keeps the machine original when a person moves an agent's shape", async () => {
    const v = await view();
    const doc = v.document as unknown as OtTakeoff;
    const agent = doc.shapes.find((s) => (s.origin as { actor?: string })?.actor === "agent" && s.measure_role === "count")!;
    const moved = { ...clone(agent), verts_norm: [[0.5, 0.5]], origin: { method: "manual", actor: "human" } };
    const res = await writeTakeoffEdits(q, projectId, { importId: v.import_id, clientRef: CLIENT, ops: [{ kind: "shape_put", target: agent.id, payload: { shape: moved }, expect: null }] }, ALEX);
    expect(res.results[0]!.status).toBe("saved");
    const after = ((await view()).document as unknown as OtTakeoff).shapes.find((s) => s.id === agent.id)!;
    expect(after.verts_norm).toEqual([[0.5, 0.5]]);
    expect(after.origin).toMatchObject({ actor: "agent", method: agent.origin!.method, proposed_verts_norm: agent.verts_norm });
    expect((await loadImportInput(db, res.importId)).takeoff.shapes.find((s) => s.id === agent.id)!.verts_norm).toEqual(agent.verts_norm);
  });

  it("refuses a stale op as a conflict (the saved edit wins), and invalid ops one by one", async () => {
    const v = await view();
    const target = v.edits.find((e) => e.target_key === "shp-drawn-in-app")!;
    const doc = v.document as unknown as OtTakeoff;
    const shape = doc.shapes.find((s) => s.id === "shp-drawn-in-app")!;
    const importBefore = await current();
    const res = await writeTakeoffEdits(q, projectId, {
      importId: v.import_id,
      clientRef: "ot-test-client-2",
      ops: [
        { kind: "shape_put", target: shape.id, payload: { shape: { ...shape, label: "Sam's" } }, expect: null },
        { kind: "shape_put", target: "shp-x", payload: { shape: { id: "other" } }, expect: null },
        { kind: "shape_delete", target: "shp-not-in-this-takeoff", expect: null },
        { kind: "nope", target: "x" },
      ],
    }, SAM);
    expect(res.results.map((r) => r.status)).toEqual(["conflict", "invalid", "invalid", "invalid"]);
    expect(res.results[0]).toMatchObject({ current: { id: target.id, editor_email: ALEX.email } });
    expect(res.reimport).toBeNull();
    expect(await current()).toBe(importBefore);
  });

  it("deleting a shape that exists only as an edit reverts its put; revert brings the import's count back", async () => {
    const v = await view();
    const put = v.edits.find((e) => e.target_key === "shp-drawn-in-app")!;
    const res = await writeTakeoffEdits(q, projectId, { importId: v.import_id, clientRef: CLIENT, ops: [{ kind: "shape_delete", target: "shp-drawn-in-app", expect: put.id }] }, ALEX);
    expect(res.results).toEqual([{ i: 0, status: "reverted", edit: put.id }]);
    const base = (await loadImportInput(db, res.importId)).takeoff;
    expect(await devQty(res.importId, "DATA-1")).toBe(base.shapes.filter((s) => s.condition_id === tagId(base, "DATA-1")).length);
    const moved = (await view()).edits[0]!;
    const back = await writeTakeoffEdits(q, projectId, { importId: res.importId, clientRef: CLIENT, ops: [{ kind: "revert", edit: moved.id }, { kind: "revert", edit: moved.id }] }, ALEX);
    expect(back.results.map((r) => r.status)).toEqual(["reverted", "conflict"]);
    expect((await view()).document).toEqual(JSON.parse(TAKEOFF_TEXT));
    expect((await db.query("select reverted_by from brink_takeoff_edits where id = $1", [moved.id])).rows[0]).toEqual({ reverted_by: ALEX.email });
  });

  it("the re-run import carries the project's schematic edits", async () => {
    const v = await view();
    const sch = await renderEdited(db, v.import_id);
    const dev = sch.file.nodes.find((n) => n.id.startsWith("dev-"))!;
    await recordEdit(db, { projectId, input: { kind: "rename", target: dev.id, payload: { label: "Renamed in the schematic" } }, editorEmail: SAM.email, editorAuth: "cloudflare-access" });
    const doc = v.document as unknown as OtTakeoff;
    const res = await writeTakeoffEdits(q, projectId, { importId: v.import_id, clientRef: CLIENT, ops: [{ kind: "sheet_scale", target: doc.sheets[0]!.sheet_id, payload: { units_per_px: 0.03, scale_source: "calibrated", scale_confirmed: true }, expect: null }] }, ALEX);
    expect(res.results[0]!.status).toBe("saved");
    const after = await renderEdited(db, res.importId);
    expect(after.file.nodes.find((n) => n.id === dev.id)!.data.label).toBe("Renamed in the schematic");
    expect(after.issues).toEqual([]);
    expect(((await view()).document as unknown as OtTakeoff).sheets[0]).toMatchObject({ units_per_px: 0.03, scale_source: "calibrated", scale_confirmed: true });
  });
});

describe("plan sheets (uploadSheet, sheetFile, removeSheet)", () => {
  it("checks names and contents", async () => {
    expect(checkSheetName(" a.pdf ")).toBe("a.pdf");
    for (const bad of ["", "a#2.pdf", "dir/a.pdf", "a\\b.pdf", "a.png", "x".repeat(201) + ".pdf", 7]) expect(() => checkSheetName(bad)).toThrow(HttpError);
    await expect(uploadSheet(env, q, projectId, "a.pdf", null, (new TextEncoder().encode("not a pdf").buffer as ArrayBuffer), ALEX, CLIENT)).rejects.toMatchObject({ status: 415 });
    await expect(uploadSheet(env, q, projectId, "a.pdf", "-1", (PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length) as ArrayBuffer), ALEX, CLIENT)).rejects.toMatchObject({ status: 400 });
    await expect(uploadSheet({}, q, projectId, "a.pdf", null, (PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length) as ArrayBuffer), ALEX, CLIENT)).rejects.toBeInstanceOf(StorageError);
  });

  it("stores a plan in the bucket under the uploader, serves it back, de-dupes the same bytes, revises other bytes, removes it", async () => {
    const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
    const first = await uploadSheet(env, q, projectId, "sample-plan.pdf", "1", ab(PDF), ALEX, CLIENT);
    expect(first.sheet).toMatchObject({ name: "sample-plan.pdf", byte_size: PDF.length, sha256: sha(PDF), page_count: 1, rev: 1, uploaded_by: ALEX.email });
    expect(first.unchanged).toBeUndefined();
    const row = (await db.query("select storage_bucket, storage_path, uploaded_auth, client_ref from brink_sheets where id = $1", [first.sheet.id])).rows[0] as Record<string, string>;
    expect(row).toMatchObject({ storage_bucket: "brink-plans", storage_path: `${projectId}/${first.sheet.id}/${sha(PDF)}.pdf`, uploaded_auth: "cloudflare-access", client_ref: CLIENT });
    expect(objects.get(`brink-plans/${row.storage_path}`)).toMatchObject({ type: "application/pdf", auth: "Bearer test-service-key" });
    const res = await sheetFile(env, q, projectId, first.sheet.id);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(PDF));
    await expect(sheetFile(env, q, "00000000-0000-4000-8000-000000000000", first.sheet.id)).rejects.toMatchObject({ status: 404 });

    const same = await uploadSheet(env, q, projectId, "sample-plan.pdf", "1", ab(PDF), SAM, CLIENT);
    expect(same).toMatchObject({ unchanged: true, sheet: { id: first.sheet.id } });
    const rev = await uploadSheet(env, q, projectId, "sample-plan.pdf", "1", ab(PDF2), SAM, CLIENT);
    expect(rev).toMatchObject({ revised: true, prevRev: 1, sheet: { rev: 2, uploaded_by: SAM.email, sha256: sha(PDF2) } });
    expect((await db.query("select replaced_by from brink_sheets where id = $1", [first.sheet.id])).rows[0]).toEqual({ replaced_by: rev.sheet.id });
    // the old revision's object and row are kept; the plan set lists the current one
    expect(objects.size).toBe(2);
    expect((await currentSheets(q, projectId)).map((s) => [s.name, s.rev])).toEqual([["sample-plan.pdf", 2]]);
    expect((await view()).sheets.map((s) => s.id)).toEqual([rev.sheet.id]);

    expect(await removeSheet(q, projectId, rev.sheet.id, ALEX)).toEqual({ removed: true });
    expect(await removeSheet(q, projectId, rev.sheet.id, ALEX)).toEqual({ removed: false });
    expect(await currentSheets(q, projectId)).toEqual([]);
    expect((await db.query("select removed_by from brink_sheets where id = $1", [rev.sheet.id])).rows[0]).toEqual({ removed_by: ALEX.email });
  });
});
