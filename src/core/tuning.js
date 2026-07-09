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
  minPnpInlierRatio: 0.15,   // …and a fraction of the correspondences
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
}

// Dense MVS knobs read in core/dense/mvs.js but NOT exposed in DepthMapsModal /
// DenseModal — the user-facing dense defaults live in defaults.user.js
// (DEPTHMAP_DEFAULTS / DENSE_FUSE_DEFAULTS). `settings`/`opts` from the caller override.
export const DENSE_TUNING = {
  coarseLong: 600,    // longest-side px at the coarsest pyramid level (sets level count)
  minAngleDeg: 3,     // source-view triangulation angle floor (too small = degenerate)
  maxAngleDeg: 60,    // …and ceiling (too wide = poor photo-consistency)
  consistencyPx: 2,   // fusion reprojection agreement threshold (px)
}
