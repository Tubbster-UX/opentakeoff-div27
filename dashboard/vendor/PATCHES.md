# Brink changes to the vendored EasySchematic

Vendored commit: `e2f178c44b2d79bc144b421f88344d72a6ea9ac2` (see [README.md](README.md)).

## Patches to vendored files

**None.** Every file under `easyschematic/` is byte-for-byte upstream. `node scripts/sync-easyschematic.mjs --check` enforces this in `npm run check`.

If a patch is ever needed:
1. Add it as `vendor/patches/NNNN-short-name.patch`, a `git diff` relative to `easyschematic/`.
2. Describe it here, naming the patch file and every file it changes. The check fails until this page names them.
3. Re-run the sync, which applies patches in name order and records the patched hashes in the lock.

## How the app changes EasySchematic's behaviour without patching it

All of these live outside the vendored tree.

### 1. Its own document

The editor runs in its own frame: `web/es-frame.html`, mounted by `web/src/es/`.

EasySchematic assumes it owns the page:
- global CSS, including `html`/`body` and colour tokens that collide with the shell's
- window-level keyboard shortcuts
- `document.title`
- a module-level store

The frame gives it all of that, with no edits. The Schematic tab embeds the frame and talks to it with `postMessage` (same origin, `web/src/lib/esBridge.ts`).

### 2. Mounted without the landing page or the service worker

`web/src/es/mount.tsx` renders upstream's `App` (inside `ReactFlowProvider` and `ErrorBoundary`) directly. Upstream's `main.tsx` is not used, so there is:
- no landing page
- no `initServiceWorkerUpdates()`

`vite-plugin-pwa` is not part of the build.

### 3. Module overrides

The build swaps a few upstream modules for Brink ones. This is the `brink-easyschematic-overrides` plugin in `dashboard/vite.config.ts`: when a module inside `easyschematic/src/` imports one of the files below, it receives the Brink module instead. The type checker still reads the upstream files, so they must keep compiling.

| Upstream module | Replaced by (`web/src/es/overrides/`) | Why |
|---|---|---|
| `src/templateApi.ts` | `templateApi.ts` | Re-exports upstream unchanged, except that every call to `api.easyschematic.live` is replaced: accounts, cloud saves, share links, community submissions and the live device library. The editor uses the device library bundled with the vendored source. |
| `src/cloudSync.ts` | `cloudSync.ts` | No EasySchematic cloud. The project saves to Brink's database. |
| `src/sw-register.ts` | `sw-register.ts` | No service worker or PWA. "Update" and "reset" reload the frame. |
| `src/mcpBridge.ts` | `mcpBridge.ts` | Upstream's local-MCP WebSocket bridge never connects from an internal web page. Agents use brink-merge's MCP server. |
| `src/components/UserMenuButton.tsx` | `UserMenuButton.tsx` | Shows the Cloudflare Access email that edits are saved under, instead of an EasySchematic log-in. |
| `src/components/LoginDialog.tsx` | `LoginDialog.tsx` | Explains that EasySchematic accounts are not used here. |
| `src/components/PendingSubmissionBanner.tsx` | `PendingSubmissionBanner.tsx` | Renders nothing (community submissions need an EasySchematic account). |
| `src/deviceLibrary.fallback.json` | A generated module | Upstream generates this file at build time from `src/deviceLibrary.ts` (`api/seed/generate-fallback.ts`). The plugin serves the same list (`DEVICE_TEMPLATES` + `CARD_TEMPLATES`) as a module, so no generated file is needed. |

### 4. Storage

`web/src/es/storage.ts` replaces `window.localStorage` in the frame before any EasySchematic module loads.

| Keys | Where they live | Why |
|---|---|---|
| The document and per-document settings: autosave, custom templates, signal colors, category order, MCP settings | Memory only | The database is the store of record, so these never leak between projects or tabs. The autosave key is seeded with an empty document, so upstream's demo schematic never loads. |
| Personal preferences: theme, minimap, auto-route preference, report layouts, default header colour and stub label mode | Persisted under a `brink-es:` prefix | |

### 5. Keyboard

`Ctrl/Cmd+S` saves to the project immediately. A capture-phase listener in `mount.tsx` stops the event before upstream's handler would open a "save to file" dialog. File > Save, Save As and the exports still write files, as upstream does.

### 6. Defines

`vite.config.ts` defines:
- `__APP_VERSION__` as `0.44.1+brink`
- `__BUILD_HASH__` as the vendored commit

These replace upstream's `package.json` version and its git hash.

## What the edit layer keeps

The edit layer keeps moves, renames, room changes and connections. That is all `web/src/es/sync.ts` saves; the rules are in `brink-merge/docs/schematic-edits.md`.

Everything else EasySchematic lets a person change is **not saved** in this phase:
- deleting takeoff devices
- adding devices from the library
- port, model and colour details
- cable type, label and length
- manual cable routes
- notes' text

The editor lists each such change as "will not be saved" in the tab's status bar, with "Discard unsaved and reload". It is never silently dropped.

File > New, Open and Import replace the editor's document. Saving then stops until the project schematic is reloaded.
