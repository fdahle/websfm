// User-facing default settings — single source of truth for values a *user* can
// change from a modal. The rule (see CLAUDE.md ▸ Conventions): every knob here is
// prefilled by its modal AND used as the core fallback, so the two can never drift.
// Nothing here is a "dev-only" tuning number — those live in `tuning.js`.
//
// Pure data module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged and
// core code can import it directly.

// Tie-point (feature) detection — SIFT. Mirrored by DetectFeaturesModal.vue's
// `siftSettings` ref. NOTE: the worker op (workers/ops/detect.js) keeps its own,
// intentionally-different fallbacks (e.g. tileSize 0 ⇒ auto-derive) — that op is the
// defensive floor, not this user-facing prefill, so the two are allowed to differ.
// Resolution/budget note (2026-07-24): these were originally set for hand-held photo
// sets and were far too conservative for the aerial + scanned-film work this app
// targets. A 10137×9600 film scan detected at 1200px throws away ~98.6% of the pixels,
// and the resulting ~6k keypoints are too few to constrain self-calibration (the CA…V
// run finished with 45 points, all 2-view). Measured cost at 5000px on that set was
// ~2.6 s/image, so the old ceiling was not buying speed that mattered. For reference,
// Metashape's defaults are full image resolution with a 40,000 key point limit.
export const DETECT_SIFT_DEFAULTS = {
  maxDim: 2400, // longest side the detector runs at (px)
  // 'absolute' ⇒ maxDim as written, for every image (the historical behaviour).
  // 'auto' ⇒ a fraction of each image's OWN native size, clamped into a per-preset
  // band whose floor IS the absolute value above — so auto can only add resolution
  // to large images, never take it away. See core/features/detectResolution.js.
  maxDimMode: 'absolute',
  // DoG response floor (lower = more, weaker keypoints). COLMAP's 0.0067 was tried and
  // reverted (2026-10-16, HANDOVER ▸ B-full-2026-10-16): with the pair-focal estimate and
  // the registration check in, it registered at most 1–2 more cameras on full blocks,
  // was less accurate on ETH3D courtyard (6.5 → 8.9 mm) and pipes (2.9 → 17 mm), and
  // cost +40–70 % matching time.
  contrastThreshold: 0.01,
  maxKeypoints: 10000, // per-image cap (strongest kept)
  // Detect a faint image (under half the cap) again at half the contrast threshold
  // (core/features/faintRetry.js). More cameras and smaller errors on interiors and
  // plain surfaces (ETH3D office 18 → 20 of 26 cameras), for more matching time where
  // it triggers (quarry, 53 of 347 images: +31 % exhaustive). Off = one detection.
  faintRetry: true,
  tiling: 'off', // 'off' | 'on' — tiled detection for very large images
  tileSize: 1024, // max tile edge (px) when tiling is on
  overlap: 64, // min tile overlap (px); kept keypoints sit ≥ overlap/2 from a cut
}

// Tie-point detection — SuperPoint (no contrast knob; learned threshold is baked in).
// Mirrored by DetectFeaturesModal.vue's `superpointSettings` ref.
export const DETECT_SUPERPOINT_DEFAULTS = {
  maxDim: 1600, // raised with SIFT's, but far less: the cap below binds first
  maxDimMode: 'absolute', // see DETECT_SIFT_DEFAULTS.maxDimMode
  maxKeypoints: 2048, // LightGlue attention is O(N²) — 2048 is the usual sweet spot
  tiling: 'off',
  tileSize: 1024,
  overlap: 64,
}

// Detection quality presets (deltas over the per-detector defaults; medium ≡ defaults).
// One shared card set (meta), two delta maps — the modal applies whichever matches the
// active detector. Only resolution + keypoint budget vary (contrast too for SIFT).
// Brute-force matching is O(Na·Nb), so the keypoint cap costs quadratically at the
// NEXT stage — that, not detection time, is what bounds the Detailed preset.
export const DETECT_SIFT_PRESETS = {
  low: { maxDim: 1400, maxKeypoints: 5000, contrastThreshold: 0.02 },
  medium: {},
  high: { maxDim: 4000, maxKeypoints: 25000, contrastThreshold: 0.005 },
}
// SuperPoint is capped much lower on purpose: LightGlue's attention is O(N²) in
// keypoints, so its budget is a hard constraint rather than a speed/quality dial.
export const DETECT_SUPERPOINT_PRESETS = {
  low: { maxDim: 1200, maxKeypoints: 1024 },
  medium: {},
  high: { maxDim: 2400, maxKeypoints: 4096 },
}
// Tie-point detection — DISK (learned, Apache-2.0; pairs with its own LightGlue).
// Lower resolution than SuperPoint: DISK's U-Net keeps 128 feature channels at FULL
// input resolution (SuperPoint downsamples 8× first), so memory per pixel is far
// higher. 1024 px is the resolution DISK and LightGlue were evaluated at.
export const DETECT_DISK_DEFAULTS = {
  maxDim: 1024,
  maxDimMode: 'absolute',
  maxKeypoints: 2048, // same LightGlue O(N²) budget as SuperPoint
  tiling: 'off',
  tileSize: 1024,
  overlap: 64,
}
export const DETECT_DISK_PRESETS = {
  low: { maxDim: 768, maxKeypoints: 1024 },
  medium: {},
  high: { maxDim: 1600, maxKeypoints: 4096 },
}
// Tie-point detection — ALIKED (learned, BSD-3-Clause; pairs with its own LightGlue).
// Same memory profile as DISK: 128 feature channels at FULL input resolution. 1024 px
// is the resolution cvg/LightGlue resizes ALIKED's input to.
export const DETECT_ALIKED_DEFAULTS = {
  maxDim: 1024,
  maxDimMode: 'absolute',
  maxKeypoints: 2048, // same LightGlue O(N²) budget as SuperPoint
  tiling: 'off',
  tileSize: 1024,
  overlap: 64,
}
export const DETECT_ALIKED_PRESETS = {
  low: { maxDim: 768, maxKeypoints: 1024 },
  medium: {},
  high: { maxDim: 1600, maxKeypoints: 4096 },
}
// Per-detector lookup, so callers never branch on a detector id.
export const DETECT_DEFAULTS_BY_DETECTOR = {
  sift: DETECT_SIFT_DEFAULTS,
  superpoint: DETECT_SUPERPOINT_DEFAULTS,
  disk: DETECT_DISK_DEFAULTS,
  aliked: DETECT_ALIKED_DEFAULTS,
}
export const DETECT_PRESETS_BY_DETECTOR = {
  sift: DETECT_SIFT_PRESETS,
  superpoint: DETECT_SUPERPOINT_PRESETS,
  disk: DETECT_DISK_PRESETS,
  aliked: DETECT_ALIKED_PRESETS,
}
export const DETECT_PRESET_META = [
  { id: 'low', label: 'Fast', blurb: 'Lower resolution, fewer keypoints' },
  { id: 'medium', label: 'Balanced', blurb: 'Default resolution and cap' },
  { id: 'high', label: 'Detailed', blurb: 'Higher resolution, more keypoints — slower' },
]

