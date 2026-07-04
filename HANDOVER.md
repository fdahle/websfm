# HANDOVER — the record: baselines + done log

Roles: `CLAUDE.md` = architecture/conventions, `TODO.md` = the plan (all open
work), this file = the **record** — measured baselines that future runs are
compared against, and a reverse-chronological done log. When an item ships,
move it from TODO.md to one done-log line here (date · what · where it lives).
Git history holds the detail.

---

## Baselines (before/after yardsticks)

### B1 — Metashape building set (2026-07-04 15:09 run, 50 images)
Intrinsics are *right* here (seed E σ2/σ1 = 1.00) — the failure is registration
contaminating the model. The R track in TODO.md exists to move these numbers:

- Pre-BA reprojection **mean 88.75px, p95 282.5px, max 213,412px** — broken
  before BA ever runs. Global BA lands in a bad local minimum (RMS 1289 → 43px
  "plateaued"; post-retriangulation BA REJECTED 43.0 → 44.3).
- Cameras accepted on almost no support: IMG_4315 **6/137** PnP inliers (4%),
  IMG_4320 7/65, IMG_4294 10/22, IMG_4314 12/100.
- Pass-2 gate ballooned to **32px** (adaptive gate follows model p95); 15
  cameras registered at 8–16px mean inlier reproj, each triangulating 100–1000
  points at that quality (IMG_4333 +1019, IMG_4336 +971).
- Track filter then deletes 41% of points (18304 → 10741) to reach median
  0.52px — survivor bias; wrong cameras stay wrong.
- Tracks: 9719 ×2 / 823 ×3 / 199 ×4+ = **9.5% ≥3-view** (target 30%+).
- Distortion fingerprint in the init-candidate table: init reproj grows with
  parallax (4306↔4307 0.64px @ 6.0° vs 4332↔4333 16.58px @ 16.5°) ⇒ unmodeled
  radial distortion (24mm wide-angle), *not* focal error. Self-calib cy
  drifting 1456→1638→1554→1519 is BA soaking that up.
- Matching: the 0.25 inlier-ratio gate rejects genuine medium-overlap bridge
  pairs (4319↔4321 27 inliers @ 0.23) — the glue that closes building loops.
- Dense (downstream symptom): cost medians 0.51–0.69 (weak ZNCC), fusion kept
  **5.0%**, 55.5% cost-culled; many depth maps report min depth **0.00**
  (degenerate planes surviving to output).

### B0 — CA213732V… aerial film strip (2026-07-03 00:12 run, 5 images, Medium dense, GPU)
The intrinsics-limited case (contrast with B1):

**Sparse** (healthy-looking but self-flattering):
- 3,066 points; track lengths **2712 ×2 / 352 ×3 / 2 ×4+** (88% 2-view —
  weakly constrained; the honest quality metric).
- Final reprojection median 0.50px — but measured *after* a 4px track filter,
  so bounded by construction. Pre-BA p95 was 12.5px.
- Init-candidate anomalies (fingerprints of an intrinsics error):
  0033↔0034 median parallax **0.48°** / 65% cheirality (others 9.8–17.7°);
  0032↔0033 init reproj **17.8px** vs 0.72px for 0035↔0036; PnP inlier ratios
  collapse toward the strip's left end (41/71, 75/183).

**Dense** (the user-visible pain: freckled depth maps, huge z-spread):
- Cost = 1 − ZNCC ∈ [0,2]. Per-image **cost median 0.63–0.70 ⇒ median ZNCC
  0.30–0.37** — barely above random. Root symptom; freckle + z-spread follow.
- Fusion auto maxCost = p70 = **0.71** (self-referential: a bad cost
  distribution sets a bad threshold). Kept **6.6%**; culled 31.4% no-depth,
  21.3% cost, **40.7% <2-views**.
- DEM: 235k measured vs 200k IDW-filled cells (~46% interpolated).

**Intrinsics suspicion (likely upstream cause):** K = 154mm ÷ 0.025mm/px =
fx 6160, but 10137px × 0.025mm = **253mm — wider than standard 230mm aerial
film**. If the scan spans the full frame, true pitch ≈ 0.0227mm ⇒ fx ≈ 6716
(~9% higher). A ~9% focal error explains the init anomalies, the 40.7%
<2-views cull, and dome/tilt z-spread. The user is verifying scan pitch /
fiducials; self-calibration (A2) + fiducials (F4) are the code-side support.
**Do not hard-code a "correct" focal.**

