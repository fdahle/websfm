# WebSfM — methods & algorithms

The *science* companion to [ARCHITECTURE.md](../ARCHITECTURE.md). ARCHITECTURE says where
the code lives; this file says **which method each step uses, and why that one**: which
bundle adjustment, which distortion model, which P3P, how georeferencing is done. It names
the files and functions to read, but its content is the algorithms, conventions,
parameters and trade-offs.

When a method changes (a new solver, cost function or model), update its section here in
the same pull request. Measured results are in [BENCHMARKS.md](BENCHMARKS.md), the history
of each change in [CHANGELOG.md](../CHANGELOG.md), user-facing explanations in the in-app
guide (`src/guide/`) and glossary (`src/glossary/`). Parameters are named as in
`src/core/defaults.user.js` (user settings) and `src/core/tuning.js` (internal tuning).

---

## 0. Summary

WebSfM is an **incremental** Structure-from-Motion pipeline followed by **PatchMatch
multi-view stereo** and raster and mesh products (DEM, orthophoto, mesh), running entirely
in the browser, with the heavy maths in Rust compiled to WebAssembly. It is a from-scratch
implementation in the COLMAP tradition: SIFT features → ratio test and RANSAC-verified
matching → two-view seed → incremental PnP resection with interleaved bundle adjustment →
dense MVS → products. It was built for **historical aerial imagery over polar regions**, so
projected (non-WGS84) CRSs and scanned-film interior orientation are first-class.

## Conventions

- **Camera model**: pinhole, `x_cam = R·X_world + t`, `u = K·[R|t]·X`,
  `K = [[fx,0,cx],[0,fy,cy],[0,0,1]]`. Rotations are row-major, **camera centre
  `C = −Rᵀt`**. Projection matrices are stored flat as the 12 elements of `[R|t]`,
  **without K**.
- **Distortion**: Brown–Conrady (with decentring), rational, or Kannala–Brandt fisheye
  (§5). Everything before and after bundle adjustment (init, PnP, triangulation, filters,
  MVS, ortho) works on a **pinhole view** of the keypoints: the recorded pixels
  undistorted by the current lens. Bundle adjustment fits the recorded pixels with the
  whole lens, so self-calibration solves the lens itself (§4.6).
- **Normalised coordinates**: `x = (u − cx)/fx`, `y = (v − cy)/fy`. Distortion and the
  essential matrix live here.
- **Pixel centres** are at integers: the top-left pixel's centre is (0, 0), as in OpenCV.
  COLMAP, OpenSfM and transforms.json (nerfstudio, instant-ngp) put it at (0.5, 0.5), so
  their principal points, observations, keypoints and two-view F and H shift by half a
  pixel on import and export (`colmapModel.js` `COLMAP_PX`); Metashape's XML does the same
  (`metashapeXml.js`). GCP marks are clicked in pixel-edge coordinates and converted
  (`markToCentrePx`).
- **Units**: reprojection error in pixels; parallax and triangulation angles in degrees;
  GCP and CRS residuals in project CRS units.

---

## 1. Pipeline at a glance

```
images ─► [1] detect ─► keypoints + descriptors
              │
              ▼
       [2] match (pairwise) ─► ratio test + F-RANSAC + spread gate ─► verified pairs
              │
              ▼
       [3] sparse SfM (incremental)
              ├ two-view init (F→E or five-point E → pose, DLT triangulate, seed pick)
              ├ incremental resection (P3P + MSAC PnP, track extension)
              ├ interleaved + final bundle adjustment (LM + Schur + Huber)
              ├ retriangulation + split-track merge + track completion + 2-pass filter
              └ optional camera-position / GCP / reference-DEM constrained BA
              ▼
       [4] dense MVS (PatchMatch depth maps → cross-view filter → fusion)
              ▼
       [5] products (local vertical frame → DEM → orthophoto, mesh)  [+ georeference]
```

Stages 1–2 are parallel per image and per pair; stage 3 is sequential; stages 4–5 work per
image and are then fused or rasterised.

---

## 2. Feature detection

**Method**: SIFT (Lowe 2004), WebSfM's own Rust implementation in `crates/sift`:
Difference-of-Gaussians scale space, orientation assignment, 128-d gradient-histogram
descriptors, sub-pixel and sub-scale extremum refinement.

