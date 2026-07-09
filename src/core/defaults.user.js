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
export const DETECT_SIFT_DEFAULTS = {
  maxDim: 1200,             // longest side the detector runs at (px)
  contrastThreshold: 0.01,  // DoG response floor (lower = more, weaker keypoints)
  maxKeypoints: 5000,       // per-image cap (strongest kept)
  tiling: 'off',            // 'off' | 'on' — tiled detection for very large images
  tileSize: 1024,           // tile edge (px) when tiling is on
  overlap: 64,              // tile overlap (px) so seams still get keypoints
}

// Tie-point detection — SuperPoint (no contrast knob; learned threshold is baked in).
// Mirrored by DetectFeaturesModal.vue's `superpointSettings` ref.
export const DETECT_SUPERPOINT_DEFAULTS = {
  maxDim: 1200,
  maxKeypoints: 2048,       // LightGlue attention is O(N²) — 2048 is the usual sweet spot
  tiling: 'off',
  tileSize: 1024,
  overlap: 64,
}

// Tie-point matching (crates/matching via useMatchesStore). Mirrored by
// MatchFeaturesModal.vue's `settings` ref. Internal-only match knobs (not shown to the
// user) live in tuning.js ▸ MATCH_TUNING.
export const MATCH_DEFAULTS = {
  ratioThreshold: 0.75,        // Lowe ratio test
  crossCheck: false,           // mutual-nearest-neighbour cross-check (brute-force)
  minMatches: 15,              // min surviving matches to keep a pair
  geometricVerification: true, // run F-RANSAC verification
  ransacThreshPx: 2.0,         // F-RANSAC inlier threshold (px)
  minInlierRatio: 0.25,        // reject pairs whose inlier fraction is below this
  maxIters: 1000,              // F-RANSAC iterations
  maxNeighbors: 10,            // preselect: k-nearest cameras to consider per image
  useGpu: false,               // experimental WebGPU LightGlue backend
  lgMaxKeypoints: 2048,        // per-image cap fed to LightGlue
  subsetGate: true,            // cheap coarse pre-test to skip non-overlapping pairs
  subsetGateSize: 200,         // spatially-uniform keypoints per image in the pre-test
  subsetGateThreshold: 8,      // min subset putatives required to run the full match
}

// Sparse reconstruction (crates/reconstruction via core/sfm/sfm.js).
// Mirrored by ReconstructModal.vue's `settings` ref.
export const RECONSTRUCT_DEFAULTS = {
  minMatchesForRegistration: 20, // min correspondences to a registered image to try PnP
  reprjThreshold: 4.0,           // reprojection inlier threshold (px)
  baIterations: 30,              // bundle-adjustment iterations
  refineIntrinsics: 'none',      // BA self-calibration: 'none' | 'f' | 'f,cxcy' | 'f,k1'
}

// Dense — Stage A depth maps (PatchMatch MVS). Mirrored by DepthMapsModal.vue.
// NOTE: values here are UI units; the modal's run() transforms some before dispatch
// (filterRelTol is a %, ÷100 on run; maxDim/bestK null ⇒ store/worker auto-derive).
export const DEPTHMAP_DEFAULTS = {
  quality: 'medium',   // low = ⅛, medium = ¼, high = ½, ultra = full native
  maxDim: null,        // advanced override; null ⇒ derive from quality
  maxSources: 6,       // source views per image
  window: 3,           // ZNCC half-window (7×7)
  iterations: 3,       // PatchMatch sweeps
  bestK: null,         // advanced override; null ⇒ auto per image
  speckleFilter: true, // median/speckle cleanup on each depth map
  filterRelTol: 10,    // speckle relative tolerance, % (÷100 on run)
  useGpu: false,       // experimental WebGPU backend
}

// Dense — Stage B fusion (fuseDepthMaps). Mirrored by DenseModal.vue.
// UI units: depthTolPct is a %, ÷100 on run; in `auto` mode minViews/maxCost are
// derived from the data (the modal sends null).
export const DENSE_FUSE_DEFAULTS = {
  auto: true,        // derive minViews + maxCost from the data
  minViews: 2,       // manual cross-view consistency count (when not auto)
  depthTolPct: 1.0,  // manual depth agreement tolerance, % of depth
  maxCost: 0.6,      // manual per-pixel cost gate (when not auto)
  step: 2,           // fusion pixel stride
}

// DEM (core/products/dem.js). Mirrored by DemModal.vue; gsd 0 ⇒ worker auto-suggests.
export const DEM_DEFAULTS = {
  crs: 'local',     // 'local' | 'project'
  gsd: 0,           // ground sample distance; 0 = auto (√(area/n))
  aggregate: 'max', // 'max' (DSM top surface) | 'mean' | 'median'
  fillRadius: 2,    // IDW hole-fill radius (cells); 0 = none
}

// Orthophoto (core/products/ortho.js). Mirrored by OrthoModal.vue.
// UI units: depthTolRel is a %, ÷100 on run; maxCost 0 ⇒ Infinity (no gate).
export const ORTHO_DEFAULTS = {
  blend: 'best',    // 'best' (sharpest) | 'average' (smoother seams)
  depthTolRel: 2,   // occlusion tolerance, % of depth
  maxCost: 0,       // 0 = no cost gate; else drop matches above this cost
}

// Product export (core/products/exporters.js + geotiff.js). Mirrored by ExportModal.vue.
// `format` is not here — it's chosen dynamically per export kind in the modal.
export const EXPORT_DEFAULTS = {
  includeColor: true,   // point cloud RGB
  includeTracks: true,  // model tracks
  nodata: -9999,        // DEM no-data sentinel
  compression: 'none',  // DEM/ortho GeoTIFF (placeholder; writer is uncompressed)
}

// Footprints from imported poses (core/footprint.js). Mirrored by
// FootprintFromPosesModal.vue's `settings` ref (the intrinsics override is seeded
// from sensor data, not a static default).
export const FOOTPRINT_DEFAULTS = {
  useAgl: false,      // derive ground from above-ground-level height instead of an elevation
  groundElev: 0,      // fixed ground elevation (when not useAgl)
  agl: 1000,          // above-ground-level height (when useAgl)
  assumeNadir: true,  // treat cameras as looking straight down when angles are missing
  overwrite: true,    // replace existing footprints
}
