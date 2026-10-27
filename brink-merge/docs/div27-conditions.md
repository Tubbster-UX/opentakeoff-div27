# Division 27 conditions in Brink's OpenTakeoff fork (Task 0)

These findings come from reading the fork's Division 27 work and from exports the engine itself wrote. They decide how brink-merge joins a takeoff to EasySchematic devices and, later, to Portal SKUs.

- **Source:** the Division 27 work lives on branch `claude/div27-cable-setup-c6t9wu` at commit `a2fe5c1`. It is not on `main`.
- **Spec:** the branch's `docs/design/CABLE_SETUP.md` and `web/src/lib/cable.js`.
- **Fixtures:** made by the branch's MCP `Session` (see [fixtures/generate](../fixtures/generate/README.md)).

## What a Division 27 export carries

The takeoff export keeps the schema id `opentakeoff.takeoff_canvas.v1`. All Division 27 fields are optional, so older documents load and export unchanged.

### `condition`

| Field | Values | Meaning |
|---|---|---|
| `cable_setup` | object or absent | Present on a **device condition**. A non-empty `device_type` is what makes a condition a cable device (`cable.js` `hasCableSetup`). |
| `cable_setup.device_type` | `wall_outlet`, `wap`, `camera`, `access_door`, `ceiling_other`, `custom` | Inputs such as `data_drop` and `cctv` are accepted as aliases, but only these six are ever stored. |
| `cable_setup.cables_per_location` | integer ≥ 1 | Cables per pull. A run can override it. |
| `cable_setup.cable_type` | free text | For example `CAT6A CMP`. It groups the cable summary and is never parsed. |
| `cable_setup.vertical_ft`, `loop_device_ft`, `loop_tr_ft` | number or null | Stated allowances. `access_door` has no default vertical. |
| `cable_setup.medium` | `copper`, `fiber`, `coax` (optional) | Stated, never inferred. It selects the length check. |
| `cable_setup.max_link_ft` | number > 0 (optional) | The stated length limit. Otherwise 295 ft (TIA-568 copper) is used for copper or unspecified media. |
| `cable_setup.package_ft` | number > 0 (optional) | Box or reel size. Order LF is pooled by `cable_type` and then rounded up to whole boxes. |
| `role` | `"tr"` or `"route"` | `tr`: the condition's count markers are telecom rooms, and the marker's `label` is the TR name (MDF, IDF-1). `route`: the condition's linear shapes are cable pathway. |
| `route_kind` | `"trunk"` or `"branch"` (route only) | Splits a run's route LF into trunk and branch, and turns on the pathway rollup. |

### `condition.materials[]`

Rows look like `{ id, name, per, basis, unit, round, note, lib_id?, origin_id?, inherited? }`. Division 27 adds two values for `basis`:
- `cables`: for example, one jack per cable.
- `pulls`: for example, one faceplate or camera mount per location.

OpenTakeoff computes these quantities, and its report carries them (`conditions[].materials[].qty`).

### Top-level `cable_runs[]`

```
{ id: "run-<uuid>", device_shape_ids[], route_shape_ids[] (device -> TR order), tr_id,
  cables_override?, vertical_override?, provenance: { method, actor, reviewed, created_at } }
```

- A hold is written as `{ id: "hold-<uuid>", route_shape_ids: [], tr_id: "", hold: { reason } }`.
- **A run stores no length.** Length is resolved from the linked shapes when it is read.

### `shape`

- `measure_role` is one of `count`, `linear`, `floor_area`, `deduct`, `surface_area`.
- `computed.perimeter_lf` on a linear shape is plan length plus any rise/drop legs.
- `label` is the only room or zone field. On a TR marker it holds the TR name.

### Cable math and where it lives

OpenTakeoff computes cable figures in `cable.js` and writes them in `export_report`'s `cable` block (`runs`, `summary`, `order`, `pathway`, `unlinked`, `held`, `warnings`). The takeoff export does not contain them. The formulas:

- Per cable = route plan LF + vertical + loop at device + loop at TR
- Location = per cable × cables
- Order = location × (1 + waste %)
- The ×N multiplier applies to pulls, cables and LF in the summary.

**Decision (confirmed with Alexavier):** brink-merge takes cable quantities from that report and never recomputes them. Summing `perimeter_lf` over linear shapes (as the original brief proposed) is wrong for cable for three reasons:
- it counts a shared trunk once instead of once per run
- it includes rise/drop legs the cable model ignores
- it leaves out the vertical and loop allowances

brink-merge does one cross-check: each linked run's `route_lf` must equal the sum of its route shapes' stored `plan_lf ?? perimeter_lf`. A report that does not match its takeoff is an error.

## D2: is there a part identity? No

Nothing in a Division 27 export identifies a part (manufacturer and model, distributor part number, or Portal id):

- **`materials[].lib_id`** links a row to the material library. That library is a browser-global IndexedDB store (`web/src/lib/store.js` `material_library`), not part of the takeoff document. Its entries are `{ id, name, unit, per, basis, round, note }`, with no manufacturer, model or SKU.
- **`cable_setup.cable_type`** is free text. A part number can be typed into it, but nothing structures or validates it.
- **`cable_setup.device_type`** is a category (six values), not a product.

**Join key:** the condition's `finish_tag` (for example `DATA-1`, `CAM-1`, `TR`), with `kind` checked against the condition:
- `device` needs a `cable_setup`
- `tr` needs `role: "tr"`
- `route` needs `role: "route"`

A finish tag can be renamed in OpenTakeoff. When that happens, brink-merge reports the new tag as an unmapped condition (an error) and never guesses. The catalog map (`data/catalog-map.json`, or the `brink_catalog_map` table) is where Brink attaches the model and, later, the Portal SKU.

## Seeded mapping proposals (for Alexavier to confirm)

| Condition | OT kind | EasySchematic `deviceType` | Port (per cable) | Notes |
|---|---|---|---|---|
| `DATA-1` | wall_outlet | `wall-plate` | ethernet, RJ45 front / 110 punch-down rear | 2 cables per location |
| `WAP-1` | wap | `access-point` | ethernet, RJ45 | |
| `CAM-1` | camera | `camera` | ethernet, RJ45 | `ptz-camera` and `turret-camera` also exist |
| `ACS-1` | access_door | `door-strike` | rs485, terminal block | ES has no card-reader type; rs485 assumes OSDP |
| `TR` | role tr | `patch-panel` | ethernet, RJ45 / 110 | one panel per TR marker, sized to the cables homed there |
| `ROUTE`, `TRUNK`, `BRANCH` | role route | none | none | pathway LF, not a cable quantity |

- Every row is `proposed`, with no model and no Portal SKU.
- Proposed mappings show up as warnings on every BOM until they are confirmed.
- The finish tags come from the invented fixtures. Brink's real job tags will differ, and each one shows up as an unmapped error until it has a row.
