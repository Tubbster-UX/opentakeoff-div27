// Owner login and the OAuth 2.1 authorization server for the Claude connector.
//
// - Owner password: scrypt ("scrypt$N$r$p$saltB64$hashB64"), timing-safe verify.
// - Owner session: stateless HMAC-signed cookie (30 days). Rotating
//   SESSION_SECRET signs every browser out.
// - Login rate limiting: per IP and global, attempts counted before the
//   password is checked (so parallel guesses cannot slip past), exponential
//   lockout, and a cap on concurrent scrypt runs.
// - OAuth: the MCP SDK's handlers (/authorize, /token, /register, /revoke and
//   the RFC 8414 / RFC 9728 metadata) over BrinkOAuthProvider below. Clients and
//   tokens live in the store under system/oauth/; tokens are stored only as
//   sha256 hashes. PKCE S256 is mandatory and checked here; codes are single
//   use (a replayed code revokes what it issued); refresh tokens rotate and a
//   reused one revokes its whole family.
import crypto from "node:crypto";
import express from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config, Storage } from "./types.ts";
import { decodeSecret, loadRedirectHosts, parsePasswordHash } from "./config.ts";

// ── constants ────────────────────────────────────────────────────────────────

export const SESSION_TTL_SEC = 30 * 24 * 3600;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 60 * 24 * 3600;
/** The consent form must be submitted within this long of /authorize. */
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Unauthorized (never consented) clients are swept after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 3600 * 1000;
const SCOPES = ["mcp"];
const MAX_PASSWORD_LEN = 1024;

const SCRYPT_DEFAULT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, saltLen: 16 };

// ── password hashing ────────────────────────────────────────────────────────

