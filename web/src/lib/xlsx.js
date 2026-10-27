// Minimal SpreadsheetML (.xlsx) writer — hand-rolled, zipped with fflate
// (already a dependency; lazy-loaded like the ingest zip path — see #16).
// No SheetJS (stale npm package with CVEs), no exceljs (~1MB).
//
// Scope: exactly what the takeoff report needs — multiple worksheets of plain
// cells. Strings go out as inline strings (<c t="inlineStr"><is><t>…), numbers
// as plain <v>; no shared-strings table, no formulas (so pasted "=..." finish
// tags can never execute — inline strings are inert text), no column widths.
// A minimal styles.xml ships because Excel expects the part to exist.
//
// The workbook builder (reportWorkbook) reads the SAME sources as the CSV/JSON
// exports — conditionTotals rows through GETTERS, sheetTotals via roundSheetRow,
// materialsSummary, shapesDetail — so the four tabs carry the same numbers as
// the on-screen table: waste applied only to order quantities, never measured.

import { GETTERS, colGetter, applyUnits, METRIC_CSV_LABELS } from "./reportColumns.js";
import { grandTotals, materialsSummary, roundSheetRow, hasMultipliers, BY_SHEET_BASE_NOTE, materialCoverage, materialNote } from "./totals.js";
import { cableTables } from "./cable.js";
import { round2 } from "./num.js";
import { M_PER_FT, M2_PER_SF } from "./units";

// ---------------------------------------------------------------------------
// XML plumbing

// Escape a value for XML text/attribute content. Also strips control chars
// that are illegal in XML 1.0 (condition names are user data — a pasted \x00
// must not produce a file Excel refuses to open). Keeps \t \n \r.
export function escXml(v) {
  return String(v)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // eslint-disable-line no-control-regex
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 0 → A, 25 → Z, 26 → AA … (spreadsheet column letters)
export function colLetter(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

// Excel sheet-name rules: non-empty, ≤31 chars, no [ ] : * ? / \ , unique
// within the workbook (case-insensitive), no leading/trailing apostrophe.
// `used` is a Set of lower-cased names already taken; the returned name is
// added to it.
export function sanitizeSheetName(name, used = new Set()) {
  let s = String(name ?? "").replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim();
  if (!s) s = "Sheet";
  s = s.slice(0, 31).trim();
  let candidate = s;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = s.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// One worksheet part from rows of cell values (array of arrays).
//   number (finite)      → <c r=… ><v>…</v></c>
//   null / undefined / "" → cell skipped entirely
//   anything else         → inline string, XML-escaped
export function sheetXml(rows) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((cells, ri) => {
    out.push(`<row r="${ri + 1}">`);
    cells.forEach((v, ci) => {
      if (v === null || v === undefined || v === "") return;
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else {
        const t = escXml(v);
        // preserve leading/trailing whitespace the way Excel expects
        const sp = /^\s|\s$/.test(String(v)) ? ' xml:space="preserve"' : "";
        out.push(`<c r="${ref}" t="inlineStr"><is><t${sp}>${t}</t></is></c>`);
      }
    });
    out.push("</row>");
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

// The bare-minimum stylesheet — Excel treats fillId 0 (none) and 1 (gray125)
// as reserved, so both ship even though no cell references a style.
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// ---------------------------------------------------------------------------
// Workbook assembly

// The authorship stamp (opt-in): docProps/core.xml dc:creator plus
// docProps/app.xml Application. The MCP server stamps "OpenTakeoff" so its
// overwrite guard (mcp/src/safewrite.ts) can recognize a workbook it wrote.
// Excel and LibreOffice rewrite Application (and add lastModifiedBy) when
// they save, which is what tells a workbook the estimator edited apart from
// ours. With no producer the package is the canvas download it always was.
const coreXml = (producer) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  `<dc:creator>${escXml(producer)}</dc:creator></cp:coreProperties>`;
const appXml = (producer) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  `<Application>${escXml(producer)}</Application></Properties>`;

/**
 * Zip sheet definitions into an .xlsx byte array.
 * @param {Array<{name: string, rows: any[][]}>} sheets one entry per tab, in order
 * @param {{producer?: string}} [opts] producer: stamp docProps (dc:creator and
 *   Application) with this name. Omitted (the canvas): no docProps parts.
 * @returns {Promise<Uint8Array>} download with MIME
 *   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 */
export async function buildXlsx(sheets, opts = {}) {
  const { zipSync, strToU8 } = await import("fflate"); // lazy — same pattern as ingest.js
  const producer = opts.producer ? String(opts.producer) : "";
  const used = new Set();
  const names = sheets.map((s) => sanitizeSheetName(s.name, used));

  const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    ...(producer ? ['<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'] : []),
    "</Types>"].join("");

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    (producer ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' : "") +
    "</Relationships>";

  const workbook = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
    ...names.map((name, i) => `<sheet name="${escXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`),
    "</sheets></workbook>"].join("");

  const wbRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"].join("");

  const files = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(wbRels),
    "xl/styles.xml": strToU8(STYLES_XML),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows)); });
  if (producer) {
    files["docProps/core.xml"] = strToU8(coreXml(producer));
    files["docProps/app.xml"] = strToU8(appXml(producer));
  }
  return zipSync(files);
}

