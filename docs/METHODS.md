# WebSfM — methods & algorithms

The *science* companion to [ARCHITECTURE.md](../ARCHITECTURE.md). ARCHITECTURE answers
"where does the code live"; this file answers "**what method is it, and why that
one**": the questions a photogrammetry colleague asks, such as which bundle
adjustment, which distortion model, which P3P, how georeferencing is done. It is
deliberately implementation-light: enough pointers to find the code, but the content
is the algorithms, the conventions, the parameters and the trade-offs.

Keep it current: when a *method* changes (a new solver, a different cost function, a
new model), update the relevant section here in the same pull request. Code-structure
changes belong in ARCHITECTURE.md, and user-facing explanations in the in-app guide
(`src/guide/`) and glossary (`src/glossary/`).

Measurements quoted here name their dataset and come from the headless bench
(`scripts/bench/`). The comparisons against COLMAP, Metashape and reference data are
collected in [BENCHMARKS.md](BENCHMARKS.md). Check ids such as `PRD-31` refer to the
maintainer's manual verification register.

---

## 0. One-paragraph summary (for the "so what does it do" question)

WebSfM is an **incremental** (sequential) Structure-from-Motion pipeline followed
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
- **Distortion**: Brown–Conrady, rational or Kannala–Brandt fisheye, **removed once at
  ingest** — the geometric pipeline (init, PnP, triangulation, BA, MVS, ortho) works on
  pinhole keypoints. Self-calibrated distortion is folded into the keypoints too (§4.6);
  a fisheye camera alone is solved in BA in the pixels its lens recorded. See §5.
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
              ├ two-view init (F→E→pose, DLT triangulate, seed pick)
              ├ incremental resection (P3P + MSAC PnP, track extension)
              ├ interleaved + final bundle adjustment (LM + Schur + Huber)
              ├ retriangulation + split-track merge + 2-pass track filter
              └ optional camera-pose + GCP-constrained BA
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

**Orientation assignment — one keypoint per strong peak** (Lowe §5; since 2026-10-05).
The 36-bin, Gaussian-weighted, smoothed gradient-orientation histogram gives the
dominant orientation (global maximum, parabola-interpolated). Every other local maximum
reaching **80 %** of it becomes an additional keypoint at the same position, scale and
response, with its own descriptor computed at that angle — up to
`DETECT_TUNING.siftMaxOrientations` per extremum. The default is **1** (COLMAP's
`max_num_orientations` is 2): on South Building, with identical matching settings, the
second orientation changed ≥3-view points by +0.5 % (60,480 vs 60,189) for ~20 % more
descriptors to match, so it stays available but off. Why it matters: a feature whose two peaks are nearly equal gets one
orientation in one image and the other in the next, its descriptors no longer agree, and
the feature drops out of every match that would have extended its track. On synthetic
rotated/rescaled pairs the second orientation adds ~18 % keypoints and **8–15 % more
distinct correct correspondences** (none at zero rotation), with unchanged precision;
`maxOrientations = 1` reproduces the earlier detector bit for bit. Siblings count toward
`maxKeypoints`, are exempt from each other in near-duplicate suppression (and are
suppressed together with their extremum), and are **folded back onto the dominant
keypoint right after matching** (`core/features/orientationSiblings.js`): every putative
is re-expressed on the canonical index and deduplicated, and a feature that the two
orientations matched to two *different* features is dropped as ambiguous. Verification
and SfM therefore see one index per physical point carrying the evidence of both
orientations — without the fold, B matching orientation 1 and C matching orientation 2
would split the point into two tracks the merge step refuses to join.

**Descriptor normalisation — RootSIFT** (Arandjelović & Zisserman 2012; COLMAP's
default `L1_ROOT`; since 2026-10-05). The crate emits classic SIFT (L2-normalise, clamp
at 0.2, re-normalise). WebSfM stores and matches each vector as `sqrt(d / ‖d‖₁)`.
Euclidean distance between RootSIFT vectors is the Hellinger kernel between the
underlying gradient histograms, which damps the few dominant bins that make plain SIFT
confuse similar-looking texture. The result is still unit-L2, so the ratio test, the
WebGPU path and every distance gate are unchanged. RootSIFT is a pure function of the
stored L2 vector, so pre-switch projects are converted when matching loads them rather
than re-detected (`core/features/siftDescriptors.js`, stamped as `descNorm` per image).
Node bench on an 8-image South Building strip: +2.1 % ≥3-image tracks at 2400 px / 10k,
+2.6 % at native / 10k and +4.8 % at native / 25k.

