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
(F8), point-cloud editing/gradual selection (F9), scale bars (F11), fisheye
(F6). The biggest
*credibility* gap is not a feature: it's that the R-track robustness work is
still unvalidated on real data (Now ▸ R).

---

## Now

### DR — Data-relative defaults: partly verified (shipped 2026-07-25)
Pixel gates are denominated in **detection** pixels and resolved per run
(`core/scaleContext.js`); the subset gate's sample size scales with the keypoint
counts (`resolveSubsetGateSize`); detection `maxDim` can scale with each image
(`core/features/detectResolution.js`, opt-in). See HANDOVER 2026-07-25.

**Verified in the browser 2026-07-25:**
- ~~CA…V~~ **passed, strongly.** 10137px native at maxDim 4000 → scale 0.395, factor
  ×2.53; gates resolved RANSAC 2→5.06px, PnP/BA 3→7.60px, filter 4→10.14px. Result
  **5/5 cameras, 3720 points, 0.72px median**, then a 4.5M-point dense cloud —
  against a 45-point, all-2-view baseline. Confounded by masks + the Detailed
  detection preset in the same run, so the gate change is not isolated, but the
  direction is unambiguous.
- ~~SB as the scale control~~ **passed.** 3072px native at maxDim 4000 → scale 1,
  factor 1, and **no "Reprojection gates" line was emitted at all** — the plumbing
  correctly does nothing on a full-resolution set. PnP gates stayed 8.0px.

**Still owed — a like-for-like SB run.** The 2026-07-25 SB run reached 65/128, but
it is not comparable to the 122/128 baseline: it used the Detailed detection preset
(4000px / 25000 kp / contrast 0.005) instead of medium, and **sequential** matching
(1280 pairs) instead of exhaustive, after the 8128-pair exhaustive run was cancelled.
It was graph-limited (2 components, largest 85/128; 101 images with 0 correspondences
to the registered set), not gate-limited.
- Re-run SB at **medium detection + exhaustive matching** — the baseline's own
  settings — to get a real control. Change one variable at a time after that.
- That run also exposed the sequential/subset-gate bug now fixed (see below); re-run
  the **sequential** variant too and confirm the 542 gated pairs are gone and the
  graph is one component.
- **Then** re-run CA…V with `maxDimMode: auto` and compare against its absolute run.
- Not done, deliberately: `maxNeighbors` / `sequentialOverlap` are **not** scaled with
  image count — they encode capture overlap, not set size (see the Backlog note).

### SB — South Building completeness + dense backend follow-up (2026-07-21)
The 128-image medium baseline produced an accurate primary model (86 cameras,
13,942 sparse points, 0.53px median reprojection) and a good 5.96M-point dense
cloud, but exposed two distinct gaps. The diagnostic/performance batch shipped:
gross-track cleanup now precedes final global BA (the baseline previously wasted two
rejected solves on a 180px residual tail); WebGPU error-scope failures retain the
device-loss reason before run-wide WASM fallback; geometric-filter logs use image
names and flag <1%-survival marginal maps; and the sparse summary persists coherent
unregistered components rather than mislabelling them as isolated weak images.
- ~~Re-run South Building medium~~ **done 2026-07-22 — see HANDOVER §B4.** BA commits
  without the 4.03→4.21px rejections; 122/128 cams, 20,953 pts, 0.52/2.05px.
- ~~Fix init-pair selection~~ **done 2026-07-22 — parallax is a gate, and graph degree now
  outranks point count** (`initPair.js`; see HANDOVER done-log + METHODS §4.2). The gate
  alone regressed SB to 86/128, so connectivity gained an above-median reward
  (`initConnCeil`) and point count went to `√`. The first browser acceptance run still
  started from a 4-camera seed and recovered to 86/128 only after retry: the desired seed
  was ninth (outside the 8-pair probe), and degree 20/22 both saturated. The selector now
  probes 24 and directly rewards PnP-ready third views with shared seed tracks.
  A follow-up reached **123/128**, but via retry 1: the stalled first seed had 20 ready
  views and the successful seed had 23, which exposed over-compression in the initial
  logarithmic growth term. Growth is now proportional. **One final browser run is owed; it is the
  acceptance test:** re-run SB medium/SIFT and confirm the seed picked on the *first*
  attempt is the high-degree pair (P1180215↔P1180321 / P1180320↔P1180213 shape — check the
  logged `score (parallax ×p, connectivity ×c)` line names it), no `retrying with alternate
  seed` line appears, fx settles at ~2566 from the first interim BA, and ≥122/128 cameras
  register. Also re-run the **50-image building set (B1)**, which currently reaches 17/50
  and is graph-limited, not seed-limited (median 6 pairs/image, 33 images with zero
  correspondences to the registered set) — confirm the seed change leaves it no worse, then
  treat B1 as a *matching* problem, not an init-pair one. If a barely-passing ~2.5° seed
  does win badly anywhere, the E-conditioning σ2/σ1 term (already computed + logged per
  candidate) is the fix, with that run as its evidence.
