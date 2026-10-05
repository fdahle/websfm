# websfm — TODO (the plan)

The single prioritized plan. Roles: `CLAUDE.md` = architecture/conventions,
`METHODS.md` = the science, `HANDOVER.md` = the record (baselines + done log),
this file = **all open work**, and `VERIFICATION.csv` = the **manual-check
register** (every browser / external-application check this environment cannot
run, with its pass criteria and a column for the result).
When an item ships: delete it here, add one done-log line to HANDOVER.md, and add
its owed manual checks as rows in `VERIFICATION.csv` — **not** as a checklist here.

A handful of **open features keep a detailed executable spec** in a
`docs/planning/plan-<feature>.md` file (linked from the relevant item below). The
TODO line is the source of truth for *whether/when*; the plan file holds the
step-by-step *how*. `docs/planning/README.md` is the index. Delete the plan file
when its implementation work closes; any remaining browser or external-tool checks
belong only in `VERIFICATION.csv`.

**Goal (updated 2026-07-07):** a general browser-based SfM/photogrammetry tool
in the COLMAP/Metashape class — full pipeline (detect → match → sparse → dense →
DEM/ortho/mesh) for arbitrary image sets, with the existing differentiators
(polar/non-WGS84 CRS, historical film scans, zero-install/client-side) kept
first-class. Ordering below is by expected impact on the two benchmark workflows
(CA213732V… aerial strip, South Building B4 / Metashape building B1) *and* on
closing the generality gap. Baselines to beat are in `HANDOVER.md` §Baselines.

**Where we stand (audit refreshed 2026-09-01, after `0.1.0-beta.1`).** The feature
gaps named in the 2026-07-07 audit have closed: mesh output (F3), COLMAP/OpenMVG/
NVM/OpenSfM interop (F7), LAS+LAZ+COG+3D Tiles+undistorted images (F1), processing
report (F8), point-cloud editing (F9: numeric filters, sparse gradual selection,
3D rectangle/lasso delete), project save/load and
folder-backed projects, learned front ends (SuperPoint/LightGlue/SAM2) with
on-demand weights, and the usability track (profiler → recommendations → device
budget → per-control prefills → visual Workflow Builder). What is
*not* closed, in order:

1. **Verification.** Most of what shipped since 2026-07-10 has never been run in a
   browser on real data. That is the credibility gap now, not any missing feature.
   It is tracked row-by-row in `VERIFICATION.csv` (123 checks; 48 at P1).
2. Remaining feature gaps: DEM-of-difference and 3D measurement (F11 — scale, 2D tools
   and DEM volume shipped), ground classification → DTM (F14), mesh texturing, fisheye
   (F6), reference-DEM-constrained BA (F13).

---

## Now

### VER — work the verification register
`VERIFICATION.csv` is the list; fill in `status` / `result` / `date` per row and
fold measured numbers into HANDOVER §Baselines. Suggested first session, because
these gate code decisions elsewhere in this file:

| row | why it gates something |
| --- | --- |
| `SFM-01` SB medium/SIFT/exhaustive | the init-pair acceptance test; decides whether the seed heuristic is done |
| `SFM-03`/`SFM-04` building 50, both front ends | decides RS ▸ WS-B and the A6 bridge-pair gate below |
| `DEN-02`/`DEN-03` sky- and vegetation-heavy dense | decides the DF retune, and whether the in-optimiser pass is worth it |
| `RAS-05` EPSG:3031 under WebGLTileLayer | go/no-go for the whole RR re-architecture |
| `DEN-05`/`DEN-06` dense on WebGPU | validates the automatic GPU default shipped 2026-08-25 and its WASM fallback |
| `MAT-07` SB with 2 SIFT orientations (re-detect) | measures the 2026-10-05 detector change; then the `minInlierRatio` 0 run in MT |
| `REL-02` cold smoke on the deployed build | it is a public beta |

Rules that keep the register honest: record the *measured* number, not "ok"; one
variable at a time (the 2026-07-25 SB run changed detection preset *and* pairing
and is therefore not comparable to anything); and a blank Debug ▸ Project Summary
block means a **producer** is not recording — fix the producer, not the renderer.

### RR — remaining reference-raster work
Local COG display, GPU styling, bounded raw windows and reviewed GCP candidates
are implemented. Remaining work: fully windowed DEM analysis (sampling still uses
a flat elevation plane), conversion of sources above the decoding budget, remote
COG sources, and rectangular-pixel tiled raster tabs. Real large-tile timings and
visual comparisons remain `RAS-06`; the synthetic EPSG:3031 GPU path is verified.
See `docs/planning/plan-reference-raster-rearchitecture.md`.

### SFM — decisions parked behind the acceptance runs
Each is one knob with a named piece of evidence; none should be tuned a priori.
The 2-camera-stall implementation detail is in
`docs/planning/plan-registration-stall.md`; this section owns its gates and priority.
- **Init-pair E-conditioning.** The candidate σ2/σ1 term is already computed and
  logged. Wire it into the score **only if** `SFM-01` shows a barely-passing ~2.5°
  seed winning badly, with that run as its evidence.
- **RS ▸ WS-B — earlier f,k1 self-cal**, *only if* the shipped 2-camera rescue alone
  does not register the building set (`SFM-03`). Make `distortionRefine`/
  `rescueRefine` (`core/sfm/register.js`) observation-aware rather than
  camera-count-only: engage `f,k1` at `cameras.size >= 4 && totalObservations >=
  ~2000` (new knob beside `distortionCalMinCams` in `tuning.js`, with rationale).
  Never below 3 cameras — a 2–3-view k1 fit is noise.
- **A second rescue, only if the logs show it.** `rescued` is one-shot; if the
  relaxed sweep admits a few cameras and stalls again *before* the distortion fold
  at 6 cams, allow one more after the first fold ("folded since last rescue", max 2
  total). Do NOT make rescue unbounded.
