# Brand files

The Brink Design logo, per the **Brink Design Brand Guidelines v1.0** (October 2026). `web/src/design/Logo.tsx` imports these files; `web/src/main.tsx` uses the app icon as the favicon. How the app uses each one is in [`docs/design-system.md`](../../../docs/design-system.md#logo-in-the-app).

| File | What it is | Source |
|---|---|---|
| `brink-design-shield-navy.svg` | The shield (primary logo), Brink Navy `#0D161F`. Default on white and light grounds. | **Owner-supplied master**: `Brink_Design.svg`, received 2026-10-28. Path data unchanged; only the file header was tidied (XML declaration, DOCTYPE, `width` / `height="100%"` and the unused `serif` / `xlink` namespaces removed; a `<title>` and `role="img"` added). |
| `brink-design-shield-white.svg` | The shield in white, for Brink Navy / Navy 700 grounds. | The master with every fill changed from `#0d161f` to `#ffffff` (the guide's approved white version). Nothing else changed. |
| `brink-design-wordmark-navy.svg` | The wordmark (secondary logo): BRINK over DESIGN, no shield. | **Derived** from the master, as the guide says ("cut from the shield master"): the two hexagon-frame paths removed and the `viewBox` recomputed to the remaining BRINK + DESIGN bounds (`0 222.526 743.366 315.886`, measured with the browser's `getBBox`). No other edits. |
| `brink-design-wordmark-white.svg` | The wordmark in white. | As above, fills `#ffffff`. |
| `brink-design-app-icon.svg` | **Interim** app icon / favicon: the white shield centred on a Brink Navy 512 × 512 square, shield 400 px wide with at least its clear space (X ≈ 40 px) on every side. | Built from `brink-design-shield-white.svg` (paths unchanged, scaled into place). |
| `brink-design-app-icon-512.png` | **Interim** 512 px PNG of the app icon (Apple touch icon). | Rasterised from `brink-design-app-icon.svg` in Chromium. |

**Interim items for the owner.** The guide names `brink-design-app-icon-512.png` as the favicon / app icon source. Until the official file is supplied, the two app-icon files above are generated from the master shield. Replace them with the official file (keeping the names) when it exists. The wordmark spacing follows the **vector master**: the guide's pending decision notes that its PNG wordmarks carry slightly more space between BRINK and DESIGN. If the owner picks the PNG spacing, re-cut the wordmark SVGs.

The guide's full logo file list (page 14). Only the SVGs above are in this repository; the app does not need the PNG exports.

| Group | File | Use (from the guide) |
|---|---|---|
| Shield | `brink-design-shield-navy.svg` | Master vector, navy. Default on white. |
| | `brink-design-shield-white.svg` | Vector, white, for navy grounds. |
| | `brink-design-shield-black.svg` | Vector, black. One-color print only. |
| | `brink-design-shield-navy.png` / `-black.png` | Transparent, 378 px. |
| | `brink-design-shield-white-on-navy.png` | 755 px square. Social avatars, profiles. |
| | `brink-design-app-icon-512.png` | 512 px. App icon and favicon source. |
| | `brink-design-banner-320x132.png` | Email signature, directory listings. |
| | `brink-design-screen-1920x1080.png` | 16:9. Video end cards, lobby screens, slide covers. |
| | `brink-design-shield-white-on-black.png` | Crops BRINK at the edge; re-export before reuse. |
| Wordmark | `brink-design-wordmark-navy.svg` / `-white.svg` | Vector, cut from the shield master. |
| | `brink-design-wordmark-navy.png` | Transparent, 1422 px. |
| | `brink-design-wordmark-white-on-black.png` | 1422 px. |
| | `brink-design-wordmark-black-on-white.png` / `-black.png` | 711 px. Black versions are one-color only. |
| | `brink-design-wordmark-white.png` | Transparent, 711 px. |

Rules that apply to every file here: never recolour (navy or white only; black is for one-colour print), no effects, no stretching, never close the gap where BRINK breaks through the frame, never rebuild the logo from a PNG or screenshot. Clear space is X, the height of the word DESIGN, on every side. Minimum on screen: shield 80 px wide, wordmark 64 px wide.

The comparison of these files with the logo as the guidelines PDF renders it is in `docs/evidence/cohesive/brand/`.
