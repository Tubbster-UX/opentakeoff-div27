// The install drawing package: tabloid pages, an index that matches the
// sheets, every tag / label / rack where the crews look for it, the status
// wording, a device marker that lands on its plan point on a /Rotate 90 page,
// the plan-not-available frame, unknown watts, and pagination at size.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { renderInstallPackage, parseInchesAff } from "../src/install/render.ts";
import { viewportTransform, planGeometry } from "../src/install/geometry.ts";
import type { InstallDesign } from "../src/installTypes.ts";
import { tinyPng } from "./bidFixture.ts";
import { ROTATED_ANCHORS, approveDesign, fixtureCompany, fixtureDesign, fixturePlans, fixtureProject } from "./installRenderFixture.ts";

type Plans = Awaited<ReturnType<typeof fixturePlans>>;
interface Item { str: string; x: number; y: number; w: number; a: number; b: number }

async function pdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function openPdf(bytes: Uint8Array) {
  const lib = await pdfjs();
  const req = createRequire(import.meta.url);
  const fonts = path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  return lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: fonts, isEvalSupported: false } as Parameters<typeof lib.getDocument>[0]).promise;
}

/** Per page: joined text, text items with positions, and the page size. */
async function readPdf(bytes: Uint8Array): Promise<{ pages: { text: string; tokens: Set<string>; items: Item[]; w: number; h: number }[]; info: Record<string, unknown> }> {
  const doc = await openPdf(bytes);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: Item[] = [];
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, a: it.transform[0], b: it.transform[1] });
    }
    const text = items.map((x) => x.str).join(" ").replace(/\s+/g, " ");
    pages.push({ text, tokens: new Set(text.split(/[\s,]+/).filter(Boolean)), items, w: vp.width, h: vp.height });
  }
  const meta = await doc.getMetadata();
  await doc.destroy();
  return { pages, info: (meta.info ?? {}) as Record<string, unknown> };
}

const SHEET_NAMES = { "T-101": "T-101 First floor", "T-201": "T-201 Second floor" };

async function render(design: InstallDesign, plans: Plans, o: { planPage?: (s: string) => Promise<{ pdf: Uint8Array; pageIndex: number } | null>; logo?: Uint8Array } = {}) {
  return renderInstallPackage({
    design, project: fixtureProject(), company: fixtureCompany(), logo: o.logo,
    planPage: o.planPage ?? (async (s) => plans[s] ?? null),
    sheetNames: SHEET_NAMES, now: "2026-11-23T12:00:00Z",
    site: { client: "Sample Builders Inc", address: ["200 Example Avenue", "Testville, SD 57000"] },
  });
}

