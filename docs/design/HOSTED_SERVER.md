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
