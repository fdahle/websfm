# PLAN — SfM workflow improvements (quality / speed / memory / usability)

Audit of 2026-07-12, written to be executed by another model. Read CLAUDE.md
first (layering, invariants, verification rules). Per repo convention TODO.md is
the single plan — when starting a track from here, **move its items into TODO.md**
(Now/Next as appropriate) and delete them here; when a track ships, add a
HANDOVER.md done-log line and delete this file's section.

**Ground rules for the executor**
- `src/core/**` stays pure (no Vue/Pinia/OPFS/DOM). Side effects via `onLog`/`onProgress`.
- User-tunable defaults live in `src/core/defaults.user.js`; dev knobs in
  `src/core/tuning.js`. Never hardcode a knob in two places.
- Per change: `npm test` + `npm run typecheck`. `crates/` change → `npm run
  build:wasm` + commit `src/wasm/*`. Browser-runtime work (modals, OPFS, GPU)
  cannot be verified headless — say so explicitly, list what the manual run must check.
- Every auto-derived value gets an `onLog` line the user can audit (house style).

---

## Executive summary of the audit

- **(a) Quality** — the big wins are already diagnosed and tracked in TODO ▸ Now ▸ Q
  (k2 self-cal, bilateral ZNCC, geometric-consistency dense filter) and Now ▸ R
  (validate the registration-robustness work on B1). Nothing structurally new
  found; §A below is an execution order plus two small additions.
- **(b) Speed** — matching dominates wall-clock (37 min / 50 imgs, target <8).
  TODO ▸ Q ▸ P5 and Next ▸ P5–P9 cover it. §B is ordering + measurement discipline.
- **(c) Memory** — the dense OOM was just fixed (HANDOVER 2026-07-12); the
  remaining structural item is TODO ▸ Next ▸ P3 (quantize + OPFS-spill depth
  maps). §C adds one new item: hardware-aware budgets.
- **(d) Usability** — **the real gap.** There is no "just works" path: no
  dataset-derived settings (detection `maxDim` is a flat 1200 whether the image
  is 2k phone photo or a 10k film scan; `maxKeypoints` flat 5000 whether 5 or
  500 images), no one-click run-all, no post-run verdict telling the user
  whether the result is good and what to do next. §U below is the new track and
  the bulk of this plan.

---

## §U — Usability track: "it just works" (NEW — highest priority of this plan)

Goal: a first-time user drops images, clicks one button, gets a defensible
result — while every derived setting is logged and overridable (Metashape
model: autos are good, experts can still turn knobs).

### U1 — Dataset profiler (pure core module) — foundation, do first
New `src/core/profile.js` (pure; unit-test alongside):
`profileDataset({ images, sensors, poses, gcps }) → profile`.
Inputs are plain metadata the stores already hold (no pixel reads): image count,
native dimensions, sensor kind (`film` vs EXIF vs unknown), focal/pitch
presence, EXIF GPS presence (`core/io/metadata.js` already parses
`gpsLat/gpsLon/gpsAlt`), imported poses presence, filename sequentiality
(natural-sort names with a single running numeric component ⇒ likely strip/video).
Output shape (add to `src/core/types.ts`):
```
{
  nImages, minDim, maxDim, medianMP,
  kind: 'film' | 'drone' | 'phone' | 'unknown',     // from sensors + EXIF
  hasGps, hasPoses, hasCalibratedDistortion, sequentialNames,
  scale: 'tiny' | 'small' | 'medium' | 'large',      // <10 / <50 / <200 / ≥200
}
```
Every classification decision gets a one-line rationale string in
`profile.notes[]` so the caller can log them. Acceptance: unit tests covering
film-scan set, EXIF drone set, no-metadata set, sequential-name detection.

### U2 — Recommended-settings derivation
New `src/core/recommend.js` (pure): `recommendSettings(profile, budget) →
{ detect, match, sfm, depthmap, fuse }` — one object per stage, same shapes as
the `defaults.user.js` constants, derived not fixed:
- **Detect**: `maxDim = clamp(round(0.5 · nativeMaxDim), 1200, 3200)` for
  film/large frames (a 10k-px scan at 1200 throws away the survey signal;
  cap keeps SIFT tractable), else keep 1200. `maxKeypoints` scaled by expected
  overlap: small sets need more per-image support (e.g. 8000 at <10 images,
  5000 default, 3000 at ≥200). Recommend `tiling:'on'` when
  `maxDim · aspect > DETECT_TUNING.spMaxUntiledInputPx`-equivalent or native
  side > 6000.