- **Rotation-cycle filter — decide its fate.** It has never engaged on any baseline:
  B0/B1/B3 sit under the 30° ceiling, B4 skipped at **42.3°** median cycle error, above
  it. B4 suggested the cause was its position — it runs before self-cal on a focal 7.4%
  wrong, so its rotations are garbage exactly when it would have most to say.
  **A third baseline (2026-08-18, 127-image DJI nadir block) kills that explanation**:
  focal within **0.88%** of nominal, 127/127 registered, 0.86 px median, one component —
  and it still skipped, at **40.0°** over 1996 triangles. Near-correct intrinsics and an
  excellent solve produce the same abort as bad intrinsics, so **moving it after the
  distortion fold will not help**; that option is closed.
  The remaining hypothesis is geometric, not calibrational: F is not uniquely determined
  on near-planar correspondences, so the essential decomposition returns an arbitrary
  member of a family. The run is consistent with it (nadir block over terrain, best seed
  in the whole graph only 4.03° parallax, 0/779 pairs rejected at a mean inlier ratio of
  0.98). **The measurement that settles it now exists**: the digest reports the
  H/F-degenerate share of accepted pairs (2026-08-18). Re-run any baseline and read it —
  a high share confirms planar degeneracy, at which point the filter should be **removed**
  rather than relocated, since no calibration fix reaches it. A low share reopens the
  intrinsics hypothesis. One run decides; do not tune the ceiling in the meantime.
- **A6 — adaptive bridge-pair gate**, gated on `SFM-11`: B1 showed `minInlierRatio
  0.25` rejecting genuine loop-closing bridges (27 inliers @ 0.23). Evaluate
  lowering `MATCH_TUNING.overrideInliers` (30) to ~25 **or** an explicit bridge
  exception (ratio ≥ 0.2 AND inliers ≥ 25 AND passes the spread gate). Decide from
  logs; one knob, one test.
- Verification of the shipped secondary-model recovery + merge is `SFM-08`. Do not
  lower the global 30% PnP gate to force the P1180182 near-miss into the primary
  model.

### DF — dense cross-view filter: retune from data
Stage A′ (`filterDepthMapsGeometric`) shipped and is unit-tested but **unmeasured on
real data**; it subsumes what was previously tracked as A5. The former dense
sky/vegetation plan is retired: this section contains all remaining decisions.
- **Retune the defaults** once `DEN-02`…`DEN-04` are in. `maxGeomCost 1.0` /
  `minConsistent 2` / `minNcc 0.1` are COLMAP's numbers, adopted untested at our
  working resolutions. Watch for over-culling on legitimately weak-texture surfaces
  (snow/ice — the polar case is exactly where a photometric floor is most likely to
  be wrong).
- If Stage A′ wall clock is not negligible beside PatchMatch, restrict its source
  loop to each map's own `selectSourceViews` neighbours rather than all maps
  (it is O(maps²·px) worst case).
- **Then** consider a Metashape-style mild/moderate/aggressive preset over these
  three knobs — once real numbers say what the useful range is. Do not invent the
  deltas first.
- **Not doing: automatic sky segmentation.** A blue/brightness prior is unsafe in
  Antarctica (snow vs sky). Manual masking already works and is what Metashape users
  do; if this ever resurfaces it is a SAM2-seeded feature, not a heuristic.