**Which keypoints survive the cap — coarse first** (COLMAP's rule; since 2026-10-05).
`maxKeypoints` used to keep the strongest |DoG| response. At high resolution that fills
the budget with fine-scale texture: at native South Building size, 85 % of a
response-ranked 25k set has σ < 4 px. That texture is the first to stop matching under
viewpoint change, and on brick or foliage it is repetitive, which the ratio test rejects.
WebSfM now keeps the largest scales first, with response as the tie-break inside the
octave the cap cuts through (`core/features/keypointCap.js`,
`DETECT_TUNING.siftCapRule`). COLMAP keeps whole octaves, so its 8192 is a soft limit;
ours stays an exact budget, because brute-force matching is O(Na·Nb). The cap runs after
masking and after the tile merge, so masked or duplicate keypoints never take slots.
Measured ≥3-image tracks on the strip: +1.4 % at 2400 px / 10k (the cap barely binds)
and **+10 %** at native 3072 px / 10k, where response ranking had scored *below* 2400 px.
With RootSIFT, that native-10k configuration gains +13.5 %.

**Non-standard bits worth mentioning to a colleague:**
- **Duplicate-keypoint suppression** (`suppress_duplicate_positions`,
  response-weighted descriptor NMS): one strong blob can fire as a DoG extremum
  across adjacent scales/octaves, producing several index-distinct keypoints
  within ~2 px. Left in, these poison matching (many-to-one convergence, §3) and
  BA. They are suppressed at detection.
- **Descriptor width is per-detector, not a constant**: 128 for SIFT, 256 for the
  optional learned **SuperPoint**, 128 for **DISK** and **ALIKED** (ONNX via
  `onnxruntime-web`, `core/features/learnedDetectors.js`). Carried as `descDim`; a
  wrong dim mis-slices the flat descriptor buffer.
- **Tiled detection** for very large scans: the image is split into an evenly spaced,
  overlapping grid whose origins sit on the coarsest octave's sample grid. Each tile
  keeps only the keypoints in its own *core*, and the cores (cut at each overlap's
  midpoint) partition the image, so every keypoint comes from exactly one tile and
  sits ≥ overlap/2 from any cut edge. A 2 px NMS then runs across seams only
  (`core/features/tiling.js`). Merging by deduplicating the union instead left most
  keypoints with a near-identical twin, and the ratio test rejects both copies; on
  South Building that cut correspondences 4×. With ownership, a tiled run reproduces
  99.5 % of the untiled run's keypoints and its matches.
- **Colour** is sampled per keypoint at detection and later median-aggregated per
  track for the coloured sparse cloud.

**Alternatives available**: SIFT (default, classical, rotation+scale invariant), or
the learned SuperPoint, DISK or ALIKED (better on low-texture / repetitive scenes,
none of them scale- or rotation-invariant, each needs its model; matched with
LightGlue).

---

## 3. Feature matching & geometric verification

Pairwise, exhaustive by default (every image pair), with two cost-cutting pairing
alternatives: position-based nearest-neighbour preselection when camera positions
exist, or a configurable capture-order window (optionally wrapping end-to-start for
a closed orbit) when they do not.

**Descriptor matching** (`core/features/bruteforce.js` or the learned
`lightglue.js`): mutual nearest-neighbour (**cross-check**) + **Lowe ratio test**
(`d1/d2 < ratio`, default 0.8, COLMAP's value). LightGlue is an attention-based
learned matcher run as an alternative to brute-force. The default was 0.75 until
2026-10-06; 0.8 won five separate measurements. On South Building it gives ~5% more
≥3-view points at an unchanged median error. On the eagle set (44 images) 0.75
registered only 29 cameras against 43 at 0.8: the extra correspondences are what
connect its weakly overlapping blocks. Geometric verification below removes the extra
false matches the looser ratio admits.

**Geometric verification** — this is where we are stricter than a textbook
pipeline. Every candidate pair (both matcher paths) passes through
`core/features/verify.js`:
1. **Fundamental-matrix RANSAC** (`verify_matches_hf`, 8-point + RANSAC in
   `crates/matching`) → inlier mask + inlier count. Each new best sample gets a
   **local optimisation** (the simple LO-RANSAC step): refit the normalised 8-point
   F on its inliers and recount, up to four rounds while the set changes, keeping
   a refit only if it explains at least as many points. The returned model is
   therefore never worse than the sample that won, and the adaptive stop sees the
   polished inlier ratio. It also fits a homography so an **H-vs-F** degeneracy
   signal is available.
   **MAGSAC++ alternative** (opt-in, match setting `verifier: 'magsac'`, 2026-10-18,
   `crates/matching/src/magsac.rs`; Barath et al., CVPR 2020). Same seeded minimal
   samples; a model is scored by the σ-marginalised loss (σ uniform on [0, σ_max],
   χ residual with ν = 4, cut-off r_max = 3.64 σ_max = the user's threshold) instead
   of an inlier count, and a promising sample is polished by σ-consensus++: up to
   four unweighted refits on the points within r_max (kept only when the loss
   drops), then IRLS with the marginalised weights divided by the squared gradient
   of the algebraic residual, so the weighted 8-point / DLT minimises the geometric
   residual. Inliers are still the points within the threshold, so the gates and
   the H/F ratio mean the same. Synthetic: median F error 0.40 → 0.30 px (3 px
   gate). Real data (2026-10-18): South Building 128 and quarry 347 within noise of
   RANSAC (quarry RTK rms3d 0.770 → 0.764 m, rmsH 0.310 → 0.295 m; points ±0.2 %),
   so RANSAC stays the default.
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
seed initialisation or fresh triangulation (their
geometry isn't trusted enough to build structure). This keeps a low-overlap chain
link (e.g. a 227-inlier film pair a user's raised `minMatches=500` would sever) in
the graph. Positionally-degenerate pairs stay hard-rejected, never weak.

**Disabled-pair flag**: a user can reversibly exclude an obviously-wrong pair
(`setPairDisabled`); disabled pairs are filtered wherever SfM reads matches.

**Prefilters** (cut the O(N²) pair cost):
- **Preselection** (`preselect.js`) — when imported or EXIF-derived camera positions exist, only
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
at a time), not global/hierarchical. After the primary model finishes, a conservative
multi-model wrapper (`core/sfm/multiModel.js`) examines coherent components in the
remaining induced match graph. Components with at least eight images are reconstructed
with up to twelve already-registered boundary cameras. The overlap estimates a 7-DOF
similarity between the arbitrary frames. A merge requires at least three shared cameras
plus low centre-alignment RMS, camera-rotation and focal agreement, compatible radial
self-calibration, and stable leave-one-camera-out scale. A failed gate preserves the
secondary as a separate sparse model; it never relaxes PnP or forces an alignment.
Before secondary recovery, a primary registering less than half the input is retried
with up to four alternate initial pairs, retaining the largest result. This prevents a
stochastic F/essential estimate from making one locally clean but non-growing seed the
foundation for every later model. Secondary recovery is suppressed if all retries leave
fewer than 25% registered, because a tiny primary is not a trustworthy alignment frame.

### 4.0 No pre-SfM pair filter (rotation-cycle filter removed 2026-10-06)

Verified pairs go into SfM as they are. A **rotation-cycle consistency filter** used to
run first: for every triangle of pairs the composed relative rotation
`R_ik⁻¹ · R_jk · R_ij` must be ≈ identity, and the edge failing most of its triangles is
dropped. It was removed after an audit of every pair against the finished model. That
audit asked two things: do the pair's inliers agree with the model's epipolar geometry
(a true pair), and does its input rotation agree with the model's relative rotation.

| run | dropped | false | true, wrong rotation | true, right rotation |
|---|---|---|---|---|
| South Building, defaults | 53 | 0 | 51 | 2 |
| South Building, native 25k | 404 | 46 | 355 | 3 |
| building set (50) | 14 | 9 | 3 | 2 |

The cycle test was not the defect; the pairwise **rotation estimate** was. It comes from
the matching-time F and a nominal K, and was wrong on many true pairs (median 28.6° on
the native run). Only 145 of those 355 were H/F-degenerate, so planar geometry explains
under half. Turning the filter off changed no point count (57,167 vs 57,168). False
pairs are instead stopped downstream: the two-gate PnP, the track filter and the robust
BA. A graph filter is worth revisiting only with better pairwise rotations (5-point E
under RANSAC with the calibrated K, H decomposition for planar pairs), re-audited
against a final model.

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

A focal-only **pre-solve** corrects that guess right after registration. Every
self-calibration update passes a plausibility guard before it is committed
(`core/sfm/selfCalGuard.js`): one pass may not move the focal by more than 25%, nor end
more than 35% from the nominal focal. Those bounds stop the thin-block runaways seen on
EXIF sets (focal +48…88%). A default-FOV guess is not a measurement, though: a 153 mm
lens on a 230 mm film frame sits 33% below it. With the EXIF bounds the guard rejected
the pre-solve on the CA213732V strip (a 29.9% step), and the focal stayed at the guess.
A guessed focal therefore gets wide bounds instead: 60% per pass, and anywhere within
[0.3, 1.7] × the guess. On that strip the focal now runs 10137 → 6953 → 6656 → 6627 px
(expected ~6700), with +11% points (423 → 470) and median reprojection error 1.94 →
1.48 px.

### 4.2 Two-view initialisation (`core/sfm/initPair.js`)

The seed pair is the single best predictor of how the model grows, so we do **not**
just take the highest inlier count. We probe up to `initCandidates` (default 24)
pairs with the most inliers and for each:
- `F → E` (`fundamentalToEssential`, applying `K_A`, `K_B`), and beside it a
  **five-point E under RANSAC** (Nistér, `core/sfm/essential.js`) on the K-normalised
  matches, each of its alternative solutions a candidate of its own (`initFivePoint`,
  on by default; inlier threshold 1.5 px). On a near-planar scene the matcher's
  uncalibrated F is undetermined and its pose is wrong, where the calibrated problem
  has no planar degeneracy (Casa Grande 1978 aerial film, one pair: 174 px init
  reprojection via F, 0.61 px via five-point),
- **pose recovery** by essential-matrix decomposition (`recoverPose`) with
  cheirality (points-in-front) disambiguation of the 4-fold sign ambiguity,
- **DLT triangulation** of all matches, keep only points passing cheirality in
  both cameras,
- record **median triangulation angle** (parallax) and **init reprojection**.

Selection rule: among candidates clearing the **parallax floor** (`minInitAngleDeg`,
default 2°) take the highest-scoring seed. If none of the first batch clears it, the
search **widens** to the next batch by inlier count, up to `initCandidateMax` (240)
probes — COLMAP likewise keeps searching until a pair meets its init constraints.
Ranking by inlier count is what makes this necessary: the highest counts come from
viewpoints that barely differ (a drone hovering or turning on the spot), and nine such
frames make 36 pairs, enough to fill a batch with ~0.2° pairs. A widening batch skips a
pair already ruled out by measurement: triangulation angle obeys the triangle
inequality, so if X and Y were each probed within half the floor of a common image Z,
X–Y lies below the floor. Only when the budget is spent does selection fall back to the
widest baseline, and a fallback under the track filter's own floor (1.5°) is reported
as unable to grow — its points are removed by the first interim cleanup. The score is

```
√cheiralKept × parallaxHealth(angle) × connectivityHealth × growthHealth / (1 + initReproj_median / 4)
```

— cheirality-surviving point count (pose correctness × scene coverage) as the base,
scaled by the seed's position in the match graph, with reprojection as a gentle
tie-breaker only (it is measured *before* any distortion self-cal, so it is a weak
signal that must not dominate).

`growthHealth = max(1, readyViews)` measures the seed's immediate ability to
grow. A third image is ready only when verified edges from either seed image observe at
least `minMatchesForRegistration` **distinct triangulated seed points** in it. This is
more specific than graph degree: degree measures neighbourhood reach, while ready-view
support proves that the neighbours reuse enough of the seed's 3D tracks to attempt PnP.
It is proportional because each independently ready view is a real opportunity to grow;
the parallax and geometry checks are applied before this ranking.

**Match-graph degree outranks point count.** `connectivityHealth` is the pair's
degree (the lower of its two images') over the median image's, clamped to
`[initConnFloor, initConnCeil]` (0.4–2) — it *rewards* a hub, not merely penalises a
satellite. Point count enters as a **square root**: a pair with twice the surviving
points is better conditioned, not twice as likely to grow the model. Both dampers are
measured, not aesthetic. With parallax gated flat (below), the first South Building
run under the new rule ranked by raw point count and picked a 1177-point pair at
degree 7 over a 670-point pair at degree 22 — capping connectivity at 1 had made the
hub's advantage invisible, since degree 22 and degree 8 scored identically. That seed
registered **3/128** cameras; the hub reached **86/128**. Across every measured run
graph degree separated the good seed from the bad one and point count separated
neither.

**Parallax is a gate, not a ranking.** `parallaxHealth` is flat at 1 for every angle
between a soft band just above the floor (`minInitAngleDeg × initSoftFloorFactor`,
default 2.5°) and a grazing knee at `initAngleTargetDeg × 4` (default 32°), beyond
which decaying overlap is discounted. A *ranked* parallax term anchored at the floor
is unstable by construction: small absolute angle differences near the floor become
large multiplicative ones. On South Building (128 images) it scored a 5.21° seed
over a 2.68° one by 4.7×, swamping the latter's combined 1.34× advantage in points,
reprojection and graph degree — and the seed it picked registered **19/128** cameras
with a self-calibration that ran away to fx +101%, against **122/128** for the seed
it beat. Sufficient triangulation angle is a threshold (COLMAP's stance), so above
the band the decision belongs to the other signals. The soft band keeps a
barely-passing pair discounted rather than cliff-edged at exactly the floor.

A quality signal logged per candidate — not currently scored — is the
**essential-matrix conditioning** σ2/σ1 (ideal ≈ 1; well below 1 ⇒ wrong focal
length). It is the term to add if a barely-passing seed ever wins badly on the flat
gate, which is this rule's remaining known risk.

### 4.3 Incremental resection (PnP)

New cameras are added one at a time (`solve_pnp` in `crates/reconstruction`):
- **P3P — Lambda-Twist** (Persson & Nordberg, ECCV 2018) as the minimal solver
  inside RANSAC. Recovers per-point depths along the bearing rays, reconstructs
  the 3 points in the camera frame, aligns to world with a rigid **Procrustes**
  fit. The depth direction from each conic root is sign-ambiguous (the metric
  constraint is homogeneous), so an all-negative λ is negated, not discarded; and
  the 3×3 SVD behind Procrustes and the essential decomposition treats a singular
  value as zero **relative** to the largest (rank-2 inputs report s₃ ≈ √ε·s₁, not 0).
  Both were silent losses until 2026-10-03: P3P recovered 24% of random noise-free
  minimal sets and the essential decomposition could return non-rotations.
  Chosen over DLT resection because it is far more stable on the **near-planar**
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
fresh. A fresh triangulation must clear the parallax floor **and** reproject within
`filterMaxReprojPx` in both images, as COLMAP's triangulator requires. A pose that
passed PnP can still carry a few bad correspondences, and a DLT on a wrong match can
land far from the rays, at a reprojection error of up to 10⁵ px. Before this gate,
those points were the whole of the interim-BA "blow-ups" on South Building (start
RMS up to 900 px), so the next interim solve began from a broken state. A later `foldOneEndpointMatches` pass folds in observations where exactly
one endpoint was already assigned (raises the ≥3-view share) — one round of the
track-completion rule of §4.7.

### 4.5 Bundle adjustment (`crates/reconstruction/src/bundle.rs`)

**Which BA?** Sparse **Levenberg–Marquardt** with the **Schur complement**
(points eliminated against cameras), analytic Jacobians, and **adaptive Huber**
robustification. From scratch, dependency-free (no Ceres/g2o). This is the same
family as COLMAP's BA; the specifics:

- **Parameterisation**: each camera is 6-DOF — translation `t` plus a
  **left-perturbed so(3)** rotation update `R ← exp(δω)·R` (minimal 3-parameter
  rotation increment, no gimbal issues). 3D points are 3-DOF.
- **Schur complement**: the per-point 3×3 blocks are eliminated, leaving a reduced
  camera(+intrinsic) system. Below n = 600 unknowns (100 cameras) it is solved by
  **dense Cholesky** (`chol_solve`); above, by **conjugate gradients with a
  block-Jacobi preconditioner** (one 6×6 block per camera, one per intrinsics group;
  `solve_reduced`). The crate's exact policy solves to a relative residual of 10⁻¹⁰
  and falls back to Cholesky if CG stalls; the app runs it **inexact (truncated
  Newton, as Ceres' iterative Schur)**: tolerance 10⁻⁶, at most 200 CG iterations, the
  capped iterate taken as the step. Any CG iterate from x₀ = 0 lowers the quadratic
  model, and LM still accepts a step only if the true cost falls. On three bench sets
  this needed the same number of LM solves and gave identical camera, checkpoint and
  point results, at 14–50 % less SfM time (GeoScan PUTI −50 %, quarry −24 %, South
  Building −14 %). Cholesky is n³/3 flops: 5.9 s per solve at 522 cameras against 0.14 s for
  CG with the same answer (2×10⁻¹² apart, native), and BA had taken 2,100 of 2,550 s
  on a 538-image block. The reduced system is stored **block-sparse**: a 6×6 block
  per pair of cameras that share a point (plus the intrinsics-group rows), so memory
  grows with the co-visibility graph, not with cameras². A dense matrix at 3,000
  cameras is 2.6 GB on its own, and wasm32 has 4 GiB in all. Above n = 4,096 (~680
  cameras) no dense copy is ever made: CG alone solves it, and a CG iterate that
  hits the iteration cap is taken as the step (it still lowers the quadratic model,
  and LM accepts it only if the true cost falls). Points' coupling blocks are
  recomputed from the Jacobians where the elimination and the back-substitution
  need them, rather than kept (160 B per observation). Every matrix entry receives
  the same sums in the same order as the dense assembly did, so a system that fits
  the dense path solves bit-identically.
- **Robust cost**: **Huber**, with an **adaptive threshold** = 2.5 × median
  residual (recomputed each outer iteration, floored at 1 px), applied as an IRLS
  weight `w = min(1, δ/‖r‖)`. Step acceptance evaluates the loss that weight
  descends, ρ = q·(2w − w²) (= 2δ‖r‖ − δ² for unit weights), not w·q. Tracks the noise floor as the model tightens so
  gross mis-triangulations don't drag the solution.
- **LM damping**: standard multiplicative λ schedule with up to 8 damping retries
  per iteration; a step is accepted only if it lowers the robust cost, and the
  whole solve is **guarded** at the orchestration level. The guard judges the
  objective the solver minimised, not plain RMS (`core/sfm/baAcceptance.js`): when
  RMS rises it re-evaluates one Huber cost before and after, with δ fixed from the
  pre-solve residuals (2.5 × median, ≥1 px), and rejects only if that cost rose too.
  Plain RMS is dominated by the few gross outliers that Huber deliberately
  down-weights, so it can rise while the fit to every inlier improves. Judged on RMS,
  South Building rejected four good interim solves per run (2026-10-05). A rejected
  solve keeps its pre-solve estimate, so the next one inherited the same problem.
- **Stopping rule**: LM stops when an accepted step lowers the robust cost by less than
  `functionTolerance` (1e-6, Ceres' default) of that iteration's cost, when no step is
  accepted within the damping retries, or at the iteration cap. The comparison stays
  within one iteration because δ is re-derived from the residuals each iteration, so
  costs from different iterations are not on one scale. Without the tolerance every BA
  ran to its cap: on St Nazaire the late BAs repeated ~4 s iterations (1.45 M
  observations) on a model that had converged in the first one or two, and BA was 91 %
  of the SfM time (St Nazaire, 127 DJI images).
- **Cost reported**: RMS reprojection error in pixels, before/after, plus a
  per-iteration convergence trace (used to tell "plateaued" from "still
  descending — raise iterations").

**Interleaved BA**: a global BA + track-filter runs every `interimBaEvery` new
cameras (COLMAP-style), so later PnP registers against a tight model and the final
BA starts near the optimum — instead of one big solve on a drifted model that
lands in a bad minimum. The solves are also **spaced geometrically**: the next one
waits until the model has grown by `interimBaGrowth` (2, i.e. doubled) since the last,
like COLMAP's `ba_global_images_ratio` (which defaults to 1.1). Each solve costs the whole model, so a fixed
every-5 spacing makes registration quadratic in the image count. On the 347-image
quarry, 69 interim BAs took 837 of 998 s of registration. Geometric spacing cut
registration to 143 s at the same points and accuracy. Doubling instead of +20 % (2026-10-11)
cut SfM a further 25–33 % on four bench sets with every camera kept and camera and
checkpoint accuracy unchanged, including the sets with weak bridges. Local BA between
the global solves (the new camera and its most co-visible neighbours free, the rest
fixed) is available but bought nothing measurable there, so it is off.

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
`summary.selfCalDistortion` carries so the **dense** stage reproduces the same
undistortion (applied as a second bag after any calibrated `dist`). A monotonicity
guard warns if a higher-order fit runs away. One single source of truth for
distortion, ingest → dense.

**Re-folding when the principal point moves** (`selfCalFold.js` `refoldIfMoved`). Each
fold is centred on the principal point of its pass, and the point is held until the
model has ten cameras, then may move. A fold about the old centre followed by one about
the new is no radial map about either. Left as it is, the composed bag (fitted about
the final centre) misses the folded keypoints, so dense undistorts the rasters
differently from the sparse model, and the non-radial remainder stays in the keypoints,
where no later pass can remove it: BA fits a radial bag, and the remainder also pulls
the principal point and focal estimates off. So once a group's principal point has
moved more than `selfCalRefoldMovePx` (0.25 px) from the centre its keypoints were
folded about, the fold fits the composed bag pristine → folded about each image's
current K and **re-derives the keypoints and GCP marks from the pristine ones** through
it. Afterwards the keypoints are exactly what the composed bag gives about the current
centre, and the next pass estimates what is left. A fisheye group never folds (§5), so
it never re-folds.

Measured on synthetic 24-camera blocks with a known lens and cameras (seeds 7, 11, 13;
camera-centre median error after a similarity fit, mm):

| true principal point offset · lens | without re-fold | with re-fold |
| --- | --- | --- |
| 4.3 px · k1 −0.05, k2 0.008 | 10.6 / 10.7 / 12.5 | 7.9 / 10.1 / 12.8 |
| 4.3 px · k1 −0.12, k2 0.03 | 10.9 / 11.6 / 17.0 | 8.1 / 10.1 / 13.1 |
| 28.8 px · k1 −0.05, k2 0.008 | 17.0 / 23.6 / 33.5 | 9.5 / 10.2 / 12.5 |
| 28.8 px · k1 −0.12, k2 0.03 | 31.2 / 37.4 / 72.0 | 9.7 / 10.6 / 16.2 |

At the 28.8 px offset the old fold left the principal point 3–9 px and the focal length
up to 1.3 % off; with the re-fold they come within 0.1–0.7 px and 0.06 %, and the
composed bag reproduces the keypoints to ≤ 0.002 px (0.7–1.5 px before; ≤ 0.016 px at the
4.3 px offset, where moves under the threshold wait). The composition
of radial maps about one centre is itself not exactly a degree-6 polynomial; that
residual is 0.001–0.011 px. The run log gives the fit RMS, how far the principal point
moved and the re-folds per sensor (`fitRmsPx`, `centreMovedPx` in `selfCalDistortion`),
and warns above `selfCalComposedWarnPx` (0.25 px). The alternative would be keeping
distortion in BA's forward model, as COLMAP does, at the cost of the pinhole invariant.

On real blocks, whose principal points sit close to the image centre, the re-fold
changes the cameras within run-to-run noise; what it removes is the gap between dense and
sparse. It ran 1–3 times per run (principal-point moves of 0.7–27 px), took the composed
residual to 0.000 px (South Building 0.18 px before) and cost 0–7 % in time:

| block | reference | without re-fold | with re-fold |
| --- | --- | --- | --- |
| South Building, 128 images | COLMAP cameras, median | 0.0047 | 0.0048 |
| ETH3D, six scenes | ground-truth cameras | — | identical |
| quarry, 347 images, no priors | RTK, 3D RMS | 0.738 m | 0.732 m |
| quarry, 347 images, RTK priors | RTK, 3D RMS | 0.236 m | 0.233 m |
| Casa Grande | check points, H / V RMS | 1.246 / 1.170 m | 1.246 / 1.173 m |
| Iceland 1980s scans, 125 images | check points, H / V RMS | 1.416 / 1.945 m | 1.416 / 1.946 m |

### 4.7 Retriangulation, split-track merge, track filtering

After BA settles: **retriangulate** pairs (`retriangulatePairs`) with the improved
poses, **merge split tracks** (`mergeSplitTracks` — the same physical point that
got triangulated twice), and a **2-pass track filter** removing observations /
points on two criteria: reprojection error above `filterMaxReprojPx`, and
triangulation angle below `filterMinTriAngleDeg` (ill-conditioned near-zero-
parallax points). The parallax floor is also applied before bulk retriangulation so
near-parallel candidates are never allocated merely because they reproject well.
BA is re-run after filtering.

**Track completion** (`completeTracks`, COLMAP's *CompleteTracks*). A verified match
whose two keypoints are both on points is a split track (merged above); one whose
keypoints are both free is new structure (retriangulated above). The third case — one
keypoint on a point, the other free — adds the free keypoint's observation to that point
when it reprojects within `filterMaxReprojPx` and the point has no observation in that
image yet. During registration this runs one round after each sweep and interim BA,
against the poses of the moment. After registration it runs **to a fixpoint** (an
observation added through A↔C can enable C↔D) after the retriangulation/merge step and
again before each track-filter pass — i.e. against the final poses and the
self-calibrated, folded keypoints, which the registration-time rounds never saw.
Added observations then go through the same filter and BA as every other observation.
On a noise-free synthetic strip the final rounds add nothing (registration's rounds
already completed every track), so their value lies in what registration could not
judge: pre-self-calibration gate failures.

**Projection-guided track extension** (`core/sfm/guidedExtension.js`; no COLMAP
equivalent). Completion can only use matches that exist. On South Building, 46–73k
two-view points had no verified correspondence into a third registered image, even
though the third image saw them. The global ratio test had to choose among all of that
image's keypoints, so a feature with a near-twin elsewhere on a repetitive façade
failed it. Once poses exist, that ambiguity is gone.

Once, before the tight track-filter pass, every point is projected into each registered
camera that does not observe it. The method then searches the unused keypoints within
the search radius and compares descriptors (uint8 RootSIFT, the same space as matching)
against up to three of the point's observations. A candidate is accepted only when both
hold:
- it is closer than the 0.9 quantile of distances between observations of this run's
  own ≥3-view tracks;
- it beats the runner-up in the same window by ratio 0.8.

Proposals are resolved greedily, best first, so one keypoint joins one point and a point
gains one keypoint per image. The following filter and BA then treat the additions like
any other observation.

The search runs camera by camera on the threaded crate (`crates/reconstruction/src/
guided.rs`, the same arithmetic as the JS search, which remains for when no wasm is
loaded); only the best-first resolution is sequential. Quarry: 3.8 → 1.5 s on 16 threads,
the same additions.

The search radius is the filter gate, capped at 3 × the model's p90 residual. On a
coarse detection scale the native-pixel gate is far wider than what the model resolves
(16.9 px on TMA against a 1 px median residual).

Measured gains in ≥3-view points:

| set | gain |
|---|---|
| South Building | +5 % |
| South Building, native 25k | +4.4 % |
| building | +28 % |
| eagle | +7 % |
| quarry | +5.9 % |

The audit compares the additions' final residuals with the rest of the model. On South
Building they come out at 0.39/0.98 px (median/p90) against 0.31/0.96 px, which is
consistent with true matches; all-false additions would sit near 0.7 × radius. The
camera accuracy against RTK is unchanged. The exception is a weak model: on the TMA scans
without interior orientation, the additions sit at 3–5 px against a 1 px model.

Two-view points remain available while the incremental solve needs them. At final
output, however, they are omitted automatically when the model already contains a
healthy core of at least three-view tracks. This specifically removes false matches
that slide along an epipolar line: they can have low two-image reprojection error but
have no independent observation confirming their depth. Tiny and genuinely two-camera
models retain their two-view structure rather than being emptied by this policy.

### 4.8 Adding images to a saved model (`core/sfm/extendModel.js`, 2026-10-30)

Sparse Reconstruction ▸ *Add to the model* runs the incremental pipeline from the saved
model in place of a seed pair: its cameras and points become the starting state, and
registration (4.3), the refinement (4.4–4.7) and the registration check work on the
images it lacks. Two things make that sound.

- **The same pinhole frame.** The pipeline works on keypoints with the lens removed
  (ingest's calibrated bag, then the self-calibration fold). The saved model keeps what
  the dense stage needs to reproduce that frame (the composed self-cal bag and the film
  transforms, `summary.selfCalDistortion` / `fiducialTransforms`), and every image is
  moved into it through that chain (`displayFrame.js makeScanCentreToPinhole`) about its
  group's solved K. A new image on a lens the model knows lands in the same frame as a
  depth map of it would; one on a new lens takes ingest's frame, as in a new run. The
  model also saved each observation's BA-frame pixel; the old images' rebuilt keypoints
  are compared with those (median 0.00002 px on the synthetic block, with and without
  self-calibration) and then take them exactly. A median gap above
  `SFM_TUNING.extendFrameMaxMedianPx` (0.5 px) means the features are not the ones the
  model was solved from (detected again), and the run stops.
- **Fixed cameras.** Self-calibration is off for the run, and every bundle adjustment
  holds the model's cameras fixed (`bundle.rs fixed_cam`) and takes only the points a
  new camera sees, with the fixed cameras that see them: a local adjustment around the
  new block, so its cost grows with the extension, not with the model. The camera-prior
  and GCP solves do not run; the fixed cameras already carry them. The cameras' stamp is
  kept, so what was built from them stays current. *Existing cameras ▸ Refined* then runs
  Optimize cameras (the same solve as Tools ▸ Model ▾) over the grown model, and what was
  built from it becomes outdated.

On the synthetic 4 × 6 block, a model of the first four columns extended by the other
two places the new cameras 0.11–0.13 % of the camera spacing from the truth, where a
run of all 24 images gives 0.06–0.09 %; the model's cameras are bit-identical.

---

## 5. Camera model & lens distortion

**Model**: **Brown–Conrady** — radial `k1,k2,k3` + tangential `p1,p2` — by default;
OpenCV's **rational** model and the **Kannala–Brandt fisheye** are the alternatives
below.
Forward: `x_d = x·(1 + k1·r² + k2·r⁴ + k3·r⁶) + [2·p1·xy + p2·(r²+2x²)]` (and the
symmetric `y_d`), in normalised coords. Inverse by **Newton's method on the exact
forward model** with backtracking, to a tolerance (not OpenCV's fixed count of
fixed-point steps, which was 0.46 px off at a 4000×3000/f=3000 corner for k1=−0.18 and
3.4 px at −0.20 — errors the self-cal fold baked into every keypoint). Where the
forward curve r·(1+k1r²+…) turns back before the observed corner radius no inverse
exists; the self-cal guard rejects such a bag (`radial-fold`) before it is folded.

**Selectable distortion models** (`DISTORTION_MODELS`, chosen per sensor):
`pinhole` (none) · `radial` (k1) · `radial2` (k1,k2) · `brown` (k1,k2,k3,p1,p2) ·
`rational` (OpenCV's k1–k6, p1, p2: the radial factor is
`(1 + k1r² + k2r⁴ + k3r⁶) / (1 + k4r² + k5r⁴ + k6r⁶)`) · `fisheye1` / `fisheye2` /
`fisheye` (Kannala–Brandt with one, two or four terms, as COLMAP's
`SIMPLE_RADIAL_FISHEYE`, `RADIAL_FISHEYE` and `OPENCV_FISHEYE`).
`distortionOf` applies **only the active model's** coefficients, so a stale k3 from
a model switch can't leak. (A sensor with no model set falls back to all five for
back-compat with pre-model saves.)

**Removed once at ingest** (the load-bearing design choice): sparse keypoints are
undistorted per-point (`undistortPixel`); dense/ortho rasters are undistorted by
building an undistorted→distorted sample map (`distortNormalized`, closed-form
forward). Everything between — F/E, PnP, triangulation, BA, PatchMatch, DEM,
ortho — is pure pinhole and never has to know about distortion. The only
approximation is that the F from matching is fitted on keypoints that are still
distorted when no calibration is known yet; the init pair also tries a five-point E
(§4.2), and BA with self-calibration corrects the rest.

**Fisheye** (`fisheye*` models, Kannala–Brandt): `θ = atan r`,
`θd = θ·(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸)`, the image point at `θd/r` times the normalised
ray. Keypoints are still undistorted at ingest into a pinhole frame for matching
verification, PnP and triangulation, but a ray more than 75° off-axis has no useful
pinhole image and is dropped there (`FISHEYE_MAX_RAY_DEG`). **BA solves a fisheye camera
in the pixels its lens recorded** (`crates/reconstruction` `lens_factor`), so
self-calibration refines the lens terms themselves (k1–k3, then k4 last in Auto, solved
again without k4 if it would fold the curve) instead of folding a Brown bag; after a
solve that changes f, the principal point or the lens, its keypoints are re-mapped from
the recorded pixels. An uncalibrated fisheye starts as the bare equidistant projection
(all terms zero). Depth maps use the field up to 60° off-axis
(`FISHEYE_DENSE_MAX_DEG`). On the FIORD MeetingRoom 200° fisheye (106 images), camera
centres agree with FIORD's model to 0.155 % of the span (median, self-calibrated;
COLMAP 0.180 %, Metashape 0.175 %), and the three self-calibrated lenses agree to ~1 px
in f and principal point; WebSfM registers 103–104 of 106 against their 106, with a
quarter of COLMAP's points at the default keypoint budget.

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

**Axis orientation**: certificates conventionally give fiducial coordinates
**y-up**, while scan rows run down, so scan→mm is a *reflection* (det < 0). Mapping
mm-y straight to canonical pixel-y would make the canonical image a mirror of the
scan — a left-handed camera and a mirrored model that no proper similarity can
georeference. When the sensor's fits are reflections, the canonical frame flips y
(`ySign: −1`) so the canonical camera stays proper. Frames recorded before this carry
no `ySign` and keep their original mapping, so an existing model stays consistent.

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
metric layout dependency.

The native refine searches only ±3 coarse pixels with the coarse winner's prototype
variant and polarity (`nativeRefinePlan`): the coarse peak is already sub-pixel, so
re-sweeping every orientation across a wide window cost ~70× more and could only add a
wrong-orientation peak. Two independent checks then demote suspect marks to review
(never delete), both on the same unfiltered set. **Batch consensus** compares each
slot with the rest of the flight in frame-relative coordinates (raster-relative when
any frame is missing or below the detector's confidence floor). The **opposite-pair
shape gate** (`fiducialShapeCheck`) needs no batch: a camera's fiducials are
centrally symmetric, and an affine scan preserves midpoints, so the midpoints of
opposite marks must coincide (tolerance 0.2 % of the mark extent). With ≥3 pairs the
pair off the median centre is named; with 2 disagreeing pairs both go to review.
Donor templates are drawn only from marks that pass both checks. Confident candidates are persisted as
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

#### Template retry (`core/sfm/fiducialDetect.js`)

Scans the analytic prototypes left incomplete are retried with **real scan patches**:
a square template is cut around each slot's strongest batch-consistent mark (the
donor) and matched, **coarse to fine**, around the slot's batch-median position: a
downscaled pass over the search window, a full-resolution pass around that peak,
then a sub-pixel separable-parabola fit to the ZNCC peak's 3×3 neighbourhood.
**ZNCC** rather than plain correlation because scans of one batch differ in exposure
and development density; zero-mean + energy normalization makes the score invariant
to exactly that affine intensity change.

The module also keeps a **90° rotation probe** (score all four orientations, take a
winner only if it beats every alternative by a margin). The retry disables it, and
it is decidable far less often than it looks: under a symmetric layout every
rotation aligns every mark with *some* real mark. Per-scan rotation/mirroring
detection is open work. The earlier layout-driven detector (calibrated
marks searched at their certificate positions, with an affine-RMS gate per image)
was removed on 2026-10-04: it had no caller, and its per-image geometric check is
covered, without needing a calibration, by the opposite-pair shape gate above.

## 6. Ground control points & georeferencing

Two independent roles for GCPs, both implemented.

### 6.1 Post-hoc similarity fit (`core/products/georef.js`)

The SfM world frame is arbitrary (7-DOF gauge freedom: scale + rotation +
translation). To emit products in a real CRS we fit a **7-parameter similarity**
(`dst ≈ s·R·src + t`) by **Horn's closed-form absolute orientation** (unit-
quaternion method: build the 4×4 `N` from the cross-covariance, take its top
eigenvector). Closed-form, no SVD dependency — matches the crate's dependency-free
spirit.

Correspondences are either **camera centres ↔ camera positions** (pose-based
fit) or **triangulated GCPs ↔ surveyed GCP coordinates**. When ≥3 GCPs triangulate
into the current SfM frame (§6.5, `gcpTriangulation.js`), the **GCP fit is
preferred** over the pose-based one. `gcpAccuracyReport()` reports per-GCP CRS
residual + per-observation reprojection px.
Horn's scalar-weight solution is a stable initializer. When GCPs carry
anisotropic covariance, all seven similarity parameters are then refined against
the full Mahalanobis objective.

Camera positions may be explicitly imported or derived from EXIF GPS. EXIF
longitude/latitude is transformed from WGS84 into the project CRS at ingest;
positions without altitude remain useful for map display and matching preselection
but cannot enter the 3D similarity fit. EXIF altitude is retained with an unknown
vertical datum and conservative default accuracy when the file supplies no accuracy.
Proximity matching uses horizontal distance only; a geographic project is mapped into
one local azimuthal-equidistant metre frame before neighbours are ranked. EXIF altitude
and accuracy remain canonically denominated in metres and are converted when a projected
working CRS uses another linear unit.
Drone XMP is read alongside standard EXIF. Complete camera gimbal yaw/pitch/roll
is converted from the common drone convention (yaw clockwise from true north,
pitch −90° at nadir) into photogrammetric omega/phi/kappa; airframe-only attitude
is not substituted for camera attitude. True-north attitude and east/north RTK
standard deviations are rotated into the project grid, including meridian
convergence, and canonical ENU values are retained so a CRS change can repeat the
conversion without accumulating error. Vendor per-axis RTK fields (including DJI
`RtkStdLon`/`RtkStdLat`/`RtkStdHgt`) override the conservative defaults.
Imported pose files take precedence over EXIF-derived positions.

**The fit is done in a local metric frame, not in grid coordinates**
(`core/products/localFrame.js`, `georef.js` `fitGeoreference`). A similarity assumes
both sides are Cartesian; a projected CRS is not. Grid E/N carry the projection's
point scale factor k (0.980 at 80°S, 0.973 at the pole in EPSG:3031) while heights do
not, and the grid ignores Earth curvature, so fitting straight to grid + height leaves
model error that error-free control cannot remove: 2.1 m RMS on a 6 km block at
80°S, 6.7 m on 10 km at 85°S, with DEM relief compressed by k. A conformal projection
is locally a similarity, so the frame divides out k about the targets' centroid,
corrects k's own variation to second order (for a conformal map that term is fixed by
∇log k), places a point h above its foot at ζ·(1 + h/R) along the tilted normal, and
restores the curvature drop |ζ|²/2R. The residual is third order (~10 µm over 10 km
at 85°S); measured fits drop to 0.07 mm (80°S) and 0.3 mm (85°S) on synthetic
error-free control. The fitted similarity carries the
frame (`sim.local`) and every consumer maps through it back to the grid; GCP
precision scales by 1/k horizontally. A similarity without `sim.local` (older
projects, no CRS, geographic) is the plain grid fit, unchanged.

The fit and the report consume the **non-robust** triangulation (§6.5): every mark
the user placed reaches them, outliers included. This is deliberate — silently
dropping a GCP observation from the fit would hide exactly the disagreement the
accuracy report exists to surface.

### 6.2 Camera positions and GCPs inside bundle adjustment

Enabled 3D camera positions also constrain BA directly. At the end of sparse SfM,
the current camera centres are Horn-fit to the registered project-CRS positions;
the inverse fit maps each surveyed/EXIF position into the current SfM frame. The
Rust solver adds the residual `C − target`, where `C = −Rᵀt`, with the analytic
pose Jacobian `[-Rᵀ | −Rᵀ[t]×]`. X/Y/Z are weighted independently by their
inverse variances after converting accuracy into SfM units. Two rounds let the fit
settle, while a bounded reprojection-increase guard rejects a noisy-position solution
that would materially damage the image measurements.

**The prior BA re-estimates the intrinsics.** It refines the same self-calibration
terms as the last post-filter pass (`cameraPriorRefineIntrinsics: 'auto'`) and folds
them like any other self-calibrated solve (§4.6). A nadir block measured from its own
images alone has a focal–flying-height correlation, and its distortion error bends the
block into a dome. With fixed intrinsics the camera positions cannot remove that,
because moving the cameras without changing f and k would break the image fit. The
fixed-K prior BA therefore stalled on two RTK benches:
- Quarry (347 images): camera-centre residual 0.73 → 0.43 m; with intrinsics refined,
  0.20 m.
- GeoScan (444 images, 15 independent checkpoints): horizontal 6.1 → 4.4 cm and
  vertical 16.4 → 10.8 cm.

With loose positions (consumer GNSS, or the 5 m import default) the prior weight is
small, and the solve leaves the intrinsics where self-calibration put them.

**GNSS antenna offset (lever arm).** The priors are antenna positions, and the camera
centre sits a lever arm `a` away (typically 0.1–0.5 m on survey drones, given per
sensor in camera axes). The antenna is at `C + Rᵀ·a`, so the prior constraint fits the
similarity to the antenna points and moves each BA target back by `Rᵀ·a / s` in the SfM
frame (`core/sfm/surveyConstraints.js`; `R` is the pose when the constraint is built,
rebuilt every round). Without it, RTK priors pull every centre onto its antenna, and
self-calibration absorbs the offset into the principal point. On GeoScan (arm 0.368 m
right, 0.181 m down, 2.9 cm pixels) the no-offset solve moved cx by +12.5 px and cy by
+6.4 px, matching the arm's 12.7 px and 6.2 px almost exactly:

| GeoScan, RTK priors | cx, cy (px) | camera vs RTK (3D) | checkpoints H / V | height bias |
|---|---|---|---|---|
| no offset | 3007.0, 2000.8 | 0.408 m | 4.5 / 10.8 cm | +5.4 cm |
| with offset | 2994.8, 1994.7 | 0.021 m | 5.9 / 10.7 cm | +3.4 cm |
| Metashape (adjusted, with offset) | ≈ 2993.7, 1996.6 | 0.023 m | — | — |

With the offset the calibration agrees with Metashape's to about a pixel, and the cameras
fit the RTK file as well as Metashape's do. The checkpoints move as a block by about
3.6 cm west (their scatter is unchanged), so the horizontal RMS rises: a bias between
the GCP survey and the RTK camera positions, which the wrong principal point used to
offset by chance, is the leading explanation and not yet confirmed.
When GCP anchors are also present, their similarity defines the common SfM target
frame for both point and camera priors. For a geographic project CRS, enabled 3D
camera positions are first transformed into one survey-centred WGS84
azimuthal-equidistant frame, with horizontal coordinates, altitude, and uncertainty
all expressed in metres; this internal frame affects only adjustment, not the
project's display/export CRS. A projected CRS likewise gets one survey frame
(`cameraPriors.js` `surveyFrameFor`, the §6.1 local metric frame centred on the
control and camera positions), and GCP anchors and camera priors are both converted
into it, so the joint pass compares like with like. Positions without altitude
remain post-hoc only.

The constraint builders live in `core/sfm/surveyConstraints.js` and are shared with
**sparse gradual selection**: its refinement BA re-runs the same GCP anchors and
camera priors (marks mapped into the pinhole frame, since the model already lives
there) and accepts the same bounded reprojection increase as the solve. Without
them a re-solve can only lower the reprojection cost, so it would pass its own gate
while quietly undoing a GCP doming correction.

When an imported or EXIF/XMP-derived camera pose also carries a complete
omega/phi/kappa orientation, its rotation constrains the same BA passes. The
photogrammetric image frame
(x right, y up, optical axis −z) is converted to the solver camera frame (x right,
y down, optical axis +z), then composed with the SfM→project similarity rotation.
The solver minimizes the wrapped rotation-vector residual
`Log(R R_targetᵀ)`. Per-axis omega/phi/kappa 1σ accuracies are transformed into a
full tangent-space precision matrix, so anisotropic angular uncertainty is retained;
incomplete orientations remain position-only priors.

GCPs also constrain BA **directly**, not just post-hoc. `bundle_adjust` accepts an
**anchor residual** `δᵀPδ` on specific 3D points, using the full GCP precision
matrix `P`. The CRS covariance (including XY/XZ/YZ correlations) is rotated and
scaled into the SfM frame before solving. Each
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

Surveyed ground coords `x/y/z` with per-axis 1σ accuracy, optional XY/XZ/YZ
correlations, accuracy provenance and vertical datum; pixel `observations`
`[{imageId, px, py, accuracyX, accuracyY}]` with per-observation 1σ pixel
accuracy; an `enabled` flag; and a
`role` (`control` or `check`). Enabled controls enter the similarity fit and
anchored BA. Enabled checkpoints are triangulated and reported against that fit
but never constrain it, so their CRS RMSE is independent accuracy. Disabled
points enter neither solve nor report. A point with <2 marks is unusable (flagged).
Delimited-file import accepts per-row X/Y/Z or horizontal accuracy, correlations,
and per-observation pixel accuracy. Import-wide presets/fallbacks support 1σ, 2σ,
95%-per-axis, HRMS/VRMS and CEP95, in metres, source-CRS units or project-CRS
units. Unknown uncertainty excludes a point from control but retains it for
marking/reporting. Defaults are remembered per project. CRS changes propagate
the full covariance with a local transform Jacobian and rescale Z between units.

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

**Frame**: marks are clicked on the raw scan, while the cameras project into the
pinhole/canonical frame. Every GCP and marker triangulation — the guides, the
georeference fit, the accuracy report, the scale-bar fit and the anchored BA — maps
each mark through its image's chain first (scan→canonical, then remove the
calibrated and the composed self-cal bags; `displayFrame.js` `makeScanToPinhole`),
and guides come back through `makeCanonicalToScan` before drawing. Until 2026-10-03
this was skipped on the store side, which on a film scan meant triangulating raw scan
pixels against the canonical K. A point guide maps exactly; an epipolar line is a
line only in the pinhole frame and is drawn as the chord through two mapped points
(exact for a film affine, a first-order approximation under lens distortion).

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

### 6.6 Scale constraints — the gauge, and why the fit is post-hoc

**Method**: weighted linear least squares for a single scalar
(`core/products/scale.js` `fitScale`), applied as a property of the projection
*frame* (`core/products/projection.js` `frameFromScaledLocal`).

A similarity transform — 3 translation, 3 rotation, 1 scale — leaves every
reprojection residual unchanged. Those seven quantities are therefore the
**gauge freedom** of the reprojection cost (photogrammetry: the *datum defect* of
a free network), and no amount of imagery determines them. §6.1's georeference
removes all seven at once from external evidence. A **scale bar** — a measured
real-world distance between two points the reconstruction can also locate —
removes exactly one of them, and is what a close-range/object project with no
GCPs and no CRS has instead.

The fit is one line:

    s = Σ wᵢ·dᵢ_model·dᵢ_known / Σ wᵢ·dᵢ_model²      residualᵢ = s·dᵢ_model − dᵢ_known

with `wᵢ = 1/σᵢ²` from each bar's declared 1σ (missing σ ⇒ weight 1, reported as
"equal weight", never as a surveyed uncertainty). Endpoints are either a
**marker** — a point with image observations and no surveyed coordinates,
triangulated by §6.5's N-view routine — or a **camera centre**, which costs
nothing because it is already part of the solution.

**Why post-hoc is not an approximation.** Because bundle adjustment is blind to
the gauge, applying a scale afterwards yields *exactly the same model* that
constraining the scale inside the adjustment would have yielded. For a single bar
the two are identical. They diverge only when ≥2 bars **disagree**: a distance
residual inside the optimiser would then deform the geometry to split the
difference between them, while the post-hoc fit leaves the shape alone and
reports the disagreement. That is the more honest answer while the disagreement
is small, and a signal to re-measure when it is not. The in-optimiser variant is
also expensive here — a distance residual couples two point blocks, which breaks
the block-diagonal point structure the Schur complement in `bundle.rs` eliminates
against — so it stays deferred until a dataset shows a bar residual worth the
cost. Note `anchor_flat` (§6.2) is *not* a shortcut: it anchors absolute
positions, which a scale bar does not know.

**Scale never rewrites coordinates.** It rides on the frame:
`fromSfm(p) = s·base.fromSfm(p)`, `toSfm(c) = base.toSfm(c/s)`, with the basis
left orthonormal (scaling `east/north/up` instead would make the two maps stop
being inverses, since `makeFrame` uses them in both directions). Rescaling the
cloud would invalidate the depth-map staleness stamp, contradict every recorded
`summary.*` number and have to be redone on each refit.

**Rank, and what a bar means when it did not define the scale.** One resolver
decides the unit — `CRS georeference > scale constraints > none`. A georeference
already carries a scale, so when both exist the georeference wins and the bars
become independent **checks**. Either way *every* bar reports its residual,
including bars excluded from the fit and bars that cannot currently be measured
(with the reason): a disagreeing bar is exactly the disagreement the report
exists to surface, the same stance as §6.1's non-robust accuracy report.

A scale-bar project is **metric with no CRS**, a combination that did not exist
before. Exports write metric values and no CRS identifier; nothing attaches the
project CRS merely because coordinates are in metres.

---

### DEM co-registration to a reference DEM (Nuth & Kääb, 2026-10-24)

`core/eval/demCoregister.js`, run by `demCompare.js` for a DEM in a CRS (Quality Report
▸ DEM vs reference). On at most 20,000 compared cells on 5–45° slopes, with the
reference's slope α and downhill aspect ψ from central differences at the comparison
spacing: Δh = DEM(p) − ref(p − t); Δh/tan α = δ_N·cos ψ + δ_E·sin ψ + c, fitted by
least squares over cells within 3 NMAD of the median; t += (δ_E, δ_N) until the step
is under 5 % of a cell (≤ 8 passes). `shift` = where the DEM sits against the
reference. Checked against a planted (3, 11) m shift with −2 m bias and noise, and
against a GDAL implementation on Rachel (0.5, 11.0 m vs 0.8, 11.2 m).

**Move the control onto the reference** (`useQualityReport.alignControlToReference`):
every control and check point moves by −shift in the DEM's CRS, its height is refilled
from that reference DEM, and the georeference refits. Rachel (Find GCPs control, medium
depth maps, 20 m DEM): offset (1.9, 11.7) m; NMAD on eroded stable rock 8.8 → 5.4 m,
30–45° slopes 9.2 → 5.3 m; median −1.5 → +2.8 m. The bias is the fit's tilt, not the
move: at the control points DEM − control height has a median of −0.8 m, while rock
inside the control hull sits +2.1 m and 2–5 km out +4.4 m. 27 heights each a few metres
off (fit residuals −17 to +8 m), bunched in 30 % of the block, pin the tilt to a few
metres over 10 km. With 90 candidates (84 control): median +0.7 m, NMAD 5.9 m. hist-sfm, same scoring:
6.4 m, median −2.8 m. Fusion settings (strict, min 4 views, 0.5 % depth tolerance)
changed NMAD by ≤ 0.2 m; DEM `max` aggregation added +11 m bias.

**Cell aggregation** (default `median` since 2026-10-24, was `max`). Rachel, 20 m cells,
aligned control: median +0.7 m / NMAD 5.9, mean +0.6 / 6.0, 75th percentile +4.9 / 6.0,
90th +8.3 / 6.4, max +13.8 / 8.2. Casa Grande (1978 film, lidar reference, 8 m cells,
mostly flat): all within 0.1 m of each other (stable NMAD 0.55–0.56 m). The max bias is
the slope across a cell (±8 m in a 20 m cell on 40°), not just noise. A median whose
per-point buffer exceeds the budget falls back to the mean.

---

### Reference-orthophoto control candidates (coarse to fine, 2026-10-19)

`workers/ops/referenceGcps.js` + `core/sfm/referenceMatch.js`. All coordinates are
native pixel-edge coordinates of each raster, so a homography maps ortho pixels to
reference pixels whatever resolution either was read at (overview reads included,
`core/io/rasterWindow.js overviewLayout`).

1. **Search region**: the georeferenced ortho's footprint, else the registered photos'
   GPS box padded by half its span and ≥ 300 m, else the whole reference.
2. **Coarse, learned** (default, 2026-10-24; `core/sfm/referenceLook.js`): DISK, or
   SuperPoint when installed, with LightGlue. Neither is scale- or rotation-invariant
   (on Rachel DISK held ×0.8–1.25 of the true scale and SuperPoint ×0.8–1.56, both
   ±15° of the true rotation), so each look reads the reference rect at ≤ 2,000
   samples and the ortho at the same metres per sample, turns the ortho to the
   hypothesised rotation (bilinear, into a bounding canvas), detects in 1,024-px tiles
   (≤ 2,048 strongest keypoints per side), matches with LightGlue and fits a homography
   (RANSAC 3 working px, 5,000 iterations, ≥ 20 inliers — hist-sfm's minimum; wrong
   rotations gave ≤ 8). Hypotheses come from a prior similarity ortho px → reference px
   (`fitSimilarity2d`, refit without pairs > 3× the median residual; refused when the
   targets do not spread or misfit > ⅓ of their spread): the georeferenced ortho's own
   grid, else camera centres ↔ GPS, else camera centres of photos within 20° of
   nadir ↔ their footprint centroids (an oblique footprint lies kilometres from its
   camera). The prior's rotation, ±15°, then every 30° at its scale, in its predicted
   footprint padded by ¼ and 3× its misfit. Without a prior (or when it fails): the
   search region and the ortho assumed to cover the same ground (hist-sfm's rule),
   × {1, √2, 1/√2, 2, ½}, each at every 30°. A hit is retried ±10°. The reference is the
   mean of bands 1–3 when it has three or more (film is panchromatic). Rachel (1960s
   film vs Sentinel-2 RGB): prior 199° (true 199.1°), 130 inliers on the first look;
   SIFT at the same scale 8 inliers, 11 of 105 matches true. Candidates against a
   georeference from hist-sfm's Metashape camera centres (bench `vsPoses`; agreement
   with that solution, not survey accuracy): Rachel median
   7.1 m / max 23.5 m, Stubb 5.6 / 13.6 m, Pequod 5.8 / 22.4 m; none over 100 m.
   **Terrain** (`matcher: 'terrain'`, `core/sfm/terrainControl.js` + `alignTerrain`):
   no image matching. The prior, turned into a 3D similarity frame → DEM CRS
   (`terrainInitial`; height offset = median DEM − point), seeds `icpAlign` of every
   sparse point against the DEM window it predicts (± 3 km, read at ≤ 2,048 samples,
   normals from central differences), with scale: point-to-point at 600 m (or 3× the
   prior's misfit) and 300 m, then point-to-plane at 150 and 60 m, trim 0.8.
   Candidates: tracks with ≥ 2 photos whose aligned point lies within 3 × max(RMS, DEM
   pixel) of the DEM, on stable ground, spread as below; σ XY = the RMS. Measured on
   Rachel (sparse points vs REMA at 16 m, offline): from 390 m and 1° off to 14 m
   RMS, the same end point as from the truth; from 1.9 km and 3° it does not
   converge. In the app (REMA 4 m read at ≤ 2,048 samples): RMS 9.5 m, candidates a
   median 13 m from the Metashape solution (DISK + LightGlue: 7 m).
   **Coarse, SIFT** (`matcher: 'sift'`): SIFT (contrast 0.01, ≤ 2 orientations) on a 1,536-px look at the whole
   ortho and the search region; mutual ratio 0.75; homography RANSAC (3 px, 2,000
   iterations; ≥ 10 inliers and ≥ 25 %). On failure, 3×3 half-size then 5×5
   quarter-size overlapping windows: any footprint ≤ ¼ (or 1/16) of the region lies
   wholly in one window, read at 2× (4×) the pixels. Then up to two re-looks at the
   predicted footprint while each halves the window.
3. **Fine**: ≤ 6×6 tiles of 512 px at the COARSER native resolution of the two (a
   feature cannot be located better than that), the finer side read from overviews.
   Matches gated to ≤ max(32 working px, 3 × coarse p95) of the coarse prediction;
   per-tile homography (2 working px); a tile is kept with ≥ 10 inliers, ≥ 30 %, and
   an inlier bounding box spanning ≥ 20 % of the tile both ways (repeated texture
   matches itself in a tight cluster). Per-tile models follow relief and doming. With
   a learned coarse look the tiles match the same way, the ortho tile turned to the
   coarse homography's rotation: SIFT aligned 0 of Rachel's 17 tiles, LightGlue 13.
4. **Candidates**: sparse tracks with ≥ 2 photo observations within 2 working px of an
   accepted match; reference position = matched feature + the tile homography's
   displacement to the track. Spread: best per cell of a √30 grid, then the next best
   ≥ 24 working px apart. Confidence = ratio × min(1, inliers/30) × e^(−r²/2) ×
   (0.8 for a two-photo track) — an ordering, not an acceptance.
5. **σ XY** = `referencePick`: the reference pixel measured in the project CRS
   (metres in a geographic project) × max(1, residual in reference px), in quadrature
   with a declared horizontal accuracy.

Nothing is added unreviewed; elevation needs a declared-accuracy DEM. Temporal
change and strong radiometric differences remain limitations. Verified on synthetic
rotated (25°) 0.5 m blocks in 1 m EPSG:3031 references of 3 and 6 km: median error
< 0.75 m, max < 2 m. Real data: verification check `RAS-09`.

**A-5, picking off a reference raster** uses the same `referencePick` with the
residual replaced by the display factor max(1, 1/zoom, preview downsampling): a click
is good to one pixel as drawn, not as stored.

### User-driven sparse cleanup

Gradual selection uses per-point reprojection RMS, registered track length, or
maximum camera-ray angle. After deletion a fixed-intrinsics bundle adjustment
refines the surviving graph. A disconnected graph, under-supported camera or
missing canonical observation rejects the operation before commit. Calibration
transforms survive; derived geometry and georeferencing are invalidated.

**Optimize cameras** (Metashape's *Optimize Cameras*) is the same constrained
re-solve without the deletion, with the focal length (optionally the principal
point) free and shared per sensor. Both re-solves are held to the GCP anchors and
camera priors of the original solve (§6.2), and accepted under the same cost rule:
an unconstrained solve may not raise the reprojection cost; a constrained one may,
within the survey allowance. Radial terms are deliberately not freed. The model is
pinhole by invariant (§4.6): distortion was folded out of the observations and the
composed bag recorded for dense to reproduce, so a new k₁ would have to be folded
and recomposed or the dense warp would disagree with the sparse model. A focal change
over 20 % is refused as a runaway, not a refinement. That is the failure mode seen on
South Building, where the cost falls while f doubles, and a cost gate cannot see it.

## 7. Dense multi-view stereo

**Method**: **PatchMatch stereo** (Bleyer et al. 2011 lineage) with slanted
support planes, in `core/dense/mvs.js` + `crates/reconstruction/src/mvs.rs`.

- **Stage A — per-image depth maps**: PatchMatch with slanted-plane hypotheses,
  red-black checkerboard propagation sweeps, and decaying random refinement. Cost
  is photometric consistency of the **plane-induced homography** warp into source
  views (best-K aggregation over neighbours). Optional `filterDepthMap`
  (median/speckle cleanup).

  **Sources and sweeps**: up to 10 neighbours per reference and 5 sweeps at the finest
  level (each coarser level one more). Measured on the six ETH3D high-res scenes from the
  ground-truth cameras, F1 at 2 cm by ETH3D's own evaluator (`multi-view-evaluation`):
  6 sources and 3 sweeps 53.6, both raised 56.4, better on every scene (office 37.8 →
  43.0, playground 36.0 → 41.8). With our earlier approximate scorer, which counts points
  in space the laser never saw as wrong: 6 + 3 50.1, 10 sources 51.6, 5 sweeps 51.1, both
  52.6. An 11×11 window scored lower (courtyard 58.2 →
  55.6), and averaging four of six sources instead of three changed nothing: the larger
  candidate pool, not the aggregation, is what fills the surface.

  **Threads** (CPU): a map's red–black half-sweep runs its rows on the threaded build's
  pool (`DENSE_TUNING.cpuDepthThreads`, one worker for the run). Every pixel draws from its
  own random stream, seeded by (seed, pixel, sweep, colour), and reads only the other
  colour, so the map is the same bits on any number of threads (`depth_map_bits_are_pinned`,
  both builds). Aukerman 42 on the CPU: 465 s (8 single-thread workers) → 263 s.
  **Window step** (`DENSE_TUNING.windowStep`, 1): every other row and column of a larger
  window, as COLMAP and ACMM sample, cost 1.4–1.5 F1 on ETH3D for ~30 % less time.

  **Method** (`method`, default *auto*: Full on the GPU, Fast on the CPU; resolved in the
  store, `resolveDepthMethod`). **Fast** is best-K view selection in one pass. **Full** is
  ACMH view selection, then a planar-prior pass, then a geometric-consistency pass, as
  below. ETH3D (official evaluator, Medium, GPU, object defaults, F1 @2 cm, court / deliv /
  office / pipes / playg / terr · mean): Fast 71.7/68.7/55.2/46.5/50.7/79.1 · 62.0; + ACMH
  63.4; + planar prior 72.9/71.0/59.0/49.4/53.2/79.4 · 64.1; + geometric pass
  **74.3/71.9/62.4/53.7/54.3/80.4 · 66.2** (COLMAP at 2,000 px: 58.4). Depth time ~2.2–3×
  Fast's on the GPU (courtyard 66 → 158 → 202 s).

  **ACMH view selection** (Xu & Tao 2019, `patchmatch.wgsl` `acmhSweep`, `mvs.rs`
  `ACMH_*`). Each
  sweep a pixel takes candidate planes from 8 regions of the other checkerboard colour —
  4 V-shapes of 7 samples next to it, 4 strips of 11 out to 23 px — the cheapest of each
  transferred onto its ray. The 8 candidates' per-view costs vote: a view counts when more
  than 2 match it below τ(t) = 0.8·e^(−t²/90) and fewer than 3 above 1.2, weighted by the
  mean of e^(−c²/2·0.3²) over its good costs; the pixel's most important view of the last
  sweep is doubled (0.2 when not selected). The cost is the weighted mean; refinement tests
  6 combinations of a random and a perturbed depth and normal with the current ones. When
  no view passes the vote, every view is weighed by its best match (the paper is silent
  here). The map hands on the best-K photometric cost of its planes. ETH3D (six scenes,
  ETH3D's own evaluator, Medium, F1 @2 cm, object defaults): best-K 62.0, ACMH **63.4**,
  every scene better, accuracy and completeness both up (pipes accuracy 84.7 → 89.4 %).
  On a smooth-noise synthetic plane it is within 1 % on 0.71 / 0.91 of pixels after 2 / 12
  sweeps, best-K 0.51 / 0.78; on a periodic texture best-K is better (a wrong depth matches
  single views of a repetitive pattern). The WASM kernel scores the same (pipes 48.6 vs GPU
  48.7). Time: GPU +40 %; CPU pipes (14 maps, 3 workers) 6,516 s against the GPU's 44 s —
  hence auto = Fast without a GPU.

  **Planar priors** (ACMP, Xu & Tao 2020; `core/dense/planarPrior.js`, `prior_cost` in
  `mvs.rs`, `priorCost` in `patchmatch.wgsl`). After the photometric sweeps, the cheapest
  pixel of each 5-px cell whose cost is below 0.1 becomes a support point; the support
  points are Delaunay-triangulated in the image (`delaunator`), and every pixel inside a
  triangle gets the depth and normal of the triangle's plane (planes meeting the ray at
  |cos| < 0.1 are dropped). A second run of 3 sweeps, seeded with the first map, scores
  a hypothesis by c′ = c²/α − ln(γ + e^(−Δd²/2σd²)·e^(−θ²/2σn²)) with α 0.18, γ 0.5,
  σd = range/64, σn = 5° (Δd the depth difference to the prior, θ the normal angle);
  pixels without a prior keep the plain cost. A textureless wall between textured edges
  gets the plane its edges span. ETH3D +0.7 F1 (3 sweeps; 5 sweeps +0.8, not worth it).

  **Geometric-consistency pass** (λ 0.1, cap 5 px, 2 sweeps; `geom_error` / `geomError`).
  Every source view's first-pass depth map (after the prior) enters the cost: a candidate
  depth is projected into the source, the source's depth there projected back, and the
  forward–backward reprojection error e (px, capped at 5) adds λ·e to that view's cost —
  as in COLMAP's geometric PatchMatch and ACMM. The finalize step still hands on the
  photometric cost, which the downstream NCC gates read. The pass is staged: the first-pass
  maps are saved as usual, the pass reads its sources' depth from them (an LRU of 24
  depth-only planes per worker) and writes `<uuid>.g.<key>.bin`, which replaces the first
  pass only once every map is done (`promoteStagedDepthPlanes`), so memory does not grow
  with the image count. On Fast (best-K) maps it lost F1; on ACMH + prior maps it adds 2.0.

  **Refinement schedule** (`core/dense/refineSchedule.js`): each sweep proposes a
  random normal, a depth-only step and a joint step at scale `s = s₀·0.5^it`; the depth
  step is `±0.5·s·min(d, d_max − d_min)`. Relative to the pixel's **own** depth `d`, as
  COLMAP's `PerturbDepth`, because a step sized by the global range is useless to a near
  pixel on a deep (ground-level, oblique) scene; bounded by the range so a shallow scene
  keeps its finer steps. A coarse-to-fine pyramid **continues** the decay rather than
  restarting it: each finer level starts at `s₀ = 2×` the scale the coarser level ended
  on (headroom for the upsampled seed, whose error is about one coarse pixel). Measured
  on a synthetic 5:1-depth plane through the real kernel: pixels within 1 % of the
  true depth 82.5 → 91.9 % (3-level pyramid), 65.8 → 76.2 % (single level); a shallow
  near-nadir plane is unchanged at a single level and slightly better through the
  pyramid (`patchmatchSchedule.test.js`).

  Per source the cost is **bilaterally weighted** ZNCC (`1 − ncc`, in [0, 2]), as in
  COLMAP: each window sample counts with `exp(−d²/2σs² − Δ²/2σc²)`, `d` its distance
  from the centre (px), `Δ` its grey difference from the centre pixel, σs = the window
  radius and σc = 25 grey levels (COLMAP: 0.2 of the range, 51). Measured on ETH3D (six
  scenes, from the ground-truth cameras, F1 @2 cm, approximate scorer): plain 52.6, σc 51
  53.2, **25 53.5**, 12 53.3, 6 52.3 — narrower bands keep trading completeness for
  accuracy. ETH3D's own evaluator, plain vs σc 25: 56.4 → 57.1, five scenes better and
  terrace equal. It costs no measurable
  time; an 11×11 window stayed worse than 7×7 with the weighting too. Best-K averages only
  sources that *measured* the pixel: a warp leaving the source, a masked texel or
  <4 overlapping samples returns a no-measurement sentinel and is excluded. A flat
  patch is split by side (variance floor 1e-6 on the 0..255 scale, identical in
  all three kernels): a flat **reference** patch is unmeasurable ⇒ excluded, but a
  textured reference warped onto a flat **source** patch (saturated snow, sky,
  shadow) is evidence *against* the hypothesis ⇒ the max cost 2.0. Excluding it
  instead let a wrong depth that lands on flat areas in all but one source win on
  that one source's chance correlation. ZNCC sums are accumulated over values
  shifted by the first contributing sample — identical mathematically, but the
  f32 GPU kernel otherwise loses the variance of a bright low-contrast patch to
  cancellation (raw Σx² ≈ 7·10⁶; ~10⁻² cost error at grey 240 ± 1.5).
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
  A view is consistent when `e ≤ maxGeomCost` (px) **and** its triangulation angle at
  `P` with the reference is ≥ `minGeomAngleDeg` (3°, COLMAP's
  `filter_min_triangulation_angle`, likewise applied per view); `minConsistent` such
  views are required. The angle gate exists because at ~0° parallax the round trip is
  vacuous: a source beside the reference looks down the same ray, so *any* depth there,
  a sky pixel at an arbitrary distance included, returns to `(u,v)`. Fusion's own
  parallax gate cannot stand in for it: it cleans only the fused cloud, while this pass
  also cleans the persisted maps the orthophoto uses as a z-buffer. A pixel that fails
  only for want of parallax is logged as such, separately from a genuine disagreement. An absolute `minNcc` floor also applies. Because of it, fusion's own
  `maxCost` is only a loose fixed backstop (0.8). It was an adaptive p70 of the pooled
  costs (clamped to 0.30–0.45) until 2026-10-12, which by construction dropped ~30 % of
  pixels this floor had already vetted: on ETH3D the fixed gate raised the mean F1 at
  2 cm from 52.6 to 58.9 (COLMAP 59.1) with accuracy unchanged on every scene, and on a
  LiDAR-checked aerial block it was neutral.

  Sampling **one** source pixel is what makes this discriminate. Fusion's own check
  (below) searches a `(2·consistencyPx+1)²` window and accepts if *any* pixel there is
  within a relative depth tolerance — a noisy depth cloud such as a bush almost always
  has *some* pixel near the right depth by chance, so it passes. That is why freckles
  survived fusion before this stage existed.

  **Candidate views**: each reference is judged against at most
  `DENSE_TUNING.filterMaxViews` (12) of the maps that overlap it. They are the nearest
  cameras whose baseline reaches the parallax gate at the reference's median depth,
  then the nearest of the rest: plain nearest-first picks cameras that can vouch for
  nothing (the three cameras of one aerial station sit within metres of each other).
  Every candidate plane is resident while a reference is judged, and a pixel that
  fails is tested against all of them, so on a 58-scan film block at High (~50
  overlapping maps each, 108 MB a plane) the uncapped filter needed 5.4 GB per worker
  and 30 min on the one worker that fitted; capped, 4.4 min on 3 workers, with the
  DEM's error against REMA and a reference DEM unchanged (coverage −3 %).

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
  is nearly empty (fusion flyers). Every cell is judged against the unfiltered
  occupancy, so the result does not depend on cell order. That is also what lets a
  large cloud be fused in slabs along the scene's long axis (one slab's accumulator
  resident at a time) with a one-cell halo and give the identical cloud. The
  accumulator's arrays, and a finished cloud past 2 GiB, live in WebAssembly memories
  (`core/bigArray.js`; shared ones for the cloud), which neither Chrome's 2 GiB
  per-ArrayBuffer cap nor its 16 GiB ArrayBuffer pool per tab applies to: with Memory64
  one accumulator holds 2³⁰ cells and a cloud 1.4 G points, and only the inputs and the
  finished slabs count against the pool. The prior gates (per-pixel cost `maxCost`,
  cross-view agreement count `minViews`) still run first. Like the cross-view filter,
  the consistency check compares each map with at most `DENSE_TUNING.fuseMaxViews` (12)
  of the maps whose frustum reaches it, those with the gate's parallax at its mean
  depth first (`fusionViews`, chosen once in the plan, so resident and streamed fusion
  give the identical cloud). Over saved maps the pre-passes (cost statistics, bounds,
  cloud size, slab outlines) read only depth and cost, and the valid count comes from
  the saved index: on 58 film maps at High fusion went from 22 to 7.8 min, most of it
  plane reads from disk.
- **Oriented normals for free**: PatchMatch already estimates a per-pixel plane
  `(depth, normal)`. Rather than re-estimating normals later (k-NN PCA +
  orientation propagation, the usual Poisson prerequisite), both backends export
  the converged **camera-frame** normal; fusion rotates it to world (`Rᵀ·n_cam`)
  and voxel-averages+renormalizes it onto each dense point (`DenseCloud.nrm`).
  Because the kernel keeps `n_z < 0` (facing the camera), aerial coverage yields
  consistently **outward-oriented** normals — exactly what screened Poisson needs.

**Two backends**, same math: **WebGPU** is preferred automatically when the browser
exposes it, with **WASM/CPU** as the unsupported/error fallback and an explicit user
opt-out. The GPU kernel (`workers/gpu/patchmatch.wgsl`, ~0.1 s/img vs minutes on
CPU) retains per-image fallback and a first-image A/B validation
(`GPU validate: … RMS …`, must stay < 5e-3).

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
  and discard. Metashape additionally offers manual masking, which WebSfM supports
  (masked pixels are excluded as ZNCC source texels, not merely zeroed). Automatic sky
  detection by a blue/brightness prior is actively unsafe for polar imagery, where
  snow/ice vs sky is genuinely ambiguous.

---

### Keeping valid depth maps (`core/dense/depthReuse.js`, 2026-10-30)

A depth run keeps a saved map when the index's sparse stamp still matches the model (a
rebuild changes it; Add to the model ▸ Fixed keeps it), the run's shape hashes to the
index's `mapsKey` (`depthRunShape`: the settings that shape a map, Auto resolved to the
method that actually ran, the working resolution after any memory step-down, the scene
type and the region), and the map's camera as the run hands it to the worker (pose, K,
lens, self-cal bag, film transform, mask) hashes to its entry in `cameraKeys`. The saved
index is cut to the kept maps before anything is computed, so a run that stops leaves
no entry naming an overwritten plane. Only the other maps run pass 1 and pass 2, with
every image a candidate source and the kept maps read as pass-2 neighbours, and only
they are judged by the cross-view filter, against every map (the kept ones were
filtered when they were made). The kept maps are not recomputed with new neighbours,
which a full run would do, so it is a setting (on).

## 8. Products (DEM, orthophoto)

`core/products/`:
1. **Local vertical frame** (`projection.js`) — auto-orient to a Z-up frame
   (aerial assumption) from the camera geometry, so "up" is meaningful before
   gridding. See §8.0 for which camera signal sets "up".
2. **DEM** (`dem.js`) — bin the dense heights into a grid over the cloud's dense
   core (§8.0), IDW-fill gaps, hillshade for preview.
3. **Orthophoto** (`ortho.js`) — **true** orthorectification: reproject using the
   cached dense depth maps as a z-buffer (occlusion-correct) and sample colour from
   the source photos, mosaicked by viewing geometry with gains and feathering (§8.2).
4. **Georeference** (optional, §6) — when present, products carry CRS coordinates
   and true scale; otherwise they live in the local frame.

### 8.0 Where "up" comes from, and what area a product covers (2026-10-09)

**Up.** Without a georeference, the vertical is estimated from the cameras. Three
readings exist, and each fails somewhere:
- the reversed **mean viewing direction** is right for a nadir survey and tilts with
  the gimbal on an oblique one. It is a trimmed mean (`geometry.js`
  `trimmedViewDirection`): passes keep the cameras within 40°, 30°, then 25° of the
  current mean, so a block that mixes verticals with obliques uses its verticals;
- the mean **image-up axis** is right for hand-held terrestrial photos and horizontal
  on a nadir survey;
- the normal of the **camera-centre plane** is right whenever the cameras share one
  height — a drone flight plan, a walk on level ground, a turntable ring — and
  undefined for a single strip or a 3D cloud of positions.

The plane normal wins when the centres are a usable plane (thinnest spread ≤ 5% of
the middle one, middle ≥ 20% of the largest) **and** the cameras look at it more than
25° off its normal (`core/sfm/geometry.js` `planeUpOverride`); otherwise the earlier
rules apply. The 25° gate keeps nadir surveys on the viewing direction, because a
terrain-following flight tilts its camera plane with the slope (rarely beyond ~25°)
while the gimbal still points down. The case that motivated it: the St Nazaire set,
127 DJI frames all facing south at −26° and −50° pitch, whose mean viewing direction is
55° off vertical. Every product, the 3D view and the post-SfM aerial auto-orient were
tilted by that much; the camera plane (0.06 m thick against 6–18 m of spread) is level
to well under a degree. Two known blind spots: an oblique set shallower than 25° keeps
the old tilted reading, and a vertical camera grid in front of a facade looks like a
nadir block turned 90° and cannot be told apart from camera geometry alone.

The trim came from a historical (TMA) block, Rachel Glacier: 30 vertical frames with 12
left and 16 right obliques about 60° off nadir. The obliques do not balance, so the
plain mean was 21° off vertical (against hist-sfm's Metashape camera centres), under the 25°
gate. The local DEM and ortho were projected onto that tilted plane, which shears the
relief by hundreds of metres, and Find GCPs could not align either with a map. The
trimmed mean keeps the 30 verticals and is 0.3° off. A nadir block, a nadir block with
obliques all round, and a single oblique look (St Nazaire's two pitches are 24° apart)
keep their plain mean.

**Sign.** The plane's normal and the viewing direction say which way is vertical but
take their side from the viewing direction, which assumes the cameras look down. Photos
taken from the ground look up at their subject: South Building (128 frames walking
around a building, the trimmed viewing mean 26° off the plane normal) showed upside down
in the 3D view. Outside an aerial project the mean image-up axis decides the sign when
it lies within 60° of the answer's line, since an unrolled camera's image-up axis
leans up whether it looks up or down (`estimateUpFromCameras`, option
`aerial`). An aerial project keeps the viewing direction's sign, because a scanned frame
can be stored rotated and its image axes then say nothing. The aerial auto-orient
therefore still turns a ground-level set over when it is run as aerial; it warns
instead (`products/projection.js` `camerasLookUp`).

**Extent.** A product covers the cloud's **dense core** by default (`dem.js`
`coreExtent`), not its raw min/max. An oblique capture sees almost to the horizon, and
a thin far field of points would otherwise set the raster size, coarsen the automatic
GSD and leave most cells empty. Far background thins out per unit area, so the core is
found by density: trim extreme flyers with 0.1/99.9% quantiles, histogram the points
on a 128×128 grid, and keep the bounding box of the cells holding at least 2% of the
density a typical point sits in (the point-weighted median cell count). A second pass
over the first box sharpens the edges to ~1% of the site. Points outside are left out,
never clamped onto the border, and the run logs how many (warning above 5%). A
cell-percentile reference would not work: when background occupies most cells, the
percentile is itself background and nothing is cut. Extent ▸ All points restores the
raw box, and a Region still bounds the input before any of this.

### 8.1 The ortho reprojects onto a *surface*, and the DEM is only one of them

`orthorectify` walks a height grid (`{width, height, gsd, originX, originY, data,
mask}`); which surface fills that grid is a user choice (Metashape's *Build
Orthomosaic ▸ Surface*), built by `core/products/surface.js`:

- **DEM** — the binned/IDW-filled height grid above. Every DEM hole is a transparent
  ortho cell, which is what makes a sparse-coverage ortho look patchy.
- **Mesh** (`meshSurface`) — a from-above z-buffer rasterisation of the Poisson
  triangles. Watertight ⇒ a dense mask, so it is the cure for that patchiness.
- **Plane** (`fitPlane`/`planeSurface`) — a robust least-squares plane through the
  cloud, for genuinely flat scenes.

`resampleSurface` decouples the ortho's GSD from the surface's: a coarse surface
reprojects fine, while the ortho wants image detail. Consequences worth stating:
an ortho therefore **carries its own geotransform** (`gsd`/`originX`/`originY`/
`frame`/`crs`) rather than borrowing the DEM's, and rebuilding a DEM only
invalidates an ortho whose surface *was* that DEM.

### 8.2 Which photo colours a cell: the mosaic (2026-10-12)

Most ground is seen by several photos, so an orthophoto is a mosaic and needs a rule
for which photo supplies each cell. The default (`blend: 'mosaic'`) follows the classic
production recipe (nearest-nadir seamlines, Brown & Lowe gain compensation, feathering),
with two departures noted below.

1. **Source labels by geometry.** Every visible view (z-buffer agreement within
   `depthTolRel`, matching cost ≤ `maxCost`, seen from above the surface) is scored by
   its foreshortened footprint, `depth / (f · cos² θ)`, θ the angle between the ray to
   the camera and the frame's vertical, and the lowest score wins. On a nadir block at
   one altitude that is the most nadir view, so labels form the nearest-nadir
   (Voronoi-like) partition; lower flights win where they overlap, and the tilt is
   counted twice so a nadir view beats a closer oblique one (one cos would be the
   pixel's true ground footprint, which lets a near oblique view win and makes
   buildings lean). Matching cost is a gate only: as a *choice* (the old `best` mode)
   it is a texture statistic that switches source from cell to cell (87 seam pairs per
   100 cells on quarry-80, against 20 for the label map). Two 3×3 majority passes then
   remove single-cell flips; a cell whose smoothed label cannot see it falls back to
   its own first choice.
2. **Gain compensation**, per image and colour channel, in linear light. Overlap means
   come from a lattice of ~65 k cells sampled from photos decoded at ~2 px per lattice
   spacing, with clipped samples (any channel ≤ 4 or ≥ 250) left out. *Departure 1*:
   the fit is in the **log domain**, `Σ_pairs N_ij (x_i − x_j − log(Ī_ji/Ī_ij))²/σ²
   + κ Σ_i W_i x_i²` with x = log g, W_i the image's own overlap weight and κ = 0.01.
   Brown & Lowe's linear form `Σ N (g_i Ī_ij − g_j Ī_ji)² + prior on (1 − g)` is
   minimised by shrinking every gain towards 0 wherever ratios disagree around loops;
   on quarry-80 it gave a median gain of 0.62. In logs a common factor costs nothing, so
   the prior only fixes the level (overlap-weighted mean log gain = 0) and, being
   relative, limits drift from small per-pair biases to a correlation length of
   ~1/√κ ≈ 10 images while matching two neighbours to ~½ %. Gains are clamped to
   0.25–4 (±2 stops; widened 2026-10-18: on quarry-80 auto-exposure moved the aperture
   f/2.8 → f/5 over the flight, the fitted gains follow the EXIF exposure t·ISO/N² to
   15 % rms in log, and at ±1 stop the last twelve photos sat at the clamp).
3. **Feathering.** Each image contributes to the cells within `seamCells` of its own
   region (default 1 % of the ortho's short side, ≤ 128 cells) with weight
   `(3·seamCells − d) / (3·seamCells)`, d the integer 3-4 chamfer distance to the
   region; colours are averaged in linear light. *Departure 2*: no multiband
   (Burt–Adelson) blending yet. It would only be needed if feathering ghosts
   misregistration inside the band, and that has not been seen so far.

Measured on 80 images of the quarry block: the seam ratio (colour
step across seams ÷ within one photo) falls from 2.76 (best) to 1.39, and from 5.88 to
2.18 at the photos' GSD. The detail inside a photo is unchanged. Tenengrad sharpness
drops, because best's dense switching between misregistered sources reads as gradient.

Exports: PLY, model JSON, DEM GeoTIFF/.asc, ortho GeoTIFF/PNG+.wld, mesh PLY/GLB
(`exporters.js`, `geotiff.js`).

#### 8.2.1 Graph-cut seamlines and multiband blending (2026-10-18, now the defaults)

`seamline: 'graphcut'` (`core/products/seamCut.js`) chooses the label map by energy
minimisation instead of the nearest-nadir partition (Kwatra et al. 2003; Agarwala et al.
2004): data cost 600 · (s_l / s_best − 1) on the foreshortened footprint s above (the
most nadir view costs 0), seam cost 6 + Σ|ΔRGB| (sRGB levels after the gains) between
the two photos at both cells, 150 where one photo does not see the cell. Solved by
alpha-expansion (Boykov, Veksler & Zabih 2001; moves that the truncation of a non-metric
V would worsen are rejected, so the energy never rises) with a grid max-flow
(`gridMaxflow.js`, Boykov–Kolmogorov). A min cut is global, so it runs once for the whole
ortho on a coarse grid of ≤ 2²⁰ cells (every f-th cell, 8 candidate views each) before
the blocks; each block reads its labels from that grid, so labels do not depend on the
block layout and seams run on coarse-cell edges. Fixed expansion order and integer
capacities make it deterministic.

`seamBlend: 'multiband'` (`multiband.js`) blends across seams with a 5-level Laplacian
pyramid (Burt & Adelson 1983), written as a correction to the hard-seam mosaic: result
= base + collapse_k(Σ_j G_k(M_j) L_k(d_j) / V_k), d_j = photo j minus the base, non-zero
only on a ring of 2^(L+1) cells around j's region, so a cell deep inside a region keeps
its photo's colour exactly. Normalised convolution (V_k) keeps data edges from darkening;
block windows are aligned to the 2^L lattice with a halo of 4·2^L + ring cells, so
blocks join bit for bit.

Visibility: a depth-map hole (the cross-view filter removes weakly matched pixels) no
longer means "not seen": the nearest agreeing depth within 2 map pixels stands in, never
overriding a nearer (occluding) depth. Without it the label map speckled (21 label
switches per 100 cells on quarry-80, 8.5 after).

Quarry-80 (2,179 × 4,096 cells at 5.8 mm, 80 photos; seam ratio = mean colour step across
seams / inside regions, lower is less visible; times under heavy machine load):

| seamline + blend | time | sharpness | seam ratio |
| --- | --- | --- | --- |
| nadir + feather (old default) | 68 s | 7.03 | 1.58 |
| graph cut + feather | 79 s | 6.80 | 1.30 |
| nadir + multiband | 103 s | 7.54 | 1.66 |
| graph cut + multiband | 116 s | 7.50 | 1.49 |

Graph cut moves seams off roofs and tree crowns (fewer, cheaper seams); multiband keeps
~7 % more detail than feathering (which averages two photos over the band) at the price
of a slightly sharper residual step. Visual review: verification check `PRD-31`.

### 8.5 Mesh — screened Poisson surface reconstruction

**Method**: **screened Poisson surface reconstruction** (Kazhdan & Hoppe 2013),
`crates/mesh` (WASM) + `core/products/mesh.js`. It solves for an implicit
indicator function whose gradient matches the oriented point normals (the
"screening" term additionally pulls the level set toward the sample points),
then extracts the surface with marching cubes. On a photogrammetric cloud the
solve alone is not a usable mesh, for the same reason PoissonRecon ships a second
program (`SurfaceTrimmer`): the solution is closed and defined everywhere, so it
extrapolates a hull past the data and wraps every speck of fusion noise in its
own shell. The cleanup below is part of the method, not a cosmetic option.

- **Why Poisson, and why it's cheap here**: Poisson needs *oriented* per-point
  normals. Normally that's a separate estimation stage; we reuse the dense
  PatchMatch plane normals (§7), so the only new heavy compute is the multigrid
  solve itself.
- **The solve must converge.** The multigrid is *cascadic*: each layer solves only
  for the residual the coarser layers left, by conjugate gradient. The vendored
  library started each layer's CG from `x₀ = b` (the right-hand side) and ran a
  fixed 10 iterations, which does not wash that guess out. The leftover residual is
  closed, cell-sized ripples of the implicit function. On a clean, 8000-sample unit
  sphere at depth 6 that was 444 surface components with 47 % of the area off the
  sphere (radius RMS 0.094). From `x₀ = 0`, with a 10⁻⁶ relative-residual stop, the
  same solve gives one component at RMS 0.0004 in ≤ 10 iterations. This was the main
  cause of the 2026-10-07 "blob field" eagle mesh.
- **Input conditioning** (`core/products/mesh.js`): the octree spans the input's
  bounding box, so stragglers far outside the object (outside the 1–99 % per-axis box
  grown by 25 % of its largest side) leave the solve. The requested depth is lowered
  when its leaves would be finer than the sample spacing (the fusion merge cell, or
  the median nearest-neighbour distance for an imported cloud): those levels resolve
  nothing. Lone stray points go before the solve (each still costs octree nodes). The
  cloud is then voxel-thinned to ≈ one sample per leaf, and **each sample keeps how
  many raw points it stands for** as its *support weight*.
- **Iso-value**: the surface is the level set at the **support-weighted average of
  the implicit function at the input samples**, not the naive `0` (the reference
  implementation also uses a sample average). Weighting by support stops a cloud of
  one-point strays from pulling the level off the well-supported surface.
- **Support trimming**: each sample's support weight is splatted onto a lattice four
  leaves wide (trilinear). A triangle whose mean vertex support is below a fraction of
  the *median sample's* support is removed (gentle 0.1, strong 0.3). Because the
  threshold is a ratio, it means the same at every scale. This removes the
  extrapolated hull and the thin shells around specks. Extraction is bounded to where
  the support is non-zero, so the hull is never generated at all.
- **Hole refill**: a trimmed region that is closed (no open edge, so it was not cut by
  the extraction bound) and no larger than 5 % of the kept piece it borders is a hole
  the solve legitimately bridged, and it is added back (cf. PoissonRecon's `--aRatio`).
  It is compared with the *bordering piece*, not the whole mesh. A speck's shell is
  also closed and attached to kept surface (the speck itself), and next to the whole
  mesh it looks small. On the floater fixture, comparing with the whole mesh restored
  9 of 29 blobs.
- **Floating pieces**: a connected component is dropped when it explains less than
  1 % of the support of the best-supported component. Support here is the summed
  weight of the input samples whose nearest kept vertex lies on that component.
  Measuring by **evidence rather than area** is the point: Poisson inflates a 20-point
  speck into a ball a few cells across, about 1 % of a sphere's area in the fixture
  while explaining 0.25 % of its samples.
- **Distance trim** (optional, off by default): cull any triangle whose three vertices
  are all farther than `distanceTrim ×` the input sample spacing from the input. It
  removes extrapolated sheets, but it cannot remove a speck's shell, which by
  construction lies within any trim radius of its own speck.
- **Colour**: Poisson vertices are new points, so colour is transferred from the
  nearest dense-cloud voxel cell (3³ neighbourhood search), then retried on a
  leaf-sized grid for vertices farther out (refilled holes, smoothed creases) before
  falling back to gray.
- **Tiles** (`tiles: auto`, `core/products/meshTiles.js`): a scene whose solve would
  not fit one heap (projected 768 MB + 10 KB a sample; ~12 GiB with Memory64) is solved
  in tiles on a 2-D grid over its two longest axes, each holding ≤ 3 GiB of samples plus
  ≥ 12 leaves of overlap (the trim's support cell is 4 leaves and reaches 2 cells, plus
  a cell of lattice rounding). Every tile is solved on
  the scene's own leaf grid (`build_on_grid`), so marching cubes puts the vertices of
  neighbouring tiles on the same lattice edges; a tile keeps the triangles whose
  centroid's cell is in its core, and vertices on a seam are welded by lattice edge,
  found exactly from the position (two coordinates on the lattice). Every tile trims
  against the scene's median support (computed as the crate does, over all samples);
  floating pieces are judged on the stitched mesh by the samples they explain. On a
  synthetic terrain in 4 tiles: median 0.007 leaf from the one-piece solve, triangle
  count within 0.4 %, and open edges along the seams as in the one-piece solve (28 vs
  23 of ~3,340, where the seams meet the scene's edge). With holes crossing the seams
  the tiles add open edges there (+1.7 % of the seam band at an 8-leaf overlap, +0.6 % at
  12): hole refill is decided per tile, and a hole only partly inside a tile's domain
  is not closed there. Moving the trim and refill after the stitch would remove that.
  Quarry, 95 M points at depth 10 (one solve ≈ 17.7 GB): 16 tiles, 2,831,258 triangles
  in 834 s, 2.2 % of seam edges open (its trim removes a quarter of the surface).
- **Knobs**: octree `depth` (detail vs cost/RAM, auto-capped by the spacing),
  `screening` weight (fit tightness; **not** PoissonRecon's samples-per-node, which
  this library does not expose), `trim`, `fillHoles`, `removeFloaters` /
  `minPiecePct`, `distanceTrim`, `tiles`.
- **Implementation note**: the solver is a **vendored, rayon-stripped** copy of
  Dimforge's `poisson_reconstruction` (rayon's worker threads panic on threadless
  wasm). Its assembly is restructured without changing the system it solves. The
  coarse-layer screening term uses the coarser solution evaluated once per sample.
  The gradient terms come from tables keyed by integer lattice offset, and the
  coarse-layer gradient term uses the exact B-spline refinement
  (`B_{2w} = Σ [1,3,3,1]/8 · B_w` per axis) to prolong the coarser solution into
  each layer's basis. On a fixed reference solve the coefficients agree with the
  original to 8.5·10⁻¹³ (relative to magnitude 3), and a 65k-point depth-8 solve went
  from 281 s to 18.6 s (native).

### 8.6 Point-cloud, mesh and raster tools (Tools tab)

All of these are post-processing of a finished product. Every edit produces a new
cloud or mesh; nothing here feeds back into the solve.

- **Neighbour search** (`core/products/knn.js`): one exact static k-d tree (median
  split on the widest axis, leaves of 12, tree-ordered positions) behind normals,
  ICP and cloud-to-cloud distance. A uniform grid answers queries near the data;
  these tools also query far from it (another epoch, an unaligned start), where a
  grid shell-walk costs the empty volume it crosses.
- **Normals** (`cloudNormals.js`): PCA of the k = 16 nearest neighbours, normal =
  eigenvector of the smallest eigenvalue (cyclic Jacobi on the trace-normalised 3×3
  covariance, built about the neighbourhood centroid in double precision). Each point
  is oriented independently, toward the nearest camera centre or toward +up. There
  is no minimum-spanning-tree propagation, so the result is deterministic.
- **Alignment** (`cloudAlign.js`): point pairs use Horn's closed-form similarity
  (`georef.js`, §6.1), and the rigid variant keeps Horn's rotation and re-solves the
  translation. ICP is trimmed (90 %) and point-to-plane (a linearised 6-DoF step,
  damped Gaussian elimination, Rodrigues update, re-orthonormalised R) when the
  reference has normals, otherwise point-to-point Horn. It runs in a frame centred on
  the reference centroid. It is local: it needs an initial overlap within the search
  radius, and there is no global registration.
- **Distance** (`cloudDistance.js`): cloud-to-cloud is the nearest-point distance,
  signed by the reference normal; with k ≥ 3 it is the distance to a local
  least-squares plane, which removes the point-spacing floor. Cloud-to-mesh is the
  exact point-to-triangle distance (Ericson). Candidates come from a k-d tree over
  triangle centroids, searched to d* + r_max, where r_max is the largest
  centroid-to-vertex radius, in radius tiers. This is exact, because no triangle
  farther than that can beat the current best.
- **Mesh cleanup** (`meshEdit.js`): edge topology from counting sorts of half-edges;
  components by union-find; long-edge bridges against the median edge; boundary
  loops filled by a centroid fan wound against the loop's own half-edges (so the
  seam becomes a manifold edge). **Taubin** λ = 0.5, μ = −0.53 (uniform umbrella
  Laplacian) smooths without the shrinkage of repeated Laplacian smoothing. Volume
  (⅙ Σ v₀·(v₁×v₂), about the bbox centre) is reported only for a closed,
  consistently wound mesh.
- **Decimation** (`meshDecimate.js`): Garland–Heckbert quadric edge collapse,
  area-weighted plane quadrics plus boundary-constraint quadrics. Collapses are
  rejected by the link condition, a normal-flip test and a degenerate-triangle test.
  Position is the better of the 3×3 solve (when well conditioned and near the edge)
  and the best point on the edge, which keeps flat regions flat and straight borders
  straight. Ties break on the shortest edge.
- **Ground classification** (`groundFilter.js`): the cloth simulation filter (CSF,
  Zhang et al. 2016), mirrored in z: the cloth rises from beneath the upright cloud
  instead of falling onto the inverted one. Collision height per cell = the lowest
  point (isolated one-cell dips more than 1 m below all but one of ≥ 5 measured
  neighbours are raised to their median; empty cells copy the nearest measured cell,
  BFS). Verlet with the reference constants (gravity 0.2·0.65² m per step², damping
  0.01), springs to the 8 neighbours and the 8 at distance 2 visited from both ends,
  moves ½(1 − 0.4ʳ) between free particles and 1 − 0.7ʳ towards a pinned one (the
  reference code's lookup tables in closed form, r = rigidness). Stop when no free
  particle moves 5 mm. Slope post-processing pins free particles reached from pinned
  ones through 4-neighbours whose collision heights differ by < 0.3 m (the paper's
  terrain-continuity rule; without it a stiff cloth settles below steep flanks,
  28 % ground on a 30 % synthetic valley vs 100 % with it at 1 m). Class from the
  point's height above the bilinear cloth: within ±0.5 m ground (2), above
  unclassified (1), below low point (7), outside the dense core 0. Lengths are
  metres converted to frame units, the simulation constants included. Measured on
  synthetics: 1 m cloth spans 30 m roofs, not 80 m (12 % of roof points ground);
  2 m spans 80 m. Default 1 m because steep (polar) terrain is the common case here.
- **Buildings and vegetation** (`pointClasses.js`, Classify Points steps 3–4, 2026-10-30):
  rules on the points the cloth left above ground, with their height above it. The
  points fall into 0.25 m voxels (centroid, mean colour, highest height above ground),
  doubled up to 1 m while an occupied voxel holds fewer than two points (a sparse
  survey's surfaces would otherwise leave their voxels apart), with the radius at least
  2.5 voxels (at exactly 2 a tilted plane's lattice neighbours count along one axis
  only). Each voxel's covariance over the voxel centroids within 1 m gives
  λ1 ≥ λ2 ≥ λ3, planarity (λ2 − λ3)/λ1, scatter λ3/λ1 and a normal (Weinmann et al.
  2015). Planar voxels (planarity ≥ 0.5, scatter ≤ 0.06) grow into segments over
  26-adjacency with normals within 20°. A segment reaching 2.5 m above the cloth with a
  surface of 10 m² (voxel count × voxel²) is building, unless its mean ExG (2g − r − b
  on chromatic coordinates, Woebbecke et al. 1995) is above 0.06; a mostly vertical one
  (mean |n_z| < 0.5) only when it lies within a radius of a roof, so a retaining wall
  alone is not a building. Building segments then take the non-green voxels within 1 m
  (their edges and corners, which see two planes and so scatter). Vegetation is a voxel
  that is green, or that scatters more than 0.06 and lies more than 1 m from any planar
  voxel (scatter beside a plane is the edge of something built), never one clearly not
  green (ExG < −0.06), banded by its height above ground at 1 and 3 m. Each point takes
  its voxel's class. A streamed cloud runs per tile with the ground filter's 30 m
  margin. On a synthetic site at drone density (building, five trees, four shrubs, a
  car): buildings 99.6 % recall, trees 100 % high vegetation, shrubs 100 % vegetation,
  the car 90 % unclassified, with and without colour. UseGeo's MVS cloud (150 × 150 m,
  16 M points, Sardinia): 5.9 s against 1.2 s for the ground alone on one thread; by eye
  roofs, crowns, the olive rows and the retaining walls are right, and a sloped concrete
  canal bank reads as roof. Not yet scored on labelled data. Known limit: on a sparse
  cloud without colour (voxels at 0.5–1 m), small boxy objects such as cars scatter at
  that scale and can come out as vegetation.
- **Enclosed gaps in a DEM** (`dem.js` `fillEnclosedGaps`, Build DEM ▸ Fill enclosed
  gaps, on for Ground only): nodata not connected to the grid border (BFS) is filled
  by pull–push (Gortler et al. 1996): a pyramid of 2×2 weighted means with weight
  min(1, Σw), then a push that blends each level with the bilinear level above by its
  weight. Border-connected nodata is the survey edge and stays.
- **Sections** (`cloudSection.js`): points within ±t/2 of the vertical plane through
  A→B, as (station, height, signed offset).
- **Contours** (`contours.js`): marching squares on cell centres. A saddle is
  resolved by the quad-centre mean, a level equal to a sample counts as above, quads
  touching nodata are skipped (lines end at holes), and segments are joined by exact
  integer edge ids.
- **Terrain derivatives** (`terrain.js`): Horn's 3×3 gradient (gdaldem), with the
  horizontal spacing gsd/k for the projection's point scale factor k (heights never
  scaled). Aspect is the downhill bearing clockwise from north. Hillshade is
  Lambertian, with GDAL's byte encoding and multidirectional weighting.
- **Raster clip** (`rasterClip.js`): an even-odd scanline fill of pixel centres
  within each polygon (holes subtract), union across polygons.
- **Image quality** (`core/features/imageQuality.js`): variance of the 3×3
  Laplacian of luma on a fixed-size, centre-aligned area-downsampled grid (longest
  side 1024). The score depends on the scene's texture, so it is judged relative to
  the batch median.
- **Region** (`region.js`): an axis-aligned box in the model frame. Depth maps seed
  their depth range only from sparse points inside it, fusion drops fused points
  outside it, and mesh/DEM inputs are clipped to it.
- **Orientation** (`orientation.js`): a user basis (up from a three-point ground
  plane turned to the cameras' side, an origin, a heading about up) for the local
  product frame. Like the scale factor (§6.6), it lives in the frame, never in the
  coordinates, and a georeference outranks it.

## 9. CRS handling (why this app is different)

Everything is built to **not assume WGS84 / lat-lon**. There is a per-project
working CRS (proj4). GCPs, footprints, and camera poses store positions **in the
project CRS** and are reprojected on CRS change. The target domain is Antarctic
aerial survey, i.e. **polar stereographic** projections where a naive lat-lon
pipeline degenerates near the pole. Georeferencing (§6) produces CRS-tagged
products directly. This is a first-class concern, not a post-export reprojection.
Fits and adjustments are solved in a local metric frame (scale factor divided out,
curvature restored, §6.1) and mapped back to the grid; raster measurements report
ground values (grid ÷ k, area and volume ÷ k²; heights unscaled) with k shown.

### 9.1 Vertical datums and the geoid (2026-10-19)

h = H + N. `core/verticalDatum.js` converts ellipsoidal ↔ EGM96 ↔ EGM2008 with NGA's
grids reduced to 15′ nodes (`scripts/build-geoid-grids.mjs`: every node exact, Int16
cm, 1.6 MB each, precached for offline use), bilinear between nodes. Measured
against PROJ 9 with the full grids (2,000 random points each, area-uniform):

| model | region | median | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| EGM96 (same 15′ nodes) | global / Antarctica | 1 mm | 4 mm | 4 mm | 5 mm |
| EGM2008 (15′ of 2.5′) | global | 2.0 cm | 14 cm | 28 cm | 47 cm |
| EGM2008 (15′ of 2.5′) | Antarctica (< 60° S) | 1.1 cm | 8 cm | 19 cm | 42 cm |

The largest EGM2008 losses are short-wavelength geoid under high relief (Everest
36 cm); against REMA/COP30 accuracies (≥ 1 m) this is negligible. National/local
height systems are recorded, never converted. Where it applies: reference-DEM
sampling into the asker's datum (Fill Z, Check Z, A-5 picks, Find GCPs fills),
an explicit GCP "Convert heights to…" (refits), the georeference records the datum
its control shares (`georef.verticalDatum`, unknown when mixed) and stamps it on the
DEM, and DEM-vs-reference / DEM-of-difference convert the reference into it. Camera
EXIF altitudes stay `unknown` (EXIF says "above sea level", DJI varies by model).

---

## 10. How our choices map to the literature / other software

| Stage | WebSfM | COLMAP | Notes |
|---|---|---|---|
| Features | SIFT (+ SuperPoint, DISK, ALIKED opt) | SIFT | + duplicate-blob suppression |
| Matching | ratio + cross-check (or LightGlue) + F-RANSAC + **spread gate** | ratio + F/E RANSAC | spread gate is extra |
| Verification | F (RANSAC, or MAGSAC++ opt) + H (degeneracy) + inlier-ratio + positional-spread | F/E/H, GRIC | no E at match time |
| SfM type | incremental | incremental | same family |
| Resection | **P3P Lambda-Twist** + MSAC + GN | P3P + RANSAC | |
| BA | LM + Schur + adaptive Huber (from scratch) | LM + Schur (Ceres) | no external solver |
| Self-cal | shared f / cx,cy / k1,k2,k3, staged by model size, folded into the keypoints | full intrinsic groups | bitmask-selected; on by default (`auto`) |
| Distortion | Brown / rational / fisheye, removed at ingest; self-cal folded into keypoints | same models, in BA | pinhole downstream, except fisheye in BA (§5) |
| Dense | PatchMatch MVS (CPU + WebGPU) | PatchMatch MVS | GPU path is WGSL |
| Georef | Horn 7-param + camera/GCP-constrained BA | model_aligner / GCP | |

Genuinely distinctive: **runs in the browser, client-side, no server**; **polar/
non-WGS84 CRS first-class**; **historical scanned-film intrinsics** (pixel-pitch /
film-format handling with sanity checks); and the WebGPU PatchMatch path.

## 11. Known limitations & honest talking points

- **Incremental SfM.** Cameras are added one at a time, so drift can accumulate on
  long strips. Interleaved BA, loop closures from exhaustive matching, and camera
  positions or GCPs inside BA (§6.2) limit it; there is no global (rotation-averaging)
  method.
- **Pairwise rotations from matching are unreliable.** Verification fits F with no
  calibration; the rotations decomposed from it with a nominal K were wrong by a median
  28.6° on true pairs of one South Building run (§4.0). That is why there is no
  pre-SfM graph filter, and it would have to change (a five-point E at match time where
  K is known) before rotation averaging could work. The init pair already tries a
  five-point E (§4.2).
- **Sequential matching cannot see a revisit.** A set taken in two laps pairs only
  neighbours in filename order and splits into two models; there is no image
  retrieval (vocabulary tree), so such a set needs exhaustive matching.
- **Doming without control.** With no GCPs or camera positions, a nadir block bends:
  50 cm (GeoScan PUTI, 444 images) and 70 cm (quarry, 347) vertical RMS against RTK after
  a similarity fit. It is the block's geometry, not the self-calibration: with
  Metashape's calibration held fixed PUTI is still 44 cm out, and COLMAP's mapper and
  GLOMAP on the same images bend more (65–86 cm). With the drone's RTK positions in BA,
  PUTI is 1.3 cm. Co-registration to a reference DEM afterwards (Nuth & Kääb, §6)
  removes a shift and tilt, not the bend; BA constrained by a reference DEM is not
  implemented.
- **Self-calibration is weakly observed** on flat, single-strip aerial blocks (it needs
  ≥ 2° of tilt variation for a trustworthy focal). The result is used for the run, folded
  into the keypoints (§4.6), but never written to the sensor table without the user.
- **Fisheye** rays more than 75° off-axis are dropped at ingest and depth maps use 60°
  (§5), so a 200° lens keeps fewer keypoints than COLMAP does (103–104 of 106 FIORD
  images registered, against 106).
- **Panoramic satellite cameras** are split into frame segments; the satellite's motion
  during the scan is not modelled (a synthetic moving block is 48 / 238 m off), and
  there is no RPC model.
- **Dense quality is intrinsics-limited**: a default-FOV guess visibly distorts depth.
  Weakly textured surfaces remain the least complete part of a dense cloud; the Full
  method's planar priors (§7) target them.
- **One browser tab.** The reconstruction runs in 32-bit WebAssembly (4 GiB); fusion
  and the Poisson mesh use 64-bit memories where the browser has them. A tab also
  caps a single ArrayBuffer at 2 GiB and all of them at ~16 GiB, which bounds dense
  clouds at about 1.4 G points.

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

### Streaming products and saved measurements (2026-09-27)

Saved depth-map fusion executes the same cost percentile, auto merge-cell,
bounding-box, consistency, parallax, incidence and voxel rules as resident fusion.
Its pair-major consistency pass preserves source order and early-accept gates,
storing agreement counts and maximum angles for one reference image. File handles
load one reference and one comparison map at a time. Synthetic tests require exact
point, normal and summary equality for both paths. Streamed orthorectification
keeps the same best-view tie order or weighted average, rounding only after all
views; gap filling runs after all source maps have contributed.

Saved 2D measurements retain world vertices, units, sampled profiles and their
source/frame stamp. They are evidence snapshots; rebuilding a raster never
silently recomputes them. Reference candidate review can declare covariance axes,
height, vertical datum and checkpoint role before import. DEM-derived heights
carry the DEM's declared accuracy; no accuracy is inferred from a good image match.

DEM volume (2026-10-03, `core/products/measure.js` `polygonVolume`) is the 2.5D
cell-sum used by Pix4D/Metashape stockpile tools and QGIS "Raster surface volume":
V = Σ (z − base(x,y))·|sx·sy| over cells whose **centre** lies inside the polygon
(scanline, even-odd), split into cut (> 0) and fill (< 0). The base is a
least-squares plane through the DEM heights at the vertices (centred coordinates;
refused when collinear), the lowest vertex height, or a user height. The method
does not interpolate. Masked, nodata, NaN and off-raster cells are counted and
reported as a coverage fraction, never filled, so the result says how much of the
drawn footprint it actually measured. The discretisation error is the cell-edge
sliver along the boundary, which shrinks with GSD. Units are horizontal² ×
vertical as recorded, with no conversion.

Reference COG conversion preserves full-resolution sample values. Nearest-sample
overviews support display only; raw matching reads the original raster. Shader
styles implement the same band ranges, gamma and normalized-difference formula
as CPU previews (the index colour ramp is sampled into 33 interpolation stops).

## 12. Where to read the code (pointers, not content)

- Sparse orchestration: `src/core/sfm/sfm.js`
- Init-pair: `src/core/sfm/initPair.js`
- P3P / PnP / triangulation / GN: `crates/reconstruction/src/pose.rs`
- Bundle adjustment: `crates/reconstruction/src/bundle.rs`
- Distortion: `src/core/sfm/distortion.js`
- Matching verification: `src/core/features/verify.js`
- Georef: `src/core/products/georef.js`; GCP triangulation: `gcpTriangulation.js`
- Dense: `src/core/dense/mvs.js`, `crates/reconstruction/src/mvs.rs`, `workers/gpu/`
- Products: `src/core/products/{projection,dem,ortho,surface}.js`
- Mesh (screened Poisson): `src/core/products/mesh.js`, `crates/mesh/` (vendored
  `poisson_reconstruction` under `crates/mesh/vendor/`)
- Tunable knobs & their rationale: `src/core/defaults.user.js`, `src/core/tuning.js`

*In-app glossary*: many of these terms also have cross-linked explanations under
`src/glossary/**` (loader/renderer in `src/core/help/`), surfaced in the UI — that
content is user-facing; this file is the developer/colleague-facing method reference.

## 13. References

The published methods WebSfM implements, from `src/core/help/references.js` — the same
list the app shows (About ▸ References, each glossary entry's *Sources*, the Quality
Report's *Methods and references*). A unit test keeps this section in step with that file.

- Agarwal, S., Snavely, N., Seitz, S. M. & Szeliski, R. (2010). Bundle adjustment in the large. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-642-15552-9_3
- Arandjelović, R. & Zisserman, A. (2012). Three things everyone should know to improve object retrieval. IEEE Conference on Computer Vision and Pattern Recognition (CVPR). https://doi.org/10.1109/CVPR.2012.6248018
- Barath, D., Noskova, J., Ivashechkin, M. & Matas, J. (2020). MAGSAC++, a fast, reliable and accurate robust estimator. IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR). https://arxiv.org/abs/1912.05909
- Besl, P. J. & McKay, N. D. (1992). A method for registration of 3-D shapes. IEEE Transactions on Pattern Analysis and Machine Intelligence 14(2), 239–256. https://doi.org/10.1109/34.121791
- Bleyer, M., Rhemann, C. & Rother, C. (2011). PatchMatch stereo — stereo matching with slanted support windows. British Machine Vision Conference (BMVC). https://doi.org/10.5244/C.25.14
- Boykov, Y. & Kolmogorov, V. (2004). An experimental comparison of min-cut/max-flow algorithms for energy minimization in vision. IEEE Transactions on Pattern Analysis and Machine Intelligence 26(9), 1124–1137. https://doi.org/10.1109/TPAMI.2004.60
- Boykov, Y., Veksler, O. & Zabih, R. (2001). Fast approximate energy minimization via graph cuts. IEEE Transactions on Pattern Analysis and Machine Intelligence 23(11), 1222–1239. https://doi.org/10.1109/34.969114
- Brown, D. C. (1966). Decentering distortion of lenses. Photogrammetric Engineering 32(3), 444–462.
- Brown, M. & Lowe, D. G. (2007). Automatic panoramic image stitching using invariant features. International Journal of Computer Vision 74(1), 59–73. https://doi.org/10.1007/s11263-006-0002-3
- Burt, P. J. & Adelson, E. H. (1983). A multiresolution spline with application to image mosaics. ACM Transactions on Graphics 2(4), 217–236. https://doi.org/10.1145/245.247
- Chen, Y. & Medioni, G. (1992). Object modelling by registration of multiple range images. Image and Vision Computing 10(3), 145–155. https://doi.org/10.1016/0262-8856(92)90066-C
- DeTone, D., Malisiewicz, T. & Rabinovich, A. (2018). SuperPoint: self-supervised interest point detection and description. CVPR Workshops. https://arxiv.org/abs/1712.07629
- Fischler, M. A. & Bolles, R. C. (1981). Random sample consensus: a paradigm for model fitting with applications to image analysis and automated cartography. Communications of the ACM 24(6), 381–395. https://doi.org/10.1145/358669.358692
- Galliani, S., Lasinger, K. & Schindler, K. (2015). Massively parallel multiview stereopsis by surface normal diffusion. IEEE International Conference on Computer Vision (ICCV). https://doi.org/10.1109/ICCV.2015.106
- Garland, M. & Heckbert, P. S. (1997). Surface simplification using quadric error metrics. SIGGRAPH 97, 209–216. https://doi.org/10.1145/258734.258849
- Hartley, R. & Zisserman, A. (2004). Multiple View Geometry in Computer Vision (2nd edition). Cambridge University Press. https://doi.org/10.1017/CBO9780511811685
- Hartley, R. I. (1997). In defense of the eight-point algorithm. IEEE Transactions on Pattern Analysis and Machine Intelligence 19(6), 580–593. https://doi.org/10.1109/34.601246
- Horn, B. K. P. (1981). Hill shading and the reflectance map. Proceedings of the IEEE 69(1), 14–47. https://doi.org/10.1109/PROC.1981.11918
- Horn, B. K. P. (1987). Closed-form solution of absolute orientation using unit quaternions. Journal of the Optical Society of America A 4(4), 629–642. https://doi.org/10.1364/JOSAA.4.000629
- Kannala, J. & Brandt, S. S. (2006). A generic camera model and calibration method for conventional, wide-angle, and fish-eye lenses. IEEE Transactions on Pattern Analysis and Machine Intelligence 28(8), 1335–1340. https://doi.org/10.1109/TPAMI.2006.153
- Kazhdan, M. & Hoppe, H. (2013). Screened Poisson surface reconstruction. ACM Transactions on Graphics 32(3), 29. https://doi.org/10.1145/2487228.2487237
- Lindenberger, P., Sarlin, P.-E. & Pollefeys, M. (2023). LightGlue: local feature matching at light speed. IEEE/CVF International Conference on Computer Vision (ICCV). https://arxiv.org/abs/2306.13643
- Lowe, D. G. (2004). Distinctive image features from scale-invariant keypoints. International Journal of Computer Vision 60(2), 91–110. https://doi.org/10.1023/B:VISI.0000029664.99615.94
- Mark, R. K. (1992). Multidirectional, oblique-weighted, shaded-relief image of the Island of Hawaii. U.S. Geological Survey Open-File Report 92-422. https://pubs.usgs.gov/of/1992/of92-422/
- Nistér, D. (2004). An efficient solution to the five-point relative pose problem. IEEE Transactions on Pattern Analysis and Machine Intelligence 26(6), 756–770. https://doi.org/10.1109/TPAMI.2004.17
- Persson, M. & Nordberg, K. (2018). Lambda Twist: an accurate fast robust perspective three point (P3P) solver. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-030-01225-0_20
- Rusu, R. B., Marton, Z. C., Blodow, N., Dolha, M. & Beetz, M. (2008). Towards 3D point cloud based object maps for household environments. Robotics and Autonomous Systems 56(11), 927–941. https://doi.org/10.1016/j.robot.2008.08.005
- Schönberger, J. L. & Frahm, J.-M. (2016). Structure-from-motion revisited. IEEE Conference on Computer Vision and Pattern Recognition (CVPR). https://doi.org/10.1109/CVPR.2016.445
- Schönberger, J. L., Zheng, E., Frahm, J.-M. & Pollefeys, M. (2016). Pixelwise view selection for unstructured multi-view stereo. European Conference on Computer Vision (ECCV). https://doi.org/10.1007/978-3-319-46487-9_31
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
