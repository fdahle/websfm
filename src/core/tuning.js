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
  // The largest image one untiled SIFT pass holds (pixels at the detection size). The
  // crate's peak is ~60 B/px of wasm memory (measured 2026-11-04, Node, synthetic
  // texture: 4 MP 231 MB, 16 MP 917 MB, 36 MP 2.06 GB, 64 MP 3.66 GB), and wasm32 stops
  // at 4 GiB: 74 MP and 100 MP failed ("unreachable"). Above this the Detect Features
  // dialog asks for Tiling (core/features/detectPlan.js); a tile is far below it.
  siftOnePassMaxPx: 64e6,
  // How often a detection run's journal (core/runJournal.js) is rewritten while images
  // finish (each image's features are saved as it finishes). `_journalMs` in a run's
  // settings overrides it; the tests use 0.
  journalIntervalMs: 5000,
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
  // A faint image — fewer keypoints than this share of the cap at the set contrast —
  // is detected again at siftFaintRetryContrast × that contrast (core/features/
  // faintRetry.js, which has the measurements). Untiled SIFT only. On or off is the
  // user's (DETECT_SIFT_DEFAULTS.faintRetry): its cost is in matching, quarry 347
  // exhaustive +31 %.
  siftFaintRetryShare: 0.5,
  siftFaintRetryContrast: 0.5,
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
  // ── A film scan's focal when nothing gives it ──
  // The focal length (mm) a film scan starts from when its sensor gives no focal, format
  // or pixel size: a 6-inch lens, the usual aerial mapping camera. Set the camera's
  // calibrated focal here when the sensor lacks it; bundle adjustment refines it from there.
  //
  // reconstruction.js resolveK. A sensor marked film without a format or pixel size:
  // fx = focal ÷ filmScanShortMm × the scan's short side, the focal defaulting to
  // filmGuessFocalMm, a 6-inch lens (the usual aerial mapping camera). Against its
  // certificates (153.46 / 154.40 mm at 25 µm ≈ 6,140 px) the guess is −3.5 % on the
  // verticals and −0.3 % on the obliques; the digital default, the scan width, was +65 %.
  filmGuessFocalMm: 152.4,
  // The width (mm) the scan's short side is taken to span when a film scan has no format
  // or pixel size: the 9-inch frame plus the margins archives keep. The starting focal in
  // pixels is the focal over this width times the short side; lower it for scans cropped
  // close to the frame.
  //
  // The short side is the 9-inch frame plus the margins the archive keeps: Rachel's
  // corner fiducials span 9084 px of a 9872–10200 px short side.
  filmScanShortMm: 254,

  // ── Bundle adjustment's linear solver ──
  // How each bundle adjustment solves for its steps: an iterative solver (PCG) that may
  // stop early, or an exact sparse factorisation on larger blocks. These trade time
  // against how exactly each step is solved; the cameras and points come out the same.
  //
  // bundle/solve.rs SolverOpts. Policy for the reduced camera system of every bundle
  // adjustment. null ⇒ the crate default: PCG from n ≥ 600 (≈ 100 cameras), rel_tol 1e-10,
  // 2,000 iterations, Cholesky fallback at the cap. The policy here is inexact Newton
  // instead: CG to 1e-6, at most 200 iterations, and the capped iterate taken as the step
  // (it still lowers the quadratic model; LM accepts it only if the true cost falls).
  // HANDOVER ▸ B-parity, corrected sweep: SfM −50 % (PUTI), −24 % (quarry), −14 % (South
  // Building) with the same LM solve counts, camera/checkpoint accuracy and point counts —
  // the exact default spent much of its time hitting the 2,000 cap and then paying a dense
  // Cholesky too. Every BA logs what its solves did and the run totals land in
  // summary.baSolver, so a bench compares by overriding keys per run (merged key by key,
  // sfm.js): { pcgMinN: 1e9 } (Cholesky only), { pcgRelTol: 1e-10, pcgMaxIter: 2000,
  // pcgAcceptPartial: false } (the exact solve), { pcgPreconditioner: 'ic0' } (block
  // IC(0), ≤ 12 % in the sweep).
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
  // Where the direct solve would hold more than the memory budget (bundle/solve.rs
  // direct_bytes against BA_MEMORY_BUDGET, 3 GiB of wasm32's 4; `memoryMb` overrides it),
  // the reduced system is never stored: PCG runs on it implicitly, through the points'
  // coupling blocks (Ceres' ITERATIVE_SCHUR). Aerial blocks stay direct to ~10,000
  // cameras; a dense camera graph (thousands of photos of one site) turns implicit
  // first. BAL final-1936: 3,929 → 114 s, final-3068 from a 2 h timeout to 226 s
  // (docs/BENCHMARKS.md ▸ BAL). { direct: 'implicit' } forces it (bench).
  // `threads`: the bundle adjustment's pool size cap (core/sfm/reconstruction.js
  // threadedWasm; one fewer than the machine's cores), 0 = the single-threaded build.
  // The result is the same bits either way. Fixed by the first call in a worker.
  baSolver: {
    // The size of the camera system (unknowns) from which the iterative solver replaces
    // the dense solve; null uses the built-in 600, about 100 cameras. A very large value
    // forces the dense solve: exact, but slow on a large block.
    pcgMinN: null,
    // The relative residual at which the iterative solver ends a step. Smaller solves
    // each step more exactly in more iterations; a step only has to lower the cost.
    pcgRelTol: 1e-6,
    // The most iterations the iterative solver spends on one step. Higher solves each
    // step more exactly, at more time per step.
    pcgMaxIter: 200,
    // On: a step that reaches the iteration cap is used as it stands when it lowers the
    // cost. Off: such a step is solved again by a dense factorisation, which is exact but
    // slow on a large block.
    pcgAcceptPartial: true,
    // Bundle adjustment stops once a step lowers the robust cost by less than this
    // fraction (Ceres' function tolerance). Raise it to stop sooner at a small loss of
    // accuracy; 0 runs every iteration up to the cap.
    functionTolerance: 1e-6,
    // On: from about 100 cameras each step is solved exactly by a sparse factorisation,
    // which takes fewer, surer steps on a large block, and the solver switches by itself
    // to 'implicit' (the camera system never stored) where that would not fit in memory.
    // 'implicit' forces that; off uses the iterative solver.
    direct: true,
    // The most threads one bundle adjustment uses (at most one fewer than the machine's
    // cores); 0 runs it on one thread. The result is identical; only the time changes.
    // Takes effect in a fresh worker.
    threads: 16,
  },
  // ── Tie point weights by keypoint scale ──
  // Above 1, an observation from a coarse keypoint weighs less in bundle adjustment, down
  // to 1/cap² of the weight of its photo's finest keypoints, and the outlier cut reads each
  // observation in its own precision. 0 = off: every observation weighs the same.
  //
  // baObservations.js tieScaleWeight. > 1: a tie observation weighs
  // 1 / (f · clamp(scale / s₀, 1, cap))² instead of 1 / f² (f the detection scale factor,
  // tieWeightOf), s₀ the finest keypoint scale of its image (keypointSet.js
  // minKeypointScale): a keypoint from a coarse pyramid level counts as proportionally less
  // precise, up to `cap` times its image's finest. With it on, the robust loss reads each
  // observation in its own σ (bundle/model.rs `sig`, solver `sigmaUnits`), so a coarse
  // keypoint is not also cut by a threshold made for fine ones.
  // 0 = off: every tie weighs 1 / f², the loss is in pixels. Off: measured 2026-11-20
  // (plan-ba-next ▸ C1, same matches per set) it is mixed and inside the noise: quarry
  // without priors RTK rms3d 0.203 m (0.233 with the pairs reversed) → 0.198 / 0.197 at
  // cap 4 / 8; PUTI with RTK checkpoints 3.0 / 8.2 → 2.7 / 8.3 cm (cap 4); Casa Grande
  // GCP checkpoints 1.09 / 1.02 → 1.11 / 1.04 m. Not gated with it on.
  tieScaleWeightCap: 0,
  // ── Coarse tie points out of the survey-held solves ──
  // Above 1, the bundle adjustments held to survey data (survey-grade camera positions,
  // GCPs, a reference DEM) leave out tie points whose keypoints are coarser than this
  // multiple of their photo's finest; they are triangulated again on the final cameras, so
  // the sparse cloud keeps them. A coarse keypoint can shift with the viewing angle and
  // bias a held block in height. 0 = off.
  //
  // coarseTies.js. > 1: the solves held to survey data (survey-grade camera positions, GCP
  // anchors, the DEM hold) leave out every tie point whose median keypoint scale over its
  // views exceeds this multiple of each photo's finest keypoint scale (keypointSet.js
  // minKeypointScale); the points are triangulated again on the final cameras afterwards
  // and filtered with the track filter's gates, so the cloud keeps them. A coarse blob's
  // centre may shift with the viewing angle, which trades with focal and height and biases
  // a held block in height (inferred). Keypoints without a scale (learned detectors) count
  // as fine.
  // 0 = off. Off: measured 2026-11-21 at 1.3 (dev/baselines.md ▸ B-coarse-2026-11-21, same
  // matches, both pair orders) it is mixed: GCP checkpoints V on PUTI with RTK 7.43 / 7.40 →
  // 6.79 / 6.76 cm at 4,000 px detection and 7.92 → 6.68 at native, quarry with RTK
  // 11.18 / 11.13 → 10.18 / 10.03 cm, Casa Grande 1.025 → 0.991 m, but PUTI at 2,400 px
  // 8.16 / 8.00 → 8.72 / 8.56 cm.
  heldTieMaxScaleRatio: 0,
  // With coarse tie points left out (heldTieMaxScaleRatio), a photo left with fewer
  // observations than this keeps its finest tie points up to this count, so a weak photo
  // is not stripped bare.
  //
  // A photo left with fewer observations than this in the held solves keeps its finest
  // points up to the count (a higher threshold for that photo).
  heldTieMinObsPerPhoto: 1000,
  // ── The robust loss before the track filter ──
  // The robust loss of the bundle adjustments that run while gross mismatches remain
  // (before the track filter): 'huber' limits a mismatch's pull but keeps it; 'cauchy' and
  // 'geman-mcclure' let it go, which can help accuracy but takes more iterations. Later
  // solves, and any solve with GCP marks, always use Huber.
  //
  // plan-ba-next ▸ C3. The interim solves of registration, the first global solve and the
  // one after retriangulation run before the tight filter, on observations that still hold
  // gross mismatches. Huber bounds a mismatch's pull at δ but keeps it; 'cauchy' or
  // 'geman-mcclure' (redescending, same δ: 2.5 × the median residual) release it. Every
  // later solve, and any solve with GCP marks, keeps Huber. 'huber' = as before. Off:
  // measured 2026-11-20 (plan-ba-next ▸ C3, same matches, both pair orders) Cauchy is a
  // trade-off: quarry RTK rms3d 0.203 / 0.233 m → 0.199 / 0.227, PUTI checkpoints V
  // 8.16 / 8.18 → 7.87 / 7.80 cm, Casa Grande equal, the gate's ETH3D medians −11 … +3 %;
  // but the first global solve takes 2–3× the iterations: BA 114 → 160 s on quarry,
  // 131 → 145 s on PUTI. Geman–McClure: mixed (PUTI lost 756 points to filter pass 1 once).
  // Cauchy on the interim solves alone (Huber from the first global solve on) keeps the
  // time but not the gain: quarry 0.203 / 0.227 → 0.202 / 0.234 m, PUTI checkpoints
  // 3.02 / 8.16, 3.19 / 8.00 → 3.05 / 8.06, 3.31 / 7.96 cm, Casa Grande equal; the gate's
  // ETH3D medians −6 … +7 % (plan-ba-next ▸ round 6, item 3): not kept.
  baPreFilterLoss: 'huber',
  // ── Bundle adjustment and track filtering ──
  // Observations with a reprojection error above this (pixels at the detection size) are
  // removed between bundle adjustments. Lower it for a tighter sparse cloud, at the risk of
  // losing tie points on weak photos; raise it while the lens model does not fit yet.
  //
  // Observation pruning threshold, in **detection pixels** — sfm.js resolves it to
  // native px against the run's detection scale (core/scaleContext.js, which owns
  // the maxFactor/minFactor knobs) before any pass reads it. Bounded separately by
  // core/sfm/cleanupThreshold.js, which caps how much a pass may remove when the
  // residual distribution is shifted by wrong intrinsics — different root cause,
  // and the two compose (the quantile bound applies to the resolved threshold).
  filterMaxReprojPx: 4.0,
  // Tie points whose rays meet at less than this angle (degrees) are dropped: their depth
  // is poorly fixed. Lower it to keep points between photos taken close together, at less
  // precise depths.
  //
  // drop points whose rays are too parallel
  filterMinTriAngleDeg: 1.5,
  // The fewest photos a tie point must be seen in to stay in the finished sparse cloud.
  // Two-view points help while the model grows and are always kept until then; 2 keeps
  // them in the result too, at more noise.
  //
  // Final sparse-cloud corroboration gate. Keep 2-view tracks while incremental SfM
  // needs them, then omit them from the delivered model once a sufficiently large
  // multi-view core proves that doing so will not erase a two-camera/tiny dataset.
  finalMinTrackViews: 3,
  // The final prune of tie points seen in too few photos runs only when at least this many
  // tie points are seen in enough photos, so a tiny project keeps its cloud.
  //
  // Part of the final corroboration gate (finalMinTrackViews): the multi-view core must
  // hold this many tracks (tracks.js minSupportedTracks).
  finalTrackPruneMinCount: 50,
  // The final prune of tie points seen in too few photos runs only when at least this
  // share of the tie points is seen in enough photos, so a weakly linked project keeps its
  // two-view points.
  //
  // Part of the final corroboration gate (finalMinTrackViews): the multi-view core must
  // be this share of the tracks (tracks.js minSupportedShare).
  finalTrackPruneMinShare: 0.2,
  // The final prune removes a two-view tie point only where tie points seen in more photos
  // already cover that part of the photo, on a grid of this many cells a side. 0 prunes
  // everywhere, which can leave empty patches.
  //
  // …and only where corroborated tracks already cover the image area (a grid of this
  // many cells a side per image; 0 = the old blanket prune). Casa Grande 1978: the
  // blanket prune left a lattice of strips around empty squares (tracks.js).
  finalTrackPruneCoverageGrid: 16,
  // Rounds of track completion after the final bundle adjustment: a verified match with
  // one keypoint in a tie point adds the other when it reprojects within the filter's
  // gate, turning two-view points into points seen in three or more photos. Rounds repeat
  // until nothing is added; later rounds add little.
  //
  // Track completion (tracks.js `completeTracks`, COLMAP's CompleteTracks) after the
  // final BA and before each post-filter pass: verified matches with one endpoint in a
  // point add the other endpoint when it reprojects within the track-filter gate.
  // Rounds repeat until nothing is added (A↔C enables C↔D); 5 is ample — later rounds
  // add almost nothing. On 2026-10-05 SB the final prune still dropped 38,990 two-view
  // points (41 %); completion is the step that turns tracks into ≥3-view ones.
  completeTracksMaxRounds: 5,
  // On: after the first self-calibrated pass, each tie point's projection is searched in
  // every photo that misses it for a keypoint with a matching descriptor, which lengthens
  // tracks. Costs memory for the descriptors (128 bytes a keypoint) and some time.
  //
  // Projection-guided track extension (guidedExtension.js): after the first
  // self-calibrated post-filter BA, search each point's projection in every registered
  // camera that misses it for a keypoint with a matching descriptor. Ships the
  // descriptors to the SfM worker as uint8 RootSIFT (128 B per keypoint; counted by the
  // sparse memory preflight). Bench (HANDOVER ▸ B-bench): ≥3-view points +5 % SB, +28 %
  // building, +7 % eagle, +5.9 % quarry, median error and RTK accuracy unchanged.
  guidedTrackExtension: true,
  // The guided search's radius: the filter gate, capped at this multiple of the model's
  // 90th-percentile reprojection error. Higher finds more points at a looser fit; 0 uses
  // the filter gate alone, which a coarse detection size makes very wide.
  //
  // Search radius = the filter gate capped at this × the model's p90 residual: a coarse
  // detection scale makes the native-px gate far wider than the model resolves (TMA:
  // 16.9 px gate, 1 px median). Capped, SB additions sit at 0.39/0.98 px median/p90 vs
  // the model's 0.31/0.96 (uncapped 0.43/1.42) for −0.6 % points. 0 = gate only.
  guidedRadiusP90Mult: 3,
  // The guided search takes a keypoint only when its descriptor distance is within this
  // quantile of the distances along tracks seen in three or more photos. Higher adds more
  // points and more false ones.
  //
  // Acceptance: best candidate ≤ this quantile of ≥3-view track descriptor distances and
  // ≤ ratio × the runner-up in the same window (0.95 gave +1 % more on SB, untested
  // elsewhere; 0.9 ratio and running in both passes changed nothing).
  guidedQuantile: 0.9,
  // The guided search also takes a keypoint only when its descriptor distance is at most
  // this ratio of the next-best candidate's in the search window (a ratio test). Lower is
  // stricter.
  //
  // See guidedQuantile.
  guidedRatio: 0.8,
  // A global bundle adjustment runs after this many newly registered photos (and once the
  // model has grown by interimBaGrowth). Lower refines more often at more time.
  //
  // run a global BA after this many newly-registered cameras
  interimBaEvery: 5,
  // A global bundle adjustment during registration also waits until the model has grown
  // by this factor since the last one, as in COLMAP. Each solve costs the whole model, so
  // this keeps a large project from slowing down quadratically; 0 solves every
  // interimBaEvery photos.
  //
  // COLMAP's ba_global_images_ratio is 1.1. Each solve costs the whole model, so every-5
  // alone is quadratic: quarry (347 images) registration 1,005 → 143 s, SB 106 → 45 s,
  // points and RTK accuracy unchanged (SB −0.4 %). 0 = every interimBaEvery cameras.
  // 2 since 2026-10-11 (HANDOVER ▸ B-parity, interim-BA spacing): against 1.2, SfM −25…33 %
  // on PUTI, quarry, South Building and St Nazaire with every camera kept and camera /
  // checkpoint accuracy unchanged, and the hard sets (building's weak bridge, eagle) lose
  // nothing either. Local BA between the solves bought nothing on top.
  interimBaGrowth: 2,
  // Iterations of each bundle adjustment during registration, fewer than the final one
  // runs. More settles each step better at more time.
  //
  // fewer iters for the interim solves than the final BA
  interimBaIterations: 12,
  // Local bundle adjustment after each registration: the new photo and this many − 1 of
  // its most co-visible photos are refined, their neighbours held. 0 = off; try it on a
  // project of thousands of photos, where the gaps between global solves grow long.
  //
  // sfm.js runLocalBundleAdjust: the new camera + its localBaWindow − 1 most co-visible
  // cameras free, their neighbours fixed. 0 = off: on six bench sets it only added 5–10 %
  // time at growth 2 (B-parity); kept opt-in for a thousands-of-cameras set, where the gaps
  // between global solves get long.
  localBaWindow: 0,
  // Iterations of each local bundle adjustment (localBaWindow).
  //
  // See localBaWindow.
  localBaIterations: 6,
  // How tracks are stored while the model is built: 'typed' (compact arrays, the fast one)
  // or 'map' (the reference it is tested against). The result is identical.
  //
  // Track storage (core/sfm/trackStore.js): 'typed' is the arena the solver runs on;
  // 'map' is the Map-based reference it is tested against. Same output, bit for bit.
  trackStore: 'typed',
  // Rounds of the final bundle adjustment held to camera positions (imported or from
  // EXIF GPS); the second lets the fit of the positions into the model settle after the
  // first one bends it.
  //
  // Camera-centre priors (imported poses / EXIF GPS) enter one final fixed-K BA.
  // Targets are mapped into the current arbitrary SfM frame by a similarity fit;
  // two rounds let that mapping settle after the first constrained deformation.
  cameraPriorBaRounds: 2,
  // The fewest photos with a camera position for the solve held to camera positions to
  // run.
  //
  // See cameraPriorBaRounds.
  cameraPriorBaMinCameras: 3,
  // How far (px) the solve held to camera positions may raise the reprojection error, so
  // noisy GNSS cannot visibly damage the tie point fit. Raise it to let positions pull
  // harder.
  //
  // A position-constrained solution may trade a little image residual for better
  // geometry. Bound that trade so noisy GPS cannot visibly damage tie-point fit.
  cameraPriorMaxReprojIncreasePx: 0.25,
  // The solve held to camera positions may also raise the reprojection error by at most
  // this fraction of the error before it.
  //
  // See cameraPriorMaxReprojIncreasePx.
  cameraPriorMaxReprojIncreaseFrac: 0.1,
  // The calibration terms the solve held to camera positions refines: 'auto' those the
  // last self-calibrated pass refined, 'none' a fixed calibration, or a comma list
  // (f,k1,…). A fixed calibration cannot remove a dome a slightly wrong focal or
  // distortion leaves in a nadir block.
  //
  // Intrinsics the camera-prior BA refines: 'auto' = the last post-filter pass's
  // self-cal terms, 'none' = fixed K, or a comma list. Fixed K cannot undo a dome caused
  // by slightly wrong f/k (nadir focal–height correlation): RTK benches quarry camera
  // residual 0.43 → 0.20 m, GeoScan checkpoints H 6.1 → 4.4 cm, V 16.4 → 10.8 cm.
  // Loose priors (5 m default, consumer GNSS) carry too little weight to move K.
  cameraPriorRefineIntrinsics: 'auto',
  // The same for the solve held to GCPs, once gcpRefineIntrinsicsMinGcps control points
  // qualify: over a nadir block only control fixes the focal. 'none' keeps the calibration
  // fixed.
  //
  // Same for the GCP-anchored BA (bundleSession.js), once at least
  // gcpRefineIntrinsicsMinGcps control points qualify: over a nadir block only control
  // pins the focal (Casa Grande 1978 film, HANDOVER ▸ B-hist). Checkpoint V with 4 control
  // GCPs, fixed K → refined, Casa Grande 1978 24.8 → 1.14 m, Iceland 26.4 → 6.5 m, DJI
  // Mavic Air 2 52 → 47 cm (gcpw-night).
  gcpRefineIntrinsics: 'auto',
  // The fewest control GCPs for the GCP-held solve to refine the calibration. Four
  // suffice; three do not, since three fit the similarity exactly and leave nothing over
  // for the calibration.
  //
  // Four suffice, three do not (three fit the similarity exactly): with 3, Casa Grande
  // 28 → 18 m, Iceland 331 m either way (gcpw-3ctl-2026-11-18).
  gcpRefineIntrinsicsMinGcps: 4,
  // ── Focal–height check (a warning; it changes no result) ──
  // A nadir block held by survey-grade camera positions alone, its focal self-calibrated,
  // gets a warning when the camera heights vary by less than this share of the flying
  // height: the positions then barely fix the focal, and a focal error moves the ground in
  // height. Raise it to warn more readily.
  //
  // focalHeight.js. A nadir block held by survey-grade positions alone (no GCPs, no DEM
  // hold), its focal self-calibrated: a focal error ε moves the ground by ε·H and the
  // cameras' height differences by ε·Δh, so the positions see the share r = Δh / H of it.
  // Warned below this r, the camera heights' NMAD over the flying height above the sparse
  // cloud. Least squares on the camera heights gives σ_ε ≈ σ_z / (NMAD·√N), so the focal's
  // share of the ground's height error is σ_z / (r·√N): at 5 % it equals the positions'
  // own vertical σ_z for a block of about 400 photos. 5 % is also what a second flight 7 %
  // of H higher gives (two heights: NMAD = 1.48 × half the step), short of the 10–20 %
  // apart the remedy asks for, and above what one height holds (altitude hold, wind and
  // gentle terrain: ±1–3 m at 100 m). Chosen from the geometry, not fitted; checked
  // (dev/baselines.md ▸ B-focal-2026-11-21): PUTI RTK 3.1 % warns (σ_z / (NMAD·√N) =
  // 166 ppm against the 170 ppm its focal profile measured), quarry RTK 5.5 % does not.
  focalHeightMaxSpreadRatio: 0.05,
  // A camera counts as oblique beyond this tilt from straight down (degrees). Nadir
  // capture stays within a few degrees on a gimbal and about 15° on a fixed wing in wind;
  // oblique capture tilts 25–45°.
  //
  // PUTI 0 %, quarry 0.6 % of the photos beyond 20°.
  focalHeightNadirMaxTiltDeg: 20,
  // With more than this share of oblique photos the block is not nadir and gets no
  // warning: the obliques' depth varies across the frame, which fixes the focal.
  //
  // See focalHeightNadirMaxTiltDeg.
  focalHeightMaxObliqueShare: 0.05,
  // ── Held to a reference DEM ──
  // Rounds of the bundle adjustment held to a reference DEM, the anchors rebuilt between
  // them, since a point that moves sideways meets the DEM elsewhere. Two usually settle it.
  //
  // F13: bundleSession.js runDemAnchoredBundleAdjust. The synthetic doming block settles in
  // two (demAnchors.ba.test.js). At most demHoldMaxAnchors tie points, spread over the
  // area; fewer than demHoldMinAnchors over stable ground and the pass is skipped. The
  // reference is sampled on at most demHoldGridSide² places over the block.
  demHoldRounds: 2,
  // The most tie points held to the DEM, spread over the area. More holds the block more
  // evenly at more time.
  //
  // See demHoldRounds.
  demHoldMaxAnchors: 4000,
  // With fewer tie points than this over stable ground, the DEM hold is skipped.
  //
  // See demHoldRounds.
  demHoldMinAnchors: 20,
  // The reference DEM is sampled on at most this many places a side over the block.
  //
  // See demHoldRounds.
  demHoldGridSide: 400,
  // ── Distortion self-calibration during registration ──
  // From this many photos on, the bundle adjustments during registration refine a shared
  // focal and radial distortion (k1), instead of leaving them to the passes after it.
  // Below it, distortion cannot be told apart from the points' positions. Only when the
  // calibration is self-calibrated.
  //
  // D3. Once the model has this many cameras, the interim BA refines a shared focal +
  // radial k1 and folds the distortion out of the keypoints (+ Kmap) mid-registration,
  // instead of deferring it to the post-filter passes. A 2-view model hides distortion in
  // its points (init reproj looks perfect, 3rd-view PnP collapses at ~13% inliers), so k1
  // is only identifiable once several cameras at different angles are in — below this
  // count the interim BA stays pose/points-only and the fold (which mutates keypoints) is
  // held back. Only active when refineIntrinsics self-calibrates (no calibrated model at
  // ingest).
  distortionCalMinCams: 6,
  // Self-calibration guard: a solve that moves the focal by more than this fraction in
  // one step is rejected. These are broad plausibility bounds against runaway solves, not
  // calibration priors.
  //
  // Transactional self-cal guard. These are deliberately broad plausibility bounds,
  // not calibration priors: normal EXIF recovery remains free, while the observed
  // thin-block runaways (focal +48…88%, k1 ≈ -0.5) are rejected before their
  // distortion is destructively folded into every image's keypoints.
  selfCalMaxFocalStepFrac: 0.25,
  // Self-calibration guard: the focal may move at most this fraction from its starting
  // (EXIF or entered) value.
  //
  // See selfCalMaxFocalStepFrac.
  selfCalMaxFocalNominalFrac: 0.35,
  // Self-calibration guard: the principal point may move at most this fraction of the
  // photo's size from the centre.
  //
  // See selfCalMaxFocalStepFrac.
  selfCalMaxPrincipalOffsetFrac: 0.1,
  // Self-calibration guard: the radial distortion may shift a photo's corner by at most
  // this fraction of its diagonal.
  //
  // See selfCalMaxFocalStepFrac.
  selfCalMaxCornerShiftFrac: 0.25,
  // The focal step bound when the starting focal is only a field-of-view guess (no EXIF
  // focal, no sensor format), which is no evidence: wider, so the solve can reach the
  // real focal.
  //
  // The same two focal bounds when the starting focal is only resolveK's default-FOV
  // guess (no EXIF focal, no sensor format). That guess is not evidence: a 153 mm lens
  // on a 230 mm film frame sits 33% below it, and the 25% step bound rejected the focal
  // pre-solve on the CA213732V strip (29.9%), leaving fx at the guess (SFM-12).
  selfCalGuessFocalStepFrac: 0.6,
  // The bound on the focal's move from its start when that start is only a field-of-view
  // guess.
  //
  // See selfCalGuessFocalStepFrac.
  selfCalGuessFocalNominalFrac: 0.7,
  // The decentring terms (p1, p2) are kept only when freeing them lowers the reprojection
  // error by at least this fraction. On undistorted photos they would only trade with the
  // camera poses; lower it to keep them more readily.
  //
  // Brown's decentring terms (p1, p2) under the auto schedule are kept only when the
  // first solve that frees them lowers the reprojection RMS by at least this fraction
  // against the same solve without them (bundleSession.js). Measured 2026-11-06: quarry
  // (a decentred senseFly lens) 4 % better, and its GCP-free dome went from 67 to 13 cm
  // vertical; South Building, ETH3D playground and UseGeo (undistorted photos) 0.0 %,
  // where freeing them moved the cameras 9–24 % further from the reference.
  selfCalDecentringMinGain: 0.01,
  // Under survey-grade camera positions (at least half within this σ in metres on every
  // axis) p1 and p2 are always kept: with the heights held, a small real decentring
  // trades with the focal and so with the ground height, even when it lowers no error.
  //
  // …but no trial under survey-grade camera positions (cameraPriors.js
  // surveyGradePositions: at least half the priors within this σ on every axis, metres):
  // p1, p2 stay. With the camera heights held, a small real decentring that lowers no RMS
  // (GeoScan PUTI, RTK only: 0.0 %) still trades with the focal and so with the ground
  // height under the cameras. Measured 2026-11-12: PUTI checkpoints V 9.2 → 7.8 cm with
  // Metashape's p1, p2 (Metashape 6.4); UseGeo with its positions at ±3/5 cm even (LiDAR
  // edge dome −3.5 → −2.4 cm). Consumer GPS (PUTI at ±10/20 m) is not held: kept there,
  // checkpoints H 9 → 45 cm. GCP-held film blocks keep the trial (kept: Casa Grande
  // 1.09/1.01 → 1.12/1.05 m, Iceland even).
  selfCalDecentringHeldSigma: 0.1,
  // Adding photos to a saved sparse model stops when the old photos' keypoints differ
  // from those the model was solved from by more than this median (px): their features
  // were detected again, so the model no longer fits them.
  //
  // Adding images to a saved model (extendModel.js) rebuilds the old images' keypoints in
  // the model's frame and compares them with the pixels the model saved: above this
  // median gap (px) they are not the keypoints the model was solved from (re-detected
  // features) and the run stops.
  extendFrameMaxMedianPx: 0.5,
  // ── PnP registration gate ──
  // Scales the inlier gate of a new photo's pose (PnP) from the reprojection threshold,
  // capped at 2. Higher admits more correspondences as inliers, and more false ones.
  //
  // fixed inlier gate = reprjThreshold × min(pnpGateScale, 2)
  pnpGateScale: 2,
  // The fewest PnP inliers for a new photo's pose to be accepted. Lower registers weak
  // photos more readily, at the risk of a wrong pose.
  //
  // absolute PnP-inlier floor to accept a pose
  minPnpInliers: 15,
  // The least share of a new photo's correspondences that must be PnP inliers for its pose
  // to be accepted. Wrong poses fit by coincidence sit below it; lower it only for photos
  // you know are right.
  //
  // Raised 0.15 → 0.3: on the 2026-07-10 building run every mis-registration was admitted
  // in the 10–25% band. With self-calibration on by default (refineIntrinsics 'auto' →
  // 'f,k1'), true poses clear 0.3 comfortably; the band below it is where coincidence
  // fits live.
  minPnpInlierRatio: 0.3,
  // A second check after the pose is refined: the inlier share counted again at the
  // tighter reprojection threshold. A pose that only fits at the loose gate waits for a
  // later round.
  //
  // Second acceptance gate: after the pose is polished, recount inliers at the
  // (tighter) reprjThreshold rather than the looser PnP gate and require the ratio
  // again — a pose that only fits at the loose gate is deferred (P4.3).
  minPnpRefineInlierRatio: 0.3,
  // ── Stalled-strip rescue ──
  // On: when a pass registers nothing but photos still link to the model, one rescue round
  // refines the focal, triangulates again and retries those photos once with a looser
  // second check. The usual cause is a short film strip; off keeps the strict passes.
  //
  // S1. When a full sweep registers nothing but images still link to the model, the
  // usual causes on short film strips are (a) a ~10% wrong focal the post-filter
  // self-cal hasn't corrected yet and (b) strip-end structure gaps. One rescue
  // round runs a focal-only BA + a retriangulation, then retries the stalled
  // images ONCE with a relaxed refine-recheck (at the PnP gate, ratio below). The
  // absolute minPnpInliers floor + gate-1 still apply, and the final BA + track
  // filter clean any loose observations, so this only rescues genuinely-linked
  // end images, never manufactures a pose. Set false to restore the strict sweep.
  rescueStalled: true,
  // The inlier share the rescue's second check asks for, instead of
  // minPnpRefineInlierRatio.
  //
  // relaxed refine-recheck ratio used on the rescue retry
  rescueRefineRatio: 0.2,
  // The rescue triangulates the points a stalled photo is matched to down to this angle
  // (degrees), so a photo taken close to its neighbours finds 3D points to register
  // against. Points still under filterMinTriAngleDeg are dropped once it has added its
  // view.
  //
  // The rescue's second retriangulation: only the points a stalled image is matched to,
  // down to this angle instead of filterMinTriAngleDeg. Between nearby registered photos
  // most shared points sit under 1.5°, so a photo with hundreds of verified inliers to the
  // model found no 3D points to resect against, and half a close-range scene stayed
  // unregistered (ETH3D playground 19/38, office 21/26). At 0.25° and a 0.5 px match the
  // depth is still within ~3 % (enough for PnP); the interim filter drops what is still
  // under filterMinTriAngleDeg once the new photo has added its view.
  rescueMinTriAngleDeg: 0.25,
  // A photo registered with fewer than this multiple of the minimum correspondences is
  // reported as near the limit (in the log and the summary): a small change upstream could
  // lose it. Changes no result.
  //
  // summary.registrationMargin, a log line, the regression gate's warning. ETH3D
  // playground's hinge photo registered at 34 against 20 (1.7×).
  registrationMarginFactor: 2,
  // ── Secondary-model recovery ──
  // On: photos left outside the main model that link to each other are reconstructed as
  // a second model and aligned to the first through the photos they share.
  //
  // reconstruct coherent blocks stranded outside the primary
  secondaryModels: true,
  // The fewest photos a group needs to become a secondary model; smaller leftovers are
  // usually noise.
  //
  // avoid recursively solving tiny/noisy leftovers
  secondaryMinImages: 8,
  // How many photos of the main model next to a secondary one are used to align the two.
  //
  // registered overlap halo used to align arbitrary frames
  secondaryBoundaryImages: 12,
  // How many other starting pairs are tried when the model stops growing while still
  // small. More tries cost time but rescue a bad start.
  //
  // retry alternate initial pairs when the primary stalls tiny
  seedRetryMax: 4,
  // A model holding less than this share of the photos counts as stalled small, and
  // another starting pair is tried.
  //
  // below this registered share, seed choice is still suspect
  seedRetryMinFraction: 0.5,
  // ── Image pairs checked against the finished model ──
  // A match agrees with the finished model when its epipolar error under the solved poses
  // is within this many pixels (at the detection size). Image pairs that disagree point to
  // photos the model may have placed wrong.
  //
  // core/sfm/pairAgreement.js. A match agrees when its Sampson error under the solved
  // relative pose is within pairCheckEpiPx (detection px, scaled like the reprojection
  // gates); a pair agrees when at least pairCheckAgreeFrac of its matches do and it does
  // not join more keypoints of *different* model points than of the same one
  // (≥ pairCheckMinSplit). A photo is contested when more than pairCheckContestedFrac of
  // its scored pairs conflict with the model (≥ pairCheckMinPairs scored pairs); pairs, not
  // matches, so one strong false pair cannot outvote several true ones; and at most
  // pairCheckMaxHolders of them agree, since a photo with many agreeing pairs is not held
  // in place by any one of them.
  pairCheckEpiPx: 4,
  // An image pair agrees with the model when at least this share of its matches do.
  //
  // See pairCheckEpiPx.
  pairCheckAgreeFrac: 0.5,
  // An image pair also disagrees when it joins keypoints of different tie points more
  // often than of the same one, counted from this many on.
  //
  // See pairCheckEpiPx.
  pairCheckMinSplit: 5,
  // Image pairs with fewer matches than this are not scored.
  //
  // See pairCheckEpiPx.
  pairCheckMinMatches: 15,
  // A photo is flagged as contested when more than this share of its scored image pairs
  // disagree with the model.
  //
  // See pairCheckEpiPx.
  pairCheckContestedFrac: 0.5,
  // A photo is flagged as contested only when it has at least this many scored image
  // pairs.
  //
  // See pairCheckEpiPx.
  pairCheckMinPairs: 2,
  // A photo is flagged as contested only when at most this many of its image pairs agree
  // with the model: a photo with many agreeing pairs is not held in place by any one.
  //
  // See pairCheckEpiPx.
  pairCheckMaxHolders: 2,
  // ── GCP triangulation, robust mode ──
  // In robust GCP triangulation, a mark is dropped as a misclick when its reprojection
  // error exceeds three times the median or this floor (px), whichever is larger. The
  // floor is a misclick's size, not a marking accuracy.
  //
  // gcpTriangulation.js; guides and target detection. Absolute floor (native px) of the
  // median cut max(3 × median, floor): on a clean set the median is ~0, and a pure
  // multiple would reject honest marks over noise. The cut is for misclicks, so the floor
  // is a misclick's size, not a marking accuracy.
  gcpRobustFloorPx: 25,
}

