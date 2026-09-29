# Plan: scale constraints + measurement tools

> **Status (audited 2026-09-01): slice 1 shipped 2026-08-25 — WS0, WS1, WS2 and their share of WS7
> are done. The 2026-09-27 2D slice adds named saved rulers, polygons and DEM profiles with source/frame stamps; 3D picking, surface area and volume remain.** See HANDOVER
> 2026-08-25 and 2026-09-27 for what landed. Synthetic 2D measurement, persistence and stale-source workflows pass in Chrome; real GIS comparisons remain:
> `VERIFICATION.csv` ▸ `MEAS-01`…`MEAS-04`, `MEAS-10`…`MEAS-13` are the owed
> checks. Deviations from this plan, both deliberate:
>   • **WS0.4 cloud/mesh export** applies the fitted scale ONLY (no rotation, no
>     origin shift) rather than the whole scaled *local* frame. The orientation
>     half of that frame is a product convention — `buildLocalFrame` guesses a
>     vertical from camera viewing dirs, else cloud PCA — and for an object scan
>     that guess is a PCA axis. Silently re-orienting an exported cloud changes
>     more than the unit the user asked for. Metres in the model's own frame,
>     with no CRS, is what ships.
>   • **D8's product stamps** landed as `frameStamp` on the DEM/ortho only (plus
>     `productFrameStatus` + the ProductViewer banner). The measurement-record
>     stamps now live with `useMeasurementsStore` for saved 2D results.
>
> TODO ▸ `F11` is the source of truth for *whether/when*; this file is the *how*.
> Delete it when WS3–WS7 ship; any unsigned checks remain in `VERIFICATION.csv`.

Executor plan. Read CLAUDE.md first (layering, "pure core", the depth-map
staleness-stamp precedent, the modal framework rules, verification policy).
Everything viewer-side needs a manual browser run this environment may not
support — say so explicitly rather than claiming verification; the pure
`core/products/*` additions are covered by `npm test` + `npm run typecheck`.

## The request

Two features, from the competitor survey:

- **Scale bars / known-distance constraints** — Metashape's staple for
  close-range/object work, where there are no GCPs and therefore no scale.
- **Measurement tools** — Pix4D rayCloud's distance / area / surface / volume,
  plus an elevation **profile**.

