// Internal tuning knobs — the developer control panel. These are NOT exposed in any
// modal; the user never sees them. Collected here so they can be swept during
// development without hunting through the pipeline code (the rationale comments moved
// here with the numbers — this is the one place to read/change them).
//
// The rule (see CLAUDE.md ▸ Conventions): a knob that a modal exposes belongs in
// `defaults.user.js`, never here. A knob owned by a self-contained pure sub-module
// (e.g. `core/sfm/initPair.js` seed thresholds) stays co-located with that module's algorithm + rationale — see the
// pointer notes below rather than duplicating those values here.
//
// Pure data module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged.

// Tie-point detection — SuperPoint safety ceiling. Read by core/features/learnedDetect.js
// (backstop error on OrtRun) AND DetectFeaturesModal.vue (pre-flight tiling prompt), so
// the two agree on one number. SuperPoint is fully convolutional: ONNX Runtime builds
// intermediate tensors at the full network-input size, and past ~this many pixels a
// single untiled pass overflows ORT's int32 shape math (SafeIntOnOverflow) — OrtRun
// fails outright with "Integer overflow". Tiling keeps each pass small and sidesteps it.
// Conservative: a 5000×4735 (23.7 MP) input was the observed failure; ≈4000×4000 leaves
// margin, and the worker's rethrow is the true backstop if a larger input slips past.
export const DETECT_TUNING = {
  // SIFT keypoints per scale-space extremum: the dominant orientation plus secondary
  // histogram peaks within 80 % of it (Lowe 2004 §5; COLMAP max_num_orientations = 2).
  // A feature with two near-equal peaks otherwise gets a different orientation in
  // different images and stops matching — the short-track failure the 2026-10-05 SB
  // runs pointed at (38.7k two-view points with no third correspondence). Siblings
  // count toward maxKeypoints, as in COLMAP. 1 = the pre-2026-10 detector exactly.
  // Default 1, measured: on South Building with identical matching settings, 2 gave
  // 60,480 vs 60,189 >=3-view points (+0.5 %, MAT-08 vs MAT-10) for ~20 % more
  // descriptors to match. Set 2 to reproduce COLMAP's detector.
  siftMaxOrientations: 1,
  // Which SIFT keypoints survive maxKeypoints (core/features/keypointCap.js):
  // 'coarse-first' keeps the largest scales (COLMAP's rule), 'response' the strongest
  // |DoG| (the pre-2026-10 rule). Measured on an 8-image SB strip (node bench, ≥3-image
  // tracks): +1.4 % at 2400 px / 10k, where the cap barely binds, and +10 % at native
  // 3072 px / 10k, where it binds hard. Response-ranked native 10k scored BELOW 2400 px
  // 10k: fine-scale texture filled the budget. It matters most where the cap binds.
  siftCapRule: 'coarse-first',
  spMaxUntiledInputPx: 16_000_000, // ≈4000×4000; above this (tiling off) → prompt / clean fail
  // DISK's U-Net holds 128 float channels at FULL input resolution (SuperPoint
  // downsamples 8× first), i.e. 512 B per input pixel in one tensor, so ORT's int32
  // byte math overflows near 2³¹ / 512 ≈ 4.2 MP. Derived, not yet observed; the
  // worker's overflow rethrow is the backstop either way.
  diskMaxUntiledInputPx: 4_000_000,
  // ALIKED: the same 128 full-resolution channels (its concatenated feature map),
  // so the same derived ceiling.
  alikedMaxUntiledInputPx: 4_000_000,
}