function scryptAsync(password: string, salt: Buffer, keyLen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * N * r * p + 16 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** "scrypt$N$r$p$saltB64$hashB64". */
export async function hashPassword(password: string, opts: { N?: number; r?: number; p?: number } = {}): Promise<string> {
  const N = opts.N ?? SCRYPT_DEFAULT.N;
  const r = opts.r ?? SCRYPT_DEFAULT.r;
  const p = opts.p ?? SCRYPT_DEFAULT.p;
  const salt = crypto.randomBytes(SCRYPT_DEFAULT.saltLen);
  const key = await scryptAsync(password.normalize("NFC"), salt, SCRYPT_DEFAULT.keyLen, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Timing-safe. False for a malformed hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (!parsed.ok) return false;
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LEN) return false;
  const key = await scryptAsync(password.normalize("NFC"), parsed.salt, parsed.key.length, parsed.N, parsed.r, parsed.p);
  return crypto.timingSafeEqual(key, parsed.key);
}

// ── small crypto helpers ────────────────────────────────────────────────────

const b64url = (buf: Buffer) => buf.toString("base64url");
const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => b64url(crypto.randomBytes(32));
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function deriveKey(secret: Buffer, label: string): Buffer {
  return crypto.createHmac("sha256", secret).update(`brink-server/${label}`).digest();
}

function mac(key: Buffer, data: string): string {
  return b64url(crypto.createHmac("sha256", key).update(data).digest());
}

// ── session cookie ──────────────────────────────────────────────────────────

/** "v1.<expiresSec>.<nonce>.<mac>" */
export function signSession(key: Buffer, expiresSec: number): string {
  const body = `v1.${expiresSec}.${b64url(crypto.randomBytes(12))}`;
  return `${body}.${mac(key, `session|${body}`)}`;
}

export function verifySession(key: Buffer, value: string | undefined, nowSec: number): boolean {
  if (!value || value.length > 200) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{1,12}$/.test(parts[1])) return false;
  const body = parts.slice(0, 3).join(".");
  if (!safeEqual(parts[3], mac(key, `session|${body}`))) return false;
  return Number(parts[1]) > nowSec;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

// ── login rate limiting ─────────────────────────────────────────────────────

export interface AuthLimits {
  /** Failed attempts per IP before the lockout starts. */
  ipFree: number;
  /** First lockout; doubles per further failure. */
  ipBaseMs: number;
  ipMaxMs: number;
  /** An IP with no attempt for this long starts fresh. */
  ipResetMs: number;
  /** Failed attempts from everyone within globalWindowMs that lock all logins. */
  globalMax: number;
  globalWindowMs: number;
  globalLockMs: number;
  globalMaxLockMs: number;
  /** Concurrent password checks (each scrypt uses ~32 MiB). */
  maxConcurrent: number;
  /** Invalid bearer tokens per IP per window before 429. */
  bearerFailMax: number;
  bearerWindowMs: number;
  /** Client registrations from everyone per hour. */
  registerGlobalPerHour: number;
}

export const DEFAULT_LIMITS: AuthLimits = {
  ipFree: 5,
  ipBaseMs: 30_000,
  ipMaxMs: 3600_000,
  ipResetMs: 3600_000,
  globalMax: 50,
  globalWindowMs: 15 * 60_000,
  globalLockMs: 5 * 60_000,
  globalMaxLockMs: 3600_000,
  maxConcurrent: 4,
  bearerFailMax: 100,
  bearerWindowMs: 10 * 60_000,
  registerGlobalPerHour: 100,
};

export class LoginLimiter {
  private ips = new Map<string, { fails: number; lockedUntil: number; last: number }>();
  private globalFails: number[] = [];
  private globalLockedUntil = 0;
  private globalLevel = 0;
  private inFlight = 0;
  constructor(
    private limits: AuthLimits,
    private now: () => number,
  ) {}

  /**
   * Call before checking a password. Counts the attempt as a failure up front;
   * `succeeded` undoes that. Returns a retry delay when locked or busy.
   */
  begin(ip: string): { ok: true; release: () => void } | { ok: false; retryAfterMs: number; busy?: boolean } {
    const now = this.now();
    const L = this.limits;
    if (now < this.globalLockedUntil) return { ok: false, retryAfterMs: this.globalLockedUntil - now };
    if (this.globalLevel > 0 && now - this.globalLockedUntil > 6 * 3600_000) this.globalLevel = 0;
    let e = this.ips.get(ip);
    if (e && now - e.last > L.ipResetMs && now >= e.lockedUntil) {
      this.ips.delete(ip);
      e = undefined;
    }
    if (e && now < e.lockedUntil) return { ok: false, retryAfterMs: e.lockedUntil - now };
    if (this.inFlight >= L.maxConcurrent) return { ok: false, retryAfterMs: 2000, busy: true };
    if (!e) {
      if (this.ips.size > 10_000) this.prune(now);
      e = { fails: 0, lockedUntil: 0, last: now };
      this.ips.set(ip, e);
    }
    e.fails++;
    e.last = now;
    if (e.fails >= L.ipFree) e.lockedUntil = now + Math.min(L.ipBaseMs * 2 ** (e.fails - L.ipFree), L.ipMaxMs);
    this.globalFails.push(now);
    while (this.globalFails.length && this.globalFails[0] <= now - L.globalWindowMs) this.globalFails.shift();
    if (this.globalFails.length >= L.globalMax) {
      this.globalLevel++;
      this.globalLockedUntil = now + Math.min(L.globalLockMs * 2 ** (this.globalLevel - 1), L.globalMaxLockMs);
      this.globalFails = [];
      console.error(`brink-server auth: ${L.globalMax} failed logins in ${L.globalWindowMs / 60000} min; all password logins locked for ${Math.round((this.globalLockedUntil - now) / 1000)} s`);
    }
    this.inFlight++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.inFlight--;
        }
      },
    };
  }

  succeeded(ip: string): void {
    this.ips.delete(ip);
    this.globalFails.pop();
  }

  private prune(now: number) {
    for (const [k, v] of this.ips) if (now - v.last > this.limits.ipResetMs && now >= v.lockedUntil) this.ips.delete(k);
  }
}

/** Sliding counter keyed by IP (bearer failures). */
class FailCounter {
  private m = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number,
  ) {}
  blocked(key: string): boolean {
    const a = this.trim(key);
    return a.length >= this.max;
  }
  note(key: string): void {
    if (this.m.size > 10_000) this.m.clear();
    const a = this.trim(key);
    a.push(this.now());
    this.m.set(key, a);
  }
  private trim(key: string): number[] {
    const a = this.m.get(key) ?? [];
    const cut = this.now() - this.windowMs;
    while (a.length && a[0] <= cut) a.shift();
    if (!a.length) this.m.delete(key);
    return a;
  }
}

// ── redirect URI policy ─────────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https on an allowlisted host (default port), or http loopback on any port. */
export function redirectUriAllowed(uri: string, hosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "https:") return u.port === "" && hosts.includes(u.hostname.toLowerCase());
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return false;
}

// ── HTML ────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="auth">
<main class="auth-card">
<h1 class="brand">Brink</h1>
${body}
</main>
</body>
</html>`;
}

function pageCsp(formAction: string): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** Only same-site relative paths; everything else becomes "/". */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next.length > 2000) return "/";
  if (!/^\/(?![\/\\])[\x21-\x7e]*$/.test(next)) return "/";
  if (next.startsWith("/login") || next.startsWith("/logout")) return "/";
  return next;
}

function retryText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} seconds`;
  return `${Math.ceil(s / 60)} minutes`;
}

// ── store records ───────────────────────────────────────────────────────────

