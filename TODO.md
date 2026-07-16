# websfm — TODO (the plan)

The single prioritized plan. Roles: `CLAUDE.md` = architecture/conventions,
`HANDOVER.md` = record (baselines + done log), this file = **all open work**.
When an item ships: delete it here, add one done-log line to HANDOVER.md.

A handful of **not-yet-started features keep a detailed executable spec** in a
`PLAN-<feature>.md` file at the repo root (linked from the relevant TODO item
below). The TODO line is the source of truth for *whether/when*; the PLAN file
holds the step-by-step *how*. Delete the PLAN file when the feature ships (fold
the done-log line into HANDOVER.md per the four-docs rule).

**Goal (updated 2026-07-07):** a general browser-based SfM/photogrammetry tool
in the COLMAP/Metashape class — full pipeline (detect → match → sparse → dense →
DEM/ortho/mesh) for arbitrary image sets, with the existing differentiators
(polar/non-WGS84 CRS, historical film scans, zero-install/client-side) kept
first-class. Ordering below is by expected impact on the two benchmark
workflows (CA213732V… aerial strip, Metashape building set B1) *and* on closing
the generality gap. Baselines to beat are in `HANDOVER.md` §Baselines.

**Where we stand vs COLMAP/Metashape (audit 2026-07-07).** Already at parity or
better for a browser tool: two detector/matcher front ends (SIFT + SuperPoint/
LightGlue, tiled detection), F/H-RANSAC verification with four repetitive-
structure defenses, incremental SfM with LM/Schur BA + f/k1 self-calibration,
distortion models, PatchMatch MVS on CPU **and** WebGPU, DEM + true ortho,
GeoTIFF export, OPFS projects, in-app glossary + command console, GCP-driven
georeferencing (post-hoc similarity fit *and* GCP-anchored BA) with a per-GCP
accuracy report. The real gaps to "general tool" (tracked in Later ▸
features): any mesh output (F3), interop with the ecosystem — COLMAP
model import/export (F7), LAS point clouds (F1 polish) — processing report
(F8), point-cloud editing/gradual selection (F9), EXIF-GPS pair preselection
(F10), scale bars (F11), fisheye (F6). The biggest
*credibility* gap is not a feature: it's that the R-track robustness work is
still unvalidated on real data (Now ▸ R).

---

## Now