// Sparse SfM knobs read directly in core/sfm/sfm.js (PnP registration + interleaved
// bundle-adjustment / track filtering). `settings` from the caller still overrides.
// NOT here (owned by its module): init-pair thresholds → core/sfm/initPair.js.
export const SFM_TUNING = {
  // ── Bundle-adjustment linear solver (bundle.rs SolverOpts) ──
  // Policy for the reduced camera system of every bundle adjustment. null ⇒ the crate
  // default: PCG from n ≥ 600 (≈ 100 cameras), rel_tol 1e-10, 2,000 iterations, Cholesky
  // fallback at the cap. The policy here is inexact Newton instead: CG to 1e-6, at most
  // 200 iterations, and the capped iterate taken as the step (it still lowers the
  // quadratic model; LM accepts it only if the true cost falls). HANDOVER ▸ B-parity,
  // corrected sweep: SfM −50 % (PUTI), −24 % (quarry), −14 % (South Building) with the
  // same LM solve counts, camera/checkpoint accuracy and point counts — the exact default
  // spent much of its time hitting the 2,000 cap and then paying a dense Cholesky too.
  // Every BA logs what its solves did and the run totals land in summary.baSolver, so a
  // bench compares by overriding keys per run (merged key by key, sfm.js): { pcgMinN: 1e9 }
  // (Cholesky only), { pcgRelTol: 1e-10, pcgMaxIter: 2000, pcgAcceptPartial: false }
  // (the exact solve), { pcgPreconditioner: 'ic0' } (block IC(0), ≤ 12 % in the sweep).
  // functionTolerance: LM stops once an accepted step lowers the robust cost by less than
  // this fraction (Ceres' function_tolerance; 0 ⇒ run to the iteration cap, the old
  // behaviour). St Nazaire SIFT (HANDOVER ▸ B-ba-ftol): BA 608 → 205 s at 1e-6 with the
  // same cameras, points, reprojection and GNSS fit to 4 decimals; 1e-5 saved another
  // 54 s but moved the median reprojection by 0.01 px, so the standard value stays.
  // direct: wherever PCG would run (≥ ~100 cameras), a sparse block Cholesky of the
  // reduced camera system instead (crates/reconstruction sparse_chol.rs): exact steps,
  // where block-Jacobi PCG stalls at its cap on big blocks (1,600 synthetic cameras: 22
  // of 23 solves capped). With exact steps the LM stop is floored at 10⁻⁵ (bundle.rs
  // DIRECT_FUNCTION_TOL; the tail past it changed nothing). plan-sfm-scale ▸ S2, bench
  // 2026-10-16 on identical matches: quarry SfM 259 → 189 s, South Building 85 → 63 s,
  // same cameras, points, final reprojection and RTK camera fit (13.24 / 18.17 vs
  // 18.26 cm); synthetic 1,600 cameras 273 → 218 s. { direct: false } is the PCG path.
  // `threads`: the bundle adjustment's pool size cap (core/sfm/reconstruction.js
  // threadedWasm; one fewer than the machine's cores), 0 = the single-threaded build.
  // The result is the same bits either way. Fixed by the first call in a worker.
  baSolver: {
    pcgMinN: null,
    pcgRelTol: 1e-6,
    pcgMaxIter: 200,
    pcgAcceptPartial: true,
    functionTolerance: 1e-6,
    direct: true,
    threads: 16,
  },
  // ── Interleaved bundle-adjustment / track filtering ──
  // Observation pruning threshold, in **detection pixels** — sfm.js resolves it to
  // native px against the run's detection scale (core/scaleContext.js, which owns
  // the maxFactor/minFactor knobs) before any pass reads it. Bounded separately by
  // core/sfm/cleanupThreshold.js, which caps how much a pass may remove when the
  // residual distribution is shifted by wrong intrinsics — different root cause,
  // and the two compose (the quantile bound applies to the resolved threshold).
  filterMaxReprojPx: 4.0,
  filterMinTriAngleDeg: 1.5, // drop points whose rays are too parallel
  // Final sparse-cloud corroboration gate. Keep 2-view tracks while incremental SfM
  // needs them, then omit them from the delivered model once a sufficiently large
  // multi-view core proves that doing so will not erase a two-camera/tiny dataset.
  finalMinTrackViews: 3,
  finalTrackPruneMinCount: 50,
  finalTrackPruneMinShare: 0.2,
  // …and only where corroborated tracks already cover the image area (a grid of this
  // many cells a side per image; 0 = the old blanket prune). Casa Grande 1978: the
  // blanket prune left a lattice of strips around empty squares (tracks.js).
  finalTrackPruneCoverageGrid: 16,
  // Track completion (tracks.js `completeTracks`, COLMAP's CompleteTracks) after the
  // final BA and before each post-filter pass: verified matches with one endpoint in a
  // point add the other endpoint when it reprojects within the track-filter gate.
  // Rounds repeat until nothing is added (A↔C enables C↔D); 5 is ample — later rounds
  // add almost nothing. On 2026-10-05 SB the final prune still dropped 38,990 two-view
  // points (41 %); completion is the step that turns tracks into ≥3-view ones.
  completeTracksMaxRounds: 5,
  // Projection-guided track extension (guidedExtension.js): after the first
  // self-calibrated post-filter BA, search each point's projection in every registered
  // camera that misses it for a keypoint with a matching descriptor. Ships the
  // descriptors to the SfM worker as uint8 RootSIFT (128 B per keypoint; counted by the
  // sparse memory preflight). Bench (HANDOVER ▸ B-bench): ≥3-view points +5 % SB, +28 %
  // building, +7 % eagle, +5.9 % quarry, median error and RTK accuracy unchanged.
  guidedTrackExtension: true,
  // Search radius = the filter gate capped at this × the model's p90 residual: a coarse
  // detection scale makes the native-px gate far wider than the model resolves (TMA:
  // 16.9 px gate, 1 px median). Capped, SB additions sit at 0.39/0.98 px median/p90 vs
  // the model's 0.31/0.96 (uncapped 0.43/1.42) for −0.6 % points. 0 = gate only.
  guidedRadiusP90Mult: 3,
  // Acceptance: best candidate ≤ this quantile of ≥3-view track descriptor distances and
  // ≤ ratio × the runner-up in the same window (0.95 gave +1 % more on SB, untested
  // elsewhere; 0.9 ratio and running in both passes changed nothing).
  guidedQuantile: 0.9,
  guidedRatio: 0.8,
  interimBaEvery: 5, // run a global BA after this many newly-registered cameras
  // …and only once the model has also grown by this factor since the last one (COLMAP's
  // ba_global_images_ratio is 1.1). Each solve costs the whole model, so every-5 alone
  // is quadratic: quarry (347 images) registration 1,005 → 143 s, SB 106 → 45 s, points
  // and RTK accuracy unchanged (SB −0.4 %). 0 = every interimBaEvery cameras.
  // 2 since 2026-10-11 (HANDOVER ▸ B-parity, interim-BA spacing): against 1.2, SfM −25…33 %
  // on PUTI, quarry, South Building and St Nazaire with every camera kept and camera /
  // checkpoint accuracy unchanged, and the hard sets (building's weak bridge, eagle) lose
  // nothing either. Local BA between the solves bought nothing on top.
  interimBaGrowth: 2,
  interimBaIterations: 12, // fewer iters for the interim solves than the final BA
  // Local BA after each registration (sfm.js runLocalBundleAdjust): the new camera + its
  // localBaWindow − 1 most co-visible cameras free, their neighbours fixed. 0 = off: on six
  // bench sets it only added 5–10 % time at growth 2 (B-parity); kept opt-in for a
  // thousands-of-cameras set, where the gaps between global solves get long.
  localBaWindow: 0,
  localBaIterations: 6,
  // Track storage (core/sfm/trackStore.js): 'typed' is the arena the solver runs on;
  // 'map' is the Map-based reference it is tested against. Same output, bit for bit.
  trackStore: 'typed',
  // Camera-centre priors (imported poses / EXIF GPS) enter one final fixed-K BA.
  // Targets are mapped into the current arbitrary SfM frame by a similarity fit;
  // two rounds let that mapping settle after the first constrained deformation.
  cameraPriorBaRounds: 2,
  cameraPriorBaMinCameras: 3,
  // A position-constrained solution may trade a little image residual for better
  // geometry. Bound that trade so noisy GPS cannot visibly damage tie-point fit.
  cameraPriorMaxReprojIncreasePx: 0.25,
  cameraPriorMaxReprojIncreaseFrac: 0.1,
  // Intrinsics the camera-prior BA refines: 'auto' = the last post-filter pass's
  // self-cal terms, 'none' = fixed K, or a comma list. Fixed K cannot undo a dome caused
  // by slightly wrong f/k (nadir focal–height correlation): RTK benches quarry camera
  // residual 0.43 → 0.20 m, GeoScan checkpoints H 6.1 → 4.4 cm, V 16.4 → 10.8 cm.
  // Loose priors (5 m default, consumer GNSS) carry too little weight to move K.
  cameraPriorRefineIntrinsics: 'auto',
  // Same for the GCP-anchored BA (bundleSession.js), once at least
  // gcpRefineIntrinsicsMinGcps control points qualify: over a nadir block only control
  // at different heights pins the focal (Casa Grande 1978 film, HANDOVER ▸ B-hist).
  gcpRefineIntrinsics: 'auto',
  gcpRefineIntrinsicsMinGcps: 5,
  // ── In-registration distortion self-calibration (D3) ──
  // Once the model has this many cameras, the interim BA refines a shared focal + radial
  // k1 and folds the distortion out of the keypoints (+ Kmap) mid-registration, instead
  // of deferring it to the post-filter passes. A 2-view model hides distortion in its
  // points (init reproj looks perfect, 3rd-view PnP collapses at ~13% inliers), so k1 is
  // only identifiable once several cameras at different angles are in — below this count
  // the interim BA stays pose/points-only and the fold (which mutates keypoints) is held
  // back. Only active when refineIntrinsics self-calibrates (no calibrated model at ingest).
  distortionCalMinCams: 6,
  // Transactional self-cal guard. These are deliberately broad plausibility bounds,
  // not calibration priors: normal EXIF recovery remains free, while the observed
  // thin-block runaways (focal +48…88%, k1 ≈ -0.5) are rejected before their
  // distortion is destructively folded into every image's keypoints.
  selfCalMaxFocalStepFrac: 0.25,
  selfCalMaxFocalNominalFrac: 0.35,
  selfCalMaxPrincipalOffsetFrac: 0.1,
  selfCalMaxCornerShiftFrac: 0.25,
  // The same two focal bounds when the starting focal is only resolveK's default-FOV
  // guess (no EXIF focal, no sensor format). That guess is not evidence: a 153 mm lens
  // on a 230 mm film frame sits 33% below it, and the 25% step bound rejected the focal
  // pre-solve on the CA213732V strip (29.9%), leaving fx at the guess (SFM-12).
  selfCalGuessFocalStepFrac: 0.6,
  selfCalGuessFocalNominalFrac: 0.7,
  // ── PnP registration gate ──
  pnpGateScale: 2, // fixed inlier gate = reprjThreshold × min(pnpGateScale, 2)
  minPnpInliers: 15, // absolute PnP-inlier floor to accept a pose
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
  rescueRefineRatio: 0.2, // relaxed refine-recheck ratio used on the rescue retry
  // ── Secondary-model recovery ──
  secondaryModels: true, // reconstruct coherent blocks stranded outside the primary
  secondaryMinImages: 8, // avoid recursively solving tiny/noisy leftovers
  secondaryBoundaryImages: 12, // registered overlap halo used to align arbitrary frames
  seedRetryMax: 4, // retry alternate initial pairs when the primary stalls tiny
  seedRetryMinFraction: 0.5, // below this registered share, seed choice is still suspect
}

