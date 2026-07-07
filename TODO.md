# websfm — TODO (the plan)

The single prioritized plan. Roles: `CLAUDE.md` = architecture/conventions,
`HANDOVER.md` = record (baselines + done log), this file = **all open work**.
When an item ships: delete it here, add one done-log line to HANDOVER.md.

Ordered by expected impact on the two real workflows: scanned Antarctic aerial
film (CA213732V… strip) and close-range sets (Metashape building example).
Baselines to beat are in `HANDOVER.md` §Baselines.

---

## Now

### R — verify the R track on real data

R1–R6 (registration robustness) shipped 2026-07-04 (see HANDOVER done log) but
are only unit-tested. **Re-run the Metashape building set (B1) and confirm the
acceptance targets:** all 50 cameras registered at the *tight* fixed gate; pre-BA
p95 < 20px (from 282px); ≥3-view track share > 30% (from 9.5%); no BA-rejected
passes; with `refineIntrinsics: 'f,k1'`, self-calib cx/cy stable within ~10px and
a plausible k1. Then re-run dense: per-image cost median ≤ 0.45, fusion kept
fraction > 20% (from 5%). If a target misses, the per-camera residual table (new)
names the offending cameras; tune `interimBaEvery` / `minPnpInlierRatio` /
`overrideInliers` from there. Record the new numbers as baseline B2 in HANDOVER.

---

## Next

### SP — SuperPoint + LightGlue backend (first learned front end; realizes F5)
Add SuperPoint (detector) and LightGlue (joint matcher) as **selectable
alternatives** to SIFT + brute-force/RANSAC, run via **ONNX Runtime Web**
(`executionProviders: ['webgpu','wasm']` — WebGPU when an adapter exists,
per-session WASM fallback). Detector and matcher are two independent selectors,
but not orthogonal: LightGlue's weights are trained on SuperPoint descriptors, so
guard the invalid combos — SIFT(128-d)→brute-force ✓ (today), SuperPoint(256-d)→
LightGlue ✓ (new, the recommended path), SuperPoint→brute-force ✓ (kept as a
deliberate user-choice fallback — expected to underperform LightGlue, but the user
keeps the freedom to run classic RANSAC matching on learned descriptors),
**SIFT→LightGlue ✗ (disallow)**. Keep the SfM core, F/H verification,
`inlierSpread`, and the pairs graph exactly as-is (the neutral meeting point per
F5) — LightGlue just replaces `matchDescriptors` + the Lowe ratio test, and its
output still flows through `verifyMatches`. User supplies `.onnx` files; SP4 adds
custom-model upload. **MAGSAC++ is out of scope here** — it's an orthogonal
upgrade to `verify_matches_hf` that would benefit both pipelines; file separately.
Do **SP0 → SP1 → SP2** in order (proves runtime + persistence before LightGlue's
coord-normalization risk); SP3/SP4/SP5 fold in after. Browser-only inference —
say so; vitest can't run ORT-WebGPU (mock the session).

**SP0 — Runtime + assets.** Add `onnxruntime-web`; set `ort.env.wasm.wasmPaths`
(Vite static copy or CDN). Bundled models live in `public/models/` (`superpoint.onnx`,
`lightglue.onnx`), lazy-`fetch`ed on first use. Check whether the dev server / deploy
already sets COOP/COEP (cross-origin isolation) — ORT threaded WASM needs it; if
absent, force single-threaded ORT. No behaviour change yet; just the runtime in place.

**SP1 — SuperPoint detector (alternate `detect` path).** New `src/core/superpoint.js`
mirroring `core/matching.js`'s lazy-init wrapper: cached `InferenceSession` +
`detectSuperPoint(gray,w,h,{maxKeypoints})` → `{keypoints:[{x,y,score}],
descriptors:Float32Array(N*256), dim:256}`. Branch `compute.worker.js` `detect()`
(l.112) on `options.detector`, **reusing** `rasterize`, the mask LUT, and the
colour-sampling + `x/scale,y/scale` back-map loop (l.138–157) unchanged — only the
feature call swaps. Make `DESC_LEN`/`STRIDE` (l.33) per-detector, not the `128`
const. Tag results with `detector`+`descDim` and persist (small add to what
`useImagesStore` writes to `project.json`; carry descriptor width with the OPFS
blob per F5 note (1), so `descriptors/{uuid}.bin` is no longer assumed N×128).
Wire the enabled `superpoint` option into `DetectFeaturesModal.vue`'s `detectors`
array with its own settings block (maxDim, maxKeypoints). Prove detection +
persistence end-to-end first by matching on brute-force — this needs
`crates/matching` to match descriptors at their **native width** (dispatch on
`DESC = descA.len()/n`: keep the existing hand-unrolled 128-d `l2_sq_early`, add a
sibling 256-d kernel = 8 blocks of 32; **no padding 128→256** — that would dilute
SIFT's ratio-test distances; each width is matched in its own space, zero quality
change). Rebuild wasm + commit `src/wasm/*` per convention. This same 256-d path
also serves the SuperPoint→brute-force user-choice fallback above.