interface ClientRecord {
  client: OAuthClientInformationFull;
  /** Set on the first consent; never-consented clients are swept after a day. */
  authorized: boolean;
}

interface TokenRecord {
  kind: "access" | "refresh";
  clientId: string;
  family: string;
  scopes: string[];
  resource?: string;
  /** ms since epoch */
  exp: number;
  created: number;
  /** refresh only: when this token was exchanged (a second use revokes the family). */
  rotatedAt?: number;
}

interface FamilyRecord {
  id: string;
  clientId: string;
  created: number;
  lastRotated: number;
  revoked?: number;
  revokedReason?: string;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  resource?: string;
  exp: number;
}

const K = {
  client: (id: string) => `system/oauth/clients/${id}.json`,
  access: (hash: string) => `system/oauth/tokens/access/${hash}.json`,
  refresh: (hash: string) => `system/oauth/tokens/refresh/${hash}.json`,
  family: (id: string) => `system/oauth/tokens/families/${id}.json`,
};

// ── the provider ────────────────────────────────────────────────────────────

export interface BrinkOAuthOptions {
  storage: Storage;
  publicUrl: string;
  redirectHosts: string[];
  now: () => number;
  /** Renders the consent page for a validated authorization request. */
  renderConsent: (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) => void;
}

export class BrinkOAuthProvider implements OAuthServerProvider {
  /** PKCE is verified here (so a failed verifier also burns the code). */
  readonly skipLocalPkceValidation = true;
  readonly resources: Set<string>;
  private codes = new Map<string, CodeRecord>();
  private usedCodes = new Map<string, { exp: number; family?: string }>();
  private tokenCache = new Map<string, TokenRecord>();
  private negativeCache = new Map<string, number>();
  private familyCache = new Map<string, FamilyRecord>();
  private clientCache = new Map<string, ClientRecord>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private o: BrinkOAuthOptions) {
    this.resources = new Set([o.publicUrl, `${o.publicUrl}/mcp`, `${o.publicUrl}/mcp/brink`]);
  }

  // ── clients ──

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => (await this.getClientRecord(clientId))?.client,
      registerClient: async (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const uris = client.redirect_uris ?? [];
        if (!uris.length || uris.length > 10) throw new InvalidClientMetadataError("give 1-10 redirect_uris");
        for (const u of uris) {
          if (!redirectUriAllowed(String(u), this.o.redirectHosts)) {
            throw new InvalidClientMetadataError(
              `redirect_uri ${String(u)} is not allowed: use https on ${this.o.redirectHosts.join(", ")} or an http://localhost / http://127.0.0.1 loopback address`,
            );
          }
        }
        const full = client as OAuthClientInformationFull;
        const info: OAuthClientInformationFull = {
          ...full,
          client_id: full.client_id ?? crypto.randomUUID(),
          client_id_issued_at: full.client_id_issued_at ?? Math.floor(this.o.now() / 1000),
          client_name: cleanName(full.client_name),
        };
        const rec: ClientRecord = { client: info, authorized: false };
        await this.writeJson(K.client(info.client_id), rec);
        this.clientCache.set(info.client_id, rec);
        console.error(`brink-server auth: registered OAuth client ${info.client_id} (${info.client_name ?? "unnamed"})`);
        return info;
      },
    };
  }

  async getClientRecord(clientId: string): Promise<ClientRecord | undefined> {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return undefined;
    const cached = this.clientCache.get(clientId);
    if (cached) return cached;
    const rec = await this.readJson<ClientRecord>(K.client(clientId));
    if (!rec?.client) return undefined;
    if (this.clientCache.size > 500) this.clientCache.clear();
    this.clientCache.set(clientId, rec);
    return rec;
  }

  async markAuthorized(clientId: string): Promise<void> {
    const rec = await this.getClientRecord(clientId);
    if (!rec || rec.authorized) return;
    rec.authorized = true;
    await this.writeJson(K.client(clientId), rec);
  }

  redirectAllowed(uri: string): boolean {
    return redirectUriAllowed(uri, this.o.redirectHosts);
  }

  /** Normalized resource string if it is one of ours; undefined for absent; throws for foreign. */
  checkResource(resource: URL | string | undefined): string | undefined {
    if (resource === undefined) return undefined;
    const s = String(resource).replace(/#.*$/, "").replace(/\/$/, "");
    if (!this.resources.has(s)) throw new InvalidTargetError(`unknown resource ${String(resource)}`);
    return s;
  }

  // ── authorize ──

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.redirectAllowed(params.redirectUri)) {
      // Never redirect to a URI the policy no longer allows.
      res.status(400).type("html").setHeader("Content-Security-Policy", pageCsp("'none'"));
      res.send(renderPage("Not allowed", `<p class="error">This app's return address (${escapeHtml(params.redirectUri)}) is not allowed by this server.</p>`));
      return;
    }
    this.checkResource(params.resource);
    this.o.renderConsent(client, params, res);
  }

  /** Called by the consent form after the owner allowed. Returns the code. */
  issueCode(rec: Omit<CodeRecord, "exp">): string {
    const now = this.o.now();
    for (const [k, v] of this.codes) if (v.exp < now) this.codes.delete(k);
    for (const [k, v] of this.usedCodes) if (v.exp < now) this.usedCodes.delete(k);
    if (this.codes.size > 1000) throw new InvalidRequestError("too many pending authorizations; try again later");
    const code = randomToken();
    this.codes.set(sha256hex(code), { ...rec, exp: now + CODE_TTL_MS });
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(sha256hex(String(code)));
    if (!rec || rec.clientId !== client.client_id || rec.exp < this.o.now()) throw new InvalidGrantError("invalid authorization code");
    return rec.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const h = sha256hex(String(code));
    const rec = this.codes.get(h);
    if (!rec) {
      const used = this.usedCodes.get(h);
      if (used?.family) {
        console.error(`brink-server auth: authorization code replayed for client ${client.client_id}; revoking the tokens it issued`);
        await this.revokeFamily(used.family, "authorization code replay");
      }
      throw new InvalidGrantError("invalid or already used authorization code");
    }
    // Single use from here on, whatever happens next.
    this.codes.delete(h);
    const used: { exp: number; family?: string } = { exp: rec.exp };
    this.usedCodes.set(h, used);
    if (rec.exp < this.o.now()) throw new InvalidGrantError("authorization code expired");
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("authorization code was issued to another client");
    if (!codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new InvalidGrantError("code_verifier missing or malformed");
    const challenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
    if (!safeEqual(challenge, rec.challenge)) throw new InvalidGrantError("code_verifier does not match the challenge");
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    let res = rec.resource;
    if (resource !== undefined) {
      const r = this.checkResource(resource);
      if (res !== undefined && r !== res) throw new InvalidTargetError("resource does not match the authorization request");
      res = r;
    }
    const now = this.o.now();
    const family: FamilyRecord = { id: b64url(crypto.randomBytes(16)), clientId: client.client_id, created: now, lastRotated: now };
    used.family = family.id;
    return this.issueTokens(family, rec.scopes, res);
  }

  private async issueTokens(family: FamilyRecord, scopes: string[], resource: string | undefined): Promise<OAuthTokens> {
    const now = this.o.now();
    family.lastRotated = now;
    const access = randomToken();
    const refresh = randomToken();
    const base = { clientId: family.clientId, family: family.id, scopes, resource, created: now };
    const accessRec: TokenRecord = { kind: "access", ...base, exp: now + ACCESS_TTL_SEC * 1000 };
    const refreshRec: TokenRecord = { kind: "refresh", ...base, exp: now + REFRESH_TTL_SEC * 1000 };
    await this.writeJson(K.family(family.id), family);
    this.familyCache.set(family.id, family);
    await this.writeJson(K.refresh(sha256hex(refresh)), refreshRec);
    await this.writeJson(K.access(sha256hex(access)), accessRec);
    this.cacheToken(sha256hex(access), accessRec);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    if (!TOKEN_RE.test(String(refreshToken))) throw new InvalidGrantError("invalid refresh token");
    const h = sha256hex(refreshToken);
    const first = await this.readJson<TokenRecord>(K.refresh(h));
    if (!first || first.kind !== "refresh") throw new InvalidGrantError("invalid refresh token");
    return this.withLock(`family:${first.family}`, async () => {
      const rec = await this.readJson<TokenRecord>(K.refresh(h));
      if (!rec) throw new InvalidGrantError("invalid refresh token");
      const family = await this.getFamily(rec.family);
      if (!family || family.revoked) throw new InvalidGrantError("refresh token revoked; reconnect the connector");
      if (rec.clientId !== client.client_id) {
        await this.revokeFamily(rec.family, "refresh token presented by another client");
        throw new InvalidGrantError("invalid refresh token");
      }
      if (rec.rotatedAt) {
        console.error(`brink-server auth: rotated refresh token reused by client ${client.client_id}; revoking its token family`);
        await this.revokeFamily(rec.family, "refresh token reuse");
        throw new InvalidGrantError("refresh token already used; all tokens from this sign-in were revoked, reconnect the connector");
      }
      if (rec.exp < this.o.now()) throw new InvalidGrantError("refresh token expired; reconnect the connector");
      let granted = rec.scopes;
      if (scopes && scopes.length) {
        if (!scopes.every((s) => rec.scopes.includes(s))) throw new InvalidScopeError("requested scope exceeds the original grant");
        granted = scopes;
      }
      if (resource !== undefined) {
        const r = this.checkResource(resource);
        if (rec.resource !== undefined && r !== rec.resource) throw new InvalidTargetError("resource does not match the original grant");
      }
      rec.rotatedAt = this.o.now();
      await this.writeJson(K.refresh(h), rec);
      return this.issueTokens(family, granted, rec.resource);
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!TOKEN_RE.test(String(token))) throw new InvalidTokenError("invalid access token");
    const h = sha256hex(token);
    const now = this.o.now();
    let rec = this.tokenCache.get(h);
    if (!rec) {
      const neg = this.negativeCache.get(h);
      if (neg && neg > now) throw new InvalidTokenError("invalid access token");
      rec = (await this.readJson<TokenRecord>(K.access(h))) ?? undefined;
      if (!rec || rec.kind !== "access") {
        if (this.negativeCache.size > 2000) this.negativeCache.clear();
        this.negativeCache.set(h, now + 60_000);
        throw new InvalidTokenError("invalid access token");
      }
      this.cacheToken(h, rec);
    }
    if (rec.exp < now) {
      this.tokenCache.delete(h);
      throw new InvalidTokenError("access token expired");
    }
    const family = await this.getFamily(rec.family);
    if (!family || family.revoked) {
      this.tokenCache.delete(h);
      throw new InvalidTokenError("access token revoked");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.exp / 1000),
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const token = String(request.token);
    if (!TOKEN_RE.test(token)) return;
    const h = sha256hex(token);
    const rec = (await this.readJson<TokenRecord>(K.access(h))) ?? (await this.readJson<TokenRecord>(K.refresh(h)));
    if (!rec || rec.clientId !== client.client_id) return;
    await this.revokeFamily(rec.family, "revoked by client");
  }

  async revokeFamily(id: string, reason: string): Promise<void> {
    const fam = (await this.getFamily(id)) ?? { id, clientId: "", created: this.o.now(), lastRotated: this.o.now() };
    if (fam.revoked) return;
    fam.revoked = this.o.now();
    fam.revokedReason = reason;
    this.familyCache.set(id, fam);
    await this.writeJson(K.family(id), fam);
    for (const [k, v] of this.tokenCache) if (v.family === id) this.tokenCache.delete(k);
  }

  private async getFamily(id: string): Promise<FamilyRecord | null> {
    const c = this.familyCache.get(id);
    if (c) return c;
    const f = await this.readJson<FamilyRecord>(K.family(id));
    if (f) {
      if (this.familyCache.size > 2000) this.familyCache.clear();
      this.familyCache.set(id, f);
    }
    return f;
  }

  private cacheToken(h: string, rec: TokenRecord) {
    if (this.tokenCache.size > 1000) {
      const now = this.o.now();
      for (const [k, v] of this.tokenCache) if (v.exp < now) this.tokenCache.delete(k);
      if (this.tokenCache.size > 1000) this.tokenCache.clear();
    }
    this.tokenCache.set(h, rec);
  }

  // ── housekeeping ──

  /** Delete expired token records, dead families and never-consented clients. */
  async sweep(): Promise<{ deleted: number }> {
    const now = this.o.now();
    let deleted = 0;
    const age = (iso: string) => now - Date.parse(iso);
    const del = async (key: string) => {
      await this.o.storage.delete(key);
      deleted++;
    };
    for (const o of await this.o.storage.list("system/oauth/tokens/access/")) {
      // Access records are written once; an hour after that they are dead.
      if (age(o.modified) > ACCESS_TTL_SEC * 1000 + 3600_000) await del(o.key);
    }
    for (const o of await this.o.storage.list("system/oauth/tokens/refresh/")) {
      if (age(o.modified) > REFRESH_TTL_SEC * 1000 + 3600_000) await del(o.key);
    }
    for (const o of await this.o.storage.list("system/oauth/tokens/families/")) {
      // Rewritten on every rotation; untouched past the refresh life means no live token.
      if (age(o.modified) > REFRESH_TTL_SEC * 1000 + 24 * 3600_000) {
        await del(o.key);
        this.familyCache.delete(o.key.replace(/^.*\//, "").replace(/\.json$/, ""));
      }
    }
    for (const o of await this.o.storage.list("system/oauth/clients/")) {
      if (age(o.modified) < UNUSED_CLIENT_TTL_MS) continue;
      const rec = await this.readJson<ClientRecord>(o.key);
      if (rec && !rec.authorized) {
        await del(o.key);
        this.clientCache.delete(rec.client.client_id);
      }
    }
    return { deleted };
  }

  // ── store helpers ──

  private async readJson<T>(key: string): Promise<T | null> {
    const bytes = await this.o.storage.getBytes(key);
    if (!bytes) return null;
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
    } catch {
      console.error(`brink-server auth: unreadable record ${key}`);
      return null;
    }
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    await this.o.storage.put(key, JSON.stringify(value), { contentType: "application/json" });
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}

function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const s = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return s || undefined;
}

// ── signed authorization request (carried by the consent form) ──────────────

interface PendingAuthorization {
  c: string; // client_id
  r: string; // redirect_uri
  ch: string; // code_challenge
  s?: string; // state
  sc: string[]; // scopes
  res?: string; // resource
  exp: number;
}

function sealRequest(key: Buffer, p: PendingAuthorization): string {
  const body = b64url(Buffer.from(JSON.stringify(p)));
  return `${body}.${mac(key, `authreq|${body}`)}`;
}

function openRequest(key: Buffer, sealed: unknown, now: number): PendingAuthorization | null {
  if (typeof sealed !== "string" || sealed.length > 8000) return null;
  const [body, sig, extra] = sealed.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, mac(key, `authreq|${body}`))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PendingAuthorization;
    if (typeof p.exp !== "number" || p.exp < now) return null;
    return p;
  } catch {
    return null;
  }
}

