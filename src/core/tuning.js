// Internal tuning knobs — the developer control panel. These are NOT exposed in any
// modal; the user never sees them. Collected here so they can be swept during
// development without hunting through the pipeline code (the rationale comments moved
// here with the numbers — this is the one place to read/change them).
//
// The rule (see CLAUDE.md ▸ Conventions): a knob that a modal exposes belongs in
// `defaults.user.js`, never here. A knob owned by a self-contained pure sub-module
// (e.g. `core/sfm/cycleFilter.js` cycle thresholds, `core/sfm/initPair.js` seed
// thresholds) stays co-located with that module's algorithm + rationale — see the
// pointer notes below rather than duplicating those values here.
//
// Pure data module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged.

// Tie-point detection — SuperPoint safety ceiling. Read by core/features/superpoint.js
// (backstop error on OrtRun) AND DetectFeaturesModal.vue (pre-flight tiling prompt), so
// the two agree on one number. SuperPoint is fully convolutional: ONNX Runtime builds
// intermediate tensors at the full network-input size, and past ~this many pixels a
// single untiled pass overflows ORT's int32 shape math (SafeIntOnOverflow) — OrtRun
// fails outright with "Integer overflow". Tiling keeps each pass small and sidesteps it.
// Conservative: a 5000×4735 (23.7 MP) input was the observed failure; ≈4000×4000 leaves
// margin, and the worker's rethrow is the true backstop if a larger input slips past.
export const DETECT_TUNING = {
  spMaxUntiledInputPx: 16_000_000, // ≈4000×4000; above this (tiling off) → prompt / clean fail
}

// Sparse SfM knobs read directly in core/sfm/sfm.js (PnP registration + interleaved
// bundle-adjustment / track filtering). `settings` from the caller still overrides.
// NOT here (owned by their modules): init-pair thresholds → core/sfm/initPair.js;
// rotation-cycle-filter thresholds → core/sfm/cycleFilter.js.
export const SFM_TUNING = {
  // ── Interleaved bundle-adjustment / track filtering ──
  filterMaxReprojPx: 4.0,    // observation pruning threshold (px)
  filterMinTriAngleDeg: 1.5, // drop points whose rays are too parallel
  interimBaEvery: 5,         // run a global BA after this many newly-registered cameras
  interimBaIterations: 12,   // fewer iters for the interim solves than the final BA
  // ── PnP registration gate ──
  pnpGateScale: 2,           // fixed inlier gate = reprjThreshold × min(pnpGateScale, 2)
  minPnpInliers: 15,         // absolute PnP-inlier floor to accept a pose
  // …and a fraction of the correspondences. Raised 0.15 → 0.3: on the 2026-07-10
  // building run every mis-registration was admitted in the 10–25% band. With
  // self-calibration on by default (refineIntrinsics 'auto' → 'f,k1'), true poses
  // clear 0.3 comfortably; the band below it is where coincidence fits live.
  minPnpInlierRatio: 0.3,
  // Second acceptance gate: after the pose is polished, recount inliers at the
  // (tighter) reprjThreshold rather than the looser PnP gate and require the ratio
  // again — a pose that only fits at the loose gate is deferred (P4.3).
  minPnpRefineInlierRatio: 0.3,
  // ── Stalled-strip rescue (S1) ──
  // When a full sweep registers nothing but images still link to the model, the
  // usual causes on short film strips are (a) a ~10% wrong focal the post-filter
  // self-cal hasn't corrected yet and (b) strip-end structure gaps. One rescue
  // round runs a focal-only BA + a retriangulation, then retries the stalled
  // images ONCE with a relaxed refine-recheck (at the PnP gate, ratio below). The
  // absolute minPnpInliers floor + gate-1 still apply, and the final BA + track
  // filter clean any loose observations, so this only rescues genuinely-linked
  // end images, never manufactures a pose. Set false to restore the strict sweep.
  rescueStalled: true,
  rescueRefineRatio: 0.2,    // relaxed refine-recheck ratio used on the rescue retry
}

