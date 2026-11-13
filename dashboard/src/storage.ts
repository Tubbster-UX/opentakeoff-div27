// Supabase Storage, from the Worker only. Plan PDFs live in the private bucket
// `brink-plans` (brink-merge's takeoff migration creates it). The service-role key
// is a Worker secret: it never reaches the browser, which reads a sheet through
// GET /api/projects/:id/sheets/:sheet/file (a same-origin proxy of the object).
//
// Storage's REST API (https://supabase.com/docs/reference/api, storage-api):
//   POST   /storage/v1/object/<bucket>/<path>   upload (x-upsert: false: never overwrite)
//   GET    /storage/v1/object/<bucket>/<path>   download (authenticated)
// An object, once written, is never replaced: a new revision of a file gets a new
// path (<project>/<sheet row>/<sha256>.pdf).

/** The Worker variables Storage needs (part of Env). */
export interface StorageEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export const PLANS_BUCKET = "brink-plans";

export class StorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function base(env: StorageEnv): { url: string; headers: Record<string, string> } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new StorageError(503, "plan storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return { url: env.SUPABASE_URL.replace(/\/+$/, ""), headers: { authorization: `Bearer ${key}`, apikey: key } };
}

const objectUrl = (url: string, bucket: string, path: string) => `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Upload bytes to a new object. An object already at that path (the same bytes, by its sha256 name) counts as written. */
export async function putObject(env: StorageEnv, bucket: string, path: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  const { url, headers } = base(env);
  const res = await fetch(objectUrl(url, bucket, path), {
    method: "POST",
    headers: { ...headers, "content-type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" },
    body: bytes,
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  // Storage answers a duplicate with 400/409 and "Duplicate" / "already exists": content-addressed, so it is the same file.
  if ((res.status === 409 || res.status === 400) && /duplicate|already exists/i.test(text)) return;
  throw new StorageError(res.status >= 500 ? 502 : res.status, `storage upload failed (${res.status}): ${text.slice(0, 200)}`);
}

/** Stream an object back. */
export async function getObject(env: StorageEnv, bucket: string, path: string): Promise<Response> {
  const { url, headers } = base(env);
  const res = await fetch(objectUrl(url, bucket, path), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new StorageError(res.status === 404 || res.status === 400 ? 404 : 502, `storage read failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res;
}
