# websfm — TODO (the plan)

The single prioritized plan. Roles: `CLAUDE.md` = architecture/conventions,
`METHODS.md` = the science, `HANDOVER.md` = the record (baselines + done log),
this file = **all open work**, and `VERIFICATION.csv` = the **manual-check
register** (every browser / external-application check this environment cannot
run, with its pass criteria and a column for the result).
When an item ships: delete it here, add one done-log line to HANDOVER.md, and add
its owed manual checks as rows in `VERIFICATION.csv` — **not** as a checklist here.

A handful of **not-yet-started features keep a detailed executable spec** in a
`docs/planning/plan-<feature>.md` file (linked from the relevant item below). The
TODO line is the source of truth for *whether/when*; the plan file holds the
step-by-step *how*. Delete the plan file when the feature ships **and** its
verification rows are signed off.

**Goal (updated 2026-07-07):** a general browser-based SfM/photogrammetry tool
in the COLMAP/Metashape class — full pipeline (detect → match → sparse → dense →
DEM/ortho/mesh) for arbitrary image sets, with the existing differentiators
(polar/non-WGS84 CRS, historical film scans, zero-install/client-side) kept
first-class. Ordering below is by expected impact on the two benchmark workflows
(CA213732V… aerial strip, South Building B4 / Metashape building B1) *and* on
closing the generality gap. Baselines to beat are in `HANDOVER.md` §Baselines.

**Where we stand (audit refreshed 2026-08-17, after `0.1.0-beta.1`).** The feature
gaps named in the 2026-07-07 audit have closed: mesh output (F3), COLMAP/OpenMVG/
NVM/OpenSfM interop (F7), LAS+LAZ+COG+3D Tiles+undistorted images (F1), processing
report (F8), dense point-cloud editing (F9 numeric half), project save/load and
folder-backed projects, learned front ends (SuperPoint/LightGlue/SAM2) with
on-demand weights, and the usability track's pure half (profiler → recommendations
→ device budget → per-control prefills, pre-flight, post-run verdict). What is
*not* closed, in order:

1. **Verification.** Most of what shipped since 2026-07-10 has never been run in a
   browser on real data. That is the credibility gap now, not any missing feature.
   It is tracked row-by-row in `VERIFICATION.csv` (105 checks; 37 at P1).
2. **The "it just works" path** — U4 below is the last piece of the usability track
   and the only one a user sees.
3. Remaining feature gaps, all genuinely narrow: sparse gradual selection (F9),
   scale bars (F11), fisheye (F6), mesh texturing, reference-DEM-constrained BA (F13).

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
| `DEN-05` SB dense on WebGPU | decides P1 (GPU as the dense default) |
| `REL-02` cold smoke on the deployed build | it is a public beta |

Rules that keep the register honest: record the *measured* number, not "ok"; one
variable at a time (the 2026-07-25 SB run changed detection preset *and* pairing
and is therefore not comparable to anything); and a blank Debug ▸ Project Summary
block means a **producer** is not recording — fix the producer, not the renderer.

### U4 — one-click "Run All" (the last usability piece)
Everything it consumes has shipped: `core/profile.js` (U1), `core/recommend.js`
(U2), `core/dense/memBudget.js` + `useComputeSettings` (C1), the per-control
prefills (U3), `core/preflight.js` (U5) and `core/sfm/verdict.js` (U6).
Two of those are **pure code with no consumer** — `preflight.js` is imported
nowhere, and `verdict.js` only reaches the Quality Report / debug digest.
- New `RunPipelineModal.vue`: stage checkboxes, one Low/Med/High selector feeding
  U2, the U5 checklist inline, Run disabled while `hasBlockers()`.
- `runAll(stages, settings)` in `composables/usePipeline.js`, chaining the existing
  `runDetect`/`runMatch`/… under the `aborted` flag; same entry point backs the
  `run all` console command (CC ▸ C2).
- Finish on the U6 verdict (headline + findings, each with its `fix`).
- Assemble the preflight state snapshot in the store — that is U5's owed half.
- Manual pass → `VERIFICATION.csv` ▸ `UI-15`.

### RR — reference rasters: raw storage + COG + draw-time styling
Re-architecture, **not** a fix: the imported-raster path stores a *baked* plane, so
styling is a ~10 s re-decode of the original, the ortho bake has no reader
(`readWindow` has no consumers; `sampleAt` is null for orthos), and raw values —
needed for automatic GCP finding against satellite imagery — are unrecoverable.
Target: originals + COG as the source of truth, style as pure view state applied at
draw time on the GPU (`ol/source/GeoTIFF` + `ol/layer/WebGLTile`, both already in
OL 10.9), fast-first import with background conversion. **No back-compat / no
migration** — re-import is expected. Full spec:
`docs/planning/plan-reference-raster-rearchitecture.md`.
- **Phase 0 spikes first** (`VERIFICATION.csv` ▸ `RAS-05`, `RAS-06`). 0a is the
  assumption phases 3–5 rest on; 0d replaces every timing estimate in the plan with
  a measurement. Do not start Phase 1 before they answer.
- Deletes the 2026-07-20 restyle work (`styleStamp`/`planeStyleStamp`/
  `redecodePlane`/`restyleRasterPreview` + the `previewUrl` layer-rebuild fix) —
  correct for the architecture they patched, dead weight in this one.
- Phase 1 (the COG writer) already shipped ahead of the spikes deliberately: it
  survives either branch.

