// The Takeoff tab's calls to the Worker (dashboard/src/takeoff.ts). Same origin; the
// Access JWT rides the request as a cookie / header that Cloudflare Access sets, so
// nothing here holds a credential.
import type { SheetSummary, SheetUploadResponse, TakeoffEditRequest, TakeoffEditResponse, TakeoffView } from "../../../src/shared/protocol.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function check<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  throw new ApiError(res.status, typeof body.error === "string" ? body.error : `request failed (${res.status})`, body);
}

export interface TakeoffApi {
  readTakeoff(): Promise<TakeoffView>;
  listSheets(): Promise<SheetSummary[]>;
  sheetBytes(sheetId: string): Promise<Uint8Array>;
  uploadSheet(name: string, bytes: ArrayBuffer, pages: number | null, clientRef: string): Promise<SheetUploadResponse>;
  removeSheet(sheetId: string): Promise<{ removed: boolean }>;
  saveEdits(req: TakeoffEditRequest): Promise<TakeoffEditResponse>;
}

export function takeoffApi(projectId: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): TakeoffApi {
  const base = `/api/projects/${projectId}`;
  return {
    readTakeoff: async () => check<TakeoffView>(await fetchImpl(`${base}/takeoff`, { cache: "no-store" })),
    listSheets: async () => (await check<{ sheets: SheetSummary[] }>(await fetchImpl(`${base}/sheets`, { cache: "no-store" }))).sheets,
    sheetBytes: async (sheetId) => {
      const res = await fetchImpl(`${base}/sheets/${sheetId}/file`);
      if (!res.ok) await check(res);
      return new Uint8Array(await res.arrayBuffer());
    },
    uploadSheet: async (name, bytes, pages, clientRef) => {
      const q = new URLSearchParams({ name, ...(pages ? { pages: String(pages) } : {}) });
      return check<SheetUploadResponse>(await fetchImpl(`${base}/sheets?${q}`, { method: "POST", headers: { "content-type": "application/pdf", "x-brink-client": clientRef }, body: bytes }));
    },
    removeSheet: async (sheetId) => check<{ removed: boolean }>(await fetchImpl(`${base}/sheets/${sheetId}`, { method: "DELETE", headers: { "content-type": "application/json" } })),
    saveEdits: async (req) => check<TakeoffEditResponse>(await fetchImpl(`${base}/takeoff/edits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) })),
  };
}
