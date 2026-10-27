# EasySchematic open check (Task 5 acceptance)

`scripts/es-open-check.mjs` started the real EasySchematic app and loaded brink-merge's output through the app's own Load input. The run captured the canvas, Pack List and Cable Schedule; the full numbers are in [results.json](results.json).

**Setup**

| Item | Value |
|---|---|
| EasySchematic | commit `e2f178c` (v0.44.1), Vite dev server |
| Dependencies | `npm ci`, `patch-package`, then `npm run generate-fallback` to build the bundled device library |
| Input | `fixtures/div27-sample` → `node bin/brink-merge.mjs ... --out job.schematic.json` |
| Schema | v43, EasySchematic's current version, so no migration ran |

**Results**

| Check | Expected | Observed |
|---|---|---|
| Load | no "Invalid schematic" alert | no dialog; tab title "Brink Div 27 sample (invented) — EasySchematic" |
| Console / migration errors during the load | none | none (`loadErrors: []`) |
| Device nodes on the canvas | 18 (16 devices + 2 patch panels) | 18 |
| Connections rendered | 23 (one per cable) | 23 |
| Pack List models | all 5 mapped models | all 5 shown |
| Pack List quantities | ACS 2, DATA 7, CAM 3, panel 2, WAP 4 | 2 / 7 / 3 / 2 / 4 ([02-pack-list.png](02-pack-list.png)) |
| Cable Schedule lengths | every measured per-cable length | all 10 distinct lengths shown, e.g. 59.1 / 67.5 / 75.8 ft ([03-cable-schedule.png](03-cable-schedule.png)) |

**Notes**

- **Console errors at boot:** six `401 (Unauthorized)` errors appear while the app starts, before any file is loaded. They come from EasySchematic's cloud API, because no user is logged in. They are not caused by the loaded file.
- **Cable Type column:** EasySchematic fills its own *Cable Type* column from the port connectors ("Ethernet", "Cat6"). OpenTakeoff's `cable_type` ("CAT6A CMP") is the connection's line label instead, and it is also on the BOM.
- **Layout:** the canvas ([01-canvas.png](01-canvas.png)) is the Stage 1a grid layout, grouped by room label. Real plan placement is Stage 1b.