- **Re-run with WebGPU enabled**. If it still drops at the first 768×576 six-source
  map, record the new device-loss reason; fix the browser/device-specific cause rather
  than weakening the CPU fallback. Target: all 86 maps remain on GPU.
- **Verify the shipped secondary-model recovery + merge.** Each viable unregistered
  component now reconstructs with a primary-camera overlap halo; ≥3 shared cameras must
  pass position/rotation/focal/radial/leave-one-out-scale gates before its new cameras
  and component-observed points merge. Failed alignment appears as a separate sparse
  cloud. Record recovered cameras and alignment diagnostics. Do not lower the global
  30% PnP gate to force the P1180182 near-miss (38/140 at 4px) into the primary model.
- ~~Verify alternate-seed regression guard.~~ **done 2026-07-22 — validated**: the
  guard turned a 19-camera primary into 122 (retry 2 of 4), clearing the ≥86 bar.
  Note what it does *not* do — it is a safety net that runs after a bad seed has
  already burned a full reconstruction, and the run's own metrics never flagged the
  19-camera model as wrong (median 1.28px on 1360 surviving points).

### FDR — fiducial split: browser verification owed (shipped 2026-07-20)
The code-side rework is complete: **Detect Fiducials** finds anonymous corner/side
structures without metric calibration or a prepared reference. **Calibrate
Fiducials** is an independent command for certificate mapping or batch layout
estimation. Persistence migration and sparse/dense reconstruction use the new
joined model. Owed: exercise Generic, Right angle, 45° and Frame modes on
representative real scans; review tolerance/drafts and generated frame masks; then
validate certificate and batch RMS. Acceptance record:
`PLAN-fiducial-detection-calibration.md`.

### RR — Reference rasters: raw storage + COG + draw-time styling (2026-07-20)
Re-architecture, **not** a fix: the imported-raster path stores a *baked* plane (RGBA
for orthos), so styling is a ~10 s re-decode of the original, the ortho bake has no
reader (`readWindow` has no consumers; `sampleAt` is null for orthos), and raw values —
needed for automatic GCP finding against satellite imagery — are unrecoverable.
Target: originals + COG as the source of truth, style as pure view state applied at
draw time on the GPU (`ol/source/GeoTIFF` + `ol/layer/WebGLTile`, both already in
OL 10.9), fast-first import with background conversion. **No back-compat / no
migration** — re-import is expected. Full spec: `plan-reference-raster-rearchitecture.md`.
- **Start with Phase 0 spikes.** 0a (EPSG:3031 under WebGLTileLayer) is the assumption
  phases 3–5 rest on; 0d replaces every timing estimate in the plan with measurements.
  Do not start Phase 1 before they answer.
- Supersedes §A of `plan-external-reference-data.md` (storage + display); that file's
  §B taxonomy shipped and is unaffected.
- Deletes the 2026-07-20 restyle work (`styleStamp`/`planeStyleStamp`/`redecodePlane`/
  `restyleRasterPreview` + the `previewUrl` layer-rebuild fix) — correct for the
  architecture they patched, dead weight in this one.
- **Unexplained, chase if it recurs:** `Reference rasters restored:` logged ~7× at ~21 ms
  intervals on 2026-07-20. `restore()` has one caller (`openProject`) and no watcher;
  suspected Vite HMR re-running restore per hot update, not reproduced cold.

### QH — Quality Report hub: browser verification owed (shipped 2026-07-17)
**All of `plan-eval-quality-hub.md` (WS0–WS6) shipped** — see HANDOVER 2026-07-17
done-log. The eight isolated Evaluate modals are folded into one `QualityReportModal`
(Overview landing page + section nav: Matching / Sparse / Calibration / Accuracy /
Coverage / Dense), backed by pure `core/eval/{health,coverage,compareRuns}.js` +
`core/products/report.js` (all unit-tested), the residual overlay in the image view
(WS3), the coverage density canvas (WS4), run comparison (WS5, `summaryHistory` in
`reconstruction.json`), and HTML report export (WS6 = F8). `npm test`/`typecheck`/
`vite build` green. **Owed — headless can't drive any of it:**
- Open the hub from each ribbon entry; confirm the Overview health list computes,
  greyed nav entries match missing prerequisites, and clicking a health row jumps to
  its section. Toggle a GCP in Accuracy → the overview RMSE + tiles refit (healthDirty).
- Residual overlay: enable the ribbon **Residuals** toggle (or click a Sparse-section
  image row) → vectors draw on a registered image, ×25 legend shows, radial-vs-coherent
  pattern is legible; the toggle persists across a reload.
- Coverage canvas renders top-down with camera dots; the run-comparison strip shows
  deltas after a second reconstruct; **Export report** downloads a self-contained HTML
  that opens/prints cleanly. Delete `plan-eval-quality-hub.md` once verified.

