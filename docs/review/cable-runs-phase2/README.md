# Division 27 cable runs — Phase 2 canvas evidence

Browser run of `web/scripts/verify-cable-runs.mjs` against a production build, headless
Chromium 1194, 1500 × 950 viewport, offline (external requests aborted and listed in
`results.json`). The fixture is invented: the bundled `demo/sample-plan.pdf` with a TR labeled
MDF, three DATA-1 wall-outlet markers (2 Cat 6A per location, 12% waste), three straight route
segments of 33.33 ft at 1/4" = 1'-0", and one agent-linked run. It is made by
`web/scripts/make-cable-fixture.mts` through the MCP server's own `Session`.

Result: **19 of 19 checks**, no console errors (`results.json`).

| Expected | Observed |
|---|---|
| Link Run readout before commit: route 33.33 LF, per cable 33.33 + 23 + 10 + 10 = 76.33 LF, 2 cables = 152.66 LF | `route 33.33 LF · per cable 76.33 LF · 2 cables = 152.66 LF` |
| After linking the second device: 2 pulls, 4 cables of 3 devices, 2 × 152.66 = 305.32 LF net, × 1.12 = 341.96 LF with waste, 1 unlinked | `2 pulls · 4 cables of 3 devices`, `305.32 LF net · 341.96 LF with waste`, `1 unlinked` |
| ⌘Z unlinks, ⇧⌘Z re-links, Accept all clears the pending run and ⌘Z restores it | all four observed |
| Clearing Vertical withholds every run on the condition with the reason inline; entering it again restores them | `0 pulls`, "Runs withheld: Vertical is required — enter the job's vertical"; then `2 pulls` |
| Enter with no route segment refuses and links nothing | message bar: "the run needs at least one route segment", still 2 pulls |

| Screenshot | Shows |
|---|---|
| `01-cues-on-sheet.png` | Amber cues on the two unlinked devices and routes, the TR's name, the imported agent run |
| `02-runs-panel.png` | The Runs panel: totals, the pending run with Accept, the unlinked list, the TR name field |
| `03-link-run-readout.png` | Link Run mid-draft: device, segment 1, TR highlighted, the readout |
| `04-linked.png` | After ⏎: the route loses its cue, the panel shows 2 pulls |
| `05-report-cable-summary.png` | The Report's Cable summary and Unlinked list |
| `06-show-unlinked.png` | Report → Show: the unlinked device framed and selected |
| `07-condition-cable-setup.png` | The cable setup in the condition properties |
| `08-vertical-cleared-withheld.png` | Vertical cleared: the inline reason, every run withheld |

Reproduce: the commands at the end of [`docs/design/CABLE_SETUP_PLAN.md`](../../design/CABLE_SETUP_PLAN.md).
