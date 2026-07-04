# HANDOVER — websfm improvement plan

Audience: implementing agent (Opus). Read `CLAUDE.md` first (layering rules,
conventions, gotchas) and skim `TODO.md` (roadmap history; this file supersedes
its "Active plan"). The previous HANDOVER (dense quality/memory overhaul) is
**done** except the OPFS spill step, which is carried forward here as P3.

This plan is ordered by expected impact on the user's actual workflow:
reconstructing scanned Antarctic aerial film (CA213732V… test set, 5-image
strip, 10137×9600 scans). Each item is independently shippable. Do them in
order within a track; tracks A → F are the priority, P/I as capacity allows.

**How the docs divide up** (so this file stays useful):
- `CLAUDE.md` — evergreen architecture, layering, invariants, "where things
  live." High-level and stable; not a task tracker.
- `HANDOVER.md` (this file) — the single **living plan**: remaining work,
  priority-ordered, plus a short **Done log** below. When an item ships, move it
  from the plan into the Done log (one line: date · what · where it lives). No
  separate "done" file needed — the Done log + git history are the record.
- `TODO.md` — long-term roadmap archive + parked/rejected ideas.

---

## Done log (most recent first)

- **2026-07-04 · P2 parallel + preselected matching** — matching was serial O(N²).
  (1) **Concurrency-safe match store**: `useMatchesStore` now `shallowRef` + in-place
  mutate + `triggerRef` (was `matchStore.value = new Map(...)` on every write, which
  races under concurrency — a snapshot clobbers a concurrent set). `descCache` caches
  the in-flight *promise* so shared images load once. (2) **Parallel `matchAll`**: a
  concurrency-limited pool of `POOL_SIZE` drain loops over a shared cursor; POOL_SIZE
  raised `min(2,…)` → `min(8, hc−1)`. Cancellation is cooperative (stop pulling).
  (3) **Preselection**: new `preselect` strategy + pure `core/preselect.js`
  (`preselectPairs` — k-nearest by camera position); `matchAll` prunes the exhaustive
  set using imported-pose positions (`positionsByUuid`), keeps pairs with an
  unpositioned endpoint, logs `N/M kept, K skipped`. Modal exposes it + a
  "neighbours per image" knob. Tests: `preselect.test.js`. **Owed:** GPS-from-EXIF
  fallback when no poses imported; a thumbnail-overlap preselector for the
  no-pose case; and a real multi-image timing check (can't run browser here).
- **2026-07-04 · A3 retriangulation + track merging** — post-BA structure recovery
  in `core/sfm.js`, factored into two pure exported functions: `retriangulatePairs`
  (matches with *both* keypoints unassigned → triangulate with the improved poses,
  keep if in front of both cams + reprojects ≤ `filterMaxReprojPx`; injected
  `triangulate` = WASM DLT) and `mergeSplitTracks` (a match whose endpoints belong
  to two *different* points = the same feature split → fold together when the union
  is consistent and reprojects ≤ gate). Wired into `reconstruct` right after the
  first global BA, then one more BA; logs the 2/3/4+ track-histogram delta. Unit-
  tested directly (`sfm.test.js`: add + gate-reject + merge + conflict-skip). Note:
  registration already triangulates most neither-assigned matches under clean data,
  so A3's real yield is on **noisy/real** sets (cheirality misses under the noisy
  seed, plus init-pair matches never revisited) — validate on the CA…V run.
- **2026-07-04 · F1 export dialogs + GeoTIFF** — each export now goes through a
  reusable `ExportModal.vue` (`kind` = cloud|model|dem|ortho) with a format select
  + a few settings (some disabled placeholders for later: LAS, COLMAP, hillshade,
  JPEG, compression, downsample). New dependency-free **GeoTIFF** writer
  `core/geotiff.js` (`writeGeoTiff` + `geoKeysForEpsg`; LE, uncompressed, single
  strip, ModelPixelScale/Tiepoint + GeoKeyDirectory, GDAL_NODATA); exporters gained
  `demToGeoTiff` (float32, NaN→nodata) + `orthoToGeoTiff` (RGBA + alpha extra-
  sample), and `cloudToPly` now takes `{ binary, color }`. `App.vue` opens the modal
  per command and `onExportRun` dispatches by format; CRS→EPSG code parsed from the
  working CRS for the GeoKeys / `.prj`. Formats: cloud PLY binary/ascii, model JSON
  (±tracks), DEM GeoTIFF or `.asc`, ortho GeoTIFF or PNG+`.wld`. Tests:
  `geotiff.test.js` (parse-back) + `exporters.test.js`; build green.