### M — Dense-fusion OOM + pipeline progress (2026-07-12)
**All 7 phases shipped** (code + unit tests + typecheck) — see HANDOVER
2026-07-12 done-log. **First owed: in-browser verification** (headless can't
observe OOM, viewer rendering, transfer round-trip, or restore). Re-run the
50-image building set at medium quality end-to-end and confirm:
- Build Dense Cloud no longer OOM-kills the tab; watch `performance.memory` /
  Task Manager during densify (peak should track the "Dense fuse: projected peak
  memory" log line).
- Progress bars glide: sparse (init-pair scoring, interim BA, final stretch),
  depth maps (fractional within-image), densify (per-map fusion + "Packing…").
- Ortho still works after a densify (Phase 3 buffer round-trip), and a *second*
  densify run works (buffers re-attached).
- Dense cloud renders in the 3D viewer (Phase 6 flat shape), PLY export opens,
  DEM builds from the dense cloud, and a saved→reopened project restores the
  dense cloud (Phase 6 flat persist/restore + the legacy-object back-compat path).

### V — SfM quality overhaul (WS1–5): verification runs owed (2026-07-16)
**WS1–WS5 code shipped** (see HANDOVER 2026-07-16 done-log): matching weak-pairs +
decoupled floors, self-cal f/cx,cy/k1,k2,k3 (bitmask BA, wasm rebuilt) with staged
schedule + composed-bag fold, cycle-filter bridge protection + post-self-cal re-admission,
dense geometric filters, and the modal ui/ framework + presets. **WS5 is now fully
migrated** (2026-07-16): all nine pipeline modals use `ModalShell` + `PresetCards` (hero
label+blurb cards; deviation shows a "· modified · Reset" status, no dead Custom chip) +
`SettingsGroup` + `AdvancedDisclosure`. The advanced-disclosure default is a persisted
Settings ▸ Display preference (`useUiSettings`), and the experimental GPU toggle moved out
of the Match/DepthMaps modals into Settings ▸ Compute (`useComputeSettings.useGpu`).
Orphaned `PresetSelector`/`SettingsSection` deleted. `npm test`/`typecheck`/`vite build`
green. **Owed — the credibility step; headless can't observe any of it:**
- **Phase 0 + Verification runs (defaults).** Re-run the **building** set (50× Canon 5D)
  and **TMA** film set at *default* settings and record deltas in HANDOVER §Baselines:
  registered cams (target building ≥45/50, TMA 5/5), post-BA median px, %≥3-view, self-cal
  fx + full k-bag (compare the distortion *curve* Δr(r) to Metashape k1 −0.137/k2 +0.101/
  k3 −0.027 @ f 2983, target ≲1px max dev), cycle-filter drops + "re-admitted N pairs"
  line, dense cull breakdown (lowParallax/grazing/isolated) + a manual sky/veg look.
- **Visual QA of the redesigned modals (browser).** Open all nine migrated pipeline modals
  (Detect / Match / DepthMaps / Dense / Reconstruct / Mesh / DEM / Ortho / Export /
  Footprint) and confirm: preset cards + "· modified · Reset", grouped Advanced sections,
  one-line hints, the Settings ▸ Display "Expand advanced settings" toggle changing the
  disclosure's default, and the Settings ▸ Compute GPU toggle actually driving Match +
  DepthMaps runs. ExportModal is now 600 px wide (was 380) — check it doesn't feel empty.
- **Tell Felix:** the "500 floor / 0.4 ratio" in the baseline logs were *user-set*, not
  defaults (`minMatches` defaults to 15) — WS1 makes the pipeline robust to it, but the
  defaults were never the problem there.

### Q — Reconstruction quality/speed overhaul (2026-07-10 log audit)
Two real runs (aerial CA213732V… film scans + 50-image building set) exposed a
chain of quality problems. **P0.1/P1/P2.1/P2.3/P3/P4/P6 shipped** (see HANDOVER
2026-07-10 done-log). Diagnosis lives in HANDOVER §Baselines B0/B1. **First owed:
the in-browser verification of what shipped** — re-run both datasets and record
deltas in HANDOVER §Baselines (verified pairs/rejected/cycle-drops, cameras
registered, post-BA median+p95 reproj, ≥3-view %, dense cost median, fusion
kept-%), plus dense visual quality + GPU↔CPU A/B RMS. This tells you whether P0.2
(k2) is even needed. Remaining items (ordered by impact/effort; delete each line
as it ships, HANDOVER done-log line each):

- **P0.2 — extend self-cal to k2** *(gated: measure P0.1 first)*. 24 mm lenses
  leave residual corner barrel after k1-only. Add shared `k2` to the BA intrinsic
  block (`crates/reconstruction/src/bundle.rs`) + extend the exact-inverse fold
  (`undistortPixel` ↔ a `project_k1k2`). Rebuild wasm, commit `src/wasm/*`.
- **P0.3 — first-class "film width (mm)" input.** In `SensorTable.vue`, for
  scan/film sensors offer format-width-mm as the primary field (pitch derived) +
  surface a store suggestion when the implied-width warning fires ("set to 230 mm?").
  The `sfm.js` K path already supports width-derived focal.
- **P2.2 — bilateral-weighted ZNCC (COLMAP-style).** Weight window samples by
  grayscale similarity + spatial distance. Change all three kernels
  (`mvs.rs`/`patchmatch.wgsl`/`planeCost.js`) + the A/B reference in lockstep.
- **P2.4 — geometric-consistency dense pass.** The heavier successor to **A5**
  (below) — do A5 first, then the in-optimiser term (also Backlog "Stage-A
  geometric consistency term inside PatchMatch"). COLMAP `--geom_consistency`.
- **P5 — matching speed** (37 min → <8 min for 50 imgs). (1) retrieval
  preselection without poses — build-now variant of Parked ▸ vocab-tree (aggregate
  existing SuperPoint descriptors → cosine kNN → top-k + sequential ±2); (2) don't
  escalate hopeless pairs (F-verify the *coarse* matches first, only run the capped
  match if coarse F-inliers ≥ ~8; `matchLightGlueTiled`); (3) parallel LightGlue
  across workers — **⚠ conflicts with SP3** (resolve together, measure GPU
  utilisation first); (4) demote per-tile logs to debug. Acceptance: <10 min with
  ≥95% of currently-verified pairs still found; no ORT deadlock on Cancel+rerun.

Verification per change: `npm test` + `npm run typecheck`; `crates/` change →
`npm run build:wasm` + commit `src/wasm/*`; kernel changes → keep the three
PatchMatch kernels in lockstep + re-check GPU↔CPU A/B RMS < 5e-3 **and** the P1
slanted-plane test.

### W0 — Ship the working tree (uncommitted feature work)
The tree currently holds two finished-but-uncommitted features (see HANDOVER
2026-07-07 entries): **tiled detection TD1–TD4** (`core/features/tiling.js` +
tests, `workers/ops/detect.js` `runTiled`, DetectFeaturesModal Advanced UI) and
**native-width descriptor matching** (`crates/matching` `dim` param, 128/256;
store passes `descDim`; wasm rebuilt) which completes SP1's SuperPoint→
brute-force path. Owed before/at commit:
- Manual browser run: tiling on/auto/manual on a large image (Chrome — watch
  the `tiling W×H → N tile(s)` log + seam-duplicate NMS behaving), SuperPoint→
  brute-force end-to-end match, TIFF ingest in Chrome, detect Cancel
  mid-SuperPoint, Safari warn-box.
- Commit `src/wasm/*` with the crate change per convention; split commits
  (tiling / dim / TIFF+UX) if practical.

### W1 — GCP georeferencing + BA anchoring (F2, uncommitted): owed manual verification
Full GCP-in-BA support + a GCP-marking UX overhaul just landed (see HANDOVER
2026-07-07 and 2026-07-08 entries): 2-view DLT triangulation
(`core/sfm/gcpTriangulation.js`), GCP-preferred `georeference()` + per-GCP
`gcpAccuracyReport()` (`useReconstructionStore`), **right-click marking** in
`ViewerImage.vue` (add-new / assign-existing) with a magnifier loupe + live
reprojection feedback, sidebar observation list (jump-to-image + remove) +
coverage flags, and a GCP anchor residual in `bundle.rs` (own point-index
space, weighted `‖pt−target‖²`, `crates/reconstruction` wasm rebuilt) wired
through `core/sfm/sfm.js`'s post-pipeline `runGcpAnchoredBundleAdjust`.
Unit-tested (Rust `bundle_adjust_gcp_anchor_pulls_point`, JS
`gcpTriangulation.test.js` + `sfm.test.js` GCP describe block); the interactive
UI + end-to-end georeference/DEM-in-CRS path still need a real browser run:
- "+ Add GCP" (table) or right-click "Add new GCP here" in an image → confirm
  a GCP appears, the overlay turns on, and the loupe/marker render correctly at
  various zoom/pan (click accuracy is the main thing to eyeball).
- Mark ≥3 GCPs on ≥2 images each, edit their surveyed X/Y/Z, run reconstruct,
  confirm the "GCP-anchored bundle adjustment" log line + plausible per-GCP
  residual (table) and live reprojection px (marker + sidebar).
- Build a DEM in the project CRS and confirm it uses the GCP-based georeference
  (`georef.value.method === 'gcps'`) over the pose-based fallback.
- Commit `src/wasm/reconstruction/*` alongside the `crates/reconstruction`
  diff per convention.

### R — verify the R track on real data (the acceptance run; unchanged)
R1–R6 (registration robustness) shipped 2026-07-04 but are only unit-tested.
**Re-run the Metashape building set (B1) and confirm the acceptance targets:**
all 50 cameras registered at the *tight* fixed gate; pre-BA p95 < 20px (from
282px); ≥3-view track share > 30% (from 9.5%); no BA-rejected passes; with
`refineIntrinsics: 'f,k1'`, self-calib cx/cy stable within ~10px and a
plausible k1. Then re-run dense (the homography-sign fix of 2026-07-07 should
finally show: cost medians ~0.2–0.35, not ~0.7): per-image cost median ≤ 0.45,
fusion kept fraction > 20% (from 5%). If a target misses, the per-camera
residual table names the offending cameras; tune `interimBaEvery` /
`minPnpInlierRatio` / `overrideInliers` from there. Record the new numbers as
baseline **B2** in HANDOVER. Same session: re-run dense on CA…V (freckle-fix
confirmation owed since 2026-07-07).

---

## Next

### U — "It just works" usability track (audit 2026-07-12)
The real gap vs Metashape/COLMAP is **usability**, not algorithms: there is no
"just works" path — detection `maxDim` is a flat 1200 whether the input is a 2k
phone photo or a 10k film scan, `maxKeypoints` a flat 5000 whether 5 or 500
images; no one-click run-all; no post-run verdict. Metashape model: autos are
good, experts keep every knob. All derived values get an `onLog` line and stay
overridable. **Order: U1 → U2 (+C1) → U4 → U5 → U3 → U6.** U1/U2/U5/U6 are pure
+ unit-testable (no browser); U3/U4 need a browser-manual pass — say so.
- **U1 — Dataset profiler.** New pure `src/core/profile.js`:
  `profileDataset({images, sensors, poses, gcps}) → { nImages, minDim, maxDim,
  medianMP, kind:'film'|'drone'|'phone'|'unknown', hasGps, hasPoses,
  hasCalibratedDistortion, sequentialNames, scale }` from metadata only (no pixel
  reads); every decision gets a `notes[]` rationale. Type in `types.ts`. Unit-test
  film/drone/no-metadata/sequential-name cases.
- **U2 — Recommended settings.** New pure `src/core/recommend.js`:
  `recommendSettings(profile, budget) → { detect, match, sfm, depthmap, fuse }`,
  same shapes as `defaults.user.js` but derived (e.g. `maxDim =
  clamp(round(0.5·nativeMax), 1200, 3200)` for film/large; `maxKeypoints` scaled
  by count; strategy from poses/GPS/sequential). Returns `{value, reason}` pairs.
  Pin expected outputs for the B0/B1 profiles.
- **C1 — Hardware-aware memory budget.** `core/memBudget.js` gains
  `deviceBudget()` reading `navigator.deviceMemory` / `performance.memory` (main
  thread — pass the number *into* core; core stays pure). Seeds the dense gate,
  feeds U2's dense quality pick, warns in U5. Unit-test the derivation with
  injected values; log detected budget + source.
- **U3 — "Recommended for this dataset" prefill** in each stage modal: banner
  showing derived values that differ from static defaults, one-click apply,
  hover shows `reason`. Prefill only, never a hidden override.
- **U4 — One-click "Run All".** New `RunPipelineModal.vue` (stage checkboxes,
  one Low/Med/High selector → U2, U5 checklist) + `runAll(stages, settings)` in
  `composables/usePipeline.js` chaining the existing `runDetect/…` with the
  `aborted` flag; also the `run all` console command (CC ▸ C2 — same `runAll`).
- **U5 — Pre-flight checks.** Pure `core/preflight.js` → `[{level, msg, fix}]`:
  no focal ⇒ warn; film without fiducials ⇒ warn; dense memory projection
  (`projectDensifyPeakBytes`) + GPU adapter check; <2 images / no keypoints /
  all pairs disabled ⇒ block. `block` disables Run.
- **U6 — Post-run verdict.** Pure `core/sfm/verdict.js`: run summary → traffic
  light + next-steps (registered <80% ⇒ list unregistered + overlap/minMatches;
  p95 reproj >3× median ⇒ suspect distortion; ≥3-view share <20% ⇒ weakly
  constrained). Encode the B0/B1 fingerprints as thresholds; this is the cheap
  20% of F8 — keep the rule engine pure so F8 reuses it.
- **§A6 — Adaptive bridge-pair gate** *(gated on the B1 re-run under R)*: B1
  showed `minInlierRatio 0.25` rejecting genuine loop-closing bridges (27 inliers
  @ 0.23). Evaluate lowering `MATCH_TUNING.overrideInliers` (30) to ~25 **or** an
  explicit "bridge exception" (ratio ≥ 0.2 AND inliers ≥ 25 AND passes spread
  gate). Decide from logs, not a priori; one knob, one test.

### TC-2 — Rust TIFF **encoder** (optional follow-up to the shipped decoder)
The native decoder shipped 2026-07-16 (decode 34 s → 1 s; see HANDOVER §B0-ingest).
The remaining ingest cost is now the **canvas PNG encode (~4 s, ~75% of ~5.3 s/img)** —
Chrome's PNG encoder is slow and canvas forces 4-channel RGBA even for grayscale film
scans. Only worth doing if ingest needs to go lower. Sketch:
- Add `encode_png(pixels, w, h, channels)` to `crates/imagecodec` (`png` + `fdeflate`),
  emitting **true grayscale** PNG for gray sources (¼ the data to filter+deflate).
- Keep the display JPEG on canvas (fast + small) OR add `encode_jpeg` too.
- Wire in `workers/ops/tiff.js` alongside the decoder; same fallback discipline.
- Watch the transfer cost of handing the ~390 MB RGBA buffer between decode and
  encode — doing both in one Rust call (decode→encode, never returning raw pixels
  to JS) may beat two hops. Measure before committing to a shape.
- Verify: PNG round-trips to identical pixels (still lossless for `computeUrl`);
  before/after `TIFF timing` → HANDOVER.

### TC-3 — Log source compression/bit-depth on the wasm decode path (diagnostic)
The `TIFF timing (wasm):` line shows `[undefined/?-bit/?spp/undefined]` because
only the geotiff fallback branch fills `srcInfo` (photometric/bit-depth/spp/
compression) — the fast wasm path never reads it. Cheap and nice-to-have: have
`crates/imagecodec`'s `decode_tiff` also return the source photometric / bits-per-
sample / samples-per-pixel / compression tag (the `tiff` crate exposes these on
the decoder) and populate `srcInfo` from the wasm result in `workers/ops/tiff.js`,
so the audit line reports what was actually decoded on the fast path. Diagnostic
only — no behaviour change.

### MC — Multiple result clouds (sparse + dense) with lineage
Today the pipeline assumes exactly one `kind:'sparse'` cloud (every downstream
stage does `clouds.find(c => c.kind==='sparse')`) and one `dem`/`ortho`. Lift
that for the two artifacts users actually compare — **sparse and dense clouds** —
so a COLMAP import (F7) can sit next to a computed reconstruction instead of
destructively replacing it, and so re-running with different settings can keep
both. This is the useful 20% of Metashape "chunks" without the project-management
overhead (chunks themselves stay Parked — decide consciously to stop here).

**Design principle:** multiplicity is for artifacts you'd *compare or keep
provenance of*; the payoff is **lineage**, not just a "main" pointer. `selectedCloud`
(viewer focus) already exists and is multi-cloud; what's missing is the *downstream*
selection — which cloud each stage consumes.

- **Phase 0 — sparse multiplicity + `mainSparseId`.** ✅ landed 2026-07-10 (see
  HANDOVER); **browser run owed** (set-main + delete-main promotion + persistence
  round-trip in the real app — OPFS/Vue can't be driven here).
- **Phase 0b — dense multiplicity + `mainDenseId` + `parentSparseId`.** Nearly free
  once 0 lands (`clouds` already holds both kinds): stop replacing on `upsertDenseCloud`,
  add `mainDenseId` + a `parentSparseId` on each dense cloud (which sparse it fused
  from) so lineage is explicit. **Depth maps become a child of their dense run** —
  key the cache by parent dense id rather than exposing "multiple depth-map sets".
- **Deferred (Tier 2/3, don't build yet):** DEM/ortho stay single refs until a real
  compare-two-DEMs need appears (cheap to regenerate, undercuts keeping several);
  matches/keypoints/georef stay single (one converged config in practice — a plural
  match graph is a bigger store rework for a workflow most users don't run).

### SP — SuperPoint + LightGlue: remaining slices
SP0–SP2 shipped (runtime + assets, SuperPoint detect path, LightGlue match op —
see HANDOVER 2026-07-06/07 entries; W0 ships the last SP1 piece). Remaining:

**SP3 — Concurrency & memory.** `matchAll`/`detectAll` fan out over the
POOL_SIZE pool; a LightGlue session is ~45 MB **per worker** plus WebGPU
buffers. Route NN ops through a single dedicated inference worker (or cap
NN-path concurrency to 1–2); SuperPoint/LightGlue are GPU-bound so per-image
parallelism helps less than for CPU SIFT. Measure memory + wall-clock; record
in HANDOVER §Baselines. **⚠ Conflicts with Q ▸ P5(3)** (which proposes N=2–3
parallel LightGlue workers) — resolve together: measure single-session GPU
utilisation, then pick one stance and update both.

**SP4 — Custom model upload (Settings ▸ Advanced).** Advanced tab in
`SettingsModal.vue` for user `superpoint.onnx` / `lightglue.onnx`. New `opfs.js`
**Models** section (`models/…`) + a small `useModelSettings` composable;
`core/features/superpoint.js`/`lightglue.js` prefer the OPFS override, else the
bundled `public/models/` default. Log which model (custom vs bundled, size/hash)
each session loads.

**SP5 — Tests + browser verification.** Unit-test the JS marshalling (coord
back-map, gate wiring, validity guard) with a mocked `InferenceSession`. The
real-inference browser run (Chrome + Safari: COEP tiles, GPU warm-up, thread
pickup, LightGlue CPU + GPU paths) is still owed from the 2026-07-06 un-hang
work — fold into W0's browser session if convenient.

### P5–P9 — Matching & detection throughput (plan of 2026-07-04)
Exhaustive matching on the building set (50 imgs × ≤5000 kp → 1225 pairs) takes
minutes. Diagnosis: (a) brute-force NN is O(pairs·M²) and every pair pays full
price even with zero overlap; (b) RANSAC always runs 1000 F + 1000 H iterations
per pair, each doing a 9×9 Jacobi eig; (c) every pair structured-clones ~5 MB of
descriptors into a worker plus both keypoint arrays for verify — ≈6 GB of copies
per run. Keep `core/` pure and the store gates unchanged. Order **P5 → P9**
(P6 shipped 2026-07-10, P7 shipped 2026-07-08, P8 shipped 2026-07-11 — see
HANDOVER); measure matching wall-clock before starting and after each item,
record in HANDOVER §Baselines.

**P5 — Parallelize `detectAll`.** `useImagesStore.detectAll` awaits one
`detectOne` at a time despite the pool. Reuse `matchAll`'s shared-cursor
drain-loop; keep cooperative cancellation + per-image progress. ~POOL_SIZE× on
detection. Trivial. Caveat (new since SP): respect SP3's NN-concurrency cap —
parallel SuperPoint sessions multiply GPU memory.

**P8 — GEMM-form NN kernel** — ✅ shipped 2026-07-11 (see HANDOVER). Optional
follow-up gated on measured need: u8-quantized descriptors + integer SIMD (touches
persistence shape). The matching wall-clock re-run (owed under Q ▸ P5) will measure
the actual speedup.

**P9 — Fused match+verify worker op + worker-side descriptor cache.** One
`matchPairFull` op (match + verify in one call; gate logic stays in the store).
Workers cache descriptors+keypoints keyed by uuid + re-detect revision
(LRU-capped ~100 MB); client posts buffers only on cache miss, dispatches pairs
grouped by shared image. Skip pairs already `done` under identical settings
unless `overwrite` (resume interrupted runs). Expect 1.3–2× and far less GC;
kills the ≈6 GB clone traffic.

### M — Mask editing overhaul (floating toolbar + tools; SAM2 is F12)
**M1+M2 shipped 2026-07-11** (see HANDOVER): "Edit Mask" ribbon toggle +
floating `MaskToolbar.vue`, rectangle/invert/undo-redo/sliders/shortcuts.
Remaining:
- **Browser-manual run (owed verification).** Toolbar drag + all tools on a
  real image (brush/eraser/rect incl. Alt-erase, invert, import, clear); undo/
  redo across a tab switch (v-show-kept state); Esc ordering (modal open →
  closes modal, else exits edit mode); shortcut gating while typing in inputs;
  Mask Manager "Edit" still lands in edit mode; keypoint re-detect after a mask
  edit actually drops masked keypoints (regression).
- **M3 (optional polish, gate on use):** polygon/lasso tool; "apply mask to all
  images of this sensor" (`maskFromSource` already rescales); masked-% readout;
  mask badge in the sidebar ImagesSection.

### M4 — Content-based Auto-Mask strategies — spec: `PLAN-automask-strategies.md`
Not started. Auto-Mask today has one strategy (fixed-px border); add three
content-based ones (detect film frame per scan, colour/luminance key, low-texture
regions) as a worker op reading downscaled rasters. Pure `core/maskAuto.js` +
`workers/ops/mask.js` + a strategy-picker rework of `AutoMaskModal.vue`. Full
step-by-step spec (module API, tests, UI, defaults) in the linked PLAN file.
Parked out of scope there: SAM2-propagation auto-masking (see F12).

### FD — Auto-detect fiducial marks on film scans — spec: `PLAN-fiducial-autodetect.md`
Not started. Marking fiducials by hand on every scan is tedious. Mark all
fiducials on **one reference image per film sensor**, then ZNCC template-match the
same marks on every other image of that sensor (the HSfM/Kugelhupf approach:
within a scan batch the frame lands in nearly the same position). Coarse-to-fine
+ sub-pixel peak; QC = absolute score floor + per-mark population median band +
affine-RMS refit gate. Pure `core/sfm/fiducialDetect.js` + two `ops/detect.js`
ops + `FiducialDetectModal.vue`, entry from the film-sensor editor in
`SensorTable.vue`. Builds on the shipped F4 interior-orientation math
(`fitFiducialAffine`/`mmToScan`). Full spec (module API, memory guardrails for
10k×10k scans, rotation-mapping gotchas, tests) in the linked PLAN file.

### G2 — Glossary entries for the newly load-bearing terms (folded from PLAN P6.3)
Add `src/glossary/algorithms/` entries for **"matching density"** (Fast/Full — the
LightGlue tiled vs capped path), **"self-calibration"** (`refineIntrinsics: 'auto'`,
now on by default), and **"cycle consistency"** (the rotation-cycle match filter) —
the pipeline now leans on all three and they auto-link wherever their title/aliases
appear (see CLAUDE.md "Adding a term"). Small; pure content.

### A5 — Per-depth-map geometric consistency filter (dense)
Fusion is currently the only cross-view test and runs too late to stop freckle.
After Stage A completes all maps (in the worker, where maps are cached), add an
optional filter pass: reproject each reference pixel into each source's *depth
map*; keep only if ≥1 source agrees within the fusion tolerance (extract the
agreement math from `fuseDepthMaps` into a shared `core/dense/mvs.js` helper).
Run before the speckle filter; log drop counts. Toggle in the modal (default
on). Related: investigate `depth 0.00` minima in Stage A output (degenerate
plane init should be clamped, not exported). Longer-term sibling (backlog):
COLMAP-style geometric term *inside* PatchMatch.

### P1 — Make GPU the dense default (WebGPU Phase 3)
Flip the modal default to on-when-adapter-exists ("Use GPU (recommended)"),
keep per-image WASM fallback + first-image A/B validation, keep opt-out. Do
after G1 (the pre-flight/diagnosability items make default-on safe). Needs a
browser check (Safari + Chrome).

### Owed runtime validations (shipped code, unproven on real data)
- **A2 self-calibration** on CA…V: does refined-f pull toward ~6700 and reduce
  the dome/tilt z-spread? (F4 fiducial interior orientation now shipped as the
  alternative fix — validate both on the film set.)
- **A3 retriangulation** on CA…V: does ×3-view share rise on noisy real data?
- **A4 undistort** on genuinely distorted imagery (drone/phone).
- **P2 matching throughput** on a real 50–500-image set.
- **Products** runtime test on the real aerial set; exported GeoTIFFs checked
  in QGIS/ArcGIS.
- **Rotation-cycle filter** on B1: drops 4289↔4324 (window-swap) without
  culling genuine weak-baseline bridges? Watch the `rotation-cycle filter
  dropped …` warns; loosen `cycleErrorDeg`/`cycleMinSupport` if it over-culls.
(The tiling/SuperPoint/LightGlue/TIFF browser runs are under W0/SP5.)

### P3 — OPFS quantize + spill of depth maps
Quantize Stage-A output (depth → Uint16 + per-map min/max, cost → Uint8), write
per image to OPFS (`depthmaps/<uuid>.bin` + JSON meta) as each completes;
densify/ortho read + dequantize **in the worker** (core stays pure); store
cache holds metadata instead of float planes; raster cache goes gray-only
(+rgb for ref); GPU state packs f16 via `pack2x16float` with chunked readback.
Bonus: depth maps survive reload — update the "not persisted" comments in
`useReconstructionStore`. Gotchas: transfer lists detach buffers shared with
ortho; `layout:'auto'` bind groups + the 64-byte Params uniform in
`depthMapGpu.js` move together. Validate in Safari before calling done.

---

## Later — features (the road to a general SfM tool)

Ordered by how much each closes the COLMAP/Metashape gap per unit effort.
F3 → F7 → F8 are the spine: visible 3D product, ecosystem interop, deliverable
report (F2 — accuracy story — shipped 2026-07-07, see HANDOVER).

### F3 — mesh output — **full 3D screened Poisson SHIPPED 2026-07-12**
Full 3D screened-Poisson meshing landed instead of the planned 2.5D-DEM shortcut
(reusing the dense PatchMatch plane normals made it tractable in WASM — see
HANDOVER 2026-07-12). Vertex-coloured `THREE.Mesh` in
Viewer3D, PLY + GLB export. **Owed: in-browser verification** (headless can't run
densify→mesh, rendering, restore, or open the exports). *Optional follow-ups (not
required):* orthophoto-textured 2.5D DEM mesh for aerial (cheaper, drapes the true
ortho); meshoptimizer decimation (Phase 6, parked); a UV-textured export.

### F7 — COLMAP model import/export (ecosystem interop) **[new 2026-07-07]**
Read/write COLMAP's sparse-model format (`cameras.txt/images.txt/points3D.txt`
+ the `.bin` variants — well documented, stable). Pure core
(`core/io/colmapModel.js` — R↔quaternion, text serialize/parse, websfm↔ColmapModel
adapters) + a dependency-free `utils/zip.js` **shipped & unit-tested** (2026-07-10).
**Export shipped**: Ribbon *Export ▸ Interop ▸ COLMAP Model* → zipped `.txt`
model (PINHOLE per image, local SfM frame). The 2D observations are exported in
the **BA (pinhole) frame** — the sparse run bakes each view's undistorted /
fiducial-canonical / self-cal-folded pixel into the cloud (`viewsPx`, persisted as
`recon.*.vx/vy.bin`), so distortion / film-scan / self-cal projects export
observations coherent with the exported K/R/t (B2 fix, 2026-07-10). Remaining:
- **Import (text)** — ✅ shipped 2026-07-10 (see HANDOVER): `colmapToSparse` +
  `makeNameResolver` (colmapModel.js), `unzipStore` (zip.js), `isColmapFile`
  sniffing, `useReconstructionStore.importColmapModel`, Ribbon *Import ▸ Interop ▸
  COLMAP Model* + multi-file/zip picker (`useImportRouting.openColmapImport`). Adds a
  new sparse cloud via MC (never replaces). **Browser run still owed** — see below.
- **`.bin` variants** — ✅ shipped (PLAN-import-export Phase 3): LE-binary
  `serializeColmapModelBin`/`parseColmapModelBin` share the ColmapModel struct;
  export modal `bin` format (zipped `.bin`), import routes `.bin` keys through the
  binary parser. Txt↔bin equivalence unit-tested.
- **Browser manual run (owed verification)** — (a) export a real sparse model, open
  the zip in COLMAP / another importer; confirm cameras + points land with low
  reprojection error. Specifically exercise a **film-scan** and a **self-cal** (`f,k1`)
  project now that observations export in the BA frame (B2) — the round-trip the unit
  tests can't cover. (b) **Import** the same zip back (or a COLMAP model from
  elsewhere) into a project with the matching images loaded: confirm the new
  "Imported (COLMAP)" sparse cloud appears alongside the computed one, name-matching
  hits the loaded images, and it can be set main → dense/DEM run off it. Best
  end-to-end check: export→import round-trip lands cameras in ~the same frame.

### F8 — Processing report **[new 2026-07-07]**
Metashape's PDF report is half its survey-market credibility. Generate a
self-contained HTML report (print-to-PDF; no new deps): project summary,
image/sensor table, calibrated intrinsics + distortion, per-camera residual
table, match graph stats, track-length histogram, reprojection stats, georef/
GCP residuals (F2), DEM/ortho previews + GSD, run settings + timings. Most
numbers already exist in run summaries (`reconstruction.json`) and the
per-camera residual table — this is largely presentation. Pure
`core/products/report.js` + an export entry. F13's Evaluate-tab views are the
interactive form of the same data — building them first makes F8 an assembly job.

### F9 — Point-cloud editing + gradual selection **[new 2026-07-07]**
Metashape-parity model cleanup. Two halves:
- **Interactive**: box/lasso select in Viewer3D → delete selected points
  (three.js raycast/frustum selection; store already owns clouds — needs a
  persisted delete mask or filtered rewrite).
- **Gradual selection** (the higher-value, cheaper half): filter sparse points
  by reprojection error / track length / triangulation angle with a live-count
  slider, then delete + re-run BA. The stats all exist in the track filter
  (`core/sfm/sfm.js`); this exposes them as a user-driven post-pass. UI as a
  modal like MatchList.

### F10 — EXIF-GPS pose priors + preselection **[new 2026-07-07; absorbs "P2 remnants"]**
`core/io/metadata.js` already parses `gpsLat/gpsLon/gpsAlt` — nothing consumes
them. Convert to the project CRS at ingest and (a) feed `preselectPairs` when
no poses are imported (drone sets get proximity preselection for free), (b)
offer them as imported-pose seeds for georef (F2's similarity fit works off
them), (c) show on the map like imported poses (visually distinguished).
Pure plumbing; every piece exists.

### F11 — Scale bars / distance constraints **[new 2026-07-07]**
For close-range/object work without GCPs: user marks two image points across
≥2 views (reuse the GCP marking UI), enters a known distance, app scales the
model (and reports residual). Metashape staple; small once F2's
triangulate-marked-points helper exists.

### F12 — SAM2 smart mask selection **[shipped 2026-07-12; see HANDOVER]**
Core (`core/segment/sam2.js` + `workers/ops/segment.js`) and the "Smart Select"
tool in `MaskToolbar.vue`/`ViewerImage.vue` are done — click-to-segment, cyan
preview, Enter/Add to commit, undo. Verified end-to-end on WebGPU encoder + WASM
decoder with onnx-community/sam2-hiera-tiny. Remaining polish (gate on use):
- **Model hosting**: the fp32 encoder is **128 MB** bundled in `public/models/`.
  Consider the quantized (`_q4`/`fp16`) encoder variant, and/or lazy-fetch + OPFS
  cache (reuse the derived-blob pattern) or SP4's custom-upload path instead of
  bundling. If keeping in-repo, Git LFS.
- **Subtract-from-mask commit**: Smart commit is add-only today (Alt-click already
  refines the candidate; a modifier on commit to *subtract* the segment is TODO).
- **WebGPU decoder**: pinned to WASM (per-click ORT WebGPU EP crashes on the
  varying point-count shape); revisit when ORT fixes it — `{ backend:'webgpu' }`.
- Later: "segment everything" grid prompts; batch encode as an Auto-Mask strategy.

### F13 — Evaluate ribbon tab (quality/accuracy views) **[new 2026-07-12]**
The ribbon tab exists (`Ribbon.vue`, between Tools and Export) with disabled
placeholders; each item below wires one up. These are **views over existing
state** (run summaries, `gcpAccuracyReport()`, matches store) — modals/tabs plus
a small pure `core/eval/` module for anything derived, not new pipeline stages.
F8 (processing report) is the exportable form of the same data — build these
views first, then F8 largely assembles them. Ordered by value/effort:
- **eval-gcps — GCP accuracy table** (start here; data function exists):
  per-GCP CRS residual X/Y/Z + per-observation reprojection px, RMSE totals,
  worst-first sort, enable/disable toggles for iterative drop-and-refit.
- **eval-reconstruction — reconstruction report**: registered/total images,
  points, mean+median reprojection, track-length histogram — surfaces what the
  run summary already holds instead of console archaeology.
- **eval-images — per-image diagnostics**: sortable table (reprojection RMS,
  triangulated observations, registration pass, self-cal drift); reuse the
  ImageTableModal pattern. Sorting by RMS names the poisoning images.
- **eval-calibration — calibration check**: BA-refined focal vs EXIF/sensor
  focal per sensor, folded k1 (`summary.selfCalDistortion`) — flags bad sensor
  guesses on film scans.
- **eval-poses — pose residuals**: per-camera distance Horn-fit SfM centre ↔
  imported pose (drift / bad EXIF positions).
- **eval-match-graph — graph health**: connected components, weakly-connected
  images, pairs killed by cycle filter / spread gate — answers "why did only 40
  of 60 register".
- **eval-depth-coverage — dense diagnostics**: per-image % valid depth pixels,
  fusion cull breakdown (already logged under 'Dense'), effective GSD.
- **eval-dem-gcps — DEM vs GCP check**: sample the DEM at each GCP's XY,
  report ΔZ vs surveyed elevation — an *independent* end-to-end accuracy check,
  not a fit residual.

### F6 — Fisheye distortion model
D3's selector covers Pinhole/Radial/Brown — all undistort-to-pinhole-able.
Fisheye (equidistant/equisolid θ-model) isn't: ≥180° FOV has no pinhole
equivalent. Add the θ-model to `distortNormalized`/`undistortNormalized`; for
dense, undistort to a *virtual pinhole with cropped FOV* (COLMAP's approach).
Needs BA self-cal support for fisheye params in `bundle.rs`. Gate on a real
fisheye dataset — irrelevant to the current workflows.

### F5 — Pluggable detector/matcher backend (design umbrella)
SuperPoint+LightGlue shipped as the first learned backend; this remains the
umbrella for later ones (DISK; detector-free RoMa/LoFTR need a
`match(imgA,imgB)` op shape with no per-image keypoint stage). The SfM core is
already neutral (pairs as `{F, matches:[[ia,ib]], inlierCount}`); descriptor
width is now carried, not assumed. Keep verification + the pairs graph as the
neutral meeting point. MAGSAC++ (better verify) is an orthogonal upgrade that
benefits every backend — file under `crates/matching` when picked up.

### CC — Command console, remaining tiers
C1 shipped 2026-07-06. **C2**: `run detect match sparse` chaining, `stats
[matches]`, `set sfm.minPnpInlierRatio 0.5` (echo old→new). **C3**:
`pair disable|enable <A> <B>`, `select <imageName>`, `Cmd/Ctrl-K`
open-and-focus, per-command usage. Owed from C1: manual browser pass; consider
auto-deriving the T1 list from the ribbon table so it can't drift.

### F1 polish — exports **[shipped 2026-07-12 via PLAN-import-export.md]**
Phases 1–6 of `PLAN-import-export.md` shipped (see HANDOVER): LAS 1.2 + XYZ
cloud export with georef/voxel-downsample options; PLY/LAS/XYZ cloud & mesh
**import** (off-thread parse → `importCloud`); COLMAP `.bin` (F7); OBJ/STL mesh
export; nerfstudio/3DGS `transforms.json` export; GeoTIFF DEFLATE, hillshade
PNG, JPEG ortho, real WKT `.prj` (WGS84 geographic + UTM zones, else proj4
fallback). **Still parked**: Bundler/NVM import (Phase 5b, optional — skipped as
time-boxed), LAZ (Phase 7 stretch — needs a WASM codec crate), GeoTIFF tiling
for very large rasters, undistorted-image export (COLMAP `image_undistorter`
parity). **Owed: in-browser verification** — headless can't open the exports;
see the per-phase manual-check list in HANDOVER.

### Products follow-ups
Real-world map-viewer overlay for the ortho; ortho GPU/WASM kernel if per-cell
JS proves slow on large grids; optional manual "Flip Z" for object scenes.

---

## Backlog

**Compute & workers**
- **P4 — GPU matcher (WebGPU).** Descriptor-distance matrix in a compute shader
  (`src/workers/gpu/`, device singleton exists). The real path to
  Metashape-class matching throughput (100×+); largest effort. Revisit only
  after P5–P9 land and are measured; reuse P8's GEMM formulation in WGSL.
- **GPU dense perf** (folded from the 2026-07-07 compute review; only worth it
  when image counts grow — measure before/after): half-grid dispatch for parity
  sweeps (2× occupancy); overlap CPU rasterize/undistort of image i+1 with
  image i's GPU work; on-GPU pyramid (upload levels once, depth upsample as a
  compute pass, read back finest only — changes the per-level backend
  contract); fewer submits via dynamic-offset ctrl uniform.
- **WASM dense perf**: f32 hot loop in `mvs.rs` `plane_cost`/`agg_cost` (GPU
  proves f32 sufficient; keep the JS f64 reference as the precision anchor).
- **Stream partial reconstruction snapshots** from the worker so the 3D viewer
  builds up live (the `emit` channel exists).
- **Surface worker errors in the UI** — currently a per-request reject logs; the
  `onerror` fail-all path isn't user-visible.

**Sparse / SfM**
- **Up-front feature-track builder (union-find), gated on measured need.**
  Track establishment from the full match graph before incremental mapping
  (COLMAP/Theia-style), with conflict splitting (reuse the `mergeSplitTracks`
  guard). websfm already forms tracks implicitly during registration; the win
  is narrow — robust topology independent of registration order + transitive
  2D-3D correspondences rescuing borderline PnP on sequential strips (B1's
  4308 missed R1 by one inlier). Only if a real sequential-strip run shows the
  implicit tracks under-deliver. Pure function in `core/sfm/`.
- **Stage-A geometric consistency term inside PatchMatch** (COLMAP-style
  forward-backward penalty during optimisation, not just A5's post-filter).
  Needs neighbour depth maps resident → interacts with the memory budget;
  design first. Also: per-pixel view-selection weighting (currently per-image
  best-K only).

**Import / formats**
- **Video import** (extract frames at interval/overlap heuristic) — cheap via
  `<video>` + canvas; opens the largest casual-user funnel.
- **16-bit / multi-band TIFF**: `utils/tiff.js` currently transcodes to 8-bit
  PNG for display+detect; scientific film scans may carry 16-bit dynamic
  range. Decide whether detect should read a 16-bit gray path before display
  transcode. Gate on a real dataset that needs it.

**Dense tuning**
- Depth-map modal defaults for large film scans: `maxDim` conservative for
  ~10k-px scans; retune fusion `maxCost` once intrinsics are right.

**Infrastructure / hygiene**
- **I2 — Persistence schema.** `schemaVersion` + migration on load; formalise
  the gcps `normalize()` backfill; `ProjectStore` interface over `opfs.js` so
  storage is mockable; round-trip + migration tests; TS types for on-disk
  shapes.
- **I3 — Bundle code-split.** Lazy-load Three.js/OpenLayers viewers + wasm
  (~1.3 MB main bundle; ORT + models make this more pressing).
- **I4 — TS migration** of `core/` module-by-module (`io/` parsers first).
- **I5 — Test debt**: more CRS cases (UTM south, antimeridian), matching unit
  tests.
- **Deploy story**: the app is dev-server-only today. A static host needs the
  COOP/COEP (credentialless) headers from `vite.config.js` replicated (ORT
  threads), correct wasm/onnx MIME types, and OPFS quota expectations
  documented. Cheap, and it's what makes "similar to COLMAP" shareable.

---

## Parked / rejected
- **wasm threads (rayon + SharedArrayBuffer) for matching** — rejected
  2026-07-04: the pair-level worker pool already saturates cores. (Note ORT
  wasm threads *are* enabled via the COOP/COEP headers — that's a different,
  already-landed mechanism.)
- **Global undo/redo command layer** — rejected. Per-entity delete/edit in the
  stores is enough (Metashape has none either).
- **Full 3D meshing (Poisson/Delaunay)** — **SHIPPED 2026-07-12** (screened
  Poisson, `crates/mesh` + `core/products/mesh.js`; see F3 above / HANDOVER).
- **Vocabulary-tree / global-descriptor image retrieval** — the scale-up path
  for candidate-pair selection with no poses/GPS. The shipped subset gate (P7,
  `core/features/subsetGate.js`) covers the same need at <100s–low-100s images
  without shipping/training a vocab tree, but still *tests* every pair (O(N²)
  pairs, cheap each). A retrieval stage (compact per-image global descriptor —
  BoW/VLAD/aggregated SIFT — + kNN to propose candidates) drops the O(N²) pair
  count itself; revisit at 1000+ image scale where the gate's per-pair floor
  starts to dominate. (Q ▸ P5(1) proposes a lighter build-now variant — aggregated
  existing SuperPoint descriptors, no vocab tree — for the no-poses case; adopt
  that there rather than duplicating the design here.)
- **Multi-camera rigs, rolling-shutter model, Metashape-style chunks** — out of
  scope for the target workflows; record demand before designing.
