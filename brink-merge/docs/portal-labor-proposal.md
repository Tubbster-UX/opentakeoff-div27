# Proposal: Portal labor in the catalog (awaiting approval)

**Status:** proposed. None of this is built yet. The parts-only push works without it.

## Goal

When a Portal push runs, add Labor items next to the parts. Each Labor item's quantity is derived from OpenTakeoff's measured numbers by a rule stored in the catalog. As with parts, prices come from Portal and are never stored in brink-merge.

## Catalog fields (additive only)

### Catalog rows

`data/catalog-map.json` rows and `brink_catalog_map` gain an optional `portalLabor` array. In the database it is a `portal_labor jsonb` column, added with `add column if not exists`:

```json
"portalLabor": [
  { "laborItemId": "5501", "basis": "per_device", "unitsPer": 0.75, "rounding": "ceil", "status": "proposed",
    "note": "Terminate and test a 2-port outlet" }
]
```

| Field | Meaning |
|---|---|
| `laborItemId` | Portal's id for the labor item. It is sent as `referencedItemId` with `itemType: "Labor"` and no `supplierId`. |
| `basis` | `per_device`: the device line's count. `per_cable`: the cables homed from this condition, summed over its BOM `cable` lines. `per_cable_lf`: the measured **net** LF of those cables, since waste is not installed. `per_tr`: the TR count. |
| `unitsPer` | Labor units per basis unit, for example 0.75 hours per device, or 1.5 hours per 100 LF written as 0.015 per LF. |
| `rounding` | `ceil` rounds up to a whole unit, because the only observed `itemQuantity` was an integer. `none` would be allowed only once Portal is confirmed to accept fractional quantities. |
| `status` | `proposed` or `confirmed`. Only confirmed labor lines are pushed, and an unconfirmed one aborts the push, as a part does. |

### Cable parts

A `cableParts` entry may carry the same `portalLabor` array, for example cable pulling at `per_cable_lf`. The database gains a matching `portal_labor jsonb` column on `brink_portal_cable_parts`.

## Push behavior

- Labor items are added after the parts, into the same area, one request each.
- Each item's quantity is `round(basis x unitsPer)`. The plan shows the arithmetic, for example `7 devices x 0.75 h = 5.25, rounded up to 6`.
- A labor line with a missing or invalid `laborItemId` aborts the push. So does a confirmed labor line whose basis is zero while its device count is not.
- `--exclude-labor` skips labor explicitly, the same way `--exclude-cable` skips cable.

## Questions for the owner (needed before building)

1. **Where labor prices come from.** The captures show no read endpoint for a labor item, and `/products/basicinfo` is for parts. A capture of adding a Labor item in the Portal UI is needed: the request that loads the labor item, and the full add-item body for a Labor item, including whether it carries `cost` and `sellPrice`. Until then, labor cannot be priced from Portal, and brink-merge will not invent a rate.
2. **What a labor item's unit is** (hours, or each), and whether `itemQuantity` may be fractional.
3. **The rates.** Confirm the starting `unitsPer` values for each condition (DATA-1, WAP-1, CAM-1, ACS-1, TR) and each cable type, or say whether to price labor per device instead.
4. **Where labor goes.** Should it sit in the same area as the parts, or in its own area, for example "Division 27 Labor"?
