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