/**
 * Read a workbook's authorship stamp back: dc:creator and cp:lastModifiedBy
 * from docProps/core.xml, Application from docProps/app.xml. Null when the
 * bytes are not a zip; a field the package does not carry reads null. Only
 * the two docProps parts are inflated.
 * @param {Uint8Array} bytes
 * @returns {Promise<{creator: string|null, lastModifiedBy: string|null, application: string|null}|null>}
 */
export async function xlsxProvenance(bytes) {
  const { unzipSync, strFromU8 } = await import("fflate");
  let parts;
  try {
    parts = unzipSync(bytes, { filter: (f) => f.name === "docProps/core.xml" || f.name === "docProps/app.xml" });
  } catch {
    return null;
  }
  const field = (part, re) => {
    if (!parts[part]) return null;
    const m = re.exec(strFromU8(parts[part]));
    return m ? m[1].trim() : null;
  };
  return {
    creator: field("docProps/core.xml", /<dc:creator>([^<]*)<\/dc:creator>/),
    lastModifiedBy: field("docProps/core.xml", /<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/),
    application: field("docProps/app.xml", /<Application>([^<]*)<\/Application>/),
  };
}

// ---------------------------------------------------------------------------
// The takeoff report workbook: Conditions / By sheet / Materials / Shapes /
// By floor × room

/**
 * Map the report's data sources onto the workbook tabs. Pure (no fflate)
 * so tests can assert the cell values directly.
 * @param {object} args
 * @param {any[]} args.rows conditionTotals() rows (shapeless conditions filtered out)
 * @param {Array<{sheet_id: any, rows: any[]}>} args.bySheet sheetTotals() result
 * @param {any[]} args.shapeRows shapesDetail() result
 * @param {Array<{sheet_id: any, groups: any[]}>} [args.byFloorRoom]
 *   sheetLabelGroupedRows() result — the floor × room cross-section. Empty
 *   (the default) still emits the tab, with its header row alone: the workbook
 *   keeps a fixed tab list so a consumer never has to test for a sheet's
 *   existence.
 * @param {Array<{key: string, header: string}>} [args.cols] visible CSV_PROFILE
 *   columns — the Conditions tab honors the same column picker the CSV uses
 * @param {{perimByCond?: Map<any, number>, attrsByCond?: Map<any, object>, specByCond?: Map<any, object>}|null}
 *   [args.ctx] handed to the getters
 * @param {((sheetId: any) => string)|null} [args.sheetLabel]
 * @param {"imperial"|"metric"} [args.units] display units — "metric" converts
 *   the Conditions, By-sheet, floor × room, and Shapes tabs to m2/m (SY retires)
 *   exactly like the CSV. "imperial" (default) is byte-identical.
 * @param {object|null} [args.cable] computeCableTakeoff() result (lib/cable.js):
 *   appends the "Cable summary" and "Cable runs" tabs. The fixed five-tab list
 *   above is unchanged; these two exist ONLY when a cable condition exists, so
 *   a project without one gets the same workbook it always did. A third,
 *   "Pathway", follows only once a route condition is tagged trunk or branch;
 *   "Cable order" (boxes / reels per cable type) only once a condition
 *   states package_ft.
 * @returns {Array<{name: string, rows: any[][]}>}
 */
