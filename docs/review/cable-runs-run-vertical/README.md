# Division 27 cable runs: per-run vertical (item 4) evidence

An invented takeoff on the bundled `demo/sample-plan.pdf`, made through the MCP server's own
`Session` (`web/scripts/make-cable-fixture.mts`: a TR labeled MDF, three DATA-1 wall outlets
with 2 Cat 6A each at 12% waste and a 23 ft vertical, three 33.33 ft routes, one agent-linked
run). Nothing here comes from a real project.

## Canvas, in a browser

`web/scripts/verify-cable-runs.mjs` against a production build: headless Chromium 1194,
1500 × 950 viewport, offline. External requests were aborted and are listed in `results.json`.

Result: **38 of 38 checks**, no console errors. The first 30 are the Phase 2, follow-up and
Phase 3 checks, re-run unchanged; 8 are new.

| Expected | Observed |
|---|---|
| **↕** on a run opens blank fields with the condition's values as placeholders | vertical blank, placeholder `23`; cables placeholder `2` |
| A vertical of −2 | refused inline (`vertical must be a number of ft, 0 or more`); totals unchanged at 305.32 LF net |
| Vertical 9 ft on one run: 33.33 + 9 + 10 + 10 = 62.33 per cable, × 2; totals 152.66 + 124.66 = 277.32 LF net | row `→ MDF · 62.33 LF × 2`, under it `run's own: vertical 9 ft (condition 23 ft)`; totals 277.32 LF net |
| ⌘Z, then ⇧⌘Z | 305.32 LF net with no override line, then 277.32 again |
| Reopen the editor | the vertical field holds `9` |
| Cables 3 beside it: 62.33 × 3 + 152.66 | 339.65 LF net; `vertical 9 ft (condition 23 ft) · 3 cables (condition 2)` |
| Blank both fields and Set | 305.32 LF net, no override line; the Report and the marked set that follow read exactly as in Phase 3 |

| Screenshot | Shows |
|---|---|
| `11-run-override-editor.png` | The ↕ editor open on a run, with 9 typed and the condition's values named |
| `12-run-vertical-override.png` | The run at 62.33 LF per cable with its override line; totals 277.32 LF net |

To repeat, from `web/`:

```
npm run build
node --import tsx scripts/make-cable-fixture.mts /tmp/cable-fixture.json
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER_PATH=/path/to/chrome \
  node scripts/verify-cable-runs.mjs /tmp/cable-fixture.json /tmp/cable-ui/results.json
```
