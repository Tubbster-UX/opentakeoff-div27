# Brink changes to the vendored EasySchematic

Vendored commit: `e2f178c44b2d79bc144b421f88344d72a6ea9ac2` (see [README.md](README.md)).

## Patches to vendored files

**None.** Every file under `easyschematic/` is byte-for-byte upstream, including its UI components. `node scripts/sync-easyschematic.mjs --check` enforces this in `npm run check`.

The Brink UI replaces EasySchematic's chrome without editing it: it swaps whole modules at build time (section 3) and re-points EasySchematic's CSS variables at the Brink tokens (section 4). The engine (store, migrations, types, routing, report generators, file format) is used as it is.

If a patch is ever needed:
1. Add it as `vendor/patches/NNNN-short-name.patch`, a `git diff` relative to `easyschematic/`.
2. Describe it here: the patch file, every file it changes, why, and whether it touches the **engine** or only the **UI**. Store logic and the file format are never patched. The check fails until this page names them.
3. Re-run the sync, which applies patches in name order and records the patched hashes in the lock.

| Patch | Files | Why | Engine or UI |
|---|---|---|---|
| (none) | | | |

## How the app changes EasySchematic without patching it

All of these live outside the vendored tree.

### 1. Mounted in the app (no frame)

The editor mounts directly in the Schematic tab: the same document, the same React 19 tree and the same Tailwind build as the rest of the app. `web/src/es/workspace.tsx` renders upstream's `App` (inside `ReactFlowProvider` and its `ErrorBoundary`).

Upstream's `main.tsx` is not used, so there is no landing page and no service worker (`vite-plugin-pwa` is not part of the build).

What upstream assumes about its page, and how the app meets it:

| Upstream assumes | In the Brink app |
|---|---|
| Its global CSS (`src/index.css`: Tailwind, React Flow, theme variables, `html`/`body`/`#root` pinned to the viewport) | `web/src/app.css` imports it unmodified, as the build's one `@import "tailwindcss"`. The app is an app shell to match: one fixed header, the view fills the rest. |
| Its colour variables (`--color-bg`, `--color-surface`...) | The Brink utilities use other names (`bg-panel`, `text-ink`...), so nothing collides. Section 4 re-points upstream's variables at the Brink tokens. |
| Window-level keyboard shortcuts | They stay as upstream wrote them, active while the tab is open. Plain keys typed in Brink chrome (`[data-bk-chrome]`: header, toolbar, menus, Brink panels) are stopped at the document before they reach those listeners, so Space, Delete, Backspace or Escape there never act on the canvas. Modifier shortcuts keep working. The app's own shortcuts use Alt (Alt+1/2/3 for the tabs), which upstream does not use. |
| `document.title` | The workspace sets the app's title after upstream's effect, on every rename. |
| A module-level store and localStorage | Section 5. |

### 2. The Brink header, toolbar and panels

There is one header for the whole app (`web/src/components/Shell.tsx`). EasySchematic's MenuBar (logo, title, menus, account) is replaced by the Brink schematic toolbar (section 3). Where each upstream feature went:

| Upstream | In the Brink UI |
|---|---|
| Logo, "EasySchematic" title, schematic name | Brink logo and project switcher in the app header |
| Undo / Redo | Toolbar |
| Edit menu (copy, paste, delete, select all, reset all routes) | Toolbar: Edit |
| Insert menu (shapes) | Toolbar: Insert, which also adds a room and a note |
| Align & distribute | Toolbar: Align |
| View menu (print view, owned gear, hide unconnected ports, minimap, auto-route, debug edges) | Toolbar: View, plus Fit to screen |
| Export menu (PNG, SVG, DXF, PDF, rack PDF, print sheets, title block) | App header: Project menu, Export |
| Reports menu (device list, cable schedule, patch panels, pack list, network, power, room distances) | App header: Project menu, Reports. Upstream's report dialog and generators are used as they are. |
| File > Preferences | Project menu: Editor preferences |
| File > Save (Ctrl+S) | Saves to the project's edit layer now. Project menu: Save now. |
| File > Save As (Ctrl+Shift+S) | Project menu: Download a copy (.json) |
| Theme toggle | App header (one theme for the whole app) |
| Account / log-in | App header: the Cloudflare Access identity, and About & licenses |
| About EasySchematic | App header: About & licenses (license, attribution, source offer) |
| Device library (left) | Unchanged upstream panel, restyled by the tokens; the toolbar's Library button shows or hides it |
| View Options, Show Info, Signal Colors (right) | Tabs of the Brink right panel (Layers, Show info, Signals), next to the Brink **Inspector** (the selection, its properties, where it came from in the takeoff, rename) and **Rows** (the generated rows outline) |
| Device and room editors, context menus, page tabs (racks, print sheets, patch panels), reports dialog | Upstream, restyled by the tokens |
| Toasts | The app's toasts |