// Tie-point matching (crates/matching via useMatchesStore). Mirrored by
// MatchFeaturesModal.vue's `settings` ref. Internal-only match knobs (not shown to the
// user) live in tuning.js ▸ MATCH_TUNING.
export const MATCH_DEFAULTS = {
  // Lowe ratio test. 0.8 = COLMAP's default. Measured five times against 0.75 (HANDOVER
  // ▸ B-bench, B-match-gpu): +5 % ≥3-view points on South Building at unchanged error,
  // and eagle registers 43/44 cameras at 0.8 but 29/44 at 0.75.
  ratioThreshold: 0.8,
  // Mutual-nearest-neighbour cross-check. ON by default (COLMAP parity): without it a
  // brute-force pass is one-directional, so many A keypoints may claim the SAME B
  // keypoint. Those many-to-one putatives (a) inflate the raw count and depress every
  // pair's inlier ratio, and (b) let F-RANSAC fit a degenerate model through a pencil of
  // epipolar lines — the signature the `inlierSpread` gate then rejects as "positional
  // collapse" (always A-side-full / B-side-collapsed, never the reverse: see the
  // 2026-07-17 building baseline). Cross-check removes the cause rather than the symptom.
  crossCheck: true,
  // Drop putatives that sit at (almost) the same pixel in both images (Metashape's
  // "filter stationary points"): fiducials, frame and data strip, reseau crosses,
  // scanner dust — fixed to the camera, not the scene (core/features/stationary.js).
  // Off by default while it is measured; tolerance in tuning.js ▸ stationaryTolPct.
  filterStationary: false,
  minMatches: 15, // min surviving matches to keep a pair
  geometricVerification: true, // run F-RANSAC verification
  // F-RANSAC inlier threshold, in **detection pixels** — i.e. at the resolution the
  // keypoints were measured at, not at native image resolution. useMatchesStore
  // resolves it per pair via core/scaleContext.js (× the coarser image's 1/scale).
  // A set detected at full resolution is unaffected; a film scan detected at ¼ gets
  // a gate 4× wider in native px, which is what keeps it above the measurement
  // quantum instead of below it. See scaleContext.js for the full argument.
  ransacThreshPx: 2.0,
  // Reject pairs whose inlier fraction is below this. COLMAP has no ratio gate at all
  // (only min_num_inliers=15) and verifies ~3× more pairs on the building set — that tail
  // of 15–40-inlier pairs is what carries its 3.6 mean track length vs our 2.6. 0.15 keeps
  // a guard against the ~0.06 spurious fits while re-admitting the tail.
  minInlierRatio: 0.15,
  maxIters: 1000, // F-RANSAC iterations
  // Robust estimator for the F (and H-vs-F) fit: 'ransac' — inlier count + local
  // optimisation — or 'magsac' — MAGSAC++ (σ-marginalised loss, IRLS polish;
  // crates/matching/src/magsac.rs). Inliers are within ransacThreshPx either way.
  verifier: 'ransac',
  preselectMethod: 'position', // preselect: 'position' (nearest cameras) | 'footprint' (ground overlap)
  maxNeighbors: 10, // preselect (position): k-nearest cameras to consider per image
  minOverlap: 30, // preselect (footprint): min ground-overlap % (of the smaller footprint) to keep a pair
  sequentialOverlap: 10, // sequential: match each image to the next N capture-order images
  sequentialLoopClosure: false, // circular sequence: also connect its end back to its start
  lgMaxKeypoints: 2048, // per-image cap fed to LightGlue (plain path)
  lgTiled: false, // coarse-to-fine tiled guided matching (full density)
  lgTileBudget: 2048, // max keypoints per tile side when tiled (attention budget)
  subsetGate: true, // cheap coarse pre-test to skip non-overlapping pairs
  // MINIMUM spatially-uniform keypoints per image in the pre-test. The actual
  // sample is sized per pair from the real keypoint counts
  // (core/features/subsetGate.js resolveSubsetGateSize) so the sampling *fraction*
  // — and therefore the meaning of subsetGateThreshold below — stays constant.
  // A fixed size makes the gate ~1/N more severe as keypoint counts rise; at the
  // Detailed detection preset a fixed 200 would veto nearly every pair.
  subsetGateSize: 200,
  // Min subset putatives required to run the full match. Only meaningful together
  // with a stable sampling fraction (see subsetGateSize) — this is a count drawn
  // from a sample, not from the full keypoint sets.
  subsetGateThreshold: 8,
  // When matching leaves the block in pieces, match the most promising pairs between
  // each piece and the main block again with looser gates (core/features/bridgeRepair.js;
  // limits in tuning.js ▸ bridge*).
  repairSplits: true,
  // Keep the result of every pair already matched and match only the others: what adding
  // photos to a matched project needs. The dialog turns it on by itself when some images
  // with features are in no pair yet (stepEffects/match.js onlyNewPairsDefault).
  onlyNewPairs: false,
}
// Matching quality presets — tune the geometric-verification strictness (deltas over
// the defaults; medium ≡ defaults). Strategy/matcher are separate primary choices, not
// preset-controlled. ratioThreshold is inert on the LightGlue path (no ratio test there).
export const MATCH_PRESETS = {
  low: { ratioThreshold: 0.85, minInlierRatio: 0.1 },
  medium: {},
  high: { ratioThreshold: 0.75, minInlierRatio: 0.25, maxIters: 2000 },
}
export const MATCH_PRESET_META = [
  { id: 'low', label: 'Lenient', blurb: 'More matches, looser verification' },
  { id: 'medium', label: 'Balanced', blurb: 'Default ratio and inlier gates' },
  { id: 'high', label: 'Strict', blurb: 'Fewer, high-confidence matches' },
]

