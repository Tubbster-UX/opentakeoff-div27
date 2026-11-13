// web/vercel.json is the Vercel twin of the Netlify/Cloudflare recipe: the same
// build, the same security headers as public/_headers (the ONE place the CSP is
// written), and the same routes as netlify.toml. Vercel reads neither _headers
// nor netlify.toml, so this pins the two hosts to one policy: change the CSP in
// _headers and this fails until vercel.json says the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const headersFile = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const netlify = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");

/** The `/*` block of public/_headers as [name, value] pairs, comments dropped. */
function underscoreHeaders(): [string, string][] {
  const out: [string, string][] = [];
  let inBlock = false;
  for (const raw of headersFile.split("\n")) {
    if (raw.startsWith("/*")) { inBlock = true; continue; }
    const s = raw.trim();
    if (!inBlock || !s || s.startsWith("#")) continue;
    const i = s.indexOf(":");
    out.push([s.slice(0, i).trim(), s.slice(i + 1).trim()]);
  }
  return out;
}

test("vercel.json sends exactly the security headers public/_headers sends, on every path", () => {
  assert.equal(vercel.headers.length, 1);
  assert.equal(vercel.headers[0].source, "/(.*)");
  const got = vercel.headers[0].headers.map((h: { key: string; value: string }) => [h.key, h.value]);
  const want = underscoreHeaders();
  assert.ok(want.some(([k]) => k === "Content-Security-Policy"), "_headers still carries the CSP");
  assert.deepEqual(got, want);
});

test("vercel.json builds like netlify.toml: same command, output dist, the legal pages before the SPA fallback", () => {
  const cmd = /command\s*=\s*"([^"]+)"/.exec(netlify)?.[1];
  assert.equal(vercel.buildCommand, cmd);
  assert.equal(vercel.outputDirectory, "dist");
  const routes = vercel.rewrites.map((r: { source: string; destination: string }) => `${r.source} -> ${r.destination}`);
  assert.deepEqual(routes, [
    "/privacy -> /privacy/index.html", "/privacy/ -> /privacy/index.html",
    "/terms -> /terms/index.html", "/terms/ -> /terms/index.html",
    "/(.*) -> /index.html",
  ]);
});
