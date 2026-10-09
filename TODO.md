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
   It is tracked row-by-row in `VERIFICATION.csv` (189 checks, 166 open; 72 open at
   P1). The headless bench (`scripts/bench/`) now closes pipeline rows without a
   person; what is left is mostly UI, OPFS-reopen and external-application checks.
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
| `SFM-18` SB reopened from OPFS | guided track extension with descriptors read from disk, the path the bench never takes |
| `SFM-04` building 50, SuperPoint + LightGlue | the learned front end on the set SIFT now fully registers |
| `DEN-02`/`DEN-03` sky- and vegetation-heavy dense | decides the DF retune, and whether the in-optimiser pass is worth it |
| `RAS-05` EPSG:3031 under WebGLTileLayer | go/no-go for the whole RR re-architecture |
| `DEN-05`/`DEN-06` dense on WebGPU | validates the automatic GPU default shipped 2026-08-25 and its WASM fallback |
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
The registration-stall work closed 2026-10-06: the bench registers SB 128/128, the
building set 50/50 and TMA 5/5 at defaults with no rescue firing (`SFM-01`/`03`/`05`),
so earlier f,k1 self-cal (WS-B), a second rescue and init-pair E-conditioning are
dropped; nothing measured asks for them. The rotation-cycle filter was removed and the
self-cal guard fixed for default-FOV focals the same day (HANDOVER done log).
- **A6 — adaptive bridge-pair gate**, gated on `SFM-11`: B1 showed `minInlierRatio
  0.25` rejecting genuine loop-closing bridges (27 inliers @ 0.23). Evaluate
  lowering `MATCH_TUNING.overrideInliers` (30) to ~25 **or** an explicit bridge
  exception (ratio ≥ 0.2 AND inliers ≥ 25 AND passes the spread gate). Decide from
  logs; one knob, one test. The bench already shows the case: the building set's last
  three images hang on one 25–27 inlier bridge and register in most runs only.
- **Secondary-model recovery (`SFM-08`).** SB no longer leaves stranded components, and
  at the new 0.8 ratio default eagle registers 43/44, so the test set is eagle with the
  ratio set back to 0.75 by hand. Its stranded components (6/4/4 images) are all below
  `secondaryMinImages` (8), so no job runs; the log claimed otherwise and now names the
  floor (fixed 2026-10-06). Whether 8 is right for small object sets is open: a 6-image
  block of a 44-image set is 14 % of the model. Needs a set with a ≥ 8-image stranded
  block to exercise the merge at all.

### ACC — georeferenced accuracy (RTK benches, HANDOVER ▸ B-bench)
The bench now measures accuracy, not only point counts: camera centres against
RTK/EXIF positions (quarry, GeoScan) and 15 independent GCP checkpoints (GeoScan).
- **GeoScan westward bias: half datum, half unexplained** (measured 2026-10-07, HANDOVER
  ▸ B-bench ▸ GeoScan datum and ▸ GeoScan calibration). The GCP and RTK files disagree by
  1.3 cm W / 1.0 cm S / 0.8 cm U (seen through Metashape's block). websfm's checkpoints
  sit 2.5 cm W. The other ~1.2 cm W stays the same with Metashape's own calibration
  pinned, so it is not the camera model. It appeared when the antenna offset was turned
  on. Next suspect: how the lever arm is applied (`surveyConstraints.js`). Compare
  websfm's and Metashape's per-camera antenna positions for the same images.
- **GeoScan vertical bias is the focal–height correlation, not a bug in websfm.** With
  Metashape's calibration fixed (it was solved with GCPs, so its focal knows the ground
  height) the +3.9 cm U bias falls to −0.8 cm. The scatter stays the same (sd 5.5–5.8 cm)
  in every variant, and correlates +0.95 per GCP with Metashape's residuals, so the
  scatter is in the survey or the marks. Self-calibration from RTK cameras alone puts fx
  at 5672.9 against Metashape's 5676.9. `VERIFICATION.csv` ▸ `GCP-07` (Metashape, RTK
  only, every GCP a checkpoint) shows whether Metashape lands on the same bias without
  GCPs. If it does, the bias is just what you get without vertical control.