---

## Done log (most recent first)

- **2026-07-04 · R1–R6 registration-robustness track (sparse)** — the fix for B1's
  poisoned-during-registration model. All six landed; **acceptance still owed on the
  real building set** (see Owed validations in TODO.md). Where each lives:
  - **R1 honest PnP acceptance** (`core/sfm.js`): a pose now needs
    `inliers ≥ max(minPnpInliers=15, minPnpInlierRatio=0.15·correspondences)`, not the
    old bare `≥6`. Kills the 6/137 (4%) coincidence fits; deferring is cheap (the sweep
    retries every pass).
  - **R2 fixed PnP gate** (`sfm.js`): the adaptive `min(reprj·maxGateScale, max(reprj,
    p95))` gate — which ballooned to 32px on B1 exactly when the model was worst — is
    replaced by a fixed `reprjThreshold × min(pnpGateScale=2, 2)`. Images that can't
    clear it wait for the next pass's tighter model rather than being let in loose.
  - **R3 interleaved bundle adjustment** (`sfm.js`, the big one): after every
    `interimBaEvery=5` new cameras, run a global BA (`interimBaIterations=12`, poses+
    points only) + a track-filter pass, `rebuildViewIndex()`, then continue the sweep
    against the tightened model. Reuses `runBundleAdjust`/`filterTracks`; BA + filter
    settings + the sensor-group map were hoisted above the registration loop.
  - **R4 track extension beyond PnP inliers** (`sfm.js`): `foldOneEndpointMatches(gate)`
    — for a verified match between two registered images with exactly one endpoint
    already on a track, add the other endpoint's observation when it reprojects ≤ gate.
    Called at each pass end + after each interim BA. Directly raises the ≥3-view share.
  - **R5 matching absolute-inlier override** (`stores/useMatchesStore.js`): accept a pair
    below the 0.25 ratio gate when `inlierCount ≥ overrideInliers=30` — the medium-overlap
    bridge pairs (27 inliers @ 0.23) that close building loops. Ratio gate still guards
    the low-count junk. Logs a `ratio-override` note.
  - **R6 solve for radial k1 in BA** (`crates/reconstruction/src/bundle.rs` +
    `core/reconstruction.js` + `sfm.js` + modal): new `refine_mode==3` ('f,k1') adds a
    shared per-sensor `k1` (Brown r²) to the intrinsic block with the **full analytic
    Jacobian** (distortion folded into `dudc/dvdc`, focal column, + a k1 column);
    `project_k1` applies it in the cost. Output intrinsics widened 4→**5** per camera
    (`fx,fy,cx,cy,k1`) — reconstruction.js parses the new stride; refined k1 is logged
    for the user to copy into the sensor table. Intrinsic refinement (f,cxcy/f,k1) is now
    restricted to the **post-filter** BAs (refining against the pre-filter mess drifted
    cy 180px on B1). WASM rebuilt. Tests: Rust `bundle_adjust_refines_shared_k1`
    (recovers k1 <0.02, sub-px), JS `refines a shared radial k1`, existing tests moved to
    the 5-wide stride.
  - **Instrumentation**: per-camera median-residual table after the final BA, flagging
    cameras > 2× the global median (would have surfaced B1's pass-2 cameras by name).
- **2026-07-04 · Docs restructure** — CLAUDE.md = evergreen, TODO.md = the one
  plan, HANDOVER.md = record (baselines + done log). Duplicated status text
  removed from all three.
- **2026-07-04 · P2 parallel + preselected matching** — matching was serial O(N²).
  (1) **Concurrency-safe match store**: `useMatchesStore` now `shallowRef` + in-place
  mutate + `triggerRef` (was `matchStore.value = new Map(...)` on every write, which
  races under concurrency). `descCache` caches the in-flight *promise* so shared
  images load once. (2) **Parallel `matchAll`**: concurrency-limited pool of
  `POOL_SIZE` drain loops over a shared cursor; POOL_SIZE `min(2,…)` → `min(8, hc−1)`.
  Cancellation cooperative. (3) **Preselection**: `core/preselect.js`
  (`preselectPairs` — k-nearest by camera position) + modal strategy/knob;
  `matchAll` prunes the exhaustive set via imported-pose positions, keeps pairs
  with an unpositioned endpoint. Tests: `preselect.test.js`. Note:
  `useImagesStore.sync()` was *not* a hazard here — matching writes matches, not
  the image doc. (Remnants → TODO "P2 remnants" + owed timing validation.)
- **2026-07-04 · A3 retriangulation + track merging** — post-BA structure recovery
  in `core/sfm.js` as two pure exported functions: `retriangulatePairs` (matches
  with *both* keypoints unassigned → triangulate with improved poses, keep if in
  front of both cams + reprojects ≤ `filterMaxReprojPx`; injected WASM DLT) and
  `mergeSplitTracks` (endpoints in two *different* points = split track → fold when
  the union is consistent + reprojects ≤ gate). Runs after the first global BA,
  then one more BA; logs the 2/3/4+ histogram delta. Unit-tested (`sfm.test.js`).
  (Runtime yield on real data → TODO "owed validations".)
- **2026-07-04 · F1 export dialogs + GeoTIFF** — reusable `ExportModal.vue`
  (`kind` = cloud|model|dem|ortho). Dependency-free **GeoTIFF** writer
  `core/geotiff.js` (`writeGeoTiff` + `geoKeysForEpsg`; LE, uncompressed, single
  strip, ModelPixelScale/Tiepoint + GeoKeyDirectory, GDAL_NODATA); exporters gained
  `demToGeoTiff` (float32, NaN→nodata) + `orthoToGeoTiff` (RGBA + alpha
  extra-sample); `cloudToPly` takes `{ binary, color }`. CRS→EPSG parsed from the
  working CRS. Formats: cloud PLY binary/ascii, model JSON (±tracks), DEM
  GeoTIFF/`.asc`, ortho GeoTIFF/PNG+`.wld`. Tests: `geotiff.test.js` (parse-back)
  + `exporters.test.js`. (Polish list → TODO "F1 polish".)
- **2026-07-04 · F1 exports (first cut)** — pure `core/exporters.js` (`cloudToPly`
  binary LE, `reconstructionToJson`, `demToAsciiGrid`, `rasterWorldFile`) +
  UI-layer `utils/download.js`; Ribbon export commands enabled, handlers in
  `App.vue`.
- **2026-07-04 · A4 radial/tangential distortion (undistort-at-ingest)** — pure
  `core/distortion.js` (Brown–Conrady forward + iterative inverse, k1,k2,k3,p1,p2;
  round-trip < 0.05px tested). Sparse: `sfm.js` undistorts keypoints once after
  the K map is built, so init/PnP/triangulation/BA stay pinhole (init-pair `F` is
  still the distorted-space fit — BA corrects it). Dense/ortho:
  `compute.worker.js` `undistortRaster` remaps each working-res raster +
  `undistortMaskLut` moves masks, in `getRaster`; DEM + ortho inherit it. Coeffs
  flow via the store (`sensor.k1..p2`); the sensor table already had the columns.
  Tests: `distortion.test.js` + sfm end-to-end (corrected < 1px, uncorrected > 2×
  worse). No WASM change. (Solving *for* k1 → TODO R6.)
- **2026-07-03 · A2 intrinsics self-calibration** — `bundle.rs` generalised:
  points still Schur-eliminated, reduced system carries optional **shared
  per-sensor intrinsic** blocks (focal scale `s`, `dcx,dcy` for `f,cxcy`) with
  analytic Jacobians. New wasm-bindgen args `sensor_of_cam` + `refine_mode`;
  output includes refined per-camera K. Wired through `bundleAdjust`, `sfm.js`
  (sensor→group map, refined K applied back, before→after focal +
  implied-film-width log with weak-observability caveat), store, and modal
  (`refineIntrinsics: none|f|f,cxcy`, default off). Tests: Rust (recovers 1.1×
  focal <1%), JS boundary + no-op. Mode-0 byte-unchanged. WASM rebuilt.
- **2026-07-03 · A1 LM bundle adjustment** — found already implemented
  (`bundle.rs`: LM + Schur complement + analytic Jacobians + adaptive Huber;
  never accepts a worsening step; hand-rolled linalg, dependency-free). Closed
  loose ends: noisy-convergence Rust test + BA-enabled end-to-end JS test.
- **2026-07-03 · Q1–Q5 quick wins** — Q1 fusion auto-maxCost clamp→0.45 +
  weak-signal warn (`core/mvs.js`); Q2 converged-BA logs debug not warn; Q3
  persisted run summaries (sparse + dense) in `reconstruction.json`; Q4
  implied-film-width sanity log + off-standard warn (`resolveK`); Q5 dense
  window default 2→3 (7×7). Tests in `mvs.test.js` / `reconstruction.test.js`.
- **2026-07 (earlier) · WebGPU dense backend, Phases 1–2 + buffer limits** —
  GPU PatchMatch kernel (see CLAUDE.md Pipelines for the stable description).
  Phase 1: single-source ZNCC `plane_cost` port + first-image A/B validation.
  Phase 2: full multi-source PatchMatch (~0.1s/img vs minutes on CPU).
  Buffer-limit fix: `device.js` requests the adapter's max
  `maxBufferSize`/`maxStorageBufferBindingSize` (defaults 256/128 MiB; state is
  npix×16 B, ~380 MB at maxDim≈5000 → cryptic "map async" failure);
  `depthMapGpu.js` pre-flights the state buffer and throws a clear "lower
  maxDim" message (worker catches → WASM fallback). (Phase 3 = TODO P1.)
- **2026-07 (earlier) · Products: DEM + orthophoto** — local vertical frame
  (`core/projection.js`, PCA fallback, aerial Z-up auto-orient via
  `rotateReconstruction`), Horn similarity georef (`core/georef.js`, persisted
  in `reconstruction.json`), DEM rasteriser (`core/dem.js`, IDW fill, auto GSD,
  hillshade preview), true-reprojection ortho (`core/ortho.js`, depth maps as
  z-buffer + colour), `DemModal`/`OrthoModal`/`ProductPreviewModal`, products
  sidebar + per-product tabs (`ProductViewer.vue`), OPFS persistence
  (`products/{kind}.json` + `.bin`; DEM rebuild deletes the stale ortho). All
  core parts unit-tested. Legacy models need one Reconstruct re-run for Z-up.
- **2026-07 (earlier) · Dense MVS pipeline (two-stage)** — Stage A per-image
  PatchMatch depth maps (WASM `compute_depth_map`, COLMAP/Gipuma-style:
  seeded random init, checkerboard propagation, plane-induced-homography ZNCC,
  best-K aggregation, random refinement) + Stage B `fuseDepthMaps` (cross-view
  consistency → dense cloud, `kind:'dense'`). Worker ops `computeDepthMaps` +
  `densify`; orchestration `core/mvs.js`; view-tracks persist in
  `reconstruction.json` so dense runs on a restored project. Runtime-tested on
  real aerial film.
- **2026-07 (earlier) · Camera intrinsics + sensor table** — `resolveK` gained
  a focal-mm + film/sensor-format-mm path (`fx = focal / formatMm × widthPx`),
  ranked above EXIF guesses; sensor table px/mm toggle + pixel-size/format
  columns; `Sensor.sensorWidthMm`. Follow-up fixes: `sensorWidthMm` was
  initially dropped from the worker payload (K stayed default-FOV — now
  forwarded); sensor table read the *selected* cloud's cameras so a dense cloud
  blanked Estimated/Diff (store now exposes `sparseCameras`).
- **2026-07 (earlier) · Phase 3: Web Workers** — all heavy wasm off the main
  thread: `compute.worker.js` + `computeClient.js` (round-robin pool, promise
  RPC); ~400-line reconstruction orchestration extracted verbatim into pure
  `core/sfm.js` with `onLog`/`onProgress` hooks; store became serialise → call
  worker → apply + persist.
- **2026-07 (earlier) · Phase 2: test harness** — Vitest, node env, wasm from
  bytes in `beforeAll`; reconstruction/crs/sfm tests. **Bug found & fixed:**
  the wasm essential-matrix decomposition recovered a wrong rotation — `svd3`'s
  degenerate column filled the wrong vector and `decompose_essential` didn't
  force det(U)=det(V)=+1 before U·W·Vᵀ. Fixed + rebuilt; ground-truth pose test
  passes to 3 decimals.
- **2026-07 (earlier) · Phase 1: `src/core/` extraction + TS foundation** —
  8 pure modules moved `utils/` → `core/` (rule: core imports no Vue/Pinia);
  `tsconfig` scoped to `src/core/**/*.ts`, `types.ts` value types, JS modules
  opt into TS by renaming.
- **2026-07 (earlier) · Pinia migration** — all shared domain state moved from
  composables to stores; project-store registry collapses restore/clear fan-out
  (sensors + images stay manual for ordering); old composables deleted.
