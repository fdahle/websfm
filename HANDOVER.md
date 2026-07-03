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

### A2 — Optional intrinsics refinement in BA (self-calibration) ← **next accuracy step**
Now that A1 is in place, add optional shared-per-sensor parameters to the LM problem:
`refineIntrinsics: 'none' | 'f' | 'f,cxcy'` (setting, default `'none'`,
exposed in the reconstruct modal's advanced section).
- All images sharing a sensor share one f (and optionally cx,cy) — one extra
  1–3 column block in the Jacobian, shared across those cameras.
- Log before → after fx and the **implied film width** (ties to Q4): if the
  user's 154mm/0.025mm entry is wrong, refinement should pull fx toward
  ~6700 and the log makes that visible and physically interpretable.
- Caveat to encode in the log: a 5-image single strip observes f weakly;
  recommend ≥2° tilt variation / longer strips for trustworthy values. Never
  silently write the refined value back to the sensor table — log it and let
  the user update the table.
- Test: synthetic scene generated with fx′ = 1.1×fx prior — refinement must
  recover fx′ within 1%.

### A3 — Retriangulation + track merging after BA
Directly attacks the 88%-2-view-track problem; standard COLMAP practice.
After the first global BA in `core/sfm.js` (before the filter/re-BA loop):
1. **Retriangulate**: sweep all verified pair matches; for matches where
   *neither* endpoint belongs to a point (they were skipped or failed
   cheirality under the early, noisier poses), triangulate with the current
   (post-BA) poses and add points that pass cheirality + reprojection ≤
   `filterMaxReprojPx` in both views.
2. **Merge**: matches where both endpoints belong to *different* points are
   the same physical point split in two. Merge when the union's observations
   all reproject within the gate against the merged (re-triangulated)
   position; keep the union's views map; drop the loser.
3. Run one more BA (A1) after.
- Reuse `viewIndex`/`addView`; keep everything inside `sfm.js` (pure).
- Expected on the test set: total points up (3k → noticeably more), and the
  **×3-view+ share up** (baseline 354/3066 ≈ 12%); log the histogram delta.
- Tests in `sfm.test.js`: synthetic 3-view scene where pair (A,C) matches are
  withheld from init but present in `donePairs` — retriangulation must
  produce 3-view tracks; a split-track fixture must merge.

### A4 — Radial distortion support (undistort-at-ingest design)
Scanned film + old lenses ⇒ radial distortion the pinhole model can't absorb;
it's a classic source of dome-shaped DEMs and cross-view depth disagreement.
Design decision: **undistort pixel data and keypoints once, keep every
downstream consumer pinhole** — do NOT thread k1 through the three PatchMatch
kernels (WGSL/JS/Rust homography warps assume pinhole; changing them breaks
the lockstep invariant for little gain).
- Add `k1` (Brown, optionally `k2`) to the sensor table + `Intrinsics` type.
- Sparse: undistort keypoint coordinates (iterative inverse, ~3 Newton steps)
  in `sfm.js`/`reconstruct` marshalling before use, when the sensor has k≠0.
- Dense/ortho: undistort during `rasterize()` in `compute.worker.js` (inverse
  map + bilinear sample — cheap at working scale) so depth maps, fusion, DEM,
  ortho all stay pinhole.
- Where does k1 come from? Manual sensor-table entry now; A2's machinery can
  optionally refine it later (`'f,k1'`) once the undistort plumbing exists.
- Tests: round-trip distort→undistort ≤ 0.05px over the frame; sfm synthetic
  with known k1.
- This is the largest A-item; fine to defer behind A1–A3 and re-evaluate — if
  Q4/A2 show the *focal* was the whole problem, k1 may be unnecessary for the
  metric-camera Antarctic sets.

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

### P2 — Parallel + preselected matching
Exhaustive matching is the felt bottleneck vs Metashape (see TODO backlog for
full context; SIMD is already done):
1. Fix the two concurrency hazards blocking pool parallelism: matches store
   replaces the whole Map per pair (mutate-in-place + targeted reactivity),
   and confirm `useImagesStore.sync()` coalescing suffices for concurrent
   completions. Then raise `POOL_SIZE` (computeClient) toward
   `hardwareConcurrency − 1`.
2. Pair preselection: match heavily downscaled thumbnails (or use imported
   pose/GPS when present) to score pair overlap; run the full matcher only on
   plausible pairs. For ordered flight strips this cuts O(N²) to ~O(N·k).
   Log skipped pairs as `skipped (preselection)` so the count is auditable.

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

### F1 — Exports (highest user value per effort)
Everything currently lives and dies in the browser. Add, in order:
- **PLY** (binary little-endian) export for sparse + dense clouds — trivial
  writer, `core/` pure function → Blob download in the UI layer.
- **DEM/ortho GeoTIFF** (or PNG + world file + `.prj` as the cheap first
  step). When a georef fit exists, write the project CRS; else local frame
  with a clear filename suffix. A minimal single-strip GeoTIFF writer
  (uncompressed, tiled off) is ~200 lines and dependency-free; a UI-layer
  dependency is also acceptable per the layering rules if preferred.
- Camera poses / sparse tracks as JSON (interchange with external tools).

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