// Tie-point matching knobs read in useMatchesStore but NOT exposed in
// MatchFeaturesModal — the user-facing match defaults live in defaults.user.js ▸
// MATCH_DEFAULTS. `settings` from the caller still overrides.
export const MATCH_TUNING = {
  // WebGPU brute-force: byte budget of the per-run GPU descriptor cache (LRU). 1 GiB
  // holds a whole 128-image SIFT run at ~8.4k kp (≈ 4.3 MB/image); a smaller budget
  // only costs re-uploads (the worker answers a miss and the store resends).
  gpuDescCacheMiB: 1024,
  lgMinConf: 0, // LightGlue min match confidence
  overrideInliers: 30, // inlier count that overrides a failed ratio/H-F gate
  hfDegenerateRatio: 0.8, // homography-vs-fundamental ratio flagging a degenerate fit
  minInlierUniqueFrac: 0.5, // reject a pair whose inliers collapse to few unique locations
  minInlierSpreadPx: 8, // …or into a pinhead region (epipole degeneracy), in px
  // ── Decoupled match-acceptance floors (WS1) ──
  // `minMatches` (defaults.user.js, user-facing) is the ACCEPT floor + the H-skip floor.
  // These two are the other two gates it used to conflate, split out so raising minMatches
  // (e.g. to 500) can never widen the pre-verification kill zone or sever the match graph:
  // filterStationary: a match moving at most this % of the image diagonal between
  // the two images is stationary (1 % = 130 px on a 9139² film scan).
  stationaryTolPct: 1,
  rawSkipFloor: 15, // skip verification below this many RAW putatives (clamped to ≤ minMatches)
  weakMinInliers: 15, // valid-F pairs with ≥ this many inliers but below the accept gate → WEAK
  // (kept for PnP registration only; never seed init or triangulate)
  // ── Tiled guided matching (core/features/guidedTiles.js, gated by lgTiled) ──
  lgCoarseKeypoints: 1024, // per-image cap for the coarse pass that fits the guide H
  // The coarse pass doubles as the LightGlue pair GATE (the brute-force subset gate
  // is skipped for LightGlue): a near-empty coarse result on 1024×1024 strong
  // keypoints means the pair doesn't overlap, so it's returned as-is (~0.3 s, the
  // store's minMatches then skips it) instead of escalating to the plain capped
  // match — the single most expensive path — just to confirm the non-overlap.
  lgCoarseGateMin: 8, // coarse matches below this ⇒ no overlap, skip (don't fall back)
  lgGuideMinMatches: 24, // min coarse matches before attempting a homography guide
  lgGuideMinInliers: 15, // min H-inliers for the guide to be trusted (else fall back)
  // The guide H only needs to predict *where a tile lands* (locality), not fit the
  // scene tightly — the residual-derived margin absorbs looseness by design. So the
  // guide RANSAC threshold scales with image size (a fixed ~3 px on a 10k-px aerial
  // frame with terrain relief rejects nearly every real pair: the 2026-07-10 CA…V
  // run fell back on 9/10 pairs at ratio 0.04–0.21 while F-RANSAC showed 0.5–0.84
  // inlier ratios), and the inlier-fraction gate is correspondingly permissive.
  lgGuideRelThresh: 0.001, // guide-H RANSAC threshold as a fraction of image diagonal (≥3 px)
  lgGuideMinInlierRatio: 0.15, // min H-inlier fraction (scene too 3D / no overlap ⇒ fall back)
  lgTileMinKps: 32, // skip a tile with fewer keypoints than this on either side
  // ── Subset gate applicability ──
  // The gate trades a small false-negative rate for skipping O(Na·Nb) matches, which is
  // only a good trade when there are many pairs to skip. Below this count the full
  // exhaustive match costs seconds, so the trade is all risk and no saving — and the
  // risk is severing the graph (the 2026-07-24 CA…V run: 7/10 pairs gated, including
  // the consecutive 33↔34, splitting 5 images into 2 components and registering 3).
  // The gate's *sample size* is not here: it is derived per pair from the real
  // keypoint counts by core/features/subsetGate.js resolveSubsetGateSize (which
  // owns the fraction/floor/ceiling), because a fixed sample makes the gate ~1/N
  // more severe as keypoint counts rise. The CA…V gating above is consistent with
  // that failure mode as well as with the low pair count.
  subsetGateMinPairs: 50,
  // Gate rescue (useMatchesStore.matchAll): images left with fewer than this many
  // accepted pairs re-test their gated pairs on a subsetGateRescueScale× larger subset
  // (scale² more expected putatives). 0 = off. Iceland 1980 film: 7 images stranded.
  subsetGateRescueDegree: 6,
  subsetGateRescueScale: 4,
  // Bridge repair (MATCH_DEFAULTS.repairSplits; core/features/bridgeRepair.js): a match
  // graph left in pieces of at least bridgeMinComponent images gets up to
  // bridgePerComponent pairs per piece (bridgeMaxPairs in all) between it and the main
  // block matched again, without the subset gate and with these looser gates. F-RANSAC
  // still verifies every pair; LightGlue gets bridgeLgKeypointScale× the keypoints.
  // Pairs rejected with at least bridgeRetryMinRaw putatives are tried first.
  bridgeRounds: 3, // again while the main block grows, each round with fresh pairs
  bridgeMinComponent: 2,
  bridgeMaxPairs: 48,
  bridgePerComponent: 12,
  bridgeRetryMinRaw: 8,
  bridgeRatioThreshold: 0.9,
  bridgeMinInlierRatio: 0.08,
  bridgeVerifier: 'magsac',
  bridgeLgKeypointScale: 2,
}