**SP2 — LightGlue matcher (alternate match path).** New `src/core/lightglue.js`:
cached session + `matchLightGlue({kpsA,descA,wA,hA,kpsB,descB,wB,hB,minConf})` →
`[{ia,ib,score}]`. This is a **new worker op**, not a drop-in for `match()`
(l.177): brute-force is descriptor-only + symmetric, LightGlue needs both keypoint
sets. **Model is now fabio-sim v1.0.0 `superpoint_lightglue_fused_cpu`** (swapped
2026-07-06; the old v0.1.0 export's 9.7k-node graph hung ORT's WebGPU warm-up —
see HANDOVER): inputs `kpts0,kpts1,desc0,desc1` — **no image-size input**, so
normalize keypoints in JS before feeding, fabio-sim convention
`(kpt − [w/2,h/2]) / (max(w,h)/2)` (validated offline: outputs bit-identical to
the old export); outputs `matches0` **[M,2] index pairs** + `mscores0` confidence
(the parser also still accepts the old per-kpt assignment format). **Remaining:
manual browser run** (CPU + GPU paths) — offline ORT-wasm validation passed but
per Verification policy the in-browser run is unproven. Branch `matchAll`
(`useMatchesStore.js`) on `settings.matcher`: LightGlue skips `matchDescriptors`/
ratio (l.88), builds the putative list directly, then **keeps** `verifyMatches`
(l.106) + `inlierSpread` (l.145) so SfM still gets `F`/`inlierMask`/`inlierCount`/
stats; feed LightGlue confidence as an extra low-conf prune before verify. Add the
matcher selector + validity guard (dim mismatch → clear log line, heavy-logging
convention) to `MatchFeaturesModal.vue`.

**SP3 — Concurrency & memory.** `matchAll`/`detectAll` fan out over the POOL_SIZE
pool; a LightGlue session is ~45 MB **per worker** plus WebGPU buffers. Route the
NN ops through a single dedicated inference worker (or cap NN-path concurrency to
1–2); SuperPoint/LightGlue are GPU-bound so per-image parallelism helps less than
it does for CPU SIFT. Measure memory + wall-clock; record in HANDOVER §Baselines.

**SP4 — Custom model upload (Settings ▸ Advanced).** Add an **Advanced** tab to
`SettingsModal.vue` (tabs today: project/display/storage/debug) letting the user
upload their own `superpoint.onnx` / `lightglue.onnx`. New `opfs.js` **Models**
section (`models/…`, follow the section-docstring pattern) + a small
`useModelSettings` composable/store; `core/superpoint.js`/`core/lightglue.js`
prefer an OPFS-stored override, else fall back to the bundled `public/models/`
default. Log which model file (custom vs bundled, + size/hash) each session loads.

**SP5 — Tests + verification.** Unit-test the JS marshalling (coord back-map, gate
wiring, validity guard) with a **mocked** `InferenceSession`. Real model inference
needs a **manual browser run** (Safari + Chrome) — flag explicitly, don't claim
verification (Verification policy). ORT-WebGPU vs WASM differ by float rounding —
don't assert exact equality (same caution as the SIMD/scalar + GPU/CPU A/B notes).