**Scale space.** Each octave holds `s+3` Gaussians at σ_i = σ0·k^i (σ0 = 1.6,
k = 2^(1/3), s = 3). The octave base already carries σ0 (octave 0 from blurring the input,
later octaves from halving the previous octave's 2σ0 level), so level 0 is not blurred
again and each later level adds only the increment σ_{i−1}·√(k²−1). The
`DETECT_SIFT_DEFAULTS` presets are calibrated against this pyramid.

**Orientation assignment** (Lowe §5): the parabola-interpolated maximum of a 36-bin,
Gaussian-weighted, smoothed gradient histogram. Other peaks reaching 80 % of it can become
extra keypoints, up to `DETECT_TUNING.siftMaxOrientations` per extremum; the default is
**1** (COLMAP's is 2), since a second orientation added +0.5 % ≥3-view points for ~20 % more
descriptors. Siblings count toward `maxKeypoints` and are **folded back onto the dominant
keypoint right after matching** (`core/features/orientationSiblings.js`; a feature matched
to two different features is dropped as ambiguous), so one point never splits into two
tracks.

**RootSIFT** (Arandjelović & Zisserman 2012; COLMAP's `L1_ROOT`): the crate emits classic
SIFT; WebSfM matches `sqrt(d / ‖d‖₁)`, whose Euclidean distance is the Hellinger kernel
between the histograms and damps the few dominant bins that make plain SIFT confuse similar
texture. It is still unit-L2, so every distance gate is unchanged. Stored L2 vectors are
converted on load (`core/features/siftDescriptors.js`, `descNorm` per image).

**Which keypoints survive the cap: coarse first** (COLMAP's rule;
`core/features/keypointCap.js`, `DETECT_TUNING.siftCapRule`). The largest scales are kept
first, with response as the tie-break inside the octave the cap cuts through. Ranking by
response alone fills the budget with fine texture (85 % of a response-ranked 25k set at
native size has σ < 4 px), which is the first to stop matching under viewpoint change.
COLMAP keeps whole octaves, so its limit is soft; WebSfM's stays an exact budget, because
brute-force matching is O(Na·Nb). The cap runs after masking and after the tile merge.

**Detection resolution** (`core/features/detectResolution.js`). *Fixed* reduces every image
to `maxDim` on the long side. *Scale with image size* takes a fraction of each image's own
long side, clamped to a per-preset band whose floor is the fixed value (SIFT Balanced:
0.4 × native, 2,400–4,000 px), and scales SIFT's keypoint cap with the detected area (up
to 4×). An object project at Balanced uses a close-range band instead: 0.66 × native,
2,400–4,000 px, with the keypoint cap as set. SIFT's default, *By project type*, is that
close-range rule in an object project and the fixed size elsewhere. Close-range evidence
(ETH3D, 6,048 px): at 2,400 px office registers 20 of 26 cameras and pipes 8 of 14, at
4,000 px every camera of all six scenes, at similar pose error (median: courtyard 6.7 →
7.5 mm, delivery_area 2.86 → 2.62 mm, pipes 3.9 → 1.6 mm); scaling the cap to
~28k changed the error within noise at 2–4× the matching time. Aerial evidence is mixed,
so aerial projects keep the fixed size: Iceland 1980 film scans gain (check points
1.97/2.46 → 1.45/1.96 m), a 42 MP drone block loses height (UseGeo 1, cameras V 6.1 →
9.6 cm), at 2.5× the time on the GPU and 3.8× on the CPU. The reprojection and RANSAC gates are in detection
pixels (`core/scaleContext.js`), so they follow whichever resolution ran.

**Other details:**
- **Duplicate-keypoint suppression** (`suppress_duplicate_positions`, response-weighted
  NMS): one strong blob can fire across adjacent scales and octaves as several keypoints
  within ~2 px. Left in, they cause many-to-one matches (§3) and poison BA.
- **Descriptor width is per detector**: 128 for SIFT, DISK and ALIKED, 256 for SuperPoint
  (ONNX via `onnxruntime-web`, `core/features/learnedDetectors.js`), carried as `descDim`.
- **Tiled detection** for large scans (`core/features/tiling.js`): an evenly spaced,
  overlapping grid with origins on the coarsest octave's sample grid. Each tile keeps only
  the keypoints in its own core; the cores (cut at each overlap's midpoint) partition the
  image, so every keypoint comes from exactly one tile, then a 2 px NMS runs across seams.
  Deduplicating the union instead leaves near-identical twins that the ratio test rejects
  in pairs.
- **Colour** is sampled per keypoint and median-aggregated per track for the sparse cloud.

**Alternatives**: the learned SuperPoint, DISK or ALIKED (better on low-texture and
repetitive scenes; not scale- or rotation-invariant; each needs its model), matched with
LightGlue.

---

## 3. Feature matching & geometric verification

**Pairing**: exhaustive by default. Alternatives: preselection by camera position
(`preselect.js`, the k nearest by horizontal distance, in a local azimuthal-equidistant
metre frame for a geographic project) when positions exist, or a capture-order window
(optionally wrapping end-to-start for a closed orbit).

**Descriptor matching** (`core/features/bruteforce.js`, or the learned `lightglue.js`):
mutual nearest neighbour (cross-check) and the **Lowe ratio test** `d1/d2 < ratio`, default
0.8 (COLMAP's value). Against 0.75 it gives more ≥3-view points at an unchanged error and
connects weakly overlapping blocks; verification removes the extra false matches.
LightGlue (Lindenberger et al. 2023) is an attention-based learned matcher.

**Geometric verification** (`core/features/verify.js`, both matcher paths) runs on the
recorded keypoints unless the image's sensor has a known lens (Brown, rational or fisheye):
then in its pinhole frame, the putatives undistorted with the K and lens SfM ingest uses
(`core/features/verifyFrame.js`), since a lens bends epipolar lines past the gate in the
outer ring of the frame. An unknown lens, the usual drone case, is verified as recorded.
1. **Fundamental-matrix RANSAC** (`verify_matches_hf`, normalised 8-point of Hartley 1997,
   in `crates/matching`) → inlier mask. Each new best sample gets a **local optimisation**:
   refit F on its inliers and recount, up to four rounds while the set changes, keeping a
   refit only if it explains at least as many points. Samples are drawn **best match
   first** (PROSAC, Chum & Matas 2005; the order is the descriptor distance, or LightGlue's
   confidence): from a small, growing set of the best matches, so a pair whose good matches
   are a minority finds a clean sample in about a hundred draws. It stops by PROSAC's rule
   (the best model's inliers among the n best points, against what a wrong model would
   gather by chance), after at least 100 draws, gives up after 1,000 when no model beats
   chance, and is capped at 10,000 (COLMAP's cap). A homography is also fitted, for an
   **H-vs-F** degeneracy signal. It is logged and flags the pair (`entry.degenerate`), but
   no gate reads it: seed selection (§4.2) guards against planar and low-parallax pairs by
   its parallax floor and the calibrated five-point solve instead.
   **MAGSAC++** (opt-in, `verifier: 'magsac'`, `crates/matching/src/magsac.rs`; Barath et
   al. 2020): the same samples scored by the σ-marginalised loss (σ uniform on
   [0, σ_max], ν = 4, cut-off 3.64 σ_max = the user's threshold) and polished by
   σ-consensus++ (up to four refits on the points within the cut-off, then IRLS with the
   marginalised weights over the squared gradient of the algebraic residual, so the
   weighted fit minimises the geometric residual). Inliers are still the points within the
   threshold. On real data it is within noise of RANSAC, so RANSAC stays the default.
2. **Inlier-ratio gate**: rejects spurious epipolar fits on repetitive structure (a low
   inlier/putative ratio even when the count looks fine).
3. **Positional-spread gate** (`inlierSpread`): rejects a pair whose inliers (a) collapse
   to few unique locations (several A-points matching one B-location: the duplicate-blob
   signature) or (b) pile into one small region (epipole degeneracy). Measured per image
   as unique rounded positions and bounding-box diagonal.

The decision is a pure function (`core/features/pairGate.js` `evaluatePairAcceptance`).
Its floors are decoupled so one knob cannot sever the graph: `minMatches` is the accept
and H-skip floor; a separate `rawSkipFloor` (≤ `minMatches`) gates the skip on raw
putatives.

**Weak pairs** (COLMAP-style): a valid F with `weakMinInliers` inliers but below the accept
gate is kept as `weak`, a **registration bridge only**: it feeds 2D–3D correspondences to
PnP (`register.js`) but never seeds initialisation or triangulation, so a low-overlap link
survives a raised `minMatches`. Positionally degenerate pairs stay rejected. A user can
exclude a pair (`setPairDisabled`).

**Subset gate** (`subsetGate.js`, brute force without positions): pre-match a small,
**spatially uniform** keypoint subset (`pickSpreadIndices` grid-buckets so a repetitive
façade does not collapse the sample onto its strong blobs) and skip the full O(Na·Nb) match
when too few survive. Coverage stays exhaustive (loop closures are still found) at a
fraction of the cost. Each image's sample is `fraction × N` of its keypoints (within a
floor and a ceiling), picked once per run and reused for all its pairs, so a real pair with
M matches shows `fraction²·M` putatives. Gated pairs get a second look on a larger sample:
every pair of an image left with fewer than six accepted pairs (4× the sample), and near
misses that reached half the threshold (2× the sample against a 2× threshold; a real
pair's count grows with the square of the sample, a chance count about linearly).

---

## 4. Sparse SfM — incremental reconstruction

Orchestrated in `core/sfm/sfm.js`; the numerical kernels are in `crates/reconstruction`.
Cameras are added one at a time (incremental, not global or hierarchical; Schönberger &
Frahm 2016).

**No pre-SfM pair filter.** Verified pairs go into SfM as they are. A rotation-cycle
(loop-consistency) filter was rejected because the pairwise rotations it tests, decomposed
from the matching-time F with a nominal K, are wrong too often on true pairs (§12). False
pairs are stopped downstream by the two-gate PnP (§4.3), the track filter (§4.9) and the
robust BA (§4.5).

**Retries and multiple models** (`core/sfm/multiModel.js`). A primary model that registers
less than half the input is retried with up to four alternate initial pairs, keeping the
largest result, so one locally clean but non-growing seed does not decide every later
model. The remaining coherent components of the match graph with at least eight images are
then reconstructed with up to twelve already-registered boundary cameras, and a 7-DOF
similarity is estimated from the overlap. A merge needs at least three shared cameras, low
centre-alignment RMS, agreeing camera rotations and focal lengths, compatible radial
self-calibration and a stable leave-one-camera-out scale. A secondary that fails is kept
as a separate sparse model; the gates are never relaxed to force it in. Secondary recovery
is skipped when every retry leaves fewer than 25 % registered: a tiny primary is no
trustworthy frame.

### 4.1 Intrinsics resolution

`resolveK` derives `K` per image from the fiducial-derived canonical K of a film sensor
(path 0, §5.1), a sensor calibration, EXIF focal length with sensor or film format, or a
scanner **pixel pitch** × format. A declared film or sensor format outranks a pitch: a
format comes off a calibration certificate, while a pitch is usually inferred from the
scanner setting and is the value that goes wrong (an off-standard implied film width is
logged against the standard 230/240 mm aerial format). With nothing known, a
**default-FOV guess** (`fx = image width`) is used and loudly warned, because wrong
intrinsics both distort geometry and stop cameras from registering.

A focal-only **pre-solve** corrects that guess right after registration. Every
self-calibration update passes a plausibility guard (`core/sfm/selfCalGuard.js`): one pass
may move the focal by at most 25 % and end at most 35 % from the nominal focal, which stops
thin-block runaways. A guessed focal is no measurement (a 153 mm lens on 230 mm film sits
33 % below the guess), so it gets wide bounds instead: 60 % per pass, within [0.3, 1.7] ×
the guess.

### 4.2 Two-view initialisation

`core/sfm/initPair.js`. The seed pair is the best single predictor of how the model grows,
so it is **not** simply the pair with most inliers. Up to `initCandidates` (24) pairs with
the most inliers are probed, each:
- `F → E` (`fundamentalToEssential`), and beside it a **five-point E under RANSAC**
  (Nistér 2004, `core/sfm/essential.js`; `initFivePoint`, on by default, 1.5 px) on the
  K-normalised matches, each of its solutions a candidate. On a near-planar scene the
  uncalibrated F is undetermined and its pose wrong; the calibrated problem has no planar
  degeneracy, but it has a **planar twin**: a second solution that explains the matches
  as well, moving along the plane's normal and tilting it. Two views cannot tell them
  apart, so outside evidence settles it, strongest first (`core/sfm/planarTwin.js`): the
  photos' attitude (omega/phi/kappa or gimbal angles give the ground's up in the camera
  frame; the twin whose plane normal agrees within 20°, every rival at least 10° further);
  a third photo's camera position (each twin places it by PnP against its own points, and
  only the true motion gives the centres the positions' shape); in an aerial project the
  more uniform depth, right when the photos look down. Otherwise the depth rule stands, the
  ambiguity is logged as open, and the first seed retry seeds the same pair with the other
  twin. The depth rule alone fails for a camera moving towards where it looks, pitched less
  than about 45° below the horizon over flat ground: there the twin is the flatter one.
- **pose recovery** by essential-matrix decomposition (`recoverPose`), resolving the
  4-fold ambiguity by cheirality;
- **DLT triangulation**, keeping points in front of both cameras;
- the **median triangulation angle** and the **init reprojection** error.

**Selection.** Among candidates clearing the parallax floor (`minInitAngleDeg`, 2°) the
highest score wins. If none of a batch clears it, the search widens to the next batch by
inlier count, up to `initCandidateMax` (240) probes, as COLMAP keeps searching until a pair
meets its constraints: the highest counts come from viewpoints that barely differ (a drone
hovering or turning on the spot). A pair already ruled out is skipped: if X and Y were each
probed within half the floor of a common image Z, X–Y lies below the floor (triangle
inequality on angles). Only when the budget is spent does selection fall back to the widest
baseline; a fallback below the track filter's floor (1.5°) is reported as unable to grow.

```
score = √cheiralKept × parallaxHealth(angle) × connectivityHealth × growthHealth / (1 + initReproj_median / 4)
```

- **Points enter as a square root**: twice the points is better conditioned, not twice as
  likely to grow the model.
- **`connectivityHealth`**: the pair's match-graph degree (the lower image's) over the
  median image's, clamped to `[initConnFloor, initConnCeil]` (0.4–2). In every measured run
  degree separated the good seed from the bad one; point count did not.
- **`growthHealth = max(1, readyViews)`**: a third image is ready when verified edges from
  either seed image observe at least `minMatchesForRegistration` distinct triangulated
  seed points in it. This proves the neighbours reuse the seed's tracks enough for PnP,
  which degree alone does not.
- **Parallax is a gate, not a ranking.** `parallaxHealth` is 1 between a soft band just
  above the floor (`minInitAngleDeg × initSoftFloorFactor`, 2.5°) and a grazing knee at
  `initAngleTargetDeg × 4` (32°), beyond which shrinking overlap is discounted. A ranked
  parallax term anchored at the floor turns small angle differences near the floor into
  large factors and picked seeds that grew a fraction of the model; sufficient
  triangulation angle is a threshold (COLMAP's stance).
- **Reprojection is a tie-breaker only**: it is measured before any self-calibration.

The essential-matrix conditioning σ2/σ1 (well below 1 ⇒ wrong focal) is logged, not scored.

### 4.3 Incremental resection (PnP)

`solve_pnp` in `crates/reconstruction/src/pose.rs`:
- **P3P after Lambda-Twist** (Persson & Nordberg 2018) as the minimal solver: depths along
  the bearing rays, then a rigid **Procrustes** fit to world. It follows the paper's
  formulation but solves every real root of the cubic and skips its Gauss–Newton
  refinement of λ; it is exact on noise-free data, and the pose is refined afterwards. The
  three points are centred and scaled to unit spread before the solve (and the pose mapped
  back), since its degeneracy tests are absolute: a frame scaled small would otherwise
  find no pose. An all-negative λ is negated, not
  discarded (each conic root's depth direction is sign-ambiguous), and the 3×3 SVD treats
  singular values as zero relative to the largest. Chosen over DLT resection because it is
  far more stable on the **near-planar** geometry of aerial and terrain scenes.
- **MSAC** scoring over the P3P hypotheses (Fischler & Bolles 1981, truncated cost).
- **Gauss–Newton** pose polish on the inliers.

**Correspondence hygiene** (`collectCorrespondences`): a 2D–3D correspondence is used only
when **bijective**. Many→one (ambiguous) and one→many (split track, repetitive structure)
are dropped, since the extras depress the inlier ratio and feed RANSAC contradictions.

**Acceptance: two gates.**
- The PnP inlier threshold `pnpThresh` is **fixed** for the run. An adaptive gate loosens
  exactly when the model is worst and admits poses that damage it further.
- **Gate 1**: an absolute floor (`minPnpInliers`) **and** an inlier fraction
  (`minPnpInlierRatio`); a 6/137 coincidence fit fails.
- **Gate 2 (refine, then recheck)**: after the polish, the fraction within the *tight*
  reprojection threshold must again pass (`minPnpRefineInlierRatio`). A pose that holds
  only at the loose gate is deferred, not accepted; later passes retry it against a model
  that interleaved BA has tightened.

**Order: next-best view** (COLMAP-style): by the count of correspondences to ≥2-view
points, weighted by their spread (4×4 grid occupancy: a tight cluster is ill-conditioned);
raw connectivity breaks ties. Correspondences are cached per pass for score and PnP.

**Stalled-model rescue (one shot, `rescueStalled`).** A sweep that registers nothing while
images still link to the model usually means a slightly wrong focal plus a structure gap,
or a **distortion deadlock at the seed** (a 2-view model absorbs radial distortion into its
points, and self-calibration starts only at `distortionCalMinCams` cameras). The rescue
runs a **focal-only** BA (skipped at two cameras, where no intrinsic is identifiable) and a
**retriangulation**, then retries the sweep once with the recheck relaxed to the PnP gate
(`rescueRefineRatio`). The cameras it admits carry the model past the self-calibration
threshold; Gate 1, the final BA and the track filter still apply.

**Self-calibration is refused below 3 cameras** in every pass: a 2-camera model returns
whatever k1 the noise prefers, and the keypoint view is derived from it.

### 4.4 Track management

A **track** is one 3D point seen in ≥2 images; a per-image `keypoint → point` index makes
extension O(1). A new camera's PnP inliers **extend existing tracks** instead of creating
duplicate 2-view points; only matches with neither keypoint on a track are triangulated.
A new point must clear the parallax floor **and** reproject within `filterMaxReprojPx` in
both images, as COLMAP's triangulator requires: a DLT on a wrong match can land 10⁵ px off
and break the next interim BA. `foldOneEndpointMatches` then adds observations where one
keypoint was already on a track (one round of track completion, §4.9).

### 4.5 Bundle adjustment

`crates/reconstruction/src/bundle.rs`. Sparse **Levenberg–Marquardt** with the **Schur
complement**, analytic Jacobians and **adaptive Huber** robustification (Triggs et al.
2000), dependency-free (no Ceres or g2o); the same family as COLMAP's BA.

- **Parameters**: each camera has `t` and a **left-perturbed so(3)** rotation update
  `R ← exp(δω)·R`; points are 3-DOF.
- **Schur complement**: points are eliminated, leaving a camera (+ intrinsics) system
  stored **block-sparse** (a 6×6 block per pair of cameras sharing a point), so memory
  grows with co-visibility, not cameras². Below 600 unknowns (~100 cameras) it is solved
  by dense Cholesky, above by a **sparse block Cholesky** (`sparse_chol.rs`). The Schur
  step is split over fixed contiguous camera ranges, so results are bit-identical on any
  thread count. Past 1 GiB of factor (`SPARSE_MAX_BYTES`) it falls back to **conjugate
  gradients with a block-Jacobi preconditioner**, inexact as Ceres' iterative Schur
  (10⁻⁶, ≤ 200 iterations).
- **Robust cost**: Huber with δ = 2.5 × median residual (re-derived each iteration,
  ≥ 1 px), as IRLS weight `w = min(1, δ/‖r‖)`; step acceptance evaluates the loss that
  weight descends, ρ = q·(2w − w²).
- **Damping**: λ × 0.3 on an accepted step, × 4 on a rejected one (10⁻⁹ … 10⁸). A rejected
  step is retried until one lowers the robust cost, λ reaches its cap, or the step falls
  below 10⁻⁸ of the model's size (Ceres' `parameter_tolerance`). A fixed retry count (8) would
  end hard problems after one iteration (BAL's large Ladybug sets); Ceres' ratio-driven
  damping (Nielsen) ended worse on them.
- **Stopping**: an accepted step lowering the cost by less than `functionTolerance` of that
  iteration's cost (10⁻⁶, Ceres' default; ≥ 10⁻⁵ with the sparse direct solve, 10⁻⁴ on
  re-solves of a converged model), no acceptable step, or the iteration cap. The
  comparison stays within one iteration, because δ changes between iterations.
- **Guard** (`core/sfm/baAcceptance.js`): a solve is judged on the objective it minimised,
  not plain RMS. When RMS rises, one Huber cost with δ fixed from the pre-solve residuals is
  evaluated before and after, and the solve is rejected only if that rose too. RMS is
  dominated by the gross outliers Huber down-weights, so it can rise while every inlier
  fits better. Each solve logs RMS before and after and a per-iteration trace.

**Checked against Ceres** on the 98 problems of Bundle Adjustment in the Large (Agarwal et
al. 2010; `scripts/bench/bal/`, `crates/reconstruction/examples/bal.rs`): the app's solver
policy and Ceres 2.2 minimise the same ½Σ‖r‖² from the same start. Results:
[BENCHMARKS.md](BENCHMARKS.md#bundle-adjustment-against-ceres-bal).

**Interleaved BA**: a global BA and track filter run as the model grows (COLMAP-style), so
later PnP registers against a tight model and the final BA starts near the optimum. Solves
are **spaced geometrically**: the next waits until the model has grown by
`interimBaGrowth` (2, doubled) since the last, like COLMAP's `ba_global_images_ratio`. Each
solve costs the whole model, so a fixed spacing makes registration quadratic in the image
count. Local BA between global solves (a new camera and its most co-visible neighbours
free) is available but off: it bought nothing measurable.

### 4.6 Self-calibration

Bundle adjustment can refine a **shared** set of intrinsics per **sensor group** (cameras
sharing a sensor id; unassigned cameras are their own group). The terms are a bitmask
(`bundle.rs` `refine_mask`: 1 = f, 2 = cxcy, 4 = k1, 8 = k2, 16 = k3, 32 = k4 (fisheye),
64 = rolling-shutter τ (§4.7), 128 = rig offsets (§4.8), 256 = p1, p2; JS `refineModeMask`
parses strings such as `'f,cxcy,p,k1,k2,k3'`):
- `f`: a focal **scale** (init 1, multiplies fx and fy), which keeps per-camera seed
  differences while sharing one DOF;
- `cxcy`: shared principal-point offsets;
- `k1,k2,k3` and `p` (Brown 1966, OpenCV convention): `x' = x·m + 2p1·xy + p2·(r² + 2x²)`,
  `y' = y·m + p1·(r² + 2y²) + 2p2·xy`, `m = 1 + k1·r² + k2·r⁴ + k3·r⁶`, `u = fx·x' + cx`,
  with exact analytic Jacobians (`distort_jac`, tested against central differences); a
  fisheye group's terms are its Kannala–Brandt k1–k4.

**On by default.** `refineIntrinsics: 'auto'` resolves per run (`sfm.js`): **staged** when
no sensor has a calibrated distortion model (EXIF-only cameras, film scans), `'none'` when a
calibrated lens is given. An explicit string overrides it and bypasses staging.

**Staged schedule** (`core/sfm/selfCalSchedule.js`): distortion is barely observable on a
thin model, so terms unlock as it grows. Registration (interim and rescue BA, once
`distortionCalMinCams` cameras are in) solves `f,k1`; the post-filter passes add `k2` at
≥ 8 cameras and 10k observations, principal point and decentring at ≥ 10 cameras, `k3` at
≥ 20 cameras and 30k observations. Never on the unfiltered model, where cx/cy drift. Results
are logged, never written to the sensor table automatically.

**How well the lens is fixed** (`bundle.rs` lens σ, solver slot 9). The solves that settle
the lens (the post-filter passes, and those held by camera positions, GCPs or a DEM) also
return each group's standard deviations: σ² = σ0²·(S⁻¹)ᵢᵢ, S the reduced camera system with
the points eliminated, assembled once more at the solution without damping (the last
accepted step's own S can carry a large λ), σ0² the final weighted cost over the
redundancy. So each σ is marginal over every pose and point. Without control S is singular
along the seven similarity directions, which move no lens term; the solve holds one camera
and the scale along one baseline, which leaves the lens marginals as they are. Unit tests
check the σ against the spread of the solved focal over 40 noise draws, and against a
dense numerical (JᵀWJ)⁻¹. It holds when each term is weighted by its noise: a tie
observation 1/f², with f the native size over the detection size (`baObservations.js`
`tieWeightOf`: a keypoint is measured in the detection raster, so its σ is one detection
pixel, f native pixels), a GCP mark 1/σ² of its pixel accuracy, camera positions and GCPs
1/σ² of their stated accuracies. Ties share f, so their own balance and the robust loss
(on raw pixels) do not depend on it; only the pull of the survey terms does. Weighting
ties as one native pixel had them count f² times what they measure: on Iceland's film scans
(f 4.8) GCP checkpoints V 2.46 → 1.02 m, on quarry with RTK cameras against RTK 10.4 / 5.4
→ 6.3 / 4.4 cm, with tie residuals unchanged. With every
optical axis parallel, a z-stretch of the scene with the focal scaled alike leaves every
image point in place: a nadir block fixes its focal only through camera positions, GCPs or
oblique photos, and its σ then says so. The log gives fx ± σ and what it means for heights
(`focalSigma.js`: σ_f / f of the distance from the cameras to the ground), the model keeps
it (`calibration.groups[].focalSigmaPx`) and the Quality Report shows it.

**The lens is solved, not folded** (`core/sfm/selfCalFold.js`). Ingest keeps every image's
keypoints and GCP marks as the lens recorded them (`ingest.js recordedByUuid`), and each
group carries one complete lens: the sensor's at the start (Brown k1–k3, p1, p2; fisheye
k1–k4; a rational lens, which the solver does not model, stays fixed). The keypoints the
pipeline reads are a **view**: the recorded pixels undistorted by the group's current lens
about the image's current K. Every BA fits the **recorded** pixels with the whole lens
(`bundleSession.js lensFrame`, `fullLens`), as COLMAP and Metashape do; an accepted solve
replaces the lens and re-derives each view, and `summary.selfCalDistortion` carries it to
dense and the exports (`displayFrame.js makeFrameModelResolver`).

**Decentring is a measured choice.** Under `auto`, the first solve that would free p1, p2
runs with and without them from the same start; they stay only when they lower the RMS by
`selfCalDecentringMinGain` (1 %, `bundleSession.js`). On a centred or already undistorted
lens they fit nothing and trade with the poses (worse heights); the size of the solved
decentring does not tell the cases apart, the RMS gain does. On a lens that needs them they
remove most of a GCP-free nadir block's dome
([BENCHMARKS](BENCHMARKS.md#drone-blocks-no-positions-in-the-solve)). Under **survey-grade
camera positions** (at least half the priors within `selfCalDecentringHeldSigma`, 0.1 m, on
every axis, and enough of them for a prior solve; `cameraPriors.js surveyGradePositions`)
p1, p2 stay without a trial. The positions hold the camera heights, and a decentring too
small to lower the RMS still trades with the focal and so with the ground height under
them: on an RTK-only block (GeoScan PUTI, 0.0 % RMS gain) keeping them gives Metashape's
p1, p2 and checkpoints V 9.2 → 7.8 cm; on an undistorted block with ±3/5 cm positions
(UseGeo) it is even. Positions at consumer-GNSS accuracy do not hold the block (kept there:
PUTI checkpoints H 9 → 45 cm), and GCPs alone do not either (film blocks even or slightly
worse), so both keep the trial.

### 4.7 Rolling shutter

`bundle.rs` `bundle_adjust_rs`, `core/sfm/rollingShutter.js`. A CMOS sensor without a
mechanical shutter reads its rows over the readout time τ. Following Vautherin et al.
(2016), the pose is taken at the principal row and row r is seen from C + τ·s·v,
s = (r − cy)/h, v the camera centre's velocity; the angular rate is taken as zero (a gimbal
holds the camera). In the solver the shift goes on the point,
x_cam = R·(X − τ·s·v) + t, with s from the **observed** row, so the pose and point
Jacobians keep their form and τ adds one column, −s·R·v.

Unlike Vautherin et al., who solve each image's velocities, WebSfM takes v from the
camera's neighbours and capture times (a least-squares line through the centres of up to
five photos in capture order, not across a pause over 8 s) and solves **one τ per camera
group** (refine bit 64) in the global solves, from 0; a common error in v is absorbed by τ.
Local and survey-constrained solves hold τ. A camera without a capture time or neighbour
is solved as global shutter; Add to the model forces it off. A global-shutter solve hides
the effect: every camera moves alike, so the row offsets become a consistent shear of the
block at sub-pixel residuals.

Every JS projection of a camera with `rs: { v, h, tau }` (`geometry.js projectPoint`)
follows the same model by a short fixed point on the row, and so does guided track
extension's window search, in JS and in the crate (`guidedExtension.js`, `guided.rs`,
the same four steps). **Products** use the principal
row's pose: the sample map (`displayFrame.js makeSampleMap`, option `rs`;
`rollingShutterPixel`) places each pixel's ray on the plane fitted to the photo's sparse
points and projects X_cam − τ·s·R·v, iterated on the row, before the lens and film
transform; a point ε of its depth off that plane lands off by ε times the shift. Shifts
under 0.01 px are ignored; the depth maps' reuse key includes the warp.

### 4.8 Multispectral rigs

`bundle.rs` `bundle_adjust_rig`, `core/sfm/rigModel.js`. A multispectral camera (MicaSense
RedEdge, Altum) has one lens per band, triggered together. Import reads each band image's
capture, band and lens offset from the XMP (`core/io/metadata.js bandMetadata`); each band
is its own sensor. MicaSense records the offset as `RigRelatives` (degrees,
R = Rx·Ry·Rz, band rays into the reference lens frame) and `RigTranslations` (mm). In the
solver's convention a reference-frame point x is R_o·x + t_o in the band frame,
R_o = Rᵀ·R_ref (`core/sensors/rig.js bandOffset`); on MicaSense's sample captures the
predicted band → green homography K_ref·R_oᵀ·K_band⁻¹ agrees with a SIFT homography to
about a pixel, where the inverse convention misses by tens.

**Matching** pairs the reference band across captures and every other band with its own
capture's reference image (`rigPairs`): tracks run through the reference band, and
blue-to-NIR matching across viewpoints is unreliable.

**Bundle adjustment** keeps one pose per capture: x_cam = R_o·(R_c·X + t_c) + t_o. With
refine bit 128 each band's offset rotation is refined (R_o = Exp(ω)·R_o⁰,
∂x_cam/∂ω = −[R_o·q]×) in the global solves only; the reference band has no ω, which fixes
the gauge. The lever arm t_o stays 0: over a nadir block a lever arm b at height H acts as a
rotation b/H, which ω absorbs (residual b·Δh/H²). Poses stay per image in the saved model,
so dense and the orthophoto are unchanged; a band photo that never registered (thermal)
takes its capture's pose through its band's offset. Prior and GCP solves keep the offsets
fixed; local solves free each camera until the next global solve.

### 4.9 Retriangulation, track completion and filtering

After BA settles: **retriangulate** pairs with the improved poses (`retriangulatePairs`,
parallax floor applied first), **merge split tracks** (`mergeSplitTracks`), and run a
**2-pass track filter** removing observations and points with reprojection error above
`filterMaxReprojPx` or triangulation angle below `filterMinTriAngleDeg`. BA runs again after
filtering.

**Track completion** (`completeTracks`, COLMAP's *CompleteTracks*). A verified match with
one keypoint on a point and the other free adds the free keypoint to that point when it
reprojects within `filterMaxReprojPx` and the point has no observation in that image yet.
During registration one round runs after each sweep and interim BA; after registration it
runs **to a fixpoint** (A↔C can enable C↔D) after the retriangulation and merge and before
each filter pass, against the final poses and self-calibrated keypoints.

**Projection-guided track extension** (`core/sfm/guidedExtension.js`; no COLMAP
equivalent). Completion can only use matches that exist, and the global ratio test fails a
feature with a near-twin elsewhere on a repetitive façade. Once poses exist, that ambiguity
is gone. Before the tight filter pass, every point is projected into each registered camera
that does not observe it; unused keypoints within the search radius are compared by
descriptor (RootSIFT) with up to three of the point's observations, and accepted when
closer than the 0.9 quantile of distances within this run's own ≥3-view tracks **and**
better than the runner-up by ratio 0.8. Proposals are resolved greedily, best first (one
keypoint per point, one point per keypoint per image), then filtered and adjusted like any
observation. The search runs per camera on the threaded crate
(`crates/reconstruction/src/guided.rs`, same arithmetic as the JS fallback). The radius is
the filter gate capped at 3 × the model's p90 residual: on a coarse detection scale the
native-pixel gate is far wider than what the model resolves.

**Two-view points at output**: they are kept while the incremental solve needs them, but
omitted from the final model when it has a healthy core of ≥3-view tracks. This removes
false matches that slide along an epipolar line, which reproject well in two images but
have no independent confirmation of depth. Tiny or genuinely two-camera models keep them.

### 4.10 Adding images to a saved model

`core/sfm/extendModel.js`. Sparse Reconstruction ▸ *Add to the model* starts the
incremental pipeline from the saved model instead of a seed pair, and registers and refines
(§4.3–4.9) only the images it lacks.

- **The same pinhole frame.** The saved model keeps the solved lens and film transforms
  (`summary.selfCalDistortion`, `fiducialTransforms`); every image is mapped into that
  frame (`displayFrame.js makeScanCentreToPinhole`) about its group's solved K, so a new
  image on a known lens lands where a depth map of it would. The model also stores each
  observation's BA-frame pixel: the old images' rebuilt keypoints are compared with those
  and then take them exactly. A median gap above `SFM_TUNING.extendFrameMaxMedianPx`
  (0.5 px) means the features were detected again and are not the model's, and the run
  stops.
- **Fixed cameras.** Self-calibration is off, and every BA holds the model's cameras fixed
  (`bundle.rs fixed_cam`) and takes only the points a new camera sees: a local adjustment
  whose cost grows with the extension, not the model. Camera-prior and GCP solves do not
  run; the fixed cameras already carry them. *Existing cameras ▸ Refined* then runs
  Optimize cameras (§4.11) over the grown model, which outdates what was built from it.

### 4.11 Sparse cleanup and Optimize cameras

**Gradual selection** removes points by reprojection RMS, track length or maximum ray
angle, then runs a fixed-intrinsics BA on the survivors. A disconnected graph, an
under-supported camera or a missing observation rejects the operation before commit.
Calibration transforms survive; derived geometry and the georeference are invalidated.

**Optimize cameras** (Metashape's *Optimize Cameras*) is the same re-solve without the
deletion, freeing the focal length or the focal length and principal point per sensor
(`OPTIMIZE_CAMERAS_DEFAULTS.refine`); the lens terms stay as the sparse run solved them.
Both re-solves keep the GCP anchors and camera priors of the original solve (§6.4, through
`core/sfm/surveyConstraints.js`), its tie weight (one detection pixel, `tieWeightOf` with the
run's `detectScaleFactor`) and its acceptance rule: an unconstrained solve may not
raise the reprojection cost, a constrained one may within the survey allowance. Without
the constraints a re-solve would pass its own gate while undoing a GCP doming correction. A
focal change over 20 % is refused as a runaway, which a cost gate cannot see (the cost can
fall while f doubles).

---

### 4.12 Merging another project's model

`core/sfm/modelMerge.js`. Import ▸ WebSfM Project ▸ *Its model: Merge into this model*
places another project's solved model (B) in this one's frame (A) and joins them, as
Metashape's Align Chunks and Merge Chunks do; the blocks need not overlap.

- **Points known in both frames.** Every way of placing B gives pairs of points (B's
  frame, A's frame) and one 7-DOF similarity (`georef.js fitSimilarity`) is fitted through
  them. *Photos in both*: each photo both models solved gives its camera centre, and two
  points one span of the shared centres along its viewing and sideways axes. Shared photos
  along one flight line have nearly collinear centres, which leave the roll about the line
  to rounding; their directions fix it. *GCPs and markers*: each one of the same name
  triangulated in both models (§6.2), each from its marks through its own model's lens;
  surveyed coordinates are not needed. *Georeference*: B's camera centres taken through
  B's georeference into B's CRS, converted to A's CRS (proj4, horizontal only; heights pass
  as they are), and through the inverse of A's georeference into A's frame. *Auto* tries
  them in that order and takes the first accepted.
- **Gates.** At least three photos or GCPs; the position RMS of the fit at most 2 % of the
  span of the common points; the leave-one-out scale spread at most 5 %; for shared photos
  the camera rotations must agree (median ≤ 3°, worst ≤ 8°), the same gates as a secondary
  model (§4). A refused merge leaves the imported photos without B's cameras.
- **The merge.** A's cameras win on a photo both hold. B's cameras and points are moved by
  the similarity (a rolling-shutter camera's velocity turns and scales with them). B's
  tracks lose their views on shared photos (they number B's keypoints, and A keeps its
  own) and points left with one view go. Each B camera keeps B's solved lens as its own
  calibration group, which the frame resolver takes before the sensor's
  (`displayFrame.js`). Nothing is re-adjusted: each block keeps its shape. The merged model
  is a new sparse model and becomes the main one; the georeference is fitted again on it.
  *Optimize cameras* (§4.11) then adjusts the two blocks together.

## 5. Camera model & lens distortion

`core/sfm/distortion.js`. **Brown–Conrady** (radial `k1,k2,k3`, tangential `p1,p2`) by
default: `x_d = x·(1 + k1·r² + k2·r⁴ + k3·r⁶) + [2·p1·xy + p2·(r²+2x²)]` and the symmetric
`y_d`, in normalised coordinates. The inverse is **Newton's method on the exact forward
model** with backtracking, to a tolerance; OpenCV's fixed count of fixed-point steps is
off by pixels at the corners of a strongly distorted wide frame. Where the forward curve
r·(1 + k1r² + …) turns back before the observed corner radius no inverse exists, and the
self-calibration guard rejects such a lens (`radial-fold`).

**Models** (`DISTORTION_MODELS`, per sensor): `pinhole` · `radial` (k1) · `radial2`
(k1, k2) · `brown` (k1–k3, p1, p2) · `rational` (OpenCV's k1–k6, p1, p2, radial factor
`(1 + k1r² + k2r⁴ + k3r⁶) / (1 + k4r² + k5r⁴ + k6r⁶)`) · `fisheye1` / `fisheye2` /
`fisheye` (Kannala–Brandt with one, two or four terms, as COLMAP's `SIMPLE_RADIAL_FISHEYE`,
`RADIAL_FISHEYE`, `OPENCV_FISHEYE`). `distortionOf` applies only the active model's
coefficients, so a stale k3 cannot leak; a sensor with no model set uses all five Brown
terms.

**A pinhole view of the recorded pixels** (the load-bearing design choice): the pipeline
reads each image's keypoints undistorted by its group's current lens (`undistortPixel`), so
F/E, PnP, triangulation and the filters are pinhole, while BA fits the recorded pixels with
the full lens (§4.6). Dense and ortho rasters are resampled through an
undistorted → distorted sample map (`distortNormalized`, closed-form forward), so
PatchMatch, DEM and ortho are pinhole too. The F from matching is fitted on still-distorted
keypoints when no calibration is known; the init pair also tries a five-point E (§4.2), and
self-calibrating BA corrects the rest.

**Fisheye** (Kannala & Brandt 2006): `θ = atan r`,
`θd = θ·(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸)`, the image point at `θd/r` times the normalised
ray. Keypoints still get a pinhole view for verification, PnP and triangulation, but a ray
more than 75° off-axis has no useful pinhole image and is dropped there
(`FISHEYE_MAX_RAY_DEG`). BA solves a fisheye camera in its recorded pixels
(`crates/reconstruction` `lens_factor`), refining k1–k3, then k4 last in Auto (solved again
without k4 if it would fold the curve back). An uncalibrated fisheye starts as the bare
equidistant projection. Depth maps use the field up to 60° off-axis
(`FISHEYE_DENSE_MAX_DEG`). Results: [BENCHMARKS](BENCHMARKS.md#fisheye-fiord-meetingroom-200-lens).

### 5.1 Interior orientation for film scans

`core/sfm/fiducials.js`. Scanned film has **scan geometry ≠ camera geometry**: each scan
places the frame differently (translation, rotation, slight scale and shear), so principal
point and pixel pitch are otherwise guesses. A metric film camera exposes **fiducial
marks** (4 or 8) whose positions the calibration certificate gives in millimetres in the
camera frame, with the calibrated focal length and principal point.

A sensor is declared `kind: 'film'`. `image.fiducialDetections` (anonymous raster slots
and scan-pixel centres) is kept apart from `sensor.fiducialCalibration` (slot-to-mark
identity, metric coordinates, focal length, principal point), so detection can be run and
reviewed before a certificate is available. At SfM ingest, and only there, the two are
joined into point pairs, and:

1. **A per-image transform** `scan px → camera mm` is fitted by least squares
   (`fitFiducialTransform`): conformal, affine (default) or projective. It yields pixel
   pitch and the RMS residual (µm); affine also reports rotation and shear. Conformal fits
   the proper and the reflected similarity and keeps the closer, so a y-up certificate
   (below) fits it as well as the affine.
2. **One canonical pixel frame per sensor** (`canonicalFrame`): a virtual grid at the
   median fitted pitch, `fx = fy = focalMm / pitch`, principal point mapped into it, so all
   images of the sensor share **one K** (`resolveK` path 0).
3. **Keypoints move** `scan → mm → canonical px` (`scanToCanonical`), indices preserved;
   GCP marks go through the same map.

Scan geometry is **removed once at ingest**; the dense stage reuses the recorded transform
(never re-fits) and composes `canonicalToScan` into its sample map.

- **Axis orientation**: certificates give fiducial coordinates y-up while scan rows run
  down, so scan → mm is a reflection (det < 0). Mapping mm-y straight to canonical y would
  make a mirrored, left-handed camera that no proper similarity can georeference, so when
  a sensor's fits are reflections the canonical frame flips y (`ySign: −1`). A frame
  without `ySign` keeps the plain mapping.
- **Distortion order**: the certificate's radial distortion is defined in camera mm about
  the principal point: `scan px →(affine)→ mm →(lens undistort)→ ideal mm → canonical px`.
  The canonical frame is a scale and offset of mm, so the Brown `undistortPixel` in
  canonical px with the canonical K is identical. Fitting k1/k2 from a certificate's
  distortion table is not implemented.
- **Residuals**: a fit RMS above about half a pixel pitch flags mis-clicked marks.

### 5.2 Fiducial detection and calibration

**Detect Fiducials** (`core/sfm/fiducialDetection.js`) is an image measurement and reads
no certificate. The user declares only image priors: mark type (Generic, Right angle, 45°
cut, Frame), corner, side or combined positions, polarity and tolerance. A coarse
grayscale pass finds the film bounds and searches the anonymous slots; accepted peaks are
refined in native-resolution crops within ±3 coarse pixels, with the coarse winner's
prototype and polarity (`nativeRefinePlan`), since the coarse peak is already sub-pixel.
Frame mode measures the frame corners and is not a substitute for real fiducials.

Two independent checks demote suspect marks to review (never delete):
- **Batch consensus**: each slot against the rest of the flight in frame-relative
  coordinates (raster-relative when a frame is missing or weak).
- **Opposite-pair shape gate** (`fiducialShapeCheck`, needs no batch): a camera's
  fiducials are centrally symmetric and an affine scan preserves midpoints, so the
  midpoints of opposite marks must coincide (to 0.2 % of the mark extent). With ≥ 3 pairs
  the pair off the median centre is named; with 2 disagreeing pairs both go to review.

Confident candidates are saved as `fiducialDetections`; uncertain ones stay drafts until
accepted or rejected. A confident frame may also yield a mask for the scanner background.

**Template retry** (`core/sfm/fiducialDetect.js`): scans left incomplete are retried with
**real scan patches**. A template is cut around each slot's strongest mark that passes both
checks (the donor) and matched coarse to fine around the slot's batch-median position,
with a sub-pixel parabola fit to the ZNCC peak. ZNCC, because scans of one batch differ in
exposure and development density, an affine intensity change it is invariant to. A 90°
rotation probe exists but is disabled in the retry: under a symmetric layout every rotation
aligns every mark with some real mark, so it is rarely decidable; per-scan rotation and
mirroring detection is open.

**Calibrate Fiducials** (`core/sfm/fiducialCalibration.js`) maps slots to named certificate
marks, or estimates a robust centred layout from the batch with a declared scan pitch for
scale; both validate per-image fits and need a calibrated focal length. Uncalibrated
detections do not affect reconstruction.

---

## 6. Ground control points & georeferencing

GCPs play two roles: a **post-hoc similarity fit** that places the model in a CRS (§6.3),
and **constraints inside bundle adjustment** that correct its shape (§6.4).

### 6.1 A GCP's shape

Surveyed `x/y/z` with per-axis 1σ accuracy, optional XY/XZ/YZ correlations, accuracy
provenance and vertical datum; pixel `observations` `[{imageId, px, py, accuracyX,
accuracyY}]` with per-observation 1σ; an `enabled` flag; and a `role`:
- enabled **controls** enter the similarity fit and anchored BA;
- enabled **checkpoints** are triangulated and reported against the fit but never
  constrain it, so their CRS RMSE is independent accuracy;
- disabled points enter neither. A point with < 2 marks is unusable (flagged).

Delimited-file import accepts per-row X/Y/Z or horizontal accuracy, correlations and pixel
accuracy; import-wide presets cover 1σ, 2σ, 95 % per axis, HRMS/VRMS and CEP95, in metres,
source-CRS or project-CRS units. Unknown uncertainty excludes a point from control but
keeps it for marking and reporting. A CRS change propagates the full covariance through
the local transform Jacobian and rescales Z between units.

### 6.2 GCP triangulation

`core/sfm/gcpTriangulation.js` places a GCP's marks in the current SfM frame for the
georeference fit (§6.3), the accuracy report, the anchored-BA targets (§6.4), the marking
guides (§6.6) and target detection (§6.7). Every mark is first mapped through its image's
chain (scan → canonical, then the group's solved lens removed; `displayFrame.js`
`makeScanToPinhole`), since marks are clicked on the raw photo. Camera poses are fixed;
only the point moves.

- **Seed**: two-view DLT on the widest-baseline pair (camera-centre distance, a parallax
  proxy before the point is known), the same WASM routine as SfM.
- **Refinement**: Gauss–Newton on the summed reprojection error over **every** mark
  (plain JS: a handful of points), `∂u/∂X = (fx/z_c)·(R₀ − (x_c/z_c)·R₂)`,
  `∂v/∂X = (fy/z_c)·(R₁ − (y_c/z_c)·R₂)`. This is what makes a third to Nth mark count.

**Robust mode** rejects marks in two stages, and the order is the method:
1. an **IRLS fit under Huber** (δ = 2 px, `w = min(1, δ/|r|)`), so a wild mark pulls with
   bounded force;
2. a **median cut** on that fit's residuals: drop views beyond `max(3 × median, 25 px)`,
   only while ≥ 2 marks survive.

Least squares has a breakdown point of zero: an outlier drags the point until its own
residual looks ordinary, so a median cut on that fit rejects nothing. The Huber fit
separates the residuals first. The 25 px floor (`SFM_TUNING.gcpRobustFloorPx`) keeps a
clean set (median ≈ 0) from losing honest marks to noise: the cut is for misclicks, so the
floor is a misclick's size, not a marking accuracy. The **final fit is plain least squares over the
survivors**. Rejected marks are still reported (`perViewReprojPx`, the guide's
`rejectedCount`), and rejection is scoped to that one prediction: the UI says "7 of 9
marks", not "2 ignored".

**Who uses which.** The georeference fit, the accuracy report and anchored BA use **plain**
mode: every placed mark reaches them, because dropping one would hide exactly the
disagreement the report exists to show. The guides (§6.6) and target detection (§6.7) use
**robust** mode: aids that must stay useful, so one misclick must not drag the prediction
in every other image.

### 6.3 Post-hoc similarity fit

`core/products/georef.js`. The SfM frame has a 7-DOF gauge (scale, rotation,
translation). Products in a real CRS come from a **7-parameter similarity**
`dst ≈ s·R·src + t` by **Horn's closed-form absolute orientation** (Horn 1987: the top
eigenvector of the 4×4 `N` built from the cross-covariance; no SVD dependency). When GCPs
carry anisotropic covariance, all seven parameters are then refined against the full
Mahalanobis objective.

Correspondences are **triangulated GCPs ↔ surveyed coordinates** when ≥ 3 GCPs
triangulate (preferred: GCPs define accuracy), else **camera centres ↔ camera positions**.
A sensor with a GNSS lever arm (§6.4) gives antenna positions, so its cameras pair as the
antenna points `C + Rᵀ·a / s`: fitted first with the centres, then twice more at the latest
scale `s`. The DEM-held placement's RMS and Evaluate ▸ Pose Residuals compare the same points.
Positions along one line pass the collinearity test on their noise alone while the roll
about the line stays arbitrary, so the fit reports it: `σ_roll ≈ σ/√(n·λ₂)`, σ the per-axis
residual and λ₂ the second eigenvalue of the targets' covariance (`georef.js`
`rollAboutStrip`). For a strip-like layout (λ₂ < 0.1·λ₁) above 1°, each camera adds a point
one span along its viewing axis in both frames: from its omega/phi/kappa, or straight down
in an aerial project. Without either the fit is refused. The bundle adjustment's prior
frame (§6.4) does the same from omega/phi/kappa.
A model held to a reference DEM by its camera positions is not fitted: it is placed in the
frame of the hold's last round, moved in height between the cameras and the DEM (§6.5).
`gcpAccuracyReport()` gives the per-GCP CRS residual and per-mark reprojection error.

**Camera positions** come from imported pose files (preferred) or EXIF GPS, transformed
into the project CRS at ingest; without altitude they serve the map and preselection only.
EXIF altitude has an unknown datum and a conservative default accuracy unless vendor RTK
fields (DJI `RtkStdLon`/`RtkStdLat`/`RtkStdHgt`) give one. Drone XMP gimbal yaw/pitch/roll
is converted to omega/phi/kappa (never the airframe's attitude); true-north attitude and
RTK sigmas are rotated into the grid including meridian convergence, from canonical ENU
values kept so a CRS change does not accumulate error.

**The fit is done in a local metric frame, not in grid coordinates**
(`core/products/localFrame.js`, `georef.js` `fitGeoreference`). A similarity assumes both
sides are Cartesian. Grid E/N carry the projection's point scale factor k (0.973–0.980 near
the pole in EPSG:3031) while heights do not, and the grid ignores Earth curvature, so a
fit to grid + height leaves metres of model error over a few kilometres that perfect
control cannot remove, and compresses relief by k. A conformal projection is locally a
similarity, so the frame divides out k about the targets' centroid, corrects k's variation
to second order (fixed by ∇log k for a conformal map), places a point h above its foot at
ζ·(1 + h/R) along the tilted normal and restores the curvature drop |ζ|²/2R. The
conformal part of the residual is third order (~10 µm over 10 km at 85°S); with relief,
the height terms leave millimetres against true ENU (RMS 0.4 mm over ±5 km and ±500 m of
relief at 80°S, 7 mm over ±10 km and ±1,000 m in UTM, 24 mm over ±20 km and ±1,500 m). The similarity carries the frame (`sim.local`)
and every consumer maps through it back to the grid; GCP precision scales by 1/k
horizontally. Without a projected CRS the fit is the plain grid fit.

### 6.4 Camera positions and GCPs inside bundle adjustment

**Camera-position priors.** After sparse SfM the centres are Horn-fit to the positions, and
the inverse maps each position into the SfM frame. The solver adds `C − target`
(`C = −Rᵀt`, Jacobian `[−Rᵀ | −Rᵀ[t]×]`), weighted by the positions' inverse variances.
Those are per survey axis (E, N, Up); the solver gets them as a full precision matrix in
SfM axes, `s²·Rᵀ·diag(1/σ²)·R` (the fit `dst = s·R·src + t`), so an RTK block's loose
height stays vertical whatever pair seeded the model. Two rounds let
the fit settle; a bounded reprojection-increase guard rejects what noisy positions would
buy at the images' expense.

- **Intrinsics are re-estimated** with the terms of the last post-filter pass
  (`cameraPriorRefineIntrinsics: 'auto'`; an accepted solve replaces the lens, §4.6). A
  nadir block measured from its own images has a focal–flying-height correlation, and its
  distortion error bends it into a dome; the positions cannot remove that without changing
  f and k. With loose positions (consumer GNSS, the 5 m import default) the weight is small
  and the intrinsics stay where self-calibration put them.
- **GNSS lever arm**: the priors are antenna positions, a lever arm `a` (camera axes, per
  sensor) from the centre. The antenna is at `C + Rᵀ·a`, so the similarity is fitted to the
  antenna points and each target moved back by `Rᵀ·a / s` (`core/sfm/surveyConstraints.js`,
  rebuilt every round). Without it, self-calibration absorbs the offset into the principal
  point.
- **Survey frame** (`cameraPriors.js` `surveyFrameFor`): GCP anchors and camera priors
  share one frame, the §6.3 local metric frame for a projected CRS or a survey-centred
  azimuthal-equidistant metre frame for a geographic one, used only in the adjustment. With
  GCP anchors, their similarity defines the target frame for both.
- **Orientation priors**: a complete omega/phi/kappa (imported or from XMP) constrains the
  same passes. The angles follow Metashape and Pix4D: R = Rx(ω)·Ry(φ)·Rz(κ) turns the
  photogrammetric image frame (x right, y up, axis −z) onto the ground, so its columns are
  the photo axes in project coordinates. Rᵀ is converted to the solver's camera frame
  (x right, y down, axis +z) and composed with the SfM → project rotation. The residual is
  the wrapped rotation vector `Log(R R_targetᵀ)`, with per-axis 1σ turned into a full
  tangent-space precision matrix. Incomplete orientations act as position priors only.

**GCP anchors.** `bundle_adjust` accepts an **anchor residual** `δᵀPδ` on chosen 3D points
with the full GCP precision matrix `P` (CRS covariance rotated and scaled into the SfM
frame). Each anchored GCP is an extra 3D point with its real marks, pulled toward its CRS
position mapped into the SfM frame by the current similarity. The anchor touches only that
point's 3×3 Schur block, so it is free to add. `runGcpAnchoredBundleAdjust` runs
*triangulate → Horn fit → inverse-transform targets → anchored BA* twice, against a poor
seed fit. The **final** georeference for products is a fresh post-hoc fit (§6.3);
anchoring only has to be good enough to correct the shape.

The constraint builders (`core/sfm/surveyConstraints.js`) also serve §4.11.

### 6.5 Holding the block to a reference DEM

`core/sfm/demAnchors.js`, `bundleSession.js` `runDemAnchoredBundleAdjust`. Georeference ▸
**Hold to a reference DEM** adds one survey-constrained pass after the camera-prior and GCP
passes. A block held only by loose positions or a few GCPs keeps the
focal–distortion–curvature correlation of §6.4 and can dome by metres at small residuals.
A reference DEM (lidar, Copernicus, SRTM) is wrong locally by metres but not bent, so many
weak height observations from it constrain exactly that low-frequency mode.

- **Anchors**: every live tie point with ≥ 3 views is mapped into the survey frame (through
  the GCPs' similarity when ≥ 3 triangulate, else the camera positions'), sampled on the
  reference, and kept on stable ground. Height differences beyond max(4·NMAD, 3σ) from the
  median are left out (buildings missing from the DEM, moved ice, blunders); at most 4,000
  are kept, one per grid cell. σ is at least the NMAD of the differences about their
  least-squares quadratic surface: a DEM that disagrees by metres locally (cliffs at its
  cell size, trees, changed ground) is not held at a declared ±2 m, while the smooth part
  (the bend being removed) does not count. Each becomes a GCP-style anchor on a real point, with target
  = the point moved vertically onto the DEM and a **rank-one precision**
  `P = u uᵀ / (σ·ℓ)²` (`u` the survey vertical in the SfM frame, `ℓ` the SfM length of one
  survey unit): held in height, free horizontally, which a coarse DEM cannot judge. The
  frame's own GCP anchors and camera priors stay in the solve; without them the frame
  drifts in scale between rounds.
- **Rounds**: two, the anchors rebuilt in between (a point that moved sideways meets the
  DEM elsewhere), each with the last pass's self-calibration mode. Fixed intrinsics cannot
  undo the bend.
- **Sampling**: the worker receives the reference once as a height grid in the survey frame
  (`core/sfm/demHoldGrid.js`, ≤ 400 × 400 over the cameras and GCPs grown by half the
  block, NaN off stable ground), in the vertical datum of the control, sampled bilinearly.
- **Placement**: with ≥ 3 GCPs the model is refitted to them afterwards (§6.3), as they
  are accurate. With camera positions alone a refit would undo the hold's height: the
  cheapest way for the solve to meet the DEM is often to move the whole block against
  loose positions (drone GPS), and a fit to those positions lifts it back. So each round
  fits the frame to the cameras (an outer iteration that also pulls a badly guessed focal
  in), and the model is placed in the last round's frame (`summary.demHold.sim`, kept on
  the cloud as `heldFrame`, georeference method `dem-hold`). A rigid vertical shift of the
  block changes no image residual, and at a DEM's σ of metres the anchors and positions
  are ~10⁻⁴ of the cost, so the iterative solve leaves that direction where it starts;
  the frame is moved by its least-squares value instead,
  `d = (W_dem·median(dz) + Σ wᵢcᵢ) / (W_dem + Σ wᵢ)`, cᵢ each camera's height above its
  position and W, w the inverse vertical variances.
- **Datums**: the DEM sets the height only when its heights and the control's are in one
  known datum (converted, or the same ellipsoidal or global-geoid datum). Otherwise each
  target is the DEM plus the median difference (`demAnchors` `relative`), so the hold keeps
  the shape and the control alone places the model: undeclared EXIF heights 52 m from
  EGM2008 (ellipsoidal plus a 3 m shift) had pulled a 346-photo block 45 m and shrunk it 6 %.
  Measured on a 444-photo RTK block with its positions loosened to ±1.3/1.8 m and the
  Copernicus GLO-30 tile (σ 2 m): checkpoint heights in the app's georeference
  101.6 → 17.3 cm RMS (mean +100 → −11 cm); σ 0.5 m bends the shape more (29 cm). On a
  quarry (346 photos, heights shifted +3 m) the camera heights went +3.00 → +1.68 m:
  Copernicus lies ~1.4 m above that ground and disagrees with the tie points by NMAD
  6.2 m (cliffs, an active pit), and holding it at ±2 m worsened the shape (V 13.4 → 16.8
  cm). With σ at its local scatter (5.6 m) the shape stays (13.4 cm) and the heights go
  +3.00 → +2.37 m; PUTI (scatter 0.3 m) is unchanged.

### 6.6 Guided marking

`core/sfm/gcpGuides.js`. Once cameras are posed, the existing marks constrain where the
next one can be, so **epipolar geometry** aims the user (like Metashape's guided marker
placement). For a target image and a GCP marked on other **registered** images:

- **One other mark** → its **epipolar line**. With `R_rel = R_B·R_Aᵀ`,
  `t_rel = t_B − R_rel·t_A`, `E = [t_rel]ₓ·R_rel`, `F = K_B⁻ᵀ·E·K_A⁻¹`, the line is
  `l = F·x_A`, normalised so `a² + b² = 1` (a true pixel distance). A zero-baseline pair is
  rejected; with several candidates the widest-baseline source is used.
- **Two or more** → the GCP triangulates (§6.2, robust) and reprojects to one predicted
  pixel. A point behind the target camera falls back to the epipolar line.

Every placed mark sharpens the guide in the images still unmarked. Guides are drawn for
GCPs not yet marked on the image (a marked one shows its reprojection error), and they come
back to raw pixels through `makeCanonicalToScan`: a point maps exactly; an epipolar line is
straight only in the pinhole frame and is drawn as the chord through two mapped points.

**The guide is never applied to the mark** (no snap-to-guide, by design). A guide is
derived from the reconstruction; snapping would feed the model's own estimate back as
ground truth. Anchored BA and the similarity fit assume marks measure the *world*, and the
gap between the guide and the click is the most useful signal precisely when the
reconstruction is wrong.

### 6.7 Detecting GCP targets

Tools ▸ Images ▸ Detect targets (`core/sfm/targetDetect.js`, `tagDetect.js`).

**Checker mats** carry no identity, so they are searched only where a GCP is expected
(triangulated from ≥ 2 marks, §6.2 robust, or placed from its coordinates through the
inverse georeference), projected into each registered photo and through the lens to raw
pixels. The detector keeps maxima of the saddle response (−det of the Hessian) whose four
quadrants alternate dark and light at the expected half-size (from mat size, depth and
focal length), and refines the best like OpenCV's `cornerSubPix`. Score: quadrant contrast.

**AprilTags** (tag36h11; Olson 2011, Wang & Olson 2016) carry their number, so the whole
photo is searched, following AprilTag 2 in outline: an adaptive threshold (integral image)
and 4-connected dark components with a ring's dark share; a quadrilateral from each convex
hull (the farthest pair of hull points and the farthest point on either side); each side
refined to sub-pixel from the strongest brightness step across its middle 70 % and a
total-least-squares line refitted without samples beyond 3 × the median residual, corners
where the lines meet; a homography from the 8-cell box, the black ring checked against the
white border, and the 36 data cells in four rotations matched to the nearest of 587 codes.
At most 2 wrong bits are accepted (distance 11 would allow 5; 2 keeps random patterns out);
score (11 − 2·errors)/11.

**ArUco markers** (OpenCV's DICT_4X4/5X5/6X6; Garrido-Jurado et al. 2014) use the same
detector with another family (`core/sfm/tags/aruco.js`): an (n + 2)-cell box, n × n data
cells read row-major, correctable bits min(2, ⌊(d − 1)/2⌋) with d the dictionary's
smallest distance over all pairs and rotations (`familyDistance.js`, as OpenCV's
`maxCorrectionBits`), but none for a 4×4 dictionary: with one bit corrected, a random
pattern inside a dark ring decodes to some id of 4x4_50 one time in 20 (4x4_250: one in
4); read exactly, one in 330. With a model, a tag farther than max(40 px, 2 % of the
photo's long side) from where its GCP projects (from its other marks, or its surveyed
position through the georeference; `targetPredict.js`) is not placed.

The centre is the homography's image of the box centre (under perspective not the corners'
mean). Photos are read in 2048-px tiles overlapping by 400 px, large tags in a 2048-px
downscale. A tag becomes a mark of the GCP whose name holds that number and no other, or of
a new marker "Tag N".

### 6.8 Scale constraints

`core/products/scale.js` `fitScale`, applied through the frame
(`core/products/projection.js` `frameFromScaledLocal`). A similarity (3 translation,
3 rotation, 1 scale) leaves every reprojection residual unchanged: the **gauge freedom**
(the datum defect of a free network). The georeference (§6.3) removes all seven; a **scale
bar**, a measured distance between two points the model can locate, removes one, and is
what a close-range project without GCPs or CRS has.

    s = Σ wᵢ·dᵢ_model·dᵢ_known / Σ wᵢ·dᵢ_model²      residualᵢ = s·dᵢ_model − dᵢ_known

with `wᵢ = 1/σᵢ²` from each bar's 1σ (missing σ ⇒ weight 1, reported as equal weight).
Endpoints are **markers** (marks without surveyed coordinates, triangulated as in §6.2) or
**camera centres**.

**Post-hoc is not an approximation.** BA is blind to the gauge, so scaling afterwards gives
exactly the model a scale constraint inside BA would give. They differ only when ≥ 2 bars
**disagree**: inside the optimiser the geometry would deform to split the difference,
while the post-hoc fit keeps the shape and reports the disagreement. A distance residual
would also couple two point blocks and break the block-diagonal structure the Schur
complement eliminates, so it stays out until a dataset needs it. The GCP anchor is no
shortcut: it fixes absolute positions, which a bar does not know.

- **Scale lives in the frame, never in the coordinates**: `fromSfm(p) = s·base.fromSfm(p)`,
  `toSfm(c) = base.toSfm(c/s)`, basis left orthonormal. Rescaling the cloud would break the
  depth-map stamps and recorded `summary.*` numbers and need redoing on every refit.
- **Rank**: one resolver decides the unit, `CRS georeference > scale constraints > none`.
  With a georeference the bars become independent **checks**. Every bar reports its
  residual, including excluded or currently unmeasurable bars (with the reason).
- A scale-bar project is **metric with no CRS**: exports write metric values and no CRS
  identifier.

### 6.9 Control candidates from a reference orthophoto or DEM

Georeference ▸ Find GCPs (`workers/ops/referenceGcps.js`, `core/sfm/referenceMatch.js`).
All coordinates are native pixel-edge coordinates, so a homography maps ortho to reference
pixels at whatever resolution either was read (`core/io/rasterWindow.js overviewLayout`).

1. **Search region**: the georeferenced ortho's footprint, else the photos' GPS box padded
   by half its span (≥ 300 m), else the whole reference.
2. **Coarse look**, one of three `matcher`s:
   - **learned** (default, `core/sfm/referenceLook.js`): DISK, or SuperPoint when
     installed, with LightGlue. Neither is scale- or rotation-invariant (each holds about
     ×0.8–1.25 and ±15°), so each look reads both rasters at the same metres per sample
     (≤ 2,000 samples), turns the ortho to a hypothesised rotation, and fits a homography
     (RANSAC, ≥ 20 inliers). Hypotheses come from a prior 2-D similarity
     (`fitSimilarity2d`: the georeferenced ortho's grid, else camera centres ↔ GPS, else
     near-nadir centres ↔ footprint centroids): its rotation ±15°, then every 30°; without
     a prior, five scales × every 30°. Against modern imagery of old film SIFT rarely finds
     the true homography where DISK + LightGlue does.
   - **`sift`**: one 1,536-px look at the whole ortho and region, mutual ratio 0.75; on
     failure 3×3 then 5×5 overlapping windows, then re-looks at the predicted footprint.
   - **`terrain`** (`core/sfm/terrainControl.js`, `alignTerrain`): no image matching. The
     prior as a 3-D similarity (`terrainInitial`) seeds a scaled ICP (`icpAlign`, §8.6) of
     the sparse points against the reference DEM, **coarse to fine**: point-to-point at two
     shrinking radii, then trimmed point-to-plane at two more. It converges from a few
     hundred metres and a degree off, not from kilometres. Candidates are tracks whose
     aligned point lies within a few RMS of the DEM on stable ground; σ XY = the RMS.
3. **Fine**: ≤ 6×6 tiles of 512 px at the **coarser** native resolution of the two (a
   feature cannot be located better), matches gated near the coarse prediction, one
   homography per tile, kept with ≥ 10 inliers, ≥ 30 % and an inlier box spanning ≥ 20 % of
   the tile both ways (repeated texture matches itself in a tight cluster). Per-tile models
   follow relief and doming.
4. **Candidates**: sparse tracks with ≥ 2 photo observations within 2 px of an accepted
   match, placed by the tile homography; spread over a √30 grid, then ≥ 24 px apart.
   Confidence = ratio × min(1, inliers/30) × e^(−r²/2) × (0.8 for a two-photo track), an
   ordering, not an acceptance.
5. **σ XY** (`referencePick`): the reference pixel in project units × max(1, residual in
   reference px), in quadrature with a declared horizontal accuracy. A click on a reference
   raster uses max(1, 1/zoom, preview downsampling) instead: good to one pixel as drawn.

Nothing is added unreviewed; elevation needs a reference DEM with declared accuracy.
Temporal change and strong radiometric differences remain limitations.

### 6.10 DEM co-registration to a reference DEM

`core/eval/demCoregister.js` (Nuth & Kääb 2011), used by `demCompare.js` (Quality Report ▸
DEM vs reference). On ≤ 20,000 cells on 5–45° slopes, with the reference's slope α and
downhill aspect ψ from central differences: Δh = DEM(p) − ref(p − t);
Δh/tan α = δ_N·cos ψ + δ_E·sin ψ + c, fitted by least squares over cells within 3 NMAD of
the median; t += (δ_E, δ_N) until the step is under 5 % of a cell (≤ 8 passes). `shift` is
where the DEM sits against the reference.

**Co-register DEM** (Tools ▸ Products, `core/products/demCoregistration.js`) applies it in
xDEM's order (NuthKaab, VerticalShift, Deramp), each optional: the shift on ≤ 20,000 cells
inside a stable-ground layer (sampled more finely when the layer keeps few), the slopes at
the DEM's own cell size; the median Δh after the shift; then a polynomial of order 1 or 2
in centred, scaled position, fitted on cells within 3 NMAD (twice). Results go to:
- **the DEM**: the copy's origin moves by −shift and each cell loses vertical + tilt;
- **the georeference**: 200 cells become pairs (where the fit puts them, where the
  correction puts them), and the similarity refitted to them (Horn, in the fit's local
  frame) replaces the fit's. A plane is a shear, which a similarity takes up as a small
  rotation (2 mrad for 2 m/km); a quadratic surface cannot be, and is refused here. A
  sparse rebuild drops the correction.

---

## 7. Dense multi-view stereo

**Method**: **PatchMatch stereo** with slanted support planes (Bleyer et al. 2011; the
multi-view form of Galliani et al. 2015 and Schönberger et al. 2016), in
`core/dense/mvs.js` and `crates/reconstruction/src/mvs.rs`, with a WebGPU kernel in
`workers/gpu/patchmatch.wgsl`. Four stages: per-image depth maps (§7.1–7.2), a cross-view
filter (§7.3), fusion (§7.4).

### 7.1 Depth maps

PatchMatch with slanted-plane hypotheses, red–black checkerboard propagation and decaying
random refinement. The cost is photo-consistency of the **plane-induced homography** warp
into the source views. Optional `filterDepthMap` (median and speckle cleanup).

- **Sources and sweeps**: up to 10 neighbours per reference and 5 sweeps at the finest level
  (one more per coarser level); both raised F1 on every ETH3D scene against 6 and 3. An
  11×11 window scored lower than 7×7, and averaging more of the best sources changed
  nothing: the larger candidate pool is what fills the surface.
- **Cost per source**: **bilaterally weighted ZNCC** (`1 − ncc`, in [0, 2]), as COLMAP:
  each window sample weighs `exp(−d²/2σs² − Δ²/2σc²)`, `d` its distance from the centre,
  `Δ` its grey difference from the centre pixel, σs = the window radius, σc = 25 grey
  levels (`DENSE_TUNING.bilateralSigmaColor`; COLMAP uses 51). Narrower bands trade
  completeness for accuracy; 25 was the best of a sweep.
- **Aggregation**: best-K over sources that actually *measured* the pixel: a warp leaving
  the source, a masked texel or < 4 overlapping samples is excluded. A flat **reference**
  patch (variance < 1e-6 on 0..255, identical in both kernels) is unmeasurable and
  excluded; a textured reference warped onto a flat **source** patch (saturated snow, sky,
  shadow) is evidence against the hypothesis and costs the maximum 2.0. Excluding it would
  let a wrong depth landing on flat areas in all but one source win on that source's chance
  correlation.
- **Numerics**: ZNCC sums are taken about the first sample's value, or the f32 GPU kernel
  loses a bright low-contrast patch's variance to cancellation.
- **Refinement schedule** (`core/dense/refineSchedule.js`): each sweep proposes a random
  normal, a depth step and a joint step at scale `s = s₀·0.5^it`; the depth step is
  `±0.5·s·min(d, d_max − d_min)`, relative to the pixel's **own** depth `d` as COLMAP's
  `PerturbDepth` (a range-sized step is useless to near pixels in a deep oblique scene),
  bounded by the range so shallow scenes keep fine steps. A coarse-to-fine pyramid
  **continues** the decay: each finer level starts at `s₀ = 2×` the scale the coarser one
  ended on (headroom for the upsampled seed's one-coarse-pixel error).
- **Threads** (CPU): rows run on the threaded build's pool (`DENSE_TUNING.cpuDepthThreads`,
  one worker); per-pixel random streams make a map bit-identical on any thread count.
- **Window step** (`DENSE_TUNING.windowStep`, 1): sampling every other row and column of a
  larger window, as COLMAP and ACMM do, saves ~30 % time for 1.4–1.5 F1, so it is off.

### 7.2 Method: Fast and Full

`method`, default **auto**: Full on the GPU, Fast on the CPU (`resolveDepthMethod`).
**Fast** is best-K view selection in one pass. **Full** is ACMH view selection, then a
planar-prior pass, then a geometric-consistency pass; each step raised ETH3D F1, together
by about 4 points, for ~2–3× Fast's depth time on the GPU. ACMH on the CPU is two orders of
magnitude slower than on the GPU, hence Fast without one. Results:
[BENCHMARKS](BENCHMARKS.md#eth3d-high-res-eth3ds-own-evaluator).

**ACMH view selection** (Xu & Tao 2019; `patchmatch.wgsl` `acmhSweep`, `mvs.rs` `ACMH_*`).
Each sweep a pixel takes candidate planes from 8 regions of the other checkerboard colour
(4 V-shapes of 7 samples next to it, 4 strips of 11 out to 23 px), the cheapest of each
transferred onto its ray. The 8 candidates' per-view costs vote: a view counts when more
than 2 match it below τ(t) = 0.8·e^(−t²/90) and fewer than 3 above 1.2, weighted by the mean
of e^(−c²/2·0.3²) over its good costs; the pixel's most important view of the last sweep
is doubled (0.2 when not selected). The cost is the weighted mean; refinement tests 6
combinations of a random and a perturbed depth and normal with the current ones. When no
view passes the vote, every view is weighed by its best match (the paper is silent here).
The map hands on the best-K photometric cost. (On periodic texture best-K is better.)

**Planar priors** (ACMP, Xu & Tao 2020; `core/dense/planarPrior.js`, `prior_cost` in
`mvs.rs`, `priorCost` in the WGSL). After the photometric sweeps, the cheapest pixel of
each 5-px cell with cost < 0.1 becomes a support point; the support points are
Delaunay-triangulated in the image (`delaunator`), and each pixel inside a triangle gets
that triangle's plane (planes meeting the ray at |cos| < 0.1 are dropped). A second run of
3 sweeps, seeded with the first map, scores
c′ = c²/α − ln(γ + e^(−Δd²/2σd²)·e^(−θ²/2σn²)), α 0.18, γ 0.5, σd = range/64, σn = 5°
(Δd and θ the depth and normal differences to the prior); pixels without a prior keep the
plain cost. A textureless wall between textured edges gets the plane its edges span. Five
sweeps instead of three gained too little to keep.

**Geometric-consistency pass** (λ 0.1, cap 5 px, 2 sweeps; `geom_error` / `geomError`),
as COLMAP's geometric PatchMatch and ACMM: each source's first-pass depth (after the prior)
enters the cost; a candidate depth is projected into the source, the source's depth there
projected back, and the forward–backward reprojection error e (capped) adds λ·e to that
view's cost. The photometric cost is still handed on for the downstream NCC gates. The pass
is staged: it reads its sources from the saved first-pass maps (an LRU of 24 depth planes
per worker) and writes `<uuid>.g.<key>.bin`, which replaces the first pass only once every
map is done (`promoteStagedDepthPlanes`), so memory does not grow with the image count. On
Fast (best-K) maps it lowered F1, which is why it belongs to Full only.

### 7.3 Cross-view consistency filter

`filterDepthMapsGeometric`, the equivalent of COLMAP's `filter` pass (`filter_min_ncc`,
`filter_min_num_consistent`, `filter_geom_consistency_max_cost`). It runs once after all
depth maps exist and **zeroes rejected pixels in the maps themselves**, so the saved
planes, and the orthophoto that uses them as a z-buffer (§8.3), are cleaned, not only the
fused cloud.

**Why no photometric gate can replace it**: sky and vegetation both have high NCC.
Vegetation is genuinely photo-consistent; gradient sky and cloud correlate at any depth.
Both are exposed only by **disagreement between views**. Per pixel: unproject to `P`,
project into a source, read **that source's depth at that single pixel**, unproject to
`P′`, reproject into the reference: the forward–backward error `e`. A view is consistent
when `e ≤ maxGeomCost` (px) **and** its triangulation angle at `P` is ≥ `minGeomAngleDeg`
(3°, COLMAP's `filter_min_triangulation_angle`); `minConsistent` such views are required,
plus an absolute `minNcc` floor.

- **The angle gate**: at ~0° parallax the round trip is vacuous: a source beside the
  reference looks down the same ray, so any depth, a sky pixel at an arbitrary distance
  included, returns to `(u,v)`. Pixels failing only for want of parallax are logged
  separately.
- **One source pixel, not a window**: fusion's check (§7.4) accepts if *any* pixel in a
  window is within a depth tolerance, which a noisy depth cloud such as a bush almost always
  passes by chance.
- **Candidate views**: at most `DENSE_TUNING.filterMaxViews` (12) overlapping maps per
  reference: first the nearest cameras whose baseline reaches the parallax gate at the
  reference's median depth, then the nearest of the rest (plain nearest-first picks
  cameras that vouch for nothing, such as the cameras of one aerial station). Every
  candidate plane is resident while a reference is judged, so the cap bounds memory.
- **Order independence**: all maps are judged against the *unfiltered* planes (rejections
  staged in per-map masks, applied afterwards), as COLMAP filters against the pass-1 maps;
  filtering in place would cascade drops in map order.

### 7.4 Fusion

`fuseDepthMaps`: a depth survives only if it reprojects consistently into enough
neighbour views (`minViews`, within a relative depth tolerance in a `(2·consistencyPx+1)²`
window), after the per-pixel cost gate `maxCost`. With the cross-view filter's NCC floor
upstream, `maxCost` is only a loose fixed backstop (0.8); an adaptive percentile of the
pooled costs would drop a fixed share of pixels the floor has already vetted. The check
compares each map with at most `DENSE_TUNING.fuseMaxViews` (12) maps whose frustum reaches
it, those with enough parallax at its mean depth first (`fusionViews`, chosen once in the
plan, so resident and streamed fusion agree).

**Point position.** With `position` 'mean' a kept pixel is emitted at the mean of its own
depth and each agreeing view's, as COLMAP's fusion averages its consistent views. A view
with centre C′ measures P at depth d′ = its map read at P's exact projection (bilinear in
inverse depth, which is linear on a plane; no value if any of the four pixels is empty),
i.e. at C′ + s·(P − C′) with s = d′ / (P's depth in that view). Depth is linear along a
ray, so in the reference camera that point lies at z_C′ + s·(d − z_C′), z_C′ the
reference-frame depth of C′. Only the views counted before the pixel settles (`minViews`
reached with the parallax) enter the mean. 'own' keeps the pixel's own depth, and only
the voxel merge averages. 'auto' resolves by scene type: mean for aerial (and unknown),
own for object captures (`DENSE_POSITION_AUTO`). Measured on the same depth maps: on a
flat aerial block the scatter about the LiDAR fell 5.1 → 4.0 cm (within 10 cm 92.9 →
97.4 %, 16 % fewer points); on six ETH3D close-range scenes F1 @2 cm fell by 0.17 on
average (accuracy up, completeness down), hence the split.

Three **geometric outlier filters** clean the fused cloud without a segmentation model (all
opt-out):
- **min triangulation angle**: a pixel must agree with a neighbour at ≥ `minTriAngleDeg`
  parallax (sky and haze agree at ~0°);
- **grazing incidence**: drops surfaces seen edge-on, `|n·(C−P)|` below
  `cos(maxIncidenceDeg)` (thins vegetation shells; view-direction fallback normals are
  inert);
- **isolated cells**: drops lone low-support voxel cells whose 26-neighbourhood is nearly
  empty (fusion flyers), each judged against the unfiltered occupancy.

The result is independent of cell order, so a large cloud is fused in **slabs** along the
long axis (one slab's accumulator resident, one-cell halo) and gives the identical cloud.
The accumulator and a cloud past 2 GiB live in WebAssembly memories (`core/bigArray.js`),
outside Chrome's 2 GiB per-ArrayBuffer cap and 16 GiB per-tab pool: with Memory64 an
accumulator holds 2³⁰ cells and a cloud ~1.4 G points. The slabs, and the cloud they are
joined into, are in shared memory where the page is cross-origin isolated (`sharedArrays`,
`cloudParts.js`), so the octree build and Build Mesh get views, not copies; elsewhere they
are plain arrays up to 2 GiB. The slab workers are released once the last slab is done: an
idle worker never collects its wasm memories, and their accumulators stayed resident
through the join. The plan holds the peak to the RAM budget less what the open project
holds, and its ArrayBuffers to the pool. **Streamed fusion** over saved maps
applies the same rules, holding one reference and one comparison map at a time (pair-major,
source order kept); its pre-passes read only depth and cost. Tests require identical
points, normals and summaries from both paths.

**Oriented normals for free**: PatchMatch already estimates a per-pixel plane. Both
backends export the converged camera-frame normal; fusion rotates it to world (`Rᵀ·n_cam`)
and voxel-averages and renormalises it per point (`DenseCloud.nrm`). The kernel keeps
`n_z < 0` (facing the camera), so aerial coverage gives consistently **outward** normals,
which screened Poisson needs (§8.5), with no k-NN PCA and orientation propagation.

### 7.5 Backends and caveats

**Two backends, same maths**: WebGPU when the browser exposes it, else (or by choice) WASM
on the CPU. The GPU path falls back per image and validates the first: its final cost
against the Rust cost of the same planes (`mvs.rs` `plane_costs`), median difference above
`DENSE_TUNING.gpuCheckMax` ⇒ CPU. Both kernels are held to the same depth accuracy on
synthetic scenes (`tests/bench/patchmatchCases.js`; WGSL on SwiftShader nightly).

- **Homography sign**: `H = R + t·nᵀ/d` for plane `n·X = d` with `d = n·P`; the
  Hartley–Zisserman `R − t·nᵀ/d` assumes the opposite plane convention and mirrors the warp.
- **Cost** scales as overlap × sources × pixels²; the levers are `maxDim`, `maxSources`,
  `iterations`.
- **No sky segmentation**, as in COLMAP and Metashape, which compute depth everywhere and
  discard. Manual masks are supported (masked pixels are excluded as source texels, not
  zeroed). A blue/brightness sky prior is unsafe for polar imagery, where snow and ice
  against sky is genuinely ambiguous.

### 7.6 Keeping valid depth maps

`core/dense/depthReuse.js`. A saved map is kept when the index's sparse stamp still
matches the model (Add to the model ▸ Fixed keeps it), the run's shape hashes to `mapsKey`
(`depthRunShape`: the settings that shape a map, Auto resolved, the working resolution, the
scene type, the region), and the map's camera (pose, K, lens, film transform, mask) hashes
to its `cameraKeys` entry. The index is cut to the kept maps first, so a stopped run never
names an overwritten plane. Only the other maps are computed (the kept ones read as pass-2
neighbours) and filtered (§7.3, against every map). Kept maps are not recomputed with new
neighbours as a full run would, so reuse is a setting (on).

---

## 8. Products

`core/products/`. The DEM, orthophoto and mesh, the reflectance map, the tools that edit
or measure them, and how they are streamed and saved. Without a georeference (§6) products
live in a local vertical frame; with one they carry CRS coordinates and true scale.

### 8.1 Where "up" comes from, and what a product covers

**Up** (`projection.js`, `core/sfm/geometry.js`). Without a georeference the vertical is
estimated from the cameras. Three readings exist, and each fails somewhere:
- the reversed **mean viewing direction**: right for a nadir survey, tilted with the gimbal
  on an oblique one. It is a trimmed mean (`trimmedViewDirection`: passes keep the cameras
  within 40°, 30°, then 25° of the current mean), so a block mixing verticals with
  unbalanced obliques (a trimetrogon film flight) uses its verticals;
- the mean **image-up axis**: right for hand-held terrestrial photos, horizontal on a nadir
  survey;
- the normal of the **camera-centre plane**: right whenever the cameras share one height
  (a flight plan, a walk on level ground, a turntable ring), undefined for a single strip
  or a 3-D cloud of positions.

The plane normal wins when the centres form a usable plane (thinnest spread ≤ 5 % of the
middle, middle ≥ 20 % of the largest) **and** the cameras look at it more than 25° off its
normal (`planeUpOverride`): a terrain-following flight tilts its camera plane with the
slope (rarely beyond ~25°) while the gimbal still points down. Blind spots: obliques
shallower than 25°, and a vertical camera grid before a façade (a nadir block turned 90°).

**Sign.** The plane normal and viewing direction take their side from the viewing
direction, which assumes the cameras look down; ground-level photos look up at their
subject. Outside an aerial project, the mean image-up axis decides the sign when it lies
within 60° of the answer's line, since an unrolled camera's image-up axis leans up whether
it looks up or down (`estimateUpFromCameras`, option `aerial`). An aerial project keeps the
viewing direction's sign, because a scanned frame can be stored rotated; the aerial
auto-orient warns when the cameras look up (`camerasLookUp`).

**Extent.** A product covers the cloud's **dense core** (`dem.js` `coreExtent`), not its
raw box: an oblique capture sees to the horizon, and a thin far field would set the raster
size and GSD. Background thins out per unit area, so the core is found by density: trim at
the 0.1/99.9 % quantiles, histogram on a 128×128 grid, keep the box of cells holding ≥ 2 %
of the point-weighted median cell count, and repeat inside it. (A cell percentile fails
when background fills most cells.) Points outside are left out and counted (warning above
5 %). Extent ▸ All points restores the raw box; a Region (§8.6) bounds the input first.

### 8.2 DEM

`dem.js`. The dense heights are binned into a grid over the dense core, gaps are filled by
inverse-distance weighting (Shepard 1968), and a hillshade is made for preview.

**Size at Auto** (`rasterSize.js demGridFor`, the dialog's readout and the run alike): a
cell of √(area / points), about one point per cell, up to `demAutoMaxSide` (8,192) cells a
side; past one plane of 4,096 the grid is built in blocks into a Cloud-Optimized GeoTIFF.

**Cell aggregation** (`aggregate`): `median` by default, or `max` (top surface), `mean`,
`min`. `max` biases the DEM upward by the slope across a cell (metres on steep terrain at
coarse cells), not just noise. A median whose per-point buffer exceeds the memory budget
falls back to the mean.

**Enclosed gaps** (`fillEnclosedGaps`, Build DEM ▸ Fill enclosed gaps, on for Ground
only): nodata not connected to the grid border (BFS) is filled by pull–push (Gortler et al.
1996): a pyramid of 2×2 weighted means with weight min(1, Σw), then a push that blends each
level with the bilinear level above by its weight. Border-connected nodata is the survey
edge and stays.

### 8.3 The orthophoto's surface

`ortho.js` is a **true** orthophoto: it reprojects through the cached dense depth maps as
a z-buffer (occlusion-correct) and samples colour from the source photos. `orthorectify`
walks a height grid (`{width, height, gsd, originX, originY, data, mask}`); which surface
fills it is a choice (Metashape's *Build Orthomosaic ▸ Surface*, `core/products/surface.js`):

- **DEM**: every DEM hole becomes a transparent ortho cell, which makes a sparse-coverage
  ortho patchy.
- **Mesh** (`meshSurface`): a from-above z-buffer rasterisation of the Poisson triangles;
  watertight, so a dense mask.
- **Plane** (`fitPlane`, `planeSurface`): a robust least-squares plane, for flat scenes.

`resampleSurface` decouples the ortho's GSD from the surface's (a coarse surface reprojects
fine detail). **At Auto** the cell is two photo pixels (`orthoAutoPhotoPx`), up to 16,384
cells a side and never coarser than the surface: `photoGsd.js` takes, per camera, the
median distance to the tie points it sees over its focal length, measured in the ortho's
frame (so in its unit), and the median over cameras. Two pixels a cell is where the photo
loader, which decodes at about two photo pixels per cell, reaches native resolution. An ortho therefore carries its own geotransform (`gsd`, `originX`,
`originY`, `frame`, `crs`), and rebuilding a DEM outdates only an ortho whose surface was
that DEM.

### 8.4 The mosaic: which photo colours a cell

Each cell takes its colour from one photo and the seams between photos are hidden. The
default (`blend: 'mosaic'`) places seams by **graph cut** (`seamline: 'graphcut'`), evens
out exposure by **gain compensation**, and blends across seams with a **multiband**
pyramid (`seamBlend: 'multiband'`). The simpler choices are nearest-nadir seams and
feathering. The Orthophoto quality cards (`ORTHO_PRESETS`) step between them.

**Visibility.** A view sees a cell when the z-buffer agrees within `depthTolRel`, its
matching cost is ≤ `maxCost`, and it sees the surface from above. A depth-map hole (the
cross-view filter removes weakly matched pixels, §7.3) does not mean "not seen": the
nearest agreeing depth within 2 map pixels stands in, never overriding a nearer (occluding)
depth; otherwise the label map speckles.

**Nearest-nadir labels** (`seamline: 'nadir'`). Every visible view is scored by its
foreshortened footprint `depth / (f · cos² θ)`, θ the angle between the ray to the camera
and the vertical, and the lowest wins: on a nadir block at one altitude the most nadir view
(a Voronoi-like partition), with lower flights winning where they overlap. The tilt counts
twice so a nadir view beats a closer oblique one; one cos (the true ground footprint) lets
near obliques win and makes buildings lean. Matching cost is a gate only: as a *choice* it
is a texture statistic that switches source from cell to cell. Two 3×3 majority passes
remove single-cell flips; a cell its smoothed label cannot see keeps its own first choice.

**Graph-cut seamlines** (`core/products/seamCut.js`; Kwatra et al. 2003, Agarwala et al.
2004) choose the labels by energy minimisation instead: data cost 600 · (s_l / s_best − 1)
on the footprint score s (the most nadir view costs 0), seam cost 6 + Σ|ΔRGB| (sRGB levels
after the gains) between the two photos at both cells, 150 where one photo does not see
the cell. Solved by alpha-expansion (Boykov, Veksler & Zabih 2001; moves that the
truncation of a non-metric V would worsen are rejected, so the energy never rises) with a
grid max-flow (`gridMaxflow.js`, Boykov–Kolmogorov 2004), once for the whole ortho on a
coarse grid of ≤ 2²⁰ cells (8 candidate views each), so labels do not depend on the block
layout; deterministic. Graph cut moves seams off roofs and tree crowns.

**Gain compensation**, per image and channel, in linear light, from overlap means on a
lattice of ~65 k cells (clipped samples left out). Unlike Brown & Lowe (2007), the fit is in
the **log domain**: `Σ_pairs N_ij (x_i − x_j − log(Ī_ji/Ī_ij))²/σ² + κ Σ_i W_i (x_i − p_i)²`,
x = log g, W_i the image's overlap weight, κ = 0.01. Brown & Lowe's linear form
`Σ N (g_i Ī_ij − g_j Ī_ji)² + prior on (1 − g)` is minimised by shrinking every gain toward
0 wherever ratios disagree around loops. In logs a common factor costs nothing, so the
prior only fixes the level and limits drift to a correlation length of ~1/√κ ≈ 10 images.

**The prior is the photo's EXIF exposure** (`exposurePriors`): p_i = log(E_med / E_i),
E = exposure time × ISO / f-number² (a factor no photo records is left out of all), 0 for a
photo without it and for a block shot at one exposure. A prior at 0 also damps a *real*
exposure trend: auto-exposure drifting fourfold along a 60-photo strip stays 96 % (in log)
across the levelled block, neighbours 2.3 % apart; centred on the EXIF exposure, 0.2 %
(`colourGains.test.js`). The fit then corrects only what the exposure does not explain
(the camera's tone curve, light, vignetting), and gains are clamped to ±2 stops around
e^{p_i}, which catches a fit gone wrong without cutting a real exposure change. After the
solve the log gains (and the clamp's centres) are shifted so their prior-weighted mean is 0:
the photos keep their own overall level, and the exposures set only how they compare (the
median exposure as the level would brighten or darken a whole product with how the
exposures happen to be spread). The
texture's per-image gains (§8.6, Texture) use the same fit and prior.

**Blending.**
- **Feathering** (`seamBlend: 'feather'`): each image contributes to the cells within
  `seamCells` of its region (1 % of the ortho's short side, ≤ 128 cells) with weight
  `(3·seamCells − d) / (3·seamCells)`, d the 3-4 chamfer distance; averaged in linear light.
- **Multiband** (`multiband.js`; Burt & Adelson 1983): a 5-level Laplacian pyramid written
  as a correction to the hard-seam mosaic, result = base +
  collapse_k(Σ_j G_k(M_j) L_k(d_j) / V_k), d_j = photo j minus the base, non-zero only on a
  ring of 2^(L+1) cells around j's region, so a cell deep inside a region keeps its photo's
  colour exactly. Normalised convolution (V_k) keeps data edges from darkening; block
  windows are aligned to the 2^L lattice with a halo of 4·2^L + ring cells, so blocks join
  bit for bit. It keeps more detail than feathering, which averages two photos over the
  band, at the price of a slightly sharper residual step.

**Streamed orthorectification** keeps the same best-view tie order or weighted average,
rounding only after all views; gap filling runs after every source map has contributed.

### 8.5 Mesh: screened Poisson surface reconstruction

**Method**: **screened Poisson** (Kazhdan & Hoppe 2013), `crates/mesh` (WASM) and
`core/products/mesh.js`: an implicit indicator function whose gradient matches the oriented
normals, with a screening term pulling the level set toward the samples, extracted by
marching cubes. On a photogrammetric cloud the solve alone is not a usable mesh, for the
reason PoissonRecon ships `SurfaceTrimmer`: the solution is closed and defined everywhere,
so it extrapolates a hull past the data and wraps every speck of noise in a shell. The
cleanup below is part of the method.

- **Normals**: Poisson needs oriented normals; the PatchMatch plane normals (§7.4) are
  reused, so the only heavy new compute is the multigrid solve.
- **Convergence**: the multigrid is cascadic, each layer solving by conjugate gradients for
  the residual the coarser layers left. Each layer's CG starts from 0 and runs to a 10⁻⁶
  relative residual; a fixed handful of iterations from `x₀ = b` leaves cell-sized ripples
  that become hundreds of spurious components.
- **Input conditioning**: the octree spans the input's box, so stragglers outside the
  1–99 % per-axis box grown by 25 % of its largest side leave the solve. A depth is
  lowered when its leaves would be finer than the sample spacing (the fusion merge cell,
  or the median nearest-neighbour distance of an imported cloud). Lone stray points go;
  the cloud is voxel-thinned to ≈ one sample per leaf, each keeping how many raw points it
  stands for as its **support weight**.
- **Iso-value**: the support-weighted mean of the implicit function at the samples, not
  `0` (the reference implementation also uses a sample average); the weighting stops
  one-point strays pulling the level off the well-supported surface.
- **Support trimming**: support weights are splatted trilinearly onto a lattice four leaves
  wide; a triangle whose mean vertex support is below a fraction of the *median sample's*
  support is removed (`trim`: gentle 0.1, strong 0.3), a ratio that means the same at any
  scale. Extraction is bounded to non-zero support, so the hull is never generated.
- **Hole refill** (`fillHoles`): a trimmed region that is closed (no open edge) and no
  larger than 5 % of the kept piece it borders is a hole the solve legitimately bridged,
  and is added back (cf. PoissonRecon's `--aRatio`). It is compared with the bordering
  piece, not the whole mesh, next to which a speck's shell also looks small.
- **Floating pieces** (`removeFloaters`, `minPiecePct`): a component is dropped when it
  explains < 1 % of the support of the best-supported one, support being the summed weight
  of the samples whose nearest kept vertex lies on it. Evidence, not area: Poisson inflates
  a 20-point speck into a ball of comparable area to real surface.
- **Distance trim** (`distanceTrim`, off): culls triangles farther than `distanceTrim ×`
  the sample spacing from the input: extrapolated sheets, not a speck's shell.
- **Colour**: from the nearest dense-cloud voxel, then a leaf-sized grid, else gray.
- **Tiles** (`tiles: auto`, `core/products/meshTiles.js`): a scene whose solve would not fit
  one heap (projected 768 MB + 10 KB a sample; ~12 GiB with Memory64) is solved in tiles on
  a 2-D grid over its two longest axes, each ≤ 3 GiB of samples plus ≥ 12 leaves of overlap
  (the trim's support cell is 4 leaves and reaches 2 cells, plus a cell of rounding). Every
  tile is solved on the scene's own leaf grid (`build_on_grid`), so neighbouring tiles put
  vertices on the same lattice edges; a tile keeps the triangles whose centroid's cell is in
  its core, and seam vertices are welded by lattice edge. Tiles trim against the scene's
  median support; floating pieces are judged on the stitched mesh. Hole refill is decided
  per tile, so a hole crossing a seam can stay open there. The tiles run on as many pool
  workers as the memory budget holds solves of the largest tile, after what the open
  project and worker 0's copy of the input take; each gets only its tile's samples
  (`tileTask`) and a fresh worker per tile (a reused wasm heap grows past the next solve's
  estimate), and the tile workers are released before worker 0 joins the tiles.
- **Depth Auto** (`depth: 0`, `autoMeshDepth`): the depth whose leaf `E / 2^d` (E the
  longest extent) is nearest `leafSpacings` sample spacings in octaves, then lowered while
  the predicted mesh passes `maxTriangles`. The prediction counts the leaves the surface
  covers: a fused cloud holds about one point per merge cell, so N points at spacing s
  cover ≈ N·s², or N·(s·2^d / E)² leaves, and a leaf yields ≈ 1.6 triangles
  (fitted on six meshes, 0.9–1.4× the real count; never more leaves than points). With
  the cards (16 / 8 / 4 spacings, ≤ 0.25 / 1 / 4 M triangles), a small block's depth is
  set by its spacing and a large block's by the limit, which follows what a tab holds
  (a 347-photo block: depth 9 at 10 GB, depth 10 at 19 GB, depth 11 past 32 GB).
- **Knobs**: `depth` (Auto, or set; capped by the spacing), `leafSpacings`, `maxTriangles`, `screening` (fit tightness; **not**
  PoissonRecon's samples-per-node), and the cleanup settings above.
- **Implementation**: a vendored, rayon-free copy of Dimforge's `poisson_reconstruction`
  (`crates/mesh/vendor/`; rayon's threads panic on threadless wasm). Its assembly is
  restructured without changing the system: the coarse-layer screening term uses the coarser
  solution evaluated once per sample, gradient terms come from tables keyed by integer
  lattice offset, and the coarse-layer gradient term prolongs the coarser solution with the
  exact B-spline refinement (`B_{2w} = Σ [1,3,3,1]/8 · B_w` per axis). The coefficients
  agree with the original to 10⁻¹² relative, at about 15× the speed.

### 8.6 Point-cloud, mesh and raster tools

Post-processing of a finished product (Tools tab); every edit makes a new cloud or mesh and
nothing feeds back into the solve.

- **Neighbour search** (`core/products/knn.js`): one exact static k-d tree (median split,
  leaves of 12) behind normals, ICP and distances; unlike a uniform grid it stays fast for
  queries far from the data (another epoch, an unaligned start).
- **Normals** (`cloudNormals.js`): PCA of the 16 nearest neighbours (smallest eigenvector,
  cyclic Jacobi in double precision), each oriented on its own toward the nearest camera
  or +up: no spanning-tree propagation, so the result is deterministic.
- **Alignment** (`rigidTransform.js`, `icp.js`): point pairs use Horn's similarity (§6.3); the rigid
  variant keeps Horn's rotation and re-solves the translation. ICP (Besl & McKay 1992) is
  trimmed (90 %) and point-to-plane (Chen & Medioni 1992; a linearised 6-DoF step, damped
  Gaussian elimination, Rodrigues update, re-orthonormalised R) when the reference has
  normals, otherwise point-to-point Horn, in a frame centred on the reference. It is local:
  it needs an initial overlap within the search radius.
- **Distance** (`cloudDistance.js`): cloud-to-cloud is the nearest-point distance, signed
  by the reference normal; with k ≥ 3 the distance to a local least-squares plane, which
  removes the point-spacing floor. Cloud-to-mesh is the exact point-to-triangle distance
  (Ericson), candidates from a k-d tree over triangle centroids searched to d* + r_max
  (r_max the largest centroid-to-vertex radius): exact, since no farther triangle can win.
- **Mesh cleanup** (`meshEdit.js`): edge topology by counting sorts of half-edges,
  components by union-find, long-edge bridges against the median edge, boundary loops
  filled by a centroid fan wound against the loop (a manifold seam). **Taubin** smoothing
  (Taubin 1995; λ = 0.5, μ = −0.53) avoids the shrinkage of repeated Laplacian smoothing.
  Volume (⅙ Σ v₀·(v₁×v₂)) is reported only for a closed, consistently wound mesh.
- **Decimation** (`meshDecimate.js`): Garland–Heckbert (1997) quadric edge collapse with
  boundary-constraint quadrics; collapses must pass the link condition, a normal-flip and a
  degenerate-triangle test. The position is the better of the 3×3 solve and the best point
  on the edge, which keeps flat regions flat and straight borders straight.
- **Texture** (`core/products/texture/texture.js`, after Waechter et al. 2014, simplified):
  per-view z-buffer visibility, one view per face chosen with Potts smoothing (loopy belief
  propagation) and a photo-consistency check, charts of connected same-view faces with UVs
  from their projection, atlas packing, per-image gains in linear light and seam levelling.
  Faces no view sees take a flat colour.
- **Ground classification** (`groundFilter.js`): the cloth simulation filter (CSF, Zhang et
  al. 2016), mirrored in z (the cloth rises beneath the upright cloud). Collision height per
  cell = the lowest point (isolated one-cell dips > 1 m below their neighbours raised to
  the neighbours' median; empty cells copy the nearest measured cell). Verlet with the
  reference constants and springs to the 8 neighbours and the 8 at distance 2 (the
  reference code's rigidness tables in closed form); stop when no free particle moves 5 mm.
  Slope post-processing pins free particles reached from pinned ones through neighbours
  whose collision heights differ by < 0.3 m (the paper's terrain-continuity rule; without
  it a stiff cloth settles below steep flanks). Class from the height above the cloth:
  within ±0.5 m ground (2), above unclassified (1), below low point (7). The 1 m default
  cloth spans roofs up to ~40 m (2 m spans ~80 m) and suits the steep terrain common here.
- **Buildings and vegetation** (`pointClasses.js`, Classify Points steps 3–4): rules on the
  points above the cloth, in 0.25 m voxels (coarsened up to 1 m on sparse clouds). Each
  voxel's covariance over its neighbours within 1 m gives planarity (λ2 − λ3)/λ1, scatter
  λ3/λ1 and a normal (Weinmann et al. 2015). Planar voxels (planarity ≥ 0.5, scatter
  ≤ 0.06) grow into segments with normals within 20°. A segment reaching 2.5 m above the
  cloth with 10 m² of surface is **building** unless it is green (mean ExG = 2g − r − b
  > 0.06, Woebbecke et al. 1995); a mostly vertical one only near a roof, so a lone
  retaining wall is not a building. Buildings then take the non-green voxels within 1 m
  (edges scatter). **Vegetation** is a voxel that is green, or scatters and lies > 1 m from
  any planar voxel, never one clearly not green, banded by height at 1 and 3 m. Not yet
  scored on labelled data; on a sparse cloud without colour, cars can come out as
  vegetation.
- **Sections** (`cloudSection.js`): points within ±t/2 of the vertical plane through A→B,
  as (station, height, signed offset).
- **Contours** (`contours.js`): marching squares on cell centres; a saddle resolved by the
  quad-centre mean, a level equal to a sample counted as above, quads touching nodata
  skipped, segments joined by exact integer edge ids.
- **Terrain derivatives** (`terrain.js`): Horn's 3×3 gradient (Horn 1981, as gdaldem) with
  horizontal spacing gsd/k for the projection's scale factor k (heights never scaled).
  Aspect is the downhill bearing clockwise from north; hillshade is Lambertian, with GDAL's
  byte encoding and multidirectional weighting (Mark 1992).
- **DEM volume** (`core/products/measure.js` `polygonVolume`): the 2.5-D cell sum of
  Pix4D/Metashape stockpile tools and QGIS *Raster surface volume*,
  V = Σ (z − base(x,y))·|sx·sy| over cells whose **centre** lies inside the polygon
  (scanline, even-odd), split into cut (> 0) and fill (< 0). The base is a least-squares
  plane through the DEM at the vertices (refused when collinear), the lowest vertex height,
  or a user height. Nothing is interpolated: masked, nodata, NaN and off-raster cells are
  counted and reported as a coverage fraction. Units are horizontal² × vertical as recorded.
- **Raster clip** (`rasterClip.js`): even-odd scanline fill of pixel centres within each
  polygon (holes subtract), union across polygons.
- **Image quality** (`core/features/imageQuality.js`): variance of the 3×3 Laplacian of luma
  on a fixed-size downsampled grid (longest side 1024), judged against the batch median.
- **Region** (`region.js`): an axis-aligned box in the model frame. Depth maps seed their
  depth range only from sparse points inside it, fusion drops points outside it, and mesh
  and DEM inputs are clipped to it.
- **Orientation** (`orientation.js`): a user basis (up from a three-point ground plane
  turned to the cameras' side, an origin, a heading) for the local product frame. Like the
  scale (§6.8) it lives in the frame, never in the coordinates, and a georeference outranks
  it.

### 8.7 Reflectance map

`core/products/reflectanceMap.js`, `core/radiometry/micasense.js`. The bands of a
multispectral rig (§4.8) on the DEM, one Float32 plane per lens, written in 1,024-cell
blocks over the pool into a COG with each band named in GDAL_METADATA, and added as a
reference raster (styled as NDVI when it has NIR and red).

- **Which photo**: each cell goes to the capture whose reference-band photo sees it nearest
  its principal point; every band reads that capture's photo, so a cell's bands come from
  one moment. No occlusion test: meant for open ground and canopy.
- **Which value**: the pinhole projection goes through the lens model to the raw pixel
  (`makeSampleMap`), the raw DN is read bilinearly from the original file, and MicaSense's
  radiometric model, ported from their MIT-licensed `imageprocessing` (MicaSense 2017),
  gives radiance
  L = V(x, y) · (DN − black) / (gain · t_exp) · a1 / 2^bits / (1 + a2·y/t_exp − a3·y), V the
  radial or 2-D vignetting polynomial, with the legacy RedEdge exposure quirk. Thermal DN is
  centikelvin: °C = DN/100 − 273.15. Checked against the panel radiance and irradiance of
  MicaSense's own sample captures.
- **Calibration**: panel: factor = albedo / L_panel (mean over the camera-detected panel
  area, `ReflectArea`). Sun sensor: π / E, E the DLS 2 horizontal irradiance, rebuilt as
  direct·sin(elevation) + scattered on firmware that computed it wrong (MicaSense's rule;
  DLS 1 is not modelled). Both: the panel factor × E_panel / E. A band without a panel
  photo falls back to the sun sensor, else radiance.

Band-to-band registration and reflectance on independent panels are not yet checked on a
real multispectral flight.

### 8.8 Saved measurements and reference rasters

Saved 2-D measurements keep world vertices, units, sampled profiles and their source and
frame stamp. They are evidence snapshots: rebuilding a raster never silently recomputes
them. Reference-candidate review (§6.9) can declare covariance axes, height, vertical datum
and checkpoint role before import; DEM-derived heights carry the DEM's declared accuracy,
and no accuracy is inferred from a good image match.

Reference COG conversion keeps full-resolution sample values; nearest-sample overviews are
for display only, and matching reads the original raster. Shader styles implement the same
band ranges, gamma and normalised-difference formula as the CPU previews (the index colour
ramp sampled into 33 stops).

---

## 9. CRS handling

Nothing assumes WGS84 or latitude/longitude. Each project has a working CRS (proj4); GCPs,
footprints and camera positions are stored in it and reprojected when it changes. The target
domain is polar aerial survey, i.e. **polar stereographic** projections, where a lat-lon
pipeline degenerates near the pole. Georeferencing (§6) produces CRS-tagged products
directly. Fits and adjustments are solved in a local metric frame (scale factor divided
out, curvature restored, §6.3) and mapped back to the grid; raster measurements report
ground values (grid ÷ k, area and volume ÷ k², heights unscaled) with k shown.

### 9.1 Vertical datums and the geoid

h = H + N. `core/verticalDatum.js` converts ellipsoidal ↔ EGM96 ↔ EGM2008 with NGA's grids
reduced to 15′ nodes (`scripts/build-geoid-grids.mjs`: every node exact, Int16 cm, 1.6 MB
each, precached for offline use), bilinear between nodes. Against PROJ with the full grids
EGM96 agrees to 5 mm and EGM2008 to 14 cm at p95 (47 cm at worst, short-wavelength geoid
under high relief), negligible against reference DEMs accurate to ≥ 1 m. National and local
height systems are recorded, never converted.

Where it applies: sampling a reference DEM into the asker's datum (Fill Z, Check Z,
reference picks, Find GCPs heights); an explicit GCP *Convert heights to…* (refits); the
georeference records the datum its control shares (`georef.verticalDatum`, unknown when
mixed) and stamps it on the DEM; DEM vs reference and DEM of difference convert the
reference into it. EXIF altitudes stay `unknown` (EXIF says "above sea level"; DJI varies by
model).

---

## 10. How the choices map to COLMAP

| Stage | WebSfM | COLMAP | Notes |
|---|---|---|---|
| Features | SIFT, RootSIFT (+ SuperPoint, DISK, ALIKED) | SIFT, RootSIFT | + duplicate-blob suppression |
| Matching | ratio + cross-check, or LightGlue | ratio + cross-check | |
| Verification | F (RANSAC, or MAGSAC++) + H (degeneracy) + inlier ratio + **positional spread** | F/E/H, GRIC | no E at match time; spread gate is extra |
| SfM type | incremental | incremental | same family |
| Resection | **P3P Lambda-Twist** + MSAC + GN | P3P + RANSAC | |
| BA | LM + Schur + adaptive Huber (from scratch) | LM + Schur (Ceres) | no external solver |
| Self-cal | shared f / cx,cy / k1–k3, p1, p2, staged by model size, the full lens in BA | full intrinsic groups | bitmask-selected; on by default (`auto`) |
| Distortion | Brown / rational / fisheye; BA fits the recorded pixels with the full lens | same models, in BA | the rest reads a pinhole view (§5) |
| Dense | PatchMatch MVS (CPU + WebGPU), ACMH + planar priors in Full | PatchMatch MVS | GPU path is WGSL |
| Georef | Horn 7-param + camera/GCP/DEM-constrained BA | model_aligner / GCP | |

Distinctive: **runs in the browser, client-side, no server**; **polar and non-WGS84 CRSs
first-class**; **scanned-film interior orientation** (fiducials, pixel pitch and film
format with sanity checks); the WebGPU PatchMatch path.

## 11. Quality diagnostics

Read-only, in the Quality Report: they derive from the finished graph and cloud and change
nothing, to show the user *where* a reconstruction is weak.

- **Match-graph bridge edges** (`core/eval/matchGraph.js` `bridgeEdges`): the bridges of the
  accepted-pair graph, by iterative Tarjan low-link. A bridge is the single link holding two
  sub-blocks together; a false match there would split the block. Shown as "fragile links",
  fewest inliers first.
- **Coverage** (`core/eval/coverage.js` `coverageGrid`): tie points binned into a top-down
  grid, each cell with its point count and **max view count** (2 = the triangulation
  minimum, ≥ 3 comfortable): the "where is my overlap thin" map, read off the oriented
  sparse points.
- **DEM vs reference** (§6.10): Nuth & Kääb shift, bias and NMAD on stable ground.
- **Accuracy at the checkpoints** (`core/eval/asprsAccuracy.js`), after the ASPRS Positional
  Accuracy Standards, Edition 2 (2023): per axis the mean error, standard deviation (n − 1)
  and RMSE of the checkpoint residuals (triangulated in the adjusted model minus surveyed);
  RMSE_H = √(RMSE_X² + RMSE_Y²), RMSE_3D = √(RMSE_H² + RMSE_V²). Edition 2 counts the
  checkpoints' own survey error in: RMSE = √(RMSE₁² + RMSE₂²), RMSE₁ the fit, RMSE₂ from each
  checkpoint's declared 1σ (RMSE_X₂ = √(mean σx²), likewise Y, Z; RMSE_H₂ = √(RMSE_X₂² +
  RMSE_Y₂²)). The standard's "tested to meet … accuracy class" sentence is written only with
  ≥ 30 checkpoints and their declared accuracy; the screens for a mean error over 25 % and a
  residual over 3 × the RMSE use the measured RMSE, as no target is known. The residuals test
  the photogrammetric adjustment, not a product: a DEM or orthophoto adds its own error.

## 12. Known limitations

- **Incremental SfM**: drift can accumulate on long strips. Interleaved BA, loop closures
  from exhaustive matching, and positions or GCPs inside BA (§6.4) limit it; there is no
  global (rotation-averaging) method.
- **Pairwise rotations from matching are unreliable**: verification fits F without
  calibration, and rotations decomposed from it with a nominal K were wrong by a median
  28.6° on true pairs of one run. Hence no pre-SfM graph filter (§4); rotation averaging
  would first need a five-point E at match time where K is known (the init pair already
  tries one, §4.2).
- **Sequential matching cannot see a revisit**: a two-lap set splits into two models; with
  no image retrieval (vocabulary tree) it needs exhaustive matching.
- **Doming without control**: with no GCPs or positions, a nadir block's height accuracy
  depends on the self-calibrated lens, decentring included (§4.6). Holding it to a reference
  DEM (§6.5) is the remedy where no control exists.
- **The focal of a nadir block** is fixed only by camera positions, GCPs or oblique photos
  (§4.6); without them its σ is several percent and heights scale with it. With RTK
  positions alone it is fixed to a few pixels, which still moves heights by a few
  centimetres (PUTI: WebSfM's focal 1.8 px shorter than Metashape's, +5 cm at the
  checkpoints, [BENCHMARKS](BENCHMARKS.md)). The solved lens is used for the run, never
  written to the sensor table without the user.
- **Fisheye**: rays beyond 75° off-axis are dropped at ingest and depth maps use 60° (§5),
  so a 200° lens keeps fewer keypoints than COLMAP and registers a few images fewer.
- **Panoramic satellite cameras** are split into frame segments; motion during the scan is
  not modelled, and there is no RPC model.
- **Dense quality is intrinsics-limited**: a default-FOV guess visibly distorts depth.
  Weakly textured surfaces remain the least complete part of a cloud; the Full method's
  planar priors (§7.2) target them.
- **One browser tab**: the reconstruction runs in 32-bit WebAssembly (4 GiB); fusion and
  the Poisson mesh use 64-bit memories where the browser has them, which bounds a dense
  cloud at about 1.4 G points (§7.4).

## 13. References

The published methods WebSfM implements, from `src/core/help/references.js` — the same
list the app shows (About ▸ References, each glossary entry's *Sources*, the Quality
Report's *Methods and references*). A unit test keeps this section in step with that file.

- Agarwal, S., Snavely, N., Seitz, S. M. & Szeliski, R. (2010). Bundle adjustment in the large. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-642-15552-9_3
- Arandjelović, R. & Zisserman, A. (2012). Three things everyone should know to improve object retrieval. IEEE Conference on Computer Vision and Pattern Recognition (CVPR). https://doi.org/10.1109/CVPR.2012.6248018
- ASPRS (2023). ASPRS Positional Accuracy Standards for Digital Geospatial Data, Edition 2, Version 1.0. American Society for Photogrammetry and Remote Sensing. https://publicdocuments.asprs.org/PositionalAccuracyStd-Ed2-V1
- Barath, D., Noskova, J., Ivashechkin, M. & Matas, J. (2020). MAGSAC++, a fast, reliable and accurate robust estimator. IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR). https://arxiv.org/abs/1912.05909
- Besl, P. J. & McKay, N. D. (1992). A method for registration of 3-D shapes. IEEE Transactions on Pattern Analysis and Machine Intelligence 14(2), 239–256. https://doi.org/10.1109/34.121791
- Bleyer, M., Rhemann, C. & Rother, C. (2011). PatchMatch stereo — stereo matching with slanted support windows. British Machine Vision Conference (BMVC). https://doi.org/10.5244/C.25.14
- Boykov, Y. & Kolmogorov, V. (2004). An experimental comparison of min-cut/max-flow algorithms for energy minimization in vision. IEEE Transactions on Pattern Analysis and Machine Intelligence 26(9), 1124–1137. https://doi.org/10.1109/TPAMI.2004.60
- Boykov, Y., Veksler, O. & Zabih, R. (2001). Fast approximate energy minimization via graph cuts. IEEE Transactions on Pattern Analysis and Machine Intelligence 23(11), 1222–1239. https://doi.org/10.1109/34.969114
- Brown, D. C. (1966). Decentering distortion of lenses. Photogrammetric Engineering 32(3), 444–462.
- Brown, M. & Lowe, D. G. (2007). Automatic panoramic image stitching using invariant features. International Journal of Computer Vision 74(1), 59–73. https://doi.org/10.1007/s11263-006-0002-3
- Burt, P. J. & Adelson, E. H. (1983). A multiresolution spline with application to image mosaics. ACM Transactions on Graphics 2(4), 217–236. https://doi.org/10.1145/245.247
- Chen, Y. & Medioni, G. (1992). Object modelling by registration of multiple range images. Image and Vision Computing 10(3), 145–155. https://doi.org/10.1016/0262-8856(92)90066-C
- Chum, O. & Matas, J. (2005). Matching with PROSAC – progressive sample consensus. IEEE Conference on Computer Vision and Pattern Recognition (CVPR). https://doi.org/10.1109/CVPR.2005.221
- DeTone, D., Malisiewicz, T. & Rabinovich, A. (2018). SuperPoint: self-supervised interest point detection and description. CVPR Workshops. https://arxiv.org/abs/1712.07629
- Fischler, M. A. & Bolles, R. C. (1981). Random sample consensus: a paradigm for model fitting with applications to image analysis and automated cartography. Communications of the ACM 24(6), 381–395. https://doi.org/10.1145/358669.358692
- Galliani, S., Lasinger, K. & Schindler, K. (2015). Massively parallel multiview stereopsis by surface normal diffusion. IEEE International Conference on Computer Vision (ICCV). https://doi.org/10.1109/ICCV.2015.106
- Garland, M. & Heckbert, P. S. (1997). Surface simplification using quadric error metrics. SIGGRAPH 97, 209–216. https://doi.org/10.1145/258734.258849
- Garrido-Jurado, S., Muñoz-Salinas, R., Madrid-Cuevas, F. J. & Marín-Jiménez, M. J. (2014). Automatic generation and detection of highly reliable fiducial markers under occlusion. Pattern Recognition 47(6), 2280–2292. https://doi.org/10.1016/j.patcog.2014.01.005
- Hartley, R. & Zisserman, A. (2004). Multiple View Geometry in Computer Vision (2nd edition). Cambridge University Press. https://doi.org/10.1017/CBO9780511811685
- Hartley, R. I. (1997). In defense of the eight-point algorithm. IEEE Transactions on Pattern Analysis and Machine Intelligence 19(6), 580–593. https://doi.org/10.1109/34.601246
- Horn, B. K. P. (1981). Hill shading and the reflectance map. Proceedings of the IEEE 69(1), 14–47. https://doi.org/10.1109/PROC.1981.11918
- Horn, B. K. P. (1987). Closed-form solution of absolute orientation using unit quaternions. Journal of the Optical Society of America A 4(4), 629–642. https://doi.org/10.1364/JOSAA.4.000629
- Kannala, J. & Brandt, S. S. (2006). A generic camera model and calibration method for conventional, wide-angle, and fish-eye lenses. IEEE Transactions on Pattern Analysis and Machine Intelligence 28(8), 1335–1340. https://doi.org/10.1109/TPAMI.2006.153
- Kazhdan, M. & Hoppe, H. (2013). Screened Poisson surface reconstruction. ACM Transactions on Graphics 32(3), 29. https://doi.org/10.1145/2487228.2487237
- Lindenberger, P., Sarlin, P.-E. & Pollefeys, M. (2023). LightGlue: local feature matching at light speed. IEEE/CVF International Conference on Computer Vision (ICCV). https://arxiv.org/abs/2306.13643
- Lowe, D. G. (2004). Distinctive image features from scale-invariant keypoints. International Journal of Computer Vision 60(2), 91–110. https://doi.org/10.1023/B:VISI.0000029664.99615.94
- Mark, R. K. (1992). Multidirectional, oblique-weighted, shaded-relief image of the Island of Hawaii. U.S. Geological Survey Open-File Report 92-422. https://pubs.usgs.gov/of/1992/of92-422/
- MicaSense (2017). MicaSense RedEdge and Altum image processing tutorials (imageprocessing). GitHub, MIT licence. https://github.com/micasense/imageprocessing
- Nistér, D. (2004). An efficient solution to the five-point relative pose problem. IEEE Transactions on Pattern Analysis and Machine Intelligence 26(6), 756–770. https://doi.org/10.1109/TPAMI.2004.17
- Olson, E. (2011). AprilTag: A robust and flexible visual fiducial system. IEEE International Conference on Robotics and Automation (ICRA), 3400–3407. https://doi.org/10.1109/ICRA.2011.5979561
- Persson, M. & Nordberg, K. (2018). Lambda Twist: an accurate fast robust perspective three point (P3P) solver. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-030-01225-0_20
- Rusu, R. B., Marton, Z. C., Blodow, N., Dolha, M. & Beetz, M. (2008). Towards 3D point cloud based object maps for household environments. Robotics and Autonomous Systems 56(11), 927–941. https://doi.org/10.1016/j.robot.2008.08.005
- Schönberger, J. L. & Frahm, J.-M. (2016). Structure-from-motion revisited. IEEE Conference on Computer Vision and Pattern Recognition (CVPR). https://doi.org/10.1109/CVPR.2016.445
- Schönberger, J. L., Zheng, E., Frahm, J.-M. & Pollefeys, M. (2016). Pixelwise view selection for unstructured multi-view stereo. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-319-46487-9_31
- Nuth, C. & Kääb, A. (2011). Co-registration and bias corrections of satellite elevation data sets for quantifying glacier thickness change. The Cryosphere 5(1), 271–290. https://doi.org/10.5194/tc-5-271-2011
- Vautherin, J., Rutishauser, S., Schneider-Zapp, K., Choi, H. F., Chovancova, V., Glass, A. & Strecha, C. (2016). Photogrammetric accuracy and modeling of rolling shutter cameras. ISPRS Annals of the Photogrammetry, Remote Sensing and Spatial Information Sciences III-3, 139–146. https://doi.org/10.5194/isprs-annals-III-3-139-2016
- Wang, J. & Olson, E. (2016). AprilTag 2: Efficient and robust fiducial detection. IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS), 4193–4198. https://doi.org/10.1109/IROS.2016.7759617
- xDEM contributors (2026). xDEM: analysis of digital elevation models for geosciences. Software, Zenodo. https://doi.org/10.5281/zenodo.4809697
- Shepard, D. (1968). A two-dimensional interpolation function for irregularly-spaced data. Proceedings of the 23rd ACM National Conference, 517–524. https://doi.org/10.1145/800186.810616
- Stewénius, H., Engels, C. & Nistér, D. (2006). Recent developments on direct relative orientation. ISPRS Journal of Photogrammetry and Remote Sensing 60(4), 284–294. https://doi.org/10.1016/j.isprsjprs.2006.03.005
- Taubin, G. (1995). A signal processing approach to fair surface design. SIGGRAPH 95, 351–358. https://doi.org/10.1145/218380.218473
- Triggs, B., McLauchlan, P. F., Hartley, R. I. & Fitzgibbon, A. W. (2000). Bundle adjustment — a modern synthesis. Vision Algorithms: Theory and Practice, LNCS 1883, 298–372. https://doi.org/10.1007/3-540-44480-7_21
- Tyszkiewicz, M. J., Fua, P. & Trulls, E. (2020). DISK: learning local features with policy gradient. Advances in Neural Information Processing Systems (NeurIPS) 33. https://arxiv.org/abs/2006.13566
- Waechter, M., Moehrle, N. & Goesele, M. (2014). Let there be color! Large-scale texturing of 3D reconstructions. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-319-10602-1_54
- Xu, Q. & Tao, W. (2019). Multi-scale geometric consistency guided multi-view stereo. IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR). https://arxiv.org/abs/1904.08103
- Xu, Q. & Tao, W. (2020). Planar prior assisted PatchMatch multi-view stereo. AAAI Conference on Artificial Intelligence 34(07), 12516–12523. https://doi.org/10.1609/aaai.v34i07.6940
- Weinmann, M., Jutzi, B., Hinz, S. & Mallet, C. (2015). Semantic point cloud interpretation based on optimal neighborhoods, relevant features and efficient classifiers. ISPRS Journal of Photogrammetry and Remote Sensing 105, 286–304. https://doi.org/10.1016/j.isprsjprs.2015.01.016
- Woebbecke, D. M., Meyer, G. E., Von Bargen, K. & Mortensen, D. A. (1995). Color indices for weed identification under various soil, residue, and lighting conditions. Transactions of the ASAE 38(1), 259–269. https://doi.org/10.13031/2013.27838
- Zhang, W., Qi, J., Wan, P., Wang, H., Xie, D., Wang, X. & Yan, G. (2016). An easy-to-use airborne LiDAR data filtering method based on cloth simulation. Remote Sensing 8(6), 501. https://doi.org/10.3390/rs8060501
- Zhao, X., Wu, X., Chen, W., Chen, P. C. Y., Xu, Q. & Li, Z. (2023). ALIKED: a lighter keypoint and descriptor extraction network via deformable transformation. IEEE Transactions on Instrumentation and Measurement 72. https://arxiv.org/abs/2304.03608
