// Who is writing: the identity Cloudflare Access puts on every request it lets
// through, as the signed JWT in the Cf-Access-Jwt-Assertion header. Writes
// (schematic edits) require it; the editor's email is taken only from a token
// whose signature verifies against the team's published certs and whose
// audience is this application's AUD tag.
//
// Configuration (wrangler vars):
//   ACCESS_TEAM_DOMAIN   https://<team>.cloudflareaccess.com  (issuer; certs at /cdn-cgi/access/certs)
//   ACCESS_AUD           the Access application's Application Audience (AUD) tag
//
// Local development only: DEV_ONLY_ACCESS_BYPASS_EMAIL=<email> in .dev.vars
// lets `wrangler dev` attribute writes to that email without Access. It is
// honoured only when (a) Access is NOT configured (no ACCESS_TEAM_DOMAIN), and
// (b) the request arrived on a loopback host (127.0.0.1 / localhost / [::1]),
// which no deployed Worker route can be. Edits made through it are recorded
// with editor_auth = 'dev-bypass'.
/** The Worker variables this module reads (part of Env). */
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_ONLY_ACCESS_BYPASS_EMAIL?: string;
}

export interface Identity {
  email: string;
  auth: "cloudflare-access" | "dev-bypass";
}

export type IdentityResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 503; error: string };

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
const CERTS_TTL_MS = 10 * 60_000;
/** Clock skew tolerated on exp / nbf. */
const SKEW_S = 60;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

interface Jwk extends JsonWebKey {
  kid?: string;
}

let certs: { url: string; at: number; keys: Jwk[] } | null = null;

async function loadCerts(url: string, fetcher: typeof fetch, force: boolean): Promise<Jwk[]> {
  if (!force && certs && certs.url === url && Date.now() - certs.at < CERTS_TTL_MS) return certs.keys;
  const res = await fetcher(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  certs = { url, at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
  return certs.keys;
}

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

export const normalizeTeamDomain = (d: string): string => d.trim().replace(/\/+$/, "");

/**
 * Verify a Cloudflare Access JWT (RS256) and return its email. Throws with the reason on any failure.
 * `fetcher` and `now` are injectable for tests.
 */
export async function verifyAccessJwt(
  token: string,
  cfg: { teamDomain: string; aud: string },
  opts: { fetcher?: typeof fetch; now?: number } = {},
): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  if (header.alg !== "RS256") throw new Error(`unsupported alg ${String(header.alg)}`);
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) throw new Error("token has no kid");
  const team = normalizeTeamDomain(cfg.teamDomain);
  const url = `${team}/cdn-cgi/access/certs`;
  const fetcher = opts.fetcher ?? fetch;
  let jwk = (await loadCerts(url, fetcher, false)).find((k) => k.kid === kid);
  // A key rotation: fetch once more before refusing.
  if (!jwk) jwk = (await loadCerts(url, fetcher, true)).find((k) => k.kid === kid);
  if (!jwk) throw new Error("token signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw new Error("bad signature");
  const claims = b64urlJson(p);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) throw new Error("token not yet valid");
  if (normalizeTeamDomain(String(claims.iss ?? "")) !== team) throw new Error("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) throw new Error("wrong audience");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  // Service tokens carry no email: they cannot author edits.
  if (!email || !email.includes("@")) throw new Error("token has no email (service token?)");
  return email;
}

/** Forget cached certs (tests). */
export function resetAccessCache(): void {
  certs = null;
}

/** The identity of a request, or why there is none. */
export async function identify(req: Request, env: AccessEnv): Promise<IdentityResult> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const token = req.headers.get(ACCESS_HEADER);
  if (team && aud) {
    if (!token) return { ok: false, status: 401, error: "no Cloudflare Access identity on this request" };
    try {
      return { ok: true, identity: { email: await verifyAccessJwt(token, { teamDomain: team, aud }), auth: "cloudflare-access" } };
    } catch (e) {
      return { ok: false, status: 401, error: `Cloudflare Access token refused: ${(e as Error).message}` };
    }
  }
  const bypass = env.DEV_ONLY_ACCESS_BYPASS_EMAIL?.trim();
  if (bypass) {
    const host = new URL(req.url).hostname;
    if (!team && LOOPBACK.has(host)) return { ok: true, identity: { email: bypass.toLowerCase(), auth: "dev-bypass" } };
    console.error(`DEV_ONLY_ACCESS_BYPASS_EMAIL is set but ignored: it works only under local wrangler dev on a loopback host with Access unconfigured (host ${host})`);
  }
  if (team || aud) return { ok: false, status: 503, error: "Cloudflare Access is half-configured: set both ACCESS_TEAM_DOMAIN and ACCESS_AUD" };
  return { ok: false, status: 503, error: "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD): edits cannot be attributed, so they are refused" };
}