### P0.3 — first-class "film width (mm)" input
In `SensorTable.vue`, for scan/film sensors offer format-width-mm as the primary
field (pitch derived) and surface a store suggestion when the implied-width warning
fires ("set to 230 mm?"). The `sfm.js` K path already supports width-derived focal,
and an explicit format **outranks** the pitch in `resolveK` since 2026-07-16, so the
warning's advice is now literally actionable — this item is just the UI half.
Related evidence: `VERIFICATION.csv` ▸ `FID-08` (the TMA set's implied 253 mm).

---

## Next

### RV — 2026-10-03 code + maths review: verified, not yet fixed
Each item was confirmed against the code (most with a measured number); the fixed
ones are in HANDOVER. Ordered by expected impact.
- **Dense half-pixel scaling**: working K uses `cx·s`; area resampling needs
  `(cx+½)s−½` (same in detection and the pyramid). Cancels only when detection and
  dense scales match.
- **Cross-view depth filter has no parallax gate** (COLMAP's
  `filter_min_triangulation_angle`): low-parallax views "confirm" sky, which then
  survives in the persisted maps the ortho uses as a z-buffer.
- **Voxel accumulator clamps out-of-bounds points into border cells** (bounds from a
  16-px-stride sample, one pad cell): thin tall features collapse. Exact bounds or
  pad by the depth range.
- **PatchMatch refinement schedule** decays from the full depth range and restarts
  per pyramid level; with 3 iterations the finest proposal is still ~12 % of range.
  Perturb relative to the current depth (COLMAP).
- **OPK convention**: `opkMatrix` is Rx·Ry·Rz used as object→photo; Pix4D documents
  it as image→object. Pin with a real Pix4D/Metashape fixture before trusting OPK
  orientation priors (κ flips on nadir if transposed).
- **`transforms.json` points at raw (distorted) images** with a pinhole K, and at
  scan dimensions with a canonical K for film. Export undistorted images with it.
- **Accuracy statistics**: control residuals normalised by Σ_gcp only (Baarda's
  Σ − Σ_ŷ reads ~35 % higher with 4 controls); LOO omits prediction covariance;
  SfM-point uncertainty ignored; pose fits drop anisotropic σ; "RMS" is weighted.
- **Rust numerics**: Jacobi stops on an absolute 1e-14 (matching + reconstruction);
  F-RANSAC's final linear refit can replace the best model with one of fewer
  inliers; no LO step; H/F ratio compares one-sided transfer error to Sampson.
- **Smaller**: dense applies the calibrated bag with the refined K (explicit refine
  string + calibrated lens only); a camera without a sensor loses its refined k1
  unfolded; the composed radial bag is fitted about the final principal point only;
  `estimateUpFromViewingDirs` tilts a single-heading oblique block's DEM.
- **Performance**: every 3D selection edit runs `persist()` over every cloud (> 1 GB
  per stroke with two 25 M-point clouds) — debounce or write only the changed
  cloud; selection overlay allocates ~16 B/selected point per stroke; LAS import
  always allocates ~29 B/point of attributes and subsamples attributed clouds with a
  string key per point; `sparseMetrics` returns one object per point; restore reads
  DEM/ortho before knowing it needs them.
- **Find GCPs reads the whole reference raster at 1536 px**: a regional tile against
  a drone block leaves the project a few dozen working pixels. Needs an approximate
  footprint (EXIF/priors) to window the read — the ortho itself is relative.
- **Structure** (god-file audit): unify Ribbon guards with `core/help/commands.js`
  `NEED_CHECKS` (one `state` prop instead of ~18); extract `core/sfm/ingest.js`
  (sfm.js 304–508); the survey-constraint builders moved to
  `core/sfm/surveyConstraints.js` (2026-10-04), but the anchored/prior BA *loops*
  are still in sfm.js and still lack one shared `buildBaObservations` (which also
  removes a per-observation `indexOf`); move the
  sparse-input marshaller out of `reconstruct()` into `stores/reconstruction/`;
  split fusion out of `mvs.js` with one shared windowed depth-agreement helper.

### FD — fiducial detection: remaining improvements (2026-10-03 gap analysis)
Shipped 2026-10-04: native refine ~70× cheaper, single decode, memory-bounded
concurrency, opposite-pair shape gate, donor/consensus/missing-slot/sidebar fixes.
Open, ranked for 100–1000-scan batches:
- **Rotation / mirroring per scan (M–L).** Detection is raster-relative, so a scan
  fed 180° rotated swaps slot identities and gets a wrong principal point; a scan
  mirrored relative to the batch lands mirrored in the canonical frame. Evidence:
  data-strip position, asymmetric marks, a learned-template probe (the dead
  rotation probe in `fiducialDetect.js` `detectFiducialsInImage`). Store `rotationK`/`mirrored` per image.
- **Batch-mean template + 2-D sub-pixel peak (M).** Align the accepted native crops
  per slot, average them, re-match every image (not only incomplete ones), and
  replace the separable parabola with a 2-D quadratic / Lucas–Kanade step. Test:
  synthetic marks with known sub-pixel offsets, RMS < 0.1 px.
- **Auto-map slots to the certificate (S).** Best D4 rotation/reflection + similarity
  from slot geometry to the certificate mm, instead of the hand mapping in
  `FiducialCalibrateModal`.
- **Review UX (M).** Persist drafts (`reviewed:false`, excluded from
  `calibratedFiducialPairs`) so a closed modal doesn't lose the queue; bulk "accept
  all ≥ x".
- **Cropped / border-less scans (S).** Low frame confidence makes every hit a draft;
  fall back to raster-relative acceptance when the batch consensus agrees.
- **Test gap**: `detectFiducialsForSensor` orchestration (retry, consensus/shape
  demotion, overwrite, masks) has no test; extract it to a pure function first.

### EX — external reference data (DEM / ortho)
Import georeferenced rasters you did **not** produce and use them as ground truth.
Shipped: the sidebar provenance split, `rasterKind.js`/`rasterSample.js`/
`rasterSource.js`, the `parseRaster` op, `useExternalStore`, the georeferenced-TIFF
routing fork, the generalised `ProductViewer` + `raster:` tab, GCP Fill Z / Check Z,
and the map overlay with per-layer opacity (A-4). Browser verification of all of it
is `VERIFICATION.csv` ▸ `RAS-01`…`RAS-04` — do that before building more on top.

**Automatic GCP finding from orthophotos** — the Tools ▸ Georeferencing ▸ **Find
GCPs** dialog defines the intended inputs (project ortho + imported reference ortho)
and its run action is deliberately disabled until the matcher exists. Build a
coarse-to-fine, rotation/scale-tolerant registration that:
- detects and matches stable features between the relative and reference orthos;
- robustly estimates the 2D mapping and rejects spatially clustered/ambiguous matches;
- converts accepted reference pixels to project-CRS X/Y, takes Z from a declared
  reference DEM (never silently invents Z=0), and traces relative-ortho pixels back
  to observations in the original registered images;
- creates **candidate** GCPs for user review with residual, confidence and coverage
  diagnostics, rather than silently accepting them as control;
- hands reviewed points to the existing Georeference workflow.

Depends on raw/readable reference pixels from **RR** — the baked RGBA source has no
window reader suitable for feature matching.

**Remaining phases**: A-5 picking GCP x/y/z straight off a reference ortho/DEM with
accuracy from GSD — **georeferencing with zero survey data**, often the only option
for historical Antarctic imagery, and the phase that makes the feature pay for
itself; A-6 reference-vs-reconstruction DEM diff as a Quality Report section
(`checkZAgainstReferenceDem` already returns the rows); A-7 remote/COG rasters (a
second `RasterSource` behind the existing boundary); A-8 GeoJSON + shapefile vector
layers. Standing trap: vertical datum (ellipsoidal vs geoid) differs by tens of
metres in Antarctica — the store carries `verticalDatum`/`verticalAccuracy` and Fill
Z refuses without the latter, but nothing yet *applies* a geoid separation (see F13).

### GG — guided GCP marking: optional follow-ups
Guides shipped and were confirmed in-browser 2026-07-16. **Snap-to-guide is
rejected, not deferred** (METHODS.md §6.4): a guide is derived from the
reconstruction, so snapping would feed the model back in as ground truth and erase
the guide-vs-mark disagreement exactly when the reconstruction is wrong.
- **Distortion-exact guides** — sample the pinhole line, push each sample through
  the composed self-cal distortion (+ `canonicalToScan` for film), draw a polyline.
  Only worth it if `GCP-05` shows a visible offset on the wide-angle building set.
- **Guides in the GCP inspector tab** (`ViewerGcp.vue`) — it already crops to each
  observation; a predicted-vs-marked delta there would make a bad mark obvious.

### MC — Phase 0b: dense multiplicity + lineage
Sparse multiplicity + `mainSparseId` landed 2026-07-10. Phase 0b is nearly free
(`clouds` already holds both kinds): stop replacing on `upsertDenseCloud`, add
`mainDenseId` and a `parentSparseId` per dense cloud (which sparse it fused from) so
lineage is explicit. **Depth maps become a child of their dense run** — key the cache
by parent dense id rather than exposing "multiple depth-map sets".
**Deferred deliberately**: DEM/ortho stay single refs until a real compare-two-DEMs
need appears (cheap to regenerate); matches/keypoints/georef stay single (one
converged config in practice — a plural match graph is a large store rework for a
workflow most users don't run). Metashape-style chunks stay parked.

### SP — SuperPoint + LightGlue: remaining slices
**SP3 — measure concurrency & memory.** The safety half has shipped: LightGlue is
pinned to worker 0, `session.run()` is serialized in `core/features/lightglue.js`,
and the store dispatches LightGlue pairs at concurrency 1. A session is ~45 MB plus
WebGPU buffers. Measure single-session GPU utilisation, peak memory and wall-clock
into HANDOVER §Baselines before deciding whether parallel sessions would actually
help. **⚠ This decides the parallel-LightGlue proposal in the matching-speed item
below**; do not add 2–3 sessions until the measurement justifies their memory cost.

**SP4 — custom model upload** (Settings ▸ Advanced). User-supplied
`superpoint.onnx` / `lightglue.onnx` via a new `opfs.js` **Models** section
(`models/…`) + a small `useModelSettings`; the core backends prefer the OPFS
override, else the registry URL. Log which model (custom vs default, size/hash) each
session loads.

**SP5 — tests.** Unit-test the JS marshalling (coord back-map, gate wiring, validity
guard) with a mocked `InferenceSession`. Real-inference browser runs are
`VERIFICATION.csv` ▸ `DET-02`, `DET-04`, `DET-06`.

### MT — closing the gap to COLMAP on South Building
Where we stand (HANDOVER ▸ B-match-gpu, MAT-05): matching **109.5 s** vs COLMAP 99 s
(done — GPU-bound at 13.5 ms/pair); ≥3-view points **54,728** vs 80,792; accepted
pairs 1694 vs 2678. Turning the subset gate off raised accepted pairs 61 % and
≥3-view points 0.2 %, so the point gap is downstream of matching. Run the browser
experiments one variable at a time on SB (exhaustive, GPU, gate off, ratio 0.8 unless
stated), each recorded as a VERIFICATION row + HANDOVER baseline.

**Points:**
- **Track building is ruled out (MAT-06).** Final-stage completion lifted only 338
  points (+0.6 %); 38,685 two-view points have no verified correspondence into a third
  registered image. The gap is in the correspondences themselves — the items below.
- **MAT-07 — measure SIFT multi-orientation** (shipped 2026-10-05, needs a re-detect).
  Note the cap: most SB images already hit 10,000 keypoints, and siblings count toward
  it (as in COLMAP), so at 2400 px the second orientation partly *replaces* the weakest
  extrema. If MAT-07 shows the cap binding, a follow-up run with a higher
  `maxKeypoints` (or the full-resolution item below) separates the two effects.
- **Inlier-ratio gate** (one run with `minInlierRatio` 0): COLMAP accepts any pair
  with ≥15 inliers; MAT-05 rejected 6282 pairs after verification. More accepted pairs
  = more correspondences per feature = longer tracks.
- **Rotation-cycle filter on true pairs.** MAT-06: 748 observations from the dropped
  pairs agree with the final geometry within 5.1 px — many dropped pairs are true.
  It removed 331/1694 pairs on MAT-05, incl.
  obvious sequential neighbours (P1180213↔218, 757 inliers, 0/31 triangles on MAT-03;
  ~20 % of accepted pairs are H/F-degenerate — a planar pair's E decomposition can
  return the wrong rotation). They now feed completion, but not registration, init or
  triangulation, and re-admission runs only while images are unregistered. COLMAP has
  no such filter; an experiment with the filter off would size its cost.
- **Interim-BA blow-ups.** MAT-05 interim BAs started from RMS 92 / 719 / 42 px (max
  ~1.9k px) and five were rejected; the final model is clean (max 8 px). Bad
  observations enter during registration — find which step (PnP extension vs fresh
  triangulation) before they cost tracks.
- **Detection resolution**: COLMAP extracts at full 3072 px with an upsampled first
  octave; SB ran at ≤2400 px. Separate experiment, after the matching ones.

**Speed** (no longer the gap; only if a larger set needs it):
- **Kernel throughput** — Chrome measured 13.5 ms/pair GPU-bound on SB (COLMAP ~12).
  Options: f16 descriptors (`shader-f16`) halve bandwidth; uint8 descriptors with
  `dot4U8Packed` quarter it but change descriptor semantics for both backends
  (METHODS change, crate in lockstep).
- **Subset-gate default**: with the GPU backend the gate saves little and costs
  pairs; make "off" the default for GPU runs.

### Matching & detection throughput
Stage timings now separate loading, serialization, matching and verification.
Use a real dataset to justify **P9 → P10**; measure before/after and record in
HANDOVER §Baselines (`DET-07` is the before-number).

**P9 — fused match+verify op + worker-side descriptor cache.** One `matchPairFull`
op (match + verify in one call; gate logic stays in the store). Workers cache
descriptors+keypoints keyed by uuid + re-detect revision (LRU ~100 MB); the client
posts buffers only on a cache miss and dispatches pairs grouped by shared image. Skip
pairs already `done` under identical settings unless `overwrite` (resumes interrupted
runs). Expect 1.3–2× and far less GC; kills the ≈6 GB of clone traffic per run.
The GPU matcher already does the descriptor half for its own worker (per-run LRU
keyed by uuid, `{ needs }` on a miss — `workers/gpu/matchGpu.js`); reuse that
protocol for the WASM pool rather than inventing a second one.

**P10 — don't compute descriptors for keypoints the cap throws away.**
`sift_keypoints` computes orientation + the 128-d descriptor inline for *every*
surviving extremum, but `detect_sift` then response-sorts, dedupes and truncates to
`max_keypoints` — measured **18288 descriptors computed to keep 10000** (B-detect).
Response is known *before* orientation/descriptor, so the scan can collect bare
`(x, y, scale, response, octave, s)`, sort/dedupe/cap globally, then describe only
survivors. **The catch**: dedup is deliberately cross-octave, so the cap is global and
survivors' Gaussian levels must still be live when it is known — octave 0's six levels
are ~600 MB at 25 MP. Either re-blur per octave in a second pass (cheap now) or group
survivors by octave and describe octave-by-octave on the way down. Measure the extrema
count on real scans first; `raw_found` is post-dedup and does not currently tell us.

**Matching speed (Q ▸ P5), 37 min → <8 min for 50 images.** (1) retrieval
preselection without poses — aggregate existing SuperPoint descriptors → cosine kNN →
top-k + sequential ±2 (the build-now variant of the parked vocab-tree item); (2) don't
escalate hopeless pairs — F-verify the *coarse* matches first and only run the capped
match if coarse F-inliers ≥ ~8 (`matchLightGlueTiled`); (3) parallel LightGlue across
workers — **⚠ conflicts with SP3**; (4) demote per-tile logs to debug. Acceptance:
<10 min with ≥95% of currently-verified pairs still found, no ORT deadlock on
Cancel+rerun.

### Dense quality & performance
- **P2.2 — bilateral-weighted ZNCC (COLMAP-style).** Weight window samples by
  grayscale similarity + spatial distance. Change all three kernels
  (`mvs.rs`/`patchmatch.wgsl`/`planeCost.js`) **and** the `aggRef` reference in
  lockstep; re-check the A/B RMS < 5e-3 and the slanted-plane test.
- **P2.4 — geometric-consistency pass inside PatchMatch** (COLMAP
  `--geom_consistency`). Re-runs PatchMatch with the forward-backward error in the
  cost, so hypotheses are pulled toward the consistent solution instead of only being
  rejected. Buys **completeness** on weak texture, not precision (Stage A′ already got
  that). ~2× Stage A, touches all three kernels under the lockstep invariant, and
  needs `memBudget.js` to learn a Stage A peak (it models only fusion). **Only worth
  it if `DEN-02`/`DEN-03` show holes, not freckles.**
- **P3 — OPFS quantize + spill of depth maps.** Persistence shipped; this is the
  memory/size half. **Quantize** the planes (depth → Uint16 + per-map min/max, cost →
  Uint8, normals → 3×Int8 — normals are >half the bytes and Poisson won't notice
  ~0.5°), roughly 4× off the ~50 MB/image at medium quality; version the sidecars
  (`index.json` has `version: 1`) and keep reading v1 float planes. **Spill per image
  as each completes** so peak memory is one map rather than all of them; densify/ortho
  then read + dequantize **in the worker** and the store cache holds metadata —
  `depthMapsMeta` already models that state, so the lazy path is the seam. Raster cache
  goes gray-only (+rgb for reference); GPU state packs f16 via `pack2x16float` with
  chunked readback. Gotchas: transfer lists detach buffers shared with ortho (the
  densify error path recovers by reloading from disk — keep that working);
  `layout:'auto'` bind groups and the 64-byte Params uniform in `depthMapGpu.js` move
  together. Validate in Safari before calling it done. Measure `DEN-10` first.

### M3 / M4 — masking
- **M3 (optional polish, gate on use):** polygon/lasso tool; "apply mask to all
  images of this sensor" (`maskFromSource` already rescales); masked-% readout; mask
  badge in the sidebar ImagesSection. The owed browser pass for the shipped toolbar is
  `VERIFICATION.csv` ▸ `UI-09`.
- **M4 — content-based Auto-Mask strategies** — spec:
  `docs/planning/PLAN-automask-strategies.md`. Not started. Auto-Mask today has one
  strategy (fixed-px border); add three content-based ones (detect film frame per
  scan, colour/luminance key, low-texture regions) as a worker op reading downscaled
  rasters: pure `core/maskAuto.js` + `workers/ops/mask.js` + a strategy-picker rework
  of `AutoMaskModal.vue`. SAM2-propagation auto-masking stays parked (F12).

### TC-2 / TC-3 — TIFF ingest follow-ups
- **TC-2 — Rust TIFF *encoder*.** The native decoder shipped (34 s → 1 s; B0-ingest),
  so the remaining ingest cost is the **canvas PNG encode (~4 s, ~75% of ~5.3 s/img)**
  — Chrome's PNG encoder is slow and canvas forces 4-channel RGBA even for grayscale
  scans. Only worth doing if ingest needs to go lower. Add `encode_png(pixels, w, h,
  channels)` to `crates/imagecodec` (`png` + `fdeflate`) emitting **true grayscale**
  for gray sources (¼ the data to filter+deflate); keep the display JPEG on canvas;
  same fallback discipline as the decoder. Watch the transfer cost of handing the
  ~390 MB RGBA buffer between decode and encode — one Rust call doing both (never
  returning raw pixels to JS) may beat two hops. Verify PNG round-trips to identical
  pixels, and put before/after `TIFF timing` in HANDOVER.
- **TC-3 — log source compression/bit-depth on the wasm decode path.** The `TIFF
  timing (wasm):` line shows `[undefined/?-bit/?spp/undefined]` because only the
  geotiff fallback branch fills `srcInfo`. Have `decode_tiff` also return photometric /
  bits-per-sample / samples-per-pixel / compression (the `tiff` crate exposes them) and
  populate `srcInfo` from the wasm result in `workers/ops/tiff.js`. Diagnostic only.

### LG — log lines that say "1 position(s)"
`core/textFormat.js` (`pluralize` for "n noun", `nounFor` for the "7/12 pairs"
shape where the number is a ratio) shipped 2026-08-18 and is used by the EXIF-GPS
line. **~120 other `(s)` strings remain** (grep `"[a-z](s)"`), mostly in
`core/sfm/`, `core/dense/`, `useMatchesStore` and `useImagesStore`. The helper is
in core precisely so those call sites can use it. Mechanical, but do it as one
reviewed pass, not opportunistically: a few read better rephrased than
pluralized, and a handful of tests assert on log text.

### IS — image-source liveness: the two remaining halves
Detection, the OPFS heal and the durable-storage request shipped 2026-08-18 (see
HANDOVER; rows `PRJ-10`…`PRJ-14`). Both items below are about not *needing* the
heal — they close the window rather than react to it.
- **IS-1 — re-point `img.url` at the OPFS copy once ingest has written it.** In a
  session, `url` keeps pointing at the user's original file on disk, so anything
  that happens to that file (moved, renamed, cloud-sync eviction) breaks the image
  even though a good copy exists. After `opfs.saveImage` resolves in `addImages`,
  revoke the disk-backed URL and re-create it from the OPFS blob. Cost is one
  read-back per image at import — measure it on a film-scan batch (B0-ingest) before
  making it unconditional; doing it lazily (first heal) is the fallback if it hurts.
  Not applicable to a non-persisting session, which has no copy by definition.
- **IS-2 — liveness in the Workflow Builder pre-flight.** A dead source is only
  discovered today when something renders or reads pixels, i.e. possibly an hour into
  a run. `core/preflight.js` is the right home: probe each image (one-byte read of the
  blob, the same test `refreshImageUrl` uses) and emit a `warn` naming the images that
  will fail, with "re-add the file" as the `fix`. Cheap enough to run per stage; must
  stay out of the hot path (it is O(images), not O(pixels)).

---

## Later — features

### F11 — measurement tools (scale shipped 2026-08-25)
**Scale constraints shipped** (slice 1, WS0–WS2: markers, scale bars, the
`effectiveFrameSpec` resolver, residual reporting, staleness) — see HANDOVER
2026-08-25 and `VERIFICATION.csv` ▸ `MEAS-01`…`MEAS-04`, `MEAS-10`…`MEAS-13`.
The 2026-09-27 slice added saved 2D ruler/polyline, planimetric area and DEM
profiles with CSV export and source/frame staleness; synthetic Chromium coverage is in `workflow-tools.spec.js`.
Volume cut/fill on a DEM polygon (plane/lowest/custom base, coverage-reported holes)
shipped 2026-10-03. What remains is 3D picking/rulers, true surface area, and a
**DEM-of-difference** volume (computed DEM vs an imported reference DEM, sampled
through `useExternalStore`'s reprojected query — the multi-epoch change product).
- **Remaining measurement tools** (Pix4D rayCloud): 3D ruler/polyline, true surface
  area, and DEM-of-difference volume. Extend the shipped
  `core/products/measure.js`; the one new *interaction*
  primitive is 3D picking, which `Viewer3D.vue` has none of today. The saved 2D half is shipped. **Ship additional pure core with its consumer, not before** — `preflight.js`
  above is the standing example of why.
- Every readout goes through `effectiveFrameSpec` and prints its unit: `24.13 m`
  or `24.13 model units`, never a bare number. That resolver, the `scaled-local`
  frame and the marker role are already in place, so this is now viewer work.
Plan: `docs/planning/plan-scale-and-measurement.md` ▸ WS3–WS7 (WS0–WS2 done;
delete the file once the measurement slices ship; unsigned checks stay in the register).

### F14 — ground classification → DTM
websfm is a general tool, so "DSM ≈ DTM on bare terrain" is not a reason to skip this:
vegetated and built-up drone sites need a bare-earth model. Today the DEM bins dense
heights per cell (`core/products/dem.js`), which yields a DSM. Imported LAS
classifications are already displayed (`core/products/cloudStyle.js`) but nothing
produces or consumes them.
- **Automatic ground filter** writing a `classification` attribute on a derived dense
  cloud (cloth-simulation or progressive-morphology filter; parameters in metres
  through `effectiveFrameSpec`, refused in model units).
- **DEM from selected classes** (DemModal: "all points" vs "ground only"), which is
  what makes the DTM. LAS/LAZ export must carry the attribute.
- Manual reclassification can reuse the 3D rectangle/lasso selection (F9) with an
  "assign class" action next to Delete / Keep only.

### F13 — reference-DEM-constrained bundle adjustment
Anchor sparse points to an imported reference DEM surface as a weak "the ground is
roughly here" prior — a soft constraint that kills dome/bowl distortion on long
strips **without any GCPs**. `bundle_adjust` already takes `anchor_flat`/
`anchor_weight` on arbitrary point indices (built for F2), so the wiring exists;
what is new is the method: per-point targets are not fixed positions but
*projections onto a surface*, so the anchor target must be recomputed each iteration
(point x/y → DEM z) rather than set once, and the weight must reflect the DEM's
vertical accuracy or it fights the observations. Needs RR to land first.
**Research-grade — METHODS.md would need a section; do not start on a whim.**

### F6 — fisheye distortion model
The sensor selector covers Pinhole/Radial/Brown — all undistort-to-pinhole-able.
Fisheye (equidistant/equisolid θ-model) isn't: ≥180° FOV has no pinhole equivalent.
Add the θ-model to `distortNormalized`/`undistortNormalized`; for dense, undistort to
a *virtual pinhole with cropped FOV* (COLMAP's approach). Needs BA self-cal support
for fisheye params in `bundle.rs`. Gate on a real fisheye dataset — irrelevant to the
current workflows.

### F5 — pluggable detector/matcher backend (design umbrella)
SuperPoint+LightGlue shipped as the first learned backend; this remains the umbrella
for later ones (DISK; detector-free RoMa/LoFTR need a `match(imgA,imgB)` op shape
with no per-image keypoint stage). The SfM core is already neutral (pairs as
`{F, matches:[[ia,ib]], inlierCount}`) and descriptor width is carried, not assumed.
Keep verification + the pairs graph as the neutral meeting point. MAGSAC++ is an
orthogonal upgrade benefiting every backend — file under `crates/matching`.
The original backend plan is retired: SP0–SP2 and the backend-neutral boundary
shipped; SP3–SP5 above are the remaining concrete work.

### CC — command console, remaining tiers
**C2**: `run workflow <name>` / `run detect match sparse` through the shipped
workflow runner, `stats [matches]`,
`set sfm.minPnpInlierRatio 0.5` (echo old→new). **C3**: `pair disable|enable <A> <B>`,
`select <imageName>`, `Cmd/Ctrl-K` open-and-focus, per-command usage. Consider
auto-deriving the T1 command list from the ribbon table so it can't drift.

### WF — Workflow Builder follow-ups
The empty-by-default visual builder, project workflows, global templates, execution snapshots,
interactive pauses, preflight, reuse/warning policies and generated recipe text
shipped 2026-09-01. Input and export intentionally remain direct user actions rather
than workflow blocks. Remaining power-user layers, deliberately after browser use:
- **Quality-gate blocks + branching** over recorded report metrics (registered share,
  reprojection error, dense coverage). A failed gate may pause/stop or choose a branch.
- **Editable recipe text** once the v1 JSON schema survives real projects; parse into
  the same block graph and require lossless visual ↔ text round-tripping.
- **Parameter sweeps / multi-project batch runs** only after one-project resume,
  interactive-block and storage-pressure behaviour is proven.
Acceptance for the shipped builder is `VERIFICATION.csv` ▸ `UI-15`.

### Remaining interoperability
Deliberately not started, with the reasons, so they aren't re-litigated:
- **Mesh texturing** — reframed as a *pipeline* feature, not an export format.
  `meshToObj` already writes per-vertex colour; adding OBJ+MTL is an afternoon, but
  there is **no texture to reference**: no UV atlas, no bake. The real work is (1) a UV
  atlas (xatlas as an isolated WASM crate, same precedent as `crates/mesh`), (2)
  visibility-based view selection + seam blending, reusing the depth maps as the
  z-buffer exactly as `core/products/ortho.js` does. Textured OBJ+MTL, textured glTF
  and a textured 3D Tiles payload all fall out afterwards. File under Products.
- **3D Tiles LOD** — the shipped exporter writes one tile, which covers "put my model
  on a globe". A quadtree with per-tile decimation needs a mesh simplifier websfm does
  not have. Gate on someone actually streaming a websfm product into Cesium and
  hitting the limit.
- **E57** — declined for now. XML over paged binary sections with a CRC-32 per
  1024-byte page and bitpacked `CompressedVector` fields: weeks of work with no
  browser-targetable library, and **LAZ now reaches the same software**
  (CloudCompare, QGIS, ArcGIS, Cyclone, Faro). Its distinctive value — multi-scan
  poses and embedded panoramas — is a terrestrial-scanning concern. Revisit only on a
  request naming the receiving application, and **read** support first.
- **Bundler import** — skipped as time-boxed; revisit only on demand.
- **Compress imported reference rasters.** Now free: the `planCog`/`assembleCog` split
  means `useExternalStore`'s import path can DEFLATE its tiles too, so a large REMA
  tile stops costing its full uncompressed size in OPFS. Fold into RR Phase 2.

### Products follow-ups
Real-world map-viewer overlay for the ortho; ortho GPU/WASM kernel if per-cell JS
proves slow on large grids; optional manual "Flip Z" for object scenes; DEM/ortho
preview images + a run settings/timings strip + an inline SVG track-length histogram
in the exported HTML report (the hub already shows the histogram live).

---

## Backlog

**Data-relative defaults — examined and rejected**
- **Do NOT scale `maxNeighbors` / `sequentialOverlap` with image count.** Both encode
  how much the *capture* overlaps (an aerial strip at 60/30% overlaps ~8–12 neighbours
  whether the block is 20 images or 500), not how large the set is. Scaling them with
  N adds O(N²) matching cost that buys no new edges. The genuinely set-size-dependent
  decision — "is preselection/the subset gate worth its false-negative risk at this
  pair count?" — is already handled by `subsetGateMinPairs` and the
  `preselectionApplied` veto.
- **Do NOT scale `minMatches` with the keypoint budget.** It looks budget-relative but
  is a *geometric* floor (enough correspondences to constrain F/PnP robustly), and
  raising it on a Detailed run would cut exactly the 15–40-inlier tail that carries
  mean track length. The spurious-match growth that comes with a larger budget is the
  **inlier ratio** gate's job, not the absolute count's.

**Project storage**
- **ZIP64 writer**, to lift the 4 GB `.websfm` ceiling. fflate reads ZIP64 but does not
  write it, so a too-large project is refused up front (`archiveSizeVerdict`) rather
  than silently corrupted. Wanted only once someone hits it — the folder backend is the
  better answer at that size, and the refusal message says so.
- **Human-friendly filenames in a folder project.** Genuinely nicer on disk, but it
  forks the layout from the OPFS one — and layout identity is what makes the zip
  export, the migration copy and the single restore path all free. Only revisit with a
  plan for keeping one canonical layout.
- **Two tabs on one folder project can race.** Same pre-existing situation as two tabs
  on one OPFS project; out of scope until either is addressed.

**Compute & workers**
- **GPU dense perf** (measure before/after; only worth it as image counts grow):
  half-grid dispatch for parity sweeps (2× occupancy); overlap CPU rasterize/undistort
  of image i+1 with image i's GPU work; on-GPU pyramid (upload levels once, depth
  upsample as a compute pass, read back finest only — changes the per-level backend
  contract); fewer submits via a dynamic-offset ctrl uniform.
- **WASM dense perf**: f32 hot loop in `mvs.rs` `plane_cost`/`agg_cost` (the GPU path
  proves f32 sufficient; keep the JS f64 reference as the precision anchor).
- **Threads for the Poisson solve.** The finest-layer solve is now the mesh tall pole
  (123 s of 227 s at depth 8) and is genuine sparse-assembly + CG work — the part that
  would gain most from rayon. The app is already cross-origin isolated for ORT, so
  `SharedArrayBuffer` is available and the rayon strip is a build flag, not a hard
  limit. Gate on someone meshing at depth 8+ regularly.
- **Stream partial reconstruction snapshots** from the worker so the 3D viewer builds
  up live (the `emit` channel exists).
- **Surface worker errors in the UI** — a per-request reject currently only logs; the
  `onerror` fail-all path isn't user-visible.
- **Match-graph edge rendering at scale** (`components/viewers/MatchGraph.vue`). The
  force-layout freeze is fixed, but with a huge match count the *edge* paths remain
  O(edges) ≈ O(n²) per frame: `draw()` strokes every edge and `edgeAt()` scans them all
  on mousemove; `pairSetKey()` sorts+joins all pair IDs into one string per deep
  `matchSummaries` change. Levers when it bites: edge culling/thinning at low zoom, a
  cheaper topology signature. Not a hard freeze — revisit only if reported.

**Sparse / SfM**
- **Up-front feature-track builder (union-find), gated on measured need.** Track
  establishment from the full match graph before incremental mapping (COLMAP/Theia
  style) with conflict splitting (reuse the `mergeSplitTracks` guard). websfm already
  forms tracks implicitly during registration; the win is narrow — robust topology
  independent of registration order + transitive 2D-3D correspondences rescuing
  borderline PnP on sequential strips (B1's 4308 missed R1 by one inlier). Only if a
  real sequential-strip run shows the implicit tracks under-deliver.
- **Per-pixel view-selection weighting** in dense (currently per-image best-K only).

**Import / formats**
- **COPC reader for large reference clouds** (LOD, not storage). Decided 2026-07-22:
  COPC must **not** become websfm's own cloud format — its value is HTTP-range
  streaming of a remote octree, which a fully client-side app never issues, and
  internally we'd pay LASzip on every read/write plus int32 quantization (a real
  precision loss in the polar/survey-CRS case) for nothing. Where it *does* pay is as a
  **reader** for imported Reference Data: a dropped 500 MB LAS is already a pain point,
  and an octree with LOD is the correct fix for "view a huge external cloud without
  hydrating it" — the same lazy pattern as `ensureRasterLoaded`/`depthMapsMeta`, and the
  point-cloud analogue of the `RasterSource` boundary. So: introduce the equivalent
  `CloudSource` boundary first, then a COPC implementation behind it. LAZ is no longer a
  blocker (`crates/lazcodec` reads and writes it) — COPC is now only the octree/LOD
  layer on top. Gate on someone hitting the wall with a real reference cloud.
- **Video import** (extract frames at an interval/overlap heuristic) — cheap via
  `<video>` + canvas; opens the largest casual-user funnel.
- **16-bit / multi-band TIFF for detection**: `utils/tiff.js` transcodes to 8-bit for
  display+detect; scientific film scans may carry 16-bit dynamic range. Decide whether
  detect should read a 16-bit gray path before the display transcode. Gate on a real
  dataset that needs it.

**Dense tuning**
- Depth-map modal defaults for large film scans: `maxDim` conservative for ~10k-px
  scans; retune fusion `maxCost` once intrinsics are right.

**Infrastructure / hygiene**
- **I2 — persistence schema.** `schemaVersion` + migration on load; formalise the gcps
  `normalize()` backfill; a `ProjectStore` interface over `opfs.js` so storage is
  mockable; round-trip + migration tests; TS types for on-disk shapes.
- **I3 — bundle code-split.** Lazy-load Three.js/OpenLayers viewers + wasm (~1.3 MB
  main bundle; ORT makes this more pressing).
- **I4 — TS migration** of `core/` module-by-module (`io/` parsers first).
- **I5 — test debt**: more CRS cases (UTM south, antimeridian), matching unit tests.
- **Glossary figures**: the `<!-- TODO(image) -->` markers in `src/glossary/**` record
  wanted diagrams; grep them for the backlog.

---

## Parked / rejected
- **wasm threads (rayon + SharedArrayBuffer) for matching** — rejected 2026-07-04: the
  pair-level worker pool already saturates cores. (ORT wasm threads *are* enabled via
  the COOP/COEP headers — a different, already-landed mechanism.)
- **SIFT-GPU (WGSL detection kernel)** — parked 2026-07-17, revisit only with profiling
  that puts detection back on top. The COLMAP comparison doesn't transfer: (a) after
  the pyramid fix detection is ~3.1× faster and was already not the dominant stage,
  (b) WebGPU gives **one** device, so a GPU detector pins to a single worker like
  LightGlue does — versus a CPU pool detecting POOL_SIZE images concurrently, making
  the realistic *throughput* win ~1.5–2× (roughly a wash on an integrated GPU),
  (c) the WASM path must stay fast regardless as the no-WebGPU fallback, and (d) two
  backends producing subtly different 128-d descriptors feeding a ratio test is a
  correctness surface pure-CPU doesn't have — a per-image fallback would be actively
  wrong here; it'd have to be per-run. If detection does return to the top, **GPU
  brute-force matching is the better first target**: bigger share of wall-clock, and a
  far simpler kernel.
- **Global undo/redo command layer** — rejected. Per-entity delete/edit in the stores
  is enough (Metashape has none either).
- **Vocabulary-tree / global-descriptor image retrieval** — the scale-up path for
  candidate-pair selection with no poses/GPS. The shipped subset gate covers the same
  need below ~100–200 images without shipping/training a vocab tree, but still *tests*
  every pair. A retrieval stage drops the O(N²) pair count itself; revisit at 1000+
  images. The lighter build-now variant (aggregated SuperPoint descriptors, no vocab
  tree) is the matching-speed item above — adopt it there rather than duplicating the
  design here.
- **Snap-to-guide for GCP marking** — rejected on method grounds (METHODS.md §6.4).
- **Automatic sky segmentation for dense** — rejected; unsafe in Antarctica.
- **Multi-camera rigs, rolling-shutter model, Metashape-style chunks** — out of scope
  for the target workflows; record demand before designing.