// Sparse reconstruction (crates/reconstruction via core/sfm/sfm.js).
// Mirrored by ReconstructModal.vue's `settings` ref.
export const RECONSTRUCT_DEFAULTS = {
  minMatchesForRegistration: 20, // min correspondences to a registered image to try PnP
  // Reprojection inlier threshold, in **detection pixels** (see ransacThreshPx).
  // core/sfm/sfm.js resolves it once per run against the set's median detection
  // scale and hands the native-px value to the PnP gates, interim BA and the track
  // filter. RECONSTRUCT_PRESETS below patch it in the same detect-px unit.
  reprjThreshold: 4.0,
  baIterations: 30, // bundle-adjustment iterations
  // BA self-calibration: 'auto' | 'none' | 'f' | 'f,cxcy' | 'f,k1'. 'auto' (the
  // default) resolves in core/sfm/sfm.js to 'f,k1' when no sensor carries a
  // calibrated distortion model (EXIF-only cameras / film scans — solve one shared
  // focal + radial k1 rather than trusting a guessed pinhole), and to 'none' when a
  // calibrated Brown model already exists (don't double-correct).
  refineIntrinsics: 'auto',
}

// Quality presets (WS5): per-modal deltas OVER the defaults above, so `medium` ≡ the
// defaults (empty delta) and the single-source-of-truth contract is preserved. A modal's
// PresetCards applies `{ ...DEFAULTS, ...PRESET[id] }`; editing any field afterwards
// flips the selector to 'custom'. Values are UI units (same as the defaults they patch).
export const RECONSTRUCT_PRESETS = {
  low: { baIterations: 15, reprjThreshold: 6.0 }, // fast: fewer BA iters, looser gate
  medium: {}, // = RECONSTRUCT_DEFAULTS
  high: { baIterations: 60, reprjThreshold: 3.0 }, // thorough: more iters, tighter gate
}
// Card metadata for the PresetCards hero (label + one-line "what you get"). Ordered.
// Kept beside the deltas so a preset's copy and its values live together.
export const RECONSTRUCT_PRESET_META = [
  { id: 'low', label: 'Low', blurb: 'Faster · looser gate, fewer BA iterations' },
  { id: 'medium', label: 'Medium', blurb: 'Balanced default for most projects' },
  { id: 'high', label: 'High', blurb: 'Slower · tighter gate, more BA iterations' },
]

// Dense — Stage A depth maps (PatchMatch MVS). Mirrored by DepthMapsModal.vue.
// NOTE: values here are UI units; the modal's run() transforms some before dispatch
// (filterRelTol is a %, ÷100 on run; maxDim/bestK null ⇒ store/worker auto-derive).
export const DEPTHMAP_DEFAULTS = {
  quality: 'medium', // low = ⅛, medium = ¼, high = ½, ultra = full native
  maxDim: null, // advanced override; null ⇒ derive from quality
  // Source views per image and PatchMatch sweeps: 6 → 10 and 3 → 5 on 2026-10-25. ETH3D
  // (six scenes, from the ground-truth cameras, ETH3D's own evaluator) mean F1 @2 cm
  // 53.6 → 56.4, every scene better (office 37.8 → 43.0); the 11×11 window
  // and a larger best-K did not help. Depth time: GPU +9 % (Aukerman 42), CPU 2.2×.
  maxSources: 10, // source views per image
  window: 3, // ZNCC half-window (7×7)
  iterations: 5, // PatchMatch sweeps
  // The PatchMatch method: 'full' = ACMH view selection, then ACMP's planar prior and
  // geometric-consistency pass (Xu & Tao 2019, 2020); 'fast' = best-K, one pass; 'auto' =
  // full on the GPU, fast on the CPU (core/dense/depthMap.js resolveDepthMethod). ETH3D
  // (six scenes, ETH3D's own evaluator, Medium, F1 @2 cm, object defaults): fast 62.0,
  // full 66.2, every scene better; depth time ~2.2–3× on the GPU, more on the CPU
  // (2026-10-26).
  method: 'auto',
  bestK: null, // advanced override; null ⇒ auto per image
  speckleFilter: true, // median/speckle cleanup on each depth map
  filterRelTol: 10, // speckle relative tolerance, % (÷100 on run)
  // ── Cross-view geometric consistency (COLMAP's filter pass; mvs.js
  // filterDepthMapsGeometric). Runs once after all maps exist and zeroes rejected
  // pixels in the maps themselves, so the orthophoto (which reuses them as a
  // z-buffer) is cleaned too. This is the filter that removes sky/vegetation
  // freckles — the photometric gates below cannot: a bush has genuinely high NCC.
  geomConsistency: true, // enable the cross-view check
  maxGeomCost: 1.0, // max forward–backward reprojection error (px) to call a view consistent
  // Min other views that must agree to keep a pixel; null = auto by the project's scene
  // type (DEPTHMAP_MIN_CONSISTENT_AUTO). One view on close range: ETH3D (six scenes, ETH3D's
  // own evaluator, F1 @2 cm) 57.1 → 62.0, every scene better (office 43.2 → 55.2), the
  // clouds far more complete for −1…−11 pt accuracy. Two on aerial blocks: on a 42-image
  // block one view let ~12 % of the extra points sit far off the surface (no aerial
  // ground truth to settle it, 2026-10-26).
  minConsistent: null,
  minGeomAngleDeg: 3.0, // a view only counts if it sees the point at ≥ this parallax (COLMAP's
  // filter_min_triangulation_angle) — near-duplicate views can't vouch for sky
  minNcc: 0.1, // absolute per-pixel ZNCC floor (drops cost > 1 − minNcc)
  // Keep a saved depth map whose camera and settings are unchanged (core/dense/
  // depthReuse.js): after Add to the model ▸ Fixed only the new images' maps are
  // computed, and the check across views runs over all of them. Off computes every map.
  keepMaps: true,
}
// "auto" consistent views (DEPTHMAP_DEFAULTS.minConsistent null) by project scene type.
export const DEPTHMAP_MIN_CONSISTENT_AUTO = { object: 1, aerial: 2 }