// Dense MVS knobs read in core/dense/mvs.js but NOT exposed in DepthMapsModal /
// DenseModal — the user-facing dense defaults live in defaults.user.js
// (DEPTHMAP_DEFAULTS / DENSE_FUSE_DEFAULTS). `settings`/`opts` from the caller override.
export const DENSE_TUNING = {
  coarseLong: 600, // longest-side px at the coarsest pyramid level (sets level count)
  minAngleDeg: 3, // source-view triangulation angle floor (too small = degenerate)
  maxAngleDeg: 60, // …and ceiling (too wide = poor photo-consistency)
  consistencyPx: 2, // fusion reprojection agreement threshold (px)
  // Stage A progress split (workers/ops/dense.js): the cross-view filter's expected
  // cost per depth-map pixel, weighed against the measured per-image loop time to give
  // the filter its share of the bar. 0.3–0.5 µs/px measured on synthetic 1.25 MP nadir
  // sets of 24–60 maps (Node/V8, dev machine, 2026-10-07); it rises slowly with map
  // count and sky share. The run logs the measured value — retune from those.
  geomFilterUsPerPx: 0.4,
  // The cross-view filter checks each reference against at most this many overlapping
  // views, nearest cameras first (0 = all). Every candidate plane is resident while a
  // reference is judged, and a pixel that fails is tested against all of them: with
  // ~50 overlapping views a map on a 58-scan film block at High, that was 5.4 GB per
  // worker and 25 min on the one worker it allowed.
  filterMaxViews: 12,
  // Fusion's consistency check, likewise (core/dense/fusionPlan.js fusionViews): at most
  // this many overlapping views per map, those with enough parallax first (0 = all).
  fuseMaxViews: 12,
  // ── Stage B streaming fusion (core/dense/mvs.js fuseDepthMaps) ──
  // Fusion accumulates kept pixels directly into a voxel-merge structure (never a
  // raw per-pixel point list — that was the OOM). The scene bbox that sizes the
  // packed cell keys is estimated from a coarse pixel grid: every Nth row/col of
  // each depth map (~few k unprojections/map, negligible vs the full fuse).
  fuseBboxStride: 16, // coarse-grid stride for the scene-bbox estimate
  fuseProgressMs: 250, // min ms between fusion progress emits (~4/s; no postMessage spam)
  fuseCostMaxSamples: 2_000_000, // cost-histogram sample budget (stride-subsampled, sorted once)
  fuseMaxCells: 2 ** 50, // packed-key exactness ceiling (float64); clamp cellSize up past this
  // Measured pre-flight (fusionCellEstimateSteps): distinct merge cells counted by hash
  // sampling. The cap bounds the tracked set (~1/√cap ≈ 0.4% relative error once the
  // scene exceeds it); the margin covers that error so the accumulator presized from
  // the estimate rarely has to grow.
  fuseEstimateSampleCap: 65536,
  fuseEstimateMargin: 1.05,
  // Over budget at the requested sample step: re-plan at 2× (then 4×) the step before
  // refusing (fusionPlan.js). 1 = never coarsen.
  fuseAutoStepMax: 4,
  // Workers fusion splits over (store densifyParallel). 1 = one worker: fusion is bound by
  // plane reads, and 8 workers on quarry took 630 s vs 557 s (plan 262 s of re-reads +
  // slabs contending for OPFS). Kept for machines / storage where that turns around.
  fuseWorkers: 1,
  // ── Post-fusion isolated-cell removal (WS4, gated by removeIsolated) ──
  // Only low-support cells are tested (a ≥3-pixel cell is never a floater), so this stays
  // O(noise tail). A tested cell survives if ≥ isolatedMinNeighbors of its 26 (radius 1)
  // neighbour cells are occupied; otherwise it's a lone flyer (sky/vegetation) and dropped.
  isolatedRadius: 1, // neighbour search radius in cells (26-neighbourhood)
  isolatedMinNeighbors: 2, // min occupied neighbours to keep a low-support cell
  isolatedMaxSupport: 2, // only cells with ≤ this many contributing pixels are tested
  // The depth-map preview (the image viewer's overlay, stretched to the image) is
  // rendered at most this many pixels on its long side: a full 27 MP PNG per map was
  // seconds of encode each for a picture nobody sees at that size.
  depthPreviewMaxDim: 2048,
  // A worker streaming depth maps waits while more than this many of its maps are not
  // saved yet (each is ~23 B/px held on the page until its write lands).
  depthMapsUnsaved: 2,
}