**Features not in the Brink UI** (the project's database is the schematic of record; each is still in the vendored source):
- File > New, Open (Ctrl+O shows a note instead), Save to a local file handle
- EasySchematic cloud: Save to Cloud, My Schematics, share links, accounts
- Save / Import Device Archive (custom templates live in memory only, see section 5)
- Import Cable Schedule (CSV wizard): it adds devices and cables the edit layer does not keep
- Help: documentation, device database and landing-page links; Load Test Schematic (dev builds)
- Renaming the schematic (the name is the project's)
- The "designed for desktop" overlay, the beta banner and the update pill
- The mobile menu overlay: at phone width the toolbar scrolls and the side panels are hidden, as upstream hides its own

### 3. Module overrides

The build swaps upstream modules for Brink ones. This is the `brink-easyschematic-overrides` plugin in `dashboard/vite.config.ts`: when a module inside `easyschematic/src/` imports one of the files below, it receives the Brink module instead. Brink modules that wrap an upstream original import it from outside the vendored tree, so that import is not redirected. The type checker still reads the upstream files, so they must keep compiling. All of these are UI or integration; none is engine.

| Upstream module | Replaced by | Why |
|---|---|---|
| `src/templateApi.ts` | `web/src/es/overrides/templateApi.ts` | Re-exports upstream unchanged, except that every call to `api.easyschematic.live` is replaced: accounts, cloud saves, share links, community submissions and the live device library. The editor uses the device library bundled with the vendored source. |
| `src/cloudSync.ts` | `web/src/es/overrides/cloudSync.ts` | No EasySchematic cloud. The project saves to Brink's database. |
| `src/sw-register.ts` | `web/src/es/overrides/sw-register.ts` | No service worker or PWA. |
| `src/mcpBridge.ts` | `web/src/es/overrides/mcpBridge.ts` | Upstream's local-MCP WebSocket bridge never connects from an internal web page. Agents use brink-merge's MCP server. |
| `src/components/UserMenuButton.tsx` | `web/src/es/overrides/UserMenuButton.tsx` | Shows the Cloudflare Access email. (Upstream's MenuBar, its only user, is replaced too; kept for any other import.) |
| `src/components/LoginDialog.tsx` | `web/src/es/overrides/LoginDialog.tsx` | Explains that EasySchematic accounts are not used here. |
| `src/components/PendingSubmissionBanner.tsx` | `web/src/es/overrides/PendingSubmissionBanner.tsx` | Renders nothing (community submissions need an EasySchematic account). |
| `src/components/MenuBar.tsx` | `web/src/es/brink/SchematicToolbar.tsx` | The Brink schematic toolbar, and the workspace's entries in the header's Project menu (section 2). It calls the store actions and the export / report functions upstream's MenuBar calls, and hosts upstream's Reports, Title Block, Preferences and Room Distances dialogs. It listens for upstream's `easyschematic:save`, `save-as`, `open` and `open-reports` events. |
| `src/components/DeviceLibrary.tsx` | `web/src/es/brink/LibraryPanel.tsx` | Upstream's device library, shown or hidden by the toolbar. |
| `src/components/ViewOptionsPanel.tsx` | `web/src/es/brink/RightPanel.tsx` | The Brink right panel in upstream App's right-hand slot: Inspector, Layers (upstream View Options), Show info, Signals, Rows. |
| `src/components/ShowInfoPanel.tsx`, `src/components/SignalColorPanel.tsx` | `web/src/es/overrides/Nothing.tsx` | Render nothing in App's right-hand slot; they are tabs of the Brink right panel instead. |
| `src/components/UpdatePill.tsx`, `src/components/BetaBanner.tsx`, `src/components/MobileGate.tsx` | `web/src/es/overrides/Nothing.tsx` | No service worker; not a beta host; the app's layout handles phones. |
| `src/components/ToastContainer.tsx` | `web/src/es/overrides/ToastContainer.tsx` | Hands each store toast to the app's toasts. `addToast` / `removeToast` are untouched. |
| `src/hooks/useTheme.ts` | `web/src/es/overrides/useTheme.ts` | Returns the app's theme (`web/src/design/theme.ts`), which sets the same `.dark` class upstream's hook set. |
| `src/deviceLibrary.fallback.json` | A generated module | Upstream generates this file at build time from `src/deviceLibrary.ts` (`api/seed/generate-fallback.ts`). The plugin serves the same list (`DEVICE_TEMPLATES` + `CARD_TEMPLATES`) as a module. |

### 4. Theme: the Brink tokens

`web/src/design/es-theme.css`, scoped to the editor's `.bk-es` element:
- upstream's own variables (`--color-bg`, `--color-surface`, `--color-surface-hover`, `--color-border`, `--color-text*`, `--color-canvas-origin`) point at the Brink tokens;
- the Tailwind palette upstream's components use (`blue-*`, `gray-*`, `slate-*`, `neutral-*`, `sky-*`, `cyan-*`, `indigo-*`) points at the Brink accent and neutrals, so `bg-blue-600` is the Brink accent (Brink Blue); its status palettes (`red-*`, `amber-*`, `yellow-*`, `green-*`, `emerald-*`, `violet-*`, `purple-*`) point at the Brink status tones and accent, so no amber is left in its chrome;
- its literal `'Inter'` (global CSS, inline styles and SVG `font-family` attributes on canvas nodes, edges and page overlays) is re-pointed at Roboto, the Brink typeface;
- the Brink voice rules: its lightning bolt and emoji (the auto-route chip, the USB-C power badge, page tabs) render as nothing through "Brink Hidden Glyphs", a tiny font listed first in the editor's font stack with a `unicode-range` covering only those characters (`scripts/make-hidden-glyphs-font.py`); the auto-route chip and the USB-C badge take Brink colours; the page-tab "add" buttons get Brink outline icons through a CSS mask;
- React Flow's controls, minimap, background and selection box take the Brink panel look;
- upstream panels shown as Brink panel tabs have their own title row hidden (`.bk-embed`).

Signal colours, power-phase colours and room / device colours stored in the schematic are data and keep their values. Exports keep upstream's light, print-safe colours: `[data-export-capturing]` and `@media print` set them on the captured element itself, which wins over these inherited values.

### 5. Storage

`web/src/es/storage.ts` replaces `window.localStorage` before the first EasySchematic module loads (`web/src/es/load.ts` installs it, then imports the editor). The Brink shell captured the real storage first (`web/src/design/theme.ts`).

| Keys | Where they live | Why |
|---|---|---|
| The document and per-document settings: autosave, custom templates, signal colors, category order, MCP settings | Memory only, reset whenever the editor opens a project | The database is the store of record, so these never leak between projects or browser tabs. The autosave key is seeded with an empty document, so upstream's demo never loads. |
| Personal preferences: theme, minimap, auto-route preference, report layouts, default header colour and stub label mode | Persisted under a `brink-es:` prefix | |

### 6. Defines

`vite.config.ts` defines `__APP_VERSION__` as `0.44.1+brink` and `__BUILD_HASH__` as the vendored commit, in place of upstream's `package.json` version and git hash.

## What the edit layer keeps

The edit layer keeps moves, renames, room changes and connections. That is all `web/src/es/sync.ts` saves; the rules are in `brink-merge/docs/schematic-edits.md`.

Everything else EasySchematic lets a person change is **not saved** in this phase:
- deleting takeoff devices
- adding devices from the library
- port, model and colour details
- cable type, label and length
- manual cable routes
- notes' text

The editor lists each such change as "will not be saved" in the status bar under the canvas, with "Discard unsaved and reload". It is never silently dropped.
