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

- **2026-07-10 · Stalled-strip rescue for registration (S1, `register.js`)** — when a
  sweep registers nothing but images still link to the model (short film strips: end
  frames fail on a ~10%-wrong focal + a strip-end structure gap), run one rescue round:
  focal-only BA (`refineIntrinsics 'f'`, safe pre-filter) + retriangulation, then a
  single relaxed-recheck retry (recount at the PnP gate, ratio `rescueRefineRatio 0.2`).
  Guarded one-shot (`rescued`), knob `rescueStalled` (default on). Absolute inlier floor
  + gate-1 + final track filter still apply, so it can't manufacture a pose. Motivated by
  a B0 run (2026-07-10) that registered only 3/5 with the film flag *off*: `0033` failed
  the tight 4px recheck (18/29 held at 8px), `0032` starved (0/20 usable correspondences).
  `npm test` (406) + typecheck green; **owed** a real B0 re-run to confirm it lifts the
  count (expected 4/5 — `0033` via relaxed recheck; `0032` depends on retriangulation
  reaching its overlap). NB the proper fix for film is still the fiducial/interior-
  orientation path (mark the sensor film) — this only hardens the no-film case.

- **2026-07-10 · Code-review batch (cycle filter, COLMAP export frame, perf, hardening)** —
  from a review of the working tree. **B1** cycle filter: strong-edge protection now
  auto-disables on a uniform-quality graph (no/equal inlier counts) instead of shielding
  every edge (`cycleFilter.js` + regression test). **B2** COLMAP export: 2D observations
  now export in the **BA (pinhole) frame** — `sfm.js` bakes each view's
  undistorted/canonical/self-cal-folded pixel into the returned points, the store carries
  it as `viewsPx` and persists it (`recon.*.vx/vy.bin`, `RECON_BIN_KEYS`), and
  `doExportColmap` prefers it (falls back to store keypoints + warns for distortion/film
  projects). Fixes silently-inconsistent exports for distortion/film/self-cal projects.
  **B3/B4** UI: LightGlue `lgMaxKeypoints:0` reads as uncapped (no false cap warning);
  `formatClock` floors minutes (no "1h 60m"). **B5** `colmapModel.fmt` throws on non-finite
  instead of writing 0. **P1** correspondences swept once per registration pass and cached
  (reused for NBV scoring + PnP attempt). **P2** cycle filter reuses its initial full-graph
  pass. **G2** `utils/zip.test.js` structural round-trip test. Docs: CLAUDE.md §3 +
  METHODS.md §4.3 (NBV ordering, two-gate PnP), TODO F7. `npm test` (406) + typecheck green;
  a real COLMAP round-trip (film + self-cal projects) is still owed — see TODO F7.
- **2026-07-10 · Extracted `core/sfm/register.js` (G1)** — lifted the incremental-resection
  stage (next-best-view ordering, two-gate PnP, track extension/triangulation, interleaved
  BA + its `collectCorrespondences`/`nextViewScore`/`countMatchesToRegistered` helpers) out
  of the 1349-line `sfm.js` into `registerImages(ctx)`. `sfm.js` → 1019 lines. Shared model
  state passed via `ctx` and mutated in place (Maps/Sets by reference; the reassignable
  `points3d` via a live `getPoints3d()` getter, since injected BA/filter closures replace
  the array). `registeredUuids` stays in `sfm.js` (the `foldOneEndpointMatches` closure
  reads it). Behaviour-preserving move — `npm test` (406) + typecheck green; owed a real-data
  reconstruction run to confirm no regression vs. the pre-extraction pipeline.
- **2026-07-10 · COLMAP model export (F7, export half)** — pure
  `core/io/colmapModel.js` (R↔quaternion, `serialize/parseColmapModel` text
  round-trip, `build/readColmapModel` websfm↔COLMAP adapters; 15 unit tests) +
  dependency-free `utils/zip.js` (STORE ZIP, verified against the `unzip`
  binary). Wired *Export ▸ Interop ▸ COLMAP Model* (new Ribbon group) →
  `useExports.doExportColmap` resolves each point's `views` to pixel
  observations from keypoints, emits a zipped 3-file PINHOLE model in the local
  SfM frame. `npm test` (404) + typecheck green. Import half + `.bin` +
  browser run still owed — see TODO F7.

- **2026-07-10 · Reconstruction-quality overhaul (PLAN-reconstruction-quality.md, P0/P1/P2/P3/P4/P6)** —
  from the 2026-07-10 building + aerial log audit. **P0** intrinsics: `refineIntrinsics`
  now defaults to `'auto'` (`defaults.user.js`), resolved in `core/sfm/sfm.js` to
  `'f,k1'` when no sensor carries a calibrated distortion model (EXIF-only / film) and
  `'none'` otherwise — self-calibration on by default, the biggest single lever for both
  datasets. **P1** PatchMatch freckle fix: spatial propagation now intersects the pixel's
  ray with the neighbour's *plane* (`cand_d = (n·P_j)/(n·ray_i)`) instead of copying the
  neighbour's raw depth (fronto-parallel-only) — fixed in lockstep in
  `crates/reconstruction/src/mvs.rs` + `src/workers/gpu/patchmatch.wgsl`, plus the two
  decoupled refinement hypotheses (random-normal / depth-only); pure-JS slanted-plane
  convergence test in `planeCost.test.js` (≥95% within 1%, vs raw-depth <50%). **P2.1**
  no-measurement pixels (cost≈2.0) are zeroed before the speckle filter (`workers/ops/dense.js`);
  **P2.3** ZNCC half-window cap lifted 3→5 (11×11) across `mvs.rs`/`patchmatch.wgsl`/
  `depthMapGpu.js`/`mvs.js` + `DepthMapsModal`. **P3** rotation-cycle filter
  (`core/sfm/cycleFilter.js`) now evidence-weights each triangle by its weakest edge's
  inlier count, uses an adaptive+capped threshold (`max(5°, 2×median)`, ≤15°), shields
  strong edges, and logs a single summary; new noisy-graph + strong-edge unit tests.
  **P4** registration: next-best-view ordering by correspondences to well-triangulated,
  spatially-spread points; `minPnpInlierRatio` 0.15→0.3 (`tuning.js`); refine-then-recheck
  at the tight `reprjThreshold`; new points gated on ≥`filterMinTriAngleDeg` parallax not
  cheirality alone. **P6** Match modal: one "Matching density" Fast/Full radio over
  `lgTiled`, caps moved under Advanced, auto-hint when the Fast cap discards most detected
  keypoints. wasm rebuilt + committed. **Not verified in-browser** (dense visual quality,
  GPU↔CPU A/B, real-data reconstruction deltas) — needs a manual run. Deferred: P0.2 (k2
  self-cal), P0.3 (film-width sensor field), P2.2/P2.4/P2.5 (bilateral ZNCC, geometric
  consistency, fusion dedupe), P5 (matching speed: retrieval preselection, escalation
  gating, parallel LightGlue). Remaining items now live in TODO ▸ Now ▸ Q (the plan
  file was folded in + deleted 2026-07-10).
