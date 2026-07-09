# Plan: fix LightGlue freeze + tiled guided matching (full-resolution)

Self-contained execution plan. Read `CLAUDE.md` first (layering, logging style,
defaults conventions). Two parts: **Part A is a bug fix and must land first**
(LightGlue currently wedges the app); **Part B** is the coarse-to-fine tiled
matching feature. Verify per change: `npm test` + `npm run typecheck`; the
runtime behaviour needs a manual browser run (ONNX/worker code doesn't run in
vitest) — say so rather than claiming verification.

---

## Part A — Fix the LightGlue freeze

### Root cause (diagnosed, high confidence)

`useMatchesStore.matchAll` (src/stores/useMatchesStore.js:371-415) dispatches
up to `POOL_SIZE` pairs concurrently (7 on an 8-core machine — hence the user
seeing exactly 7 log lines). But `computeClient.matchLightGlue`
(src/workers/computeClient.js:96-101) pins **every** LightGlue call to worker 0
(deliberate — one heavy ORT session). So 7 `matchLightGlue` messages land on
worker 0 at once; its op handler is `async`, so all 7 interleave on the
worker's event loop, all pass the `warmedUp` check (it's only set *after* a run
completes — that's why all 7 log `LightGlue: first match … one-time graph
warm-up…`), and all 7 call `session.run(feeds)` **concurrently on the same ORT
InferenceSession**. onnxruntime-web sessions are not reentrant; concurrent
`run()` on one wasm session deadlocks/corrupts. That is the freeze.

Cancel doesn't help because cancellation is cooperative (`matchAll` merely
stops pulling new pairs, src/stores/useMatchesStore.js:404-415) and the 7
in-flight worker promises never settle, so `Promise.all(drains)` awaits
forever. `terminatePool()` exists in computeClient.js but has **zero callers**.

### A1. Serialize LightGlue runs (the actual fix)

Two layers, do both:

1. **Store level** — in `matchAll`, drop to serial dispatch for LightGlue:
   ```js
   const concurrency = settings.matcher === 'lightglue'
     ? 1 : Math.max(1, Math.min(POOL_SIZE, pairs.length))
   ```
   Rationale comment: LightGlue is pinned to worker 0 and the ORT session is
   not reentrant; parallel drain loops would just queue (or wedge) there, and
   serial dispatch keeps the progress bar honest. (Brute-force keeps the pool.)

2. **Module level (defense in depth)** — in `core/features/lightglue.js`, add a
   module-scoped promise-chain mutex so *any* future caller is safe:
   ```js
   let runChain = Promise.resolve()
   function serialized(fn) {
     const p = runChain.then(fn, fn)
     runChain = p.catch(() => {})
     return p
   }
   ```
   Wrap the body of `matchLightGlue` from session resolution through
   `session.run` (feeds construction can stay outside). Keep the GPU-fallback
   logic inside the serialized section so a fallback re-run can't interleave
   with the next pair either.

### A2. Fix the "first match" / warm-up logging

With A1 the 7× duplicate mostly disappears, but make it correct anyway: mark
`warmedUp.add(modelKey)` (or an equivalent `firstStarted` set) when the first
run **starts**, not when it finishes, so queued pairs never claim to be first.
Keep the completion log (`first match … → N correspondences in X ms`) keyed off
the same flag captured before the run. Also log, once per run at 'info', an
expectation-setter before the first CPU run: matching `N×M` on single-thread
wasm can take tens of seconds per pair (the interval watchdog can't fire while
wasm blocks the worker loop — the existing comment at lightglue.js:148-151
explains why); per-pair duration should be logged at 'debug' for **every**
pair, not just the first, so a slow-but-alive run is distinguishable from a
hang in the console.

### A3. Make cancel actually cancel

Wire the matching cancel path to `terminatePool()`: when `shouldCancel()`
flips while worker calls are in flight, the drains stop pulling but in-flight
promises may never settle (a wedged or long-blocking wasm run). Approach:

- In `usePipeline`'s cancel handler for the match stage (see
  src/composables/usePipeline.js), after setting the abort flag, call
  `terminatePool('cancelled by user')` from computeClient. `terminatePool`
  already rejects all pending promises and respawns the pool lazily.
- `matchPair` must catch a rejected worker call, mark the pair entry
  `status: 'error'` (or reset to idle), log at 'warn', and return instead of
  throwing out of `matchAll`.
- Note the cost: terminating worker 0 drops the cached ORT session (~45 MB
  model reload on next run). Acceptable for an explicit user cancel; log it.

### A4. Verify the fix

With 3+ SuperPoint-detected images and matcher=LightGlue (CPU): expect exactly
one "first match … warm-up" line, then one per-pair debug timing line each,
serial progress 1/N → N/N, no freeze; cancel mid-run returns the UI to idle
within ~a second. Then repeat with "Use GPU" checked on a Chromium+adapter
machine (warm-up timeout/fallback path must still work — it's inside the
mutex now). This is browser-manual verification; state it explicitly.

### A5. If a single pair still hangs

If after A1 the *first* pair alone never completes on CPU, the concurrency
diagnosis is incomplete — measure: try `lgMaxKeypoints: 512` (should complete
in a few seconds). If 512 works and 2048 "hangs", it's just single-threaded
wasm slowness (2048² attention × 9 layers) — check `crossOriginIsolated` is
true in the worker (vite.config.js sends COOP/COEP; ~3× from threads) and
report timings rather than guessing further.

---

## Part B — Tiled guided matching (match at full keypoint density)

### Why (context for the executor)

LightGlue's attention is O(N²) in keypoints — that's what `lgMaxKeypoints`
(default 2048, `defaults.user.js`) protects: 8k keypoints ≈ 16× the compute and
memory of 2k, on a wasm heap. But tiled *detection* (core/features/tiling.js)
deliberately produces 10–20k keypoints per image; capping to the strongest 2048
throws most of them away and biases coverage toward high-contrast regions.

The feature: **coarse-to-fine guided matching**. Match a capped subset first →
fit a homography H (A→B) on the verified coarse matches → tile image A → map
each tile through H (+ a parallax margin) into image B → run LightGlue
tile-vs-region at full local density → merge. Every tile-pair stays under the
attention budget, so the pair is matched at full resolution in bounded memory.

**Honest expectations** (relay to the user): this helps *match count and
spatial uniformity* — more verified inliers, more even coverage → better
F/E estimates, longer tracks, better-conditioned BA. It does NOT create
keypoints; it only pays off where detection produced ≫ `lgMaxKeypoints`
(i.e. large images with tiled detection). Total per-pair time grows roughly
linearly with total keypoints (T tiles × bounded cost each) — recommend the
GPU backend when tiled mode is on. The homography guide assumes a roughly
planar scene or modest relief (fine for aerial/nadir imagery — this repo's
primary case); strong 3D scenes are handled by the margin + a fallback (B3.3).

### B1. Pure math module: `src/core/features/guidedTiles.js`

Pure (no Vue/ORT/DOM — unit-testable in Node), mirroring `tiling.js` style:

- `estimateHomographyRansac(ptsA, ptsB, { threshPx = 3, iters = 500 })` →
  `{ H, inlierMask, inlierCount, p95ErrPx } | null`. 4-point DLT (normalize
  coords Hartley-style, solve via SVD or the direct 8×8 linear system) + RANSAC
  + final DLT refit on inliers; residual = symmetric transfer error or plain
  forward reprojection px. `null` if degenerate/< 4 points. (The existing
  H-RANSAC lives inside the wasm crate `verify_matches_hf` and only returns a
  count, not H — do NOT touch the crate; a small JS DLT is enough here, it only
  guides tiling.)
- `planGuidedTiles({ wA, hA, wB, hB, H, tileSize, marginPx })` → array of
  `{ tileA: {x,y,w,h}, regionB: {x,y,w,h} }`. Reuse `planTiles(wA, hA,
  tileSize, overlap)` (import from `./tiling.js`; small overlap ~32 px so
  seam keypoints appear in a tile). Map each tileA's 4 corners through H,
  bbox them, expand by `marginPx`, clamp to B; drop tiles whose region is
  empty after clamping (no overlap → nothing to match).
- `kptIndicesInRect(kps, rect)` → `number[]` (indices, preserving the
  score-sorted order so a per-tile cap still keeps the strongest).
- `dedupeGuidedMatches(matches)` — tiles overlap, so the same (ia,ib) can
  appear twice, and one ia can match different ib in different tiles: keep
  highest `score` per `ia`, then per `ib` (mutual uniqueness, matching
  LightGlue's own one-to-one output convention).
- `marginFromResiduals(p95ErrPx, { min = 32, k = 3 })` → margin px — derive
  the parallax allowance from how well H actually fits, not a blind constant.

Tests (`guidedTiles.test.js`): synthetic H + outliers recovered by RANSAC
(compare reprojection, not H entries — H is scale-ambiguous); tile projection
with identity/translation/scale H; clamping at borders; dedupe keeps best
score; rect assignment.

### B2. Orchestration: worker-side, in `core/features/lightglue.js`

Add `matchLightGlueTiled(args)` next to `matchLightGlue` (same file — it
reuses the session machinery; keep the math imports from `guidedTiles.js`).
It runs **inside the existing single `matchLightGlue` worker op** so one pair
= one postMessage round-trip; add an `emit`-driven progress log per few tiles.

Refactor first: extract the feeds-build + run + parse of the current
`matchLightGlue` into an internal `runPair(session, backend, {kps/desc/dims
subsets})` helper so both entry points share it (the GPU-fallback wrapper
stays around `runPair`). The public `matchLightGlue` keeps its exact
signature/behaviour.

Algorithm of `matchLightGlueTiled`:

1. **Coarse pass**: `runPair` on the strongest `lgCoarseKeypoints` (default
   1024) per image — same prefix trick as today. Filter by `minConf`.
2. **Guard**: if coarse matches < `lgGuideMinMatches` (default 24) → log why
   and return the plain capped `matchLightGlue` result (fallback, not failure).
3. **Fit**: `estimateHomographyRansac` on the coarse matches. If null,
   `inlierCount < 15`, or inlier ratio < 0.3 → same fallback (scene too 3D /
   too little overlap for a useful guide; the plain path still works).
4. **Plan**: `marginPx = marginFromResiduals(p95)`; pick `tileSize` from
   keypoint density so an average tile holds ≤ `lgTileBudget` (default 2048)
   keypoints: `tileSize = clamp(sqrt(lgTileBudget / (nA / (wA*hA))), 512, 4096)`,
   then `planGuidedTiles`.
5. **Per tile**: gather `kptIndicesInRect` for tileA and regionB; skip tiles
   with < `lgTileMinKps` (default 32) on either side; cap each side to
   `lgTileBudget` (score order); slice descriptors
   (`descA.subarray` won't work for arbitrary index sets — gather rows into a
   fresh Float32Array, like `sliceDescriptorRows` in
   `core/features/subsetGate.js`; reuse that helper if importable, else
   mirror it); `runPair`; **remap** returned tile-local indices through the
   index arrays back to full-array indices.
6. **Merge**: concat all tile matches + the coarse pass's H-inliers, then
   `dedupeGuidedMatches`. Return `{ matches }` — identical shape to
   `matchLightGlue`, so downstream (verifyMatches F-RANSAC, inlierSpread,
   ratio gates in the store) is untouched.

Serialization: the whole tiled run goes through the Part-A mutex (it's all
inside one worker op on worker 0, so this is automatic — just don't spawn
anything round-robin from here).

Logging (CLAUDE.md heavy-logging style, one auditable line per derived value):
coarse `n×n → m matches, k H-inliers (ratio r), p95 err e px`; `margin M px,
tileSize T → K tiles (J skipped empty/thin)`; per-tile at 'debug'
(`tile i/K: a×b kps → c matches`); final `tiled match: X raw → Y after dedupe
(coarse-only would have been Z)`.

### B3. Wiring: op → client → store → modal

- `workers/ops/match.js`: route the existing `matchLightGlue` op to
  `matchLightGlueTiled` when `args.tiled` is set (one op name, one pinned
  worker — no new client function needed beyond passing the flag).
- `useMatchesStore.matchPair`: pass `tiled: settings.lgTiled`,
  `coarseKeypoints: settings.lgCoarseKeypoints`, `tileBudget:
  settings.lgTileBudget` into the `matchLightGlue` call args.
- **Defaults, per the CLAUDE.md convention** — user-tunable in
  `core/defaults.user.js`: `lgTiled: false`, `lgTileBudget: 2048` (reuse the
  existing `lgMaxKeypoints` meaning for the non-tiled cap; don't merge the two
  knobs). Internal in `core/tuning.js` (MATCH_TUNING): `lgCoarseKeypoints:
  1024`, `lgGuideMinMatches: 24`, `lgGuideMinInliers: 15`,
  `lgGuideMinInlierRatio: 0.3`, `lgTileMinKps: 32`, with rationale comments.
- `MatchFeaturesModal.vue`: when matcher = LightGlue, a checkbox
  "Tiled guided matching (full resolution)" bound to `lgTiled`, with a hint
  line ("matches all keypoints in homography-guided tiles; slower — best with
  GPU + tiled detection"). Prefill from `MATCH_DEFAULTS` like the other knobs.

### B4. Validation (manual browser run — report, don't assert)

On a benchmark pair (aerial strip, tiled detection ≥ 8k kps/image):
1. Baseline: LightGlue capped 2048 → record verified inliers + rough spatial
   coverage (the store logs inlier counts; eyeball the match preview overlay).
2. Tiled on: expect a multiple more verified inliers and visibly uniform
   coverage; F-RANSAC inlier *ratio* should stay comparable (if ratio drops
   hard, tiles are producing junk — check margin and per-tile min).
3. Fallback: a non-overlapping pair must cleanly fall back / get rejected by
   the normal gates, not error.
4. **Track-length histogram**: run sparse SfM on ≥3 images and compare the
   `track lengths — N ×2-view, N ×3-view, N ×4+-view` log line (sfm.js) vs the
   capped baseline. Tracks chain on keypoint identity `(image, kpt index)`;
   capping to the strongest 2048 per pair means pairs (A,B) and (B,C) often
   match different subsets of B's keypoints, breaking chains. Full-density
   tiled matching should raise the ≥3-view share — this, not raw pair inlier
   count, is the number that predicts SfM quality. (The index remap in B2.5
   and one-to-one dedupe in B1 are what make chaining work — an executor must
   not "simplify" either away.)
5. Record before/after in `HANDOVER.md` per repo convention.

### Execution order

A1 → A2 → A3 (commit: freeze fix) → A4 manual check → B1 (+tests) → B2 → B3 →
B4. Part B only makes sense once Part A is confirmed (tiled mode multiplies
`session.run` calls — it would multiply the freeze too). When shipped: delete
this file, TODO.md entry out, one done-log line into HANDOVER.md, fold the
"ORT sessions are not reentrant — LightGlue runs are mutexed + dispatched
serially" lesson into CLAUDE.md's gotchas.