// Depth-map quality cards. Unlike the other presets these are NOT deltas — `quality` is
// itself a first-class setting the store resolves to a working resolution; the cards are
// a nicer picker over its four values (there is no "custom" quality).
export const DEPTHMAP_QUALITY_META = [
  { id: 'low', label: 'Low', blurb: '⅛ native · fastest' },
  { id: 'medium', label: 'Medium', blurb: '¼ native · balanced' },
  { id: 'high', label: 'High', blurb: '½ native · denser, slower' },
  { id: 'ultra', label: 'Ultra', blurb: 'Full native · slowest' },
]

// Dense — Stage B fusion (fuseDepthMaps). Mirrored by DenseModal.vue.
// UI units: depthTolPct is a %, ÷100 on run; in `auto` mode the modal sends null for
// minViews/maxCost and fusion picks them (minViews from the map count, maxCost below).
export const DENSE_FUSE_DEFAULTS = {
  auto: true, // fusion picks minViews (from the map count) and maxCost (below)
  minViews: 2, // manual cross-view consistency count (when not auto)
  depthTolPct: 1.0, // manual depth agreement tolerance, % of depth
  // Per-pixel cost gate (1 − ZNCC; also what `auto` uses). A loose backstop: the depth
  // maps' cross-view filter has already applied an absolute ZNCC floor, and a tighter
  // gate only removed true surface — 0.8 vs the old adaptive p70 (≈ 0.3): ETH3D mean
  // F1 @2 cm 52.6 → 58.9, accuracy unchanged on all 13 scenes; 0.8 and 1.0 score alike.
  maxCost: 0.8,
  step: 1, // fusion pixel stride (full res; spatial merge dedupes overlap)
  // ── Geometric outlier filters (WS4; 0 disables each) ──
  minTriAngleDeg: 2.0, // min triangulation angle between the reference and an agreeing
  // view — kills sky/haze pixels that only "agree" at ~0° parallax
  maxIncidenceDeg: 80, // max angle between the surface normal and the viewing ray —
  // thins edge-on vegetation shells (0/90 disables; fallback normals inert)
  removeIsolated: true, // drop low-support voxel cells with too few occupied neighbours
  // Output: add the new product beside the others as the main one (false), or put it
  // in place of the main one (true). Off, so a rebuild never loses a result by default.
  replaceMain: false,
}

// Reconstruct ▸ Find GCPs (composables/useFindGcps.js, FindGcpsModal.vue).
export const FIND_GCPS_DEFAULTS = {
  matcher: 'auto', // 'auto' (SuperPoint if installed, else DISK) | 'disk' | 'superpoint' | 'sift' | 'terrain'
  // Candidates proposed, spread over the block (a √n × √n grid first). The georeference's
  // tilt is pinned by the candidates' heights, each a few metres off on steep rock: on
  // Rachel Glacier 30 left the DEM 2.8 m high after moving the control onto REMA, 90 0.7 m.
  candidates: 90,
}

// Find GCPs ▸ Sentinel-2 (Sentinel2Modal.vue, core/sentinel2.js).
export const SENTINEL2_DEFAULTS = {
  maxCloud: 20, // % cloud over the whole scene, as the catalogue states it
  from: '', // ISO date or '' (any)
  to: '',
  // σ XY declared on the fetched raster, metres: Sentinel-2's geolocation is about
  // 11–12.5 m CE95 (σ ≈ 5 m) before refinement against ESA's Global Reference Image,
  // plus a fraction of a 10 m pixel of matching error.
  horizontalAccuracy: 8,
}

