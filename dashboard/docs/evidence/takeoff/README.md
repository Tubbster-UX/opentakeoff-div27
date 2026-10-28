# Takeoff tab evidence

Taken by `npm run takeoff-check` (`scripts/takeoff-check.mjs`) on 2026-10-28, against local Supabase (Postgres, Realtime and Storage) with Cloudflare Access verified by the Worker (a local stand-in team). Every screen uses brink-merge's invented fixtures and the repository's `demo/sample-plan.pdf`. `results.json` has every check and its observed value.

**Result: 30 of 30 checks passed.**

## How to reproduce

```bash
# 1. local Supabase from brink-merge/ (README "Run it locally"; Storage must be running)
# 2. import brink-merge/fixtures/div27-sample.takeoff.json with its report
# 3. dashboard/.dev.vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
cd dashboard
npm run takeoff-check        # builds, starts its own wrangler dev with Access, drives two users
```

## Expected and observed

| Step | Expected | Observed |
|---|---|---|
| Mount | The OpenTakeoff canvas in the tab, no iframe; no OpenTakeoff top bar, tool rail, logo or status strip; the Brink header, toolbar, sheets and right panels | 0 iframes, 0 upstream chrome elements; 1 Brink toolbar, logo, sheets panel and right panel |
| No plan file | The Brink empty state names the takeoff's sheet; loading writes nothing | "sample-plan.pdf, 41 takeoffs on sheets with no plan file"; no edit rows written |
| Upload | The PDF goes to the private `brink-plans` bucket under the Access email, and the Worker serves it back | 891 bytes, 1 page, in `storage.objects`; the read-back sha256 matches; the page holds no Storage key |
| Draw | The takeoff draws over the plan | 41 machine shapes on view |
| Count | A count drawn with the canvas's Count tool saves a `shape_put` under the Access email and re-runs the import | A new current import; the second tab's BOM goes from DATA-1 7 EA to 8 EA, live, in 309 ms |
| BOM note | BOM & issues says the count differs from the report because of an app edit (a warning) | "DATA-1: 8 EA after edits made in the Brink app; OpenTakeoff's report (exported before them) says 7 ..." |
| Machine original | Moving an agent's marker keeps its original ring and actor; the import's raw takeoff is unchanged | `actor: agent`, `proposed_verts_norm` kept; `takeoff_sha256` unchanged; the inspector says "Machine original kept" |
| Delete | `shape_delete`; the BOM goes back down, live | DATA-1 7 EA in 311 ms |
| Second canvas | B's canvas shows A's new count live; A's tab ignores its own echo | 41 to 42 shapes in 778 ms; no reload notice in A's tab |
| Reload, re-import | Edits persist; a CLI re-import reloads the canvas with the edits re-applied, and the BOM too | 42 shapes, 4 active edits; DATA-1 8 EA on the new import |
| Project menu | Upstream's exporters run from the Brink Project menu | Marked set PDF (9721 bytes), DXF (8842 bytes), takeoff JSON (30505 bytes) |
| Dark mode | The app's `.dark` class themes the canvas chrome | Passed |
| Phone (390 px) | No horizontal page scroll; the toolbar scrolls inside itself, side panels hidden | 0 px overflow |
| Errors | No page errors in any tab | None |

## Screenshots

| File | What it shows |
|---|---|
| `01-no-plan-yet-light.png` | The tab before any plan file is uploaded |
| `02-plan-uploaded-light.png` | The uploaded plan with the import's takeoff drawn over it |
| `04-count-drawn-light.png` | A new DATA-1 count drawn with the Count tool |
| `04b-second-tab-bom-live.png` | The second user's BOM & issues after the save (DATA-1 8 EA) |
| `05-machine-marker-moved-inspector-light.png` | An agent's marker moved; the inspector says who made it and that the original is kept |
| `07-second-tab-canvas-live-light.png` | The second user's canvas after A's new count arrived live |
| `09-project-menu-light.png`, `09d-project-menu-dark.png` | The Project menu with the takeoff's exports |
| `09b-takeoff-tab-light.png`, `09c-takeoff-tab-dark.png` | The whole tab, light and dark |
| `10-phone-takeoff.png` | Phone width |

The cohesive screenshots (`../cohesive/08-takeoff-light.png`, `../cohesive/08-takeoff-dark.png`) and `../cohesive/live-check/06-takeoff.png` show the same tab from `npm run shots` and `npm run live-check`.

## Notes

- Condition swatches keep the takeoff's own colours (user data), so some, such as TR and ACS-1, are not Brink colours.
- "Accept 40 proposed shapes" is upstream's banner for the agent-proposed shapes in the fixture. Accepting is a person's action in the browser; an agent cannot set `reviewed` through the edit layer.
- React 19: the development build mounts the canvas with no React warnings in the console (`vendor/PATCHES.md`, "React 19").