- **2026-07-09 · TIFF transcode OPFS cache + display-first ingest** — reopening a
  project with TIFFs no longer re-runs the multi-second decode+re-encode: both
  transcode outputs (display JPEG + lossless compute PNG) are cached in OPFS under
  `images-derived/{uuid}.display|.compute` (`opfs.saveImageDerived`/
  `loadImageDerivedBlob`/`deleteImageDerived`), written at ingest and read on
  restore; cache miss (older project / partial write) transcodes + backfills so
  projects heal on reopen. Ingest now encodes **display-first** (`tiffToDisplayBlob`
  serial JPEG→PNG + streamed `display` event through the tiff op/computeClient) so
  the viewer shows the full-res image while the PNG still encodes; a per-uuid
  `whenComputeReady` promise gates the two compute entry points (`detectOne`, dense
  marshalling in `useReconstructionStore`) and rejects on transcode failure so
  compute errors loudly instead of falling back to the lossy JPEG. Files:
  `utils/opfs.js`, `utils/tiff.js` (+`nativeTiffDecodeResult`), `workers/ops/tiff.js`,
  `workers/computeClient.js`, `stores/useImagesStore.js`, `stores/useReconstructionStore.js`.
  Phase 2b (geotiff decoder pool) left as measure-first/optional. Not yet
  browser-verified (OPFS + OffscreenCanvas are runtime-only). Lives in the TIFF
  gotcha paragraph of CLAUDE.md.

- **2026-07-08 · F4 — Fiducial-mark interior orientation for film scans** — treats
  scan geometry like lens distortion: removed once at ingest so the pipeline stays
  pinhole with one shared K per sensor. New pure core `core/sfm/fiducials.js`
  (`fitFiducialAffine` least-squares scan→mm, `canonicalFrame`, `scanToCanonical`/
  `canonicalToScan`; `fiducials.test.js`). Data model: `kind`/`fiducials` on
  sensors (`useSensorsStore.setFiducialMarks`), `fiducialObs` on images
  (`setFiducialObservation`/`addFiducialObservations`), both persisted. UI: film
  Kind + fiducial editor (marks table + certificate paste) in `SensorTable.vue`;
  "Mark fiducial…" right-click flow + distinct overlay + live per-mark residual in
  `ViewerImage.vue`; `<3`-marks flag in `ImagesSection`. Import: `core/io/fiducialObs.js`
  parser routed via `importKind.js`/`useImportRouting`. Sparse: `sfm.js` ingest fits
  per film image, builds one canonical frame per sensor (median pitch), moves the
  worker's keypoints + GCP observations, adds `resolveK` **path 0** (`_fiducialK`),
  records `summary.fiducialTransforms`. Dense: `workers/ops/dense.js` warps each film
  raster+mask into the canonical frame (`warpFilmRaster`/`filmMaskLut`) from the
  sparse run's stored transform (never re-fits). Method in METHODS.md §5.1, invariant
  in CLAUDE.md. `npm test` (film reconstruction test in `sfm.test.js`) + typecheck +
  build green; browser run (mark fiducials on CA…V scans, check the pitch log,
  compare §B0 baselines) still pending — this environment can't drive it.

- **2026-07-08 · Fix: project switch/close silently destroyed the left project**
  — teardown ran *before* the project switch, so every `clear*` operated on the
  still-current (old) project. `useImagesStore.clearAll` `sync()`'d an empty
  image list over its `project.json`, and `useSensorsStore.clearSensors` +
  `useMatchesStore/useGcpsStore/useFootprintsStore/usePosesStore.clear()`
  unconditionally deleted their OPFS files — wiping images/sensors/keypoints/
  matches/GCPs/etc. on switch or "new project" (only reconstruction survived,
  as its `clear({ purge })` already gated OPFS deletion). Fix: all six teardowns
  now take `{ purge = false }` and only touch OPFS when purged; only the explicit
  `clear-all` command purges (App.vue), switch/create do not. Lives in the six
  stores + `App.vue` dispatch.

- **2026-07-08 · Console = append-only OPFS stream** — the dev console no longer
  loses verbose SfM output to the buffer cap. `utils/opfs.js` `log.ndjson` is an
  append-only NDJSON stream (`appendLog`/`readLog`/`truncateLog`, legacy
  `log.json` migrated once); `useLogStore` batches every logged line onto it
  (single-flight, `flushNow`/`readAll`/`clearConsole`) while `useLog` keeps only
  a capped display tail (`MAX_BUFFER` 1000→5000, still shift-on-overflow but no
  longer lossy). `DevConsole.vue` scroll-to-top progressively prepends older
  chunks from the file (500/chunk, scroll-anchored) and Save TXT exports the
  whole unfiltered stream. Browser-runtime (OPFS writable) — not verified here.