// Mesh (screened Poisson) internals read in core/products/mesh.js but NOT exposed in
// MeshModal — the user-facing knobs (depth/screening/trim/fillHoles/removeFloaters/
// colorize) live in defaults.user.js (MESH_DEFAULTS). `settings` from the caller override.
export const MESH_TUNING = {
  colorSearchRadius: 1, // vertex-colour transfer: search ±N voxel cells (3³ nhood)
  grayFallback: [180, 180, 180], // colour for a vertex with no dense point nearby
  // Poisson input downsample. A depth-D octree can't resolve detail finer than one leaf
  // cell (extent / 2^D), so feeding it a much denser cloud is wasted work — octree build,
  // matrix assembly and the CG solve all scale ~linearly with point count. Voxel-subsample
  // the input to ≈ this many leaf cells per point before the solve (1 ⇒ ~one point per leaf
  // cell). Colour transfer still uses the FULL dense cloud, so quality is unaffected. The
  // subsample only kicks in when it would actually thin the cloud (input denser than a leaf
  // cell); a sparse cloud passes through untouched. Each kept sample carries how many raw
  // points it stands for — the support weight the trim and the floater filter read.
  inputLeafCellsPerPoint: 1,
  // Support-density trim: drop surface whose support is below this fraction of the median
  // sample's (crates/mesh `density_ratio`). 0.1 removes the fixture's speck shells and the
  // bridged cap of a sphere while keeping an open rim (≈ ½ median); 0.3 also eats thinly
  // observed surface. A ratio, so it means the same at every scale.
  trimRatio: { off: 0, gentle: 0.1, strong: 0.3 },
  // Hole refill: a trimmed region that is closed and no larger than this fraction of the
  // kept piece around it is a hole the solve bridged and goes back in. Relative to the
  // bordering piece, never the whole mesh (crates/mesh `refill_holes`).
  holeAreaRatio: 0.05,
  // Robust extent. The octree spans the input's bounding box, so a few stragglers far from
  // the object coarsen every leaf. Points outside the [lo, hi] per-axis quantile box,
  // grown by `robustMargin` × its size on each side, are left out of the solve. The margin
  // keeps the object's real extremities (they are inside the 1–99 % box ± 25 %).
  robustQuantiles: [0.01, 0.99],
  robustMargin: 0.25,
  robustSampleMax: 200000, // positions sampled to estimate the quantiles
  // Pre-solve floater filter (cloudEdit `removeIsolated` at this many leaf widths): a cell
  // holding ≤ 2 points with < 2 occupied neighbours is a stray. A converged solve ignores
  // lone strays geometrically, but each still costs ~125 finest-layer octree nodes.
  isolatedCellLeaves: 2,
  // The auto depth cap: never refine leaves below this many input spacings — finer cells
  // than the samples resolve nothing and multiply the solve's cost by ~4 per level.
  minLeafSpacings: 1,
  minDepth: 5,
  // Spacing estimate for a cloud without a fusion merge cell (an imported cloud): median
  // nearest-neighbour distance over this many sampled points.
  spacingSampleMax: 20000,
}