describe("install package (draft)", () => {
  const design = fixtureDesign();
  let plans: Plans;
  let out: Awaited<ReturnType<typeof render>>;
  let pdf: Awaited<ReturnType<typeof readPdf>>;
  before(async () => {
    plans = await fixturePlans(design);
    out = await render(design, plans, { logo: tinyPng(40, 12) });
    pdf = await readPdf(out.pdf);
  });

  test("every page is tabloid landscape, 1224 x 792", async () => {
    const doc = await PDFDocument.load(out.pdf);
    assert.equal(doc.getPageCount(), out.sheets.length);
    for (const p of doc.getPages()) {
      assert.equal(Math.round(p.getWidth()), 1224);
      assert.equal(Math.round(p.getHeight()), 792);
      assert.equal(p.getRotation().angle, 0);
    }
    for (const p of pdf.pages) assert.deepEqual([Math.round(p.w), Math.round(p.h)], [1224, 792]);
  });

  test("the sheet list is numbered by section and matches the pages and the cover index", () => {
    const numbers = out.sheets.map((s) => s.number);
    assert.equal(numbers[0], "I-0.0");
    assert.deepEqual(numbers.filter((n) => n.startsWith("I-1.")), ["I-1.1", "I-1.2"]);
    assert.deepEqual(numbers.filter((n) => n.startsWith("I-2.")), ["I-2.1", "I-2.2"]);
    assert.ok(numbers.some((n) => n.startsWith("I-3.")));
    assert.deepEqual(numbers.filter((n) => n.startsWith("I-4.")), ["I-4.1", "I-4.2"]);
    assert.ok(numbers.filter((n) => n.startsWith("I-5.")).length >= 3, "rack flows plus at least one room flow");
    assert.deepEqual(numbers.filter((n) => n.startsWith("I-6.")), ["I-6.1"]);
    assert.equal(new Set(numbers).size, numbers.length, "numbers are unique");
    // sections in order
    const sec = numbers.map((n) => Number(n.slice(2, 3)));
    assert.deepEqual(sec, [...sec].sort((a, b) => a - b));
    const cover = pdf.pages[0].text;
    out.sheets.forEach((s, i) => {
      assert.ok(cover.includes(s.number), `cover index lists ${s.number}`);
      assert.ok(cover.includes(s.title), `cover index lists "${s.title}"`);
      assert.ok(pdf.pages[i].tokens.has(s.number), `page ${i + 1} carries its sheet number ${s.number}`);
      assert.ok(pdf.pages[i].text.includes(s.title.slice(0, 20)), `page ${i + 1} carries its title`);
    });
  });

  test("the title block carries the company, client and project on every sheet", () => {
    for (const p of pdf.pages) {
      assert.ok(p.text.includes("Example Design"));
      assert.ok(p.text.includes("Sample Builders Inc"));
      assert.ok(p.text.includes("Sample Academy Classroom Wing"));
      assert.ok(p.text.includes("2026-11-23"));
    }
  });

  test("device plans carry every device tag of their sheet", () => {
    for (const [i, s] of out.sheets.entries()) {
      if (!s.number.startsWith("I-1.")) continue;
      const key = s.title.includes("T-101") ? "T-101" : "T-201";
      for (const d of design.devices.filter((x) => x.sheet === key)) assert.ok(pdf.pages[i].tokens.has(d.tag), `${s.number} shows ${d.tag}`);
    }
    const all = new Set(pdf.pages.filter((_, i) => out.sheets[i].number.startsWith("I-1.")).flatMap((p) => [...p.tokens]));
    for (const d of design.devices) assert.ok(all.has(d.tag), `device plans show ${d.tag}`);
  });

  test("pull-label plans carry every cable label at its device", () => {
    const all = new Set(pdf.pages.filter((_, i) => out.sheets[i].number.startsWith("I-2.")).flatMap((p) => [...p.tokens]));
    for (const c of design.cables) {
      if (!design.devices.some((d) => d.tag === c.to.equipment)) continue;
      assert.ok(all.has(c.label), `pull-label plans show ${c.label}`);
    }
    assert.ok(pdf.pages[out.sheets.findIndex((s) => s.number === "I-2.2")].text.includes("Home runs to RK-101"), "the speaker home runs on T-201 go to the MDF");
  });

  test("the pull schedule lists every cable label, with totals and the unmeasured-length note", () => {
    const idx = out.sheets.map((s, i) => (s.number.startsWith("I-3.") ? i : -1)).filter((i) => i >= 0);
    const tokens = new Set(idx.flatMap((i) => [...pdf.pages[i].tokens]));
    for (const c of design.cables) assert.ok(tokens.has(c.label), `schedule lists ${c.label}`);
    for (const i of idx) {
      assert.match(pdf.pages[i].text, /Sheet total: \d+ cables?/);
      assert.match(pdf.pages[i].text, /field-measure/);
    }
    const text = idx.map((i) => pdf.pages[i].text).join(" ");
    assert.match(text, /Total Lab 203: 11 cables/);
    assert.match(text, /1 without a measured length/);
  });

  test("every rack has its elevation, power with unknown watts flagged (never 0), and heat", () => {
    for (const r of design.racks) {
      const i = out.sheets.findIndex((s) => s.number.startsWith("I-4.") && s.title.includes(r.id));
      assert.ok(i > 0, `elevation for ${r.id}`);
      const t = pdf.pages[i].text;
      assert.ok(t.includes(r.id));
      assert.match(t, /BTU\/hr/);
      for (const it of r.items.filter((x) => x.kind === "equipment" || x.kind === "panel")) assert.ok(pdf.pages[i].tokens.has(it.tag), `${r.id} elevation shows ${it.tag}`);
      assert.ok(pdf.pages[0].tokens.has(r.id), `cover lists ${r.id}`);
    }
    const mdf = pdf.pages[out.sheets.findIndex((s) => s.title.includes("Rack elevation — RK-101"))].text;
    assert.match(mdf, /NVR-101 unknown unknown/);
    assert.match(mdf, /Total \(known only\) 1100 9\.17/, "740 + 300 + 60 W, the NVR left out");
    assert.match(mdf, /at least 29% of 80% circuit capacity/);
    assert.match(mdf, />= 3,753 BTU\/hr/);
    const idf = pdf.pages[out.sheets.findIndex((s) => s.title.includes("Rack elevation — RK-201"))].text;
    assert.match(idf, /50 CFM/);
    assert.match(idf, /Total 740 6\.17/);
  });

  test("signal flow draws every equipment block and references the far end by sheet", () => {
    const idx = out.sheets.map((s, i) => (s.number.startsWith("I-5.") ? i : -1)).filter((i) => i >= 0);
    const tokens = new Set(idx.flatMap((i) => [...pdf.pages[i].tokens]));
    for (const e of design.equipment) assert.ok(tokens.has(e.tag), `signal flow shows ${e.tag}`);
    for (const d of design.devices) assert.ok(tokens.has(d.tag), `signal flow shows ${d.tag}`);
    const text = idx.map((i) => pdf.pages[i].text).join(" ");
    // the MDF switch patch to PP-A port 1, and a wall outlet's rack end
    assert.match(text, /\[I-5\.1\] SW-101:1\b/);
    assert.match(text, /\[I-5\.1\] PP-A:1 · RK-101/);
    assert.match(text, /\[I-5\.\d\] DO-101:A · Office 101/);
    assert.match(text, /\[I-5\.2\] FIB-201:F1 · RK-201/, "the fiber backbone references the IDF sheet");
    assert.ok(!/\[—\]/.test(text), "every far end is drawn somewhere");
    for (const k of ["data", "video", "fiber", "speaker"]) assert.ok(text.includes(k), `cable-kind legend has ${k}`);
  });

  test("mounting details: one per type with its height", () => {
    const i = out.sheets.findIndex((s) => s.number === "I-6.1");
    const t = pdf.pages[i].text;
    for (const m of design.mounting) {
      assert.ok(t.includes(m.title), m.title);
      assert.ok(t.includes(m.heightAff), m.heightAff);
    }
    assert.match(t, /FINISHED FLOOR/);
  });

  test("a draft says DRAFT and NOT FOR CONSTRUCTION on every sheet, never ISSUED", () => {
    for (const p of pdf.pages) {
      assert.ok(p.tokens.has("DRAFT"));
      assert.match(p.text, /NOT FOR CONSTRUCTION/);
      assert.ok(!/ISSUED FOR/.test(p.text));
    }
  });

  test("no OpenTakeoff marks in the text or the metadata", () => {
    for (const p of pdf.pages) assert.ok(!/opentakeoff/i.test(p.text));
    assert.ok(!/opentakeoff/i.test(JSON.stringify(pdf.info)));
    assert.ok(!Buffer.from(out.pdf).toString("latin1").toLowerCase().includes("opentakeoff"));
  });

  test("on the /Rotate 90 plan, a device tag lands at its verts_norm point", () => {
    const i = out.sheets.findIndex((s) => s.number === "I-1.2");
    const items = pdf.pages[i].items;
    // the vector copy is upright: the plan's room names read left to right
    const room = items.find((x) => x.str === "CLASSROOM 201");
    assert.ok(room, "the source plan text survives as vectors");
    assert.ok(room.a > 0 && Math.abs(room.b) < 1e-6, "rotated plan text reads upright on the sheet");
    for (const [tag, anchorText] of Object.entries(ROTATED_ANCHORS)) {
      const anchor = items.find((x) => x.str === anchorText);
      const label = items.find((x) => x.str === tag);
      assert.ok(anchor && label, `${tag} and its plan anchor are on the sheet`);
      // the anchor was drawn into the source page at the device's point; the
      // tag label sits beside the marker drawn at that point
      const cx = label.x + label.w / 2, cy = label.y + 2.3;
      const reach = 4.2 + 1.5 + label.w / 2 + 2 + 9.5;
      const dist = Math.hypot(cx - anchor.x, cy - anchor.y);
      assert.ok(dist <= reach, `${tag} label is ${dist.toFixed(1)} pt from its plan point (<= ${reach.toFixed(1)})`);
    }
  });
});

