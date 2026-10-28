# Brink design system

One look for the whole Brink app: the shell (Projects, the project header, BOM & issues), the schematic editor, and next the takeoff canvas. Neither EasySchematic's nor OpenTakeoff's own look is used.

It follows the **Brink Design Brand Guidelines v1.0** (October 2026): colour, type, logo, iconography and voice. Where the guide leaves a choice open for a dense app (dark theme, secondary greys, status colours), this page records what we chose and why.

- **Code**: `dashboard/web/src/design/` (import from `design/index.ts`)
- **Kitchen sink**: the `/design` route shows the brand palette, every token and component live, the type scale and the wordmark, in the current theme
- **Screenshots**: `dashboard/docs/evidence/cohesive/` (light and dark), the logo comparison in `dashboard/docs/evidence/cohesive/brand/`
- **Contrast test**: `dashboard/test/tokens.test.ts` (part of `npm run check`)

## Colour

Every colour comes from a token in **`web/src/design/tokens.css`**. Components never use raw colours. HEX is the reference.

### The guide's palette

| Name | HEX | Role in the guide | In the app |
|---|---|---|---|
| Brink Navy | `#0D161F` | The brand colour, logo ink, dark grounds | Text (`ink`), primary buttons, the app header field, the dark theme's canvas |
| Navy 700 | `#1E2D3D` | Large supporting fields beside navy | The dark theme's panels; hover in the header |
| Brink Blue | `#1F5A96` | The accent, one highlight per page (**proposed**) | The one accent: links, focus ring, selection, the live-change flash tint, accent badges |
| White | `#FFFFFF` | The default ground | Canvas and panels (light) |
| Surface Raised | `#F3F5F7` | Cards, table headers | Side panels, table headers, the schematic's origin (`surface-2`, `paper-origin`) |
| Line | `#D5DBE1` | Hairline rules | Hairlines and dividers (`line`); secondary text on navy (`ink-2`, dark) |
| Border Strong | `#6B7884` | Input outlines | Input and control outlines (`line-strong`) |
| Ink Muted | `#4E5B67` | Captions, metadata | Captions, metadata, icons, placeholders (`ink-3`) |
| Print Black | `#000000` | One-colour logo only | Not used on screen |

Proportion: white grounds and navy type carry the app, the navy header frames it, and Brink Blue stays a small highlight. **Primary buttons, the active tab underline, checked menu items and pressed toggles are navy, not blue**, so blue is left for links, focus and selection. No warm, cream or tan grounds. Brink Productions amber (`#DEA31E`) is never used: the warning colour is a burnt orange.

Never navy text on Navy 700, never white text on Surface Raised: the token pairs make neither, and the test checks it.

### Tokens