- **Tangential self-calibration (p1/p2): parked.** Holding Metashape's calibration and
  dropping its p1/p2 costs 1.0 cm on the camera fit and 0.4 cm on checkpoint H. But
  websfm's own radial self-calibration already beats that fixed calibration (checkpoints
  H 3.4 vs 4.8 cm, camera fit 1.6 vs 1.7 cm). Revisit only on a lens with strong
  decentring.
- **The remaining GeoScan error** (checkpoints H 4.4 cm, V 10.8 cm, GSD 2.9 cm; Metashape
  fits the RTK cameras at 1.2 cm vertical). After the lever arm, check whether the prior
  BA converged: its reprojection RMS does not move across both rounds, and it runs 30
  iterations each. Quarry's residual (0.20 m) concentrates on 0194/0195/0344–0346 in
  every variant; look at those images.
- **Pure-SfM doming** (no priors): about 0.5–0.7 m vertical on both nadir blocks. Only
  priors or GCPs fix it today. Worth a look at whether the staged self-calibration
  unlocks k2/k3 on too little evidence for a flat block.
- **GCP mark pixel convention.** The viewer stores clicks in pixel-edge coordinates (pixel
  centre = +0.5), while keypoints use pixel-centre coordinates (centre = 0). Measured
  2026-10-06 on GeoScan (with the antenna offset; Metashape marks share the click
  convention): marks shifted by +0.5 / 0 / −0.5 px give checkpoints H 7.2 / 6.0 / 4.8 cm,
  V 13.0 / 10.8 / 8.9 cm, still falling past −0.5. Two fixes the same night: the
  keypoint back-mapping (`x / s`, not centre-aligned: 0.75 px at s = 0.4) and the mark
  convention (−½ into the camera frame, +½ back; CLAUDE.md ▸ CRS/GCP). On the fixed
  keypoints (`puti-arm3`) the shift curve is H 5.3 / 4.2 / 3.3 / 3.1 / 3.0 / 3.1 cm and
  V 9.8 / 8.1 / 7.1 / 6.9 / 6.9 / 7.2 cm at +0.5 / 0 / −0.5 / −0.75 / −1.0 / −1.25 px;
  the shipped −½ is the first half of that. **Open: a further ~0.3–0.5 px** (optimum
  near −0.85). Not the SIFT octaves (decimation, exact) nor the resize (centre-aligned),
  and not the camera model: with Metashape's calibration pinned the curve keeps the same
  slope (`puti-tangential`). A shift mainly moves the mean east, so it may be the
  westward bias above rather than anything about the marks.
  Candidates: how Metashape places marker centres, or these 15 marks. Test with marks
  made in websfm's own viewer before tuning anything. Also: the viewer draws keypoints
  and residual vectors in keypoint convention on an edge-convention canvas (½ px
  up-left; cosmetic).
- **Quarry GCPs.** Nine surveyed targets (CH1903/LV03) exist, but no image marks. Mark them
  once in the app and export, or auto-place them by projection + target detection; that
  gives quarry checkpoints too.
- **Guided extension on weak models.** On TMA (no interior orientation) the additions sit
  at 3–5 px against a 1 px model, even with the radius cap. Revisit with fiducials
  calibrated: if they persist, gate the step on model quality.
- **Matching is not deterministic** (RANSAC). The building set's last three images
  (IMG_4292–4294) hang on one bridge pair of 25–27 inliers, and the rescue registers
  them in some runs only (50 vs 47 cameras).

### DF — dense cross-view filter: retune from data
Stage A′ (`filterDepthMapsGeometric`) shipped and is unit-tested but **unmeasured on
real data**; it subsumes what was previously tracked as A5. The former dense
sky/vegetation plan is retired: this section contains all remaining decisions.
- **Retune the defaults** once `DEN-02`…`DEN-04` are in. `maxGeomCost 1.0` /
  `minConsistent 2` / `minNcc 0.1` / `minGeomAngleDeg 3` are COLMAP's numbers, adopted
  untested at our working resolutions. The parallax gate (2026-10-08) is the one most
  likely to over-cull: short-baseline sets (video sweeps, close-range objects shot from
  a few steps apart) lose real surface the near-duplicate views alone saw; the log's
  "consistent only at <3° parallax" bucket is the number to read. Watch for over-culling on legitimately weak-texture surfaces
  (snow/ice — the polar case is exactly where a photometric floor is most likely to
  be wrong).
