# Brink changes to the vendored EasySchematic and OpenTakeoff

Two upstreams are vendored: **EasySchematic** (the Schematic tab, this first part) and **OpenTakeoff** (the Takeoff tab, the [second part](#opentakeoff)). Each is a byte-for-byte copy checked by its sync script; every Brink change to it is listed here.

# EasySchematic

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

# OpenTakeoff

Vendored commit: `00f9adca1705f0e3e9abe24f680b29a802033370`, this repository's `main` (see [README.md](README.md#vendored-opentakeoff)). Its `web/` is byte-identical to upstream OpenTakeoff `798ee88` ("Scan star: the agent's mark, in the app and the PDF watermark (#571)"), which `main` merged.

The Division 27 cable-setup UI (branch `claude/div27-cable-setup-c6t9wu`) is **not** vendored. It arrives through a re-sync (`node scripts/sync-opentakeoff.mjs --ref origin/main`) once that branch is merged to `main`. Until then the canvas carries a Division 27 export's `cable_setup`, `role` and `cable_runs` fields through untouched (brink-merge reads them; the canvas does not show them).

## Patches to vendored files

One patch. Everything else is done from outside the vendored tree (sections 2 to 6).

| Patch | Files | Why | Engine or UI |
|---|---|---|---|
| `opentakeoff-patches/0001-host-bridge.patch` | `src/pages/TakeoffCanvas.jsx` | Adds one import (`useOtHost` from `@brink/ot-host`, aliased to `web/src/ot/host.ts`) and one call before the component's `return`, handing the host page that render's state and verbs (tool, sheets, conditions, selection, scale, zoom ref, exporters). The canvas keeps all of that in its own hooks and draws its own chrome inline, so nothing outside the component can reach it otherwise. The call reads; it changes no state and no behaviour. | UI (read-only bridge) |

`node scripts/sync-opentakeoff.mjs --check` (in `npm run check`) fails on any other change, and on a patch that is not listed here.

## React 19 (upstream is React 18.3 / Vite 6 / pdfjs-dist 4.10)

The app builds the canvas with its own React 19.3 / Vite 8 / Tailwind 4 toolchain. **No change was needed for React 19.** The audit, over all of `vendor/opentakeoff/src`:
- **Removed APIs:** no `ReactDOM.render`, `hydrate`, `unmountComponentAtNode` or `findDOMNode`; no string refs (`ref="…"`); no `defaultProps` or `propTypes` on function components; no legacy context (`contextTypes`, `childContextTypes`, `getChildContext`); no `createFactory`, `react-dom/test-utils`, `UNSAFE_` lifecycles or class components. Upstream's own entry (`main.jsx`, `ReactDOM.createRoot`) is not used.
- **Changed behaviour:** every callback ref has a block body (returns nothing), so React 19's ref-cleanup rule changes nothing; `flushSync` (used) is unchanged in React 19.
- **Checked in the browser:** the development build (`npm run dev:web`) logs no React warning while the canvas loads a project, opens a sheet and saves a drawn count (`docs/evidence/takeoff/README.md`).
- **Dependencies:** pdfjs-dist 4.10.38, pdf-lib 1.17.1, fflate 0.8.3, jsts 2.12.1 and @turf 7.3.5, pinned to what upstream's lock file resolved. None depends on React. pdf.js's worker is emitted by Vite 8 as upstream's Vite 6 did (`?url`); the canvas's tile and room workers build as ES module workers (`worker.format: "es"`, as upstream configures).

## How the app changes OpenTakeoff without patching it

### 1. Mounted in the app (no frame)

The canvas mounts directly in the Takeoff tab (`web/src/ot/workspace.tsx`): the same document and React tree, inside upstream's `GoogleAuthProvider` (not configured, so it settles at once). The Takeoff tab loads it as its own chunk on first use (`@brink/takeoff-workspace`, typed by `web/src/ot-workspace.d.ts`). Upstream's `main.jsx`, `index.html`, router, project home and sign-in gates are not used.

| Upstream assumes | In the Brink app |
|---|---|
| Its global CSS (`styles/tokens.css` with a Google Fonts import, `styles/app.css` on `html` / `body`) | Not loaded. `web/src/design/ot-theme.css` defines the same variables and classes inside `.bk-ot` (section 4), and imports upstream's `print.css` and `brand.css` unchanged. |
| A 100vh shell | `.bk-ot .app-shell` fills the tab instead (ot-theme.css). |
| Window-level single-letter shortcuts | They stay as upstream wrote them, active while the tab is open. Plain keys typed in Brink chrome (`[data-bk-chrome]`) are stopped before they reach them. |
| `store` is IndexedDB (`lib/store.js`) | Section 5. |

### 2. The Brink toolbar, panels and status bar

Upstream's top bar, tool rail, panel rail and status strip are replaced by Brink chrome that calls the canvas's own setters and functions through the host bridge (`web/src/ot/host.ts`).

| Upstream | In the Brink UI |
|---|---|
| Logo, project name, Open, account and presence chips | App header: Brink logo, project switcher, the Access identity |
| Tool rail (select, area, rectangle, linear, surface, count, symbol, deduct, markups, approval stamp, copy text, calibrate) | Toolbar (`web/src/ot/brink/TakeoffToolbar.tsx`): select, the six measuring tools, two deduct tools, Markup menu, calibrate. Approval stamp and copy text keep their shortcuts and upstream's own prompts. |
| Edit cluster (undo, redo, finish) | Toolbar |
| Snap and 45° guides | Toolbar toggles |
| Active condition picker, add condition | Toolbar, and the right panel's Conditions tab |
| Scale menu, units | Toolbar (end): the scale face in words (upstream prints status glyphs), upstream's scale menu items |
| Fit, sheet invert, focus (canvas corner buttons) | Toolbar: zoom in / out, fit, invert. Focus mode is always on (section 3). |
| Sheet chip, sheet tabs, plan gallery landing | Sheets panel (left, `brink/SheetsPanel.tsx`): files and pages with takeoff counts, upload (upstream's own file input and ingest), remove. Upstream's gallery (previews, side by side, match-line stitching, levels) stays one click away (Panels menu). |
| Condition palette band, compact strip | Right panel, Conditions tab (`brink/RightPanel.tsx`): conditions with measured totals, activate, add; "Details" opens upstream's own quantities panel (materials, waste, appearance), restyled |
| (none) | Right panel, Inspector tab: the selected takeoff, its quantity, who made it (person or agent, method), whether the machine original is kept, author and last edit |
| (none) | Right panel, Edits tab: who saves, what the edit layer holds, what is not saved, the layer's warnings |
| Status strip (tool verb, coordinates, scale, message bar, save state) | Status bar (`brink/StatusBar.tsx`): tool, sheet, scale, zoom, selection, the canvas's messages, editor and save state, notices |
| Report, marked set, DXF, export takeoff, estimate, revisions | App header: Project menu (`brink/projectMenu.ts`): marked set PDF (upstream's `exportMarkedSet`), DXF (upstream's `lib/dxf.ts`, as its report builds it), the takeoff file, report, estimate, revisions, print report (upstream's print stylesheet) |
| Panel rail (markups, stamps, RFIs, takeoffs, work, roll goods, layers, revisions) | Toolbar Panels menu |
| Theme toggle | App header (one theme for the whole app) |

**Features not in the Brink UI** (each is still in the vendored source):
- Google Drive, Microsoft 365 and shared-folder sync, the project home and sign-in gates (the project database is the store of record)
- The premium workspace layout and the premium plans page
- The guided first takeoff on upstream's bundled sample plan, and "Connect your AI" (agents use the MCP servers)
- On-device OCR and voice dictation (section 3)
- "Clear workspace" (it deletes every plan in the browser-only store)

### 3. Module overrides

`vite.config.ts`, plugin `brink-opentakeoff-overrides`: when a module inside `opentakeoff/src/` imports one of these, it receives the Brink module. A Brink module that wraps the upstream original imports it from outside the vendored tree, so that import is not redirected. All are UI or integration; none is engine.

| Upstream module | Replaced by | Why |
|---|---|---|
| `src/lib/ocr/client.ts` | `web/src/ot/overrides/ocrClient.ts` | Upstream's on-device OCR worker needs ppu-paddle-ocr on onnxruntime-web and models staged per deployment. The app stages none and does not bundle the engine: the client answers "disabled", as upstream does with `VITE_OCR=off`. The PDF's own text layer is still read. |
| `src/lib/voiceRecognizerClient.ts` | `web/src/ot/overrides/voiceRecognizerClient.ts` | Push-to-talk dictation (Whisper on @huggingface/transformers): reports "uninstalled", as upstream does without its model. The command box is gated off upstream anyway. |
| `src/lib/msgraph/auth.js` | `web/src/ot/overrides/msgraphAuth.ts` | Microsoft 365 sync (MSAL). Only loads on a build configured for it, which the app never is; kept importable, says why on use. |
| `src/lib/theme.js` | `web/src/ot/overrides/theme.ts` | One theme: reads and toggles the app's `.dark` class (instead of `<html data-theme>`), reports changes. |
| `src/lib/focusMode.js` | `web/src/ot/overrides/focusMode.ts` | Focus mode always on: upstream itself then skips its top bar, palette band, sheet tabs and compact strip. |
| `src/components/WorkspaceLayout.jsx` | `web/src/ot/overrides/WorkspaceLayout.tsx` | Pins the classic layout (the premium workspace has its own header and docks); the rest re-exported unchanged. |
| `src/components/PlanNavigator.jsx` | `web/src/ot/overrides/PlanNavigator.tsx` | Upstream's gallery without its premium plans, guided tour, connect-AI and clear-workspace entry points. |

The same plugin also:
- replaces `__APP_VERSION__` inside OpenTakeoff's tree with `0.1.0+brink` (upstream's `package.json` version; EasySchematic defines the same global for itself);
- re-points literal colours in SVG presentation attributes (CSS variables do not resolve there) at Brink literals, per file, and fails the build if one of them is no longer in upstream's source:

| File | Upstream | Brink |
|---|---|---|
| `src/lib/ui.js` (`SVG`, the sanctioned literals) | cobalt `#0e636b` / dark `#62d4dc`; danger `#b03a26` / `#ff6b57`; positive `#1f6b4a` / `#35d48f` | Brink Blue `#1f5a96` / `#8ebbea`; danger `#b42318` / `#ff8f86`; ok `#17703e` / `#6fd69a` |
| `src/pages/TakeoffCanvas.jsx` (overlay chrome) | `#1f3fc7`, `rgba(31,63,199,…)`, `rgba(37,99,235,…)` | Brink Blue `#1f5a96`, `rgba(31,90,150,…)` |
| | danger `#b03a26` | `#b42318` |
| | source-trace highlight (amber) `#c47a10`, `rgba(196,122,16,.18)` | Brink Blue `#1f5a96`, `rgba(31,90,150,.18)` |
| | grips and captions in warm greys and cream: `#faf6ea`, `#0b0e14`, `#9a917f`, `#6b6256`, `#5b544a`, `#8a8577`, `#c9c2b2`, `#1c1914`, `#14120e` | Brink neutrals: `#ffffff`, `#0d161f`, `#a9b4bf`, `#4e5b67`, `#4e5b67`, `#6b7884`, `#a9b4bf`, `#16222f`, `#0d161f` |

Not re-pointed (data, or deliverables): condition colours and hatches (`lib/takeoffConstants.ts` `PALETTE` / `HATCH_IDS`, `lib/canvasConstants.js` `FLOORING_DEFAULTS`), draw styles, markup, stamp and RFI colours, and the marked set PDF (`lib/markedset.js`).

### 4. Theme: the Brink tokens

`web/src/design/ot-theme.css`, scoped to the Takeoff tab's `.bk-ot` element (upstream renders nothing outside its own tree, no portals):
- upstream's variables (`--paper-*`, `--ink*`, `--cobalt*`, `--c-*`, tints, shadows, `--stage`, `--ring`) point at the Brink tokens; `--hairline-warm` (upstream keeps it warm on purpose) is the Brink line; `--glow` is none;
- its fonts (`--f-display`, `--f-body`, `--f-mono`) are Roboto (`--font-ui`); numerals stay tabular where upstream asks;
- its scales (`--sp-*`, `--fs-*`, `--ctl-*`, shell sizes) are upstream's values; `--r-1` is the Brink 4 px control radius;
- upstream's `app.css` classes the canvas uses (`.btn-primary`, `.btn-ghost`, `.field-label`, `.text-input`, `.card`, `.panel`, `.badge`, `.tag`, `.skeleton`, `.ink-panel`, `.paper-*`, `.t-*`, `.pip`) take the Brink look inside `.bk-ot .app-shell` only, so the Brink chrome around it is untouched;
- dark mode is the app's `.dark` class;
- the tool rail, panel rail, status strip and canvas corner buttons are hidden (the Brink chrome replaces them);
- print: upstream's `print.css` prints its report subtree only; the Brink header and chrome step out of the way.

### 5. Storage

The canvas reads one live binding, `store` (`lib/store.js`). Upstream swaps it with `setActiveStore()` for its own cloud mode; the Takeoff tab does the same, before the canvas mounts, with `web/src/ot/store.ts` (a store adapter, no vendored file changed):

| Data | Where it lives |
|---|---|
| Plan PDFs | `brink_sheets` + the private Supabase Storage bucket `brink-plans`, through the Worker (`/api/projects/:id/sheets`). The browser never holds a Storage credential. |
| The takeoff (shapes, conditions, sheet scales) | Read as the import's raw takeoff with the takeoff edit layer applied (`GET …/takeoff`); saved as edit-layer ops (`POST …/takeoff/edits`, brink-merge's `diffTakeoff`), which re-run the import (`brink-merge/docs/takeoff-edits.md`) |
| Live updates from other tabs | Upstream's own sync bridge (`store.syncBridge.onRemoteUpdate`): it defers while a person is mid-gesture and re-hydrates when idle |
| Markups, RFIs, approval seals, rules, estimate settings | Kept in the browser tab only, and listed as "not saved" in the status bar |
| Open sheets, groups, condition palette, units | Per tab |
| Condition templates, material and stamp libraries | Upstream's local store (browser-global by design, as in upstream's cloud mode) |
| Snapshots (revisions) | Upstream's local store, scoped to the project |
| Preferences (`opentakeoff_*`, `ot.*`, `ot-author`) | The real localStorage. The EasySchematic workspace replaces `window.localStorage` for its own keys; these pass straight through it (`web/src/es/storage.ts`). |

Upstream stamps `author` / `updated_by` on shapes from a declared name; the tab declares the Cloudflare Access email. The edit row's `editor_email` (from the verified JWT) is the authority.

### 6. Aliases and type checking

`@brink/ot-host` resolves to `web/src/ot/host.ts` (the patch's import), `@brink/takeoff-workspace` to `web/src/ot/load.ts`. `web/tsconfig.ot.json` checks `web/src/ot/` with upstream's compiler options (`allowJs`, `checkJs: false`, strict `.ts`).