### SFM — decisions parked behind the acceptance runs
Each is one knob with a named piece of evidence; none should be tuned a priori.
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
real data**; it subsumes what was previously tracked as A5. Plan doc:
`docs/planning/plan-dense-sky-vegetation.md` (delete once this closes).
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
**SP3 — concurrency & memory.** A LightGlue session is ~45 MB **per worker** plus
WebGPU buffers. Route NN ops through a single dedicated inference worker (or cap
NN-path concurrency to 1–2); the learned backends are GPU-bound, so per-image
parallelism helps less than for CPU SIFT. Measure memory + wall-clock into HANDOVER
§Baselines. **⚠ Conflicts with the P5 matching-speed item below** (which proposes
2–3 parallel LightGlue workers): measure single-session GPU utilisation, pick one
stance, update both.

**SP4 — custom model upload** (Settings ▸ Advanced). User-supplied
`superpoint.onnx` / `lightglue.onnx` via a new `opfs.js` **Models** section
(`models/…`) + a small `useModelSettings`; the core backends prefer the OPFS
override, else the registry URL. Log which model (custom vs default, size/hash) each
session loads.

**SP5 — tests.** Unit-test the JS marshalling (coord back-map, gate wiring, validity
guard) with a mocked `InferenceSession`. Real-inference browser runs are
`VERIFICATION.csv` ▸ `DET-02`, `DET-04`, `DET-06`.

### Matching & detection throughput
Order: **P5 → P9 → P10**; measure before starting and after each item, and record in
HANDOVER §Baselines (`DET-07` is the before-number).

**P5 — parallelize `detectAll`.** `useImagesStore.detectAll` awaits one `detectOne`
at a time despite the pool. Reuse `matchAll`'s shared-cursor drain loop; keep
cooperative cancellation + per-image progress. ~POOL_SIZE× on detection, trivial.
Caveat: respect SP3's NN-concurrency cap — parallel SuperPoint sessions multiply GPU
memory.

**P9 — fused match+verify op + worker-side descriptor cache.** One `matchPairFull`
op (match + verify in one call; gate logic stays in the store). Workers cache
descriptors+keypoints keyed by uuid + re-detect revision (LRU ~100 MB); the client
posts buffers only on a cache miss and dispatches pairs grouped by shared image. Skip
pairs already `done` under identical settings unless `overwrite` (resumes interrupted
runs). Expect 1.3–2× and far less GC; kills the ≈6 GB of clone traffic per run.

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
- **P1 — make GPU the dense default.** Flip to on-when-adapter-exists ("Use GPU
  (recommended)"), keep per-image WASM fallback + first-image A/B validation, keep
  the opt-out. Gated on `DEN-05`/`DEN-06` passing in both Chrome and Safari.
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
- **IS-2 — liveness in the pre-flight (needs U4/U5 wiring).** A dead source is only
  discovered today when something renders or reads pixels, i.e. possibly an hour into
  a run. `core/preflight.js` is the right home: probe each image (one-byte read of the
  blob, the same test `refreshImageUrl` uses) and emit a `warn` naming the images that
  will fail, with "re-add the file" as the `fix`. Cheap enough to run per stage; must
  stay out of the hot path (it is O(images), not O(pixels)).

---

## Later — features

### F9 — the two remaining halves of point-cloud editing
The numeric **dense** half shipped 2026-07-22 (Tools ▸ Point Cloud: filter / crop /
merge, `core/products/cloudEdit.js`). What remains needs *interaction* or touches the
*sparse* model, which that work deliberately excluded:
- **Gradual selection** (the higher-value, cheaper half): filter **sparse** points by
  reprojection error / track length / triangulation angle with a live-count slider,
  then delete + re-run BA. The stats all exist in the track filter
  (`core/sfm/sfm.js`); this exposes them as a user-driven post-pass, UI as a modal
  like MatchList. It is genuinely a different operation from the shipped dense
  filters and must stay separate: a sparse point carries the view-tracks that
  dense/ortho/COLMAP-export read, so deleting one must invalidate the depth-map
  staleness stamp and re-run BA — exactly why `cloudEdit.js` refuses sparse clouds.
- **Interactive**: box/lasso select in Viewer3D → delete selected (three.js
  raycast/frustum). Cheaper than it was — the delete is `cropCloud`/`selectPoints`
  with a caller-supplied mask, so this is a selection-UI task plus one core entry
  point. Still needs the "new derived cloud vs persisted delete mask" decision.

### F11 — scale bars / distance constraints
For close-range/object work without GCPs: mark two image points across ≥2 views
(reuse the GCP marking UI), enter a known distance, scale the model and report the
residual. Metashape staple; small now that the triangulate-marked-points helper
exists (`core/sfm/gcpTriangulation.js`).

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
Background reading: `docs/planning/plan-feature-matching-backends.md` (the original
2026-07 backend plan, kept as reference).

### CC — command console, remaining tiers
**C2**: `run detect match sparse` chaining (same `runAll` as U4), `stats [matches]`,
`set sfm.minPnpInlierRatio 0.5` (echo old→new). **C3**: `pair disable|enable <A> <B>`,
`select <imageName>`, `Cmd/Ctrl-K` open-and-focus, per-command usage. Consider
auto-deriving the T1 command list from the ribbon table so it can't drift.

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
- **P4 — GPU matcher (WebGPU).** Descriptor-distance matrix in a compute shader
  (`src/workers/gpu/`, device singleton exists). The real path to Metashape-class
  matching throughput (100×+); largest effort. Revisit only after P5–P9 land and are
  measured; reuse P8's GEMM formulation in WGSL.
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