- **Match**: pick strategy — poses ⇒ `maxNeighbors` preselect; GPS-only ⇒
  depends on TODO ▸ F10 (note the dependency, fall through until it lands);
  `sequentialNames && !gps` ⇒ recommend sequential ±3 window **plus** the subset
  gate for loop closure; else exhaustive + subset gate. Scale `maxNeighbors`
  with `nImages`.
- **SfM**: `refineIntrinsics:'auto'` already resolves correctly — pass through.
- **Dense**: quality preset from image count × MP × memory budget (see C1);
  `maxSources` down at large N.
Everything returns `{ value, reason }` pairs or a parallel `reasons` map so the
UI can show *why*. Unit-test the derivations against the two benchmark profiles
(B0 film strip, B1 building set) with expected outputs pinned.

### U3 — Wire recommendations into the modals ("Auto (recommended)" prefill)
Each stage modal (DetectFeaturesModal, MatchFeaturesModal, ReconstructModal,
DepthMapsModal, DenseModal) gets a small "Recommended for this dataset" banner:
shows the derived values that differ from the static defaults, one click applies
them, hover/expand shows the `reason` strings. Static `defaults.user.js` stays
the fallback when no images are loaded. Keep the existing manual knobs
untouched — autos are a prefill, never a hidden override. (Store marshals the
profile inputs as plain objects if any of this crosses to the worker — it
shouldn't need to; recommendation runs on the main thread on metadata only.)

### U4 — One-click pipeline ("Run All")
- New `RunPipelineModal.vue`: stage checkboxes (Detect → Match → Sparse →
  Depth maps → Dense → DEM → Ortho, later stages default off past Sparse for
  first-run safety), one Low/Medium/High quality selector that maps onto the U2
  recommendations, and the pre-flight checklist from U5.
- Chaining lives in `composables/usePipeline.js`: add `runAll(stages, settings)`
  that awaits the existing `runDetect/runMatch/runReconstruct/…` in order,
  aborting the chain on cancel or stage failure (reuse the existing `aborted`
  flag; each stage already owns its progress modal — retitle to
  "Step 2/5 — Matching…").
- Stage preconditions already exist implicitly (`kpStatus === 'done'` filters
  etc.) — surface them: if a stage would no-op, log why and continue.
- Ribbon entry (Workflow tab or wherever Reconstruct lives today) + a
  `run all` console command (TODO ▸ CC ▸ C2 wants `run detect match sparse`
  chaining — implement both on the same `runAll`, don't duplicate).
- Acceptance: on a fresh project, one click yields sparse cloud + logged
  auto-settings; Cancel mid-chain stops cleanly at the current stage boundary;
  re-running skips already-done detection unless `overwrite`.

### U5 — Pre-flight checks (before Run All / each heavy stage)
Pure `core/preflight.js` returning `[{ level:'ok'|'warn'|'block', msg, fix }]`:
- No sensor / no focal ⇒ warn "focal will be guessed + self-calibrated".
- Film sensor without fiducials marked ⇒ warn (points at F4 workflow).
- Dense: memory projection (reuse `projectDensifyPeakBytes` /
  `memBudget.js`) + GPU-adapter presence when `useGpu`.
- < 2 images, images without keypoints, all pairs disabled, etc. ⇒ block.
Render as a checklist in RunPipelineModal; `block` disables Run.

### U6 — Post-run verdict ("did it work?")
After sparse completes, the run summary already carries the numbers
(cameras registered, median/p95 reproj, track-length histogram, ≥3-view share).
Add a pure `core/sfm/verdict.js` mapping summary → traffic-light verdict +
next-step suggestions, e.g.:
- registered < 80% of images ⇒ list the unregistered images + "check overlap /
  lower minMatches / mark GCPs";
- p95 reproj > 3× median ⇒ "suspect distortion — enable f,k1 self-cal / check
  sensor pitch" (the B0/B1 fingerprints in HANDOVER §Baselines are the
  calibration data for these rules — encode those thresholds, cite them in
  comments);
- ≥3-view share < 20% ⇒ "weakly constrained — add overlap / try tiled matching".
Show as a compact card in the run-complete state (toast/modal footer) with a
"details" link to the log. This is the cheap 20% of TODO ▸ F8 (processing
report) — keep the rule engine pure so F8 can reuse it verbatim.

**Order within §U:** U1 → U2 (+C1 budget input) → U4 → U5 → U3 → U6.
U1/U2/U5/U6 are pure + unit-testable; U3/U4 need a browser-manual pass (say so).

---

## §A — Quality track (mostly: execute existing TODO items, in this order)

1. **Verification runs first** (TODO ▸ Now ▸ R and the Q re-runs). Everything
   below is gated on knowing where B1/B2 actually stand after the shipped
   fixes. Record deltas in HANDOVER §Baselines. *(Browser-manual; a model in
   this environment can only prepare, not perform.)*
2. **P0.2 — k2 self-calibration** (TODO ▸ Q). Only if the B1 re-run still shows
   corner residual after k1.
3. **P2.2 — bilateral-weighted ZNCC** (TODO ▸ Q). All three kernels in
   lockstep (`mvs.rs` / `patchmatch.wgsl` / `planeCost.js`) + A/B RMS < 5e-3.
4. **A5 — per-depth-map geometric consistency filter** (TODO ▸ Next). Also fix
   the `depth 0.00` degenerate-plane export noted there (clamp at source).
5. **F10 — EXIF-GPS priors** (TODO ▸ Later). Quality *and* speed (preselection);
   also feeds U2's match-strategy pick.
6. *(new, small)* **Adaptive bridge-pair gate**: B1 showed the flat
   `minInlierRatio 0.25` rejecting genuine loop-closing bridge pairs
   (27 inliers @ 0.23). `MATCH_TUNING.overrideInliers` (30) nearly covers it —
   evaluate lowering `overrideInliers` to ~25 **or** an explicit
   "bridge exception" (ratio ≥ 0.2 AND inliers ≥ 25 AND passes spread gate).
   Decide from the B1 re-run logs, not a priori; one knob, one test.

## §B — Speed track (execute existing TODO items; measure before/after each)

Wall-clock discipline: record matching + detection + sparse + dense timings in
HANDOVER §Baselines before starting and after each item.

1. **P5 (Next) — parallelize `detectAll`** — trivial, ~POOL_SIZE× on detection;
   respect the SP3 NN-concurrency cap for SuperPoint.
2. **Q ▸ P5 — matching speed bundle** (retrieval preselection without poses,
   don't-escalate-hopeless-pairs in `matchLightGlueTiled`, demote per-tile
   logs). Resolve the SP3-vs-P5(3) parallel-LightGlue conflict by measuring GPU
   utilisation first, as TODO says.
3. **P9 — fused match+verify op + worker-side descriptor cache** — kills the
   ~6 GB structured-clone traffic; biggest architectural speed item left.
4. **P4 (Backlog) — WebGPU matcher** — only after 1–3 land and are measured.

## §C — Memory track

1. *(new)* **C1 — hardware-aware budget module.** `src/core/memBudget.js` (or a
   sibling) gains `deviceBudget()` reading `navigator.deviceMemory` and
   `performance.memory?.jsHeapSizeLimit` (main thread — pass the result *into*
   core/worker as a plain number; core stays pure). Use it to (a) seed the
   dense `memBudgetBytes` gate instead of a fixed default, (b) feed U2's dense
   quality recommendation, (c) warn in U5 pre-flight on low-memory devices.
   Log the detected budget + source. Unit-test the derivation with injected
   values; the navigator read itself is a thin untested shim.
2. **P3 (Next) — quantize + OPFS-spill depth maps** — the structural item;
   also makes depth maps survive reload. Follow the TODO entry's gotchas
   (transfer-list detach, Safari validation).
3. **SP3 — NN session concurrency/memory cap** — 45 MB × POOL_SIZE sessions is
   the other real consumer; resolve together with Q ▸ P5(3).

---

## Suggested overall execution order for the executing model

1. §U U1 + U2 + C1 (pure modules + tests — no browser needed, high leverage).
2. §U U4 + U5 (Run All + pre-flight; browser-manual pass owed, list it).
3. §B 1 (detectAll parallelism — trivial win).
4. §U U3 + U6.
5. §A/§B/§C items in their listed orders — but note items marked
   *browser-manual verification first* are gated on runs only the user can do;
   prepare the code, state plainly what remains unverified.
