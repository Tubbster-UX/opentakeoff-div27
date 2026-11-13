// A small Portal HTTP client: bearer auth from a refresh token, proactive
// refresh before the access token's exp, one refresh-and-retry on a 401.
// Credentials and tokens live only in this object's memory: they are never
// logged, returned, or written anywhere, and error text is redacted.
import { loginRequest, refreshRequest, requestUrl, type PortalConfig, type PortalRequest } from "./requests.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export type PortalCredentials = { userName: string; password: string } | { refreshToken: string };

/** Credentials from the environment only: PORTAL_REFRESH_TOKEN, else PORTAL_USERNAME + PORTAL_PASSWORD. */
export function credentialsFromEnv(env: Record<string, string | undefined>): PortalCredentials | null {
  if (env.PORTAL_REFRESH_TOKEN) return { refreshToken: env.PORTAL_REFRESH_TOKEN };
  if (env.PORTAL_USERNAME && env.PORTAL_PASSWORD) return { userName: env.PORTAL_USERNAME, password: env.PORTAL_PASSWORD };
  return null;
}

export class PortalHttpError extends Error {
  constructor(readonly status: number, readonly method: string, readonly path: string, detail: string) {
    super(`Portal ${method} ${path} -> HTTP ${status}${detail ? `: ${detail}` : ""}`);
  }
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Strip anything token-shaped plus the given secrets from text bound for output. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let s = text.replace(JWT, "<redacted>");
  for (const x of secrets) if (x && x.length >= 4) s = s.split(x).join("<redacted>");
  return s;
}

/** exp (seconds since epoch) from a JWT, or null when it is not a readable JWT. */
export function jwtExp(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Refresh this long before exp. */
const REFRESH_MARGIN_S = 30;
/** Assumed lifetime when the access token carries no readable exp (observed ~300 s). */
const ASSUMED_LIFETIME_S = 300;

export class PortalClient {
  private refreshToken: string | null;
  private accessToken: string | null = null;
  private accessExp = 0;
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(private readonly cfg: PortalConfig, private readonly creds: PortalCredentials, opts: { fetch: FetchLike; now?: () => number }) {
    this.fetch = opts.fetch;
    this.now = opts.now ?? (() => Date.now());
    this.refreshToken = "refreshToken" in creds ? creds.refreshToken : null;
  }

  private secrets(): (string | null)[] {
    return [this.accessToken, this.refreshToken, "password" in this.creds ? this.creds.password : null];
  }

  private async raw(r: PortalRequest, token: string | null): Promise<{ status: number; ok: boolean; text: string }> {
    const headers: Record<string, string> = { Accept: "application/json", ...(r.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(r.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetch(requestUrl(this.cfg, r), { method: r.method, headers, ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}) });
    return { status: res.status, ok: res.ok, text: await res.text() };
  }

  private async login(): Promise<void> {
    if (!("password" in this.creds)) throw new Error("Portal: the refresh token was rejected and no username / password is set");
    const res = await this.raw(loginRequest(this.creds.userName, this.creds.password), null);
    // never echo a login response body: it carries tokens
    if (!res.ok) throw new PortalHttpError(res.status, "POST", "/authenticate/login", "login refused");
    const body = parse(res.text) as { refreshToken?: unknown } | null;
    if (typeof body?.refreshToken !== "string" || !body.refreshToken) throw new Error("Portal login: the response has no refreshToken");
    this.refreshToken = body.refreshToken;
  }

  /** Get a fresh access token from the refresh token (logging in first when there is none). */
  async refresh(): Promise<void> {
    let fresh = false;
    if (!this.refreshToken) {
      await this.login();
      fresh = true;
    }
    let res = await this.raw(refreshRequest(this.refreshToken!), null);
    if (res.status === 401 && !fresh && "password" in this.creds) {
      // the refresh token itself expired: log in again once
      await this.login();
      res = await this.raw(refreshRequest(this.refreshToken!), null);
    }
    if (!res.ok) throw new PortalHttpError(res.status, "POST", "/access-token", "access-token refresh refused");
    const body = parse(res.text) as { accessToken?: unknown } | null;
    if (typeof body?.accessToken !== "string" || !body.accessToken) throw new Error("Portal access-token: the response has no accessToken");
    this.accessToken = body.accessToken;
    this.accessExp = jwtExp(body.accessToken) ?? Math.floor(this.now() / 1000) + ASSUMED_LIFETIME_S;
  }

  private async ensureToken(): Promise<string> {
    if (!this.accessToken || this.now() / 1000 >= this.accessExp - REFRESH_MARGIN_S) await this.refresh();
    return this.accessToken!;
  }

  /** Send an authenticated request; returns the parsed JSON body (null for an empty body). */
  async send<T = unknown>(r: PortalRequest): Promise<T> {
    let res = await this.raw(r, await this.ensureToken());
    if (res.status === 401) {
      await this.refresh();
      res = await this.raw(r, this.accessToken);
    }
    if (!res.ok) throw new PortalHttpError(res.status, r.method, r.path, redact(res.text.slice(0, 300), this.secrets()));
    return parse(res.text) as T;
  }
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