// Tie-point matching knobs read in useMatchesStore but NOT exposed in
// MatchFeaturesModal — the user-facing match defaults live in defaults.user.js ▸
// MATCH_DEFAULTS. `settings` from the caller still overrides.
export const MATCH_TUNING = {
  // ── Image pair verification ──
  // On: RANSAC draws its samples best match first (PROSAC) instead of at random. It can
  // find a fit sooner on image pairs with few true matches, but it can also settle on a
  // smaller set of inliers and cost close-range scenes photos.
  //
  // PROSAC, crates/matching ransac_fundamental_ordered. Off: in 0.8 it cost close-range
  // scenes cameras (ETH3D courtyard 38 → 36, office 26 → 21 and playground 38 → 19
  // registered; on courtyard a 743-match pair kept 475 inliers where uniform sampling
  // finds 558) and gained nothing measured on real data (quarry and PUTI kept their
  // accepted pairs, the film sets their cameras). Uniform: every ETH3D camera registers;
  // quarry 6,592 pairs (6,589) at +5 % matching time. Its gain was on synthetic pairs
  // with 15–30 % true matches; turn it on to try a set that has such pairs.
  prosacSampling: false,
  // ── Saving and caches ──
  // How often (ms) a matching run saves its matches while image pairs finish: what a
  // closed or crashed tab can lose, against the time each save takes (never more often
  // than ten times that time).
  //
  // core/runJournal.js: the matches and the run's journal. `_journalMs` in a run's
  // settings overrides it; the tests use 0.
  journalIntervalMs: 60_000,
  // The memory (MiB) a matching run keeps descriptors in, so an image used by many image
  // pairs is read from project storage once. A smaller budget saves memory and costs
  // reloads; 2,048 holds about 16 million SIFT keypoints.
  //
  // Byte budget of a matching run's descriptor cache in the page
  // (core/features/descriptorCache.js: each image's descriptors and subset-gate sample,
  // the image whose next pair is furthest ahead evicted first). A smaller budget costs
  // reloads from project storage; the gate samples (≤ 0.1 MB an image as bytes, 0.4 MB
  // as an older project's floats) keep a pair the gate skips from loading anything. SIFT
  // is stored as bytes (128 B a keypoint), so 2 GiB holds 16 M keypoints of it (PUTI at
  // 4,000 px is 8.5 M) and a quarter as many of floats.
  descCacheMiB: 2048,
  // The GPU memory (MiB) brute-force matching on WebGPU keeps descriptors in. A smaller
  // budget only costs uploading descriptors again; 1,024 holds about 2 million SIFT
  // keypoints.
  //
  // WebGPU brute-force: byte budget of the per-run GPU descriptor cache (LRU). The GPU
  // holds floats (stored bytes are widened on upload, 512 B a SIFT keypoint): 1 GiB
  // holds a whole 128-image SIFT run at ~8.4k kp (≈ 4.3 MB/image); a smaller budget
  // only costs re-uploads (the worker answers a miss and the store resends).
  gpuDescCacheMiB: 1024,
  // ── Image pair acceptance ──
  // LightGlue matches below this confidence (0–1) are dropped. Raise it for fewer, surer
  // matches.
  //
  // LightGlue min match confidence
  lgMinConf: 0,
  // An image pair with at least this many RANSAC inliers is accepted even when its
  // inlier ratio is below Min inlier ratio: dozens of inliers are real geometry, such as a
  // narrow overlap.
  //
  // inlier count that overrides a failed ratio/H-F gate (pairGate.js R5 absolute-inlier
  // override: a medium-overlap façade bridge, not the ~12/100 spurious fit the ratio gate
  // targets)
  overrideInliers: 30,
  // An image pair whose homography holds at least this share of its inliers is labelled
  // degenerate (a plane or a pure rotation): it still links photos but is not used to
  // start a model.
  //
  // homography-vs-fundamental ratio flagging a degenerate fit; a quality label, not a
  // rejection (pairGate.js)
  hfDegenerateRatio: 0.8,
  // An image pair is rejected when its inliers land on fewer distinct spots than this
  // share of their count (many keypoints matched to one place).
  //
  // reject a pair whose inliers collapse to few unique locations
  minInlierUniqueFrac: 0.5,
  // An image pair is rejected when its inliers all lie within a patch this small (px) in
  // one photo, which is no real geometry.
  //
  // …or into a pinhead region (epipole degeneracy), in px
  minInlierSpreadPx: 8,
  // ── Acceptance floors besides Min matches per pair ──
  // With Ignore stationary points on, a match that moves at most this percentage of the
  // image diagonal between the two photos counts as stationary (frame marks, burnt-in
  // text) and is dropped.
  //
  // Decoupled match-acceptance floors (WS1). `minMatches` (defaults.user.js, user-facing)
  // is the ACCEPT floor + the H-skip floor. This and the next two are the other gates it
  // used to conflate, split out so raising minMatches (e.g. to 500) can never widen the
  // pre-verification kill zone or sever the match graph. filterStationary: a match moving
  // at most this % of the image diagonal between the two images is stationary (1 % =
  // 130 px on a 9139² film scan).
  stationaryTolPct: 1,
  // An image pair with fewer matches than this before verification is skipped (at most
  // Min matches per pair).
  //
  // skip verification below this many RAW putatives (clamped to ≤ minMatches)
  rawSkipFloor: 15,
  // An image pair with a valid fit and at least this many inliers that misses the accept
  // gate is kept as weak: used to register photos, never to start a model or triangulate.
  //
  // valid-F pairs with ≥ this many inliers but below the accept gate → WEAK (kept for PnP
  // registration only; never seed init or triangulate)
  weakMinInliers: 15,
  // ── Tiled guided matching ──
  // LightGlue's Full matching density first matches up to this many of each photo's
  // strongest keypoints to find how the two photos line up. More fits that alignment more
  // surely, at more time.
  //
  // core/features/guidedTiles.js, gated by lgTiled. per-image cap for the coarse pass
  // that fits the guide H
  lgCoarseKeypoints: 1024,
  // With fewer coarse matches than this, the image pair is taken not to overlap and is
  // skipped, rather than matched again in full. Lower it if overlapping pairs are skipped.
  //
  // The coarse pass doubles as the LightGlue pair GATE (the brute-force subset gate
  // is skipped for LightGlue): a near-empty coarse result on 1024×1024 strong
  // keypoints means the pair doesn't overlap, so it's returned as-is (~0.3 s, the
  // store's minMatches then skips it) instead of escalating to the plain capped
  // match — the single most expensive path — just to confirm the non-overlap.
  // coarse matches below this ⇒ no overlap, skip (don't fall back)
  lgCoarseGateMin: 8,
  // The fewest coarse matches before a homography is fitted to guide the tiles; below it
  // the image pair is matched without tiles.
  //
  // min coarse matches before attempting a homography guide
  lgGuideMinMatches: 24,
  // The fewest homography inliers for the guide to be trusted; below it the image pair is
  // matched without tiles.
  //
  // min H-inliers for the guide to be trusted (else fall back)
  lgGuideMinInliers: 15,
  // The guide homography's RANSAC threshold, as a fraction of the image diagonal (at least
  // 3 px). The guide only has to predict where a tile lands, so it is loose by design;
  // lower it only for flat scenes.
  //
  // The guide H only needs to predict *where a tile lands* (locality), not fit the
  // scene tightly — the residual-derived margin absorbs looseness by design. So the
  // guide RANSAC threshold scales with image size (a fixed ~3 px on a 10k-px aerial
  // frame with terrain relief rejects nearly every real pair: the 2026-07-10 CA…V
  // run fell back on 9/10 pairs at ratio 0.04–0.21 while F-RANSAC showed 0.5–0.84
  // inlier ratios), and the inlier-fraction gate is correspondingly permissive.
  // guide-H RANSAC threshold as a fraction of image diagonal (≥3 px)
  lgGuideRelThresh: 0.001,
  // The least share of coarse matches the guide homography must hold; below it (a scene
  // too 3D, or no overlap) the image pair is matched without tiles.
  //
  // min H-inlier fraction (scene too 3D / no overlap ⇒ fall back)
  lgGuideMinInlierRatio: 0.15,
  // A tile with fewer keypoints than this in either photo is skipped.
  //
  // skip a tile with fewer keypoints than this on either side
  lgTileMinKps: 32,
  // ── When the subset gate runs ──
  // The subset gate runs only with at least this many image pairs. On fewer, matching
  // every pair in full takes seconds, and a skipped real pair could split the photos into
  // pieces.
  //
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
  // Photos left with fewer accepted image pairs than this test their skipped pairs again
  // on a larger sample (subsetGateRescueScale). Raise it to rescue more photos at more
  // time; 0 = off.
  //
  // Gate rescue (useMatchesStore.matchAll): images left with fewer than this many
  // accepted pairs re-test their gated pairs on a subsetGateRescueScale× larger subset
  // (scale² more expected putatives). 0 = off. Iceland 1980 film: 7 images stranded.
  subsetGateRescueDegree: 6,
  // How many times larger the sample of the rescue test is.
  //
  // See subsetGateRescueDegree.
  subsetGateRescueScale: 4,
  // A skipped image pair whose sample reached at least this share of Min subset matches
  // is tested again on a larger sample (subsetGateNearMissScale), against a threshold
  // raised in step. 0 = off.
  //
  // Near misses (matchAll's gate rescue): a gated pair whose sample reached at least
  // subsetGateNearMiss × the threshold is tested again on a subsetGateNearMissScale×
  // larger sample against a threshold as many times higher (the count a real pair
  // reaches grows with the sample size squared, a chance count about linearly).
  // South Building: 102 of the 918 pairs gated at 6–7 of 8 are pairs COLMAP verifies
  // with ≥ 50 inliers (one with 498).
  subsetGateNearMiss: 0.5,
  // How many times larger the sample of a near miss's second test is.
  //
  // See subsetGateNearMiss.
  subsetGateNearMissScale: 2,
  // ── Repair a split graph ──
  // How many rounds Repair a split graph runs while the main block grows, each with fresh
  // image pairs between the pieces and the main block, matched without the subset gate
  // and with looser gates.
  //
  // Bridge repair (MATCH_DEFAULTS.repairSplits; core/features/bridgeRepair.js): a match
  // graph left in pieces of at least bridgeMinComponent images gets up to
  // bridgePerComponent pairs per piece (bridgeMaxPairs in all) between it and the main
  // block matched again, without the subset gate and with these looser gates. F-RANSAC
  // still verifies every pair; LightGlue gets bridgeLgKeypointScale× the keypoints.
  // Pairs rejected with at least bridgeRetryMinRaw putatives are tried first.
  // A piece hanging on the main block by a thread is repaired too: one apart from it
  // without the pairs of fewer than bridgeWeakInliers inliers, and joined to it by fewer
  // than bridgeWeakCut inliers in all (Starbuck, Jorum: TMA flight lines SfM leaves out).
  // again while the main block grows, each round with fresh pairs
  bridgeRounds: 3,
  // The smallest piece of photos the repair links back to the main block.
  //
  // See bridgeRounds.
  bridgeMinComponent: 2,
  // The repair also links a piece hanging on the main block by a thread: one apart from it
  // without the image pairs of fewer inliers than this (and joined by fewer than
  // bridgeWeakCut inliers in all).
  //
  // See bridgeRounds.
  bridgeWeakInliers: 30,
  // A piece joined to the main block by fewer than this many inliers in all, counting the
  // image pairs under bridgeWeakInliers, is repaired too.
  //
  // See bridgeRounds.
  bridgeWeakCut: 100,
  // The most image pairs the repair matches again in one round, over all pieces.
  //
  // See bridgeRounds.
  bridgeMaxPairs: 48,
  // The most image pairs it matches again per piece.
  //
  // See bridgeRounds.
  bridgePerComponent: 12,
  // Rejected image pairs with at least this many matches before verification are tried
  // first.
  //
  // See bridgeRounds.
  bridgeRetryMinRaw: 8,
  // The ratio test threshold of the repair's matching, looser than the dialog's.
  //
  // See bridgeRounds.
  bridgeRatioThreshold: 0.9,
  // The least inlier ratio an image pair of the repair needs, looser than the dialog's.
  //
  // See bridgeRounds.
  bridgeMinInlierRatio: 0.08,
  // The estimator that verifies the repair's image pairs: 'magsac' or 'ransac'.
  //
  // See bridgeRounds.
  bridgeVerifier: 'magsac',
  // How many times as many keypoints LightGlue uses in the repair.
  //
  // See bridgeRounds.
  bridgeLgKeypointScale: 2,
  // ── Detect gaps again at full size ──
  // Photos of the pieces still apart after the repair that were detected at less than
  // this share of their size are detected again at full size.
  //
  // Detecting gaps again (MATCH_DEFAULTS.gapRedetect; core/features/gapRedetect.js): the
  // SIFT photos of the pieces still apart after bridge repair, detected at under
  // gapMaxScale of their size, are detected again at full size with ≤gapMaxKeypoints
  // (their cap scaled with the area), together with gapPartnerShare as many photos of
  // the main block, those with candidate pairs to most of them. Not when they would be
  // more than gapMaxShare of the photos: detecting everything at full size is then the
  // better run. Starbuck subset, 46 gap photos + 30 partners at 10,400 px: 32 posed.
  gapMaxScale: 0.8,
  // The most keypoints a photo detected again gets (its cap scaled with the area).
  //
  // See gapMaxScale.
  gapMaxKeypoints: 40000,
  // How many photos of the main block are detected again with them, as a share of their
  // count: those with candidate image pairs to most of them.
  //
  // See gapMaxScale.
  gapPartnerShare: 0.65,
  // Skipped when the photos to detect again would be more than this share of all photos:
  // running Detect Features at full size is then the better choice.
  //
  // See gapMaxScale.
  gapMaxShare: 0.5,
  // ── Find turned photos ──
  // Rounds of Find turned photos, repeated while photos join. Each photo of a piece still
  // apart is tested for a quarter turn against photos of the main block.
  //
  // Finding turned photos (MATCH_DEFAULTS.turnSearch; core/features/turnSearch.js): each
  // photo of a piece still apart, and the main-block photos it is probed against (those
  // with overlap evidence, else an even spread, ≤turnProbesPerImage), gets a SIFT look
  // at turnProbeMaxDim px with ≤turnProbeKeypoints keypoints; a probe's homography (RANSAC
  // at turnProbeThreshFrac of the photo's long side: it only has to hold the rotation)
  // counts with ≥turnMinInliers inliers, and a photo takes the quarter turn holding
  // turnMinShare of its probes' inliers. Rounds repeat while photos join.
  turnRounds: 2,
  // The most main-block photos each photo is tested against.
  //
  // See turnRounds.
  turnProbesPerImage: 40,
  // The size (px, long side) the test detects keypoints at.
  //
  // See turnRounds.
  turnProbeMaxDim: 1536,
  // The most keypoints per photo in the test.
  //
  // See turnRounds.
  turnProbeKeypoints: 2000,
  // The test's homography threshold, as a fraction of the photo's long side: loose, as it
  // only has to hold the rotation.
  //
  // See turnRounds.
  turnProbeThreshFrac: 0.01,
  // The fewest inliers for a test to count.
  //
  // See turnRounds.
  turnMinInliers: 20,
  // A photo takes the quarter turn that holds at least this share of its tests' inliers.
  //
  // See turnRounds.
  turnMinShare: 0.6,
  // ── Progress ──
  // The share of the progress bar kept for the gate rescue and the split-graph repair,
  // which follow the pass over the image pairs when they run.
  //
  // core/features/matchProgress.js.
  progressPostShare: 0.1,
}