- Stage A′ wall clock: the exact cull + nearest-first walk (2026-10-07) cut it ~3×
  on synthetic sets, but sky-heavy maps still scale with map count. Check the logged
  µs/px on a real run (`Depth filter: cross-view consistency in …`) and retune
  `DENSE_TUNING.geomFilterUsPerPx`; only if it still rivals GPU PatchMatch consider
  restricting candidates to `selectSourceViews` — that one *does* change verdicts.
- **Then** consider a Metashape-style mild/moderate/aggressive preset over these
  three knobs — once real numbers say what the useful range is. Do not invent the
  deltas first.
- **Not doing: automatic sky segmentation.** A blue/brightness prior is unsafe in
  Antarctica (snow vs sky). Manual masking already works and is what Metashape users
  do; if this ever resurfaces it is a SAM2-seeded feature, not a heuristic.

### MS — mesh: confirm on real data (fix shipped 2026-10-07)
- **Run `MESH-01` on the eagle** (cleaned cloud, defaults) and `MESH-02` on an aerial
  set. If pieces survive or real surface is lost, retune `MESH_TUNING.trimRatio` /
  `holeAreaRatio` and the 1 % floater default from those runs, not from the fixtures.
  Record time and triangle count as the first real-data mesh baseline.
- **`demSource` makes the same first-dense pick** Build Mesh used to make, so a DEM
  ignores an edited cloud too. Decide whether DEM should follow `meshSource`'s rule
  (selected → newest edit → first) before changing it: DEMs feed ortho staleness.
- Only if `MESH-01` still shows floaters a cleaned cloud cannot explain: a
  visibility-aware mesher (TSDF from the persisted depth maps, or Delaunay graph-cut).

---

## Next

### TL — Tools-tab follow-ups (tools shipped 2026-10-07; checks in VERIFICATION ▸ TOOL-*)
- **Extra-bytes attributes in LAZ.** PLY and LAS carry them since 2026-10-08; LAZ drops
  them (logged) because `crates/lazcodec` `vlr_for_format` builds the LASzip item list
  from the point format alone and rejects a longer `point_size`. Add a
  `LazItemType::Byte(extra)` item when the record exceeds the base size, rebuild the
  wasm, then pass the longer record length from `core/io/laz.js` and stop dropping.
- **ICP to a mesh** matches mesh vertices, not closest surface points: coarse meshes
  converge to vertex spacing. Use the exact C2M search (`cloudDistance.js`) for
  correspondences.
- **Region gizmo.** The box is edited numerically and by fit; drag handles in the 3D
  view would be faster for objects.
- **Workflow blocks** for the new tools (the dense-edit pattern in `core/workflow.js`),
  once someone wants to replay a cleanup chain.

### RV — 2026-10-03 code + maths review: verified, not yet fixed
Each item was confirmed against the code (most with a measured number); the fixed
ones are in HANDOVER. Ordered by expected impact.
- **OPK convention**: `opkMatrix` is Rx·Ry·Rz used as object→photo; Pix4D documents
  it as image→object. Pin with a real Pix4D/Metashape fixture before trusting OPK
  orientation priors (κ flips on nadir if transposed).
- **`transforms.json` points at raw (distorted) images** with a pinhole K, and at
  scan dimensions with a canonical K for film. Export undistorted images with it.
- **Accuracy statistics**: control residuals normalised by Σ_gcp only (Baarda's
  Σ − Σ_ŷ reads ~35 % higher with 4 controls); LOO omits prediction covariance;
  SfM-point uncertainty ignored; pose fits drop anisotropic σ; "RMS" is weighted.
- **Rust numerics**: H/F ratio compares one-sided transfer error to Sampson (COLMAP
  does the same; revisit only if the degeneracy label misfires). Jacobi and the
  F-RANSAC refit/LO shipped 2026-10-08.
