# Brink design system

One look for the whole Brink app: the shell (Projects, the project header, BOM & Issues), the schematic editor, and next the takeoff canvas. Neither EasySchematic's nor OpenTakeoff's own look is used.

- **Code**: `dashboard/web/src/design/` (import from `design/index.ts`)
- **Kitchen sink**: the `/design` route shows every token and component live, in the current theme
- **Screenshots**: `dashboard/docs/evidence/cohesive/09-design-light.png` and `-dark.png`

## Re-colouring: one file

Every colour comes from a token in **`web/src/design/tokens.css`**. Components never use raw colours. To apply real brand colours, change the `--bk-accent*` lines there (light block and `.dark` block), rebuild, and check `/design`. Keep each text pair at 4.5:1 or more (the table below).

No brand colour guide exists yet. The palette is a restrained warm-neutral scale that suits the black and white logo, with one accent (deep teal).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bk-canvas` | `#f4f4f2` | `#0b0b0c` | App background behind panels |
| `--bk-surface` | `#ffffff` | `#161618` | Panels, header, cards, dialogs |
| `--bk-surface-2` | `#fafaf9` | `#121214` | Side panels, table headers |
| `--bk-hover` | `#efeeeb` | `#212124` | Hover fill |
| `--bk-pressed` | `#e5e4e0` | `#2a2a2e` | Pressed / open fill |
| `--bk-line` | `#e3e2de` | `#29292d` | Hairlines, dividers |
| `--bk-line-strong` | `#c4c2bc` | `#45454b` | Control borders, canvas node borders |
| `--bk-ink` | `#18181b` | `#ededef` | Primary text |
| `--bk-ink-2` | `#4f4f57` | `#b0b0b8` | Secondary text |
| `--bk-ink-3` | `#6e6e76` | `#8e8e97` | Tertiary text, icons, placeholders |
| `--bk-accent` | `#0d7377` | `#45c2ba` | **The one accent**: links, selection, active tab, primary button, focus ring |
| `--bk-accent-hover` | `#0a5c5f` | `#6fd3cc` | Accent hover |
| `--bk-accent-soft` | `#e2f1f0` | `#12302e` | Selected tints, info backgrounds |
| `--bk-on-accent` | `#ffffff` | `#04211f` | Text on an accent fill |
| `--bk-accent-fill` / `-hover` | `#0d7377` / `#0a5c5f` | `#0f7f7a` / `#0c6b67` | Fills that carry white text (EasySchematic's blue buttons) |
| `--bk-ok` / `-soft` | `#17703e` / `#e6f4ec` | `#5bd08a` / `#10291b` | Saved, live, confirmed |
| `--bk-warn` / `-soft` | `#8f5a00` / `#fbf1da` | `#e9b949` / `#2d2410` | Unsaved, warnings |
| `--bk-danger` / `-soft` | `#b42318` / `#fbe8e6` | `#ff8a7a` / `#35140f` | Errors, not saved |
| `--bk-flash` | `#fff1b8` | `#3b3410` | A row that just changed live |
| `--bk-paper` / `-origin` | `#ffffff` / `#ecebe7` | `#111113` / `#0a0a0b` | Schematic drawing area / outside the printable origin |

Status colours mean state only, never decoration, and are always paired with text.

**Contrast** (measured, WCAG 2.1; AA needs 4.5:1 for text):

| Pair | Light | Dark |
|---|---|---|
| ink / ink-2 / ink-3 on surface | 17.7 / 8.1 / 5.1 | 15.5 / 8.4 / 5.6 |
| ink-3 on canvas, on surface-2 | 4.6, 4.8 | 6.1, 5.8 |
| accent on surface | 5.6 | 8.3 |
| on-accent on accent; white on accent-fill | 5.6; 5.6 | 7.8; 4.8 |
| ok / warn / danger on their soft fill | 5.4 / 5.2 / 5.6 | 8.0 / 8.4 / 7.3 |
| accent on accent-soft | 4.8 | 6.5 |

## Theme

Light, dark or system (`web/src/design/theme.ts`; the header's sun / moon button). It sets the `.dark` class on `<html>`, which switches the Brink tokens **and** EasySchematic's own dark mode, so there is one theme for the whole app. An inline script in `index.html` applies it before first paint. The choice is stored in the browser as `brink:theme`.

## Type, space, shape

- **Font**: Inter (bundled with the vendored EasySchematic: no external font load), system fallbacks. Numbers in tables use tabular figures; ids and codes use the system monospace (`font-num`).
- **Type scale** (px, Tailwind names): 11 `text-2xs` (panel headings, uppercase), 12 `text-xs`, 13 `text-sm` (tables, controls), 14 `text-base` (body), 16 `text-lg` (dialog titles), 20 `text-xl` (figures), 24 `text-2xl` (page titles).
- **Spacing**: Tailwind's 4 px scale. Controls are 32 px high (28 px small); the header is 48 px; toolbars 44 px; side-panel headers 40 px.
- **Radius**: `rounded-ctl` 4 px (controls), `rounded-panel` 6 px (panels, menus, toasts), `rounded-dialog` 8 px.
- **Elevation**: `shadow-sm` (panels), `shadow-md` (canvas controls), `shadow-lg` (menus, dialogs, toasts).
- **Focus**: one style everywhere, a 2 px accent ring with a 2 px offset, on keyboard focus only (`:focus-visible`).

## Tailwind wiring

`web/src/app.css` is the build's one stylesheet: EasySchematic's `index.css` (unmodified; it carries the single `@import "tailwindcss"`), then `tokens.css`, `theme.css` and `es-theme.css`. `theme.css` adds the Brink names to Tailwind's theme (`@theme inline`): `bg-app`, `bg-panel`, `bg-panel-2`, `bg-hover`, `border-line`, `border-line-strong`, `text-ink`, `text-ink-2`, `text-ink-3`, `bg-accent`, `text-accent`, `bg-accent-soft`, `text-on-accent`, `text-ok`, `bg-ok-soft` (and warn / danger), `font-ui`, `font-num`, the type scale, `rounded-ctl` / `-panel` / `-dialog`. The names never collide with EasySchematic's own CSS variables.

## Components

| Component | File | Notes |
|---|---|---|
| `Button` | `components/Button.tsx` | `primary`, `secondary`, `quiet`, `danger`; `sm` / `md`; optional icon. Defaults to `type="button"`. |
| `IconButton` | `components/Button.tsx` | Icon only. `label` is required: it is the accessible name and the tooltip (with the shortcut). `pressed` makes it a toggle (`aria-pressed`). |
| `Toolbar`, `ToolbarGroup`, `ToolbarDivider` | `components/Toolbar.tsx` | ARIA toolbar: Left / Right / Home / End move between controls. Scrolls sideways on narrow screens; `end` holds right-aligned controls. |
| `Panel` | `components/Panel.tsx` | Titled card, optional count and actions. |
| `SidePanel` | `components/Panel.tsx` | Docked panel: header, optional tabs, scrolling body, optional close. |
| `PropertyList` | `components/Panel.tsx` | Label / value list (inspector). |
| `TabList`, `TabPanel`, `tabClass` | `components/Tabs.tsx` | ARIA tabs with automatic activation and arrow keys; `tabClass` styles routed tabs (the header's project tabs) the same way. |
| `Menu` | `components/Menu.tsx` | ARIA menu button: Enter / Space / Down open, Up / Down / Home / End move, type-ahead, Escape returns focus. Items: action, checkbox (`checked`), heading, separator, shortcut, disabled with a hint. Renders in a portal so a scrolling toolbar never clips it. |
| `Dialog` | `components/Dialog.tsx` | Modal: labelled by its title, focus trapped, Escape and backdrop close, focus returns. |
| `Input`, `Select`, `Field` | `components/Field.tsx` | `Field` ties the label, hint and error to the control (`aria-describedby`, `aria-invalid`). |
| `DataTable` | `components/Table.tsx` | Scrolls inside its own box; sticky header; `num` / `code` / `desc` cell classes; live rows flash. |
| `Badge`, `Status`, `Tag` | `components/Badge.tsx` | Tones `neutral`, `accent`, `ok`, `warn`, `danger`. `Status` is dot + text (save state, live state); `Tag` maps data values (severity, mapping status) to tones. |
| `Toaster`, `toast()` | `components/Toast.tsx` | Bottom-right, polite live region, dismissable. EasySchematic's toasts are routed here too. |
| `Icon` | `icons.tsx` | 16 px line icons, `currentColor`, decorative (`aria-hidden`). |
| `Logo` | `Logo.tsx` | The Brink Design mark: black on light, white on dark. |

## The app frame

- **One header** (`web/src/components/Shell.tsx`): Brink logo, project switcher, the project tabs (Takeoff, Schematic, BOM & Issues; Alt+1/2/3), then the open workspace's save status, the live-updates status, the **Project menu** (file-type actions the workspace contributes: exports, reports, title block, print sheets), the theme toggle and the user menu (Cloudflare Access identity, About & licenses).
- **Workspaces** contribute to the header through `web/src/lib/chrome.ts` (`status`, `menu`) while they are mounted.
- **Pages** use `Page` (title, meta line, actions) from `web/src/components/ui.tsx`.
- **A workspace tab** (Schematic today, Takeoff next) is: a `Toolbar` under the header, a left `SidePanel` (library / sheets), the canvas, a right `SidePanel` with `TabList` tabs (inspector and the tool's own panels), and a status bar under the canvas. Mark Brink chrome inside a canvas tab with `data-bk-chrome`, so the tool's single-key shortcuts never fire from it.

## Brand files

`web/public/brand/Logo Transparent Black@2x.png` and `Logo Transparent White@2x.png`. **The files in the repository are generated placeholders**: the originals are in the owner's Google Drive ("Brink Design" folder). Overwrite them, keeping the names, and rebuild. They are imported as assets (the build's public folder is the vendored EasySchematic's, for its fonts).

## For the OpenTakeoff canvas (next phase)

To match this system the takeoff tab should:
1. mount the canvas in the tab like the schematic workspace (no frame), behind a typed lazy entry like `@brink/schematic-workspace`;
2. replace OpenTakeoff's top bar, logo and menus with a Brink `Toolbar` (tools, zoom, undo) and put file-type actions (marked PDF, DXF, reports, print) in the header's Project menu through `chrome.ts`;
3. use `SidePanel`s for sheets (left) and conditions / inspector (right), and the status bar for save and calibration state;
4. map OpenTakeoff's design tokens (`web/src/styles/tokens.css`: `--sp-*`, `--fs-*`, colours) to the Brink tokens in a scoped CSS file, as `es-theme.css` does for EasySchematic; SVG presentation attributes there take literal colours (`web/src/lib/ui.js` `SVG`), so those need Brink values passed in, not CSS variables; condition palettes stay as they are (they are user data);
5. keep its single-letter shortcuts inside the canvas and mark Brink chrome `data-bk-chrome`;
6. use the `.dark` class for its dark mode.
