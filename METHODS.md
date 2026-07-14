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

### 4.1 Intrinsics resolution (`resolveK`)

`K` is derived per image from EXIF focal length + sensor/film format, or from a
sensor-table calibration. For scanned aerial film there is a **pixel-pitch path**
(scan resolution × format) that can silently produce an off-standard implied film
width (~9% focal error observed on a real set) — flagged in the log against the
standard ~230/240 mm aerial format. If nothing is known, a **default-FOV guess**
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

**Stalled-strip rescue (one shot).** A full sweep that registers nothing while images
still *link* to the model is the signature failure of short film strips: the end
frames fail on a slightly-wrong focal (self-calibration only runs post-filter, after
registration) plus a structure gap in their overlap. Before giving up, run one rescue
round — a **focal-only** bundle adjustment (`refineIntrinsics: 'f'`, well-constrained
even on the pre-filter set, unlike cx/cy or k1) to correct the focal, plus a
**retriangulation** pass to grow structure into the stalled overlaps — then retry the
sweep **once** with a relaxed refine-recheck (recount at the PnP gate instead of the
tight reprojection threshold, ratio `rescueRefineRatio`). The absolute inlier floor
and the first PnP gate still apply, and the final BA + track filter clean any loose
observations, so this rescues genuinely-linked end frames without manufacturing a
pose. Off via `rescueStalled: false`.

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
Modes (`refineIntrinsics`):
- `f` — a focal **scale** `s` (init 1, multiplies fx/fy). Modelling focal as a
  scale, not an absolute, preserves per-camera seed differences while sharing one
  DOF across the group.
- `f,cxcy` — focal scale + shared principal-point offsets `dcx, dcy`.
- `f,k1` — focal scale + a shared radial `k1` (Brown r² term). The BA forward
  model is `u = fx·a·(1+k1·r²)+cx` with exact analytic Jacobians.

**Self-calibration is on by default.** The shipped default is `refineIntrinsics:
'auto'`, which `sfm.js` resolves per run: `'f,k1'` when **no** sensor carries a
calibrated distortion model (EXIF-only cameras / film scans — a guessed pinhole is
the single biggest downstream error source, so refine focal + k1), and `'none'`
when a calibrated Brown model already removed distortion at ingest (don't
double-correct). The explicit modes above override the resolution.

Self-calibration is **only** run on post-filter passes (never on the pre-filter
mess — it drifted cx/cy ~180 px on a test set), and it is **weakly observed** on
short/single strips (needs ≥2° tilt variation for a trustworthy focal). Results
are logged (before→after focal, implied film width) but **never** written back to
the sensor table automatically — the user adopts them.

**Important invariant** for the `k1` mode: because the rest of the pipeline is
pure pinhole, a `k1` left on the model would be invisible to reprojection stats,
the track filter, and the dense/ortho warp. So after each self-cal pass we **fold
k1 back into the keypoints** (`undistortPixel` is the exact inverse of BA's
`project_k1`), reset the model `k1` to 0, and **accumulate** it per sensor into
`summary.selfCalDistortion` so the dense stage can reproduce the same
undistortion. One single source of truth for distortion, ingest → dense.

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

A sensor is declared **`kind: 'film'`** and carries the calibrated `fiducials`
(marks in mm, principal point in mm, focal in mm). Each image carries clicked
**scan-pixel observations** of those marks. At SfM ingest we:

1. **Fit a per-image affine** `scan px → camera mm` by least squares from the
   ≥3 paired observations (`fitFiducialAffine`) — recovering true pixel pitch,
   scan rotation, shear, and the RMS residual (µm) as the audit number.
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
into the current SfM frame (2-view DLT, `gcpTriangulation.js`), the **GCP fit is
preferred** over the pose-based one. `gcpAccuracyReport()` reports per-GCP CRS
residual + per-observation reprojection px.

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

---

## 7. Dense multi-view stereo

**Method**: **PatchMatch stereo** (Bleyer et al. 2011 lineage) with slanted
support planes, in `core/dense/mvs.js` + `crates/reconstruction/src/mvs.rs`.

- **Stage A — per-image depth maps**: PatchMatch with slanted-plane hypotheses,
  red-black checkerboard propagation sweeps, and decaying random refinement. Cost
  is photometric consistency of the **plane-induced homography** warp into source
  views (best-K aggregation over neighbours). Optional `filterDepthMap`
  (median/speckle cleanup).
- **Stage B — fusion** (`fuseDepthMaps`): cross-view **geometric consistency**
  (a depth survives only if it reprojects consistently in enough neighbour views)
  → fused dense point cloud.
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
