# Fixture provenance

Every `fixtures/*.json` file was written by the real OpenTakeoff engine, not typed by hand:
- the engine is the MCP `Session` from branch `claude/div27-cable-setup-c6t9wu` at commit `a2fe5c18d2583e4e93a57ea0c4fc3b41a7e4f664`
- it ran on the repository's bundled `demo/sample-plan.pdf`
- the takeoffs themselves are invented and contain no real project data

| File | Written by |
|---|---|
| `<name>.takeoff.json` | `Session.exportPayload()`, the payload of `export_takeoff` |
| `<name>.report.json` | `Session.exportReport()`, the document `export_report` returns and writes |

The fixtures:
- **`div27-minimal`:** the branch's own `web/scripts/make-cable-fixture.mts` layout:
  - 1 TR (MDF) and 3 `DATA-1` outlets with 2 × CAT6A each
  - three 33.33 ft routes, one linked run
  - hand check: 33.33 + 23 + 10 + 10 = 76.33 ft per cable; × 2 cables = 152.66 LF; × 1.12 waste = 170.98 LF
- **`div27-sample`:**
  - 2 TRs, trunk and branch pathway
  - DATA, WAP (×2 multiplier), CAM and ACS conditions with room labels
  - per-run verticals and a pole camera over 295 ft
  - a hold, an unlinked device and an unlinked route
  - 1000 ft box sizes and cables/pulls materials rows

## Required follow-up: when Div 27 merges onto current upstream

These fixtures were made from `a2fe5c1`, which is built on the fork's old `main` (`18c1f1d`). Upstream OpenTakeoff has since moved to `798ee88`. Merging upstream into the Div 27 branch conflicts in 32 files. Two of them sit next to the cable math, and once reconciled they could shift per-run numbers:

- **`web/src/lib/totals.js`** holds the condition totals, the cables/pulls materials bases, and the ×N and waste roll-ups.
- **`web/src/lib/takeoffDocument.js`** is the takeoff export writer. Upstream added `estimate_settings`, `bid_proposal` and `split_view`; Div 27 added `cable_runs`.

Once the reconciled Div 27 branch merges, do all of the following before trusting brink-merge on a real bid:

1. Regenerate both fixture pairs from the reconciled engine (commands below), and record its commit in this file.
2. Run `npm run check`. The rollup-vs-report test, the per-run route LF cross-check, and the BOM-vs-report totals compare brink-merge against the new engine. If a pinned total changes, find out why before updating the test.
3. Re-run `scripts/es-open-check.mjs` on the new sample output.

## Regenerate

From the repository root:

```bash
REPO=$(pwd)
git fetch origin claude/div27-cable-setup-c6t9wu
mkdir -p /tmp/ot-div27 && git archive origin/claude/div27-cable-setup-c6t9wu | tar -x -C /tmp/ot-div27
(cd /tmp/ot-div27/web && npm ci) && (cd /tmp/ot-div27/mcp && npm ci)
cd /tmp/ot-div27/web && node --import tsx "$REPO/brink-merge/fixtures/generate/make-div27-fixtures.mts" /tmp/ot-div27 "$REPO/brink-merge/fixtures"
```

Ids and timestamps change on every run, so regenerating changes the files. The totals the tests assert do not change. Record the new commit here when you regenerate.
