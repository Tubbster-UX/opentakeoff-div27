// A stand-in for a Cloudflare Access team in tests: an RSA key pair, its JWKS
// served at <team>/cdn-cgi/access/certs, and RS256 tokens shaped like the ones
// Access puts in Cf-Access-Jwt-Assertion. Invented values only.
import { createServer, type Server } from "node:http";

const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", kid, use: "sig" } };
}

export async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = enc({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}

export interface TestTeam {
  /** Team domain, http://127.0.0.1:<port> (the issuer). */
  url: string;
  aud: string;
  key: TestKey;
  /** Serve these keys from now on (key rotation). */
  publish(keys: TestKey[]): void;
  certRequests: number;
  token(claims?: Record<string, unknown>, key?: TestKey): Promise<string>;
  close(): Promise<void>;
}

export async function startTestTeam(aud = "test-aud-0000"): Promise<TestTeam> {
  const key = await makeKey("kid-1");
  let keys = [key];
  const team = {} as TestTeam;
  const server: Server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      team.certRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: keys.map((k) => k.jwk), public_cert: { kid: key.kid, cert: "unused" } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(team, {
    url,
    aud,
    key,
    certRequests: 0,
    publish: (k: TestKey[]) => {
      keys = k;
    },
    token: (claims: Record<string, unknown> = {}, k: TestKey = key) => {
      const now = Math.floor(Date.now() / 1000);
      return signJwt(k, { aud: [aud], email: "alex@brink.test", exp: now + 600, iat: now, nbf: now, iss: url, type: "app", identity_nonce: "x", sub: "0000", country: "US", ...claims });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return team;
}
