import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadConfig, loadRedirectHosts } from "../src/config.ts";
import { hashPassword } from "../src/auth.ts";

let HASH = "";
const SECRET = crypto.randomBytes(48).toString("base64");
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "brink-plans",
  R2_ACCESS_KEY_ID: "placeholder-access-key",
  R2_SECRET_ACCESS_KEY: "placeholder-secret-key",
};

const base = (): Record<string, string> => ({
  PUBLIC_URL: "https://brink.example.com",
  OWNER_PASSWORD_HASH: HASH,
  SESSION_SECRET: SECRET,
  ...R2,
});

function problems(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail("expected loadConfig to throw");
}

describe("loadConfig", () => {
  before(async () => {
    HASH = await hashPassword("a long test password", { N: 2 ** 14 });
  });

  test("R2 config with defaults", () => {
    const c = loadConfig(base());
    assert.equal(c.publicUrl, "https://brink.example.com");
    assert.equal(c.port, 8080);
    assert.equal(c.dataDir, "/data");
    assert.equal(c.maxUploadBytes, 4 * 1024 ** 3);
    assert.deepEqual(c.storage, { kind: "r2", accountId: R2.R2_ACCOUNT_ID, bucket: "brink-plans", accessKeyId: R2.R2_ACCESS_KEY_ID, secretAccessKey: R2.R2_SECRET_ACCESS_KEY });
    assert.equal(c.databaseUrl, undefined);
  });

  test("local store, explicit values, trailing slash trimmed", () => {
    const env: Record<string, string> = { ...base(), PUBLIC_URL: "https://brink.example.com/", PORT: "9000", DATA_DIR: "/srv/data", DATABASE_URL: "postgres://u:p@db.example.com/brink", MAX_UPLOAD_BYTES: "1048576", STORE_DIR: "/srv/store" };
    for (const k of Object.keys(R2)) delete env[k];
    const c = loadConfig(env);
    assert.equal(c.publicUrl, "https://brink.example.com");
    assert.equal(c.port, 9000);
    assert.equal(c.dataDir, "/srv/data");
    assert.deepEqual(c.storage, { kind: "fs", root: "/srv/store" });
    assert.equal(c.databaseUrl, "postgres://u:p@db.example.com/brink");
    assert.equal(c.maxUploadBytes, 1048576);
  });

  test("http allowed only for localhost", () => {
    assert.equal(loadConfig({ ...base(), PUBLIC_URL: "http://localhost:8080" }).publicUrl, "http://localhost:8080");
    assert.match(problems({ ...base(), PUBLIC_URL: "http://brink.example.com" }), /must start with https/);
  });

  test("empty environment lists every missing piece at once", () => {
    const msg = problems({});
    assert.match(msg, /PUBLIC_URL is required/);
    assert.match(msg, /Storage is not set/);
    assert.match(msg, /OWNER_PASSWORD_HASH is required/);
    assert.match(msg, /SESSION_SECRET is required/);
  });

  test("bad values fail with clear messages", () => {
    assert.match(problems({ ...base(), PUBLIC_URL: "brink.example.com" }), /not a valid URL/);
    assert.match(problems({ ...base(), PUBLIC_URL: "https://brink.example.com/app" }), /just the scheme and host/);
    assert.match(problems({ ...base(), PORT: "80a" }), /PORT/);
    assert.match(problems({ ...base(), PORT: "70000" }), /PORT/);
    assert.match(problems({ ...base(), DATA_DIR: "data" }), /DATA_DIR/);
    assert.match(problems({ ...base(), STORE_DIR: "/srv/store" }), /not both/);
    assert.match(problems({ ...base(), R2_BUCKET: "" }), /missing: R2_BUCKET/);
    assert.match(problems({ ...base(), R2_ACCOUNT_ID: "my-account" }), /R2_ACCOUNT_ID/);
    assert.match(problems({ ...base(), R2_BUCKET: "Brink_Plans" }), /R2_BUCKET/);
    assert.match(problems({ ...base(), OWNER_PASSWORD_HASH: "hunter2" }), /OWNER_PASSWORD_HASH is not a valid hash/);
    assert.match(problems({ ...base(), OWNER_PASSWORD_HASH: HASH.replace("$16384$", "$1024$") }), /power of two/);
    assert.match(problems({ ...base(), SESSION_SECRET: "short" }), /SESSION_SECRET must be base64 of at least 32/);
    assert.match(problems({ ...base(), SESSION_SECRET: crypto.randomBytes(16).toString("base64") }), /at least 32/);
    assert.match(problems({ ...base(), DATABASE_URL: "mysql://x" }), /DATABASE_URL/);
    assert.match(problems({ ...base(), MAX_UPLOAD_BYTES: "4GB" }), /MAX_UPLOAD_BYTES/);
    assert.match(problems({ ...base(), OAUTH_REDIRECT_HOSTS: "https://x.example.com" }), /OAUTH_REDIRECT_HOSTS/);
  });

  test("URL-safe base64 session secret is accepted", () => {
    assert.ok(loadConfig({ ...base(), SESSION_SECRET: crypto.randomBytes(40).toString("base64url") }));
  });

  test("redirect hosts default to Claude and can be extended", () => {
    assert.deepEqual(loadRedirectHosts({}), ["claude.ai", "claude.com"]);
    assert.deepEqual(loadRedirectHosts({ OAUTH_REDIRECT_HOSTS: " App.Example.com, other.example.org " }), ["claude.ai", "claude.com", "app.example.com", "other.example.org"]);
  });
});
