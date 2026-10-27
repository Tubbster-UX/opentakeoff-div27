// export_report's Excel workbook — the canvas Report's Excel export, written
// from this session. The tabs come from web/src/lib/xlsx.js reportWorkbook and
// the bytes from its buildXlsx: the SAME code the canvas's Excel button runs,
// one implementation for both surfaces (the marked.ts / markedset.js pattern).
// What this module contributes is the destination (default name, overwrite
// guard) and the authorship stamp that lets the guard recognize its own file.
import path from "node:path";
import { reportWorkbook as reportWorkbookJs, buildXlsx as buildXlsxJs, sanitizeSheetName } from "../../web/src/lib/xlsx.js";
import { UserError } from "./format.ts";
import { assertWritable, XLSX_PRODUCER } from "./safewrite.ts";
import type { Session } from "./session.ts";

// The builders are untyped canvas JS; tsc infers parameter types from their
// destructuring defaults (cable = null ⇒ "null only"), so a typed facade at
// the boundary states the real contract instead (the marked.ts precedent).
type WorkbookSheet = { name: string; rows: unknown[][] };
const reportWorkbook = reportWorkbookJs as unknown as (args: Record<string, unknown>) => WorkbookSheet[];
const buildXlsx = buildXlsxJs as unknown as (sheets: WorkbookSheet[], opts?: { producer?: string }) => Promise<Uint8Array>;

/** `<plan dir>/<plan base> - report.xlsx`, the export_marked_pdf naming. */
export function defaultWorkbookPath(session: Session): string {
  const { file, filePath } = session;
  if (!file || !filePath) throw new UserError("No plan loaded — call load_plan first.");
  return path.join(path.dirname(filePath), `${file.replace(/\.pdf$/i, "")} - report.xlsx`);
}

export interface ReportWorkbook {
  path: string;
  tabs: string[];
  bytes: Uint8Array;
}

/** Build the workbook for `outPath` (or the default) after checking the
 * destination; writes nothing — the caller writes once every destination of
 * the call has passed its own check. */
export async function buildReportWorkbook(session: Session, outPath: string | undefined, overwrite?: boolean): Promise<ReportWorkbook> {
  const args = session.reportWorkbookArgs();
  const dest = path.resolve(outPath ?? defaultWorkbookPath(session));
  await assertWritable(dest, "xlsx", overwrite);
  const sheets = reportWorkbook(args);
  let bytes: Uint8Array;
  try {
    bytes = await buildXlsx(sheets, { producer: XLSX_PRODUCER });
  } catch (e) {
    // fflate is a runtime dependency of the server (package.json); an install
    // that predates it fails here and only here, so say how to fix it
    const err = e as { code?: string; message?: string };
    if (err?.code === "ERR_MODULE_NOT_FOUND" && /fflate/.test(String(err.message))) {
      throw new UserError("The workbook writer needs the fflate package, which this install is missing — run `npm install` in the mcp folder (or reinstall opentakeoff-mcp), then export again. The JSON report needs nothing extra: call export_report without xlsx.");
    }
    throw e;
  }
  // the tab names as Excel shows them (buildXlsx sanitizes the same way)
  const used = new Set<string>();
  const tabs = sheets.map((s) => sanitizeSheetName(s.name, used) as string);
  return { path: dest, tabs, bytes };
}