describe("install package (approved)", () => {
  test("says ISSUED FOR CONSTRUCTION with the approval date and revision, and no DRAFT", async () => {
    const design = approveDesign(fixtureDesign());
    const plans = await fixturePlans(design);
    const out = await render(design, plans);
    const pdf = await readPdf(out.pdf);
    for (const p of pdf.pages) {
      assert.match(p.text, /ISSUED FOR\s+CONSTRUCTION/);
      assert.ok(!/DRAFT/i.test(p.text), "no DRAFT once approved");
      assert.ok(!/NOT FOR CONSTRUCTION/.test(p.text));
      assert.match(p.text, /Revision 4 · 2026-11-20/);
    }
    assert.match(pdf.pages[0].text, /ISSUED FOR CONSTRUCTION Revision 4 · approved 2026-11-20/);
  });

  test("approval of an older revision does not issue this one", async () => {
    const design = { ...approveDesign(fixtureDesign()), approved: { at: "2026-11-20T16:30:00.000Z", revision: 3 } };
    const out = await render(design, await fixturePlans(design));
    const pdf = await readPdf(out.pdf);
    assert.ok(pdf.pages.every((p) => p.tokens.has("DRAFT")));
    assert.ok(!pdf.pages.some((p) => /ISSUED FOR/.test(p.text)));
  });
});