// DEM (core/products/dem.js). Mirrored by DemModal.vue; gsd 0 ⇒ worker auto-suggests.
export const DEM_DEFAULTS = {
  crs: 'local', // 'local' | 'project'
  // The raster size: by cell size or by pixels on the longer side (the dialog shows one
  // field); a set gsd wins over longSide, and both 0 = auto (core/products/rasterSize.js).
  sizeBy: 'gsd', // 'gsd' | 'px'
  gsd: 0, // ground sample distance; 0 = auto (√(area/n))
  longSide: 0, // cells on the longer side; 0 = auto
  // 'median' | 'max' (top surface) | 'mean' | 'min'. Median by default: in a cell on a
  // slope `max` takes the cell's top edge — +14 m on Rachel Glacier's rock at 20 m
  // cells (NMAD 8.2 vs 5.9 m) — while on flat Casa Grande all four agree within 0.1 m.
  aggregate: 'median',
  fillMethod: 'idw', // 'none' | 'nearest' | 'idw'
  fillRadius: 2, // IDW hole-fill radius (cells); 0 = none
  extent: 'core', // 'core' = the cloud's dense footprint (dem.js coreExtent) | 'all' = raw min/max
  points: 'all', // 'all' (DSM) | 'ground' = only LAS class 2 of a classified cloud (DTM)
  fillHoles: false, // also interpolate every enclosed nodata area (under removed buildings)
  // Output: add the new product beside the others as the main one (false), or put it
  // in place of the main one (true). Off, so a rebuild never loses a result by default.
  replaceMain: false,
}

// Reseau crosses (Tools ▸ Images ▾ ▸ Detect reseau, SAT-5): the KH-9 mapping camera's
// 1 cm grid of crosses. Film size comes from the scans (image size × scan pitch).
export const RESEAU_DEFAULTS = {
  spacingMm: 10, // cross spacing on the film
  armMm: 0.5, // half-length of a cross arm
  widthMm: 0.03, // line width
}

// Split panoramic strips (core/sfm/panoramic.js). Mirrored by PanoramicModal.vue.
export const PANORAMIC_DEFAULTS = {
  segments: 0, // segments per strip; 0 = near-square (one per strip height of scan)
  overlapPct: 10, // added to each side of a segment, as a % of its share of the scan
  removeStrips: true,
}

// Orthophoto (core/products/ortho.js). Mirrored by OrthoModal.vue.
// UI units: depthTolRel is a %, ÷100 on run; maxCost 0 ⇒ Infinity (no gate).
export const ORTHO_DEFAULTS = {
  // Which surface supplies the height per ground cell (core/products/surface.js).
  // 'dem' reuses the built DEM (and its frame); 'mesh' rasterises the mesh cloud
  // (watertight ⇒ no holes); 'plane' fits a plane through the cloud (flat scenes).
  surface: 'dem',
  crs: 'local', // frame for a mesh/plane surface; 'dem' reuses the DEM's frame
  sizeBy: 'gsd', // 'gsd' | 'px', as DEM_DEFAULTS
  gsd: 0, // ortho cell size; 0 = the surface's own (auto) resolution
  longSide: 0, // cells on the longer side; 0 = auto
  // 'mosaic' (one photo per area, seamlines, gains, seam blending) |
  // 'best' (lowest matching cost per cell) | 'average' (every visible view).
  blend: 'mosaic',
  // mosaic: where the seams run — 'graphcut' (min cut over colour difference + nadir
  // cost, so seams avoid buildings and trees) | 'nadir' (each cell's most nadir photo).
  seamline: 'graphcut',
  // mosaic: how seams are hidden — 'multiband' (Laplacian pyramid, 5 bands) |
  // 'feather' (linear cross-fade over seamWidth).
  seamBlend: 'multiband',
  colourBalance: true, // mosaic: per-image gains over the overlaps (Brown & Lowe)
  seamWidth: 1, // mosaic + feather: seam band, % of the ortho's short side; 0 = hard seams
  depthTolRel: 2, // occlusion tolerance, % of depth
  maxCost: 0, // 0 = no cost gate; else drop matches above this cost
  fillMethod: 'idw', // colour interpolation: 'none' | 'nearest' | 'idw'
  fillRadius: 2, // fill unsampled pixels inside the chosen surface (cells)
  extent: 'core', // mesh/plane surface extent, as DEM_DEFAULTS.extent; 'dem' follows the DEM grid
  // Output: add the new product beside the others as the main one (false), or put it
  // in place of the main one (true). Off, so a rebuild never loses a result by default.
  replaceMain: false,
}

// Product export (core/products/exporters.js + geotiff.js). Mirrored by ExportModal.vue.
// `format` is not here — it's chosen dynamically per export kind in the modal.
export const EXPORT_DEFAULTS = {
  includeColor: true, // point cloud RGB
  includeTracks: true, // model tracks
  nodata: -9999, // DEM no-data sentinel
  compression: 'none', // DEM/ortho GeoTIFF: 'none' | 'deflate'
  applyGeoref: true, // cloud: transform into the project CRS when a georef fit exists
  downsampleCell: 0, // cloud: voxel downsample cell in world units; 0 = off
  jpegQuality: 0.9, // ortho JPEG quality (0–1)
  // Ortho GeoTIFF / PNG: transparent empty pixels (an alpha band), or, unticked, three
  // bands with empty pixels at `orthoNodata` (0–255; a JPEG always uses it).
  orthoAlpha: true,
  orthoNodata: 0,
  // DEM/ortho GeoTIFF in another CRS (core/products/warp.js): 'product' = as built,
  // 'other' = reprojected to the CRS picked in the dialog; how cells are resampled.
  rasterCrs: 'product', // 'product' | 'other'
  resampling: 'bilinear', // 'bilinear' | 'nearest'
  // Saved measurements as GeoJSON (core/products/measurementExport.js): 'project' =
  // the project CRS in the legacy `crs` member, heights kept; 'wgs84' = RFC 7946.
  measurementCoords: 'project',
  // 3D Tiles (core/products/tiles3d.js). `tiling` null = by size: a hierarchy of
  // tiles ('lod') from these sizes up, else one tile ('single'). A mesh's tiles hold
  // up to `tileTriangles` triangles each (about 1–2 MB of glTF).
  tiling: null,
  tilesLodMinPoints: 1_000_000,
  tilesLodMinTriangles: 250_000,
  tileTriangles: 65_536,
  // Undistorted images (COLMAP image_undistorter parity).
  // `mode` 'crop' keeps only the region every output pixel of which samples inside
  // the source — the alternative leaves a clamped-edge smear a downstream matcher
  // reads as real content. `undistortMaxDim` 0 = native resolution.
  undistortMode: 'crop', // 'crop' | 'full'
  undistortFormat: 'jpeg', // 'jpeg' | 'png' (png = lossless, much larger)
  undistortQuality: 0.92, // JPEG quality; above the ortho default since these feed MVS
  undistortMaxDim: 0,
  // Camera poses (Export ▸ Camera Poses): the omega/phi/kappa columns, and the
  // accuracy columns (imported poses only; estimated ones have none).
  poseOrientation: true,
  poseAccuracy: true,
  // Camera poses and vector layers as GeoJSON: 'project' = the project CRS in the
  // legacy `crs` member; 'wgs84' = longitude/latitude (RFC 7946).
  geoJsonCoords: 'project',
  // Matches: 'matches' = every pair with its keypoint index pairs; 'pairs' = the pair
  // list with its counts alone.
  matchContent: 'matches',
}