// ── buildAuth ───────────────────────────────────────────────────────────────

export interface BuildAuthDeps {
  config: Config;
  storage: Storage;
  /** Hosts allowed for https redirect URIs; default from OAUTH_REDIRECT_HOSTS + claude.ai, claude.com. */
  redirectHosts?: string[];
  limits?: Partial<AuthLimits>;
  now?: () => number;
  /** false disables the SDK's own per-endpoint rate limits (tests). */
  sdkRateLimits?: boolean;
  /** Run the store sweep on a timer (default true). */
  sweepTimer?: boolean;
}

export interface Auth {
  /** /login, /logout, /oauth/consent, /authorize, /token, /register, /revoke, /.well-known/... Mount at the root. */
  router: express.Router;
  /** Bearer guard for the MCP routes (401 carries WWW-Authenticate resource_metadata). */
  guard: RequestHandler;
  /** Owner cookie: JSON 401 under /api, redirect to /login for pages. */
  requireOwner: RequestHandler;
  /** State-changing requests: JSON content type and Origin == PUBLIC_URL. */
  csrf: RequestHandler;
  isOwner(req: Request): boolean;
  provider: BrinkOAuthProvider;
  limiter: LoginLimiter;
  /** RFC 9728 metadata URL for an MCP path ("/mcp" or "/mcp/brink"). */
  resourceMetadataUrl(path: string): string;
  close(): void;
}