- **2026-07-08 · P7 subset gate (two-stage exhaustive matching)** — the
  structural fix for the no-poses/no-GPS exhaustive case (a building shot in a
  circle: sequential misses the loop closures, exhaustive is too slow, preselect
  has no positions to work with). New pure helper `core/features/subsetGate.js`
  (`pickSpreadIndices` grid-buckets keypoints and keeps one per cell — spatially
  uniform, not response-sorted top-K, so it doesn't collapse onto a façade's
  repeated high-contrast blobs; `sliceDescriptorRows` gathers the subset into a
  compact buffer) + `subsetGate.test.js` (6 tests). Wired into
  `useMatchesStore.matchPair` before the full match (brute-force only, skipped
  for LightGlue): match a ~200-kp spatially-uniform subset per image, and if
  fewer than `subsetGateThreshold` (default 8) putatives survive, mark the pair
  `gated` and skip the O(Na·Nb) full match. Only engages when both images have
  >1.5× the subset size in keypoints (small images pay the full match). Keeps
  exhaustive *coverage* (loop closures still found anywhere in the graph) at a
  fraction of the per-pair cost. Toggle + subset-size/threshold controls in
  `MatchFeaturesModal` (on by default for brute-force); gated count reported in
  the run summary; per-pair gate decisions logged at debug. This is TODO's P7
  with a spatial-spread refinement over the planned response-sorted `subarray`;
  the scale-up beyond it (global-descriptor / vocab-tree retrieval to cut the
  O(N²) pair count itself) stays Parked for 1000+ image sets. `npm test` +
  typecheck clean. Owed: a real browser run on the circular building set to tune
  `subsetGateThreshold` (watch the `Gated:`/`Gate passed:` debug lines and the
  `N gated` summary — if genuine weak-overlap pairs get gated, lower the
  threshold or keep a sequential band unconditionally).

- **2026-07-08 · GCP UX overhaul** — reworked the GCP workflow per user
  feedback on the F2 landing below. (1) Removed the control/check `role` split
  entirely (every enabled GCP is now used); dropped it from `useGcpsStore`,
  `useReconstructionStore` (qualify/report/marshalling), `sfm.js` anchoring,
  and the UI. (2) Split the single image (marker) accuracy into per-axis
  `accuracyImgX`/`accuracyImgY` px (2D — no Z); back-compat seeds both from the
  old `accuracyRel`. (3) Moved marking out of the table into the **image
  view's right-click menu** (`ViewerImage.vue` `@contextmenu`): "Add new GCP
  here" (`addGcp` + `setObservation`, auto-selects + enables the GCP overlay)
  or "Assign to existing ▸ <list>" (`allGcps` prop). Removed the table/sidebar
  "Mark" buttons and the old select-then-left-click `gcpMarkMode`. (4) Added
  the requested extras: a magnifier **loupe** (zoomed inset sampled from the
  `<img>`, shown while the GCP overlay is on), **live reprojection** error
  drawn next to each marker + in the sidebar observation list (refreshed after
  every mark), a per-GCP **observation list** in the sidebar (jump-to-image +
  per-observation remove via new `jump-to-image`/`remove-gcp-observation`
  events), and **coverage** flags (⚠ on GCPs with <2 marks) in table + sidebar.
  Table row-click now highlights (`selectedGcpId`) instead of a Mark button.
  Follow-ups same day: the image-view right-click is now a **general** context
  menu (Add GCP here… / Copy pixel / Copy color / Zoom in here / Fit to view);
  "Add GCP here…" flips the same popup to the new-vs-existing chooser in place.
  The sidebar lost its "+ Add GCP" and per-GCP "Remove GCP" buttons — removal is
  now a right-click context menu on the GCP row (`useContextMenu`, matching the
  other sidebar sections); adding is via the table or image right-click only.
  Docs (CLAUDE.md CRS/GCP section) updated; `sfm.test.js` fixtures dropped
  `role`. 347/347 tests, typecheck + build clean. Still owed the same manual
  browser verification as the entry below (marking click accuracy at zoom,
  loupe, end-to-end georeference).