describe("plans that are not available", () => {
  test("a missing or unreadable page renders the frame and still tags every device", async () => {
    const design = fixtureDesign();
    const plans = await fixturePlans(design);
    for (const planPage of [
      async (s: string) => (s === "T-201" ? null : plans[s]),
      async (s: string) => { if (s === "T-201") throw new Error("store down"); return plans[s]; },
      async (s: string) => (s === "T-201" ? { pdf: new Uint8Array([1, 2, 3]), pageIndex: 0 } : plans[s]),
      async (s: string) => (s === "T-201" ? { pdf: plans[s].pdf, pageIndex: 7 } : plans[s]),
    ]) {
      const out = await render(design, plans, { planPage });
      const pdf = await readPdf(out.pdf);
      const i = out.sheets.findIndex((s) => s.number === "I-1.2");
      assert.match(pdf.pages[i].text, /PLAN NOT AVAILABLE/);
      for (const d of design.devices.filter((x) => x.sheet === "T-201")) assert.ok(pdf.pages[i].tokens.has(d.tag), d.tag);
      const j = out.sheets.findIndex((s) => s.number === "I-1.1");
      assert.ok(!/PLAN NOT AVAILABLE/.test(pdf.pages[j].text), "the available plan still draws");
    }
  });
});

describe("pagination at size", () => {
  test("many cables and racks paginate, every label still listed, pages stay tabloid", async () => {
    const base = fixtureDesign();
    const design: InstallDesign = structuredClone(base);
    // five times the cables (new labels) and two more racks cloned from the IDF
    for (let k = 1; k <= 4; k++) {
      for (const c of base.cables) design.cables.push({ ...structuredClone(c), label: `${c.label}-${k}` });
    }
    for (const id of ["RK-301", "RK-401"]) {
      const r = structuredClone(base.racks[1]);
      r.id = id;
      r.name = `${id} closet`;
      r.items = r.items.map((it) => ({ ...it, tag: `${it.tag}-${id}` }));
      design.racks.push(r);
      for (const it of r.items) {
        const src = base.equipment.find((e) => e.tag === it.tag.replace(`-${id}`, ""));
        if (src) design.equipment.push({ ...structuredClone(src), tag: it.tag, rack: id, location: id });
      }
    }
    const plans = await fixturePlans(base);
    const t0 = Date.now();
    const out = await render(design, plans);
    const ms = Date.now() - t0;
    const pdf = await readPdf(out.pdf);
    assert.ok(ms < 20000, `rendered in ${ms} ms`);
    assert.equal(pdf.pages.length, out.sheets.length);
    for (const p of pdf.pages) assert.deepEqual([Math.round(p.w), Math.round(p.h)], [1224, 792]);
    const sched = out.sheets.map((s, i) => (s.number.startsWith("I-3.") ? i : -1)).filter((i) => i >= 0);
    assert.ok(sched.length >= 6, `${sched.length} schedule sheets for ${design.cables.length} cables`);
    const tokens = new Set(sched.flatMap((i) => [...pdf.pages[i].tokens]));
    for (const c of design.cables) assert.ok(tokens.has(c.label), c.label);
    assert.equal(out.sheets.filter((s) => s.number.startsWith("I-4.")).length, 4);
    for (const id of ["RK-301", "RK-401"]) assert.ok(out.sheets.some((s) => s.number.startsWith("I-5.") && s.title.includes(id)), `signal flow for ${id}`);
  });
});

