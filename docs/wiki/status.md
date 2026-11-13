# Capability status

This page describes implementation support, not a promise that every plan can
be measured automatically. Follow its source links before changing behavior.

| Capability | Current boundary | Evidence |
|---|---|---|
| Human and agent measurements | Shared geometry/quantity modules; source interpretation still requires inspection | [Geometry workflow](../GEOMETRY_WORKFLOW.md) |
| Original machine geometry after human correction | Outer vertices preserved, including manual agent traces; missing historical originals cannot be recovered | [Compatibility](../../protocol/COMPATIBILITY.md) |
| Human stitching | Browser gallery and alignment; editable browser archive preserves composites | [Workflow](workflows.md) |
| MCP stitched documents | No stitch tool; current import/export omits stitch records | [Field inventory](../../protocol/INVENTORY.md) |
| One-Click | Temporarily gated in the default browser/MCP builds | [Gate](../design/ONE_CLICK_GATE.md) |
| Browser/MCP room boundaries | Shared quantity modules do not prove identical detector boundaries; the open [#385](https://github.com/Kentucky-ai/opentakeoff/issues/385) report remains unresolved | [Architecture](architecture.md), [geometry evidence](../GEOMETRY_WORKFLOW.md) |
| Plan-set search, Copy text, on-device page reads | Browser gallery and canvas; MCP text tools read the text layer only, no OCR. OCR reads scanned pages, and the pictures on a vector sheet that its text layer can't read, after a download notice and is labelled OCR; Copy text works on single sheets, not stitched surfaces. Import from schedule reads a raster schedule box on-device after the same notice; the in-canvas agent's `read_schedule` reads the text layer only. Kept OCR reads stay in this browser after sign-out, kept by the PDF's content hash | [User guide](../USER_GUIDE.md#copy-text) |
| Import from schedule—extra forms | Drawn box only: codes followed by a word (FTB-01 CUT) read as the code; NOT USED / N.I.C. rows start unticked; on a text-layer box, a four- or five-letter code with no number is read when the header or a read row is above it, it fills two or more other columns, and a numbered code comes after it, else listed as not read (the on-device raster read neither reads nor lists them, and there a NOT USED or word-after code line in a short table can stay part of the row above; it repairs a `$`, O or I misread in a code and flags the row **read as**); the sheet graph's whole-sheet index reads them as before | [User guide](../USER_GUIDE.md#import-from-schedule) |
| Toolbar command and voice | Gated in the default build; use normal controls and keyboard shortcuts | [User guide](../USER_GUIDE.md#17-voice-and-the-command-box) |
| TakeoffDocument v1 | Draft schemas, preflight and opt-in repository adapters for a bounded profile; legacy writer format remains | [Protocol](protocol.md) |
| Annotation cleanup | Text-only MCP edit with undo; RFI-linked notes refuse | [MCP routing](mcp.md) |
| Division 27 cable runs | Headless: `cable_setup` and `role: "tr"` / `"route"` on conditions, `link_run` / `list_runs` / `unlink_run` / `hold_devices`, cable blocks on the summary, report, CSV and workbook; lengths come only from measured linear shapes, pending agent runs count and are disclosed; in the canvas: cable setup in condition properties, the Link Run tool (`W`), the Runs panel, unlinked cues and the Report's Cable summary; holds with a reason (`hold_devices`, Runs panel), runs over their length limit per cable (a stated `max_link_ft`, else 295 ft for copper or no stated medium; fiber and coax not checked without one) and routes on an unconfirmed agent-set scale flagged; the marked set carries route chips (run ID · device condition · per-cable LF), device run tags, TR names, unlinked/held rings and per-condition cable lines on the cover; route conditions tagged trunk or branch (`route_kind`) split each run into branch and trunk and add a Pathway rollup that counts each segment once. A run may state its own vertical (`vertical_override`: MCP `link_run vertical_ft`, Runs panel ↕), replacing its condition's for that location only, so devices that share a type but not a vertical stay on one condition; MCP changes an existing run's vertical by unlink and relink. A cable setup may state its box or reel length (`package_ft`); the order LF is then rounded up to whole boxes per cable type, pooled across its conditions, and blank on conflicting sizes or a blank type | [Design](../design/CABLE_SETUP.md), [plan](../design/CABLE_SETUP_PLAN.md) |
| Agent knowledge | Packaged wiki resources and source-generated tool/schema references | [Index](README.md) |
| Academy interoperability | Incompatibilities inventoried; no adapter or certification bridge claimed | [Academy report](../../protocol/ACADEMY_COMPATIBILITY.md) |
| Shared work review | Personal layouts/shared review proposal is not merged; do not describe [PR #388](https://github.com/Kentucky-ai/opentakeoff/pull/388) as shipped | [Roadmap](../ROADMAP.md) |
| Microsoft 365 annotation sync | Unproven across machines; the live validation remains open in [#315](https://github.com/Kentucky-ai/opentakeoff/issues/315) | [Roadmap](../ROADMAP.md) |
| Learned floor-model bridge | Not on `main`; no model-generated geometry integration is advertised | [Roadmap](../ROADMAP.md) |
| Independent geometry benchmark | Reference-assisted and synthetic checks are not independently reviewed ground truth | [Geometry evidence](../GEOMETRY_WORKFLOW.md#reusable-evidence-from-a-project-test) |

Next protocol work connects the tested contracts to focused MCP workflows and
measures tool-selection/completion results. Broader adapter profiles remain
bounded by preservation tests. Package extraction, verified identity/signatures, Academy credentials
and optional anchoring come later. Rendering optimization is separate from
this protocol and knowledge work.
