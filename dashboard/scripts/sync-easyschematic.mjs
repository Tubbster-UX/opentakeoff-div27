#!/usr/bin/env node
// Vendor EasySchematic (github.com/duremovich/EasySchematic, AGPL-3.0) into
// vendor/easyschematic/, and check that the vendored copy is still exactly
// upstream plus the patches recorded in vendor/PATCHES.md.
//
//   node scripts/sync-easyschematic.mjs --commit <sha>   clone upstream at <sha> and re-vendor
//   node scripts/sync-easyschematic.mjs --from <dir>     re-vendor from a checkout (its HEAD)
//   node scripts/sync-easyschematic.mjs --check          verify vendor/ against vendor/easyschematic.lock.json
//
// Only upstream's tracked files under INCLUDE are copied, byte for byte. The
// lock records the commit and a sha256 per file. Brink's own patches to
// vendored files live in vendor/patches/*.patch (applied in name order after
// the copy, with `git apply`) and are described in vendor/PATCHES.md; --check
// fails on any other difference, so an unrecorded edit cannot slip in.
// Everything the app changes about EasySchematic's behaviour is done from
// outside the vendored tree (web/src/es/, see vendor/PATCHES.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const DEST = join(VENDOR, "easyschematic");
const LOCK = join(VENDOR, "easyschematic.lock.json");
const PATCH_DIR = join(VENDOR, "patches");
const PATCHES_MD = join(VENDOR, "PATCHES.md");
const REPO = "https://github.com/duremovich/EasySchematic";

/** Upstream paths the app uses. src/ is taken whole so a diff against upstream stays trivial. */
const INCLUDE = [
  "LICENSE",
  "README.md",
  "package.json",
  "src",
  "public/fonts",
  "public/favicon.svg",
  // upstream's own fix to a dependency (patch-package); the app applies it the same way
  "patches",
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const posix = (p) => p.split(sep).join("/");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function hashTree(dir) {
  const files = {};
  for (const f of walk(dir).sort()) files[posix(relative(dir, f))] = sha256(readFileSync(f));
  return files;
}

function patchFiles() {
  return existsSync(PATCH_DIR) ? readdirSync(PATCH_DIR).filter((f) => f.endsWith(".patch")).sort() : [];
}

function sync(checkout) {
  const commit = git(checkout, "rev-parse", "HEAD").trim();
  const committedAt = git(checkout, "show", "-s", "--format=%cI", "HEAD").trim();
  const tracked = git(checkout, "ls-files", "-z", "--", ...INCLUDE).split("\0").filter(Boolean);
  if (!tracked.length) throw new Error(`no tracked files under ${INCLUDE.join(", ")} in ${checkout}`);
  rmSync(DEST, { recursive: true, force: true });
  for (const f of tracked) {
    mkdirSync(dirname(join(DEST, f)), { recursive: true });
    cpSync(join(checkout, f), join(DEST, f));
  }
  const upstream = hashTree(DEST);
  // Brink patches, in order. Each must apply cleanly; a failure leaves the tree unpatched and stops.
  const repoRoot = git(ROOT, "rev-parse", "--show-toplevel").trim();
  for (const p of patchFiles()) {
    execFileSync("git", ["apply", "--whitespace=nowarn", `--directory=${posix(relative(repoRoot, DEST))}`, join(PATCH_DIR, p)], { cwd: repoRoot, stdio: "inherit" });
  }
  const after = hashTree(DEST);
  const patched = Object.fromEntries(Object.entries(after).filter(([f, h]) => upstream[f] !== h));
  const lock = { repository: REPO, commit, committedAt, license: "AGPL-3.0", include: INCLUDE, patches: patchFiles(), files: upstream, patched };
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`vendored ${tracked.length} files from ${REPO} @ ${commit} into ${posix(relative(ROOT, DEST))}`);
  console.log(`${patchFiles().length} Brink patch(es), ${Object.keys(patched).length} file(s) differ from upstream`);
}

function check() {
  if (!existsSync(LOCK)) throw new Error("vendor/easyschematic.lock.json is missing: run --commit <sha> first");
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const problems = [];
  const actual = hashTree(DEST);
  const expected = { ...lock.files, ...lock.patched };
  for (const [f, h] of Object.entries(expected)) {
    if (!(f in actual)) problems.push(`missing: ${f}`);
    else if (actual[f] !== h) problems.push(`changed without a recorded patch: ${f}`);
  }
  for (const f of Object.keys(actual)) if (!(f in expected)) problems.push(`not from upstream: ${f}`);
  const onDisk = patchFiles();
  if (JSON.stringify(onDisk) !== JSON.stringify(lock.patches)) problems.push(`vendor/patches/ (${onDisk.join(", ") || "none"}) differs from the lock (${lock.patches.join(", ") || "none"}): re-run the sync`);
  const md = existsSync(PATCHES_MD) ? readFileSync(PATCHES_MD, "utf8") : "";
  if (!md.includes(lock.commit)) problems.push("vendor/PATCHES.md does not name the vendored commit");
  for (const p of onDisk) if (!md.includes(p)) problems.push(`vendor/PATCHES.md does not describe ${p}`);
  for (const f of Object.keys(lock.patched)) if (!md.includes(f)) problems.push(`vendor/PATCHES.md does not list the patched file ${f}`);
  if (!existsSync(join(DEST, "LICENSE"))) problems.push("the upstream LICENSE is missing");
  if (problems.length) {
    console.error(`vendor/easyschematic is not upstream ${lock.commit} + the recorded patches:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/easyschematic: ${Object.keys(lock.files).length} files = upstream ${lock.commit.slice(0, 7)}, ${Object.keys(lock.patched).length} patched (recorded)`);
}

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--check")) check();
else if (flag("--from")) sync(flag("--from"));
else if (flag("--commit")) {
  const tmp = mkdtempSync(join(tmpdir(), "easyschematic-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", REPO, tmp], { stdio: "inherit" });
    execFileSync("git", ["-C", tmp, "checkout", "--quiet", flag("--commit")], { stdio: "inherit" });
    sync(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.error("usage: sync-easyschematic.mjs --commit <sha> | --from <checkout> | --check");
  process.exit(2);
}