describe("plan geometry", () => {
  test("the viewport transform matches pdf.js for every rotation and an offset view box", async () => {
    const doc = await PDFDocument.create();
    const cases = [0, 90, 180, 270].map((rot) => ({ rot, box: [30, 50, 830, 650] as const }));
    for (const c of cases) {
      const p = doc.addPage([900, 700]);
      p.setMediaBox(c.box[0], c.box[1], c.box[2] - c.box[0], c.box[3] - c.box[1]);
      p.setRotation(degrees(c.rot));
      p.drawText("x", { x: 100, y: 100, size: 8 });
    }
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const js = await openPdf(bytes);
    for (let i = 0; i < cases.length; i++) {
      const vp = (await js.getPage(i + 1)).getViewport({ scale: 1 });
      const g = planGeometry(reloaded.getPage(i));
      assert.equal(g.rotation, cases[i].rot);
      assert.deepEqual(g.transform.map((v) => Math.round(v * 1000) / 1000), vp.transform.map((v: number) => Math.round(v * 1000) / 1000), `rotation ${cases[i].rot}`);
      assert.deepEqual([g.width, g.height], [vp.width, vp.height]);
    }
    await js.destroy();
    assert.deepEqual(viewportTransform([0, 0, 1152, 1728], 90).transform, [0, 1, 1, 0, 0, 0]);
  });

  test("mounting heights parse from the usual wordings", () => {
    assert.equal(parseInchesAff("18 in. AFF to center"), 18);
    assert.equal(parseInchesAff("9 ft AFF"), 108);
    assert.equal(parseInchesAff("7'-6\" AFF"), 90);
    assert.equal(parseInchesAff("48\" to top"), 48);
    assert.equal(parseInchesAff("Ceiling"), null);
  });
});