Derived values (not in the guide) are marked †; each is a cool neutral or a tint / shade of a guide colour.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bk-canvas` | `#FFFFFF` | `#0D161F` | App background |
| `--bk-surface` | `#FFFFFF` | `#1E2D3D` | Panels, cards, dialogs |
| `--bk-surface-2` | `#F3F5F7` | `#16222F` † | Side panels, table headers |
| `--bk-hover` | `#E9EDF1` † | `#2A3B4E` † | Hover fill |
| `--bk-pressed` | `#DDE3E9` † | `#34475C` † | Pressed / open / toggled fill |
| `--bk-line` | `#D5DBE1` | `#34465A` † | Hairlines, dividers |
| `--bk-line-strong` | `#6B7884` | `#7D8A96` † | Input and control outlines, canvas node borders |
| `--bk-ink` | `#0D161F` | `#FFFFFF` | Primary text |
| `--bk-ink-2` | `#33414E` † | `#D5DBE1` | Secondary text |
| `--bk-ink-3` | `#4E5B67` | `#A9B4BF` † | Captions, metadata, icons, placeholders |
| `--bk-primary` / `-hover` | `#0D161F` / `#1E2D3D` | `#FFFFFF` / `#D5DBE1` | Primary buttons (`--bk-on-primary`: white / navy) |
| `--bk-accent` | `#1F5A96` | `#8EBBEA` † | **The one accent**: links, focus ring, selection |
| `--bk-accent-hover` | `#184878` † | `#B3D1F1` † | Accent hover |
| `--bk-accent-soft` | `#E8EFF7` † | `#1F3A57` † | Selected tints, info backgrounds |
| `--bk-on-accent` | `#FFFFFF` | `#0D161F` | Text on an accent fill |
| `--bk-accent-fill` / `-hover` | `#1F5A96` / `#184878` | `#1F5A96` / `#184878` | Fills that carry white text (EasySchematic's blue buttons) |
| `--bk-ok` / `-soft` | `#17703E` / `#E7F3EC` | `#6FD69A` / `#173A2A` | Saved, live, confirmed |
| `--bk-warn` / `-soft` | `#A6480B` / `#FBEDE4` | `#F4A06B` / `#3D2A1E` | Unsaved, warnings (not amber) |
| `--bk-danger` / `-soft` | `#B42318` / `#FBE8E6` | `#FF8F86` / `#40201F` | Errors, not saved |
| `--bk-ok-fill`, `-warn-fill`, `-danger-fill` | `#17703E`, `#A6480B`, `#B42318` | same | Status fills with white text |
| `--bk-flash` | `#DCE8F5` † | `#1F3A57` † | A row that just changed live (a Brink Blue tint) |
| `--bk-paper` / `-origin` | `#FFFFFF` / `#F3F5F7` | `#142030` † / `#0D161F` | Schematic drawing area / outside the printable origin |

**Dark theme.** Built from Brink Navy (canvas) and Navy 700 (panels), with white primary text, the guide's Line neutral as secondary text, and a lighter tint of Brink Blue (`#8EBBEA`, the same hue) that keeps AA on navy. Brink Blue itself stays the fill behind white text. Primary buttons invert to white with navy text.

**The header** is a Brink Navy field in both themes (`.bk-inverse`, which applies the dark values with `surface` = Brink Navy and `hover` = Navy 700).

Status colours mean state only, never decoration, and are always paired with text. Ok, warning and danger differ in hue (green / orange / red, at least 15° apart) and the test checks that.

### Contrast

WCAG 2.1, measured from the tokens (`test/tokens.test.ts` checks these and every other pair the UI uses, in light, dark and the header; AA is 4.5:1 for text, 3:1 for borders, focus rings and icons).

| Pair | Light | Dark | Header (navy) | Min |
|---|---|---|---|---|
| ink on surface | 18.2 | 14.0 | 18.2 | 4.5 |
| ink-2 on surface | 10.5 | 10.0 | 13.1 | 4.5 |
| ink-3 on surface | 7.0 | 6.7 | 10.9 | 4.5 |
| ink-3 on surface-2 | 6.4 | 7.6 | 10.9 | 4.5 |
| ink-3 on hover | 5.9 | 5.4 | 8.4 | 4.5 |
| accent on surface | 7.1 | 7.0 | 9.1 | 4.5 |
| accent on canvas | 7.1 | 9.1 | 9.1 | 4.5 |
| accent on accent-soft | 6.1 | 5.8 | 5.8 | 4.5 |
| on-accent on accent | 7.1 | 9.1 | 9.1 | 4.5 |
| white on accent-fill (Brink Blue) | 7.1 | 7.1 | 7.1 | 4.5 |
| on-primary on primary | 18.2 | 18.2 | 18.2 | 4.5 |
| ok / warn / danger on surface | 6.1 / 5.9 / 6.6 | 7.9 / 6.7 / 6.4 | 10.2 / 8.8 / 8.3 | 4.5 |
| ok / warn / danger on their soft fill | 5.4 / 5.2 / 5.6 | 7.0 / 6.5 / 6.6 | 7.0 / 6.5 / 6.6 | 4.5 |
| white on danger-fill | 6.6 | 6.6 | 6.6 | 4.5 |
| ink on flash | 14.7 | 11.7 | 11.7 | 4.5 |
| line-strong (input outline) on surface | 4.5 | 4.0 | 5.2 | 3 |

The guide's approved pairs hold: navy on white 18.2, Ink Muted on Surface Raised 6.4, white on Navy 700 14.0, blue on white 7.1, white on blue 7.1.

## Theme

Light, dark or system (`web/src/design/theme.ts`; the header's sun / moon button). It sets the `.dark` class on `<html>`, which switches the Brink tokens **and** EasySchematic's own dark mode, so there is one theme for the whole app. An inline script in `index.html` applies it before first paint. The choice is stored in the browser as `brink:theme`.

## Type

- **Roboto**, bundled from `@fontsource/roboto` (Light 300, Regular 400, Medium 500, Bold 700; Latin and Latin Extended), imported in `web/src/main.tsx`. No external font request at runtime. Fallbacks: Helvetica Neue, then Arial.
- **Weights**: Bold 700 for headings; Medium 500 for all-caps labels and eyebrows, tracked +0.12 em (`.bk-label`); Regular 400 for body; Light 300 only at 18 px and up.
- **Headings are sentence case** ("BOM & issues", "Current import source").
- **Scale** (the guide's, px size / line height, with the Tailwind names):

| Guide | Tailwind | Size | In the app |
|---|---|---|---|
| Display | `text-display` | 48 / 52 Bold | (/design only) |
| Heading 1 | `text-2xl` | 32 / 40 Bold | |
| Heading 2 | `text-xl` | 24 / 32 Bold | Page titles, stat figures |
| Heading 3 | `text-lg` | 18 / 24 Bold | Card and dialog titles |
| Body | `text-base` | 16 / 24 | Longer text |
| Small | `text-sm` | 14 / 20 | **The app's dense default**: tables, controls, panels, menus |
| Label | `text-2xs` / `text-xs` + `.bk-label` | 12 / 16 Medium caps +0.12 em | Panel headings, table headers, eyebrows, menu headings |

  Dense app chrome uses Small and Label (the guide allows it); the hierarchy above follows the guide.
- **Numbers** in tables use tabular figures; ids and codes use the system monospace (`font-num`).
- **EasySchematic** uses Roboto too: `es-theme.css` re-points its `'Inter'` (global CSS, inline styles and SVG `font-family` attributes on canvas nodes, edges and page overlays) at the Brink font. Canvas node text stays small, as upstream draws it. Exported PNG / SVG captures use Roboto; upstream's PDF exports embed their own Inter files.

## Space and shape

- **Spacing**: Tailwind's 4 px scale. Controls are 32 px high (28 px small); the header is 48 px; toolbars 44 px; side-panel headers 40 px.
- **Radius**: `rounded-ctl` 4 px (controls), `rounded-panel` 6 px (panels, menus, toasts), `rounded-dialog` 8 px.
- **Elevation**: `shadow-sm` (panels), `shadow-md` (canvas controls), `shadow-lg` (menus, dialogs, toasts), navy-tinted.
- **Focus**: one style everywhere, a 2 px Brink Blue ring with a 2 px offset, on keyboard focus only (`:focus-visible`).

## Logo in the app

Files and their sources: [`web/public/brand/README.md`](../web/public/brand/README.md). The component is `Logo` (`web/src/design/Logo.tsx`).

| Where | Logo | Size | Colour |
|---|---|---|---|
| App header (every screen) | **Wordmark** | 72 px wide, about 31 px high (minimum 64 px) | White on the Brink Navy header, both themes |
| `/design`, Logo section | Wordmark specimens | 128 px wide | Navy on white, white on Brink Navy |
| Browser tab (favicon), home-screen icon | **App icon**: the white shield on Brink Navy | Interim SVG + 512 px PNG | White on navy |

- **Why the wordmark in the header.** The header is 48 px high; the shield at its 80 px minimum width is about 69 px high and does not fit with its clear space. The guide names narrow headers as a wordmark use.
- **Why no shield on any app screen.** The header is on every screen, and the guide says never to show the shield and the wordmark on the same surface. So in the app the shield is the app icon only (outside the page). The shield files are linked from `/design` to view on their own.
- **Clear space**: `Logo` pads itself by X, the height of DESIGN (about 10% of the logo's width: 7.3 px at 72 px). **Minimum sizes**: `Logo` never renders a shield under 80 px or a wordmark under 64 px wide.
- **Colour**: navy (`#0D161F`) on white and light grounds, white on Brink Navy / Navy 700. Never blue, gray or any other colour; no effects; never stretched (the image keeps the vector's aspect ratio); never rebuilt from a PNG.

## Icons

- **One family**: the Brink set in `web/src/design/icons.tsx`, which the shell already used: outline only, 16 px grid, round caps and joins, **1.5 px stroke at every rendered size** (non-scaling stroke via `.bk-icon`), `currentColor`, so icons are navy (or Ink Muted) on light grounds and white on navy. No filled icons (the one filled glyph was removed). Status dots in `Status` are state indicators, not icons.
- Icons are decorative (`aria-hidden`); a control that shows only an icon carries its own label.
- **EasySchematic's own icons** inside the canvas and device library stay upstream's (mostly outline, `currentColor`, so they take the Brink colours). Its two page-tab "add" buttons printed emoji; `es-theme.css` gives them Brink outline icons through a CSS mask.

## Voice in the UI

From the guide: straightforward, capable, warm.
- Say what happens, in short sentences and plain words. Specific beats impressive.
- **we / us / our** when the app speaks for Brink Design ("Next, we put the OpenTakeoff canvas in this tab", "Our internal project app at Brink Design").
- No hype words, no exclamation points, no emoji, no lightning bolts or electric clichés.
- The name is **Brink Design**: two words, title case. Never "Brink Design Co.", "BrinkDesign" or "BRINK DESIGN" in running text (the logo's capitals are artwork).
- Headings and labels in sentence case.
- **EasySchematic's bolt and emoji** ("⚡ Auto-Route", "⚡ Routing…", the USB-C badge's "⚡", page-tab 📄 / 🔌) are hidden without patching the vendored files: `es-theme.css` lists "Brink Hidden Glyphs" first in the editor's font stack, a 772-byte font whose only glyphs are empty (`scripts/make-hidden-glyphs-font.py`), with a `unicode-range` covering just those code points. The characters stay in the DOM text (a screen reader may still announce them); upstream's own wording ("Auto-Route", "Create New Device") is kept.

## Tailwind wiring

`web/src/app.css` is the build's one stylesheet: EasySchematic's `index.css` (unmodified; it carries the single `@import "tailwindcss"`), then `tokens.css`, `theme.css` and `es-theme.css`. `theme.css` adds the Brink names to Tailwind's theme (`@theme inline`): `bg-app`, `bg-panel`, `bg-panel-2`, `bg-hover`, `border-line`, `border-line-strong`, `text-ink`, `text-ink-2`, `text-ink-3`, `bg-primary`, `text-on-primary`, `bg-accent`, `text-accent`, `bg-accent-soft`, `text-on-accent`, `text-ok`, `bg-ok-soft` (and warn / danger), `font-ui`, `font-num`, the type scale (and `.bk-label`), `rounded-ctl` / `-panel` / `-dialog`. The names never collide with EasySchematic's own CSS variables.

## Components

| Component | File | Notes |
|---|---|---|
| `Button` | `components/Button.tsx` | `primary` (navy fill), `secondary`, `quiet`, `danger`; `sm` / `md`; optional icon. Defaults to `type="button"`. |
| `IconButton` | `components/Button.tsx` | Icon only. `label` is required: it is the accessible name and the tooltip (with the shortcut). `pressed` makes it a toggle (`aria-pressed`, a neutral pressed fill). |
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
| `Icon` | `icons.tsx` | The one outline family: 16 px grid, 1.5 px stroke at any size, `currentColor`, decorative (`aria-hidden`). |
| `Logo` | `Logo.tsx` | `variant` `wordmark` (default) or `shield`; `tone` `auto` (navy on light, white on dark), `navy` or `white`; minimum widths and clear space built in. |

## The app frame

- **One header** (`web/src/components/Shell.tsx`), a Brink Navy field: the white Brink Design wordmark, project switcher, the project tabs (Takeoff, Schematic, BOM & issues; Alt+1/2/3), then the open workspace's save status, the live-updates status, the **Project menu** (file-type actions the workspace contributes: exports, reports, title block, print sheets), the theme toggle and the user menu (Cloudflare Access identity, About & licenses).
- **Workspaces** contribute to the header through `web/src/lib/chrome.ts` (`status`, `menu`) while they are mounted.
- **Pages** use `Page` (title, meta line, actions) from `web/src/components/ui.tsx`.
- **A workspace tab** (Schematic today, Takeoff next) is: a `Toolbar` under the header, a left `SidePanel` (library / sheets), the canvas, a right `SidePanel` with `TabList` tabs (inspector and the tool's own panels), and a status bar under the canvas. Mark Brink chrome inside a canvas tab with `data-bk-chrome`, so the tool's single-key shortcuts never fire from it.

## Brand files

`web/public/brand/`: the shield (owner-supplied master SVG, navy, and its white version), the wordmark (cut from the master), and the interim app icon. Each file's source and the guide's file list are in [`web/public/brand/README.md`](../web/public/brand/README.md). They are imported as assets (the build's public folder is the vendored EasySchematic's, for its fonts).

## For the OpenTakeoff canvas (next phase)

To match this system the takeoff tab should:
1. mount the canvas in the tab like the schematic workspace (no frame), behind a typed lazy entry like `@brink/schematic-workspace`;
2. replace OpenTakeoff's top bar, logo and menus with a Brink `Toolbar` (tools, zoom, undo) and put file-type actions (marked PDF, DXF, reports, print) in the header's Project menu through `chrome.ts`;
3. use `SidePanel`s for sheets (left) and conditions / inspector (right), and the status bar for save and calibration state;
4. map OpenTakeoff's design tokens (`web/src/styles/tokens.css`: `--sp-*`, `--fs-*`, colours) to the Brink tokens in a scoped CSS file, as `es-theme.css` does for EasySchematic; SVG presentation attributes there take literal colours (`web/src/lib/ui.js` `SVG`), so those need Brink values passed in, not CSS variables; condition palettes stay as they are (they are user data);
5. keep its single-letter shortcuts inside the canvas and mark Brink chrome `data-bk-chrome`;
6. use the `.dark` class for its dark mode;
7. use Roboto (map OpenTakeoff's font variables to `--font-ui`), the Brink outline icons, and the voice rules above for its labels.
