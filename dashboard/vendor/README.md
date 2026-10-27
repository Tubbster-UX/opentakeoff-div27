# Vendored EasySchematic

`easyschematic/` is a copy of [EasySchematic](https://github.com/duremovich/EasySchematic) by duremovich. EasySchematic is licensed under the GNU Affero General Public License v3; its license is in [`easyschematic/LICENSE`](easyschematic/LICENSE). The Brink app embeds it as the Schematic tab's editor.

The Brink app includes this code, so the app as a whole is distributed under the AGPL-3.0 as well. That is also the license of the repository it lives in (OpenTakeoff, `LICENSE` at the repository root).

| | |
|---|---|
| Upstream | <https://github.com/duremovich/EasySchematic> |
| Commit | `e2f178c44b2d79bc144b421f88344d72a6ea9ac2` (2026-10-05, version 0.44.1) |
| What is copied | `LICENSE`, `README.md`, `package.json`, all of `src/`, `public/fonts/`, `public/favicon.svg`, `patches/` |
| Record | [`easyschematic.lock.json`](easyschematic.lock.json): the commit, the include list, and a sha256 for every file |
| Changes | [`PATCHES.md`](PATCHES.md) |

## Why a recorded copy (not a git subtree)

**The choice:** a byte-for-byte copy of a fixed list of upstream paths, with the source commit and every file's hash in a lock file, plus a script that re-syncs and checks it.

**The rejected alternative:** `git subtree add --squash`. It would bring all 600+ upstream files (the API Worker, the docs site, e2e tests, marketing images), and a later `subtree pull` would hit modify/delete conflicts for every directory the app leaves out.

**What the copy gives:**
- **Small, pullable updates.** Only the files the app builds from are vendored.
- **Updates as one reviewable diff.** Upstream changes arrive as `node scripts/sync-easyschematic.mjs --commit <sha>`.
- **Unrecorded edits fail CI.** `npm run check` runs `--check`, which fails on any vendored file that differs from upstream and is not a recorded patch.

```bash
cd dashboard
node scripts/sync-easyschematic.mjs --commit <sha>   # clone upstream at <sha>, copy, re-apply vendor/patches/*.patch, rewrite the lock
node scripts/sync-easyschematic.mjs --from ../path/to/EasySchematic   # the same, from a local checkout
node scripts/sync-easyschematic.mjs --check          # verify (part of npm run check)
```

After a sync:
- review the diff
- run `npm run check`, which typechecks the vendored source with upstream's compiler options, together with the Brink overrides
- re-run `npm run es-check` (the editor end-to-end check, see `dashboard/README.md`)
- check whether `brink-merge`'s vendored enums need `node brink-merge/scripts/vendor-es.mjs`

## Dependencies

The app pins what upstream's lock file resolved at this commit:
- `@xyflow/react` 12.10.1
- `zustand` 5.0.11
- `html-to-image` 1.11.13
- `jspdf` 4.2.1

Upstream's own fix to `html-to-image` (`easyschematic/patches/html-to-image+1.11.13.patch`) is applied the way upstream applies it: `patch-package` in `postinstall`.