- **2026-07-07 · GCP-driven georeferencing + GCP-in-BA (F2, full scope)** —
  GCPs now participate in georeferencing, not just display. Data model: GCPs
  get a `role: 'control' | 'check'` (`useGcpsStore`) plus `setObservation`/
  `removeObservation` mutations for interactive marking. New pure
  `core/sfm/gcpTriangulation.js` (`triangulateGcp`/`triangulateAllGcps`)
  2-view-DLT-triangulates a GCP's registered-image observations into the
  current SfM frame. `useReconstructionStore`: `georeference()` now prefers a
  GCP-based Horn fit (`method: 'gcps'`) over the pose-based one when ≥3 control
  GCPs triangulate, and a new `gcpAccuracyReport()` surfaces per-GCP CRS
  residual + mean reprojection px in `GcpTable`/`GcpTableModal`/`GcpsSection`
  (role toggle + a refresh button). `ViewerImage.vue` gained click-to-mark:
  select a GCP (table "Mark" button or sidebar), click a pixel in an open
  image tab, it upserts that GCP's observation for the active image
  (`gcpMarkMode`/`selectedGcpId` props, `mark-gcp` emit). `GcpTable.vue` also
  gained a "+ Add GCP" toolbar button (`useGcpsStore.addGcp()` — a blank
  control GCP at the origin, no import needed) and made name/X/Y/Z editable
  inline (`setGcpName`/`setGcpPosition`), so a project with zero imported GCPs
  can still build one entirely from clicks: add → edit position → mark
  observations. Deepest part: GCPs
  now also constrain bundle adjustment directly (previously TODO's explicit
  "later") — `bundle_adjust` (`crates/reconstruction/src/bundle.rs`) takes new
  `anchor_flat`/`anchor_weight` params, adding a `Σ w·‖pt−target‖²` residual
  that only touches each anchored point's own 3×3 Schur block (no camera
  Jacobian changes; empty arrays ⇒ identical to prior behavior). `sfm.js`'s
  new `runGcpAnchoredBundleAdjust` runs after the main pipeline settles:
  triangulate control GCPs → Horn-fit → inverse-transform each GCP's CRS
  position into the SfM frame as the anchor target → re-run BA with the
  GCP observations injected as extra points/residuals → repeat once more
  (hard-coded, not a setting) as insurance against a poor seed fit; only the
  refined camera poses + original points are kept, so the *final* georeference
  used for products is still a fresh post-hoc fit, not the anchoring pass's
  scratch state. wasm rebuilt (`src/wasm/reconstruction/*`, not yet
  committed — see TODO ▸ Now ▸ W1). Tested: new Rust unit test
  (`bundle_adjust_gcp_anchor_pulls_point`), JS unit tests
  (`gcpTriangulation.test.js`, `reconstruction.test.js` gcpAnchors case,
  `sfm.test.js` GCP describe block) — 347/347 passing, typecheck clean. Owed:
  manual browser verification of the marking UI + end-to-end georeference/DEM
  path (TODO ▸ Now ▸ W1) before this is fully done.

- **2026-07-07 · Full-app audit vs COLMAP/Metashape + docs rebuild** — genuine
  state check of code vs docs. Findings: (1) tiled detection (TD) and
  native-width matching were implemented but **uncommitted and undocumented**
  (entries below); (2) `handover_gpu.md` held open work outside TODO.md,
  violating the three-doc rule — its open items are folded into TODO.md
  (Now ▸ G1, Backlog ▸ GPU/WASM dense perf), its verification record into the
  entry below, and the file is marked as an archived deep-dive reference;
  (3) EXIF GPS is parsed (`core/io/metadata.js`) but unconsumed — now TODO F10;
  (4) stale backlog line (`utils/detection.js` already deleted by RESTRUCT)
  removed. TODO.md rewritten with an explicit "general SfM tool" goal + gap
  analysis: new feature tracks F7 (COLMAP model import/export), F8 (processing
  report), F9 (cloud editing/gradual selection), F10 (EXIF-GPS priors), F11
  (scale bars), LAS + undistorted-image export under F1 polish, video import +
  16-bit TIFF + deploy story in Backlog. Test suite at audit time: 340/340,
  typecheck clean (per the GPU review run, same tree).

- **2026-07-07 · GPU/WASM compute review (record; plan folded into TODO)** —
  line-by-line review of the three PatchMatch kernels + orchestration at
  `89977ee`. **Verified**: cost math/aggregation/struct layouts/red-black
  semantics/bilinear edge behaviour in lockstep across WGSL↔JS↔Rust; committed
  wasm in sync with crate sources; 340/340 tests + typecheck green; fallback
  paths correct. **Issues found** (all secondary, none invalidates current
  defaults — fixes tracked as TODO G1): GPU silently truncates sources to 16
  while WASM/validation use all; no texture-dimension pre-flight (>8192px
  cameras fail opaquely); mid-run fallback retry drops the `onLog` hook; GPU
  lacks Rust's depth-range clamps; two stale comments; no GPU error scopes.
  Perf/quality follow-ups (half-grid dispatch, CPU/GPU overlap, on-GPU
  pyramid, f32 WASM loop, Stage-A geometric term) → TODO Backlog. Full detail
  survives in `handover_gpu.md` (archived reference).

- **2026-07-07 · TD1–TD4 tiled detection (native-resolution keypoints)** —
  **in working tree, uncommitted** (ship = TODO W0; browser run owed). Pure
  helpers `core/features/tiling.js` (`planTiles` edge-flushed overlapping grid,
  `sliceRaster`, `nmsByPosition` seam dedup, `autoTileSize` from GPU
  `maxStorageBufferBindingSize`; unit-tested in `tiling.test.js`).
  Orchestration in `workers/ops/detect.js` (`runTiled` wraps both SIFT and
  SuperPoint runners; per-tile coord offset → merged set → positional NMS →
  global top-K; adapter limit queried once; per-run tile-size resolve with a
  conservative SuperPoint GPU cap). UI: `DetectFeaturesModal.vue` Advanced
  disclosure per detector (Tiling Off/Auto/Manual, tile size, overlap px;
  "Max resolution" relabelled "Detection resolution"). Off by default
  (single-tile path == before). Kills the SuperPoint grid-density cap + the
  WebGPU OOM at source (the 2026-07-07 per-image fallback remains as belt).

- **2026-07-07 · Native-width descriptor matching (128/256; completes SP1's
  SuperPoint→brute-force path)** — **in working tree, uncommitted** (ship =
  TODO W0). `crates/matching` `l2_sq_early`/`match_descriptors` take a `dim`
  param (SIMD 32-dim block loop + scalar tail; no 128→256 padding, each width
  matched in its own space); `core/features/bruteforce.js` passes
  `options.dim`; `useMatchesStore.matchPair` supplies `srcA.descDim ?? 128`
  (wrong dim mis-slices into phantom rows → out-of-range indices — the
  `reading 'x'` crash in verify, hence the loud comments). WASM rebuilt
  (`src/wasm/matching/*` in tree).