// Image retrieval for Match Features ▸ Pairing ▸ Similar images (core/features/
// retrieval.js). On South Building (128 images, against COLMAP's exhaustive verified
// pairs) 64 words kept 88.5 % of all inliers at k = 15; 16 words 84.7 %, 256 words 89.6 %
// (4× the encoding and similarity cost); query expansion gained < 1 point. A codebook
// from 20 k descriptors in 8 iterations (4 s in one worker) kept 88.7 %, as 50 k in 15
// (18 s) did: within the ±0.5 points two seeds differ by.
export const RETRIEVAL_TUNING = {
  words: 64, // codebook size (vector length = words × descriptor length)
  trainSamples: 20_000, // descriptors the codebook is learned from, spread over the photos
  minPerImage: 20, // at least this many from each photo
  kmeansIterations: 8, // Lloyd iterations (stops earlier when nothing moves)
  seed: 1, // the codebook's random seed: same project, same pairs
  // Sequential ▸ Find revisits: each image's most similar images added to its window.
  revisitNeighbors: 5,
  // Match Features opens on Similar images for more images than this without camera
  // positions (core/recommend.js initialMatchStrategy). Quarry 347 without priors: 347/347
  // cameras at 8 % of the pairs in half the match time, against 346/347 exhaustively;
  // South Building 128: the same cameras and accuracy either way, so exhaustive stays below.
  autoAboveImages: 200,
  // Similar images: besides its k most similar, each image takes up to k × spreadOut more
  // that spread over the scene (retrieval.js diverseSimilar), from its `diversePool`
  // best. Without them a 1,940-image oblique block (Mill19 building) matched every photo
  // only with its own strip, and a strip of 77 hung off one end, 105–355 m out; with them
  // it is tied to its neighbours (worst camera 5.5 m against PixSfM) for a third more
  // pairs. 128–347-image sets: the same cameras and accuracy, +16–23 % pairs. Few
  // candidates qualify: spreadOut 0.5 and 1 gave nearly the same pairs.
  spreadOut: 1,
  diversePool: 200,
}