// Point-cloud / mesh import (ImportCloudModal.vue → useReconstructionStore.importCloud).
// Coordinates import verbatim into the current frame — no CRS reprojection.
export const IMPORT_CLOUD_DEFAULTS = {
  unitScale: 1, // multiply coordinates: 1 = m, 0.01 = cm, 0.001 = mm source units
  swapYZ: false, // Y-up source (many mesh tools) → Z-up
  subsampleCell: 0, // voxel subsample cell in world units after scaling; 0 = off
}

// Video import (ImportVideoModal.vue → core/io/videoFrames.js): which frames of a
// video become images, and how they are stored.
export const VIDEO_IMPORT_DEFAULTS = {
  mode: 'auto', // 'auto' (spaced by motion, sharpest kept) | 'interval'
  every: 1, // interval: one frame every `every` `unit`
  unit: 'seconds', // interval: 'seconds' | 'frames'
  // Auto: consecutive frames share about this much of the view (% of the frame
  // width). 80 % keeps every point in ~5 frames, plenty for sequential matching
  // with its 10-image window.
  overlap: 80,
  maxFrames: 200, // auto: the spacing widens until the count fits
  minSharpness: 0.5, // auto: blurry below this × the median sharpness of nearby moments
  format: 'jpeg', // 'jpeg' | 'png' (lossless, ~5× larger)
  jpegQuality: 0.95, // the frames are already compressed once; keep the second pass light
  maxDim: 0, // long side of the saved frames in px; 0 = the video's own size
}

// Mesh (screened Poisson, core/products/mesh.js + crates/mesh). Mirrored by
// MeshModal.vue. `screening` is the Poisson point-fitting weight (the vendored
// library's quality lever; the classic PoissonRecon "samples per node" knob is not
// exposed — see crates/mesh/src/lib.rs). The cleanup after the solve (crates/mesh
// `MeshOptions`) is what makes the surface usable on a photogrammetric cloud:
// `trim` drops surface the samples don't support (the extrapolated hull, the shell
// around a stray speck), `fillHoles` closes small holes that opens, `removeFloaters`
// drops disconnected pieces explaining < `minPiecePct` % of the main surface's
// samples. `distanceTrim` is the older proximity trim (× the input sample spacing;
// 0 = off), kept as an advanced option.
export const MESH_DEFAULTS = {
  depth: 8, // octree max depth (detail vs cost/RAM); auto-lowered when the cloud can't use it
  screening: 4, // Poisson point-fitting weight; 0 disables screening
  trim: 'gentle', // 'off' | 'gentle' | 'strong' — support-density trim (MESH_TUNING.trimRatio)
  fillHoles: true, // re-add small closed holes the trim opened
  removeFloaters: true, // drop disconnected pieces with little sample support
  minPiecePct: 1, // … below this % of the best-supported piece's support
  distanceTrim: 0, // proximity trim radius in input-sample cells; 0 = off
  colorize: true, // transfer dense-cloud colour onto the mesh vertices
  tiles: 'auto', // 'auto' | 'off' — solve in tiles when one solve would not fit (meshTiles.js)
  // Output: add the new product beside the others as the main one (false), or put it
  // in place of the main one (true). Off, so a rebuild never loses a result by default.
  replaceMain: false,
}
// Mesh quality presets — octree depth is the detail/cost lever (deltas; medium ≡ defaults).
export const MESH_PRESETS = {
  low: { depth: 6 },
  medium: {},
  high: { depth: 10 },
}
export const MESH_PRESET_META = [
  { id: 'low', label: 'Coarse', blurb: 'Octree depth 6 · quick preview' },
  { id: 'medium', label: 'Balanced', blurb: 'Octree depth 8 · default' },
  { id: 'high', label: 'Fine', blurb: 'Octree depth 10 · detailed, slow' },
]

// Mesh texture (core/products/texture/). `maxScale` is the finest texel size as a share
// of a native photo pixel (1 = full photo resolution); the run lowers it until the atlas
// fits `maxPages` pages of `pageSize`². `smoothness` is the seam penalty of the view
// selection: higher means fewer, larger charts from slightly worse views.
export const TEXTURE_DEFAULTS = {
  pageSize: 4096, // atlas page side in texels
  maxPages: 8, // page cap; the texel scale drops until the atlas fits
  maxScale: 1, // finest texel scale relative to the photos' native pixels
  smoothness: 0.5, // view-selection seam penalty per cut edge
  levelColours: true, // per-image exposure/white-balance gains before the bake
  useMasks: true, // leave masked photo pixels out of the texture
  unseen: 'colour', // faces no photo sees: 'colour' (flat, from the vertex colours) | 'remove'
  // Drop a face's photos that saw something the others did not (people, cars that
  // moved). Off by default: on a static scene it mostly drops views of things that
  // look different from different angles (a vine standing off a wall: South Building).
  photoConsistency: false,
}

