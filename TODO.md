# websfm — TODO (the plan)

The single prioritized plan. Roles: `CLAUDE.md` = architecture/conventions,
`HANDOVER.md` = record (baselines + done log), this file = **all open work**.
When an item ships: delete it here, add one done-log line to HANDOVER.md.

Ordered by expected impact on the two real workflows: scanned Antarctic aerial
film (CA213732V… strip) and close-range sets (Metashape building example).
Baselines to beat are in `HANDOVER.md` §Baselines.

---

## Now — R track: registration robustness (sparse)

Root cause of the bad building-set run (HANDOVER baseline B1): the sparse model
is poisoned *during* incremental registration; dense symptoms (speckle, 5%
fusion keep) are downstream. Do in order.

### R1 — Honest PnP acceptance
`sfm.js` accepts any pose with ≥6 absolute inliers (`inlierCount < 6`, ~line
674). Require `inliers ≥ max(minPnpInliers, minPnpInlierRatio · correspondences)`
(defaults ~15 / 0.15, settings-exposed). A pose supported by 4% of its
correspondences (IMG_4315: 6/137) is a coincidence fit; deferring is cheap
because the sweep loop retries every pass.

### R2 — Kill the adaptive-gate doom loop
The per-pass PnP gate `min(reprjThreshold·maxGateScale, max(reprjThreshold, p95))`
escalates exactly when the model is worst (pass 2 ran at 32px on B1). Replace
with a fixed gate (reprjThreshold, at most a 2× cap) + rely on R3: images that
can't clear a tight gate should wait for BA to improve the model, not have the
gate loosened for them. Never-registered images stay out and are reported (that
report already exists).

### R3 — Interleaved bundle adjustment (the big one)
All 50 cameras register in one 164ms sweep with zero intermediate BA; the single
global BA then can't recover (B1: pre-BA p95 282px, post-retriangulation BA
rejected). COLMAP-style: after every K new registrations (K≈5, or ~25% model
growth), run global BA + a track-filter pass, then continue the sweep against
the tightened model. Reuse `runBundleAdjust` + `filterTracks` as-is; fewer iters
(10–15) per interim solve. Expect: pre-BA p95 < 20px, deferred images
registering at the *tight* gate in later passes, final BA starting near the
optimum.

### R4 — Track extension beyond PnP inliers
Only PnP-inlier correspondences extend tracks; outlier correspondences are
dropped and pair-matches touching an existing track are skipped for
triangulation — the observation is simply lost, so tracks stay 2-view (9.5%
≥3-view on B1). After a pose is accepted (and again after each interim BA), fold
in one-endpoint-assigned matches whose reprojection against the existing point
is ≤ gate. Direct lever on the ≥3-view share and on BA conditioning.

### R5 — Matching: absolute-inlier override on the ratio gate
`useMatchesStore` rejects any pair with inlier ratio < 0.25 regardless of count.
Accept when `inlierCount ≥ overrideInliers` (~30) even at low ratio —
120-putative/27-inlier bridge pairs are real geometry on repetitive facades, and
they're the glue that closes loops + makes ≥3-view tracks. Keep the ratio gate
for the 15–25-putative junk it was built for.

### R6 — Distortion: refine k1 in BA (`refineIntrinsics: 'f,k1'`)
Undistort-at-ingest plumbing exists (`core/distortion.js`) but nothing *solves*
for k1, and the building set shows classic radial residuals (init reproj grows
with parallax: 0.64px @ 6° vs 16.6px @ 16.5°). Add a shared per-sensor k1 to the
BA intrinsic block (`bundle.rs`, analytic Jacobian like the focal scale), report
it like the focal log; the user copies it into the sensor table. Also restrict
`f,cxcy`/`f,k1` refinement to the *post-filter* BAs — refining intrinsics
against the pre-filter mess is how cy drifted 180px on B1.

**Acceptance (vs baseline B1):** all 50 cameras registered at the tight gate;
pre-BA p95 < 20px; ≥3-view track share > 30% (from 9.5%); no BA-rejected passes;
self-calib cx/cy stable within ~10px. Then re-run dense: per-image cost median
≤ 0.45, fusion kept fraction > 20% (from 5%).

**Instrumentation to add alongside:** per-camera median-residual table after the
final BA, flagging cameras > 2× the global median (would have exposed the
pass-2 cameras immediately, where the global median hides them).

---

## Next

### A5 — Per-depth-map geometric consistency filter (dense)
Fusion is currently the only cross-view test and runs too late to stop freckle.
After Stage A completes all maps (in the worker, where all maps are in the
raster/store cache), add an optional filter pass: for each reference pixel,
reproject into each source's *depth map*; keep the pixel only if ≥1 source
agrees within the fusion tolerance (reuse `fuseDepthMaps`' agreement math —
extract a shared helper in `core/mvs.js`). Run before the speckle filter; log
the drop count per image. Toggle in the modal (default on). Expect: fewer
wrong-depth pixels reaching fusion, `<2 views` cull shrinking, cleaner per-image
depth displays. Related: investigate the `depth 0.00` minima in Stage A output
(degenerate plane init should be clamped/rejected, not exported).