// Dense MVS knobs read in core/dense/mvs.js but NOT exposed in DepthMapsModal /
// DenseModal — the user-facing dense defaults live in defaults.user.js
// (DEPTHMAP_DEFAULTS / DENSE_FUSE_DEFAULTS). `settings`/`opts` from the caller override.
export const DENSE_TUNING = {
  // GPU depth maps: how long one GPU command (a band of rows of one pass) may take, in ms.
  // An integrated GPU also draws the screen, and the OS resets one that runs a single
  // command for about 2 s (Windows TDR): long commands froze the display on Intel
  // laptops. A dedicated GPU runs a whole pass within this and is not slowed.
  gpuBandMs: 30,
  // Bands are queued until this many of the browser's fixed waits for finished GPU work
  // (measured per device) are reached before one wait, when that is more than gpuBandMs:
  // Firefox answers on a 100 ms timer, so it queues 400 ms of 30 ms bands per wait.
  gpuWaitsPerQueue: 4,
  // A fixed wait shorter than this (ms) is left out of the band timing.
  gpuWaitMinMs: 1,
  // A first GPU map slower than this (ms) has the second map computed on the CPU to
  // compare, and the run continues on the faster of the two (workers/ops/dense.js).
  gpuProbeMs: 8000,
  // The GPU check on a run's first map (depthMap.js hooks.validate): the median difference
  // between the GPU's final cost and the Rust cost of the same planes (mvs.rs plane_costs).
  // Over gpuCheckWarn the log warns (more than this GPU's rounding explains); over
  // gpuCheckMax the run, and later runs in the session, move to the CPU
  // (workers/ops/dense.js): the GPU computes something else, a broken kernel or driver.
  // Smaller drift between the kernels is the nightly browser suite's to catch
  // (tests/browser/gpu-depth.spec.js, exact f32 on SwiftShader), not a user's run.
  // The median, not the RMS: a hardware sampler's 8-bit filter weights leave a few
  // low-texture pixels far off, so a correct kernel's RMS reaches 7e-3 on an NVIDIA Turing
  // (synthetic scenes, tests/bench/patchmatchCases.js) while its median is ≤ 1.3e-5 there
  // and 1.4e-4 on five Aukerman photos (SwiftShader: ~5e-7). The shader with its homography
  // sign flipped (the old "freckle" bug): 2e-1 on the same photos. Rust against itself with
  // a setting changed: best-K +1 or the other window step 1.5e-4–1.1e-3, a 2 % warp error
  // 5.5e-3–9e-3 (2026-11-04).
  gpuCheckWarn: 1e-3,
  gpuCheckMax: 1e-2,
  // The CPU map of that comparison gives up after a pyramid level once it is on course
  // to take gpuProbeGiveUp× the GPU's time for it (core/dense/gpuProbe.js). Melville,
  // 10,500 px film scans at High: the GPU map 94 s, the CPU map 78 min.
  gpuProbeGiveUp: 2,
  // How often a depth-map run's journal (core/runJournal.js) is rewritten while maps
  // finish: what a dead tab's run can lose and recompute on Continue, against one
  // small JSON write. (A run's `_journalMs` setting overrides it; the tests use 0.)
  journalIntervalMs: 5000,
  coarseLong: 600, // longest-side px at the coarsest pyramid level (sets level count)
  // Bilateral-weighted NCC in PatchMatch (mvs.rs Bilateral), σc in grey levels; 0 = plain
  // NCC. COLMAP uses 0.2 of the range (51). ETH3D six scenes, F1 @2 cm (approximate
  // scorer): plain 52.6, 51 53.2, 25 53.5, 12 53.3, 6 52.3 (narrower: more accuracy, less
  // completeness); official evaluator plain 56.4 → 25 57.1. 25 better than
  // plain on every scene. Aukerman 42 unchanged (roughness, points −0.4 %); GPU time
  // unchanged, CPU +10 % (2026-10-26, docs/METHODS.md §7.1).
  bilateralSigmaColor: 25,
  // Depth maps on the CPU: each map on the threaded build's pool, one worker for the run
  // (mvs.rs sweeps over rows; the same bits as one thread). 640×480, 6 sources, natively:
  // best-K 91.8 → 8.9 s, ACMH 246 → 22.1 s on 20 cores (2026-10-26).
  cpuDepthThreads: true,
  // ACMP planar priors (core/dense/planarPrior.js, depthMapForImage): support points one
  // per priorGrid² cell below priorMaxCost, then priorIterations sweeps from the finished
  // map with the prior in the cost (the paper's α, γ, σ_n; σ_d = range / 64). ETH3D +0.7
  // F1 (3 sweeps; 5 gave +0.8). On or off is the Method's (DEPTHMAP_DEFAULTS.method, the
  // store resolves it); `planarPrior` here is only the fallback of a call that names none.
  planarPrior: false,
  priorGrid: 5,
  priorMaxCost: 0.1,
  priorAlpha: 0.18,
  priorGamma: 0.5,
  priorSigNDeg: 5,
  priorIterations: 3,
  priorPerturbStart: 0.125,
  // The geometric-consistency pass (depthMap.js geomDepthMapForImage; mvs.rs Geom): ACMP's
  // λ 0.1, cap 5 px, 2 sweeps from the saved first-pass maps (ETH3D +2.0 F1 on ACMH +
  // prior maps); the worker keeps the last geomDepthCache neighbour depth planes it read.
  geomDepthCache: 24,
  geomWeight: 0.1,
  geomMaxPx: 5,
  geomIterations: 2,
  geomPerturbStart: 0.0625,
  // Step between PatchMatch window samples (mvs.rs Patch): 1 = every pixel, 2 = every other
  // row and column (COLMAP / ACMM). Measured 2026-10-26 (ETH3D six scenes, official
  // evaluator, GPU, ACMH): 7×7 step 1 63.4; radius 5 step 2 61.9, radius 4 step 2 62.1,
  // both ~30 % faster — a speed knob, not a default.
  windowStep: 1,
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
  // The cross-view filter over saved maps takes at most one worker per this many maps
  // (and no more than the pool or the memory budget holds): contiguous chunks keep each
  // worker's candidate planes warm. It hardly matters on the sets where it binds: 48 quarry
  // maps at Medium, 3 workers, filter 16.8 s of a 1,872 s depth run (2026-10-24).
  filterMapsPerWorker: 16,
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
  // Most workers fusion splits over (store densifyParallel; at most POOL_SIZE, fewer when
  // the plan cannot hold their inputs in the budget and the tab's buffer pool). It was 1
  // while 8 workers ran slower (quarry 630 vs 557 s, bound by plane reads); with the view
  // cap, light pre-passes and slabs in shared memory, quarry at Medium (347 maps, 95 M
  // points) 478 → 308 s, at half the merge cell (208 M points) 922 → 200 s, the same cloud.
  fuseWorkers: 8,
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
  // The parallel depth filter's comparison cache per worker (stores/reconstruction/
  // dense.js densifyParallel): a quarter of the budget split over the workers, at most
  // this. An eighth of the budget split K ways starved the cache (96 MB each on quarry).
  densifyCacheMaxMiB: 512,
}

