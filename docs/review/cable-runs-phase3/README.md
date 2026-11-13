# Division 27 cable runs — bid follow-ups and Phase 3 evidence

Two invented takeoffs on the bundled `demo/sample-plan.pdf`, both made through the MCP
server's own `Session`. Nothing here comes from a real project.

## Canvas, in a browser

`web/scripts/verify-cable-runs.mjs` against a production build: headless Chromium 1194,
1500 × 950 viewport, offline. External requests were aborted and are listed in
`results.json`. The fixture is `web/scripts/make-cable-fixture.mts`: a TR labeled MDF, three
DATA-1 outlets with 2 Cat 6A each at 12% waste, three 33.33 ft routes, and one agent-linked run.

Result: **30 of 30 checks**, no console errors. The first 19 are the Phase 2 checks, re-run.

| Expected | Observed |
|---|---|
| A 300 ft vertical: 33.33 + 300 + 10 + 10 = 353.33 ft per cable on both linked runs, both still counted, one warning | 2 `>295` flags, `2 pulls`, "2 linked runs exceed 295 ft per cable…" |
| Hold the last unlinked device, reason "Furnished by others" | totals `1 held`, no unlinked; the Held list shows the reason and `1 device`; the grey cue replaces the amber one |
| ⌘Z, then ⇧⌘Z | the hold is released, then re-held. Before the fix in plan §12, the redo did nothing. |
| The Report | its Held list names the device and the reason |
| The canvas's marked set: cover | `Cable runs: 2 pulls linked · 1 run pending review · 0 unlinked devices · 1 held device` and `2 pulls · 4 cables · 305.3 LF cable net · 342 LF order at 12% waste · 1 held` |
| The canvas's marked set: sheet | two chips `run-… · DATA-1 · 76.3 LF`; each run ID printed twice, on the chip and beside its device; MDF named; one generic `ROUTE · 33.3 LF` chip left, on the unlinked route |

The full text extracted from that PDF is in `marked-set-text.json`.

| Screenshot | Shows |
|---|---|
| `09-over-295-flag.png` | The Runs panel with both runs flagged `>295` and the warning |
| `10-held.png` | A held device: the Held list with its reason and release, and the grey cue on the sheet |

## Marked set, from MCP

`web/scripts/make-cable-marked-sample.mts` builds 12 runs that share one corridor trunk:
6 DATA-1, 3 WAP-1 and 3 CAM-1. One camera is over 295 ft, one outlet is held "Furnished and
installed by others", and one is left unlinked. It then calls `export_marked_pdf`'s
own code path.

| Image | Shows |
|---|---|
| `marked-set-cover.png` | The cover: the cable meta line, a cable line under each device condition, the route and TR conditions labeled, the key, and the warnings |
| `marked-set-sheet.png` | The sheet: a chip per run spread along the shared trunk, the over-length camera in amber, run IDs beside each device, MDF named, amber and grey rings on the unlinked and held outlets |

Reproduce with the commands in [`docs/design/CABLE_SETUP_PLAN.md`](../../design/CABLE_SETUP_PLAN.md) §13.
