// Environment → Config. Fails fast, listing every problem at once in plain
// words, so a bad deploy stops at boot instead of half-working.
import path from "node:path";
import type { Config } from "./types.ts";

type Env = Record<string, string | undefined>;

const GiB = 1024 ** 3;
const DEFAULT_MAX_UPLOAD = 4 * GiB;
/** S3/R2 cap on one object (5 TiB). */
const MAX_OBJECT = 5 * 1024 ** 4;

export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

function val(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** "scrypt$N$r$p$saltB64$hashB64" → parts, or a reason it is not usable. */
export function parsePasswordHash(
  hash: string,
): { ok: true; N: number; r: number; p: number; salt: Buffer; key: Buffer } | { ok: false; reason: string } {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false, reason: 'expected "scrypt$N$r$p$salt$hash"' };
  const [, nS, rS, pS, saltS, keyS] = parts;
  if (!/^\d+$/.test(nS) || !/^\d+$/.test(rS) || !/^\d+$/.test(pS)) return { ok: false, reason: "N, r and p must be whole numbers" };
  const N = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  if (N < 2 ** 14 || N > 2 ** 22 || (N & (N - 1)) !== 0) return { ok: false, reason: "N must be a power of two between 16384 and 4194304" };
  if (r < 1 || r > 32 || p < 1 || p > 16) return { ok: false, reason: "r must be 1-32 and p 1-16" };
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(saltS) || !b64.test(keyS)) return { ok: false, reason: "salt and hash must be base64" };
  const salt = Buffer.from(saltS, "base64");
  const key = Buffer.from(keyS, "base64");
  if (salt.length < 16) return { ok: false, reason: "salt must be at least 16 bytes" };
  if (key.length < 32 || key.length > 128) return { ok: false, reason: "hash must be 32-128 bytes" };
  return { ok: true, N, r, p, salt, key };
}

/** OAUTH_REDIRECT_HOSTS: comma-separated extra hostnames allowed as https OAuth redirect targets. */
export function loadRedirectHosts(env: Env = process.env): string[] {
  const hosts = new Set(DEFAULT_REDIRECT_HOSTS);
  const extra = val(env, "OAUTH_REDIRECT_HOSTS");
  if (extra) {
    for (const raw of extra.split(",")) {
      const h = raw.trim().toLowerCase();
      if (!h) continue;
      if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) {
        throw new Error(`OAUTH_REDIRECT_HOSTS: "${raw.trim()}" is not a plain hostname (like app.example.com, no https:// and no port)`);
      }
      hosts.add(h);
    }
  }
  return [...hosts];
}