// Mesh (screened Poisson) internals read in core/products/mesh.js but NOT exposed in
// MeshModal — the user-facing knobs (depth/screening/trim/fillHoles/removeFloaters/
// colorize) live in defaults.user.js (MESH_DEFAULTS). `settings` from the caller override.
export const MESH_TUNING = {
  // Octree depth Auto (products/mesh.js autoMeshDepth): the depths it picks from, and the
  // one it uses when the cloud's spacing or extent is unknown.
  autoDepthRange: [6, 11],
  autoDepthFallback: 8,
  // Triangles per covered leaf in predictMeshTriangles, fitted on six meshes (aerial
  // blocks, subsets, a close-range object): the prediction is 0.9–1.4× the real count.
  trianglesPerLeaf: 1.6,
  // A depth set by hand that predicts more triangles than this gets a warning: an 11 M
  // triangle mesh outgrew the 32 GB a tab had after its solve (2026-11-09).
  warnTriangles: 4_000_000,
  colorSearchRadius: 1, // vertex-colour transfer: search ±N voxel cells (3³ nhood)
  // Tiled Poisson (meshTiles.js, MESH_DEFAULTS.tiles 'auto'): a scene whose solve would
  // pass what one solve holds (the worker's `oneSolveBytes`: ~12 GiB with Memory64, the
  // 32-bit heap otherwise) is solved in tiles of at most `tileHeapBytes` each, which the
  // faster 32-bit build holds, with at least `tileOverlapCells` leaves of overlap: the
  // density trim's support cell is 4 leaves and reaches 2 cells, plus a cell of lattice
  // rounding. Where a trimmed border (a hole) crosses a seam, the tiles can still decide
  // the refill differently and leave short open edges there (synthetic terrain with holes:
  // +1.7 % open seam-band edges at 8 leaves, +0.6 % at 12; none without holes).
  tileHeapBytes: 3 * 2 ** 30,
  tileOverlapCells: 12,
  oneSolveBytes: 3.5 * 2 ** 30,
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
// DEM and orthophoto size at Auto (core/products/rasterSize.js). A DEM keeps about one
// point per cell; past one 4,096 plane it is built in blocks, up to `demAutoMaxSide`. An
// ortho is `orthoAutoPhotoPx` photo pixels a cell, the photos then read at about native
// resolution, up to `orthoAutoMaxSide` (never coarser than its surface). Quarry, 347
// photos (2026-11-09): DEM 4,096 → 6,305 px 40 → 78 s; ortho 4,096 → 12,600 px
// 253 → 469 s, the tab at 9.1 → 13.2 GB, GeoTIFF 31 → 260 MB.
export const RASTER_TUNING = {
  demAutoMaxSide: 8192,
  orthoAutoPhotoPx: 2,
  orthoAutoMaxSide: 16384,
}

// The 2D map's Photos layer and photo ground grids (core/products/photoGrid.js).
//   gridCells     cells a side of the grid each aligned photo is cast on the ground with:
//                 its mesh follows relief and lens at this spacing, 12 → 169 rays a photo
//   heightCellPts sparse points the height surface wants per cell on average; its cell
//                 is √(area / points × this), so a median of several decides each cell
//   heightMinPts  fewer points than this leave a cell to be filled from its neighbours,
//                 so a lone stray point never sets a height
//   heightMaxSide longest side of the height surface in cells
export const PHOTO_GRID_TUNING = {
  gridCells: 12,
  heightCellPts: 8,
  heightMinPts: 3,
  heightMaxSide: 512,
}

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
  // GPU vs CPU depth on the first view the mesh covers enough of to judge (at least
  // gpuCheckCoverage of its grid): below gpuAgreeMin of the covered pixels agreeing, the
  // run falls back to the CPU pass (workers/ops/texture.js). Rasterisers differ by a
  // pixel along occluder edges, which weigh more among covered pixels than among all of
  // them. A view that covers less is not judged: it takes the CPU pass, and the next
  // view is checked.
  gpuAgreeMin: 0.95,
  gpuCheckCoverage: 0.02,
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
  // Decoded tiles of tiled-pyramid photos (a native scan past the canvas limit; the
  // fiducial and GCP windows revisit the same tiles), kept in EACH compute worker
  // (workers/rasterSource.js): the pool may hold this many times its size.
  rasterTileCacheMiB: 256,
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

// Cloud and mesh exports (composables/exports/clouds.js): from this estimated size on,
// Chrome and Edge ask where to save before the export runs and write the file there
// (core/io/exportSize.js), instead of a download of the finished file.
export const EXPORT_TUNING = {
  savePickerMinMiB: 256,
  // Export ▸ Allmaps reads each photo's IIIF info.json for its served size; a server
  // that has not answered in this long counts as not reached (the photo keeps its size).
  iiifInfoTimeoutMs: 15_000,
}

// Tools ▸ Images ▸ Image quality (core/features/imageQuality.js). The sharpness score is
// the Laplacian variance of the image resampled to `analysisMaxDim` (a fixed unit across
// cameras), over a `tiles`×`tiles` grid. The blur threshold is a user setting
// (defaults.user.js IMAGE_QUALITY_DEFAULTS.minRelative).
export const IMAGE_QUALITY_TUNING = {
  analysisMaxDim: 1024,
  tiles: 4,
  // Luma at or above this (of 255) counts as clipped highlight, at or below
  // `underexposedLevel` as crushed shadow.
  overexposedLevel: 250,
  underexposedLevel: 5,
  // A tile needs this many valid Laplacian samples to report a variance.
  minTileSamples: 16,
  // Over- or underexposed when that share of valid pixels is clipped.
  maxClipped: 0.25,
}

// Find GCPs ▸ Sentinel-2 (core/sentinel2.js, workers/ops/io.js fetchSentinel2Window).
export const SENTINEL2_TUNING = {
  searchLimit: 50, // scenes asked of the catalogue
  // The window read around the search area: a quarter of its larger side, at least
  // `minPad` m, and at most `maxPx` 10 m pixels a side (60 km: 3 × 6,000² 16-bit
  // reads, about 200 MB).
  padFraction: 0.25,
  minPad: 1000,
  maxPx: 6000,
  // The stretch to 8 bits: these quantiles of the valid reflectances.
  loQ: 0.005,
  hiQ: 0.995,
}

// Co-register DEM ▸ Copernicus DEM (core/copernicusDem.js, workers/ops/io.js
// fetchCopDemMosaic). The box read around the DEM: a tenth of its larger side, at least
// `minPadDeg` (about 1 km), so a DEM that is shifted still lies on the reference; at most
// `maxPx` 1″ cells a side (about 180 km, a 140 MB Float32 grid).
export const COP_DEM_TUNING = {
  pad: 0.1,
  minPadDeg: 0.01,
  maxPx: 6000,
}

// Classify Points ▸ vegetation and buildings (core/products/pointClasses.js). Lengths
// in metres. The features are computed on voxel centroids: `voxel` sets the cost (a
// dense cloud's points collapse to a few per voxel), `radius` the neighbourhood the
// covariance sees (a roof plane is flat over a metre; a canopy is not).
export const CLASSIFY_TUNING = {
  voxel: 0.25,
  radius: 1,
  // A plane: (λ2 − λ3)/λ1 at least this, λ3/λ1 at most `maxScatter`. Above that
  // scatter a voxel reads as vegetation.
  minPlanarity: 0.5,
  maxScatter: 0.06,
  // Neighbouring plane voxels join one segment when their normals agree within this.
  normalAngleDeg: 20,
  // Mean ExG (2g − r − b on chromatic coordinates) above which a voxel is green.
  greenExg: 0.06,
  // A segment whose mean |normal z| is below this is a wall (steeper than about 60°): a
  // building only beside a roof.
  wallNormalZ: 0.5,
}

// Adding photos to a project in browser storage (core/io/folderProject.js bigImportOffer):
// from this many GiB of photos in the project, counting the ones being added, WebSfM
// offers to move it to a folder on disk first, once per project and page. Keypoints,
// matches, depth maps and products come to several times the photos, and a browser may
// cap or clear its storage; a folder is bounded by the disk alone.
export const FOLDER_OFFER_TUNING = {
  photosGiB: 3,
}

// Import ▸ Project into this project (composables/useProjectMerge.js).
export const PROJECT_IMPORT_TUNING = {
  // Photos read and ingested at a time: the page never holds a whole project as blobs.
  photosPerBatch: 16,
}

// Adding photos, masks and reference rasters (stores/images/ingest.js, maskImport.js,
// thumbnails.js; workers/ops/io.js).
export const IMPORT_TUNING = {
  // Photos whose stored copies are looked up at a time after an import: the lookups are
  // storage round trips (~5 ms each, measured on 300 images).
  readBackConcurrency: 16,
  // TIFF transcodes in flight, bounded by pixels rather than by count. Each holds the
  // decoded RGBA, its canvas and the JPEG + PNG encodes (~12 bytes per pixel), all in
  // the renderer process (the workers share it). A batch used to transcode all its
  // files at once: 32 Iceland 1980 scans (130 MP each) killed the renderer, and with
  // GPU canvas the overlapping readbacks failed 31 of 125 images. A file larger than
  // the budget still runs, alone.
  tiffTranscodePixels: 400e6,
  // The share of the tab's buffer pool a mask import may hold; image transcodes of the
  // same folder may still be running beside it.
  maskPoolShare: 0.25,
  // Thumbnails generated at a time, in their own worker (workers/thumbnail.worker.js).
  thumbnailConcurrency: 2,
  // Import ▸ Reference raster: the memory a conversion to a tiled COG may decode the
  // source into; a source needing more is used as it is.
  rasterConversionMiB: 512,
}

// File ▸ Save project file (utils/projectFile.js): archived files up to this size are
// read into memory once, so the archive holds the version they had when it started.
export const PROJECT_FILE_TUNING = {
  snapshotInMemoryMiB: 64,
}

// Tools ▸ Cloud and Mesh edits (stores/reconstruction/cloudEdits.js).
export const CLOUD_EDIT_TUNING = {
  // Undo of point edits in the 3D view (core/editHistory.js): at most this many steps
  // back, holding at most this many bytes of replaced points between them (the last step
  // is always kept). A step of a 25 M-point cloud holds ~400 MB, so the bytes bind first
  // on dense clouds and the steps on small ones.
  undoSteps: 10,
  undoBytes: 2 ** 30,
  // Steps of a streamed cloud keep its old octree files on disk (gigabytes for a big
  // cloud) instead of points in memory: at most this many of them.
  undoStreamedSteps: 3,
  // A crop of a streamed cloud becomes a resident one: at most this many points.
  streamedCropMaxPoints: 25_000_000,
  // From this many points the outlier filter and normals split the cloud into slabs over
  // the worker pool (each slab with a margin); below it one worker is as quick.
  splitMinPoints: 1_000_000,
  splitPointsPerWorker: 400_000,
  // From this many triangles Decimate splits an untextured mesh into blocks over the pool
  // (core/products/meshBlocks.js), each worker taking at least splitTrianglesPerWorker.
  decimateSplitMinTriangles: 500_000,
  splitTrianglesPerWorker: 250_000,
  // A streamed REFERENCE (alignment, distance) is read where the source is, at full
  // detail up to this many points, coarser beyond (the log says so).
  streamedReferenceMaxPoints: 12_000_000,
}

// Tools ▸ Georeferencing ▸ Find GCPs, the learned look (workers/ops/referenceGcps.js).
export const FIND_GCPS_TUNING = {
  // The coarse look reads both rasters at up to this many samples a side.
  coarseDim: 1536,
  // A learned look reads both rasters at up to learnedDim samples a side (a 4-band
  // orthophoto read stays inside rasterWindow's 16 M-sample budget), detects in tiles
  // of learnedTile px and gives LightGlue the strongest lightglueKeypoints of each.
  learnedDim: 2000,
  learnedTile: 1024,
  lightglueKeypoints: 2048,
  // A learned look counts when this many matches agree on one homography (hist-sfm's
  // minimum); wrong rotations on Rachel gave at most 8.
  learnedMinInliers: 20,
}

// Tools ▸ Products ▸ Co-register DEM… (core/products/demCoregistration.js).
export const COREG_TUNING = {
  // DEM cells used, on a regular sub-grid: each costs about a dozen reference samples,
  // and 20,000 pin a metre-scale shift (as Quality Report ▸ DEM vs reference).
  maxPoints: 20000,
  // Fewer cells with a reference height than this: no co-registration.
  minPoints: 200,
  // Nuth & Kääb on slopes in this range (flat ground shows no shift, cliffs are noise),
  // until the step is under `tolerance` of a cell, at most maxIterations passes.
  minSlopeDeg: 5,
  maxSlopeDeg: 45,
  maxIterations: 8,
  tolerance: 0.05,
  // The tilt fit keeps cells within this many NMAD of the median, then of the first fit.
  trimNmad: 3,
  // Points kept with a co-registered georeference, to compose it again after a refit.
  anchors: 200,
}

// Sidebar ▸ Sensors: which camera groups may hold photos of more than one camera
// (core/sensors/splitSuggestions.js).
export const SENSOR_TUNING = {
  // A new group with fewer photos than this is marked small: self-calibration frees the
  // principal point only from 10 cameras on (core/sfm/selfCalSchedule.js cxcyMinCams).
  splitMinImages: 10,
  // A scan batch has one exact size (Melville: 10137, 10140 and 10141 px wide were three
  // cameras). Exact sizes count when at least exactShare of the photos share theirs with
  // exactMinPhotos or more; otherwise the frames were cropped one by one, and sizes that
  // differ by less than formatTolFrac in both dimensions are one format.
  exactMinPhotos: 3,
  exactShare: 0.9,
  formatTolFrac: 0.01,
  // A roll whose median fiducial residual is this many times the rest's, and over half a
  // scan pixel, fits the group's mark layout badly (Melville: 171 µm against about 30).
  fiducialMisfitFactor: 3,
}

// Tools ▸ Images ▸ Detect targets ▸ AprilTag (core/sfm/tagDetect.js, workers/ops/targets.js
// detectTagsInPhoto).
export const TAG_DETECT_TUNING = {
  // The photo is searched in native tiles of `tile` px overlapping by `overlap`: a tag up
  // to `overlap` px across lies whole in the tile whose core holds its centre, and a
  // worker holds a few tile-sized buffers instead of the whole photo's.
  tile: 2048,
  overlap: 400,
  // Larger tags are found in the photo downscaled to `tile` px.
  minSide: 16,
  // Wrong bits a tag may have (tag36h11 tells codes apart by 11; 2 keeps false tags out).
  // A 4×4 ArUco dictionary reads exactly (tagDetect.js): with one bit corrected, 5 % of
  // random patterns inside a dark ring decode to some id of 4x4_50.
  maxHamming: 2,
  // With a model, a tag farther than max(gateMinPx, gateFrac × the photo's long side)
  // from its GCP's predicted place is not placed (useDetectTargets.js runTags).
  gateMinPx: 40,
  gateFrac: 0.02,
}

// Text on the photographs (core/ocr/: Auto Mask ▸ Text and the text read from the
// photos). The detector and recogniser are PaddleOCR's PP-OCRv5 mobile models; the DB
// post-processing values are theirs (inference.yml ▸ DBPostProcess).
export const OCR_TUNING = {
  // A photograph is searched at most this many px on its long side: about 1/4 of a
  // 10,000 px film scan, where the printed data line is 20-30 px high, which the
  // detector reads best; a smaller photo is searched as it is.
  detMaxDim: 2560,
  // The detector reads tiles of `detTile` px overlapping by `detOverlap`, so a worker
  // holds one tile's activations, not the whole scan's.
  detTile: 960,
  detOverlap: 128,
  detThresh: 0.3, // probability above which a pixel is text
  detBoxThresh: 0.6, // mean probability a box needs
  unclipRatio: 1.5,
  detMinSize: 3, // px, the shorter side of a box
  detMaxCandidates: 1000,
  // A box this many times taller than wide is a line running up or down the photo.
  verticalRatio: 1.5,
  // A line cut out wider than this many px (at 48 px high) is read only so far.
  recMaxWidth: 1600,
  recBatch: 16,
}

// Auto Mask ▸ Frame (core/maskFrame.js): finding the film frame on a scan.
export const FRAME_MASK_TUNING = {
  maxDim: 1024, // px on the long side the scan is searched at
  maxFrac: 0.25, // the frame is looked for within this share of each side
  band: 0.6, // a side's profile is the median across this middle share of the other axis
  minContrast: 0.15, // a frame darker than the photograph by less, over the scan's range, is none
  photoRun: 0.03, // the photograph begins where the profile stays bright this share of the side
  frameStart: 0.05, // the dark frame begins within this share of the edge (a scanner bed is narrower)
  groupTolerance: 0.015, // a side this share of the scan off its group's median takes the median
}
