# Brink hosted server (`brink-server/`)

One always-on Node server that holds every bid's files and lets Claude work on
them 24/7 through an MCP connector.

## The workflow it serves

1. On the phone: download the bid package (zip, or loose PDFs) from SAM.gov or
   the GC's portal, open the upload page, pick or create the project, upload.
   Bytes go straight from the phone to Cloudflare R2 in parts (no size cap that
   matters; a dropped part retries).
2. The server unpacks the zip (nested zips too), sorts each file (plan, spec,
   SOW, form, doc, sheet, image), and extracts its text page by page.
3. In any Claude (phone, web, desktop, Claude Code) with the connector added:
   list projects, search and read the documents, open a project's plans, run
   the full OpenTakeoff takeoff, and write the marked set, report, estimate and
   proposal. What the tools write is pushed back to R2 and gets a download link.
4. The Brink parts list / schematic tools run on the same server.

Claude never receives a whole file: it reads text pages, searches and rendered
crops through tools, so a 300 MB plan set is no different from a 3 MB one.

## Pieces

| File | Owns |
|---|---|
| `src/types.ts` | Shared contracts (store layout, manifest, interfaces). Change only by agreement. |
| `src/storage.ts` | `FsStorage` (tests, local) and `R2Storage` (S3 API, SigV4 via aws4fetch, presigned GET and multipart). |
| `src/projects.ts` | Project manifests in the store, per-project write lock. |
| `src/ingest.ts`, `src/extract.ts` | Upload → files/ (+ text/): zip unpack with safety limits, classification, PDF/Word/Excel/text extraction. |
| `src/search.ts` | Page-level search and reading over extracted text. |
| `src/workspace.ts` | Local disk mirror the takeoff engine reads; pushes tool outputs back. |
| `src/config.ts` | Environment → `Config`. |
| `src/auth.ts` | Owner login (scrypt password, signed cookie), OAuth 2.1 authorization server for the Claude connector (dynamic client registration, PKCE, rotating refresh tokens), bearer guard. |
| `src/http.ts`, `public/` | Express app: login, upload page and its JSON API, downloads, health. |
| `src/mcp.ts`, `src/projectTools.ts` | `/mcp` (OpenTakeoff session per MCP session + project tools) and `/mcp/brink`. |
| `src/bidTypes.ts` | Bid contracts (settings, price book, `BidDraft`). Change only by agreement. |
| `src/settings.ts`, `src/pricebook.ts` | Owner settings + playbook (`system/settings.json`, `system/playbook.md`; percentages are fractions) and the append-only price book (`system/pricebook.json`). |
| `src/bid/price.ts`, `src/bidTools.ts` | `priceBid` (takeoff + settings + price book → `BidDraft`, using `web/src/lib/cable.js` and `totals.js` at runtime) and the bid MCP tools (`price_bid` writes `outputs/bid/bid.json`). |
| `src/main.ts` | Wiring. |
| `Dockerfile`, `docs/HOSTED.md` | Image and deploy guide. |

## Rules

- The store is the source of truth; local disk is a cache and can be wiped.
- Originals are never overwritten or deleted by tools. Outputs live under
  `outputs/`.
- Every route except `/login`, `/api/health`, the OAuth endpoints and their
  well-known metadata needs the owner (cookie) or a valid bearer token (MCP).
- Unpacking refuses unsafe paths (absolute, `..`), caps entry count, per-file
  and total uncompressed size, and nesting depth.
- No secrets in files. Config comes from the environment.
- Test fixtures are invented. No real plans in the repository.

## Owner decisions (2026-11-16 quiz)

- One user: the owner. One login.
- Chat happens in the regular Claude apps through this server's connector; no
  chat UI of our own.
- Claude does the whole bid as a draft: takeoff → pricing → Excel workbook →
  proposal PDF → marked plans + schematic. Nothing is final until the owner
  presses Approve on the project page; MCP tools cannot approve.
- Review is on the phone: the owner looks at the marked sheets and numbers and
  tells Claude what to fix. No phone editing UI.
- Work is mostly federal (SAM.gov). The owner fills and signs the federal
  forms; the system does not draft them.
- Material prices: Claude's own lookups and the owner's past bids. Every price
  is kept with its source and date in a price book and reused on later bids.
- Labor: hours per item × the owner's rate. Markup: overhead % + profit %.
- Proposal: the owner's letterhead (name, address, UEI, CAGE, logo), stamped
  DRAFT until approved, without the OpenTakeoff watermark or footer line
  (NOTICE makes that line a request, not a license condition). The
  attribution the license does require, in the app's legal notice, stays.

### Owner's quoting playbook (2026-11-16)

The owner's playbook (how a Division 27 job is quoted: intake, takeoff rules,
labor units, markup chain, proposal formats) is stored on the server as a
settings document Claude reads at the start of every bid. It is not committed
here: it carries rates, prices, competitor data and company identifiers.
Decisions taken from it:

- Pricing chain: material × (1 + material markup) at the line, + labor hours ×
  labor cost entry → subtotal × (1 + overhead) × (1 + profit) × (1 + SD
  contractor's excise, SD work only, off with an exemption certificate), + bond
  as a separate add. Default material markup 15%.
- Labor cost entry is back-solved from a target bill rate: cost entry = bill
  rate ÷ the chain, so labor sells at the bill rate after the markups.
- Pull labor is per pull, not per cable: a first-cable unit per location plus an
  additional-cable unit (default set 1.20 / 0.45 h wall, 1.40 / 0.50 h ceiling;
  the lowered set only when Claude states open ceilings and short runs). Job
  hours on top: certification and labeling per link, mobilization, travel (site
  days × crew × drive hours), PM % of field hours, submittals, cleanup; mileage
  per vehicle.
- One flat number by default, no priced adds.
- Bid workbook in the owner's form: formulas with the levers on an Assumptions
  tab, each price with source and date, a status per line (live / estimate /
  allowance), a Quotes Needed tab, a Price As Sent row.
- Two proposal formats: the 3-page GC/EC sub-bid, and for federal work the
  cover letter + technical package (compliance matrix, BOM by room) as .docx
  and PDF. The owner fills and signs the forms.
- Claude traces cable routes as well as counting. The phone review opens with
  every link over 250 ft or crossing floors. Before the first live bid, a past
  job (North Rapid PD) is traced on the server and compared against the
  owner's Bluebeam averages (2-port 52.1 ft, APs 65.1 ft, cameras 90.7 ft);
  the difference is reported before the traced lengths are trusted. Its plans
  are private and stay on the server.

### Status (2026-11-16)

Items 1–6 below are built and tested (`test/fullbid.test.ts` runs one invented
bid through all of them). Item 7 needs the deployed server and the owner's
North Rapid PD plans.

### Work after the first build lands

1. Pricing engine on the chain above (labor units per pull and per cable, job
   hours, excise, bond, back-solved labor), cable footage priced from the cable
   order.
2. Price book tools (record / look up, with source and date, live / estimate /
   allowance).
3. Settings on the server: company profile, labor units, rates, markups,
   playbook document; a tool Claude reads them with.
4. Bid workbook export in the owner's form.
5. Proposals: GC sub-bid layout and federal cover letter + technical package
   (.docx + PDF), DRAFT until approved, no watermark.
6. Phone project page: long-link and floor-crossing flags first, outputs, bid
   status, Approve.
7. Calibration run on North Rapid PD before the first live bid.