- **2026-07-04 · F1 exports (the tool finally has an exit)** — pure
  `core/exporters.js`: `cloudToPly` (binary LE, sparse+dense), `reconstructionToJson`
  (SfM cameras+centres+tracks), `demToAsciiGrid` (ESRI .asc, NaN→NODATA),
  `rasterWorldFile` (.wld). UI-layer `utils/download.js` (`downloadBlob`,
  `dataUrlToBlob`) does the Blob/anchor download. Ribbon's pre-scaffolded
  export-cloud/dem/ortho are now enabled (+ new "Model JSON"; `orthoReady` gate
  added); handlers in `App.vue`.
- **2026-07-04 · A4 radial/tangential distortion (undistort-at-ingest)** — new pure
  `core/distortion.js` (Brown–Conrady forward + iterative inverse, k1,k2,k3,p1,p2;
  round-trip < 0.05px tested). Sparse: `sfm.js` undistorts keypoints once after the
  K map is built, so init/PnP/triangulation/BA stay pinhole (the init-pair `F` is
  still the distorted-space fit — BA corrects it). Dense/ortho: `compute.worker.js`
  `undistortRaster` remaps each working-res source raster (forward map + bilinear)
  and `undistortMaskLut` moves masks to match, in `getRaster`; DEM + ortho inherit
  it for free (ortho reuses the dense maps' undistorted RGB). Coeffs flow via the
  store (`sensor.k1..p2` to reconstruct, per-image `dist` to dense). **The sensor
  table already had k1..p2 columns + persistence** — only the compute path was
  missing. Tests: `distortion.test.js` + an sfm end-to-end test (corrected < 1px,
  uncorrected > 2× worse). No WASM change. Next distortion step (optional): let A2
  refine k1 (`refineIntrinsics: 'f,k1'`) now that the plumbing exists.
- **2026-07-03 · A2 intrinsics self-calibration** — `crates/reconstruction/src/
  bundle.rs` generalised: points are still Schur-eliminated, but the reduced
  system now carries optional **shared per-sensor intrinsic** blocks (focal scale
  `s`, and `dcx,dcy` for `f,cxcy`) with analytic Jacobians. New wasm-bindgen args
  `sensor_of_cam` + `refine_mode`; output now includes refined per-camera K.
  Wired through `core/reconstruction.js` `bundleAdjust`, `sfm.js` (sensor→group
  map, refined K applied back to cameras, before→after focal + implied-film-width
  log with the weak-observability caveat), `useReconstructionStore` (passes
  `sensorId`), and the reconstruct modal (`refineIntrinsics: none|f|f,cxcy`,
  default off). Tests: `bundle_adjust_refines_shared_focal` (Rust, recovers a
  1.1× focal <1%), a JS boundary test in `reconstruction.test.js`, and an
  off-path no-op test. WASM rebuilt. **Mode-0 behaviour is byte-unchanged (the
  existing pose-only tests still pass).**
- **2026-07-03 · A1 LM bundle adjustment** — found already implemented
  (`crates/reconstruction/src/bundle.rs`: LM + Schur complement + analytic
  Jacobians + adaptive Huber; wired via `core/reconstruction.js` `bundleAdjust`).
  The A-section text below had described the *superseded* finite-difference
  solver. Remaining loose ends closed: added a noisy-convergence Rust test
  (`bundle_adjust_converges_under_noise`, asserts monotone accepted-step trace +
  noise-floor convergence) and a BA-enabled end-to-end JS test in `sfm.test.js`
  (the old integration test only ran `baIterations: 0`). **A2 self-calibration
  is the real next accuracy step.**
- **2026-07-03 · Q1–Q5 quick wins** — Q1 fusion auto-maxCost clamp→0.45 +
  weak-signal warn (`core/mvs.js`); Q2 converged-BA logs `debug` not `warn`
  (`core/sfm.js`); Q3 persisted run summaries, sparse + dense, in
  `reconstruction.json` (`sfm.js`/`mvs.js`/`useReconstructionStore.js`); Q4
  implied-film-width sanity log + off-standard warn (`core/reconstruction.js`
  `resolveK` + `sfm.js` K log); Q5 dense window default 2→3 (7×7). Tests added
  in `mvs.test.js` / `reconstruction.test.js`.

---

## 0. Baseline — what the logs say today (keep for before/after)

From the 2026-07-03 00:12 run (5 images, Medium dense preset, GPU backend).
These are the numbers every accuracy item below must move:

**Sparse** (healthy-looking but self-flattering):
- 3,066 points; track lengths **2712 ×2-view / 352 ×3-view / 2 ×4+-view**
  (88% 2-view — weakly constrained; this is the honest quality metric).
- Final reprojection median 0.50px — but measured *after* a 4px track filter,
  so it's bounded by construction. Pre-BA p95 was 12.5px.
- Init-candidate anomalies (fingerprints of an intrinsics error):
  - 0033↔0034: median parallax **0.48°**, 65% cheirality — degenerate two-view
    geometry for adjacent frames in a strip (others are 9.8–17.7°).
  - 0032↔0033: init reproj median **17.8px** vs 0.72px for 0035↔0036.
  - PnP inlier ratios collapse toward the strip's left end (41/71, 75/183).

**Dense** (the user-visible pain: freckled depth maps, huge z-spread):
- Cost = 1 − ZNCC ∈ [0,2]. Per-image **cost median 0.63–0.70 ⇒ median ZNCC
  0.30–0.37** — the photoconsistency signal is barely above random. This is
  the root symptom; freckle and z-spread follow from it.
- Fusion auto maxCost = p70 = **0.71** (self-referential: a bad cost
  distribution sets a bad threshold). Kept **6.6%**; culled 31.4% no-depth,
  21.3% cost, **40.7% <2-views** (chance depths failing cross-view checks).
- DEM: 235k measured vs 200k IDW-filled cells (~46% interpolated).

**Intrinsics suspicion (likely upstream cause of much of the above):**
K comes from the sensor table as fx = 154mm ÷ 0.025mm/px = 6160. But
10137px × 0.025mm = **253mm — wider than standard 230mm aerial film**. If the
scan spans the full frame, the true pitch is ~0.0227mm and fx ≈ 6716 (~9%
higher). A ~9% focal error explains the init anomalies, the cross-view depth
disagreement (40.7% <2-views cull), and dome/tilt z-spread. **The user is
verifying the scan pitch / fiducials on their side** — items Q4/A2/F4 give
the code-side support. Do not hard-code a "correct" focal.

---

## A. Accuracy track (the core work — sparse geometry quality)

### A1 — Proper Levenberg–Marquardt bundle adjustment (Rust) — ✅ DONE (2026-07-03)
Already implemented before this handover was written; the text here originally
described the *superseded* finite-difference solver. The current solver is
`crates/reconstruction/src/bundle.rs`: LM with the Schur complement (points
eliminated against cameras, dense reduced-camera Cholesky), **analytic
Jacobians** (cameras as left-perturbed so(3) + t, points xyz), adaptive Huber
robustification, and damping retries that never accept a worsening step. Crate
stays dependency-free (hand-rolled linalg in `linalg.rs`). Same wasm-bindgen
signature (`bundle_adjust` → `core/reconstruction.js` `bundleAdjust`), returns
`costTrace`. Tests: `bundle_adjust_reduces_reprojection` +
`bundle_adjust_converges_under_noise` (Rust), plus a BA-enabled end-to-end test
in `sfm.test.js` (the old integration test only ran `baIterations: 0`). The WASM
was already rebuilt (`src/wasm/reconstruction/*` in the working tree).

### A2 — Optional intrinsics refinement in BA (self-calibration) — ✅ DONE (2026-07-03, see Done log)
Shipped: `refineIntrinsics: 'none' | 'f' | 'f,cxcy'` in the reconstruct modal
(default off), shared per-sensor focal (+cx,cy) refined inside the LM problem,
before→after focal + implied-film-width logging with the weak-strip caveat.
**Runtime validation still owed on the CA…V set**: does refined-f pull toward
~6700 and reduce the dome/tilt z-spread? That evidence decides whether A4
(radial) and F4 (fiducials) are still needed — the next accuracy step is now
**A3 (retriangulation/track-merging)**, which is pure JS.

### A3 — Retriangulation + track merging after BA — ✅ DONE (2026-07-04, see Done log)
Shipped as pure `retriangulatePairs` + `mergeSplitTracks` in `sfm.js`, run after the
first global BA + one more BA; logs the 2/3/4+ histogram delta. **Runtime yield
still owed on CA…V**: on clean synthetic data registration already triangulates
most neither-assigned matches, so the ×3-view lift shows up on noisy/real sets —
confirm the baseline (325 ×3-view / 0 ×4+) actually rises there. Possible follow-up
if it under-delivers: also fold the *one-endpoint-assigned* (extension) case here,
and re-triangulate merged points from all views rather than reusing the winner's xyz.

### A4 — Radial/tangential distortion — ✅ DONE (2026-07-04, see Done log)
Undistort-at-ingest shipped (Brown–Conrady k1..p2, `core/distortion.js`). Sparse
keypoints + dense/ortho rasters are undistorted once; everything downstream stays
pinhole. **Runtime validation owed on real distorted imagery** (drone/phone set):
does it remove the dome and lift the dense photoconsistency? Optional follow-up:
A2 `refineIntrinsics: 'f,k1'` to *solve* for k1 instead of hand-entering it.

### A5 — Per-depth-map geometric consistency filter (dense)
The original MVS design listed a forward-backward reprojection check that was
never built; fusion is currently the only cross-view test, and it runs too
late to stop freckle. After Stage A completes all maps (in the worker, where
all maps are in the raster/store cache), add an optional filter pass: for
each reference pixel, reproject into each source's *depth map*; keep the
pixel only if ≥1 source agrees within the fusion tolerance (reuse
`fuseDepthMaps`' agreement math — extract a shared helper in `core/mvs.js`).
Run before the speckle filter; log the drop count per image. Toggle in the
modal (default on). Expect: fewer no-depth-but-wrong pixels reaching fusion,
`<2-views` cull shrinking, cleaner per-image depth displays.

---

## P. Performance / robustness track

### P1 — Make GPU the dense default (WebGPU Phase 3)
`compute.worker.js` swaps in `computeDepthMapGPU` when `settings.useGpu` &&
adapter. Flip the modal default to on-when-adapter-exists (label "Use GPU
(recommended)"), keep the per-image WASM fallback and the A/B validation on
the first image. Keep opt-out. Needs a browser check (Safari + Chrome) —
flag for the user if this environment can't run one.

### P2 — Parallel + preselected matching — ✅ DONE (2026-07-04, see Done log)
Shipped: concurrency-safe match store (shallowRef + triggerRef), parallel
`matchAll` (POOL_SIZE drains), and pose-proximity preselection (`core/preselect.js`
+ modal strategy). Note: `useImagesStore.sync()` was *not* a hazard here — matching
writes matches, not the image doc. **Remaining:** GPS-from-EXIF positions when no
poses are imported; a thumbnail-overlap preselector for the no-pose/no-GPS case
(the universal fallback); real multi-image (50–500) timing validation.

### P3 — OPFS quantize + spill of depth maps (carried from previous handover)
Deferred because it needs browser runtime validation. Full design intent:
quantize Stage-A output (depth → Uint16 + per-map min/max, cost → Uint8),
write per image to OPFS (`depthmaps/<uuid>.bin` + JSON meta, following the
`opfs.js` section-docstring pattern) as each completes; densify/ortho read +
dequantize **in the worker** (core stays pure — OPFS I/O in
`compute.worker.js`); store cache holds metadata instead of float planes;
raster cache goes gray-only (+rgb for ref); GPU state packs f16 via
`pack2x16float` with chunked readback. Bonus: depth maps survive reload —
update the "not persisted" comments in `useReconstructionStore` (~lines
42–48). Gotchas recorded previously: transfer lists detach buffers shared
with ortho; `layout:'auto'` bind groups + the 64-byte Params uniform in
`depthMapGpu.js` must move together. Validate in Safari before calling done.

### P4 — GPU matcher (large; only after P2)
Descriptor-distance matrix in a compute shader (`src/workers/gpu/`,
`device.js` singleton already exists). The real path to Metashape-class
matching throughput. Design in its own right when picked up.

---

## F. Feature track (new capabilities)

### F1 — Exports — ✅ DONE (2026-07-04, see Done log)
Shipped: export dialogs (`ExportModal.vue`) + formats — cloud PLY (binary/ascii),
model JSON, DEM GeoTIFF/`.asc`, ortho GeoTIFF/PNG+`.wld`, all georeferenced.
**Polish left:** GeoTIFF compression (writer is uncompressed) + tiling for very
large rasters; proper **WKT** in `.prj` (currently raw proj4/EPSG); the disabled
modal placeholders (LAS, COLMAP, hillshade, JPEG, downsample). Needs a real-file
sanity check in QGIS/ArcGIS (can't run the browser here).

### F2 — GCP-driven georeferencing
`core/georef.js` `fitSimilarity` (Horn) currently fits SfM camera centres ↔
imported poses. Add the GCP path: user marks GCP image observations (GCP
store + image viewer marking exist), triangulate marked GCPs in the SfM
frame from ≥2 registered views, then `fitSimilarity(sfmGcpPositions,
projectCrsGcpPositions)` and report per-GCP residuals in a table (the
accuracy report users actually trust). Later: GCP observations as weighted
constraints inside A1's BA. Serves the Antarctica use case directly
(memory: `gcp-crs-architecture`, `works-in-antarctica`).

### F3 — 2.5D mesh from the DEM
Skip full 3D meshing (Poisson in WASM is a project of its own). For aerial:
regular-grid triangulation of the DEM (two triangles per cell, skip holes),
draped with the orthophoto as texture → `THREE.Mesh` in Viewer3D, plus PLY
export via F1. Cheap, and it makes the products feel real.

### F4 — Fiducial-mark interior orientation (film scans)
The proper fix for "scan geometry ≠ camera geometry" on historical film
(TODO backlog, deferred). Per sensor: user clicks 4/8 fiducial marks in one
or more images, app fits the affine scan→frame transform, principal point
and pitch derive from the calibrated fiducial coordinates instead of scan
centre + guessed pitch. Applies to keypoints + rasterisation like A4's
undistort. Decide after Q4/A2 evidence: if refined-f alone fixes the CA…V
set, keep deferring.

---

## I. Infrastructure / hygiene

- **I1 — Commit the tree.** Everything is uncommitted on `main` (dense MVS,
  WebGPU backend, sensors work, products). Split into logical commits (wasm
  artifacts with their source change). Do this FIRST, before any new work —
  the current state is unrecoverable if the tree is lost.
- **I2 — Persistence schema (old Phase 4).** `schemaVersion` in project
  files + migration on load; formalise the gcps `normalize()` backfill;
  `ProjectStore` interface over `opfs.js` so storage is mockable; round-trip
  + migration tests; TS types for on-disk shapes.
- **I3 — Bundle code-split.** Lazy-load Three.js/OpenLayers viewers + wasm
  (~1.3MB main bundle today).
- **I4 — TS migration** of `core/` module-by-module (`pose`/`sensor`/`gcp`
  first — pure parsers).
- **I5 — Test debt**: BA coverage (see A1), more CRS cases (UTM south,
  antimeridian), matching unit tests.

---

## Invariants (do not break)

- `src/core/*.js` stays pure: no Vue/Pinia/OPFS/DOM; side effects only via
  injected `onLog`/`onProgress`. OPFS I/O lives in the worker or stores.
- The three PatchMatch kernels (`patchmatch.wgsl`, `core/planeCost.js`,
  `crates/reconstruction/src/mvs.rs`) implement the same math; the
  first-image GPU↔CPU A/B check must stay RMS < 5e-3. Change all three (and
  the `aggRef` closure in `core/mvs.js`) in lockstep or not at all.
- Marshal reactive state to plain arrays before `postMessage` (Vue proxies
  don't structured-clone); worker results transfer ArrayBuffers.
- R row-major `[[…]×3]`, `t=[x,y,z]`, `C = −Rᵀt`, P = flat 12-elem `[R|t]`.
- After any `crates/` change: `npm run build:wasm`, commit `src/wasm/*`.
- Keep the heavy logging style — every derived/auto value gets a log line the
  user can audit.

## Verification playbook

Per change: `npm test` + `npm run typecheck` (both green today). WASM changes:
rebuild + rerun. Browser-runtime items (P1, P3, anything WGSL) need a manual
run this environment may not support — say so explicitly rather than claiming
verification.

End-to-end acceptance on the CA213732V set (compare to §0 baseline):
- Sparse: ×3-view+ track share up from 12%; pre-BA p95 down from 12.5px; the
  0033↔0034 parallax anomaly (0.48°) and 0032↔0033 init reproj (17.8px)
  should normalise once intrinsics are right; Q3's summary line makes runs
  comparable.
- Dense: per-image cost median down from 0.63–0.70 toward ≤0.45; fusion kept
  fraction up from 6.6% *with the tighter Q1 threshold*; `<2 views` cull down
  from 40.7%; DEM measured ≫ filled (baseline 235k vs 200k).