// Cloud editing (core/products/cloudEdit.js). Mirrored by FilterCloudModal.vue /
// CropCloudModal.vue / MergeCloudsModal.vue. These edit **dense** clouds only — a
// sparse cloud carries the per-point view-tracks the dense/ortho/COLMAP paths read,
// so it is not editable here (see the module docstring).
//
// The filter's `methods` list is ordered and each stage feeds the next, so the
// default order is deliberate: cheap linear rejections first, the O(N·27-cell)
// neighbour sweep last, over the smallest cloud.
export const FILTER_CLOUD_DEFAULTS = {
  methods: ['sor'], // any of 'range' | 'voxel' | 'isolated' | 'sor', in run order
  // Statistical outlier removal.
  sorK: 12, // neighbours averaged per point
  sorStdRatio: 1.5, // drop above mean + ratio·σ; lower = more aggressive
  // Voxel downsample. 0 ⇒ auto (the dense run's merge cell, filled in by the store).
  voxelCell: 0,
  // Isolated-cluster removal. 0 ⇒ auto (4× the estimated point spacing).
  isolatedCell: 0,
  isolatedMinNeighbors: 2, // occupied neighbour cells needed to keep a low-support cell
  isolatedMaxSupport: 2, // cells with more points than this are never tested
  // Elevation / brightness band. null ⇒ unbounded on that side.
  zMin: null,
  zMax: null,
  lumaMin: null,
  lumaMax: null,
}
// Filter presets — deltas over the defaults; 'medium' ≡ defaults.
export const FILTER_CLOUD_PRESETS = {
  light: { methods: ['sor'], sorStdRatio: 2.5 },
  medium: {},
  strong: { methods: ['isolated', 'sor'], sorStdRatio: 1.0 },
}
export const FILTER_CLOUD_PRESET_META = [
  { id: 'light', label: 'Light', blurb: 'Outlier removal only · trims obvious flyers' },
  { id: 'medium', label: 'Balanced', blurb: 'Outlier removal at 1.5σ · default' },
  { id: 'strong', label: 'Strong', blurb: 'Isolated clusters + 1.0σ · may bite into thin detail' },
]

// Crop. Bounds are prefilled from the source cloud's bbox by the modal; a null
// component means "unbounded on that side", so a Z-only crop needs no X/Y numbers.
export const CROP_CLOUD_DEFAULTS = {
  minX: null,
  minY: null,
  minZ: null,
  maxX: null,
  maxY: null,
  maxZ: null,
  invert: false, // keep what falls OUTSIDE the box instead
}

// Merge. `cell` voxel-dedupes the result — the seam where two overlapping clouds
// meet is otherwise double-density. 0 ⇒ plain concatenation.
export const MERGE_CLOUDS_DEFAULTS = {
  cell: 0,
}

// ── Tools ▸ Mesh ▾ (core/products/meshEdit.js, meshDecimate.js) ──────────────
// Every mesh edit adds a NEW derived mesh; the source is never modified.

// Clean mesh: an ordered chain, each step on the previous output.
export const CLEAN_MESH_DEFAULTS = {
  // 'weld' first: an STL-style import (every triangle its own corners) must share
  // vertices before pieces, edges or holes mean anything. Its ε is relative to the
  // mesh (meshEdit.js WELD_REL_*), so a mesh that already shares vertices is untouched.
  methods: ['weld', 'components', 'longEdges', 'holes', 'compact'],
  // Drop pieces smaller than this share of the largest piece (Poisson specks).
  minFraction: 0.01,
  minTriangles: 50,
  // Bridge triangles: any edge longer than this × the median edge.
  maxEdgeFactor: 6,
  // Fill boundary loops up to this many edges. A terrain's outer rim is itself a
  // loop, so "all" (0) closes an open surface — only for objects you want watertight.
  maxHoleEdges: 64,
}
// Taubin λ/μ smoothing: λ > 0 smooths, μ < −λ re-inflates, so the mesh does not
// shrink the way repeated Laplacian smoothing does.
export const SMOOTH_MESH_DEFAULTS = {
  iterations: 10,
  lambda: 0.5,
  mu: -0.53,
  fixBoundary: true,
}
export const DECIMATE_MESH_DEFAULTS = {
  targetMode: 'ratio', // 'ratio' | 'count'
  targetRatio: 0.25,
  targetTriangles: 200_000,
  preserveBoundary: true,
}
export const SAMPLE_MESH_DEFAULTS = {
  count: 1_000_000,
}

// ── Tools ▸ Point Cloud ▾ (core/products/cloudNormals.js, cloudAlign.js, …) ──