- **Smaller**: dense applies the calibrated bag with the refined K (explicit refine
  string + calibrated lens only); a camera without a sensor loses its refined k1
  unfolded; the composed radial bag is fitted about the final principal point only;
  `estimateUpFromViewingDirs` tilts a single-heading oblique block's DEM.
- **Performance**: selection overlay allocates ~16 B/selected point per stroke; LAS import
  always allocates ~29 B/point of attributes and subsamples attributed clouds with a
  string key per point; `sparseMetrics` returns one object per point; restore reads
  DEM/ortho before knowing it needs them.
- **Find GCPs reads the whole reference raster at 1536 px**: a regional tile against
  a drone block leaves the project a few dozen working pixels. Needs an approximate
  footprint (EXIF/priors) to window the read — the ortho itself is relative.
- **Structure** (god-file audit; `core/sfm/ingest.js` and one shared
  `buildBaObservations` shipped with MEM, 2026-10-08): move the sparse-input
  marshaller out of `reconstruct()` into `stores/reconstruction/`; split fusion out of
  `mvs.js` with one shared windowed depth-agreement helper.

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

**SP4 — replace a cached model** (Settings ▸ Compute). Supplying a file now exists
for the non-redistributable SuperPoint: the consent modal links the upstream file and
caches a picked/dropped one under the model URL (`useModelsStore.provideModelFile`).
What remains: a Settings list of cached models with "Replace with file…" (a custom
export of any model, e.g. a 2048-keypoint SuperPoint), and logging which bytes each
session loaded (size + a short hash), so a run records custom vs default weights.

**SP5 — tests.** Output parsing is pinned (`learnedDetect.test.js`: DISK/SuperPoint
layouts, cap, width mismatch). Still open: coord back-map, gate wiring and the validity
guard with a mocked `InferenceSession`. Real-inference browser runs are
`VERIFICATION.csv` ▸ `DET-02`, `DET-04`, `DET-06`.

### MT — closing the gap to COLMAP on South Building
Where we stand (HANDOVER ▸ B-match-gpu, MAT-13): **115,533** ≥3-view points vs COLMAP
80,792 at full resolution untiled (25k cap, ratio 0.8); end to end ~20 min, matching 488 s.
The point gap is closed; what remains is speed and making this the default path. With
projection-guided track extension (shipped 2026-10-06), the same settings give 124,680
(154 % of COLMAP; HANDOVER ▸ B-bench).
Pairs are not what limits points: gate off raised accepted pairs 61 % for +0.2 %
points (MAT-05), `minInlierRatio` 0 added 9 pairs (MAT-07), while uncapping the
keypoints added 9.8 % points on fewer pairs (MAT-08). Run the browser
experiments one variable at a time on SB (exhaustive, GPU, ratio 0.8 unless
stated), each recorded as a VERIFICATION row + HANDOVER baseline.

**Points:**
- **Track building is ruled out (MAT-06).** Final-stage completion lifted only 338
  points (+0.6 %); 38,685 two-view points have no verified correspondence into a third
  registered image. The gap was in the correspondences themselves: projection-guided
  extension (shipped) recovers +4–6 % of them on SB.
- **Ruled out by measurement:** F-RANSAC 4 px (+0.7 %), F-RANSAC 10k iterations (0),
  peak threshold above or below 0.01 (−1.6…−8 %), a second SIFT orientation (+0.5 %,
  MAT-10), pair gates (MAT-05/07), track building (MAT-06). See HANDOVER ▸
  B-match-gpu, "knob sweep".
- **Keypoint cap default.** `maxKeypoints` 10,000 binds on SB at 2400 px (MAT-05..07)
  and costs ~10 % points. Raising the SIFT default (or making it scale with the
  detection size) is a cost question for WASM users — brute force is O(Na·Nb). Decide
  after MAT-09 and the detection-resolution run, which both move the keypoint count.
  Since 2026-10-05 the cap keeps the coarsest scales first, which changes the
  trade-off. On the node bench, native resolution with a 10k coarse-first cap matched
  2400 px with 10k (3,672 vs 3,671 ≥3-image tracks with RootSIFT), so resolution is no
  longer free points at a fixed budget. MAT-16 gives the browser number.
