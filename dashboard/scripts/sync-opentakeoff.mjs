#!/usr/bin/env node
// Vendor OpenTakeoff's plan canvas (this repository's web/ app on `main`, AGPL-3.0) into
// vendor/opentakeoff/, and check that the vendored copy is still exactly that commit
// plus the patches recorded in vendor/PATCHES.md.
//
//   node scripts/sync-opentakeoff.mjs --ref <commit|branch>   re-vendor from this repository's git history
//   node scripts/sync-opentakeoff.mjs --check                  verify vendor/ against vendor/opentakeoff.lock.json
//
// The source is this repository's own git objects (not the working tree), so a sync reads
// exactly the committed web/ of `main` (or any ref) without checking it out. The Brink app
// never edits top-level web/: everything it changes about the canvas is done from outside
// the vendored tree (web/src/ot/, vite.config.ts), and the few source changes it needs are
// patch files in vendor/opentakeoff-patches/, applied in name order after the copy and
// described in vendor/PATCHES.md. --check fails on any other difference.
//
// Not the Division 27 branch: the cable-setup UI (claude/div27-cable-setup-c6t9wu) arrives
// through a re-sync once that branch is merged to main (`--ref origin/main`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor");
const DEST = join(VENDOR, "opentakeoff");
const LOCK = join(VENDOR, "opentakeoff.lock.json");
const PATCH_DIR = join(VENDOR, "opentakeoff-patches");
const PATCHES_MD = join(VENDOR, "PATCHES.md");
const REPO = "https://github.com/Tubbster-UX/opentakeoff-div27";
/** The canonical project this repository's web/ is synced from. */
const UPSTREAM = "https://github.com/Kentucky-ai/opentakeoff";

/**
 * Repository paths the app builds from, and where each lands under vendor/opentakeoff/.
 * web/src is taken whole so a diff against main stays trivial. LICENSE is the repository's
 * (web/ has none of its own).
 */
const INCLUDE = [
  { from: "LICENSE", to: "LICENSE" },
  { from: "web/package.json", to: "package.json" },
  { from: "web/src", to: "src" },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
/** git at the repository's top level, so pathspecs are repository paths. */
const TOP = execFileSync("git", ["-C", ROOT, "rev-parse", "--show-toplevel"]).toString().trim();
const git = (...args) => execFileSync("git", ["-C", TOP, ...args], { maxBuffer: 256 << 20 });
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

function sync(ref) {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).toString().trim();
  const committedAt = git("show", "-s", "--format=%cI", commit).toString().trim();
  rmSync(DEST, { recursive: true, force: true });
  let n = 0;
  for (const { from, to } of INCLUDE) {
    const listed = git("ls-tree", "-r", "-z", "--name-only", commit, "--", from).toString().split("\0").filter(Boolean);
    if (!listed.length) throw new Error(`${from} is not in ${commit}`);
    for (const path of listed) {
      const out = join(DEST, to + path.slice(from.length));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, git("show", `${commit}:${path}`));
      n++;
    }
  }
  const upstream = hashTree(DEST);
  // Brink patches, in order. Each must apply cleanly; a failure stops the sync.
  const repoRoot = TOP;
  for (const p of patchFiles()) {
    execFileSync("git", ["apply", "--whitespace=nowarn", `--directory=${posix(relative(repoRoot, DEST))}`, join(PATCH_DIR, p)], { cwd: repoRoot, stdio: "inherit" });
  }
  const after = hashTree(DEST);
  const patched = Object.fromEntries(Object.entries(after).filter(([f, h]) => upstream[f] !== h));
  const lock = {
    repository: REPO,
    ref,
    commit,
    committedAt,
    upstream: UPSTREAM,
    license: "AGPL-3.0-only",
    include: INCLUDE,
    patches: patchFiles(),
    files: upstream,
    patched,
  };
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`vendored ${n} files from ${REPO} @ ${commit} into ${posix(relative(ROOT, DEST))}`);
  console.log(`${patchFiles().length} Brink patch(es), ${Object.keys(patched).length} file(s) differ from ${commit.slice(0, 7)}`);
}

function check() {
  if (!existsSync(LOCK)) throw new Error("vendor/opentakeoff.lock.json is missing: run --ref <commit> first");
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const problems = [];
  const actual = hashTree(DEST);
  const expected = { ...lock.files, ...lock.patched };
  for (const [f, h] of Object.entries(expected)) {
    if (!(f in actual)) problems.push(`missing: ${f}`);
    else if (actual[f] !== h) problems.push(`changed without a recorded patch: ${f}`);
  }
  for (const f of Object.keys(actual)) if (!(f in expected)) problems.push(`not from ${lock.commit.slice(0, 7)}: ${f}`);
  const onDisk = patchFiles();
  if (JSON.stringify(onDisk) !== JSON.stringify(lock.patches)) problems.push(`vendor/opentakeoff-patches/ (${onDisk.join(", ") || "none"}) differs from the lock (${lock.patches.join(", ") || "none"}): re-run the sync`);
  const md = existsSync(PATCHES_MD) ? readFileSync(PATCHES_MD, "utf8") : "";
  if (!md.includes(lock.commit)) problems.push("vendor/PATCHES.md does not name the vendored OpenTakeoff commit");
  for (const p of onDisk) if (!md.includes(p)) problems.push(`vendor/PATCHES.md does not describe ${p}`);
  for (const f of Object.keys(lock.patched)) if (!md.includes(f)) problems.push(`vendor/PATCHES.md does not list the patched file ${f}`);
  if (!existsSync(join(DEST, "LICENSE"))) problems.push("the LICENSE is missing");
  // When the repository still has the vendored commit, every locked file must be byte-equal to it.
  let fromGit = "skipped (commit not in this clone)";
  try {
    git("cat-file", "-e", `${lock.commit}^{commit}`);
    for (const { from, to } of lock.include) {
      const listed = git("ls-tree", "-r", "-z", "--name-only", lock.commit, "--", from).toString().split("\0").filter(Boolean);
      for (const path of listed) {
        const rel = to + path.slice(from.length);
        const h = sha256(git("show", `${lock.commit}:${path}`));
        if (lock.files[rel] !== h) problems.push(`the lock's hash for ${rel} is not ${lock.commit.slice(0, 7)}'s`);
      }
      const n = listed.length;
      const locked = Object.keys(lock.files).filter((f) => f === to || f.startsWith(to + "/")).length;
      if (n !== locked) problems.push(`${from}: ${n} file(s) at ${lock.commit.slice(0, 7)}, ${locked} in the lock`);
    }
    fromGit = "matches git";
  } catch (e) {
    if (problems.length === 0 && !(e instanceof Error && /cat-file/.test(e.message))) throw e;
  }
  if (problems.length) {
    console.error(`vendor/opentakeoff is not ${lock.commit} + the recorded patches:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor/opentakeoff: ${Object.keys(lock.files).length} files = ${lock.commit.slice(0, 7)} (${fromGit}), ${Object.keys(lock.patched).length} patched (recorded)`);
}

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--check")) check();
else if (flag("--ref")) sync(flag("--ref"));
else {
  console.error("usage: sync-opentakeoff.mjs --ref <commit|branch> | --check");
  process.exit(2);
}
