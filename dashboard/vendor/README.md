# Vendored code: EasySchematic and OpenTakeoff

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

## Vendored OpenTakeoff

`opentakeoff/` is a copy of OpenTakeoff's plan canvas: this repository's own `web/` app as committed on `main` (AGPL-3.0-only, the repository's `LICENSE`, copied in as `opentakeoff/LICENSE`). The Brink app mounts it as the Takeoff tab's canvas.

| | |
|---|---|
| Source | This repository, <https://github.com/Tubbster-UX/opentakeoff-div27>, `main` |
| Commit | `00f9adca1705f0e3e9abe24f680b29a802033370` (2026-10-27). Its `web/` is byte-identical to upstream [OpenTakeoff](https://github.com/Kentucky-ai/opentakeoff) `798ee88`. |
| What is copied | `LICENSE`, `web/package.json` (as `package.json`), all of `web/src/` (as `src/`) |
| Record | [`opentakeoff.lock.json`](opentakeoff.lock.json): the source, the commit, the include list, a sha256 for every file, the patches and the patched files' hashes |
| Changes | [`PATCHES.md`](PATCHES.md#opentakeoff): one patch (`opentakeoff-patches/0001-host-bridge.patch`), the module overrides, the theme, the storage adapter |

**Not the Division 27 branch.** The cable-setup UI lives on `claude/div27-cable-setup-c6t9wu` and is not copied. Once that branch is merged to `main`, a re-sync brings it in as one reviewable diff.

```bash
cd dashboard
node scripts/sync-opentakeoff.mjs --ref origin/main   # copy web/ at that commit from this repository's git objects, re-apply opentakeoff-patches/*.patch, rewrite the lock
node scripts/sync-opentakeoff.mjs --check             # verify (part of npm run check): every file equals the lock, the lock equals git at that commit
```

The copy is read from git objects, never from the working tree, and the top-level `web/` is never modified by the app. After a sync:
- review the diff, and that `0001-host-bridge.patch` still applies (the sync stops if it does not);
- run `npm run check` (it also fails the build if a literal colour the theme re-points has left upstream's source);
- re-run the Takeoff checks (`npm run takeoff-check`, `dashboard/README.md`).

**Dependencies** (pinned to what upstream's lock file resolved at the commit): pdfjs-dist 4.10.38, pdf-lib 1.17.1, fflate 0.8.3, jsts 2.12.1, @turf/helpers, @turf/difference, @turf/boolean-overlap, @turf/boolean-contains 7.3.5. Upstream's OCR, voice and Microsoft 365 engines (onnxruntime-web, ppu-paddle-ocr, @huggingface/transformers, @azure/msal-browser) are not installed: the modules that load them are replaced (PATCHES.md, OpenTakeoff section 3).