- **Defaults after MAT-13.** Full resolution with a non-binding cap is the best SB result
  so far (115k vs 60k at 2400 px). Decide the Balanced/Detailed SIFT presets
  (`DETECT_SIFT_DEFAULTS` maxDim/maxKeypoints; the ratio default moved to 0.8 on
  2026-10-06), weighing WASM-only users: brute force is O(Na·Nb) and 2.2 M keypoints is ~4×
  the matching work of MAT-10. Check one aerial/film set first.
- **GPU descriptor cache size (low value; measured).** `MATCH_TUNING.gpuDescCacheMiB`
  1024 evicts above ~2 M keypoints, but MAT-15 shows the evictions cost almost nothing.
  The summed GPU kernel time scales with the quadratic keypoint work alone: MAT-16 1092 s
  at 1.27 M → MAT-15 3323 s at 2.21 M = 3.04×, against (2.21/1.27)² = 3.03×. Wall time
  matches (154 s × 3.0 ≈ 460 s), even though MAT-15 re-uploaded 7.4 GB over 752
  evictions. Sizing the cache from the run would still be tidy, but it is not a speed
  lever at this scale; matching time is the keypoint count.

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

### MEM — big runs vs the 4 GB per-isolate ceiling (from the Monster stretch run)
Chrome caps each page's and each worker's **V8 heap** at ~4 GB (`jsHeapSizeLimit`); a
page cannot raise it. ArrayBuffers and wasm memory live outside that cap. The Monster
run (4.5 M keypoints, 7.7 M matches) died in its SfM worker at guided extension. The
compact-memory work (shipped 2026-10-08, HANDOVER ▸ B-mem) moved the worker's
keypoints, tracks and matches into typed arrays: peak worker heap 1.36 → 0.16 GB on
GeoScan PUTI, 1.08 → 0.12 GB on South Building, bit-identical output. The preflight
now projects heap and buffers separately and drops guided extension rather than
dying. Open:
1. **Run Monster at defaults on the bench machine** (`SFM-23`): the model projects
   0.78 GB of worker heap; confirm it completes and record the real per-segment peak.
2. **Main-thread keypoints** (`useImagesStore`): still one object per keypoint
   (`nx, ny, scale, response, …`) in the renderer — on Monster roughly 0.5 GB of
   renderer heap. A store rework, separate from the solver.
3. **Split very large blocks into overlapping sub-models and merge** (long term), on
   the existing secondary-model similarity merge; COLMAP's route to thousands of images.
4. **Memory64 wasm** only lifts the wasm side and Rust/wasm-bindgen support is still
   experimental — revisit later.
Not needed: guided extension in image batches (plan Phase 5). Its descriptors are
ArrayBuffers now, outside the heap ceiling; revisit only if the device-memory side of
the preflight starts refusing runs.

**PCG reduced solve — decide from the bench (`SFM-22`).** PCG is live (shipped in
`d1355a3`, from n ≥ 600). On a synthetic BA-shaped system it was 43× faster than
Cholesky (0.14 vs 5.9 s at n = 3,144, native). On quarry (347 cameras) it made BA
*slower*: 692 s vs 579 s, total SfM 869 vs 744 s, accuracy unchanged (112,985 points,
camera RMS 0.217 vs 0.214 m). Suspected: real reduced systems are far worse conditioned
(gauge freedom, LM damping), so CG runs to its 2,000-iteration cap at 10⁻¹⁰ and then
pays for the Cholesky fallback too. Since 2026-10-08 every BA logs what its solves did
and the run total lands in `summary.baSolver`; the policy is `SFM_TUNING.baSolver`, so
the bench compares Cholesky-only / default / inexact (`pcgRelTol 1e-6, pcgMaxIter 200,
pcgAcceptPartial`) as three `recon` variants with no rebuild. Then: keep the winner as
the default, or switch PCG off (`pcgMinN: 1e9`) if neither PCG variant wins. A better
preconditioner (Schur-Jacobi or a gauge fix) only if the stats show CG converging
slowly rather than falling back.