// Mesh texture internals (core/products/texture/). User-facing knobs are
// TEXTURE_DEFAULTS in defaults.user.js.
export const TEXTURE_TUNING = {
  // Visibility z-buffer: the mesh is rasterised per view onto a grid of at most this
  // many pixels on the long side. Visibility needs occlusion, not texel detail.
  bufferSide: 1536,
  maxCandidates: 8, // best views kept per face for the view selection
  minCos: 0.1, // faces seen at more than ~84° from their normal are not candidates
  depthTolRel: 0.01, // depth-test slack as a share of depth, on top of the pixel-footprint term
  // A face no view sees whole is textured from the view that hides least of it (else
  // it would get a flat colour).
  occludedFallback: true,
  // View selection (min-sum loopy BP, Potts).
  bpIterations: 12,
  // Charts under this many faces are merged into a neighbour's photo where possible.
  minChartFaces: 12,
  bpDamping: 0.5,
  // Charts: padding texels around each chart rectangle (filled with real photo content,
  // so mipmaps don't bleed); a rectangle less than `minFill` covered by its triangles
  // and larger than `minSplitTexels` is bisected.
  padding: 2,
  minFill: 0.35,
  minSplitTexels: 1024,
  gainSamples: 65536, // faces sampled for the colour-levelling fit
  consistencyMinTol: 0.25, // photo consistency never rejects within ±28 % (log colour)
  // Seam levelling (texture/seamLevel.js): weight of keeping a chart's offset smooth
  // along its edges, relative to a seam's two sides meeting; seams far beyond the
  // model's median seam difference count as misaligned detail and pull less; a small
  // pull to 0.
  seamLevelling: true,
  seamSmoothWeight: 1,
  seamDelta: 2, // Cauchy scale, × the model's median seam difference
  seamEpsilon: 1e-3,
  seamChromaWeight: 0, // colour-difference offsets pull at this share of brightness (0: brightness only)
  seamMaxOffset: 40, // levels; colour differences get half
  seamMaxIterations: 2000,
  // Faces no view sees get a flat colour from a palette of cellSize² cells, the colour
  // quantised to `paletteBits` per channel.
  cellSize: 4,
  paletteBits: 5,
  grayFallback: [128, 128, 128],
  jpegQuality: 0.9, // atlas pages are stored as JPEG
  // A mesh with more open edges than this share is taken as unwelded (an STL: every
  // face its own corners) and welded first; without shared vertices every face would
  // be a chart of its own.
  weldOpenShare: 0.5,
}

