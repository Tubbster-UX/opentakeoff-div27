# Portal push

`brink-merge portal-push` builds a **Draft** proposal in Portal (portal.io) from a project's current import. It pushes parts only. Labor is waiting on a catalog design the owner has to approve: see [portal-labor-proposal.md](portal-labor-proposal.md).

**Dry run is the default.** A dry run makes no network request. It prints the exact ordered request plan and records the attempt in `brink_portal_pushes`.

```bash
# dry run from the database (DATABASE_URL, --db-url, or BRINK_PGLITE_DIR)
node bin/brink-merge.mjs portal-push --project "Job name"
# dry run from files (not recorded)
node bin/brink-merge.mjs portal-push --bom-json bom.json --map data/catalog-map.json
# live: a person runs this after reading the dry run
PORTAL_REFRESH_TOKEN=... node bin/brink-merge.mjs portal-push --project "Job name" --live --confirm <plan hash>
```

**Options:**
- `--exclude-cable` leaves every cable line out. Each one is listed as not pushed.
- `--proposal-name` sets the proposal name. The default is `<project> - Division 27`.
- `--area` sets the area name. The default is `Division 27`.
- `--app-version` sets the `appVersion` query parameter. The default comes from `PORTAL_APP_VERSION`, then the observed build `2026.10.23.1`.
- `--new-proposal` allows a second live push for a project that already has one.
- `--json` prints the report as JSON.

**Exit codes:**
- `0`: planned, or a live push succeeded
- `1`: aborted, refused because of an earlier push, or failed
- `2`: bad usage, or live mode without `--confirm`

The brink MCP server's `portal_push` tool runs a **dry run only**. A live push is always a person running the CLI.

## What gets pushed

Everything comes from the import's BOM lines and the catalog in the database. Prices are never part of brink-merge: each item's `cost`, `sellPrice` and `supplierId` come from Portal's `/products/basicinfo/{partId}`.

| BOM line | Pushed as | Quantity |
|---|---|---|
| `device`, `tr` | Its catalog row's part (`portal_sku` = Portal partId) | BOM qty (EA). It must be a whole number. Held and unlinked devices inside the count are named in the plan. |
| `cable_order` (one per cable type) | The cable type's part in `cableParts` / `brink_portal_cable_parts` | `orderBasis: "box"`: OpenTakeoff's box count. `orderBasis: "ft"`: OpenTakeoff's order LF, rounded up to whole feet. |
| `cable` (per condition and TR) | Not pushed | The cable is bought through its `cable_order` line. |
| `pathway`, `other`, `material` | Not pushed | They are listed in the plan. A `pathway` or `other` row that has a `portal_sku` is an error, because no push rule exists for it. |

**Cable is mapped only when the mapping is unambiguous.** All of these must hold:
- The cable part is `confirmed` and has a partId.
- `portalUnitOfMeasure` is set. A live push checks it against basicinfo's `unitOfMeasure` and aborts on a difference.
- For `box`: OpenTakeoff stated a box size, and it equals the part's `packageFt`.

Anything else is an error. brink-merge never guesses a cable part.

## Abort rules (before any write)

The whole push aborts, and every offending line is listed, when any of these is true:
- The import has an `error` issue.
- A device or TR line is unmapped, or its row is `proposed`.
- A confirmed row has an empty `portal_sku`, or one that is not a positive integer (`^[1-9][0-9]*$`).
- The import's `portal_sku` differs from the catalog's. Re-import.
- A quantity is not a whole number.
- A cable type has no cable part, or the part is not confirmed. The unit is unset, the box size is missing or differs, or a cable type has no order line.

**In live mode, these also abort:**
- The plan hash differs from `--confirm`.
- There are no credentials.
- The project already has a live push.
- Any part's basicinfo returns 404, a status other than `Activated`, a non-numeric `cost` or `sellPrice`, no `supplierId`, or a `unitOfMeasure` that differs from the cable part's. All parts are read first, so every bad part is reported together.

A failure **after** the proposal exists is recorded as `failed`, with the proposal id and the item ids added so far. It is never retried automatically, and it blocks a later live push until someone passes `--new-proposal`.

## Push record

`brink_portal_pushes` has one row per attempt:
- `dry_run`
- `status`: `planned`, `aborted`, `started`, `succeeded` or `failed`
- `plan_hash`
- `plan`: the items, the lines not pushed and the request plan
- `errors`
- `app_version`
- `portal_proposal_id`, `portal_area_id`, `portal_area_option_id` and `portal_item_ids`
- timestamps

Tokens and credentials are never stored, printed or logged. Credentials come only from the environment: `PORTAL_REFRESH_TOKEN`, or `PORTAL_USERNAME` with `PORTAL_PASSWORD`. Error text from Portal is redacted.

## Portal API used

Base `https://api.portal.io` (`PORTAL_BASE_URL` overrides it). Every request carries `appVersion=<build>`, `Accept: application/json` and, on a POST, `Content-Type: application/json`. No request carries a cookie. Authenticated requests also carry `Authorization: Bearer <accessToken>`.

1. `POST /authenticate/login?skipInterceptors` `{userName, password}`. Only the `refreshToken` is used. It is skipped when `PORTAL_REFRESH_TOKEN` is set.
2. `POST /access-token?skipInterceptors` `{refreshToken, useTokenCookie:false}` returns `{accessToken}`. It is called again 30 s before the JWT's `exp` (a token with no readable `exp` is treated as lasting 300 s). On a 401 it is called once and the request is retried once.
3. `GET /products/basicinfo/{partId}` for each distinct part, before any write.
4. `POST /proposals` `{name}`. The response must be `status: "Draft"`.
5. `GET /proposals/{id}?excludeDescriptions=true&frameOnly=true&showAreaOptionDescription=true` reads `proposalDates.lastModified`.
6. `POST /proposals/{id}/area` `{name}` with `If-Unmodified-Since: <lastModified>`. `areaOptions[0].id` is used from the response.
7. `POST /proposals/{id}/items` sends one Part per request, and the response must be exactly one `proposalItemId`.

The request builders are in `src/portal/requests.ts`. The qty and sellprice adjustment builders exist, with `setDefault:false` and `updateAllInstances:false`, but the plan does not use them. brink-merge has no builder for sending, finalizing, emailing or changing the status of a proposal. It has none for `POST /proposal/assignpeoplelocation` either: the customer is left unset.

## Not confirmed from the captures

- **Login token:** login returns `bearerToken`. Whether that token works as an access token is not confirmed, so the push always gets its access token from `/access-token`.
- **Usable part statuses:** only `Activated` is known to be usable.
- **`unitOfMeasure` values:** Portal's vocabulary for them is not known, so the cable part has to state the exact string.
- **`If-Unmodified-Since` on item adds:** whether `POST /items` needs it is not known. It was seen only on the area add, so the item adds do not send it.
- **Re-run behavior:** what Portal does when the same part is added twice to one area is not known. Each BOM line is a separate request.
- **Draft cleanup:** no delete endpoint was captured. A failed live push leaves a Draft proposal, which someone removes in Portal by hand.