### ZM — Monster beach set: MicaSense Altum-PT + YellowScan LiDAR (2026-09-23 flight)
Local folder `wbsfm/20260923_zm_micasense_afternoon` (bench config `zm-pan`): 556
captures × 7 bands (5 MS 2064×1544, pan 4112×3008, thermal 320×256, 16-bit), ~120 m
above ground, standalone GPS; 12 LiDAR strips (LAS 1.4 format 7, 158 M points, RD New +
NAP) and the 200 Hz trajectory. The first set with an independent 3D surface: the bench
grids the LiDAR at 0.5 m and scores reconstruction points on flat cells after fitting a
shift and offset (`scripts/bench/lidar.mjs` → `lidarCheck`: tilt, dome, scatter).
- **The app imports 1 of these 12 LiDAR strips.** Two limits stack. The import budget
  (`core/io/las.js` `validateLasAllocation`: `count × (2 × recordLength + 64)` ≤ 1 GiB)
  allows ~7.9 M points of format 7, and the strips hold 9–16 M. Behind it, `crates/lazcodec`
  decodes one file per call and caps that at 512 MiB of records (15.9 M points × 36 B =
  573 MB). Chunked decoding alone does not fix it: the decoded cloud keeps ~54 B/point
  (Float64 xyz, colour and 14 attribute arrays), ~0.86 GB for one strip. The fix is a
  streaming import that subsamples (voxel) or builds a level-of-detail tree per chunk —
  the `CloudSource` / COPC backlog item, now with a real dataset. First piece: a
  `LazDecoder` in the crate that owns the compressed bytes and returns N points per call.
  The bench meanwhile decodes the first 14.9 M points of an oversized strip
  (`decompressLazRecords` `maxPoints`).
- **MicaSense factory calibration (optional).** The EXIF focal is right (pan: 16.6 mm ×
  289.855 px/mm = 4,812 px; the XMP `PerspectiveFocalLength` gives 4,807.5 px), so K
  resolves without help. The XMP also carries the principal point (mm) and a five-term
  Brown model per band (pan: k1 −0.157, k2 0.219, k3 0.526, p1, p2). Importing it as a
  calibrated sensor would replace self-calibration on this camera; compare the two on
  `zm-pan` with `lidarCheck` before deciding.
- **Fixed 2026-10-06: every imported TIFF stayed in memory.** exifr reads a whole TIFF
  into one buffer and returns some tags as views into it; `meta.raw` (unused) and
  `gpsAltRef` held them, so each original stayed alive (23 MB per pan frame; 12.7 GB on
  538 frames, which the sparse memory preflight refused). `core/io/metadata.js` now keeps
  plain values only. A 97 MP film scan pinned ~93 MB the same way.
- **Ground captures**: the camera records from power-on; 18 of 556 captures are on the
  ground (~48 m GPS altitude vs 160–168 m flying). The bench drops them with `minGpsAlt`;
  the app has no equivalent (an altitude outlier flag at import would do).
- **Later**: the LiDAR trajectory as camera priors (needs the camera↔IMU time offset and
  lever arm), multispectral bands as a rig, LiDAR-constrained BA (F13).

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
SuperPoint+LightGlue and DISK+LightGlue have shipped (`core/features/learnedDetectors.js`
registry; one ONNX runner). This remains the umbrella for later ones. **ALIKED**
(BSD-3-Clause, the strongest LightGlue pairing) needs a standalone per-image ONNX
export: fabio-sim ships it only as a fused two-image pipeline (v3.0), which does not
fit the per-image keypoint stage — export cvg/LightGlue's ALIKED extractor + its
LightGlue ourselves, then it is one registry entry. Detector-free RoMa/LoFTR need a
`match(imgA,imgB)` op shape with no per-image keypoint stage. The SfM core is already neutral (pairs as
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
- **Threads for the Poisson solve.** After the 2026-10-07 restructuring (B-mesh-2) the
  finest layer is 6.8 s of an 18.6 s depth-8 bench run, split between assembly and the
  right-hand side, both hash-lookup-bound and per node independent, so they would
  parallelise cleanly. The app is already cross-origin isolated for ORT, so
  `SharedArrayBuffer` is available. But wasm threads need nightly Rust with
  `-Z build-std` (atomics), a new toolchain requirement for the whole build. Gate on
  real meshes at depth 9–10 being too slow.
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