// ── Resident feature data (stores; TODO ▸ SC-2/SC-3) ─────────────────────────────
// Keypoints and matches live on disk and are read per image / per pair on demand
// (utils/byteLru.js). These budgets bound the CLEAN copies kept for re-use — the open
// image tabs, the match preview, a matching run's working set. Unsaved results are
// pinned and never count against eviction. A bulk consumer (SfM input, exports,
// fingerprints) streams past the cache rather than through it. 256 MiB is ~470 images
// of 20 k keypoints, or ~33 M matches.
export const RESIDENT_TUNING = {
  keypointCacheMiB: 256,
  matchCacheMiB: 256,
  // One read of the matches file serves every consecutive pair inside this window
  // (core/features/matchStorage.js planMatchReads).
  matchReadWindowMiB: 32,
}

// The turntable video (components/viewers/useTurntable.js): MediaRecorder bitrate from
// the canvas size. Point clouds are all fine detail, which a low bitrate smears into
// blocks; 4 bits per pixel and second is ~8 Mbit/s for a 1920×1080 view.
export const TURNTABLE_TUNING = {
  bitsPerPixel: 4,
  minBitrate: 4e6,
  maxBitrate: 25e6,
  minSecondsPerTurn: 5,
  maxSecondsPerTurn: 600,
}