They arrive as one request because they are one problem: **a measurement without
a declared scale is a number without a unit.** An object-capture project
(`sceneType: 'object'`, created with `crs: null` —
[NewProjectModal.vue:42](../../src/components/modals/NewProjectModal.vue#L42)) has no
georeference and no CRS, so every length the app could report today is
up-to-scale. Scale therefore ships first, and every measurement readout carries
its unit *provenance*.

## Shipping scope (do not build all eight workstreams as one release)

Ship this in four independently useful slices:

1. **Scale v1:** markers, camera/marker scale bars, residual reporting and the
   effective metric frame (WS0–WS2). This is the minimum object-capture feature.
2. **Measure v1:** saved 3D distance/polyline measurements (WS3 + WS4 distance).
3. **Raster measure:** 2D distance/planimetric area + DEM profile (WS5). This may
   land before 3D area because ProductViewer already has pixel↔world mapping.
4. **Advanced:** tilted planar area, volume, and—only if competitor parity really
   requires it—mesh surface area (the sum of clipped mesh triangles, which is not
   the same quantity as a polygon projected onto a best-fit plane).

Do not call the feature complete merely because one slice lands. Add/report the
verification rows belonging to each slice as it ships.

## What already exists (this is mostly wiring, not new math)

- **Marked points, triangulated.** `triangulateGcp` /`refineGcpPoint`
  ([gcpTriangulation.js](../../src/core/sfm/gcpTriangulation.js)) turn N image marks
  into an SfM-frame 3D point with per-view reprojection residuals. Marking UI
  (right-click ▸ "Add GCP here", guided epipolar/predicted marking, the
  multi-image `ViewerGcp` inspector) is already built around it.
- **The scale seam is already in the frame abstraction.** `makeFrame` carries
  `unit: 'model' | 'm'` and `buildLocalFrame` hardcodes `'model'`
  ([projection.js:163-188](../../src/core/products/projection.js#L163-L188)); the DEM
  op already branches on it
  ([products.js:66](../../src/workers/ops/products.js#L66)), as does ProductViewer
  ([ProductViewer.vue:198](../../src/components/viewers/ProductViewer.vue#L198)).
  Nothing needs inventing — the scale record's whole job is to let a *local*
  frame say `unit:'m'`.
- **The post-hoc fit precedent.** `georeference()`
  ([georeferencing.js](../../src/stores/reconstruction/georeferencing.js)) fits a
  similarity from evidence, persists a small record in `reconstruction.json`,
  and reports residuals it does **not** feed back into the fit.
- **Surfaces + samplers for area/volume/profile.** `meshSurface` / `planeSurface`
  / `resampleSurface` ([surface.js](../../src/core/products/surface.js)) already build
  the `{width,height,gsd,originX,originY,data,mask}` grid, and
  [rasterSample.js](../../src/core/io/rasterSample.js) is **the** raster sampler
  (bilinear + nodata) for DEMs and imported reference rasters.
- **Read-only reporting UI.** `ui/DataTable.vue` + `ui/StatTiles.vue` + the
  Quality Report hub's section pattern.

What does **not** exist: any 3D picking in
[Viewer3D.vue](../../src/components/viewers/Viewer3D.vue) (no `Raycaster`, no pick
buffer). That is the one genuinely new interaction primitive (WS4).

## Design decisions

**D1 — Never rescale the cloud. Scale is a property of the frame.**
Rewriting point/camera coordinates would invalidate the depth-map staleness
stamp, contradict every recorded `summary.*` number, silently break persisted
ortho geotransforms, and have to be redone on each refit. The scale record
instead wraps the local frame with a scalar transform, exactly as
`frameFromSimilarity` does for a georeference.

**Do not scale `east`/`north`/`up`.** `makeFrame` assumes those vectors are
orthonormal and uses them in both directions; a scaled basis makes `fromSfm` and
`toSfm` cease to be inverses. Add `frameFromScaledLocal(base, scale)` (or make
`buildLocalFrame(..., { scale })` implement the same algebra):

```
fromSfm(p) = scale · base.fromSfm(p)
toSfm(c)   = base.toSfm(c / scale)
```

Keep the serialized basis unit-length and store `scale` separately in the local
frame descriptor. Add an inverse round-trip test; this is the regression test
that catches accidental double-scaling.

**D2 — One effective frame, resolved by evidence rank, in one place.**
`CRS georeference > scale constraints > none`. Add a single resolver to
`useReconstructionStore`, `effectiveFrameSpec → { frameSpec, scale, unit:
'm'|'model', source: 'georef'|'scalebars'|null, stamp }`, and let every readout
and product builder ask it. A scalar-only getter is insufficient: horizontal
distance and Δz also need the resolved orientation. A CRS fit already carries
scale, so when both exist the georeference wins and the bars become checks (D6).
Two parallel unit systems is the failure mode to avoid.

**D3 — Fit the scale post-hoc, not inside bundle adjustment — and for the common
case that is exact, not an approximation.**
Scale is one of the seven gauge freedoms of the reprojection cost: a similarity
leaves every residual unchanged. So "constrain scale in BA" and "scale the frame
afterwards" produce the *same model*. The two stop being equivalent only with ≥2
mutually disagreeing bars, where a BA-side distance residual would deform the
model to split the difference. That residual couples two point blocks, which
breaks the block-diagonal structure the Schur complement in
[bundle.rs](../../crates/reconstruction/src/bundle.rs) eliminates against — real Rust
work, and **deferred until a dataset shows a bar residual big enough to care.**
Note `anchor_flat` is *not* a shortcut here: it anchors absolute positions, which
a scale bar does not know.

**D4 — A scale-bar endpoint is a *marked* point, not a picked one.**
Reuse the GCP machinery with a third role, `marker`: a GCP with observations and
**no** surveyed coordinates. The null coordinates are useful representation, but
**not a safety boundary**. Change every BA/georeference/leave-one-out eligibility
gate to require `role === 'control'` explicitly. Today most sites happen to be
gated on finite `x/y/z` plus `precisionFromGcp` —
[georeferencing.js:74](../../src/stores/reconstruction/georeferencing.js#L74),
[sfm.js:1185-1188](../../src/core/sfm/sfm.js#L1185-L1188),
[useReconstructionStore.js:1158-1162](../../src/stores/useReconstructionStore.js#L1158-L1162)
— but relying on nulls would let a migrated, imported or accidentally edited
marker become a ground constraint. Concrete edits this needs:
  - `normalizeGcpRole` ([gcp.js:132](../../src/core/io/gcp.js#L132)) collapses anything
    unknown to `'control'`, so a marker would reload from disk as a control point
    at whatever coordinates the table happens to hold. It must round-trip
    `'marker'`.
  - `addGcp` seeds `x:0, y:0` ([useGcpsStore.js:244](../../src/stores/useGcpsStore.js#L244)) —
    finite, i.e. a control point at the CRS origin. A marker must seed all three
    coordinates `null` (the same reasoning as the existing `z: null` rule: zero is
    a valid coordinate, never a missing-value sentinel).
  - The `CTL`/`CHK` badge and the binary `role === 'check' ? … : …` ternaries in
    [GcpsSection.vue:68-70](../../src/components/layout/sidebar/GcpsSection.vue#L68-L70)
    and [useQualityReport.js:173](../../src/composables/useQualityReport.js#L173).
  - The GCP table hides the coordinate/accuracy columns for a marker row.
  - Rename user-facing mixed lists/toolbars from “GCPs” to “Control & Markers” or
    “Reference Points”. The imported-GCP command remains aerial-only; the mixed
    point table/editor does not.
  - Change `addGcp()` to `addPoint({ role = 'control' })` (name is flexible). The
    Scale Bars modal's guided “Mark point” action calls it with `marker`; never
    create a control and mutate its role afterward.

**D5 — A bar is its own record, not a GCP field.** New project-scoped store
`useScaleBarsStore` (`registerProjectStore`, persisted `scalebars.json`), items
`{ id, name, a, b, knownDistanceM, accuracyM, displayUnit, enabled }` where each endpoint is
`{ kind: 'marker'|'camera', id }`. Camera↔camera bars (a calibrated rig baseline,
a surveyed camera pair) cost nothing extra — the centres are already known — and
give object projects a scale with no marking at all.

Metres are canonical internally, but the modal must accept `mm | cm | m` because
close-range users commonly know a dimension in millimetres. `accuracyM` is 1σ;
when present use `weight = 1 / accuracyM²`. Missing accuracy gets weight 1 and is
labelled “equal weight”, not silently presented as surveyed uncertainty. Reject
same-endpoint, missing-endpoint, non-positive-distance and non-positive-accuracy
records. A deleted marker/camera leaves a visible invalid bar until the user
repairs or deletes it; it must never silently disappear from the report.

**D6 — Every bar always reports a residual**, whether or not it defines the
scale. That is the checkpoint pattern, and the same rule that keeps
`gcpAccuracyReport` non-robust: a disagreeing bar is exactly the disagreement the
report exists to surface, so nothing gets dropped from the report — only from the
fit, and only when the user unchecks it.

**D7 — Measurement geometry is pure core.** `core/products/measure.js`, plain
data in/out, unit-tested. Viewers pick and render; they compute nothing.

**D8 — Store geometry in its native frame and stamp every content dependency.**
A 3D pick lands in the **SfM frame** and is stamped with the cloud actually shown
and picked (`{ id, kind, createdAt }`), not unconditionally with the main sparse
cloud. On mismatch it is stale and its numbers grey out; it is never silently
re-displayed over another cloud. A 2D pick stores product-frame coordinates plus
the exact product frame descriptor. Geometry-only 2D distance/planimetric area
depends on that frame; profile/true-area/volume additionally stamps the DEM or
surface content revision. Add `{id, createdAt, sourceStamp, frameStamp}` to newly
generated products because a geotransform alone cannot detect regenerated data.

**D9 — Never print a bare number, never fabricate a metre.** With no scale, a
measurement renders as `12.47 model units` with a one-line hint pointing at scale
bars. This is the whole reason the two halves ship together.

**D10 — Picking: raycast first, pick-buffer only on measured need.**
`THREE.Raycaster` handles the mesh and the sparse cloud directly (`Points`
needs `params.Points.threshold` in **world** units, so derive it from the scene
extent and the current point size — a fixed threshold is meaningless in a frame
whose scale is arbitrary, which is this feature's entire premise). Points
raycasting is O(N) per click, so **measure it on a real dense cloud (20–30 M
points) before deciding**; if a click costs more than ~150 ms, upgrade to a
GPU pick buffer (render an index-encoded pass into a small scissored render
target, `readPixels`), which is O(screen) and cloud-size independent.

For the raycaster seam, convert the configured point size in pixels to a world
threshold at the candidate depth (`worldPerPixel ≈ 2·depth·tan(fov/2)/viewportH`)
and clamp it to a small fraction of the robust scene radius. Record pick source
and snap threshold with the measurement so its precision is inspectable.

**D11 — Fits and derived products are stamped, never trusted forever.** A
`scaleFit` is a cached result derived from the current sparse model, enabled bar
records, endpoint marker observations and camera centres. Persist
`sourceStamp:{id,createdAt}`, `evidenceDigest`, and `createdAt` with it. The digest
must deterministically include the enabled bar fields plus the observations of
referenced markers. If either stamp differs, `effectiveFrameSpec` refuses the fit
and the UI says “Scale changed—Apply again”. A DEM/ortho records the effective
frame stamp used to build it; after a scale/georef refit it remains viewable in
its own recorded frame but gets an “outdated frame—rebuild” banner and cannot be
mistaken for a product in the current frame.

## Exact UI/command placement

These are additions to the current Ribbon structure, not a new navigation model:

| Where | Command id | Label | Behaviour / gate |
| --- | --- | --- | --- |
| `Tools ▸ Georeferencing` | `scale-bars` | `Scale Bars` | Opens `ScaleBarsModal`; `needsSparse`, never `aerialOnly`. Add one `MODAL_COMMANDS` entry in App.vue. |
| `View ▸ Inspect` | `open-gcp-table` | `Control & Markers` | Keep the existing command id and rename its label/modal; remove `aerialOnly`, retain `needsGcps`. The import-GCP button stays aerial-only. |
| `View ▸ Inspect` | `open-measurements` | `Measurements` | Opens saved-measurement manager; enabled when a project exists. One `MODAL_COMMANDS` entry. |
| `View` while 3D viewer is active, new dynamic group `Measure · 3D` | `measure-3d-distance`, `measure-3d-polyline`, `measure-3d-area` | `Distance`, `Polyline`, `Area` | Toggle the active tool; needs a displayed cloud/mesh. These are switch/toggle cases, not modal commands. Area may remain disabled until its slice ships. |
| Contextual `DEM`/`Orthophoto` ribbon tab, new group `Measure` | `measure-raster-distance`, `measure-raster-area`, `measure-raster-profile`, later `measure-raster-volume` | `Distance`, `Area`, `Profile`, `Volume` | Operates on the active ProductViewer. Profile/volume require an elevation raster/surface; disable with a reason on a plain ortho. |

Marker creation lives in `ScaleBarsModal` behind guided **Mark point 1/2 in
photos** steps. It creates and links a marker, closes the blocking modal, then
returns to the setup automatically after that point has two photo marks. Reuse
the existing image `gcpEdit` machinery, but rename its ribbon group/button and
`GcpToolbar` copy to “Points” / “Edit Points”; the toolbar's create row becomes
two explicit actions: **＋ New control** (aerial only) and **＋ New marker**. In an
object project it defaults to marker. Right-click text likewise says “Add
control/marker here…” rather than always creating a GCP.

Implementation hint: add `measure3dGroup` beside `cameraGroup`/`sceneGroup`, and
add the raster commands directly in `rasterTab`. Keep tool state in
`useMeasureTools`; App.vue only dispatches commands and passes state/handlers to
the active viewer. Ribbon commands require an `Icon.vue` id; reuse an existing
semantic icon only when it reads correctly, otherwise add small ruler/polyline/
area/profile icons there as part of the relevant slice.

## Workstreams

Ordered so each one is useful on its own. WS0–WS2 deliver "my model is in
metres"; WS3–WS4 deliver the ruler; WS5–WS6 the rest.

### WS0 — the unit resolver + the scale record (no UI)
**SHIPPED 2026-08-25.** `core/products/scale.js`, `frameFromScaledLocal`,
`effectiveFrameSpec`, `scaled-local` in the worker, the export audit (see the
deviation above). Tests: `scale.test.js`, `projection.test.js`.

Small, and everything else leans on it.
1. `core/products/scale.js` (pure, new): `fitScale(constraints)` where each
   constraint is `{ modelDistance, knownDistance, weight }` → weighted
   least-squares `s = Σ w·d_model·d_known / Σ w·d_model²`, plus per-constraint
   residual (`s·d_model − d_known`), RMS and count. Mirror `fitSimilarity`'s
   return shape and its "returns null on degenerate input" contract.
2. `reconstruction.json` gains `scaleFit: { scale, rms, count, method:
   'scalebars', sourceStamp, evidenceDigest, createdAt, constraints:
   [{ id, modelDistance, knownDistanceM, accuracyM, residualM,
   normalizedResidual }] }` — serialise/restore beside `georef`
   ([useReconstructionStore.js:252-266](../../src/stores/useReconstructionStore.js#L252-L266),
   restore at [:1325](../../src/stores/useReconstructionStore.js#L1325)).
3. `frameFromScaledLocal` + `effectiveFrameSpec` (D1/D2). Extend the worker's
   `rebuildFrame`/`frameDescriptor` with a serializable `scaled-local` kind; never
   pass scaled vectors to `makeFrame`. Audit every `unit === 'm'` / `frame.unit` consumer and every
   `crs`-assuming export path: a scale-bar project is **metric with no CRS**, a
   combination that has not existed before. Specifically check the DEM/ortho
   GeoTIFF + `.prj` writers ([exporters.js](../../src/core/products/exporters.js),
   [wkt.js](../../src/core/products/wkt.js)) — they must write metric pixel scales and
   **no** CRS rather than defaulting to one.
4. Audit **all** metric exports, not only rasters: cloud/LAS/PLY, mesh, ASCII DEM,
   GeoTIFF/world file and measurement export. A scale-only cloud/mesh export uses
   the scaled local frame but writes no CRS identifier. Never attach the project
   CRS merely because the coordinates are metric.
5. Log the fit with its inputs, per the house rule: bars used, scale, RMS.

**Tests**: `scale.test.js` — exact single constraint, weighted disagreement of
two, degenerate (zero model distance) → null, invalid/non-finite input, residual
signs; projection tests for scaled-local forward/inverse round-trip and a known
distance scaling exactly once.

### WS1 — markers (the `marker` role)
**SHIPPED 2026-08-25.** Plus `core/io/gcp.js` `isGroundControl` — one gate for
every constraint site, tested with a finite-coordinate marker (MEAS-12's pure half).

Everything in D4. Add explicit role tests at each constraint boundary (georef,
anchored BA, LOO report)—a marker with deliberately finite coordinates and
precision must still be excluded. Plus: `triangulateAllGcps` already skips nothing role-specific,
so a marker triangulates for free; surface its SfM-frame position and per-view
reprojection residual in the sidebar detail, since for a marker that residual is
the *only* quality signal there is (no surveyed coordinate to diff against).

### WS2 — scale bars
**SHIPPED 2026-08-25.** `useScaleBarsStore`, `stores/reconstruction/scaling.js`,
`ScaleBarsModal.vue`, the ribbon entry, the Quality-Report tab + HTML section +
digest fact. Tests: `scaling.test.js`.

1. `useScaleBarsStore` (D5) + OPFS save/load following the footprints/poses store
   shape.
2. Put endpoint resolution/refit in `stores/reconstruction/scaling.js`, shaped
   like `georeferencing.js`; the bars store owns evidence/persistence, while the
   reconstruction store owns the derived fit and current sparse cameras. This
   avoids teaching the evidence store about triangulation or reconstruction state.
3. `ScaleBarsModal.vue` — built from `ModalShell` + `SettingsField` per the modal
   framework: a table of bars (endpoints, entered distance ± accuracy, measured
   distance, residual, enabled), a guided two-point workflow plus an advanced
   existing-endpoint row, and a **Set project scale** action that runs `fitScale`
   and writes `scaleFit`.
4. Endpoint distance sources: marker → `triangulateGcp` position; camera →
   `cameraCenter(cam)`. Both in the SfM frame, so the model distance is the plain
   Euclidean norm.
5. Ribbon: `Tools ▸ Georeferencing ▸ Scale Bars` (same job — fixing the datum —
   and deliberately **not** `aerialOnly`). One `MODAL_COMMANDS` line in App.vue.
6. Reporting (D6): a second table in `EvalAccuracySection.vue` and a matching
   block in `buildExportReport` ([useQualityReport.js](../../src/composables/useQualityReport.js)),
   so the HTML report carries bar residuals. Add `scaleFit` to
   `core/eval/summaryDigest.js` as a recorded run fact.

### WS3 — measurement core (2D length/area/profile shipped; remaining geometry below)
`core/products/measure.js`:
- `segmentLengths(points)` / `polylineLength` → per-segment + total, plus Δz and
  horizontal (map) distance per segment. Callers first transform SfM vertices
  through `effectiveFrameSpec`; never interpret raw SfM Z as elevation.
- `polygonArea3d(points)` — project onto a **general 3D** best-fit plane (a small
  symmetric eigensolver/Jacobi is sufficient; do not reuse `fitPlane`, which is
  the height-field model `z=ax+by+c` and fails for vertical polygons), then
  shoelace in-plane; return both the **true (tilted planar)** area and
  the **planimetric footprint** area, because those differ on a slope and users
  read whichever number is shown as "the" area.
- `pointInPolygon` (ray crossing) + `polygonBounds`.
- `sampleProfile(grid, polyline, { step })` → `[{ distance, z }]` walking the
  grid via the existing bilinear/nodata convention, nodata gaps preserved as
  `null` (never interpolated across—a filled gap is an invented elevation).
  Default `step` to one raster cell and always include vertices/endpoints.
- `volumeBetween(grid, polygon, base)` → `{ cut, fill, net, cells,
  cellArea, nodataCells }` where `base` is a plane (`{a,b,c,d}`) or a second
  grid. Derive `cellArea` from the grid geotransform, define the plane as
  `a*x+b*y+c*z+d=0`, and reject incompatible second-grid frames until an explicit
  resampling step has made them compatible. Define positive
  `fill = surface-base`, positive `cut = base-surface`, and `net = fill-cut`.
  Always return the cell count and cell size alongside the volume: a volume
  is a sum over a discretisation, and it is not auditable without them.

**Tests**: unit square (area 1), a 45°-tilted square (true area vs footprint
ratio √2), a right prism of known volume, a profile across a synthetic ramp,
nodata handling, a polygon with a hole-free concave shape.

### WS4 — 3D picking + ruler/area in Viewer3D
1. Picking per D10, behind a small `composables/usePick3d.js` seam
   (`pickAt(clientX, clientY) → { point: [x,y,z], source: 'mesh'|'points' } | null`)
   so a later pick-buffer swap does not touch the tools.
2. `composables/useMeasureTools.js` — active tool (`none|distance|polyline|area`),
   vertex list, live rubber-band, commit/cancel (Escape cancels the in-progress
   measurement before it closes anything else — check the `useModalEscape`
   ordering).
3. Rendering: a `THREE.Group` of `Line`/`Points` + HTML labels positioned by
   projecting the vertices each frame. Follow the existing overlay convention —
   **coalesce redraws**, never one per `mousemove`.
4. `useMeasurementsStore` (project-scoped, persisted `measurements.json`), items
   `{ id, name, kind, nativeFrame, sourceStamp, surfaceStamp, frameStamp,
   vertices, pickMeta, createdAt }` per D8; the
   panel/modal lists them with results, rename/delete, and a stale badge.
5. Contextual 3D-view ribbon gets the tool toggles
   ([Ribbon.vue:356-378](../../src/components/layout/Ribbon.vue#L356-L378)); `View ▸
   Inspect ▸ Measurements` opens the list.
6. Every result renders through the D2 resolver: `24.13 m` vs `24.13 model units`.

### WS5 — 2D measurement on products + profile (temporary tools shipped 2026-09-27)
Temporary ruler/polyline, planimetric area, DEM profile with nodata gaps and CSV
are implemented and browser-tested. Persisted measurement records and cross-raster
height sampling remain open. Original design:

Cheaper than WS4 and higher-value for aerial work: `ProductViewer` already
converts pixel↔world and samples the value under the cursor, and already has a
context menu to hang tools on.
- Ruler / polygon over an ortho or DEM. Planimetric results use the active
  raster's recorded frame. Height-dependent results use a DEM only after checking
  that its frame stamp matches; never sample a convenient but differently framed
  DEM. Elevation may come from the computed DEM (or the imported reference DEM,
  via `sampleReferenceDem` — which also returns the
  declared σ, so a profile over reference data can state its vertical accuracy).
- **Profile**: polyline → `sampleProfile` → inline SVG chart (no chart library;
  same approach as the report's histogram), distance-along vs height, nodata as
  gaps.
- A 2D measurement and a 3D one are the same store record with a different
  `frame` (D8).

### WS6 — volume
`volumeBetween` wired to a surface chosen from the existing `orthoSurfaces`
getter (mesh / DEM / fitted plane) — that getter is already the single source of
"what surfaces exist", and reusing it keeps DemModal/OrthoModal/this in agreement.
Base-plane options: best-fit through the polygon vertices, lowest vertex
(horizontal), custom Z, or a second surface (DEM-of-difference — the natural
join with imported reference DEMs, so **gate it behind RR/EX landing**).
Report cut / fill / net with cell size + cell count + nodata-cell count.
For v1 ship best-fit boundary plane, lowest-boundary horizontal plane and custom
Z. Defer second-grid DEM-of-difference until RR/EX provides an explicit
same-CRS/resampling path. “Best-fit boundary” means the polygon vertices are
expected to lie on exposed base ground; state that assumption in the modal.

### WS7 — docs, export, glossary
- Export measurements as CSV and GeoJSON (georeferenced projects only for the
  latter; reuse [geojson.js](../../src/core/io/geojson.js)).
- Glossary entries under `src/glossary/georeferencing/` (`scale-bar`,
  `gauge-freedom`) and `src/glossary/products/` (`volume-cut-fill`,
  `elevation-profile`); wrap the modal labels in `<GlossaryTerm>`.
- METHODS.md: a short section on the scale gauge and why the fit is post-hoc
  (D3) — this is a *method* statement, so it belongs there, not in CLAUDE.md.
- CLAUDE.md: the evergreen invariants only — D1 (scale lives in the frame), D2
  (one resolver), D8 (the stamp), D9 (never a bare number).
- HANDOVER.md done-log line + `VERIFICATION.csv` rows.

## Verification

`npm test` + `npm run typecheck` cover WS0/WS3 (both land under the
`src/core/**` glob). Everything else is browser-runtime and owes
`VERIFICATION.csv` rows — draft:

| id | area | check | pass criteria |
| --- | --- | --- | --- |
| `MEAS-01` | Scale | Follow the guided setup for 2 points marked in ≥2 images, enter one known distance, Set project scale | the modal returns after each point's second mark; model reports metres; DEM/ortho log says `m/px`, not `model units/px` |
| `MEAS-02` | Scale | Two bars entered with a deliberate 2 % disagreement | both residuals reported; fit RMS reflects the split; neither bar silently dropped |
| `MEAS-03` | Scale | Aerial project with GCPs **and** a bar | georeference wins the scale; the bar reports a residual as a check |
| `MEAS-04` | Scale | Export a DEM GeoTIFF from a scale-bar-only project | metric pixel scale, **no** CRS/.prj invented |
| `MEAS-05` | Measure | Ruler on a 20–30 M-point dense cloud | pick latency measured and recorded (drives D10) |
| `MEAS-06` | Measure | Re-run sparse SfM with measurements saved | measurements flagged stale, numbers greyed, nothing wrong displayed |
| `MEAS-07` | Measure | Area on a tilted roof plane | true vs planimetric area both shown and plausibly √-related |
| `MEAS-08` | Measure | Volume of a stockpile against a best-fit base plane | cut/fill/net + cell size + cell count reported; halving the GSD moves the volume < a stated tolerance |
| `MEAS-09` | Measure | Profile across a DEM with a nodata hole | gap rendered as a break, not interpolated |
| `MEAS-10` | Scale lifecycle | Apply a bar, edit a marker observation, reopen project | old fit is rejected as stale; metres return only after Apply |
| `MEAS-11` | Product lifecycle | Build metric DEM, change scale, reopen DEM | old DEM says outdated frame and retains its recorded coordinates; rebuild uses new scale |
| `MEAS-12` | Marker safety | Give a marker finite coordinates/accuracy through a test fixture | it never enters georef, anchored BA or LOO controls |
| `MEAS-13` | UI | Object project with sparse model | Scale Bars and marker editor are enabled; imported-GCP/georeference commands remain aerial-only |

Record the *measured* number, not "ok". `MEAS-05` and `MEAS-08`'s convergence
number belong in HANDOVER §Baselines.

## Resolved product decisions

1. Markers share the existing GCP storage/sidebar, renamed **Control & Markers**;
   do not build a parallel marker-observation subsystem.
2. V1 bars use reproducible marker or camera endpoints. Arbitrary cloud picks are
   deferred until 3D picking exists and can record source/snap precision.
3. V1 volume uses boundary-fit plane, lowest-boundary horizontal plane or custom
   Z. DEM-of-difference is deferred behind explicit frame-compatible resampling.
4. Post-hoc scale is the permanent default. Do not touch Rust BA until a measured
   dataset demonstrates unacceptable bar-dependent deformation.

## Executor handoff / traps to check before claiming completion

- Read CLAUDE.md and follow the project-store registry; add OPFS helpers for
  `scalebars.json` and `measurements.json`, including delete/purge paths.
- Search for every binary `role === 'check' ? ... : ...`, every
  `role !== 'check'` constraint gate, and every “GCP” label. Do not change the
  imported-GCP concept where it genuinely means surveyed ground control.
- Search every frame descriptor reconstruction site. A descriptor crosses the
  worker boundary as plain data; closures and Vue proxies cannot cross it.
- Make `effectiveFrameSpec` the only selection point. Product builders,
  measurement display, reports and exports must not independently choose scale.
- Keep persisted evidence (`scalebars.json`) separate from derived state
  (`reconstruction.json.scaleFit`). Test restore with missing/legacy fields.
- Unit-test pure math first. Then run `npm test`, `npm run typecheck`, and an SFC
  binding check for App.vue after adding modal refs/commands (per CLAUDE.md).
- Viewer work still owes manual browser verification. Never report ray-picking,
  Escape ordering, overlay placement, persistence or ribbon enablement as verified
  from tests/typecheck alone.