export function reportWorkbook({ rows = [], bySheet = [], shapeRows = [], cols = null, ctx = null, sheetLabel = null, units = "imperial", byFloorRoom = [], cable = null }) {
  const columns = applyUnits(cols || [], units, METRIC_CSV_LABELS);
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  const M = units === "metric";
  const AU = M ? "m2" : "SF", LU = M ? "m" : "LF";
  const A = (v) => (M ? round2((Number(v) || 0) * M2_PER_SF) : v);
  const L = (v) => (M ? round2((Number(v) || 0) * M_PER_FT) : v);

  // Conditions — same columns, getters, and TOTAL row as totalsToCsv (per-
  // column get, i.e. custom columns, falls back to the shared GETTERS; a
  // metric descriptor carries `conv` so the by-key TOTAL reads convert too)
  const conditions = [columns.map((c) => c.header)];
  for (const r of rows) conditions.push(columns.map((c) => colGetter(c)?.(r, ctx)));
  const g = grandTotals(rows);
  conditions.push(columns.map((c) => {
    if (c.key === "finish") return "TOTAL";
    const v = (c.key === "waste_sf" || c.key === "waste_lf") ? GETTERS[c.key](g) : (g[c.key] !== undefined ? g[c.key] : "");
    return c.conv && v !== "" ? c.conv(v) : v;
  }));

  // By sheet — base (unmultiplied) quantities, rounded at serialization only
  const bySheetRows = [["Sheet", "Sheet ID", "Finish", `Floor ${AU}`, `Wall ${AU}`, `Border ${AU}`, LU, "EA"]];
  for (const gp of bySheet) {
    for (const row of gp.rows) {
      const mult = row.multiplier || 1;
      const finish = mult > 1 ? `${row.finish_tag} ×${mult}` : row.finish_tag;
      const r = roundSheetRow(row);
      bySheetRows.push([String(label(gp.sheet_id)), String(gp.sheet_id), finish, A(r.floor_sf), A(r.wall_sf), A(r.border_sf), L(r.lf), r.ea]);
    }
  }
  if (hasMultipliers(bySheet)) bySheetRows.push([], [BY_SHEET_BASE_NOTE]);

  // Materials — per condition, then the combined buy list (mirrors the CSV)
  const materials = [["Finish", "Material", "Qty", "Unit", "Coverage", "Note"]];
  for (const r of rows) for (const m of (r.materials || [])) {
    materials.push([r.finish_tag, m.name, m.qty, m.unit, materialCoverage(m), materialNote(m)]);
  }
  const combined = materialsSummary(rows);
  if (combined.length) {
    materials.push([], ["Material (combined)", "Qty", "Unit"]);
    for (const s of combined) materials.push([s.name, s.qty, s.unit]);
  }

  // Shapes — measured only: no multiplier, no waste (shapesDetail semantics).
  // Metric display mode mirrors the standalone shapes CSV. The JSON keeps the
  // machine-readable raw-foot field names.
  const shapesTab = [
    ["Per-shape measured quantities — no multiplier or waste; standalone deducts negative; reconciled cutouts stay as audit rows with zero additive area because the parent is already net; LF on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition LF"],
    ["Shape", "Sheet", "Sheet ID", "Finish", "Role", `Area ${AU}`, LU, "EA", `Height ${M ? "m" : "ft"}`, "Height override", `Rise ${M ? "m" : "ft"}`, `Drop ${M ? "m" : "ft"}`, "Origin"],
  ];
  for (const r of shapeRows) {
    shapesTab.push([String(r.shape_id), String(r.sheet), String(r.sheet_id), r.finish, r.role,
      A(r.area_sf), L(r.lf), r.ea, L(r.height_ft), r.height_override ? "yes" : "", L(r.rise_ft ?? 0), L(r.drop_ft ?? 0), r.origin]);
  }

  // By floor × room — the cross-section the other tabs each flatten one axis
  // out of: Conditions totals the job, By sheet totals the floor, and this
  // says what goes down in THAT room on THAT floor. ORDERED quantities per
  // cell (waste % and ×N applied per slice, like the report's grouped views
  // and unlike the base By-sheet tab above), so a room's numbers are the ones
  // that get bought — and every shape a floor carries appears under one of
  // its rooms or under its Unlabeled roll-up, so a floor's rooms add back up
  // to the floor. Cells are one row per (floor, room, finish); the Sheet ID
  // rides along because display labels are session-volatile.
  const floorRoom = [
    ["Ordered quantities per floor × room — waste % and xN applied per slice; each floor's rooms reconcile to that floor's shapes. Coverage ceils are per-cell display, not a buy list"],
    ["Sheet", "Sheet ID", "Room", "Finish", `Floor ${AU}`, `Wall ${AU}`, `Border ${AU}`, LU, "EA", `Total ${AU}`, `Total ${AU} w/Waste`],
  ];
  for (const gp of byFloorRoom) {
    for (const grp of gp.groups) {
      for (const row of grp.rows) {
        floorRoom.push([String(label(gp.sheet_id)), String(gp.sheet_id), grp.label, row.finish_tag,
          A(row.floor_sf), A(row.wall_sf), A(row.border_sf), L(row.lf), row.ea,
          A(row.total_sf), A(row.total_sf_net)]);
      }
    }
  }

  // Cable summary / Cable runs (Division 27) — full-precision cells, the same
  // matrices the CSV sections print (lib/cable.js cableTables), so a bid
  // workbook can reference them directly. The Unlinked list rides at the foot
  // of the summary tab, and a leg warning prints above it.
  const cableTabs = [];
  const cableT = cableTables(cable, { sheetLabel, L, lengthUnit: LU });
  if (cableT) {
    const summary = [...cableT.warnings.map((w) => [w]), ...cableT.summary];
    if (cableT.unlinked.length > 1) summary.push([], ["Unlinked"], ...cableT.unlinked);
    cableTabs.push({ name: "Cable summary", rows: summary }, { name: "Cable runs", rows: cableT.runs });
    // "Pathway" (trunk/branch, each segment once) exists only once a route
    // condition is tagged trunk or branch — the J-hook / tray basis
    if (cableT.pathway) cableTabs.push({ name: "Pathway", rows: cableT.pathway });
    // "Cable order" (boxes / reels per cable type) exists only once a
    // condition states package_ft
    if (cableT.order) cableTabs.push({ name: "Cable order", rows: cableT.order });
  }

  return [
    { name: "Conditions", rows: conditions },
    { name: "By sheet", rows: bySheetRows },
    { name: "Materials", rows: materials },
    { name: "Shapes", rows: shapesTab },
    { name: "By floor × room", rows: floorRoom },
    ...cableTabs,
  ];
}