### P5–P9 — Matching & detection throughput (plan of 2026-07-04)
Exhaustive matching on the building set (50 imgs × ≤5000 kp → 1225 pairs) takes
minutes. Diagnosis: (a) the brute-force NN is O(pairs · M²) and every pair pays
full price even with zero overlap; (b) RANSAC always runs 1000 F iterations
**plus** 1000 H iterations per pair, each iteration doing a 9×9 Jacobi eig;
(c) every pair structured-clones ~5 MB of descriptors into a worker
(`computeClient.js` `matchDescriptors`, deliberately no transfer) and a second
`verifyMatches` call clones both keypoint arrays — ≈6 GB of copies per run.
Everything below keeps `core/` pure and the store gates unchanged. Suggested
order **P5 → P6 → P7 → P8 → P9**; measure matching wall-clock on the building
set before starting and after each item, record in HANDOVER §Baselines.

**P5 — Parallelize `detectAll`.** `useImagesStore.detectAll` awaits one
`detectOne` at a time despite the POOL_SIZE worker pool. Reuse `matchAll`'s
shared-cursor drain-loop pattern (`useMatchesStore.js` ~l.265); keep cooperative
cancellation and per-image progress callbacks. Expect ~POOL_SIZE× on detection.
Trivial.

**P6 — Adaptive RANSAC termination (`crates/matching`).** In
`ransac_fundamental` / `ransac_homography`: after each new best model, recompute
the needed iteration count from the inlier ratio w
(`n = ln(1−0.99)/ln(1−w^s)`, s = 8 resp. 4) and stop at `min(needed,
max_iters)`. Good pairs finish in <100 iterations instead of 1000. Also let
`verify_matches_hf` skip the H-RANSAC when F inliers land below a new
`h_skip_below` param (store passes `minMatches` — the pair is rejected anyway
and `hInlierCount` is only meaningful on kept pairs). Bonus if cheap:
PROSAC-style sampling — matches arrive sorted-ish by Lowe distance. Pure Rust;
rebuild wasm + commit `src/wasm/*` per convention. Expect 2–5× on the verify
stage.

**P7 — Two-stage exhaustive matching ("generic preselection",
Metashape-style).** The structural fix for the no-poses/no-footprints case.
SIFT keypoints are already response-sorted descending (`crates/sift` sorts
before output), so each image's strongest K descriptors are just
`descriptors.subarray(0, K*128)` — free, and served by the existing per-run
`descCache`. New `matchAll` stage for the exhaustive strategy (on by default,
toggleable in the modal): stage 1 mini-matches **every** pair with K≈300
descriptors (ratio test only, no RANSAC, no cross-check); pairs with ≥T putative
mini-matches (T≈10, setting) go to stage 2 = today's full match+verify; the
rest are recorded as skipped. Log kept/pruned counts like the proximity
preselector does. Supersedes the thumbnail-overlap preselector idea (removed
from P2 remnants). Expect 4–8× on building-style sets where each image truly
overlaps ~10–15 others.

**P8 — GEMM-form NN kernel (`crates/matching`).** Replace the early-exit scan
in `nn2`/`l2_sq_early` with a blocked top-2 distance computation: precompute
row norms, use d² = |a|²+|b|²−2a·b, compute dot products in cache-sized tiles
(e.g. 8 queries × 64 db rows staying in L1, f32x4 mul-add), track best/second
per query. Branch-free inner loop, full SIMD utilization; expect 3–8× over the
early-exit path. Keep the `match_descriptors` signature; existing tests must
pass (borderline ratio-test ties may flip — same caveat as the SIMD note at the
top of `lib.rs`). Optional follow-up, separate commit, only if still needed:
quantize descriptors to u8 at detect time + integer SIMD dot products (4× less
memory traffic, ~2× again) — touches the descriptor persistence shape, so gate
on measured need.

**P9 — Fused match+verify worker op + worker-side descriptor cache.** Add a
`matchPairFull` op to `compute.worker.js`: takes image ids, runs
match_descriptors + verify_matches_hf in one call, returns what the current two
calls return combined (raw count, F, hInlierCount, inlier-filtered matches) —
the gate logic stays in the store. Workers cache descriptors+keypoints keyed by
uuid + a revision bumped on re-detect (LRU-capped, ~100 MB); the client posts
an image's buffers to a worker only on cache miss and dispatches pairs grouped
by shared image (block order, not round-robin) to maximize hits. While in
`matchAll`: skip pairs already `done` under identical settings unless
`overwrite`, so interrupted runs resume. Expect 1.3–2× wall-clock and much less
GC churn; kills the ≈6 GB clone traffic.

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
- **Rotation-cycle match filter** on B1: does it drop the 4289↔4324 window-swap
  pair (and kin) before registration, without removing genuine weak-baseline
  bridges? Watch the `rotation-cycle filter dropped …` warn lines; if it culls
  real edges, loosen `cycleErrorDeg`/`cycleMinSupport`.