// Tie-point matching knobs read in useMatchesStore but NOT exposed in
// MatchFeaturesModal — the user-facing match defaults live in defaults.user.js ▸
// MATCH_DEFAULTS. `settings` from the caller still overrides.
export const MATCH_TUNING = {
  lgMinConf: 0,            // LightGlue min match confidence
  overrideInliers: 30,     // inlier count that overrides a failed ratio/H-F gate
  hfDegenerateRatio: 0.8,  // homography-vs-fundamental ratio flagging a degenerate fit
  minInlierUniqueFrac: 0.5, // reject a pair whose inliers collapse to few unique locations
  minInlierSpreadPx: 8,    // …or into a pinhead region (epipole degeneracy), in px
  // ── Tiled guided matching (core/features/guidedTiles.js, gated by lgTiled) ──
  lgCoarseKeypoints: 1024,   // per-image cap for the coarse pass that fits the guide H
  // The coarse pass doubles as the LightGlue pair GATE (the brute-force subset gate
  // is skipped for LightGlue): a near-empty coarse result on 1024×1024 strong
  // keypoints means the pair doesn't overlap, so it's returned as-is (~0.3 s, the
  // store's minMatches then skips it) instead of escalating to the plain capped
  // match — the single most expensive path — just to confirm the non-overlap.
  lgCoarseGateMin: 8,        // coarse matches below this ⇒ no overlap, skip (don't fall back)
  lgGuideMinMatches: 24,     // min coarse matches before attempting a homography guide
  lgGuideMinInliers: 15,     // min H-inliers for the guide to be trusted (else fall back)
  // The guide H only needs to predict *where a tile lands* (locality), not fit the
  // scene tightly — the residual-derived margin absorbs looseness by design. So the
  // guide RANSAC threshold scales with image size (a fixed ~3 px on a 10k-px aerial
  // frame with terrain relief rejects nearly every real pair: the 2026-07-10 CA…V
  // run fell back on 9/10 pairs at ratio 0.04–0.21 while F-RANSAC showed 0.5–0.84
  // inlier ratios), and the inlier-fraction gate is correspondingly permissive.
  lgGuideRelThresh: 0.001,   // guide-H RANSAC threshold as a fraction of image diagonal (≥3 px)
  lgGuideMinInlierRatio: 0.15, // min H-inlier fraction (scene too 3D / no overlap ⇒ fall back)
  lgTileMinKps: 32,          // skip a tile with fewer keypoints than this on either side
}

// Dense MVS knobs read in core/dense/mvs.js but NOT exposed in DepthMapsModal /
// DenseModal — the user-facing dense defaults live in defaults.user.js
// (DEPTHMAP_DEFAULTS / DENSE_FUSE_DEFAULTS). `settings`/`opts` from the caller override.
export const DENSE_TUNING = {
  coarseLong: 600,    // longest-side px at the coarsest pyramid level (sets level count)
  minAngleDeg: 3,     // source-view triangulation angle floor (too small = degenerate)
  maxAngleDeg: 60,    // …and ceiling (too wide = poor photo-consistency)
  consistencyPx: 2,   // fusion reprojection agreement threshold (px)
  // ── Stage B streaming fusion (core/dense/mvs.js fuseDepthMaps) ──
  // Fusion accumulates kept pixels directly into a voxel-merge structure (never a
  // raw per-pixel point list — that was the OOM). The scene bbox that sizes the
  // packed cell keys is estimated from a coarse pixel grid: every Nth row/col of
  // each depth map (~few k unprojections/map, negligible vs the full fuse).
  fuseBboxStride: 16,     // coarse-grid stride for the scene-bbox estimate
  fuseProgressMs: 250,    // min ms between fusion progress emits (~4/s; no postMessage spam)
  fuseCostMaxSamples: 2_000_000, // cost-histogram sample budget (stride-subsampled, sorted once)
  fuseMaxCells: 2 ** 50,  // packed-key exactness ceiling (float64); clamp cellSize up past this
}

// Mesh (screened Poisson) internals read in core/products/mesh.js but NOT exposed in
// MeshModal — the user-facing knobs (depth/screening/trimFactor/colorize) live in
// defaults.user.js (MESH_DEFAULTS). `settings` from the caller override.
export const MESH_TUNING = {
  colorSearchRadius: 1,        // vertex-colour transfer: search ±N voxel cells (3³ nhood)
  grayFallback: [180, 180, 180], // colour for a vertex with no dense point nearby
}
