# websfm — methods & algorithms (the SfM/photogrammetry reference)

The *science* companion to CLAUDE.md. CLAUDE.md answers "where does the code
live"; this file answers "**what method is it, and why that one**" — the questions
a photogrammetry colleague asks: which bundle adjustment, which distortion model,
which P3P, how is georeferencing done. It is deliberately implementation-light:
enough pointers to find the code, but the content is the algorithms, the
conventions, the parameters, and the trade-offs.

Keep it current: when a *method* changes (a new solver, a different cost function,
a new model), update the relevant section here — same discipline as the other
three docs. Code-structure churn does **not** belong here (that's CLAUDE.md); task
status does **not** belong here (that's TODO.md/HANDOVER.md).

---

## 0. One-paragraph summary (for the "so what does it do" question)

websfm is an **incremental** (sequential) Structure-from-Motion pipeline followed
by **PatchMatch multi-view stereo** densification and raster product generation
(DEM, orthophoto), running entirely client-side in the browser (Rust→WASM for the
heavy math). It is a from-scratch implementation in the COLMAP tradition — SIFT
features → ratio-test + RANSAC-verified matching → two-view seed → incremental
PnP resection with interleaved bundle adjustment → dense MVS → DEM/ortho. It is
built for **historical aerial imagery over polar regions** (Antarctica), so
non-WGS84 / projected CRS handling and scanned-film intrinsics are first-class
rather than afterthoughts.

## Conventions (state these once, reuse everywhere)

- **Camera model**: pinhole, `x_cam = R·X_world + t`, projection `u = K·[R|t]·X`.
  Intrinsics `K = [[fx,0,cx],[0,fy,cy],[0,0,1]]`. Rotations are row-major
  `[[…],[…],[…]]`, translation `t=[x,y,z]`, **camera centre `C = −Rᵀt`**.
  Projection matrices are stored flat, 12 elements `[R|t]`, **without K** (K is
  applied separately / points are normalised first).
- **Distortion**: Brown–Conrady, but **removed once at ingest** — the entire
  geometric pipeline (init, PnP, triangulation, BA, MVS, ortho) is pure pinhole.
  See §6.
- **Normalised coordinates**: `x = (u − cx)/fx`, `y = (v − cy)/fy`. Distortion
  math and the essential matrix live here.
- **Units**: reprojection error in **pixels**; parallax/triangulation angles in
  **degrees**; GCP/CRS residuals in the project CRS units (metres for polar
  stereographic).

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
              ├ rotation-cycle filter (prune false pairs)
              ├ two-view init (F→E→pose, DLT triangulate, seed pick)
              ├ incremental resection (P3P + MSAC PnP, track extension)
              ├ interleaved + final bundle adjustment (LM + Schur + Huber)
              ├ retriangulation + split-track merge + 2-pass track filter
              └ optional GCP-anchored BA
              ▼
       [4] dense MVS (PatchMatch depth maps → geometric fusion)
              ▼
       [5] products (local vertical frame → DEM → orthophoto)  [+ optional georef]
```

Stages 1–2 are embarrassingly parallel (per-image / per-pair); stage 3 is
inherently sequential; stages 4–5 are per-image then fused/rasterised.

---

## 2. Feature detection

**Method**: SIFT (Lowe 2004), our own Rust implementation in `crates/sift` —
Difference-of-Gaussians scale space, orientation assignment, 128-d gradient
histogram descriptors, sub-pixel + sub-scale extremum refinement.

**Scale-space construction** (Lowe §3, and worth stating because we got it wrong
until 2026-07-17): each octave holds `s+3` Gaussians at σ_i = σ0·k^i (σ0 = 1.6,
k = 2^(1/3), s = 3), and the octave's **base already carries σ0** — octave 0's from
blurring the input, octaves 1+ from halving the previous octave's σ0·k³ = 2σ0 level,
which lands back at σ0 in the new pixel grid. So level 0 *is* the base and must not
be re-blurred, and each later level adds only the **increment** σ_{i-1}·√(k²−1)
rather than being re-blurred from the base by the full σ_i (Gaussians compose in
quadrature, so the levels are identical either way — but the increments are ~0.77×
the absolute sigmas, and with a 3σ kernel radius that is most of the pyramid's cost).

We previously re-blurred every octave base by σ0, giving octaves 1+ an effective
σ0·√2 at level 0 and a uniformly over-blurred pyramid. Two consequences, the second
of which is the one that matters: reported keypoint `scale` was wrong above octave 0
(it sizes the descriptor window), and — because adjacent over-blurred levels differ
*less* — the DoG response was flattened, so coarse-scale extrema failed the contrast
threshold and were **silently discarded**. Fine texture still fired in octave 0, so
the symptom was not "no keypoints" but a quiet loss of large-scale structure and a
`contrastThreshold` whose effective meaning was scale-dependent. Fixing it materially
raises keypoint yield at a given threshold and shifts the mix toward coarse scales,
so the `DETECT_SIFT_DEFAULTS` presets are calibrated against the corrected pyramid.

**Non-standard bits worth mentioning to a colleague:**
- **Duplicate-keypoint suppression** (`suppress_duplicate_positions`,
  response-weighted descriptor NMS): one strong blob can fire as a DoG extremum
  across adjacent scales/octaves, producing several index-distinct keypoints
  within ~2 px. Left in, these poison matching (many-to-one convergence, §3) and
  BA. They are suppressed at detection.
- **Descriptor width is per-detector, not a constant**: 128 for SIFT, 256 for the
  optional learned **SuperPoint** detector (ONNX via `onnxruntime-web`). Carried
  as `descDim`; a wrong dim mis-slices the flat descriptor buffer.
- **Tiled detection** for very large scans: image is split into an overlapping
  grid, detected per tile, then seams de-duplicated by NMS (`core/features/tiling.js`).
- **Colour** is sampled per keypoint at detection and later median-aggregated per
  track for the coloured sparse cloud.

**Alternatives available**: SIFT (default, classical, rotation+scale invariant) or
SuperPoint (learned, better on low-texture / repetitive scenes, needs the model).

---

## 3. Feature matching & geometric verification

Pairwise, exhaustive by default (every image pair), with two cost-cutting
prefilters.

**Descriptor matching** (`core/features/bruteforce.js` or the learned
`lightglue.js`): mutual nearest-neighbour (**cross-check**) + **Lowe ratio test**
(`d1/d2 < ratio`, default ~0.8). LightGlue is an attention-based learned matcher
run as an alternative to brute-force.

**Geometric verification** — this is where we are stricter than a textbook
pipeline. Every candidate pair (both matcher paths) passes through
`core/features/verify.js`:
1. **Fundamental-matrix RANSAC** (`verify_matches_hf`, 8-point + RANSAC in
   `crates/matching`) → inlier mask + inlier count. It also fits a homography so
   an **H-vs-F** degeneracy signal is available.
2. **Inlier-ratio gate** — rejects spurious epipolar fits on repetitive structure
   (a low inlier/putative ratio even when the absolute count looks fine).
3. **Positional-spread gate** (`inlierSpread`) — a geometry check no count/ratio/
   H-F test can see. Rejects a pair whose accepted inliers either
   (a) **collapse to few unique locations** (many-to-one convergence — several
   distinct A-points matching a stack of keypoints at ~one B-location, the
   duplicate-blob signature), or (b) **pile into one tiny image region**
   (epipole degeneracy). Measured as unique rounded positions + bounding-box
   diagonal, per image.

The accept/reject decision is a pure function (`core/features/pairGate.js`
`evaluatePairAcceptance`). Its floors are **decoupled** so one knob can't sever
the graph: `minMatches` is the accept + H-skip floor, a separate `rawSkipFloor`
(clamped ≤ minMatches) gates the pre-verification raw-putative skip.

**Weak pairs** (COLMAP-style registration robustness): a pair with a valid F and
enough inliers (`weakMinInliers`) but below the accept gate is not discarded — it's
kept flagged `weak`. Weak pairs are **registration bridges only**: they feed 2D-3D
correspondences to PnP (`register.js`, via `corrPairs = strong + weak`) but never
seed initialisation, the rotation-cycle filter, or fresh triangulation (their
geometry isn't trusted enough to build structure). This keeps a low-overlap chain
link (e.g. a 227-inlier film pair a user's raised `minMatches=500` would sever) in
the graph. Positionally-degenerate pairs stay hard-rejected, never weak.

**Disabled-pair flag**: a user can reversibly exclude an obviously-wrong pair
(`setPairDisabled`); disabled pairs are filtered wherever SfM reads matches.

**Prefilters** (cut the O(N²) pair cost):
- **Preselection** (`preselect.js`) — when imported camera positions exist, only
  match each image's k-nearest neighbours by camera position.
- **Subset gate** (`subsetGate.js`, brute-force, no-poses case) — pre-match a
  small **spatially-uniform** keypoint subset (`pickSpreadIndices` grid-buckets so
  a repetitive façade doesn't collapse the sample onto its few strong blobs);
  skip the full O(Na·Nb) match if too few survive. Keeps exhaustive *coverage*
  (loop closures still found) at a fraction of the cost.

---

## 4. Sparse SfM — incremental reconstruction

Orchestrated in `core/sfm/sfm.js`; the numerical kernels are in
`crates/reconstruction`. This is a **sequential/incremental** SfM (add one camera
at a time), not global/hierarchical.

### 4.0 Rotation-cycle consistency filter (pre-SfM pruning)

Before any reconstruction, `rotationCycleFilter` (`core/sfm/cycleFilter.js`)
prunes verified-but-false pairs that clear every count/ratio gate but whose
**relative rotation is inconsistent with the match graph**. For every triangle of
pairs, the composed relative rotation `R_ik⁻¹ · R_jk · R_ij` must be ≈ identity;
greedily drop the edge that fails the most of its triangles. Relative rotations
come from decomposing each pair's essential matrix. This is the classic loop-
consistency idea applied as a cheap graph cleaning step.

Because the filter runs **before self-calibration**, uncorrected lens distortion
biases the pairwise rotations and it can drop **true** edges. Two guards
(`core/sfm/cycleFilter.js`): (1) **bridge protection** never drops the sole link
between two sub-graphs (severing is unrecoverable; a bad pose is caught downstream
by the PnP gates — though, since a drop candidate always lies on a 3-cycle, this is
provably a no-op for the current drop gate and is kept only as insurance). (2)
**Post-self-cal re-admission** (`reevaluateDroppedEdges` + the final second-chance
sweep in `sfm.js`): once the first fold has corrected the keypoints, dropped edges
are re-judged — F is re-fit on the folded keypoints, rotations recomputed for
candidates **and** survivors with the refined Kmap (so corrected candidates aren't
judged against uncorrected survivors), and consistent ones re-admitted, then one
more registration sweep runs in case a re-admitted bridge lets a stranded camera
resect.

### 4.1 Intrinsics resolution (`resolveK`)

`K` is derived per image from EXIF focal length + sensor/film format, or from a
sensor-table calibration. For scanned aerial film there is a **pixel-pitch path**
(scan resolution × format) that can silently produce an off-standard implied film
width (~9% focal error observed on a real set) — flagged in the log against the
standard ~230/240 mm aerial format. A declared **film/sensor format therefore
outranks the pitch** when both are known: a format comes off a calibration
certificate and is measured, whereas a pitch is typically inferred from the scanner
setting and is the value that goes wrong. If nothing is known, a **default-FOV guess**
(`fx = image width`) is used and loudly warned: wrong intrinsics both distort the
geometry and commonly *prevent* cameras from registering.

### 4.2 Two-view initialisation (`core/sfm/initPair.js`)

The seed pair is the single best predictor of how the model grows, so we do **not**
just take the highest inlier count. We probe up to `initCandidates` (default 8)
pairs with the most inliers and for each:
- `F → E` (`fundamentalToEssential`, applying `K_A`, `K_B`),
- **pose recovery** by essential-matrix decomposition (`recoverPose`) with
  cheirality (points-in-front) disambiguation of the 4-fold sign ambiguity,
- **DLT triangulation** of all matches, keep only points passing cheirality in
  both cameras,
- record **median triangulation angle** (parallax) and **init reprojection**.

Selection rule: among candidates clearing the **parallax floor** (`minInitAngleDeg`,
default 2°) take the **lowest init reprojection** seed; if none clear it, fall back
to the widest baseline. A quality signal logged here is the **essential-matrix
conditioning** σ2/σ1 (ideal ≈ 1; well below 1 ⇒ wrong focal length). Picking by
parallax + reprojection, not inlier count, avoids locking onto a near-degenerate
tiny-baseline seed whose points collapse to a line.

### 4.3 Incremental resection (PnP)

New cameras are added one at a time (`solve_pnp` in `crates/reconstruction`):
- **P3P — Lambda-Twist** (Persson & Nordberg, ECCV 2018) as the minimal solver
  inside RANSAC. Recovers per-point depths along the bearing rays, reconstructs
  the 3 points in the camera frame, aligns to world with a rigid **Procrustes**
  fit. Chosen over DLT resection because it is far more stable on the **near-planar**
  geometry of aerial/terrain scenes — this is "the reason aerial cameras register".
- **MSAC** robust scoring (RANSAC variant with a smooth truncated cost) over the
  P3P hypotheses.
- **Gauss–Newton** pose polish on the inlier set (`pose.rs`).

**Correspondence hygiene** before PnP (`collectCorrespondences`): a 2D–3D
correspondence is only used when **bijective** — one 3D point ↔ one new keypoint.
Both `many→one` (ambiguous) and `one→many` (split track / repetitive structure)
are detected and dropped, because the extras mechanically depress the PnP inlier
ratio while feeding RANSAC contradictory constraints (the "many correspondences,
few inliers" stall).

**Acceptance gating — two gates** (deliberately conservative):
- a **fixed** PnP inlier threshold for the whole run (`pnpThresh`) — it never
  chases the model's p95 upward (an adaptive gate loosens exactly when the model
  is worst, admitting bad poses that poison it further);
- **Gate 1 (at the PnP threshold):** require **both** an absolute inlier floor
  (`minPnpInliers`) **and** an inlier fraction (`minPnpInlierRatio`) — a 6/137 = 4%
  "coincidence fit" is rejected.
- **Gate 2 (refine-then-recheck):** after the Gauss–Newton polish, recount how many
  correspondences fall within the *tight* reprojection threshold (not the looser PnP
  gate) and require the fraction again (`minPnpRefineInlierRatio`). A pose that only
  holds up at the loose gate is a weak fit — deferred, not accepted.
- Deferral is cheap: the sweep retries the image on every later pass, by which
  point interleaved BA has tightened the model.

**Ordering — next-best-view (COLMAP-style):** at each pass, unregistered images are
tried in order of a next-best-view score = count of correspondences to
**well-triangulated** (≥2-view) points, weighted by how spatially spread those
observations are (a 4×4 grid-bucket occupancy fraction — a pose constrained by a
tight cluster is ill-conditioned). Raw inlier connectivity to the registered set is
the tie-break (and the fallback for candidates with no well-triangulated
correspondences yet). Correspondences are swept once per pass and cached — reused for
both the score and the subsequent PnP attempt until a registration grows the model.

**Stalled-model rescue (one shot).** A full sweep that registers nothing while images
still *link* to the model has two signature causes. On short film strips the end
frames fail on a slightly-wrong focal (self-calibration only runs post-filter, after
registration) plus a structure gap in their overlap. The other — and on consumer
wide-angle imagery the more common — is a **distortion deadlock at the seed pair**: a
2-view model can absorb radial distortion into its point positions, so the seed's
reprojection looks excellent while the geometry is wrong, and the third view is the
first to expose it (inlier ratios in the 10–30% band against the acceptance gate). The
in-registration self-calibration that would break this (§4.6) only engages once the
model has `distortionCalMinCams` cameras, which it never reaches. Chicken-and-egg: a
model can be *stuck at exactly two cameras*, which is why the rescue triggers from two
cameras up rather than three.

Before giving up, run one rescue round — a **focal-only** bundle adjustment
(`refineIntrinsics: 'f'`, well-constrained even on the pre-filter set, unlike cx/cy or
k1) to correct the focal, plus a **retriangulation** pass to grow structure into the
stalled overlaps — then retry the sweep **once** with a relaxed refine-recheck (recount
at the PnP gate instead of the tight reprojection threshold, ratio `rescueRefineRatio`).
At a 2-camera stall the focal solve is skipped and only retriangulation + the relaxed
sweep run: *no* intrinsic is identifiable from two views, so a focal fitted there would
be fitting noise. The relaxed sweep is not a lowering of standards but a bootstrap — the
cameras it admits carry the model past the self-calibration threshold, at which point
the distortion is measured and folded out of the keypoints (§5) and every subsequent
sweep runs against pinhole geometry at the strict gates. The absolute inlier floor and
the first PnP gate still apply throughout, and the final BA + track filter clean any
loose observations, so this rescues genuinely-linked frames without manufacturing a
pose. One shot, by design. Off via `rescueStalled: false`.

Corollary: **self-calibration is refused below 3 cameras** in the post-filter passes
too (§4.6). A 2-camera model returns whatever k1 the noise prefers — observed flipping
sign between passes on a 5-image set — and the fold that follows is destructive
(it moves keypoints), so no refinement beats a confident wrong one.

### 4.4 Track management

A **track** = one 3D point observed across ≥2 images. A reverse index
(`keypoint → point`, per image) makes track extension O(1). On registering a
camera, its PnP-inlier correspondences **extend existing tracks** (grow to 3+
views, a much stronger BA constraint) rather than spawning duplicate 2-view
points; only matches where *neither* endpoint is yet on a track are triangulated
fresh. A later `foldOneEndpointMatches` pass folds in observations where exactly
one endpoint was already assigned (raises the ≥3-view share).

### 4.5 Bundle adjustment (`crates/reconstruction/src/bundle.rs`)

**Which BA?** Sparse **Levenberg–Marquardt** with the **Schur complement**
(points eliminated against cameras), analytic Jacobians, and **adaptive Huber**
robustification. From scratch, dependency-free (no Ceres/g2o). This is the same
family as COLMAP's BA; the specifics:

- **Parameterisation**: each camera is 6-DOF — translation `t` plus a
  **left-perturbed so(3)** rotation update `R ← exp(δω)·R` (minimal 3-parameter
  rotation increment, no gimbal issues). 3D points are 3-DOF.
- **Schur complement**: the per-point 3×3 blocks are eliminated, leaving a reduced
  camera(+intrinsic) system solved by **dense Cholesky** (`chol_solve`). Note for
  scaling questions: the dense reduced solve is the one piece to swap for an
  iterative preconditioned-CG Schur solve at very large camera counts.
- **Robust cost**: **Huber**, with an **adaptive threshold** = 2.5 × median
  residual (recomputed each outer iteration, floored at 1 px), applied as an IRLS
  weight `w = min(1, δ/‖r‖)`. Tracks the noise floor as the model tightens so
  gross mis-triangulations don't drag the solution.
- **LM damping**: standard multiplicative λ schedule with up to 8 damping retries
  per iteration; a step is accepted only if it lowers the robust cost, and the
  whole solve is **guarded** at the orchestration level (a result that worsens RMS
  is rejected, not committed).
- **Cost reported**: RMS reprojection error in pixels, before/after, plus a
  per-iteration convergence trace (used to tell "plateaued" from "still
  descending — raise iterations").

**Interleaved BA**: a global BA + track-filter runs every `interimBaEvery` new
cameras (COLMAP-style), so later PnP registers against a tight model and the final
BA starts near the optimum — instead of one big solve on a drifted model that
lands in a bad minimum.

### 4.6 Self-calibration (optional intrinsics refinement in BA)

BA can refine a **small, shared** set of intrinsics per **sensor group** (cameras
sharing a sensor id share the parameters; unassigned cameras are their own group).
The terms are a **bitmask** (`bundle.rs` `refine_mask`: 1=f, 2=cxcy, 4=k1, 8=k2,
16=k3; the JS `refineModeMask` parses a comma string like `'f,cxcy,k1,k2,k3'`):
- `f` — a focal **scale** `s` (init 1, multiplies fx/fy; fy stays locked to fx).
  Modelling focal as a scale, not an absolute, preserves per-camera seed
  differences while sharing one DOF across the group.
- `cxcy` — shared principal-point offsets `dcx, dcy`.
- `k1,k2,k3` — the shared radial polynomial. The BA forward model is
  `u = fx·a·(1 + k1·r² + k2·r⁴ + k3·r⁶) + cx` with **exact analytic Jacobians**
  (the pose/point terms generalise the pinhole+k1 case by replacing `k1` with
  `g ≡ k1 + 2k2·r² + 3k3·r⁴`). Tangential `p1,p2` are out of scope for self-cal.

**Self-calibration is on by default.** The shipped default is `refineIntrinsics:
'auto'`, which `sfm.js` resolves per run: **staged** when **no** sensor carries a
calibrated distortion model (EXIF-only cameras / film scans — a guessed pinhole is
the single biggest downstream error source), and `'none'` when a calibrated Brown
model already removed distortion at ingest (don't double-correct). An explicit
comma string overrides the resolution and bypasses staging.

**Staged schedule** (`core/sfm/selfCalSchedule.js`, `auto` only): distortion is
barely observable on a thin model, so the terms unlock as it grows. Registration
(interim/rescue BA) solves the base `f,k1`; the **post-filter** passes escalate —
add `k2` at ≥8 cams & ≥10k obs, principal point at ≥10 cams, `k3` at ≥20 cams &
≥30k obs. Deferred terms are logged. Self-cal is **only** run on post-filter passes
(and the in-registration interim BA once `distortionCalMinCams` cameras are in —
never on the pre-filter mess, which drifted cx/cy ~180 px on a test set), and it is
**weakly observed** on short/single strips (needs ≥2° tilt variation). Results are
logged but **never** written back to the sensor table automatically.

**Important invariant — the pinhole fold.** Because the rest of the pipeline is
pure pinhole, radial coeffs left on the model would be invisible to reprojection
stats, the track filter, and the dense/ortho warp. So after each self-cal pass we
**fold the full `{k1,k2,k3}` bag into the keypoints** (`undistortPixel` is the
exact inverse of BA's forward model) and reset the model coeffs to 0; `cx/cy` stay
on K (projectPoint reads them). Multi-pass composition is handled by snapshotting
each image's **pristine** (pre-first-fold) keypoints and, after each pass,
fitting **one composed `{k1,k2,k3}` bag** that maps pristine → fully-folded via a
linear least-squares (`core/sfm/selfCalCompose.js`, `fitComposedRadial` — the
forward radial model is linear in the coeffs given the radius). That single
composed bag — not a per-pass sum, which is wrong beyond first order — is what
`summary.selfCalDistortion` carries so the **dense** stage reproduces the exact
same undistortion (applied as a second bag after any calibrated `dist`). A
monotonicity guard warns if a higher-order fit runs away. One single source of
truth for distortion, ingest → dense.

### 4.7 Retriangulation, split-track merge, track filtering

After BA settles: **retriangulate** pairs (`retriangulatePairs`) with the improved
poses, **merge split tracks** (`mergeSplitTracks` — the same physical point that
got triangulated twice), and a **2-pass track filter** removing observations /
points on two criteria: reprojection error above `filterMaxReprojPx`, and
triangulation angle below `filterMinTriAngleDeg` (ill-conditioned near-zero-
parallax points). BA is re-run after filtering.

---

## 5. Camera model & lens distortion

**Model**: **Brown–Conrady** — radial `k1,k2,k3` + tangential `p1,p2`.
Forward: `x_d = x·(1 + k1·r² + k2·r⁴ + k3·r⁶) + [2·p1·xy + p2·(r²+2x²)]` (and the
symmetric `y_d`), in normalised coords. Inverse by **fixed-point iteration** (the
standard OpenCV scheme, ~8 iterations; strong fisheye is explicitly out of scope).

**Selectable distortion models** (`DISTORTION_MODELS`, chosen per sensor):
`pinhole` (none) · `radial` (k1) · `radial2` (k1,k2) · `brown` (k1,k2,k3,p1,p2).
`distortionOf` applies **only the active model's** coefficients, so a stale k3 from
a model switch can't leak. (A sensor with no model set falls back to all five for
back-compat with pre-model saves.)

**Removed once at ingest** (the load-bearing design choice): sparse keypoints are
undistorted per-point (`undistortPixel`); dense/ortho rasters are undistorted by
building an undistorted→distorted sample map (`distortNormalized`, closed-form
forward). Everything between — F/E, PnP, triangulation, BA, PatchMatch, DEM,
ortho — is pure pinhole and never has to know about distortion. The only
approximation is that the pairwise F used to pick the init pair is still a
distorted-space fit; global BA corrects it.

### 5.1 Interior orientation for film scans (`core/sfm/fiducials.js`)

Scanned historical film has **scan geometry ≠ camera geometry**: each scan places
the film frame differently (translation, rotation, slight scale/shear from the
scanner), so the principal point and pixel pitch are otherwise only guessed (scan
centre, user-entered pitch). A metric film camera exposes **fiducial marks** (4 or
8) whose positions the calibration certificate gives in **millimetres in the camera
frame**, plus the calibrated focal length and principal point.

A sensor is declared **`kind: 'film'`**. The current model deliberately separates
`image.fiducialDetections` (anonymous raster slots and scan-pixel centres) from
`sensor.fiducialCalibration` (slot-to-mark identity, metric coordinates, focal
length and principal point). Detection can therefore run and be reviewed before a
camera certificate is available. At SfM ingest, and only there, the two records are
joined into calibrated point pairs and we:

1. **Fit a per-image transform** `scan px → camera mm` by least squares from the
   paired observations (`fitFiducialTransform`): conformal, affine (default), or
   projective according to calibration. This recovers pixel pitch and the RMS
   residual (µm) as the audit number; affine also reports rotation/shear.
2. **Define one canonical pixel frame per sensor** (`canonicalFrame`): a virtual
   pixel grid at the **median** fitted pitch, with `fx = fy = focalMm / pitch` and
   the principal point mapped into the grid — so all images of the sensor share
   **one K**.
3. **Move each image's keypoints** `scan → mm → canonical px` (`scanToCanonical`),
   positions only, indices preserved.

This is the **exact analogue of lens distortion**: scan geometry, like distortion,
is removed **once at ingest**, so the whole pipeline (init, PnP, BA, PatchMatch,
DEM, ortho) stays pinhole with one shared K. `resolveK` gains a **path 0** that
returns the fiducial-derived canonical K. The dense stage reproduces the exact
same per-image transform (recorded in the run summary — it must **not** re-fit) and
composes `canonicalToScan` into its raster sample map. GCP observations, which are
also in scan space, are pushed through the same map at ingest.

**Distortion ordering**: the certificate's radial distortion is defined in the
camera mm frame about the principal point, so the chain is
`scan px →(affine)→ mm →(lens undistort)→ ideal mm → canonical px`. Since the
canonical frame is a pure scale+offset of the mm frame, applying the existing Brown
`undistortPixel` in *canonical* px with the canonical K is mathematically
identical — no new distortion code. **Residual interpretation**: the fit RMS is in
µm; anything above ~½ a pixel pitch (≈ scanner noise) flags mis-clicked marks. Same
init-pair caveat as distortion: pairwise F from matching is a scan-space fit that
BA corrects. (Fitting k1/k2 from a certificate's distortion *table* is a follow-up,
out of v1.)

#### Anonymous fiducial detection (`core/sfm/fiducialDetection.js`)

**Detect Fiducials** is an image-measurement task and does not read certificate
marks, focal length, principal point or a pre-marked reference image. The user
declares only image priors: Generic, Right angle, 45° cut or Frame; corner, side or
combined positions; polarity; and tolerance. A coarse grayscale analysis finds the
film bounds and searches the corresponding anonymous raster slots. Accepted peaks
are refined in native-resolution crops. Frame mode measures the frame intersections
themselves and is explicitly not presented as a substitute for physical camera
fiducials.

Across a batch, normalized positions are combined per slot and the strongest safe
scan supplies real ZNCC donor patches. Incomplete scans are retried around those
batch-relative positions. This improves appearance matching without introducing a
metric layout dependency. Confident candidates are persisted as
`fiducialDetections`; uncertain candidates remain drafts until explicitly accepted
or rejected. A confident measured frame may also generate a mask for scanner
background outside the film rectangle.

**Calibrate Fiducials** is a separate task (`core/sfm/fiducialCalibration.js`). In
certificate mode, raster slots are mapped to named metric marks. In batch mode, a
robust centred layout is estimated from repeated detections and a declared scan
pitch fixes its scale. Both paths validate per-image fits and report RMS/p95; a
positive calibrated focal length is required before applying the calibration.
Uncalibrated detections remain useful for review but have no effect on sparse or
dense reconstruction. Legacy observation/layout records are migrated on project
restore.

#### Legacy calibrated-layout measurement (`core/sfm/fiducialDetect.js`)

The earlier layout-dependent detector remains compatibility code for migrated
projects and unusual prepared-reference workflows; it is no longer the Detect
Fiducials UI path.

Clicking 4–8 marks on every frame of a film block is the most tedious step above.
The default path therefore starts without a marked reference image. Analytic,
scale-pyramidal prototypes cover generic dot/ring/crosshair, right-angle and
45-degree-cut marks; strong row/column transitions provide the separate frame
mode. The calibration-certificate layout is normalized into the measured film
rectangle, rotated by the user-declared batch orientation, and each physical mark
is searched only in its predicted edge/corner region. Detection is followed by a
native-resolution crop refinement and the same affine geometry gate used by the
interior orientation. Certificate coordinates are still required: autonomy removes
scan-pixel clicking, not metric camera calibration.

The strongest geometrically accepted image then becomes an **automatic template
donor**. Real scan patches are cut around its refined centres and the existing ZNCC
matcher retries images that the analytic prototypes could not measure. Thus the
detector learns the batch appearance without requiring the user to prepare a
reference first. Unresolved images remain untouched and open in the existing image
fiducial editor, whose three placed marks predict ghost locations for the rest.
The legacy explicitly marked-reference path remains available for unusual designs.

A square template is cut around each accepted donor (or legacy reference) fiducial and
matched, **coarse to fine**, in each target: a downscaled pass over a search window
around the predicted position, then a full-resolution pass around that peak, then a
sub-pixel refinement fitting a separable parabola to the ZNCC peak's 3×3
neighbourhood. Predictions come from the target's own interior orientation when it
already has ≥3 marks (`fitFiducialAffine` + `mmToScan`), otherwise from the
reference's click positions scaled by the size ratio. **ZNCC** rather than plain
correlation because scans of one batch differ in exposure and development density;
zero-mean + energy normalization makes the score invariant to exactly that affine
intensity change.

An optional probe resolves a **90° scan rotation** (a frame fed through the scanner
sideways) by scoring all four orientations at their respectively-rotated predicted
positions and taking the winner only if it beats *every* alternative by a margin.
This is decidable far less often than it looks: fiducial marks are identical to one
another, so under the textbook symmetric 4-corner layout every rotation aligns every
mark with *some* real mark and no template evidence separates the hypotheses. The
margin rule then keeps k=0 — the correct failure, since a batch is normally scanned
in one consistent orientation, and a confident wrong k would mis-assign every mark
id at once.

**QC is the point of the feature** — an automatically mismeasured mark is worse than
an unmeasured one, because a wrong interior orientation propagates silently into
every pose. Three gates run in order:

1. **Absolute** — a detection below the ZNCC floor is rejected.
2. **Population** — per mark, the median score across the whole batch; detections
   far below their own mark's median are rejected. This is what catches
   *confident-wrong* matches: a mark that locks onto the wrong feature can still
   clear an absolute floor, but not the standard its own mark sets on every other
   scan of the batch. It needs the whole batch, so detections are buffered and
   applied in a second pass.
3. **Geometric** — fit the interior-orientation affine to the survivors; over the
   RMS gate, drop the single worst mark (chosen by leave-one-out refit, not by
   largest residual, which masking makes unreliable) and refit once. Still over ⇒
   the image fails and **nothing is written** for it.

Gate 3's repair requires **≥5 marks**. An affine has 6 DOF, so any 3 points fit one
exactly: with the common 4-mark camera, dropping the true outlier and dropping a
good mark both leave a 3-point exact fit, and the outlier is mathematically
unlocalizable. Four-mark images that miss the gate therefore fail outright rather
than have a coin flip decide their interior orientation — the same lesson as the GCP
robust fit (§6.5): never let a fit the outlier has already dragged decide which point
is the outlier.

---

## 6. Ground control points & georeferencing

Two independent roles for GCPs, both implemented.

### 6.1 Post-hoc similarity fit (`core/products/georef.js`)

The SfM world frame is arbitrary (7-DOF gauge freedom: scale + rotation +
translation). To emit products in a real CRS we fit a **7-parameter similarity**
(`dst ≈ s·R·src + t`) by **Horn's closed-form absolute orientation** (unit-
quaternion method: build the 4×4 `N` from the cross-covariance, take its top
eigenvector). Closed-form, no SVD dependency — matches the crate's dependency-free
spirit.

Correspondences are either **camera centres ↔ imported camera poses** (pose-based
fit) or **triangulated GCPs ↔ surveyed GCP coordinates**. When ≥3 GCPs triangulate
into the current SfM frame (§6.5, `gcpTriangulation.js`), the **GCP fit is
preferred** over the pose-based one. `gcpAccuracyReport()` reports per-GCP CRS
residual + per-observation reprojection px.

The fit and the report consume the **non-robust** triangulation (§6.5): every mark
the user placed reaches them, outliers included. This is deliberate — silently
dropping a GCP observation from the fit would hide exactly the disagreement the
accuracy report exists to surface.

### 6.2 GCPs inside bundle adjustment (anchored BA)

GCPs also constrain BA **directly**, not just post-hoc. `bundle_adjust` accepts an
**anchor residual** `Σ w·‖pt − target‖²` on specific 3D points, weighted by
`w = 1/σ²` (from per-axis GCP survey accuracy, scaled into the SfM frame). Each
anchored GCP is injected as an extra 3D point (with its own real reprojection
observations) whose position is pulled toward the GCP's CRS position transformed
into the SfM frame via the current similarity fit. The anchor only touches that
point's own 3×3 Schur block — no camera Jacobian — so it is free to add and a
no-op with empty arrays.

`runGcpAnchoredBundleAdjust` runs *triangulate → Horn-fit → inverse-transform
targets → anchored BA* twice (hard-coded, as insurance against a poor seed fit).
The **final** georeference used for DEM/ortho is a fresh post-hoc fit against
whatever cameras remain — anchoring only needs to be "good enough to help
convergence".

### 6.3 A GCP's shape

Surveyed ground coords `x/y/z` with per-axis accuracy, pixel `observations`
`[{imageId, px, py}]` with per-axis image accuracy, and an `enabled` flag. There
is **no control/check split** — every enabled GCP is used. A GCP with <2 marks is
unusable (flagged).

### 6.4 Guided marking (`core/sfm/gcpGuides.js`)

Marking the same GCP across dozens of images is the tedious part of georeferencing,
and once the cameras are posed it is also largely *redundant*: the existing
observations already constrain where the next mark can be. We exploit **epipolar
geometry** to aim the user (the same idea as Metashape's guided marker placement).

For a target image with pose `(R_t, t_t)` and a GCP marked on other **registered**
images:

- **One other observation** → the mark is confined to that observation's
  **epipolar line**. From the two world→camera poses, the relative pose is
  `R_rel = R_B·R_Aᵀ`, `t_rel = t_B − R_rel·t_A`; then the essential and fundamental
  matrices are `E = [t_rel]ₓ·R_rel` and `F = K_B⁻ᵀ·E·K_A⁻¹`, and the line in the
  target is `l = F·x_A` (corresponding pixels satisfy `x_Bᵀ·F·x_A = 0`). We
  normalise `l` so `a²+b²=1`, making `|a·u+b·v+c|` a true pixel distance. A
  pure-rotation (zero-baseline) pair has no epipolar constraint and is rejected.
  With several single-view candidates the **widest-baseline** source is used — the
  most stable line and the least foreshortened.
- **Two or more other observations** → the GCP triangulates (§6.5,
  **robust** mode) and reprojects to a **single predicted pixel** —
  a 0-D constraint. Cheirality is enforced: a point behind the target camera
  falls back to the epipolar line rather than projecting to a meaningless pixel.

Because the triangulation is N-view, **every** mark the user places sharpens the
guide in the images still unmarked — the 5th mark constrains the prediction more
than the 2nd did. Guides use the **robust** variant (§6.5): a single misclick must
not drag the aiming prediction in every other image. This is the mirror image of
§6.1's choice, and the asymmetry is the point — a guide is a convenience whose
only job is to be *useful*, so discarding a bad mark costs nothing; the fit is a
measurement whose job is to be *honest*, so discarding one would hide a defect.

Guides are **advisory only** — nothing about them enters the fit. They are drawn
for GCPs not yet marked on the image; an already-marked GCP shows its measured
reprojection error instead.

**The guide is never applied to the mark** (no snap-to-guide — a deliberate
design decision, not a missing feature). A guide is *derived from* the current
reconstruction, so snapping a mark onto it would feed the model's own estimate
back in as ground truth. GCPs exist to be **independent** evidence that can
correct the reconstruction — anchored BA (§6.2) and the similarity fit (§6.1)
both assume the marks are measurements of the *world*, not of the model. A
snapped mark could only ever confirm the model, and would erase the
guide-vs-mark disagreement precisely when the reconstruction is wrong, which is
when that disagreement is the most valuable signal the user has. The gap between
the guide and where the user actually clicks **is** the diagnostic.

**Frame caveat**: like `gcpAccuracyReport`, guides are computed in the **raw
observation pixel frame** against the pinhole model — no calibrated or
self-cal-composed distortion is re-applied, and film scans are not mapped through
`canonicalToScan`. This keeps a guide consistent with the reprojection numbers
shown beside each marker, but on a strongly distorted lens the true epipolar
"line" is a slight **curve**, so the guide is a first-order approximation. The
exact form would sample the pinhole line and push each sample through the composed
distortion into a polyline.

### 6.5 GCP triangulation (N-view, optionally robust)

`gcpTriangulation.js` places a GCP's pixel marks into the current SfM frame. It
feeds the georeference fit (§6.1), the accuracy report, the anchored-BA targets
(§6.2) and the marking guides (§6.4). Camera poses are **fixed input** — only the
3D point moves; refining poses against GCPs is anchored BA's job, not this.

**Seed** — the widest-baseline pair (camera-centre distance, a parallax proxy
usable before the point is known) is triangulated by two-view DLT, reusing the
same WASM routine as SfM point triangulation. This is the best-conditioned
two-view solve available, but only a *seed*.

**Refinement** — the seed is then refined against **every** observation by
Gauss-Newton on summed reprojection error (pure JS: a handful of points per
project, not millions, so no WASM routine is warranted). The Jacobian of a
projection w.r.t. the point, for `x_cam = R·X + t`, is
`∂u/∂X = (fx/z_c)·(R₀ − (x_c/z_c)·R₂)` and `∂v/∂X = (fy/z_c)·(R₁ − (y_c/z_c)·R₂)`.
This is what makes a 3rd..Nth mark worth placing: the DLT pair alone ignores them,
so marking a GCP in eight images used to yield precisely what the best two yielded.

**Robust mode** (opt-in; guides only, §6.4) rejects marks in two stages, and the
**order is the whole method**:

1. An **IRLS fit under a Huber loss** (δ = 2 px; weight `w = min(1, δ/|r|)`), so a
   wild mark pulls with bounded force rather than in proportion to its error.
2. A **median cut** on *that* fit's residuals — drop views beyond
   `max(3 × median, 3 px)`, and only when ≥2 marks survive.

Stage 1 is not an optimisation, it is what makes stage 2 possible. Least-squares
has a breakdown point of zero: the outlier drags the point toward itself until it
stops looking like an outlier. Measured on a 4-view GCP with one ~108 px misclick,
the plain LSQ fit smears it into residuals of **42 / 11 / 50 / 27 px** — median 34,
so a 3× cut of 103 clears the outlier's own 50 px and rejects **nothing**. Under
the Huber fit the bad mark is downweighted, the point settles on the good marks'
consensus, and the residuals separate cleanly (≈0 vs ≈108) so the cut fires. Judging
marks against a fit those same marks corrupted is circular; the Huber stage breaks
the circle. The **absolute 3 px floor** guards the other direction: on a clean set
the median residual is ~0, and a pure multiple of it would reject honest marks over
sub-pixel noise.

The **final fit is plain least-squares over the survivors** — the Huber stage exists
only to *identify* outliers; once they are gone, the efficient unbiased estimate is
the one to keep. Rejected marks are still reported in `perViewReprojPx` (and counted
in the guide's `rejectedCount`): a discarded mark did not steer the point, but the
user should still see that it disagreed. Rejection is **scoped to the one prediction**
— the mark remains a full member of the GCP in the georeference fit, the accuracy
report and anchored BA — so the UI says "7 of 9 marks", never "2 ignored", which
would imply the GCP itself was discarded.

**Observability**: the refinement is invisible by construction — a better prediction
just looks like a prediction. One log line per *placed mark* reports the
**guide-vs-click gap** (§6.4): where the model predicted the mark against where the
user actually clicked. It should shrink as marks accumulate; a large one means model
and user disagree. A detail-level companion **brackets** the mark — the guide before
(fitted from the GCP's N other marks) against `gcpEstimateForImage` after (fitted
from all N+1, *including* the new one) — reporting the shift and its direction. That
bracket is the only way to watch the N-view refinement act on the image being worked
on, because marking a GCP retires its guide there. Expect the shift to point toward
the click and to shrink as N grows (one vote in N+1); a **zero** shift usually means
the robust stage rejected the new mark, not that the estimate is stuck.

Logging the guides themselves was tried and removed: guides recompute on every tab
switch, selection and re-render, so those lines reported the app re-rendering rather
than the user working.

---

## 7. Dense multi-view stereo

**Method**: **PatchMatch stereo** (Bleyer et al. 2011 lineage) with slanted
support planes, in `core/dense/mvs.js` + `crates/reconstruction/src/mvs.rs`.

- **Stage A — per-image depth maps**: PatchMatch with slanted-plane hypotheses,
  red-black checkerboard propagation sweeps, and decaying random refinement. Cost
  is photometric consistency of the **plane-induced homography** warp into source
  views (best-K aggregation over neighbours). Optional `filterDepthMap`
  (median/speckle cleanup).
- **Stage A′ — cross-view consistency filter** (`filterDepthMapsGeometric`): the
  equivalent of COLMAP's `filter` pass (`filter_min_ncc`, `filter_min_num_consistent`,
  `filter_geom_consistency_max_cost`). Runs once after all depth maps exist and
  **zeroes rejected pixels in the maps themselves**, so the persisted planes — and the
  orthophoto that reuses them as a z-buffer — are cleaned, not only the fused cloud.

  Why it is needed, and why no photometric gate can substitute: **sky and vegetation
  both have high NCC**. Vegetation is strongly textured, so its photo-consistency is
  genuine — cost is simply not measuring what is wrong with it. Gradient sky and cloud
  correlate well at *any* depth, so they too are confidently wrong. Both are exposed
  only by **disagreement between views**. Per pixel: unproject to `P`, project into a
  source, read **that source's own depth at that single pixel**, unproject it to `P′`,
  reproject `P′` into the reference — the **forward–backward reprojection error** `e`.
  A view is consistent when `e ≤ maxGeomCost` (px); `minConsistent` such views are
  required. An absolute `minNcc` floor also applies, distinct from fusion's *adaptive*
  p70 `maxCost` which by construction keeps 70% of pixels however bad the distribution.

  Sampling **one** source pixel is what makes this discriminate. Fusion's own check
  (below) searches a `(2·consistencyPx+1)²` window and accepts if *any* pixel there is
  within a relative depth tolerance — a noisy depth cloud such as a bush almost always
  has *some* pixel near the right depth by chance, so it passes. That is why freckles
  survived fusion before this stage existed.

  **Order-independence**: all maps are judged against the *unfiltered* planes
  (rejections are staged in per-map masks and applied afterwards). Filtering in place
  would let map *i*'s rejections remove the evidence map *i+1* is judged against,
  cascading drops in map order. COLMAP likewise filters against the pass-1 maps.
- **Stage B — fusion** (`fuseDepthMaps`): cross-view **geometric consistency**
  (a depth survives only if it reprojects consistently in enough neighbour views)
  → fused dense point cloud. Three **geometric outlier filters** clean the fused
  cloud without a segmentation model (all opt-out): a **min-triangulation-angle**
  gate keeps a pixel only if it agrees with a neighbour at ≥ `minTriAngleDeg`
  parallax (kills sky/haze that "agree" at ~0°); a **grazing-incidence** reject
  drops surfaces seen edge-on (`|n·(C−P)|` below `cos(maxIncidenceDeg)` — thins
  vegetation shells; view-direction fallback normals are inert); and a post-fusion
  **isolated-cell removal** drops lone low-support voxel cells whose 26-neighbourhood
  is nearly empty (fusion flyers). The prior gates (per-pixel cost `maxCost`,
  cross-view agreement count `minViews`) still run first.
- **Oriented normals for free**: PatchMatch already estimates a per-pixel plane
  `(depth, normal)`. Rather than re-estimating normals later (k-NN PCA +
  orientation propagation, the usual Poisson prerequisite), both backends export
  the converged **camera-frame** normal; fusion rotates it to world (`Rᵀ·n_cam`)
  and voxel-averages+renormalizes it onto each dense point (`DenseCloud.nrm`).
  Because the kernel keeps `n_z < 0` (facing the camera), aerial coverage yields
  consistently **outward-oriented** normals — exactly what screened Poisson needs.

**Two backends**, same math: **WASM/CPU** (default) and an opt-in **WebGPU**
kernel (`workers/gpu/patchmatch.wgsl`, ~0.1 s/img vs minutes on CPU), with
per-image fallback to CPU and a first-image A/B validation (`GPU validate: … RMS …`,
must stay < 5e-3).

**Method caveats a colleague will probe:**
- The plane-induced homography is `H = R + t·nᵀ/d` for plane `n·X = d` with
  `d = n·P` — the **sign** is load-bearing; the Hartley–Zisserman `R − t·nᵀ/d`
  assumes the opposite plane convention and mirrors the warp (a real bug we hit).
- Quality is gated by **correct intrinsics** — `resolveK` falling back to
  default-FOV directly distorts depth. This is why the sparse-stage intrinsics
  warnings matter downstream.
- Perf scales as overlap × sources × pixels²; the levers are `maxDim`,
  `maxSources`, `iterations`.
- We run COLMAP's **filter** pass but not (yet) its second **`geom_consistency`
  optimisation** pass, which re-runs PatchMatch with the forward–backward error added
  to the cost so hypotheses are *pulled toward* the cross-view-consistent solution
  rather than only rejected afterwards. Filtering recovers the precision (freckles go);
  the second pass would add **completeness** on weakly-textured surfaces, at ~2× Stage A
  cost. Deliberate deferral, not an oversight.
- Neither COLMAP nor Metashape does **sky segmentation**; both compute depth everywhere
  and discard. Metashape additionally offers manual masking, which websfm supports
  (masked pixels are excluded as ZNCC source texels, not merely zeroed). Automatic sky
  detection by a blue/brightness prior is actively unsafe for polar imagery, where
  snow/ice vs sky is genuinely ambiguous.

---

## 8. Products (DEM, orthophoto)

`core/products/`:
1. **Local vertical frame** (`projection.js`) — auto-orient to a Z-up frame
   (aerial assumption) from the camera geometry, so "up" is meaningful before
   gridding.
2. **DEM** (`dem.js`) — bin the dense heights into a grid, IDW-fill gaps,
   hillshade for preview.
3. **Orthophoto** (`ortho.js`) — **true** orthorectification: reproject using the
   cached dense depth maps as a z-buffer (occlusion-correct) and sample colour.
4. **Georeference** (optional, §6) — when present, products carry CRS coordinates
   and true scale; otherwise they live in the local frame.

Exports: PLY, model JSON, DEM GeoTIFF/.asc, ortho GeoTIFF/PNG+.wld, mesh PLY/GLB
(`exporters.js`, `geotiff.js`).

### 8.5 Mesh — screened Poisson surface reconstruction

**Method**: **screened Poisson surface reconstruction** (Kazhdan & Hoppe 2013),
`crates/mesh` (WASM) + `core/products/mesh.js`. It solves for an implicit
indicator function whose gradient matches the oriented point normals (the
"screening" term additionally pulls the zero level set toward the sample points),
then extracts the surface with marching cubes.

- **Why Poisson, and why it's cheap here**: Poisson needs *oriented* per-point
  normals. Normally that's a separate estimation stage; we reuse the dense
  PatchMatch plane normals (§7), so the only new heavy compute is the multigrid
  solve itself.
- **Iso-value**: the reconstructed surface is the level set at the **average of
  the implicit function evaluated at the input samples**, not the naive `0` — the
  vendored library hard-coded `0`, which inflated the surface ~8% (a patch extracts
  at the sample-average iso, matching the reference implementation).
- **Trimming**: Poisson closes over holes with extrapolated "bulges". We cull any
  triangle whose three vertices are all farther than `trimFactor × mergeCell` from
  the input cloud (a voxel-hash proximity test), keeping only surface supported by
  data. `trimFactor 0` keeps the full watertight hull.
- **Colour**: Poisson vertices are new points, so colour is transferred from the
  nearest dense-cloud voxel cell (3³ neighbourhood search).
- **Knobs**: octree `depth` (detail vs cost/RAM), `screening` weight (fit
  tightness; **not** PoissonRecon's samples-per-node — this library exposes
  screening instead), `trimFactor`.
- **Implementation note**: the solver is a **vendored, rayon-stripped** copy of
  Dimforge's `poisson_reconstruction` — rayon's worker threads panic on
  threadless wasm, so its two `par_iter_mut()` sites run sequentially.

---

## 9. CRS handling (why this app is different)

Everything is built to **not assume WGS84 / lat-lon**. There is a per-project
working CRS (proj4). GCPs, footprints, and camera poses store positions **in the
project CRS** and are reprojected on CRS change. The target domain is Antarctic
aerial survey, i.e. **polar stereographic** projections where a naive lat-lon
pipeline degenerates near the pole. Georeferencing (§6) produces CRS-tagged
products directly. This is a first-class concern, not a post-export reprojection.

---

## 10. How our choices map to the literature / other software

| Stage | websfm | COLMAP | Notes |
|---|---|---|---|
| Features | SIFT (+ SuperPoint opt) | SIFT | + duplicate-blob suppression |
| Matching | ratio + cross-check + F-RANSAC + **spread gate** | ratio + F/E RANSAC | spread gate is extra |
| Verification | F + H (degeneracy) + inlier-ratio + positional-spread | F/E/H, GRIC | |
| SfM type | incremental | incremental | same family |
| Resection | **P3P Lambda-Twist** + MSAC + GN | P3P + RANSAC | |
| BA | LM + Schur + adaptive Huber (from scratch) | LM + Schur (Ceres) | no external solver |
| Self-cal | shared focal scale / cx,cy / k1 | full intrinsic groups | intentionally modest |
| Distortion | Brown, removed at ingest | Brown, in BA | we stay pinhole downstream |
| Dense | PatchMatch MVS (CPU + WebGPU) | PatchMatch MVS | GPU path is WGSL |
| Georef | Horn 7-param + GCP-anchored BA | model_aligner / GCP | |

Genuinely distinctive: **runs in the browser, client-side, no server**; **polar/
non-WGS84 CRS first-class**; **historical scanned-film intrinsics** (pixel-pitch /
film-format handling with sanity checks); and the WebGPU PatchMatch path.

## 11. Known limitations & honest talking points

- **Incremental** SfM → sequential, drift can accumulate on long strips (mitigated
  by interleaved BA + loop closures from exhaustive matching, not by a global
  method).
- **Dense reduced-camera Cholesky** in BA → the scaling ceiling; not yet an
  iterative Schur solve.
- **Self-calibration is weakly observed** on flat, single-strip aerial blocks —
  reported but not auto-applied.
- **Fisheye / strong distortion** is out of scope (fixed-point Brown inverse).
- **Dense quality is intrinsics-limited** — a default-FOV guess visibly distorts
  depth.
- Fitting the init F in **distorted space** is a first-order approximation
  (global BA corrects it).

### 11.1 Quality diagnostics (read-only, Quality Report hub)

These derive from the finished cloud/graph and change nothing in the pipeline; they
exist to tell the user *where* a reconstruction is weak.

- **Match-graph bridge edges** (`core/eval/matchGraph.js` `bridgeEdges`): the
  articulation edges of the accepted-edge graph, found by iterative Tarjan low-link.
  A bridge is a pair whose removal raises the component count — the single link holding
  two sub-blocks together; if it were a false match the block would split. Surfaced as
  "fragile links", weakest (fewest inliers) first, so a thin loop closure is inspectable
  before it fails.
- **Coverage binning** (`core/eval/coverage.js` `coverageGrid`): tie points binned into
  a top-down XY grid (auto cell from the bbox), each cell carrying its point count and
  its **max view count** — how many images see that patch of ground (2 = the triangulation
  minimum, ≥3 comfortable). It's the photogrammetric "where is my overlap thin" map,
  read straight off the already-Z-up-oriented sparse points, not a new solve.

## 12. Where to read the code (pointers, not content)

- Sparse orchestration: `src/core/sfm/sfm.js`
- Init-pair: `src/core/sfm/initPair.js`; cycle filter: `cycleFilter.js`
- P3P / PnP / triangulation / GN: `crates/reconstruction/src/pose.rs`
- Bundle adjustment: `crates/reconstruction/src/bundle.rs`
- Distortion: `src/core/sfm/distortion.js`
- Matching verification: `src/core/features/verify.js`
- Georef: `src/core/products/georef.js`; GCP triangulation: `gcpTriangulation.js`
- Dense: `src/core/dense/mvs.js`, `crates/reconstruction/src/mvs.rs`, `workers/gpu/`
- Products: `src/core/products/{projection,dem,ortho}.js`
- Mesh (screened Poisson): `src/core/products/mesh.js`, `crates/mesh/` (vendored
  `poisson_reconstruction` under `crates/mesh/vendor/`)
- Tunable knobs & their rationale: `src/core/defaults.user.js`, `src/core/tuning.js`

*In-app glossary*: many of these terms also have cross-linked explanations under
`src/help/**` surfaced in the UI — that content is user-facing; this file is the
developer/colleague-facing method reference.