export function buildAuth(deps: BuildAuthDeps): Auth {
  const { config, storage } = deps;
  const publicUrl = config.publicUrl.replace(/\/$/, "");
  const secure = publicUrl.startsWith("https://");
  const now = deps.now ?? Date.now;
  const limits: AuthLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const redirectHosts = deps.redirectHosts ?? loadRedirectHosts();
  const secret = decodeSecret(config.sessionSecret);
  const cookieKey = deriveKey(secret, "session-cookie");
  const requestKey = deriveKey(secret, "oauth-request");
  const cookieName = secure ? "__Host-brink_session" : "brink_session";
  const limiter = new LoginLimiter(limits, now);
  const bearerFails = new FailCounter(limits.bearerFailMax, limits.bearerWindowMs, now);
  const registrations: number[] = [];

  const isOwner = (req: Request) => verifySession(cookieKey, parseCookies(req.headers.cookie)[cookieName], Math.floor(now() / 1000));

  const setSessionCookie = (res: Response) => {
    const exp = Math.floor(now() / 1000) + SESSION_TTL_SEC;
    const value = signSession(cookieKey, exp);
    res.append(
      "Set-Cookie",
      `${cookieName}=${value}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
  };
  const clearSessionCookie = (res: Response) => {
    res.append("Set-Cookie", `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  };

  const originOk = (req: Request) => req.get("origin") === publicUrl;

  const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

  /** One password attempt through the limiter. */
  async function checkPassword(req: Request, password: unknown): Promise<{ ok: true } | { ok: false; status: number; message: string; retryAfterMs?: number }> {
    const ip = ipOf(req);
    const gate = limiter.begin(ip);
    if (!gate.ok) {
      return {
        ok: false,
        status: 429,
        retryAfterMs: gate.retryAfterMs,
        message: gate.busy ? "The server is busy checking other sign-ins. Try again in a few seconds." : `Too many attempts. Try again in ${retryText(gate.retryAfterMs)}.`,
      };
    }
    try {
      const good = typeof password === "string" && password.length > 0 && (await verifyPassword(password, config.ownerPasswordHash));
      if (!good) {
        console.error(`brink-server auth: failed password from ${ip}`);
        return { ok: false, status: 401, message: "Wrong password." };
      }
      limiter.succeeded(ip);
      return { ok: true };
    } finally {
      gate.release();
    }
  }

  // ── pages ──

  function loginPage(res: Response, status: number, next: string, error?: string) {
    res.status(status).type("html").setHeader("Content-Security-Policy", pageCsp("'self'"));
    res.setHeader("Cache-Control", "no-store");
    res.send(
      renderPage(
        "Sign in · Brink",
        `<form method="post" action="/login" class="stack">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="text" name="username" value="owner" autocomplete="username" hidden>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="${MAX_PASSWORD_LEN}">
<button type="submit" class="primary">Sign in</button>
</form>`,
      ),
    );
  }

  function consentPage(res: Response, p: PendingAuthorization, clientName: string, owner: boolean, status = 200, error?: string) {
    const target = new URL(p.r);
    res.status(status).type("html");
    res.setHeader("Content-Security-Policy", pageCsp(`'self' ${target.origin}`));
    res.setHeader("Cache-Control", "no-store");
    const sealed = sealRequest(requestKey, p);
    res.send(
      renderPage(
        `Allow ${clientName}? · Brink`,
        `<form method="post" action="/oauth/consent" class="stack">
<h2>Allow ${escapeHtml(clientName)}?</h2>
<p>It will be able to read, search and change your Brink projects and run takeoffs on them.</p>
<p class="muted">After you allow, you go back to <strong>${escapeHtml(target.host)}</strong>.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<input type="hidden" name="req" value="${escapeHtml(sealed)}">
${
  owner
    ? ""
    : `<input type="text" name="username" value="owner" autocomplete="username" hidden>
<label for="password">Brink password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="${MAX_PASSWORD_LEN}">`
}
<div class="row">
<button type="submit" name="action" value="deny" class="secondary" formnovalidate>Deny</button>
<button type="submit" name="action" value="allow" class="primary">${owner ? `Allow ${escapeHtml(clientName)}` : "Sign in and allow"}</button>
</div>
</form>`,
      ),
    );
  }

  const provider = new BrinkOAuthProvider({
    storage,
    publicUrl,
    redirectHosts,
    now,
    renderConsent: (client, params, res) => {
      const scopes = (params.scopes ?? []).filter((s) => SCOPES.includes(s));
      const p: PendingAuthorization = {
        c: client.client_id,
        r: params.redirectUri,
        ch: params.codeChallenge,
        s: params.state,
        sc: scopes.length ? scopes : SCOPES,
        res: provider.checkResource(params.resource),
        exp: now() + AUTH_REQUEST_TTL_MS,
      };
      consentPage(res, p, client.client_name ?? "this app", isOwner(res.req as Request));
    },
  });

  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 });

  router.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    if (isOwner(req)) {
      res.redirect(303, next);
      return;
    }
    loginPage(res, 200, next);
  });

  router.post("/login", form, async (req, res) => {
    const next = safeNext(req.body?.next);
    if (!originOk(req)) {
      loginPage(res, 403, next, "This sign-in request did not come from this site. Open the sign-in page again and retry.");
      return;
    }
    const r = await checkPassword(req, req.body?.password);
    if (!r.ok) {
      if (r.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
      loginPage(res, r.status, next, r.message);
      return;
    }
    setSessionCookie(res);
    res.redirect(303, next);
  });

  router.post("/logout", form, express.json({ limit: "1kb" }), (req, res) => {
    if (!originOk(req)) {
      res.status(403).json({ error: "bad_origin", message: "Request refused: it did not come from this site." });
      return;
    }
    clearSessionCookie(res);
    if (req.is("application/json")) res.json({ ok: true });
    else res.redirect(303, "/login");
  });

  router.post("/oauth/consent", form, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const errorPage = (status: number, msg: string) => {
      res.status(status).type("html").setHeader("Content-Security-Policy", pageCsp("'none'"));
      res.send(renderPage("Sign-in problem · Brink", `<p class="error">${escapeHtml(msg)}</p>`));
    };
    if (!originOk(req)) return errorPage(403, "This request did not come from this site. Start connecting again from Claude.");
    const p = openRequest(requestKey, req.body?.req, now());
    if (!p) return errorPage(400, "This sign-in page expired. Start connecting again from Claude.");
    const clientRec = await provider.getClientRecord(p.c);
    if (!clientRec || !clientRec.client.redirect_uris.map(String).includes(p.r) || !provider.redirectAllowed(p.r)) {
      return errorPage(400, "This app is no longer registered. Start connecting again from Claude.");
    }
    const redirect = (params: Record<string, string>) => {
      const u = new URL(p.r);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.s !== undefined) u.searchParams.set("state", p.s);
      res.redirect(302, u.href);
    };
    const name = clientRec.client.client_name ?? "this app";
    if (req.body?.action !== "allow") {
      redirect({ error: "access_denied", error_description: "The owner denied access" });
      return;
    }
    if (!isOwner(req)) {
      const r = await checkPassword(req, req.body?.password);
      if (!r.ok) {
        if (r.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
        consentPage(res, { ...p, exp: now() + AUTH_REQUEST_TTL_MS }, name, false, r.status, r.message);
        return;
      }
      setSessionCookie(res);
    }
    await provider.markAuthorized(p.c);
    const code = provider.issueCode({ clientId: p.c, redirectUri: p.r, challenge: p.ch, scopes: p.sc, resource: p.res });
    console.error(`brink-server auth: owner allowed OAuth client ${p.c} (${name})`);
    redirect({ code });
  });

  // Global cap on dynamic registrations (the SDK's limit is per IP).
  router.post("/register", (req, res, next) => {
    const t = now();
    while (registrations.length && registrations[0] <= t - 3600_000) registrations.shift();
    if (registrations.length >= limits.registerGlobalPerHour) {
      res.status(429).json({ error: "too_many_requests", error_description: "Too many client registrations; try again later" });
      return;
    }
    registrations.push(t);
    next();
  });

  // RFC 9728 metadata for the /mcp/brink resource and the origin; the SDK router serves /mcp.
  const prm = (resource: string) => ({
    resource,
    authorization_servers: [`${publicUrl}/`],
    scopes_supported: SCOPES,
    resource_name: "Brink",
    bearer_methods_supported: ["header"],
  });
  router.use("/.well-known/oauth-protected-resource/mcp/brink", metadataHandler(prm(`${publicUrl}/mcp/brink`)));

  const sdkLimit = deps.sdkRateLimits === false ? { rateLimit: false as const } : {};
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(`${publicUrl}/`),
      resourceServerUrl: new URL(`${publicUrl}/mcp`),
      scopesSupported: SCOPES,
      resourceName: "Brink",
      authorizationOptions: sdkLimit,
      tokenOptions: sdkLimit,
      revocationOptions: sdkLimit,
      // Secrets never expire: an expiring secret would break the connector silently.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...sdkLimit },
    }),
  );
  router.use("/.well-known/oauth-protected-resource", metadataHandler(prm(publicUrl)));

  const resourceMetadataUrl = (p: string) => `${publicUrl}/.well-known/oauth-protected-resource${p.startsWith("/mcp/brink") ? "/mcp/brink" : "/mcp"}`;

  const guard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const ip = ipOf(req);
    if (bearerFails.blocked(ip)) {
      res.setHeader("Retry-After", String(Math.ceil(limits.bearerWindowMs / 1000)));
      res.status(429).json({ error: "too_many_requests", error_description: "Too many invalid tokens" });
      return;
    }
    const verifier = {
      verifyAccessToken: async (token: string) => {
        try {
          const info = await provider.verifyAccessToken(token);
          if (info.resource) provider.checkResource(info.resource);
          return info;
        } catch (e) {
          bearerFails.note(ip);
          if (e instanceof InvalidTargetError) throw new InvalidTokenError("token was not issued for this server");
          throw e;
        }
      },
    };
    return requireBearerAuth({ verifier, resourceMetadataUrl: resourceMetadataUrl(req.originalUrl) })(req, res, next);
  };

  const requireOwner: RequestHandler = (req, res, next) => {
    if (isOwner(req)) return next();
    if (req.originalUrl.startsWith("/api/") || req.originalUrl === "/api") {
      res.status(401).json({ error: "not_signed_in", message: "Sign in again." });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const next = safeNext(req.originalUrl);
      res.redirect(302, next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
      return;
    }
    res.status(401).type("text").send("Sign in first.");
  };

  const csrf: RequestHandler = (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!originOk(req)) {
      res.status(403).json({ error: "bad_origin", message: "Request refused: it did not come from this site." });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ error: "json_required", message: "Send JSON (Content-Type: application/json)." });
      return;
    }
    next();
  };

  const timers: NodeJS.Timeout[] = [];
  if (deps.sweepTimer !== false) {
    const run = () =>
      provider.sweep().then(
        (r) => r.deleted && console.error(`brink-server auth: swept ${r.deleted} expired OAuth records`),
        (e) => console.error("brink-server auth: sweep failed", e),
      );
    timers.push(setTimeout(run, 60_000).unref(), setInterval(run, 6 * 3600_000).unref());
  }

  return {
    router,
    guard,
    requireOwner,
    csrf,
    isOwner,
    provider,
    limiter,
    resourceMetadataUrl,
    close() {
      for (const t of timers) clearTimeout(t);
    },
  };
}
