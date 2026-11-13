// A small method + path router for /api. Routes are declared with `:param`
// segments; a param can carry a validator. A path that matches with another
// method answers 405 with an Allow header, so adding a write endpoint later is
// one more `router.post(...)` / `router.put(...)` line.
import type { Env } from "../env.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (c: RouteContext) => Promise<Response> | Response;

interface Route {
  method: Method;
  parts: string[];
  handler: Handler;
}

export type ParamValidator = (value: string) => string | null;

export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly validators: Record<string, ParamValidator> = {}) {}

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  add(method: Method, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  /** The route for this request; null when no path matches. */
  async handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);
    const allowed = new Set<Method>();
    for (const r of this.routes) {
      const params = match(r.parts, segs);
      if (!params) continue;
      // HEAD is answered as GET (the body is dropped by the runtime).
      if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) {
        allowed.add(r.method);
        continue;
      }
      for (const [k, v] of Object.entries(params)) {
        const problem = this.validators[k]?.(v);
        if (problem) return json({ error: problem }, 400);
      }
      return r.handler({ req, env, ctx, url, params });
    }
    if (allowed.size) return json({ error: "method not allowed" }, 405, { allow: [...allowed].join(", ") });
    return null;
  }
}

function match(parts: string[], segs: string[]): Record<string, string> | null {
  if (parts.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const s = segs[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return params;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