export const NORMALS_DEFAULTS = {
  k: 16,
  // 'auto' ⇒ towards the cameras for a computed cloud, +Z (up) for an imported one.
  orient: 'auto', // 'auto' | 'cameras' | 'up' | 'existing'
}
// Classify ground (core/products/groundFilter.js, cloth simulation). Lengths in
// metres; a project without metric scale is refused. Mirrored by ClassifyGroundModal.vue.
// Tools ▸ Model ▾ ▸ Optimize cameras (OptimizeCamerasModal.vue): which intrinsics the
// re-solve frees: 'f' (focal length) | 'f,cxcy' (and the principal point).
export const OPTIMIZE_CAMERAS_DEFAULTS = {
  refine: 'f',
}
// Sparse Model ▸ Add to the model (core/sfm/extendModel.js). Existing cameras: 'auto'
// keeps them fixed when depth maps, clouds or rasters were built from them (those stay
// current), and lets them move with the new ones (Optimize cameras) when nothing was.
export const EXTEND_DEFAULTS = {
  existingCameras: 'auto',
}
export const GROUND_DEFAULTS = {
  // Cloth particle spacing. 1 m spans roofs up to ~40 m and follows slopes up to
  // ~30 %; a large hall needs 2 m, steep mountain terrain 0.5 m.
  clothResolution: 1,
  rigidness: 2, // 1 steep terrain | 2 rolling relief | 3 flat (stiffest)
  classThreshold: 0.5, // max distance from the cloth for a ground point
  slopeSmoothing: true, // spread the cloth onto continuous steep ground
  extent: 'core', // 'core' = the DEM's dense core (outside → class 0) | 'all'
}
// Classify Points ▸ steps 3 and 4, on the points above the cloth (core/products/
// pointClasses.js). Heights are above the cloth, in metres; an area in m².
export const CLASSIFY_DEFAULTS = {
  vegetation: true,
  // ASPRS leaves the bands to the user; under a metre is grass and low crops, up to
  // 3 m shrubs and hedges, above that trees.
  lowVegetationMax: 1,
  mediumVegetationMax: 3,
  buildings: true,
  // A plane this high and this large: a garden shed is about 2.5 m and 6–10 m², a car
  // roof 1.5 m and 4 m², which stays unclassified.
  minBuildingHeight: 2.5,
  minBuildingArea: 10,
}
export const ICP_DEFAULTS = {
  // A real dense cloud (noisy normals) needs tens: South Building, 2° start, 40–71 in
  // point-to-plane; at 30 it stopped 1.9 cm off. A converged run stops early.
  maxIterations: 100,
  // Correspondence rejection radius, in the clouds' units. 0 ⇒ auto (10× the
  // source's point spacing) — ICP only refines; it needs a rough alignment first.
  maxDistance: 0,
  sampleCount: 50_000,
  pointToPlane: true,
  estimateScale: false,
}
export const DISTANCE_DEFAULTS = {
  maxDistance: 0, // 0 ⇒ unlimited
  signed: true, // along the reference's normals, when it has them
}
export const SECTION_DEFAULTS = {
  thickness: 0, // 0 ⇒ auto (about 3× the point spacing)
  extend: false,
}

// ── Tools ▸ Products ▾ (core/products/contours.js, terrain.js, rasterClip.js) ─

export const CONTOUR_DEFAULTS = {
  interval: 0, // 0 ⇒ auto (≈ 25 levels over the DEM's height range)
  indexEvery: 5,
  smooth: 1,
  // Smooth the heights first (Gaussian σ, cells) and drop lines shorter than minCells:
  // a photogrammetric DEM's noise otherwise traces as thousands of tiny rings (Aukerman
  // DSM: 31,436 lines → 733). 0 turns either off.
  generalize: 2,
  minCells: 20,
  // The lines always go on the map (when the DEM has a CRS); this is the download too:
  // 'none' | 'geojson' | 'dxf'. A DEM without a CRS is always downloaded.
  format: 'none',
}
export const TERRAIN_DEFAULTS = {
  products: ['slope', 'hillshade'],
  slopeUnits: 'degrees', // 'degrees' | 'percent'
  azimuth: 315,
  altitude: 45,
  multidirectional: false,
}

// ── Tools ▸ Images ▾ (core/features/imageQuality.js) ─────────────────────────
export const IMAGE_QUALITY_DEFAULTS = {
  // Sharpness relative to the batch median below which an image is flagged blurry.
  minRelative: 0.5,
}

// Footprints from imported poses (core/footprint.js). Mirrored by
// FootprintFromPosesModal.vue's `settings` ref (the intrinsics override is seeded
// from sensor data, not a static default).
export const FOOTPRINT_DEFAULTS = {
  ground: 'dem', // 'dem' (follow a terrain model) | 'absolute' (one plane) | 'agl' (camera Z − agl)
  demSource: 'terrain', // 'dem': 'terrain' (global terrain tiles) | a reference DEM's id
  poseDatum: 'unknown', // 'dem': vertical datum of the camera heights; 'unknown' = the DEM's
  groundElev: 0, // 'absolute': ground elevation
  agl: 1000, // 'agl': flying height above ground
  assumeNadir: true, // treat cameras as looking straight down when angles are missing
}

// Anonymous structural detection. Calibration has a separate modal/defaults.
export const FIDUCIAL_SPOT_DEFAULTS = {
  family: 'generic',
  positions: 'corners',
  polarity: 'auto',
  tolerance: 0.5,
  overwrite: false,
  generateMasks: false,
  maskDarkPixels: false,
}

// Auto Mask's border rule (AutoMaskModal.vue; src/guide/masks.md border / linked /
// existing): the outer pixels excluded on each side of an image.
export const AUTO_MASK_DEFAULTS = {
  border: 40, // px excluded on each side
  linked: true, // editing one side sets all four
  existing: 'merge', // 'merge' (union with the image's mask) | 'replace'
}

// Masks ▸ Import folder (MaskManagerModal.vue; src/guide/masks.md importExisting):
// one mask file per image, paired by name.
export const MASK_IMPORT_DEFAULTS = {
  existing: 'replace', // 'replace' the image's mask with the file | 'merge' (union)
}

// The 3D view's turntable (View ▸ Camera ▸ Turntable; src/guide/3d-view.md). Persisted
// per browser by useViewerSettings.
export const TURNTABLE_DEFAULTS = {
  secondsPerTurn: 24, // one full turn; also the length of a recorded video
}
