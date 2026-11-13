// src/access.ts: the Cloudflare Access identity behind every write, and the
// local-only dev bypass that must never work outside `wrangler dev`.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_HEADER, identify, resetAccessCache, verifyAccessJwt, type AccessEnv } from "../src/access.js";
import { makeKey, signJwt, startTestTeam, type TestTeam } from "./access-keys.js";

let team: TestTeam;
beforeAll(async () => {
  team = await startTestTeam();
});
afterAll(() => team.close());
beforeEach(() => {
  resetAccessCache();
  team.publish([team.key]);
});

const cfg = () => ({ teamDomain: team.url, aud: team.aud });
const env = (vars: AccessEnv): AccessEnv => vars;
const req = (url: string, token?: string) => new Request(url, token ? { headers: { [ACCESS_HEADER]: token } } : {});

describe("verifyAccessJwt", () => {
  it("accepts a token signed by the team's key for this application, and returns its email", async () => {
    expect(await verifyAccessJwt(await team.token({ email: "Alex@Brink.test" }), cfg())).toBe("alex@brink.test");
    // a trailing slash on the configured team domain does not matter
    expect(await verifyAccessJwt(await team.token(), { teamDomain: `${team.url}/`, aud: team.aud })).toBe("alex@brink.test");
  });

  it("refuses every token that is not exactly that", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stranger = await makeKey("kid-1"); // same kid, different key
    const cases: [string, Promise<string>, RegExp][] = [
      ["wrong audience", team.token({ aud: ["another-app"] }), /audience/],
      ["wrong issuer", team.token({ iss: "https://evil.cloudflareaccess.com" }), /issuer/],
      ["expired", team.token({ exp: now - 3600 }), /expired/],
      ["not yet valid", team.token({ nbf: now + 3600 }), /not yet valid/],
      ["forged signature", signJwt(stranger, { aud: [team.aud], email: "alex@brink.test", exp: now + 600, iss: team.url }), /bad signature/],
      ["service token (no email)", team.token({ email: undefined, common_name: "svc" }), /no email/],
      ["alg none", Promise.resolve(`${Buffer.from('{"alg":"none","kid":"kid-1"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`), /unsupported alg/],
      ["garbage", Promise.resolve("not-a-jwt"), /malformed/],
    ];
    for (const [name, token, why] of cases) await expect(verifyAccessJwt(await token, cfg()), name).rejects.toThrow(why);
  });

  it("re-fetches the certs once for an unknown key id (rotation), and caches them otherwise", async () => {
    const before = team.certRequests;
    await verifyAccessJwt(await team.token(), cfg());
    await verifyAccessJwt(await team.token(), cfg());
    expect(team.certRequests - before).toBe(1);
    const next = await makeKey("kid-2");
    team.publish([team.key, next]);
    expect(await verifyAccessJwt(await team.token({}, next), cfg())).toBe("alex@brink.test");
    expect(team.certRequests - before).toBe(2);
    await expect(verifyAccessJwt(await signJwt(await makeKey("kid-9"), { aud: [team.aud], email: "a@b.c", exp: 9e9, iss: team.url }), cfg())).rejects.toThrow(/unknown key/);
  });
});

describe("identify", () => {
  it("with Access configured: a verified token, or 401", async () => {
    const e = env({ ACCESS_TEAM_DOMAIN: team.url, ACCESS_AUD: team.aud });
    expect(await identify(req("https://brink.example/api/me", await team.token()), e)).toEqual({ ok: true, identity: { email: "alex@brink.test", auth: "cloudflare-access" } });
    expect(await identify(req("https://brink.example/api/me"), e)).toMatchObject({ ok: false, status: 401 });
    expect(await identify(req("https://brink.example/api/me", await team.token({ aud: ["x"] })), e)).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/audience/) });
  });

  it("the dev bypass works only on a loopback host with Access unconfigured", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bypass = { DEV_ONLY_ACCESS_BYPASS_EMAIL: "Dev@Brink.test" };
    for (const host of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
      expect(await identify(req(`${host}/api/me`), env(bypass)), host).toEqual({ ok: true, identity: { email: "dev@brink.test", auth: "dev-bypass" } });
    }
    // Deployed hosts: refused, loudly.
    for (const host of ["https://brink.example", "https://brink-dashboard.someone.workers.dev", "http://127.0.0.1.nip.io"]) {
      expect(await identify(req(`${host}/api/me`), env(bypass)), host).toMatchObject({ ok: false, status: 503 });
    }
    expect(err).toHaveBeenCalled();
    // A configuration with Access never takes the bypass, even on loopback.
    expect(await identify(req("http://127.0.0.1:8787/api/me"), env({ ...bypass, ACCESS_TEAM_DOMAIN: team.url, ACCESS_AUD: team.aud }))).toMatchObject({ ok: false, status: 401 });
    expect(await identify(req("http://127.0.0.1:8787/api/me"), env({ ...bypass, ACCESS_TEAM_DOMAIN: team.url }))).toMatchObject({ ok: false, status: 503 });
    err.mockRestore();
  });

  it("without Access or the bypass, nobody can write (503)", async () => {
    expect(await identify(req("http://127.0.0.1:8787/api/me"), env({}))).toMatchObject({ ok: false, status: 503, error: expect.stringMatching(/not configured/) });
  });

  it("the committed configuration can never enable the bypass", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(/DEV_ONLY_ACCESS_BYPASS_EMAIL/);
  });
});