### P1 — Make GPU the dense default (WebGPU Phase 3)
Flip the modal default to on-when-adapter-exists (label "Use GPU
(recommended)"), keep the per-image WASM fallback + first-image A/B validation,
keep opt-out. Needs a browser check (Safari + Chrome).

### Owed runtime validations (shipped code, unproven on real data)
- **A2 self-calibration** on the CA…V film set: does refined-f pull toward
  ~6700 and reduce the dome/tilt z-spread? Evidence decides whether F4
  (fiducials) is still needed.
- **A3 retriangulation** on CA…V: does the ×3-view share actually rise on noisy
  real data (clean synthetics already triangulate most matches)? If it
  under-delivers: also fold the one-endpoint-assigned case (see R4) and
  re-triangulate merged points from all views.
- **A4 undistort** on genuinely distorted imagery (drone/phone): does it remove
  the dome and lift dense photoconsistency?
- **P2 matching throughput** on a real 50–500-image set (SIMD + pool + preselect
  landed without browser timing).
- **Products** runtime test on the real aerial set; exported GeoTIFFs sanity-
  checked in QGIS/ArcGIS.

### P2 remnants — preselection fallbacks
- GPS-from-EXIF positions when no poses are imported.
- Thumbnail-overlap preselector for the no-pose/no-GPS case (the universal
  fallback).

### P3 — OPFS quantize + spill of depth maps
Quantize Stage-A output (depth → Uint16 + per-map min/max, cost → Uint8), write
per image to OPFS (`depthmaps/<uuid>.bin` + JSON meta, following the `opfs.js`
section-docstring pattern) as each completes; densify/ortho read + dequantize
**in the worker** (core stays pure — OPFS I/O in `compute.worker.js`); store
cache holds metadata instead of float planes; raster cache goes gray-only (+rgb
for ref); GPU state packs f16 via `pack2x16float` with chunked readback. Bonus:
depth maps survive reload — update the "not persisted" comments in
`useReconstructionStore` (~lines 42–48). Gotchas: transfer lists detach buffers
shared with ortho; `layout:'auto'` bind groups + the 64-byte Params uniform in
`depthMapGpu.js` must move together. Validate in Safari before calling done.

---

## Later — features

### F2 — GCP-driven georeferencing (Antarctica use case)
`core/georef.js` `fitSimilarity` (Horn) currently fits SfM camera centres ↔
imported poses. Add the GCP path: user marks GCP image observations (GCP store +
image-viewer marking exist), triangulate marked GCPs in the SfM frame from ≥2
registered views, then `fitSimilarity(sfmGcpPositions, projectCrsGcpPositions)`
and report per-GCP residuals in a table (the accuracy report users actually
trust). Later: GCP observations as weighted constraints inside BA. See memories
`gcp-crs-architecture`, `works-in-antarctica`.

### F3 — 2.5D mesh from the DEM
Skip full 3D meshing (Poisson in WASM is a project of its own). For aerial:
regular-grid triangulation of the DEM (two triangles per cell, skip holes),
draped with the orthophoto as texture → `THREE.Mesh` in Viewer3D, plus PLY
export via the export modal. Cheap, and it makes the products feel real.

### F4 — Fiducial-mark interior orientation (film scans)
The proper fix for "scan geometry ≠ camera geometry" on historical film. Per
sensor: user clicks 4/8 fiducial marks, app fits the affine scan→frame
transform; principal point + pitch derive from calibrated fiducial coordinates
instead of scan centre + guessed pitch. Applies to keypoints + rasterisation
like the undistort path. **Decision gate:** only if A2's refined-f evidence on
CA…V doesn't fix the film set on its own.

### F1 polish — exports
GeoTIFF compression (writer is uncompressed) + tiling for very large rasters;
proper WKT in `.prj` (currently raw proj4/EPSG); the disabled modal placeholders
(LAS, COLMAP, hillshade, JPEG, downsample).

### Products follow-ups
Real-world map-viewer overlay for the ortho; ortho GPU/WASM kernel if per-cell
JS proves slow on large grids; optional manual "Flip Z" for object scenes.

---

## Backlog

**Compute & workers**
- **P4 — GPU matcher (WebGPU).** Descriptor-distance matrix in a compute shader
  (`src/workers/gpu/`, `device.js` singleton exists). The real path to
  Metashape-class matching throughput (100×+); largest effort; design when
  picked up. Pairs with a GPU SIFT detector later.
- **Stream partial reconstruction snapshots** from the worker so the 3D viewer
  builds up live (the `emit` channel exists; post periodic camera/point
  snapshots between stages).
- **Surface worker errors in the UI** — currently a per-request reject logs; an
  `onerror` fail-all path exists but isn't user-visible.

**Dense tuning**
- Depth-map modal defaults for large film scans: `maxDim` is conservative for
  ~10k-px scans (perf-gated, cost scales with pixels²); retune fusion `maxCost`
  once intrinsics are right (correct focal should drop PatchMatch costs and
  raise the fused count without loosening gates).

**Infrastructure / hygiene**
- **I2 — Persistence schema.** `schemaVersion` in project files + migration on
  load; formalise the gcps `normalize()` backfill; `ProjectStore` interface over
  `opfs.js` so storage is mockable; round-trip + migration tests; TS types for
  on-disk shapes.
- **I3 — Bundle code-split.** Lazy-load Three.js/OpenLayers viewers + wasm
  (~1.3MB main bundle).
- **I4 — TS migration** of `core/` module-by-module (`pose`/`sensor`/`gcp`
  first — pure parsers), wiring in `types.ts`.
- **I5 — Test debt**: more CRS cases (UTM south, antimeridian), matching unit
  tests.
- Delete `utils/detection.js` (unused, superseded by the worker).

---

## Parked / rejected
- **Global undo/redo command layer** — rejected. Metashape has none; per-entity
  delete/edit (already in the stores) is enough.
- **Full 3D meshing (Poisson)** — parked in favour of F3's 2.5D DEM mesh.