### DF — Dense sky/vegetation freckles: verify + follow-ups (2026-07-17)
**Stage A′ shipped** (`filterDepthMapsGeometric`, see HANDOVER done-log + METHODS §7):
COLMAP's `filter` pass — forward–backward reprojection per pixel + an absolute NCC
floor — running once after the Stage A loop and zeroing pixels in the maps themselves.
Unit-tested (order-independence, flyer rejection, single-map guard); **unmeasured on
real data** — headless cannot run dense. Plan doc: `plan-dense-sky-vegetation.md`
(delete once this closes).
- **Baseline it** on a sky-heavy and a vegetation-heavy set; record in HANDOVER
  §Baselines: dense point count (and count inside a hand-boxed sky region → target
  ~0), the new `Depth filter:` cull percentages, Stage A′ wall clock (it is O(maps²·px)
  worst case — if it is not negligible beside PatchMatch, restrict the source loop to
  each map's own `selectSourceViews` neighbours rather than all maps), and an ortho
  visual check over vegetation (the ortho reuses the now-filtered planes).
- **Retune the defaults from that data.** `maxGeomCost 1.0` / `minConsistent 2` /
  `minNcc 0.1` are COLMAP's numbers, adopted untested at our working resolutions.
  Watch for over-culling on legitimately weak-texture surfaces (snow/ice — the polar
  case is exactly where a photometric floor is most likely to be wrong).
- **Then consider a Metashape-style mild/moderate/aggressive preset** over these three,
  once real numbers say what the useful range is. Do not invent the deltas first.
- **Deferred: COLMAP's second `geom_consistency` optimisation pass.** Re-runs PatchMatch
  with the fwd-bwd error in the cost, so hypotheses are pulled toward the consistent
  solution instead of only being rejected. Buys **completeness** on weak texture, not
  precision (the filter already got that). ~2× Stage A, touches all three kernels
  (`mvs.rs` / `patchmatch.wgsl` / `planeCost.js`) under the lockstep + A/B RMS < 5e-3
  invariant, and needs `memBudget.js` to learn a Stage A peak (it models only fusion).
  Only worth it if the baseline shows holes, not freckles.
- **Not doing: automatic sky segmentation.** A blue/brightness prior is unsafe in
  Antarctica (snow vs sky). Manual masking already works and is what Metashape users do;
  if this ever resurfaces, it is a SAM2-seeded feature, not a heuristic.

### RS — 2-camera registration stall: re-baseline (2026-07-16)
**WS-A + WS-C shipped** (see HANDOVER 2026-07-16 done-log): the stalled-model rescue
now fires at the 2-camera seed (`register.js`), post-filter self-cal is skipped below
3 cameras, and an explicit film format outranks the scan pixel pitch in `resolveK`.
Diagnosis + the four stall baselines live in `plan-registration-stall.md` (delete it
once this item closes). The fix is **unproven on real data** — headless cannot run it,
and the synthetic scene would not reproduce the stall (a noise-free co-visible rig
absorbs even k1 = −0.35), so `register.test.js` pins the *guard*, not the recovery.
Owed, ideally folded into the V ▸ verification session:
- **Re-run all four baselines** — building×{SIFT, SP+LightGlue}, TMA×{SIFT,
  SP+LightGlue} — and record in HANDOVER §Baselines. Targets: building+LightGlue
  ≥45/50 cams and post-BA median ≲1px (from 2/50); building+SIFT materially >2 cams
  (its 166-pair graph is sparse — report, don't force); TMA+LightGlue still 5/5, fusion
  kept-fraction no worse. Watch for the `registration stalled at 2 camera(s)` line.
- **WS-B — earlier f,k1 self-cal, *only if* WS-A alone doesn't register the building
  set.** Make `distortionRefine`/`rescueRefine` (`register.js`) obs-aware instead of
  camera-count-only: engage f,k1 at `cameras.size >= 4 && totalObservations >= ~2000`
  (new knob next to `distortionCalMinCams` in `tuning.js`, with rationale). Never below
  3 cameras — a 2–3-view k1 fit is noise (the D3 comment's warning).
- **Second rescue, only if the logs show it.** `rescued` is one-shot: if the relaxed
  sweep admits a few cameras and stalls again *before* the distortion fold at 6 cams,
  allow one more rescue after the first fold ("folded since last rescue", max 2 total).
  Do NOT make rescue unbounded.
- **Rotation-cycle filter — decide its fate.** It has never engaged on any baseline,
  and now for both possible reasons: B0/B1/B3 sit under the 30° ceiling, while B4
  (South Building) skipped at **42.3° median cycle error — above** it. B4 also shows
  why: it runs before self-cal on a focal that is 7.4% wrong, so its rotations are
  garbage exactly when it would have the most to say. Either move it after the first
  distortion fold or remove it; "always skips" is now measured at both ends.

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
  The `sfm.js` K path already supports width-derived focal, and as of 2026-07-16 an
  explicit format **outranks** the pitch in `resolveK`, so the warning's advice ("use
  the film/sensor-format field instead of pixel size") is now literally actionable —
  this item is just the UI half.
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

### EX — External reference data (DEM / ortho) — spec: `plan-external-reference-data.md`
Import georeferenced rasters you did **not** produce, and use them as ground
truth. The immediate driver: map-placed GCPs have no elevation source.

#### Automatic GCP finding from orthophotos — UI mockup shipped, matcher owed

The Tools ▸ Georeferencing ▸ **Find GCPs** dialog now defines the intended inputs:
the project's relative/local orthophoto and an imported georeferenced reference
orthophoto. Its run action is deliberately disabled until the matching pipeline is
implemented. Build a coarse-to-fine, rotation/scale-tolerant image registration that:

- detects and matches stable features between the relative and reference orthos;
- robustly estimates the 2D mapping and rejects spatially clustered/ambiguous matches;
- converts accepted reference pixels to project-CRS X/Y, obtains Z from a declared
  reference DEM (never silently invents Z=0), and traces relative-ortho pixels back to
  observations in original registered images;
- creates **candidate** GCPs for user review rather than silently accepting them as
  control, with residual, confidence and coverage diagnostics;
- hands reviewed points to the existing **Georeference** workflow (GCP-anchored sparse
  adjustment followed by the final SfM→CRS similarity fit).

This depends on raw/readable reference-ortho pixels from RR above; the currently baked
RGBA source has no window reader suitable for feature matching.

**Workstream B + phases A-1…A-3 shipped 2026-07-18** (see HANDOVER) — sidebar
provenance split, `rasterKind.js`/`rasterSample.js`/`rasterSource.js`, the
`parseRaster` op, `useExternalStore`, the georeferenced-TIFF routing fork, the
generalised `ProductViewer` + `raster:` tab, and GCP Fill Z / Check Z.

**Owed: a browser verification run.** Nothing in this feature has been exercised
in a browser — the pure modules have unit tests, but the geotiff decode, the
OPFS index/sidecar round-trip (import → reopen → lazy hydrate → sample), the
routing fork on a real dropped GeoTIFF, the import modal and the raster tab are
all browser-runtime. Do this before building A-4+ on top. Bring a real REMA or
COP30 tile *and* a reference ortho, ideally in a CRS ≠ the project CRS (the
reproject-the-query path is the one most likely to be wrong).

**Remaining phases** (still specced in the plan file): A-4 map-overlay toggle +
per-layer opacity; A-5 picking GCP x/y/z straight off a reference ortho/DEM with
accuracy from GSD — **georeferencing with zero survey data**, often the only
option for historical Antarctic imagery, and the phase that makes the feature
pay for itself; A-6 reference-vs-reconstruction DEM diff as a Quality Report
section (`checkZAgainstReferenceDem` already returns the rows); A-7 COG/remote
rasters (a second `RasterSource` behind the existing boundary); A-8 GeoJSON +
shapefile vector layers. Standing trap to keep in mind: vertical datum
(ellipsoidal vs geoid) differs by tens of metres in Antarctica — the store
carries `verticalDatum`/`verticalAccuracy` and Fill Z refuses without the
latter, but nothing yet *applies* a geoid separation. See also F13.

### GG — Guided GCP marking: follow-ups (shipped + verified 2026-07-16, see HANDOVER)
Guides themselves are in (`core/sfm/gcpGuides.js`), rendering confirmed in-browser.
**Snap-to-guide is rejected, not deferred** — see METHODS.md §6.4 / CLAUDE.md: a
guide is derived from the reconstruction, so snapping would feed the model back in
as ground truth and erase the guide-vs-mark disagreement exactly when the
reconstruction is wrong. The mark stays the user's. Remaining, both optional:
- **Distortion-exact guides.** The guide uses the raw-pixel/pinhole frame
  (METHODS.md §6.4), so on a strongly distorted lens the true epipolar line is a
  slight curve. Sample the pinhole line, push each sample through the composed
  self-cal distortion (+ `canonicalToScan` for film) → draw a polyline. Only worth
  it if the browser pass shows a visible offset on the wide-angle building set.
- **Guides in the GCP inspector tab** (`ViewerGcp.vue`) — it already crops to each
  observation; a predicted-vs-marked delta there would make a bad mark obvious.

### U — "It just works" usability track (audit 2026-07-12)
The real gap vs Metashape/COLMAP is **usability**, not algorithms: there is no
"just works" path — detection `maxDim` is a flat 1200 whether the input is a 2k
phone photo or a 10k film scan, `maxKeypoints` a flat 5000 whether 5 or 500
images; no one-click run-all; no post-run verdict. Metashape model: autos are
good, experts keep every knob. All derived values get an `onLog` line and stay
overridable. **Order: U1 → U2 (+C1) → U4 → U5 → U3 → U6.** U1/U2/U5/U6 are pure
+ unit-testable (no browser); U3/U4 need a browser-manual pass — say so.
- ~~**U1 — Dataset profiler.**~~ **done 2026-07-24** — `src/core/profile.js`
  `profileDataset(...)` + `DatasetProfile` type in `types.ts`, 11 unit tests
  (film/declared-film/drone/phone/no-metadata/sequential/mixed-res/scale cases).
  Now unblocks U2.
- ~~**U2 — Recommended settings.**~~ **done 2026-07-24** — `src/core/recommend.js`
  `recommendSettings(profile, budget) → { detect, match, sfm, depthmap, fuse }`, each
  stage a map of knob→`{value, reason}` (derived knobs only; unlisted keep defaults).
  13 unit tests incl. pinned B0 (aerial film) + B1 (building) profiles. **Refinement
  vs the spec sketch:** sequential *matching* is only recommended on a **large** set —
  contiguous filenames alone don't prove a strip (cameras number every shoot
  sequentially), so a medium set stays exhaustive. Next: **C1** (real device budget for
  the dense pick) then **U3** (banner wiring, browser).
- ~~**C1 — Hardware-aware memory budget.**~~ **done 2026-07-31** —
  `core/dense/memBudget.js` `deviceBudget({deviceMemoryGB, jsHeapLimitBytes})` derives
  `{ budgetBytes, deviceMemoryGB, source, note }` from **injected** readings (core stays
  pure): 50% of `navigator.deviceMemory` clamped [1,6] GB, else 75% of the JS-heap limit,
  else the conservative `DEFAULT_BUDGET_BYTES`. `deviceMemoryGB` passes through for U2's
  dense pick. The main-thread half now lives in `useComputeSettings`: it reads the optional
  browser globals, logs the derivation, seeds both dense-stage pre-flight gates, preserves
  saved manual overrides with an Auto reset, and exposes `recommendForDataset(profile)`.
  6 core unit tests; browser smoke-check the displayed automatic source/value and Auto reset.
- ~~**U3 — "Recommended for this dataset" prefill.**~~ **done 2026-07-31** —
  reactive `useDatasetRecommendations` wires U1→U2→C1 into the pipeline stages, surfaced
  **on the control each recommendation concerns** (recommended preset card / badged card /
  inline field link — see CLAUDE.md), not in a banner. Only derived values differing from
  static defaults appear; reasons stay readable and selecting is normally the only mutation.
  Applying logs every value + rationale. Integration also corrected two stale U2 outputs:
  large-image tiling is `auto` (not the removed `on` mode), and raw EXIF GPS only
  offers position preselection after it becomes usable project-CRS poses. F10 later
  made that pairing choice automatic when at least two positions are available.
  Automated tests/typecheck/build green; browser visual/apply smoke-check remains owed.
- **U4 — One-click "Run All".** New `RunPipelineModal.vue` (stage checkboxes,
  one Low/Med/High selector → U2, U5 checklist) + `runAll(stages, settings)` in
  `composables/usePipeline.js` chaining the existing `runDetect/…` with the
  `aborted` flag; also the `run all` console command (CC ▸ C2 — same `runAll`).
- ~~**U5 — Pre-flight checks.**~~ **done 2026-07-24** — pure `core/preflight.js`
  `preflight(state) → [{level, code, msg, fix}]` + `hasBlockers()`. Blocks: <2 images /
  no keypoints / no matches / all pairs disabled. Warns: missing focal, film-without-
  fiducials, dense projection over budget (`formatBytes`), GPU-requested-but-absent.
  Blocks-first ordering; every check carries `fix`. 12 tests. **Owed (browser):** assemble
  the state snapshot in the store + disable Run when `hasBlockers`.
- ~~**U6 — Post-run verdict.**~~ **done 2026-07-24** — pure `core/sfm/verdict.js`
  `buildVerdict(snapshot) → { level, headline, findings[] }`. Rules: degenerate (red,
  short-circuits), registration<warn/bad, p95≥{3,5}× median ⇒ distortion, high median,
  ≥3-view<20% ⇒ weak-geometry, split graph, focal Δ, **dense depth-coverage** (added
  2026-07-24). Reuses the single `EVAL_THRESHOLDS` table (health.js) — only the
  residual-tail *ratio* is verdict-local. Each finding carries an actionable `fix`. 12
  tests incl. the B1 fingerprints (282px-tail distortion, 9.5% ≥3-view). **Owed
  (browser/store):** wire into a post-run panel + U4 Run-All summary.
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

**P10 — Don't compute descriptors for keypoints the cap throws away.**
`sift_keypoints` computes orientation + the 128-d descriptor inline for *every*
surviving extremum, but `detect_sift` then response-sorts, dedupes, and truncates to
`max_keypoints`. Measured 2026-07-17 (B-detect): **18288 descriptors computed to keep
10000** on a 5000px image — ~45% wasted, and now a tall pole since the pyramid got
6.3× faster. Response (`|contrast|`) is known *before* orientation/descriptor, so the
scan can collect bare `(x, y, scale, response, octave, s)`, sort/dedupe/cap globally,
then describe only survivors. **The catch**: dedup is deliberately cross-octave, so the
cap is global and the survivors' Gaussian levels must still be live when it's known —
octave 0's six levels are ~600 MB at 25 MP, so keeping every pyramid is not an option.
Either re-blur per octave in a second pass (only worth it now that blur is cheap) or
group survivors by octave and describe them octave-by-octave on the way down. Measure
the extrema count on real scans first — the win scales with how hard the cap binds, and
`detect_sift`'s `raw_found` sentinel is post-dedup so it does not currently tell us.

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

### ~~G2 — Glossary entries for the newly load-bearing terms~~ **done 2026-07-24**
Added `src/glossary/algorithms/matching-density.md` (Fast/Full — the LightGlue tiled
vs capped path) and `cycle-consistency.md` (the rotation-cycle match filter);
**self-calibration** already existed (`core-sfm/self-calibration.md`). Also added
`preselection.md` (position/footprint/capture-order pair pruning, the term
`recommend.js`'s strategy pick leans on). All auto-link via title/aliases and cross-link
to existing entries; `glossary.test.js` green (id↔filename, help: ids resolve, no `>` in
TODO(image) comments). Figures still owed (the `<!-- TODO(image) -->` markers).

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
- **Depth-map persistence** (shipped 2026-07-16, browser-only paths unproven):
  Stage A → reopen → Densify loads from disk and fuses to the same cloud;
  Ortho likewise; a sparse re-run discards the saved set (stale stamp); removing
  one image drops only its map; measure the real bytes/image + reload seconds and
  record them as a baseline (the ~50 MB/image figure is projected, not measured).
- **Project save/load + folder-backed projects** (shipped 2026-07-22, browser-only
  paths entirely unproven — OPFS, File System Access and IndexedDB do not exist in
  the test environment). Owed, in Chromium unless noted: save a real project →
  reopen the `.websfm` in a fresh profile → the reconstruction, GCPs and images
  all come back; the "exclude cached & derived data" file still opens and heals
  (transcodes re-run, depth maps absent, products regenerate); drag-and-drop of a
  `.websfm` routes to the project importer while a COLMAP `.zip` still routes to
  the COLMAP importer; the buffered `<a download>` fallback path in **Firefox and
  Safari** (no `showSaveFilePicker`); a project just under the 4 GB pre-flight
  actually produces a readable archive. Folder projects: create in a folder →
  reload → the reconnect prompt appears and Connect works; move the folder on
  disk → "Choose folder…" re-links; "Open project folder…" adopts a project
  copied from another machine; both migration directions verify and leave the
  disk folder in place. Measure export/import throughput on the 128-image set and
  record it as a baseline.
- **Debug ▸ Project Summary** (shipped 2026-07-24, extended 2026-07-25 into the
  **baseline record** — run config + diagnostics + verdict, see HANDOVER; browser-only
  paths still unproven): the ribbon button appears under Other ▸ Debug, opens the modal,
  the Markdown⇄JSON toggle switches the body, Copy writes to the clipboard with the
  toast, and the digest also lands in `log.ndjson` at debug level. **Check on the first
  baseline run** that the new blocks are populated, not blank: Run config (all four
  stages), Seed + attempts, Reprojection gates, Match gates, fx trajectory, cycle
  filter, timings, Stage A backend/throughput/filter. Anything blank means a producer
  isn't recording — fix that rather than the renderer. `matchRun` is session-scoped by
  design, so copy the digest **without reopening the project** after a run.
(The tiling/SuperPoint/LightGlue/TIFF browser runs are under W0/SP5.)

### P3 — OPFS quantize + spill of depth maps
**Persistence shipped 2026-07-16** (unquantized float planes + lazy load; see
HANDOVER). What remains here is the *memory/size* half:
- **Quantize** the planes (depth → Uint16 + per-map min/max, cost → Uint8,
  normals → 3×Int8 — normals are >half the bytes and Poisson won't notice ~0.5°).
  Roughly 4× off the ~50 MB/image at medium quality. Version the sidecars
  (`index.json` has `version: 1`) and keep reading v1 float planes.
- **Spill per image as each completes**, rather than one write after Stage A, so
  peak memory is one map rather than all of them; densify/ortho then read +
  dequantize **in the worker** (core stays pure) and the store cache holds
  metadata instead of float planes — `depthMapsMeta` already models exactly that
  state, so the lazy-load path is the seam to build on.
- Raster cache goes gray-only (+rgb for ref); GPU state packs f16 via
  `pack2x16float` with chunked readback.
Gotchas: transfer lists detach buffers shared with ortho (the densify error path
now recovers by reloading from disk — keep that working); `layout:'auto'` bind
groups + the 64-byte Params uniform in `depthMapGpu.js` move together. Validate
in Safari before calling done.

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

### F7 — SfM interoperability hub — **SHIPPED 2026-08-06**
Complete COLMAP database/workspace import-export plus transforms.json, OpenMVG,
VisualSFM NVM, and OpenSfM import is recorded in HANDOVER. **Owed verification:**
open a real exported database/workspace in COLMAP, run mapper, re-import it, and
exercise a large compressed folder/ZIP in Chromium, Firefox, and Safari. Include a
film-scan and self-calibrated project to verify BA-frame observations end to end.

### F8 — Processing report **[shipped 2026-07-17 via Quality Report hub WS6]**
Self-contained HTML report (print-to-PDF; no new deps) shipped as `core/products/
report.js` (`buildReportHtml`) + the **Export report** button in the Quality Report
hub footer. Assembled by `composables/useQualityReport.js` from the *same* plain
snapshot + pure `core/eval/*` fns the hub renders, so report and hub can't drift:
overview health table + sparse tiles/worst-images + calibration + GCP accuracy.
*Optional follow-ups (gate on use):* DEM/ortho preview images, run settings/timings
strip, inline SVG track-length histogram in the export (the hub shows it live).

### F9 — Point-cloud editing + gradual selection **[new 2026-07-07]**
Metashape-parity model cleanup. The **numeric dense half shipped 2026-07-22**
(Tools ▸ Point Cloud: filter / crop / merge, `core/products/cloudEdit.js` — see
HANDOVER). What remains is the two halves that need *interaction* or touch the
*sparse* model, which the shipped work deliberately excluded:
- **Interactive**: box/lasso select in Viewer3D → delete selected points
  (three.js raycast/frustum selection). Now cheaper than it was: the delete is
  `cropCloud`/`selectPoints` with a caller-supplied mask, so this is a
  selection-UI task plus one core entry point, not a data-model task. Still
  needs the same "new derived cloud vs. persisted delete mask" decision.
- **Gradual selection** (the higher-value, cheaper half): filter **sparse**
  points by reprojection error / track length / triangulation angle with a
  live-count slider, then delete + re-run BA. The stats all exist in the track
  filter (`core/sfm/sfm.js`); this exposes them as a user-driven post-pass. UI
  as a modal like MatchList. Note this is a genuinely different operation from
  the shipped dense filters and must stay separate: a sparse point carries the
  view-tracks dense/ortho/COLMAP-export read, so deleting one has to invalidate
  the depth-map staleness stamp and re-run BA — which is exactly why
  `cloudEdit.js` refuses sparse clouds.

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

### F13 — Reference-DEM-constrained bundle adjustment **[new 2026-07-18]**
Anchor sparse points to an imported reference DEM surface as a weak "the ground
is roughly here" prior — a soft constraint that kills dome/bowl distortion on
long strips **without any GCPs**. `bundle_adjust` already takes
`anchor_flat`/`anchor_weight` on arbitrary point indices (built for F2's GCP
anchoring), so the wiring exists; what's new is the method: per-point targets
are not fixed positions but *projections onto a surface*, so the anchor target
must be recomputed each iteration (point x/y → DEM z) rather than set once, and
the weight has to reflect the DEM's vertical accuracy or it fights the
observations. Requires the external-raster import (see
`plan-external-reference-data.md`) to land first. **Research-grade — METHODS.md
would need a section; do not start on a whim.**

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
fallback). **LAZ, GeoTIFF tiling (COG), undistorted-image export and single-tile
Cesium 3D Tiles shipped 2026-08-07** — see HANDOVER and
`docs/planning/plan-interop-formats.md`. **Still parked**: Bundler/NVM import
(Phase 5b, optional — skipped as time-boxed). **Owed: in-browser + external-
application verification** — headless can't open the exports; see the per-phase
manual-check list in HANDOVER and the per-item checklist in the interop-formats
plan.

### Remaining interoperability (from `docs/planning/plan-interop-formats.md`)
Deliberately not started, with the reasons, so they aren't re-litigated:
- **Mesh texturing** — reframed as a *pipeline* feature, not an export format.
  `meshToObj` already writes per-vertex colour; adding OBJ+MTL is an afternoon,
  but there is **no texture to reference**: no UV atlas, no bake. The real work is
  (1) a UV atlas (xatlas as an isolated WASM crate, same precedent as
  `crates/mesh`), (2) visibility-based view selection + seam blending, reusing the
  depth maps as the z-buffer exactly as `core/products/ortho.js` does. Textured
  OBJ+MTL, textured glTF and a textured 3D Tiles payload all fall out afterwards.
  File under Products when picked up, not Interoperability.
- **3D Tiles LOD** — the shipped exporter writes one tile, which covers "put my
  model on a globe". A quadtree with per-tile decimation needs a mesh simplifier
  websfm does not have. Gate on someone actually streaming a websfm product into
  Cesium and hitting the limit.
- **E57** — declined for now. The container is XML over paged binary sections with
  a CRC-32 per 1024-byte page and bitpacked `CompressedVector` fields: weeks of
  work with no browser-targetable library, and **LAZ now reaches the same
  software** (CloudCompare, QGIS, ArcGIS, Cyclone, Faro). Its distinctive value —
  multi-scan poses and embedded panoramas — is a terrestrial-laser-scanning
  concern, not an aerial one. Revisit only on a request naming the receiving
  application, and **read** support first.
- **Compress imported reference rasters.** Now free: the `planCog`/`assembleCog`
  split means `useExternalStore`'s import path can DEFLATE its tiles too, so a
  large REMA tile stops costing its full uncompressed size in OPFS.

### Products follow-ups
Real-world map-viewer overlay for the ortho; ortho GPU/WASM kernel if per-cell
JS proves slow on large grids; optional manual "Flip Z" for object scenes.

---

## Backlog

**Data-relative defaults — examined and rejected**
- **Do NOT scale `maxNeighbors` / `sequentialOverlap` with image count.** Both were
  candidates in the 2026-07-25 pass and both are wrong to scale: they encode how
  much the *capture* overlaps (an aerial strip at 60/30% overlaps ~8–12 neighbours
  whether the block is 20 images or 500), not how large the set is. Scaling them
  with N would add O(N²) matching cost that buys no new edges. The genuinely
  set-size-dependent decision in that area — "is preselection/the subset gate worth
  its false-negative risk at this pair count?" — is already handled by
  `subsetGateMinPairs` and the `preselectionApplied` veto.
- **Do NOT scale `minMatches` with the keypoint budget.** It looks budget-relative
  but is a *geometric* floor (enough correspondences to constrain F/PnP robustly),
  and raising it on a Detailed run would cut exactly the 15–40-inlier tail that
  carries mean track length (see `minInlierRatio`'s note in defaults.user.js). The
  spurious-match growth that comes with a larger budget is the **inlier ratio**
  gate's job, not the absolute count's.

**Project storage**
- **ZIP64 writer**, to lift the 4 GB `.websfm` ceiling. fflate reads ZIP64 but
  does not write it, so today a too-large project is refused up front
  (`archiveSizeVerdict`) rather than silently corrupted. Wanted only once
  someone actually hits it — the folder backend is the better answer for a
  project that size, and the refusal message says so.
- **Human-friendly filenames in a folder project** (real extensions on image
  blobs, original names). Genuinely nicer on disk, but it forks the layout from
  the OPFS one — and layout identity is what makes the zip export, the migration
  copy and the single restore path all free. Parked deliberately; only revisit
  with a plan for keeping one canonical layout.
- **Two tabs on one folder project can race.** Same pre-existing situation as two
  tabs on one OPFS project; out of scope until either is addressed.

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
- **Match-graph edge rendering at scale** (`components/viewers/MatchGraph.vue`).
  The force-layout freeze is fixed (grid-accelerated repulsion + settle animated
  across RAF frames instead of synchronously — 2026-07-24), but with a huge match
  count the *edge* paths remain O(edges) ≈ O(n²) every frame and can drag the frame
  rate: `draw()` strokes every edge each frame and `edgeAt()` scans them all on every
  mousemove. Also `pairSetKey()` sorts+joins all pair IDs into one big string on each
  deep `matchSummaries` change. Levers when it bites: edge culling / thinning at low
  zoom, and a cheaper topology signature. Not a hard freeze — revisit only if the
  reduced frame rate is actually reported.

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
- **COPC reader for large reference clouds** (LOD, not storage). Decided
  2026-07-22: COPC must **not** become websfm's own cloud format. Its value is
  HTTP-range streaming of a remote octree, which a fully client-side app never
  issues; internally we'd pay laz-perf as a dependency, LASzip compress/
  decompress on every read and write, and int32 coordinate quantization
  (a real precision loss in the polar/survey-CRS case) to buy nothing. The flat
  typed-array sidecars already parse in zero time. Where it *does* pay is as a
  **reader** for imported Reference Data: a dropped 500 MB LAS is already a
  pain point, and an octree with LOD is the correct fix for "view a huge
  external cloud without hydrating it" — the same lazy pattern as
  `ensureRasterLoaded` / `depthMapsMeta`, and the point-cloud analogue of the
  `RasterSource` accessor boundary (`core/io/rasterSource.js`), which exists so
  a lazy source lands as a second implementation rather than a rewrite of every
  call site. So: introduce the equivalent `CloudSource` boundary first, then a
  COPC implementation behind it. LAZ is no longer a blocker for this —
  `crates/lazcodec` + `core/io/laz.js` read and write it as of 2026-08-07, so
  COPC is now only the octree/LOD layer on top. Gate on someone actually hitting
  the wall with a real reference cloud.
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
- **SIFT-GPU (WGSL detection kernel, à la COLMAP's SiftGPU)** — parked
  2026-07-17, revisit only with profiling that puts detection back on top. The
  COLMAP comparison doesn't transfer cleanly: (a) after the pyramid fix detection is
  ~3.1× faster and was already not the dominant stage (TIFF decode and O(N²) matching
  are), (b) WebGPU gives **one** device, so a GPU detector pins to a single worker like
  LightGlue does — versus a CPU pool detecting POOL_SIZE images concurrently, making
  the realistic *throughput* win ~1.5–2×, not the ~10× the per-image latency suggests
  (and roughly a wash on an integrated GPU sharing bandwidth with those cores), (c) the
  WASM path must stay fast regardless as the no-WebGPU fallback, so the CPU work was
  never an alternative, and (d) two backends producing subtly different 128-d
  descriptors feeding a ratio test is a correctness surface pure-CPU doesn't have — a
  per-image GPU→WASM fallback (as dense uses) would be actively wrong here; it'd have
  to be per-run. If detection *does* return to the top, **GPU brute-force matching is
  the better first target**: bigger share of wall-clock, and a far simpler kernel
  (tiled dot-product + ratio test, fixed-size output, no compaction, no sort).
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