### P2 remnants — preselection fallbacks
- GPS-from-EXIF positions when no poses are imported. (The no-pose/no-GPS
  fallback is now P7's descriptor prefilter, which superseded the earlier
  thumbnail-overlap idea.)

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

### F6 — Fisheye distortion model (the one D3 couldn't absorb)
The distortion-model selector (D3) covers Pinhole/Radial/Brown, all of which the
undistort-at-ingest architecture handles (`distortion.js` `DISTORTION_MODELS`).
Fisheye (equidistant/equisolid θ-model) is the exception: a ≥180° FOV has no
pinhole equivalent, so undistort-to-pinhole can't represent it. Add the θ-model
to `distortNormalized`/`undistortNormalized`, and for **dense** undistort to a
*virtual pinhole with cropped FOV* (COLMAP's approach) rather than the full frame.
Also needs BA self-cal support for the fisheye params in `bundle.rs` (today only a
shared radial k1). Gate on a real fisheye/action-cam dataset — irrelevant to the
aerial + close-range workflows the tool targets today.

### F5 — Pluggable detector/matcher backend (learned features)
**The first concrete backend (SuperPoint+LightGlue) is now tracked under `Next ▸
SP`; this item remains the general design umbrella for later backends (DISK,
RoMa/LoFTR — incl. the detector-free one-stage `match(imgA,imgB)` shape).**
Make feature extraction + matching swappable so the user can pick SIFT (today),
SuperPoint+LightGlue, DISK, RoMa/LoFTR, etc. **The SfM core is already neutral**:
everything downstream consumes a pair as `{ F, matches: [[ia,ib],…], inlierCount }`
— index pairs into per-image keypoints whose only load-bearing fields are `x,y`
— and `sfm.js` never touches a descriptor. RANSAC F/H verification is correspondence-
level, so it's reusable or skippable. The coupling is all in the extract+match front
end. Two matcher *shapes* to support behind one output contract (per-image keypoints
+ index-pair correspondences + optional confidence):
- **Detect → match, two stages (SIFT, SuperPoint+LightGlue, DISK).** The staging
  survives; what changes is the match *algorithm*. Today `matchDescriptors(descA,
  descB)` does independent brute-force NN + Lowe ratio + cross-check and gets **only
  descriptors**. LightGlue is a *joint* matcher: it needs both feature sets together
  **plus keypoint positions** (attention input) and emits correspondences directly
  (no ratio/cross-check). So the concrete change is a `match` op that also receives
  keypoint coords, not just descriptor buffers.
- **Detector-free, one stage (RoMa, LoFTR).** These take an *image pair* and emit
  dense correspondences with no per-image keypoint stage — needs a `match(imgA,imgB)`
  op shape.
Front-end coupling to unpick, all upstream of the neutral pair interface:
(1) fixed 128-d float descriptor — `DESC_LEN=128`/`STRIDE=133` hardcoded in
`utils/detection.js` + `compute.worker.js`, and OPFS persists an untyped N×128 blob
(SuperPoint is 256-d); carry descriptor width with the buffer instead of as a const.
(2) the `detect→match` two-stage assumption baked into the worker op-map (`detect`,
`match` are separate ops) — add the joint/detector-free op shape alongside.
(3) keypoint shape `{x,y,nx,ny,scale,response,color}` — learned detectors give
`{x,y,score}`, mostly harmless since only `x,y` is load-bearing downstream.
Execution: run models via ONNX Runtime Web / WebGPU; the `src/workers/gpu/` device
singleton + op-map are the seams. Keep verification + the pairs graph exactly as-is
(the neutral meeting point). **Do the interface design before adding the first learned
backend**, so the two shapes above are both expressible from day one. Pairs with P4
(GPU matcher) and the GPU-SIFT idea.

### CC — Command console (power-user command line)

A typed command line that drives the **existing** command dispatch
(`handleCommand(id)` in `App.vue`) — every ribbon button is already a named
command, so this is a text front end over the same registry, not new pipeline
logic. Lives **inside the existing DevConsole panel** (a prompt line below the
log stream, REPL-style; toggled from *Other ▸ Console*). Output reuses `useLog`,
so typed commands and their results read inline with the pipeline logs.

Architecture (keep the layering): `src/core/commands.js` **pure** registry
(`{name, aliases, args, run, help, guard}` + arg parse/validate, Vitest-tested,
no Vue/DOM) → `src/composables/useCommands.js` binds registry entries to actions
(most just call `handleCommand(id)`; a few take args) → DevConsole prompt UI
(input, ↑/↓ history, tab-completion, inline usage/error). Extract the ribbon's
`isDisabled`/`disabledReason` guard so ribbon **and** console share one gate —
typing `dense` before depth maps exist prints "Compute depth maps first" rather
than silently no-op'ing. Destructive commands (`clear-all`, `remove`) need
`--yes`/confirm.

Command tiers: **T1 parity** — aliases auto-derived from the ribbon table (never
drifts): `detect`, `match`, `sparse`, `depth`, `dense`, `dem`, `ortho`,
`export cloud|dem|ortho`, `settings`, … **T2 power moves** (no button today):
`run detect match sparse` (chain the pipeline); `set sfm.minPnpInlierRatio 0.5`
(poke `core/sfm.js` knobs without a modal, echo old→new); `stats [matches]`
(dump match/track/registration counts); `pair disable|enable <A> <B>` (drive
`useMatchesStore.setPairDisabled` from the console — today only via
MatchListModal double-click); `select <imageName>`, `goto image|map`.
**T3 introspection**: `help [cmd]`, `log detail on|off`, `log clear`, `echo`.

Slices: **C1 ✅ (2026-07-06)** registry + `useCommands` + prompt UI + T1 parity +
help/history/completion — shipped, see HANDOVER. **C2** `run` chaining + `stats` +
`set`. **C3** `pair`/`select` store commands + `Cmd/Ctrl-K` open-and-focus
shortcut + per-command usage.
Verify: `npm test` on `core/commands.js` (parse, alias resolution, guard msgs);
UI/dispatch wiring is browser-only — flag as manual, don't claim verified.
Follow-up (C1 owed): manual browser pass on the prompt; consider auto-deriving
the T1 list from the ribbon table (extract it from `Ribbon.vue`) so it can't drift.

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
  picked up. Pairs with a GPU SIFT detector later. Revisit only after P5–P9
  land and are measured — they may already suffice; reuse P8's GEMM
  formulation (norms + dot-product matrix + top-2 reduction) in WGSL.
- **Stream partial reconstruction snapshots** from the worker so the 3D viewer
  builds up live (the `emit` channel exists; post periodic camera/point
  snapshots between stages).
- **Surface worker errors in the UI** — currently a per-request reject logs; an
  `onerror` fail-all path exists but isn't user-visible.

**Sparse / SfM**
- **Up-front feature-track builder (union-find), gated on measured need.**
  Establish tracks from the full pairwise-match graph *before* incremental
  mapping (COLMAP/Theia "track establishment"): union-find over
  `(image, keypointIndex)` nodes, so a feature chained A→B→C is one track
  regardless of triangulation order, with **conflict splitting** (a track must
  never observe one image with two keypoints — reuse the guard in
  `mergeSplitTracks`, `core/sfm.js` ~l.284). websfm already forms these tracks
  *implicitly* via the shared-index reverse map during registration
  (`core/sfm.js` ~l.684), so the win is narrow: (a) robust track topology
  independent of registration order, and (b) extra transitive 2D-3D
  correspondences that can rescue borderline PnP on **sequential strips** (B1's
  4308 missed the R1 gate by one inlier, 38/39). **Not** a substitute for graph
  connectivity — a chain with one bad link still isolates a downstream strip,
  and transitive closure trusts unverified A↔C links (error propagation). So
  only pursue if a real sequential-strip run shows exhaustive matching isn't an
  option and the implicit tracks under-deliver. Pure function in `core/sfm.js`.

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
- **wasm threads (rayon + SharedArrayBuffer) for matching** — rejected
  2026-07-04. The pair-level worker pool already saturates cores, and
  SharedArrayBuffer requires cross-origin isolation (COOP/COEP headers), which
  complicates deployment for no throughput gain.
- **Global undo/redo command layer** — rejected. Metashape has none; per-entity
  delete/edit (already in the stores) is enough.
- **Full 3D meshing (Poisson)** — parked in favour of F3's 2.5D DEM mesh.