export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];

  // PUBLIC_URL
  let publicUrl = "";
  const pu = val(env, "PUBLIC_URL");
  if (!pu) {
    errors.push("PUBLIC_URL is required: the address people and Claude use to reach this server, e.g. https://brink.example.com");
  } else {
    let u: URL | null = null;
    try {
      u = new URL(pu);
    } catch {
      errors.push(`PUBLIC_URL "${pu}" is not a valid URL (it should look like https://brink.example.com)`);
    }
    if (u) {
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
        errors.push("PUBLIC_URL must start with https:// (plain http is only allowed for localhost testing)");
      } else if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
        errors.push("PUBLIC_URL must be just the scheme and host, e.g. https://brink.example.com (no path, query or login)");
      } else {
        publicUrl = u.origin;
      }
    }
  }

  // PORT
  let port = 8080;
  const portS = val(env, "PORT");
  if (portS !== undefined) {
    if (!/^\d+$/.test(portS) || Number(portS) < 1 || Number(portS) > 65535) errors.push(`PORT "${portS}" must be a number from 1 to 65535`);
    else port = Number(portS);
  }

  // DATA_DIR
  const dataDir = val(env, "DATA_DIR") ?? "/data";
  if (!path.isAbsolute(dataDir)) errors.push(`DATA_DIR "${dataDir}" must be an absolute path, e.g. /data`);

  // storage: R2 or STORE_DIR, exactly one
  const r2Names = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const r2Set = r2Names.filter((n) => val(env, n) !== undefined);
  const storeDir = val(env, "STORE_DIR");
  let storage: Config["storage"] | null = null;
  if (r2Set.length > 0 && storeDir) {
    errors.push("Set either the R2_* variables (Cloudflare R2) or STORE_DIR (local folder), not both");
  } else if (r2Set.length > 0) {
    const missing = r2Names.filter((n) => !r2Set.includes(n));
    if (missing.length) {
      errors.push(`R2 storage needs all four variables; missing: ${missing.join(", ")}`);
    } else {
      const accountId = val(env, "R2_ACCOUNT_ID")!;
      const bucket = val(env, "R2_BUCKET")!;
      const accessKeyId = val(env, "R2_ACCESS_KEY_ID")!;
      const secretAccessKey = val(env, "R2_SECRET_ACCESS_KEY")!;
      let ok = true;
      if (!/^[0-9a-f]{32}$/i.test(accountId)) {
        errors.push("R2_ACCOUNT_ID should be the 32-character Account ID from the Cloudflare dashboard (letters a-f and digits)");
        ok = false;
      }
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
        errors.push(`R2_BUCKET "${bucket}" is not a valid bucket name (3-63 lowercase letters, digits and dashes)`);
        ok = false;
      }
      if (/\s/.test(accessKeyId) || /\s/.test(secretAccessKey)) {
        errors.push("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY must not contain spaces (check the copy and paste)");
        ok = false;
      }
      if (ok) storage = { kind: "r2", accountId: accountId.toLowerCase(), bucket, accessKeyId, secretAccessKey };
    }
  } else if (storeDir) {
    if (!path.isAbsolute(storeDir)) errors.push(`STORE_DIR "${storeDir}" must be an absolute path`);
    else storage = { kind: "fs", root: storeDir };
  } else {
    errors.push("Storage is not set: give the four R2_* variables (Cloudflare R2) or STORE_DIR (a local folder)");
  }

  // OWNER_PASSWORD_HASH
  const ownerPasswordHash = val(env, "OWNER_PASSWORD_HASH") ?? "";
  if (!ownerPasswordHash) {
    errors.push("OWNER_PASSWORD_HASH is required: run `node --import tsx scripts/hash-password.ts` and paste its output");
  } else {
    const parsed = parsePasswordHash(ownerPasswordHash);
    if (!parsed.ok) errors.push(`OWNER_PASSWORD_HASH is not a valid hash (${parsed.reason}); make a new one with scripts/hash-password.ts`);
  }

  // SESSION_SECRET
  const sessionSecret = val(env, "SESSION_SECRET") ?? "";
  if (!sessionSecret) {
    errors.push("SESSION_SECRET is required: 32+ random bytes in base64, e.g. the output of `openssl rand -base64 48`");
  } else if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(sessionSecret) || decodeSecret(sessionSecret).length < 32) {
    errors.push("SESSION_SECRET must be base64 of at least 32 random bytes (44+ characters), e.g. the output of `openssl rand -base64 48`");
  }

  // DATABASE_URL (optional)
  const databaseUrl = val(env, "DATABASE_URL");
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\/.+/.test(databaseUrl)) {
    errors.push("DATABASE_URL must start with postgres:// or postgresql:// (leave it unset to use the built-in database)");
  }

  // MAX_UPLOAD_BYTES
  let maxUploadBytes = DEFAULT_MAX_UPLOAD;
  const mu = val(env, "MAX_UPLOAD_BYTES");
  if (mu !== undefined) {
    if (!/^\d+$/.test(mu) || Number(mu) < 1 || Number(mu) > MAX_OBJECT) {
      errors.push(`MAX_UPLOAD_BYTES "${mu}" must be a whole number of bytes from 1 to ${MAX_OBJECT} (default ${DEFAULT_MAX_UPLOAD} = 4 GiB)`);
    } else maxUploadBytes = Number(mu);
  }

  // OAUTH_REDIRECT_HOSTS is read by auth.ts; check it here so a typo stops the boot.
  try {
    loadRedirectHosts(env);
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (errors.length || !storage) {
    throw new Error(`brink-server configuration problems:\n  - ${errors.join("\n  - ")}`);
  }
  const config: Config = { publicUrl, port, dataDir, storage, ownerPasswordHash, sessionSecret, maxUploadBytes };
  if (databaseUrl) config.databaseUrl = databaseUrl;
  return config;
}

/** SESSION_SECRET accepts standard or URL-safe base64. */
export function decodeSecret(secret: string): Buffer {
  return Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
