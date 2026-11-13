# Logo files compared with the Brand Guidelines PDF

The logo SVGs in `web/public/brand/` against the logo artwork in the **Brink Design Brand Guidelines v1.0** PDF, rendered at 288 dpi. The PDF is the owner's and is not in the repository.

| File | Compared with | PDF artwork (px) | Overlap (IoU of the ink) | Differing pixels / ink |
|---|---|---|---|---|
| `compare-shield-navy.png` | page 3, the navy shield | 959 × 826 | 0.973 | 2.7% |
| `compare-shield-white.png` | page 4, the white shield on navy | 599 × 516 | 0.963 | 3.8% |
| `compare-wordmark-navy.png` | page 5, the navy wordmark | 879 × 374 | 0.993 | 0.8% |
| `compare-wordmark-white.png` | page 5, the white wordmark on navy | 879 × 374 | 0.992 | 0.8% |

Each image is the PDF crop, the SVG rendered by Chromium at the same size, and an overlap map (grey: both, red: PDF only, blue: SVG only). The differences are a one-pixel fringe along the edges (anti-aliasing and the threshold), thickest on the thin frame and DESIGN strokes, so the smaller page-4 shield scores lowest. Shapes, proportions, the BRINK break-through and the gap all match. `compare.json` has the numbers.

The shield SVGs are the owner-supplied master (`Brink_Design.svg`, 2026-10-28) with path data unchanged; the wordmark SVGs are cut from it. See `web/public/brand/README.md`.

`app-icon-512-and-32.png`: the interim app icon at 512 px and at 32 px (favicon size).

Reproduce: `scripts/brand-logo-compare.py` (its header has the steps).