- **2026-07-07 · TIFF input support (Chrome/Firefox)** — source TIFFs were
  invisible in every browser but Safari (WebKit decodes TIFF via system ImageIO;
  Skia/Gecko don't), so `<img>`, the metadata dimension probe, and the worker's
  `createImageBitmap` rasterize all failed silently. New `utils/tiff.js`
  (`isTiff` + `tiffToDisplayBlob` via the `geotiff` dep) transcodes TIFF→PNG at
  ingest (`addImages`) and restore (`restoreImages`) so `image.url` is always a
  browser-native raster; every downstream consumer works unchanged. Original TIFF
  still persists to OPFS.
- **2026-07-07 · Detect UX: size-aware GPU pin, non-Chromium warning, hard
  cancel** — `core/features/superpoint.js` (the WASM pin is now per input size:
  `gpuFailedAtPx` Map replaces the all-or-nothing `pinnedWasm` set, so a
  full-frame OOM no longer condemns small tiles; backend log states the real
  reason), `components/modals/DetectFeaturesModal.vue` (warn-box on
  Safari/Firefox that SuperPoint runs CPU-only + rewritten detection-resolution
  hints explaining the tiling interaction), `composables/usePipeline.js` +
  `stores/useImagesStore.js` (detect Cancel now hard-terminates the worker pool
  like reconstruct; a cancelled in-flight image reverts instead of erroring).
  Needs a manual browser run (Safari warn-box, cancel mid-SuperPoint).

- **2026-07-07 · SuperPoint per-image GPU→CPU fallback** —
  `core/features/superpoint.js`. WebGPU EP was hard-failing on large inputs
  (`std::bad_alloc` from a full-res convolutional activation exceeding the GPU
  buffer limit — e.g. 1200×1136), killing every image with no recovery. Mirrored
  LightGlue's self-healing pattern: sessions keyed `${modelKey}:${backend}`,
  `pinnedWasm` set + `chooseBackend`, and a try/catch around `session.run` that on
  a WebGPU failure pins CPU WASM for the rest of the run and re-runs the image on
  CPU (input tensor rebuilt per attempt so the re-run isn't handed a consumed
  buffer). Stopgap until tiled detection (TODO.md TD) removes the OOM at source.
  Typecheck + 330 tests green; in-browser fallback path unverified (Verification
  policy).

- **2026-07-07 · RESTRUCT · codebase reorganisation (RESTRUCTURE.md, all phases)** —
  mechanical, behaviour-preserving. `src/core/` grouped into `features/ sfm/ dense/
  products/ io/ help/` (crs/footprint/mask/types stay flat); `utils/` grab-bag
  dissolved (`detection.js`→pure `core/features/sift.js` + worker routed through it,
  `camera.js`→`io/cameraKind.js`, `importKind.js`→`io/importKind.js`,
  `cameraEstimated.js`→`sfm/cameraEstimated.js`); `matching.js` split into
  `features/bruteforce.js` + `features/verify.js`. God files broken up: `sfm.js`
  1417→1029 (`rotations`/`cycleFilter`/`tracks`/`initPair`); `App.vue` 1641→1297
  (composables `useTabDrag`/`useSidebarResize`/`useImportRouting`/`useExports`/
  `useModalEscape`); `Sidebar.vue` 1118→181 (6 section components under
  `components/layout/sidebar/` + `useContextMenu`); `compute.worker.js` 694→65
  (`workers/ops/{detect,match,sfm,dense,products}.js`). Each phase: `npm test`
  (188 pass) + typecheck + build green; the Vue/worker phases are browser-runtime
  and were NOT verified in a real browser (typecheck/build + binding audits only —
  needs a manual run). App.vue's remaining length is the flat template modal stack,
  left intact by choice (extracting a `<ModalStack>` would add prop/emit indirection
  for a cosmetic line win).

- **2026-07-07 · DX · Dense plane-cost homography sign (freckle root cause)** — the
  plane-induced homography in all three PatchMatch kernels computed `R·ray −
  t·(n·ray)/d`, but with the code's plane convention `d = n·P` (`n·X = d`) the correct
  sign is **`+`** (the `R − t·nᵀ/d` form assumes the opposite `n·X + d = 0`). Verified
  numerically: at the true depth/normal the old sign scores cost 0.11 (never bottoms
  out) vs 0.0000 flipped. Effect: PatchMatch settled on wrong depths everywhere → cost
  median ~0.7 (ZNCC ~0.29) *regardless of resolution/iterations* (the tell — a High-vs-
  Medium run left cost identical) → freckle + source-overlap seams, while sparse stayed
  clean (it uses `projectPoint`/`project_k1`, not `plane_cost`). Fixed in lockstep:
  `crates/reconstruction/src/mvs.rs`, `core/planeCost.js`, `workers/gpu/patchmatch.wgsl`
  (rebuilt `src/wasm/*`). Hidden for so long because `planeCost.test.js` only ever
  passed `t=[0,0,0]`, vanishing the term — now a non-zero-baseline ground-truth warp
  test guards it. Owed: re-run dense on CA…V to confirm cost medians fall to ~0.2–0.35
  and the freckle clears.

- **2026-07-06 · D3 · Distortion-model selector (general-SfM)** — sensors now declare
  a Brown-Conrady model — Pinhole / Radial (k1) / Radial (k1,k2) / Brown
  (k1,k2,k3,p1,p2) — in `core/distortion.js` (`DISTORTION_MODELS`, `coeffsForModel`,
  `inferDistortionModel`; `distortionOf` applies only the active model's coefficients,
  so a stale term from a model switch can't leak; undefined model ⇒ all five,
  back-compat). Store: `distortionModel` field on every sensor (EXIF → `pinhole`,
  imported → inferred from coefficients), validated edit path (`useSensorsStore`). UI:
  a Distortion column in `SensorTable.vue` (dropdown in Initial, read-only label
  elsewhere; inactive coefficient inputs disabled). Tests in `distortion.test.js`.
  Fisheye deferred to F6 (needs a virtual-pinhole dense undistort). UI is browser-only
  — unverified in-app.

- **2026-07-06 · D2 · Propagate self-calibrated distortion to dense** — the k1 D1
  folds into the sparse keypoints was lost at densify (dense undistorts rasters with
  the *sensor's* coefficients only), leaving the dense cloud in a slightly distorted
  frame vs the sparse cloud. `reconstruct` now accumulates the self-calibrated k1 per
  sensor across passes and exports it (`summary.selfCalDistortion`); the reconstruction
  store adds it to each sensor's dense `dist` (dense's camera K is the same BA-refined K
  the fold used, so applying k1 there reproduces the sparse frame — passes compose ≈
  additively for small residuals). Logs the applied calibration ('Dense' category).
  Covered by the D1 test's summary assertions (`sfm.test.js`). Pure JS — no wasm rebuild.

- **2026-07-06 · D1 · Fold self-calibrated k1 back into keypoints** — `refineIntrinsics:
  'f,k1'` estimated a shared radial k1 inside BA (`project_k1`, bundle.rs) that no
  downstream consumer applied — `projectPoint`, the track filter, reprojection stats,
  and the dense/ortho warp are all pinhole — so the model K carried a stranded k1: BA
  reported RMS 0.83px while pinhole stats read 7.35px, the pass-2 filter then gutted
  2862 → 737 points and dense froze on a k1-inflated fx (freckle). Fix in
  `runBundleAdjust` (`core/sfm.js`): after each self-cal pass, re-undistort each
  image's keypoints with the estimated k1 (`undistortPixel` is the exact inverse of
  BA's `project_k1`) and reset the model k1 to 0, so the pinhole invariant holds and
  stats/filter agree with BA. Logs the fold (image count + mean px shift). Test in
  `sfm.test.js` (distorted synthetic, no sensor, `f,k1` → K.k1 = 0, postBA median <
  1px, model survives). Pure JS — no wasm rebuild. D2 (propagate the calibration to
  dense) + D3 (distortion-model selector UI) remain in TODO.

- **2026-07-06 · LightGlue un-hang: fused model + keypoint cap + wasm threads** —
  the "stuck on one-time graph warm-up" had three stacked causes. (1) Bundled
  `lightglue.onnx` was the fabio-sim **v0.1.0** export: 9,729 nodes of dynamic-shape
  bookkeeping that hang ORT's WebGPU EP in shader-compile warm-up → replaced with
  **v1.0.0 `superpoint_lightglue_fused_cpu`** (1,359 nodes, fused MHA/LayerNorm/Gelu;
  offline-verified **bit-identical matches** and runnable on the repo's
  onnxruntime-web 1.27 wasm EP; outputs are now `matches0` [M,2] + `mscores0` [M] —
  parser already handled both formats). (2) CPU fallback fed up to 5000 kpts/image
  into O(N²) attention (~45–60 s/pair measured) → new `maxKeypoints` cap in
  `matchLightGlue` (default 2048, strongest-first prefix so indices stay valid;
  `lgMaxKeypoints` in MatchFeaturesModal). (3) The 15 s "still matching" watchdog
  could never fire on CPU (ORT wasm `run()` blocks the worker event loop) → watchdog
  now GPU-only, CPU logs honest post-hoc timing. Also: COOP + **COEP credentialless**
  headers in `vite.config.js` (dev+preview) → cross-origin isolation → multi-threaded
  ORT wasm (~3× measured at 4 threads; credentialless keeps basemap tiles working,
  Safari degrades to single-thread); `classifyOutputs` in `core/superpoint.js`
  hardened against N=256 shape-collision. Offline validation also confirmed
  SuperPoint emits **(x,y)** keypoints + L2-normed descriptors (SP1 risk retired).
  **Browser run still unverified** — needs a manual Chrome + Safari pass (tiles
  under COEP, GPU warm-up, thread pickup).

- **2026-07-06 · Fix project-open freeze on projects with a saved model** — three
  causes. (1) `clouds` was a plain `ref`, so every point object + its `views` Map
  became deeply reactive → `markRaw` the per-cloud `points`/`cameras` at all
  construction sites (`useReconstructionStore.js`). (2) `reconstruction.json` stored
  the whole point cloud as JSON, so restore did a multi-MB main-thread `JSON.parse`
  → new **version-2 binary format**: metadata (cameras, viewUuids) in JSON, point
  data in transferable `recon.{cloudId}.{pos|col|vcount|vcam|vkp}.bin` sidecars
  (positions Float64, colours Uint8, view-tracks CSR); `opfs.js` splits/reassembles,
  store `serializeCloud`/`deserializeCloud` pack/unpack. Legacy inline shape still
  reads. (3) added an interaction-blocking "Loading project…" overlay
  (`projectLoading` in `App.vue`) so users can't act on a half-restored project.
  Also fixed doubled console lines on reopen: log ids are now globally unique
  (`useLog.js`, was `++_seq` which reset per page-load → duplicate Vue `:key`s) and
  the log-store restore trims the previous open's re-logged banner lines
  (`useLogStore.js`).

- **2026-07-06 · 3D viewer: frustum size ← camera spacing, not cloud extent**
  — camera frustums / image thumbnails were sized off the point-cloud bounding
  radius (`radius * 0.15`), so a small or outlier-inflated sparse cloud made every
  quad the same big size and they overlapped heavily. Now `cameraFrustumDepth`
  (`Viewer3D.vue`) uses the **median nearest-neighbour distance between camera
  centres** (`× 0.6`, invariant to cloud outliers + absolute scale), with a robust
  95th-pctile point radius as the <2-camera fallback.

- **2026-07-06 · 3D viewer: "View options" popover** — a viewer-local gear popover
  (top-right of `Viewer3D.vue`, NOT the ribbon / global Settings — these are
  ephemeral session-scoped display tweaks) with live **Camera size** (`cameraScale`
  multiplier on the auto frustum depth; rebuilds frustums via `buildFrustums` with
  no cloud recompute) and **Point size** sliders. Room to grow (background,
  thumbnail on/off); the ribbon "Cameras" toggle can migrate in later.

- **2026-07-06 · Command console C1 (power-user command line)** — a typed prompt
  in the DevConsole that drives the *same* dispatch as the ribbon
  (`handleCommand(id)`). Pure registry `core/commands.js` (tokenize / resolve /
  alias / completions / `guardReason` mirroring the ribbon's disabled-tooltips /
  help) with 30 Tier-1 parity commands incl. 2-token `export <what>`; unit-tested
  (`core/commands.test.js`, 17 cases). Impure binding `composables/useCommands.js`
  (echo → resolve → guard → dispatch, plus `help`/`clear` built-ins). `DevConsole.vue`
  gains a prompt (↑/↓ history persisted to localStorage, Tab completion to longest
  shared prefix, auto-focus on open); `App.vue` passes `handleCommand` +
  `commandState`. Tier-2/3 (`run` chaining, `set`, `stats`, `pair`, Cmd/Ctrl-K)
  remain in TODO CC. `npm test` + typecheck + `vite build` green; runtime prompt
  behaviour is browser-only, not yet manually exercised here.

- **2026-07-05 · Six UX/quality improvements** — (1) Console
  (`DevConsole.vue`) sticky-bottom auto-scroll made explicit (`stickToBottom` set
  from a `@scroll` handler) + floating "↓ New logs" chip when detached. (2)
  Unaligned images: `App.vue` `alignedUuids` (union of sparse-cloud camera uuids)
  dims/flags unregistered images in the sidebar (`Sidebar.vue` `isUnaligned`) and
  fades their markers on the map (`ViewerMap.vue`); the 3D view already only draws
  registered-camera frustums. (3) Removed the "run reconstruction" link in the
  empty Point Clouds state. (4) Match **soft-disable**: `useMatchesStore`
  `setPairDisabled` adds a persisted `disabled` flag (excluded at reconstruct time
  in `useReconstructionStore.js`); toggled from `MatchListModal` (row/preview) —
  reversible, survives reload. (5) Connected-Papers-style **graph view**
  (`components/viewers/MatchGraph.vue`, canvas force layout, no dep) as a
  List/Graph toggle in `MatchListModal`; click edge → preview, double-click →
  exclude/restore, node colour = aligned/unaligned. (6) Progress ETA
  (`ProgressModal.vue`) now blends the cumulative mean with a per-item EMA and
  eases the displayed value (`smoothedEta`) for a smoother countdown.

- **2026-07-05 · Glossary (in-app help) overhaul** — replaced the CK3-style
  cascading side panels with a single centered **tabbed** modal
  (`components/glossary/GlossaryModal.vue`, `useGlossaryStore` = `tabs`/`activeId`)
  with a home index + search. Hover popup (`GlossaryTooltip.vue`) now shows a
  **border progress ring** that pins the popup once filled (interactive:
  cross-links + "Read more"); the keyword itself is no longer a click target
  (`GlossaryTerm.vue`, hover-only, setting-gated). `core/help.js` →
  `core/glossary.js`: adds `getAllHelpEntries`/`searchGlossary`, KaTeX
  (`$…$`/`$$…$$`, `marked-katex-extension` + `katex/dist/katex.min.css` in
  `main.js`), `assets/*` image resolution, and **auto-linking** of any entry
  title/alias (opt out with `<span class="no-help">`). New persisted
  `glossaryTermsEnabled` toggle (`composables/useGlossarySettings.js`, wired into
  Settings ▸ Display) and Ribbon *Other ▸ Glossary* entry (`open-glossary`, new
  `book` icon). Verified: `npm test` (164, incl. 16 new glossary), `typecheck`,
  `npm run build` all green. **Not browser-verified here**: the ring/pin hover
  interaction, tab management, and KaTeX/image rendering need a manual run.

- **2026-07-04 · Duplicate-keypoint suppression + inlier-spread reject (two more
  repetitive-structure defenses)** — closes the many-to-one escape hatch: the SIFT
  detector emitted several index-distinct keypoints within ~1px of one strong blob
  (same DoG extremum across adjacent scales/octaves), letting a repetitive-structure
  pair pass cross-check + ratio (each duplicate is a *distinct* index) and then get
  RANSAC-blessed by a degenerate F that parks the epipole at the shared point — while
  the H/F flag reads *healthy* (a homography can't fit a many-to-one bundle). Two layers:
  - **Detection-side dedup (root fix, `crates/sift/src/lib.rs`, WASM rebuilt):**
    `suppress_duplicate_positions` runs after response-desc sort, before the
    `max_keypoints` cap — spatial-hash NMS (cell = radius) keeping the strongest
    keypoint within `DEDUP_RADIUS_PX` (2px). `detect_sift` now emits a *second* trailing
    sentinel (`suppressed`) after `raw_found`; parse is `kept = floor((len-2)/STRIDE)`,
    updated in both parsers (`utils/detection.js`, `workers/compute.worker.js`) and
    logged per image (`SIFT … −N duplicate-position keypoints suppressed`).
  - **Position-aware reject (belt-and-suspenders for old keypoints / future matchers,
    JS only):** `inlierSpread` (`core/matching.js`, pure/exported/unit-tested) measures
    the accepted inliers' unique rounded positions + bounding-box diagonal per image;
    `useMatchesStore.matchPair` hard-rejects a pair whose inliers collapse — unique spots
    < `minInlierUniqueFrac` (0.5) × inliers (many-to-one) **or** extent < `minInlierSpreadPx`
    (8px) in either image (epipole degeneracy). Distinct from the `degenerate` label
    (planar/pure-rotation, a seed-quality tag): this is a hard drop with its own
    `rejectReason` + debug spread line. **Acceptance owed on the real building set**
    (browser run): confirm the stone many-to-one bundles from B1 are gone and the
    suppressed-count log is non-trivial on the building images.

- **2026-07-04 · Rotation-cycle match filter + match-run logging (sparse)** — a fourth
  repetitive-structure defense plus two smaller diagnostics. **Acceptance owed on the
  real building set** (browser run): the target is B1's 4289↔4324 window-swap pair being
  dropped before it poisons registration. Where each lives:
  - **Rotation-cycle consistency filter** (`core/sfm.js` `rotationCycleFilter` + call site
    in `reconstruct()`, pure/exported, no WASM change): the graph-level catch for pairs
    that clear every count/ratio gate but are geometrically false. Decomposes each
    verified pair's essential matrix into a relative rotation (reuses existing
    `fundamentalToEssential`/`recoverPose`), then for every triangle `{i<j<k}` (enumerated
    once from its min–mid edge) measures the cycle error `‖R_ik⁻¹·R_jk·R_ij‖` as a geodesic
    angle and credits all three edges. **Greedy** removal: drop the single least
    cycle-consistent edge, recompute support (so a good edge dragged down by a bad
    neighbour recovers), repeat until every survivor with ≥`minTriangles` triangles clears
    the support floor. Runs after K-map/undistort, before init-pair selection; prunes
    `donePairs` in-memory only (store/OPFS untouched — recomputable). Unjudgeable edges
    (< `minTriangles`, or no `F`) are kept. Knobs: `cycleErrorDeg` 5°, `cycleMinTriangles`
    2, `cycleMinSupport` 0.3, gated by `rotationCycleFilter` (default on). A false edge
    breaks essentially every cycle it sits in, so it separates cleanly from true edges
    (~few°) regardless of inlier count. Tests: K4-with-one-bad-edge, all-consistent,
    reversed-edge canonicalisation, single-triangle-unjudged.
  - **Match-run knob logging** (`stores/useMatchesStore.js` `matchAll`): the run-start line
    now reports `cross-check on (mutual NN)/off` + `ratio`. cross-check was already wired
    (modal → `settings.crossCheck` → WASM matcher) but defaults **off** and left no console
    trace, so a run's putative-matching behaviour was unauditable. No behaviour change.
  - Not touched (owner's runtime call): the PnP inlier-fraction floor `minPnpInlierRatio`
    (`core/sfm.js`, default 0.15) — raising it to 0.30–0.40 gates borderline cameras but
    has no modal control yet.
  - Verified: `npm test` (155) + typecheck clean. No `crates/` change → no WASM rebuild.
- **2026-07-04 · Repetitive-structure defenses (sparse)** — three COLMAP/Metashape-parity
  guards against matches that survive fundamental-matrix RANSAC but link the wrong
  repeated feature (window↔window on B1's building façade: epipolar-consistent yet
  geometrically wrong). Landed as three separate commits on branch
  `matching-degeneracy-robust-tri`; **acceptance owed on the real building set** (a
  browser run — this env can't drive OPFS/WGSL). Where each lives:
  - **Robust multi-view track triangulation** (`crates/reconstruction/src/pose.rs`
    `triangulate_tracks` + `core/reconstruction.js` `triangulateTracks` +
    `core/sfm.js` `robustRetriangulateTracks`, the high-leverage one): batched RANSAC
    over a track's view pairs (parallax-gated seeds) → largest consensus → N-view DLT
    refine → per-observation inlier mask. In sfm.js it re-votes each ≥3-view track
    after retriangulation/merge and before the filter passes, dropping the
    observations that disagree with the majority + a settling BA. Fixes the case
    `filterTracks` can't: when the 2-view seed was the wrong window, the point sits
    wrong and the old filter deleted the *good* views to fit it. 2-view tracks pass
    through untouched. Toggle `robustRetriangulate` (default on). Tests: Rust
    `triangulate_tracks_recovers_point_and_rejects_outlier`, JS batch-marshalling case.
  - **H-vs-F degeneracy flag** (`crates/matching/src/lib.rs` `verify_matches_hf` +
    `homography_dlt`/`ransac_homography`; `core/matching.js`; `stores/useMatchesStore.js`;
    seed tweak in `sfm.js`): fit a homography via RANSAC alongside F, compare inlier
    counts. `hfRatio ≥ 0.8` ⇒ `entry.degenerate` (planar façade / pure rotation — a
    poor SfM seed with an ambiguous E decomposition). Not a rejection (the pair still
    bridges the graph); the flag rides through `useReconstructionStore` into SfM, where
    seed selection prefers non-degenerate adequate pairs. Output layout of the verify
    call grew by one (`hInlierCount`). Tests: Rust planar (H≈F) vs general (H≪F), JS
    parse guard.
  - **Min-views-per-point gate** (`core/sfm.js` `minTrackViews` + `ReconstructModal.vue`):
    drop points seen by < N images, applied **once** after all BA/filter passes
    (earlier would starve registration). Default 2 = no-op; 3 mirrors Metashape's
    "image count" gradual selection and kills 2-view window-swap residue at the cost of
    cloud density. Recorded in the run summary. Test: a scene with genuine 2-view tracks
    asserts the ≥3-view gate drops exactly those.
  - Both crates rebuilt (`src/wasm/*` committed with source). Verified: `cargo test`
    (matching 2, reconstruction 8) + `npm test` (147) + typecheck. The end-to-end effect
    on B1's window-swap matches is the number still to measure in-browser.
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
