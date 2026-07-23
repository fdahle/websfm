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

// Detection quality presets (deltas over the per-detector defaults; medium ≡ defaults).
// One shared card set (meta), two delta maps — the modal applies whichever matches the
// active detector. Only resolution + keypoint budget vary (contrast too for SIFT).
export const DETECT_SIFT_PRESETS = {
  low:    { maxDim: 900,  maxKeypoints: 3000, contrastThreshold: 0.02 },
  medium: {},
  high:   { maxDim: 1600, maxKeypoints: 8000, contrastThreshold: 0.006 },
}
export const DETECT_SUPERPOINT_PRESETS = {
  low:    { maxDim: 900,  maxKeypoints: 1024 },
  medium: {},
  high:   { maxDim: 1600, maxKeypoints: 4096 },
}
export const DETECT_PRESET_META = [
  { id: 'low',    label: 'Fast',     blurb: 'Lower resolution, fewer keypoints' },
  { id: 'medium', label: 'Balanced', blurb: 'Default resolution and cap' },
  { id: 'high',   label: 'Detailed', blurb: 'Higher resolution, more keypoints — slower' },
]

// Tie-point matching (crates/matching via useMatchesStore). Mirrored by
// MatchFeaturesModal.vue's `settings` ref. Internal-only match knobs (not shown to the
// user) live in tuning.js ▸ MATCH_TUNING.
export const MATCH_DEFAULTS = {
  ratioThreshold: 0.75,        // Lowe ratio test
  // Mutual-nearest-neighbour cross-check. ON by default (COLMAP parity): without it a
  // brute-force pass is one-directional, so many A keypoints may claim the SAME B
  // keypoint. Those many-to-one putatives (a) inflate the raw count and depress every
  // pair's inlier ratio, and (b) let F-RANSAC fit a degenerate model through a pencil of
  // epipolar lines — the signature the `inlierSpread` gate then rejects as "positional
  // collapse" (always A-side-full / B-side-collapsed, never the reverse: see the
  // 2026-07-17 building baseline). Cross-check removes the cause rather than the symptom.
  crossCheck: true,
  minMatches: 15,              // min surviving matches to keep a pair
  geometricVerification: true, // run F-RANSAC verification
  ransacThreshPx: 2.0,         // F-RANSAC inlier threshold (px)
  // Reject pairs whose inlier fraction is below this. COLMAP has no ratio gate at all
  // (only min_num_inliers=15) and verifies ~3× more pairs on the building set — that tail
  // of 15–40-inlier pairs is what carries its 3.6 mean track length vs our 2.6. 0.15 keeps
  // a guard against the ~0.06 spurious fits while re-admitting the tail.
  minInlierRatio: 0.15,
  maxIters: 1000,              // F-RANSAC iterations
  maxNeighbors: 10,            // preselect: k-nearest cameras to consider per image
  sequentialOverlap: 10,       // sequential: match each image to the next N capture-order images
  sequentialLoopClosure: false, // circular sequence: also connect its end back to its start
  lgMaxKeypoints: 2048,        // per-image cap fed to LightGlue (plain path)
  lgTiled: false,              // coarse-to-fine tiled guided matching (full density)
  lgTileBudget: 2048,          // max keypoints per tile side when tiled (attention budget)
  subsetGate: true,            // cheap coarse pre-test to skip non-overlapping pairs
  subsetGateSize: 200,         // spatially-uniform keypoints per image in the pre-test
  subsetGateThreshold: 8,      // min subset putatives required to run the full match
}
// Matching quality presets — tune the geometric-verification strictness (deltas over
// the defaults; medium ≡ defaults). Strategy/matcher are separate primary choices, not
// preset-controlled. ratioThreshold is inert on the LightGlue path (no ratio test there).
export const MATCH_PRESETS = {
  low:    { ratioThreshold: 0.80, minInlierRatio: 0.10 },
  medium: {},
  high:   { ratioThreshold: 0.70, minInlierRatio: 0.25, maxIters: 2000 },
}
export const MATCH_PRESET_META = [
  { id: 'low',    label: 'Lenient',  blurb: 'More matches, looser verification' },
  { id: 'medium', label: 'Balanced', blurb: 'Default ratio and inlier gates' },
  { id: 'high',   label: 'Strict',   blurb: 'Fewer, high-confidence matches' },
]

// Sparse reconstruction (crates/reconstruction via core/sfm/sfm.js).
// Mirrored by ReconstructModal.vue's `settings` ref.
export const RECONSTRUCT_DEFAULTS = {
  minMatchesForRegistration: 20, // min correspondences to a registered image to try PnP
  reprjThreshold: 4.0,           // reprojection inlier threshold (px)
  baIterations: 30,              // bundle-adjustment iterations
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
  low:    { baIterations: 15, reprjThreshold: 6.0 }, // fast: fewer BA iters, looser gate
  medium: {},                                        // = RECONSTRUCT_DEFAULTS
  high:   { baIterations: 60, reprjThreshold: 3.0 }, // thorough: more iters, tighter gate
}
// Card metadata for the PresetCards hero (label + one-line "what you get"). Ordered.
// Kept beside the deltas so a preset's copy and its values live together.
export const RECONSTRUCT_PRESET_META = [
  { id: 'low',    label: 'Low',    blurb: 'Faster · looser gate, fewer BA iterations' },
  { id: 'medium', label: 'Medium', blurb: 'Balanced default for most projects' },
  { id: 'high',   label: 'High',   blurb: 'Slower · tighter gate, more BA iterations' },
]

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
  // ── Cross-view geometric consistency (COLMAP's filter pass; mvs.js
  // filterDepthMapsGeometric). Runs once after all maps exist and zeroes rejected
  // pixels in the maps themselves, so the orthophoto (which reuses them as a
  // z-buffer) is cleaned too. This is the filter that removes sky/vegetation
  // freckles — the photometric gates below cannot: a bush has genuinely high NCC.
  geomConsistency: true, // enable the cross-view check
  maxGeomCost: 1.0,      // max forward–backward reprojection error (px) to call a view consistent
  minConsistent: 2,      // min consistent views to keep a pixel
  minNcc: 0.1,           // absolute per-pixel ZNCC floor (drops cost > 1 − minNcc)
}
// Depth-map quality cards. Unlike the other presets these are NOT deltas — `quality` is
// itself a first-class setting the store resolves to a working resolution; the cards are
// a nicer picker over its four values (there is no "custom" quality).
export const DEPTHMAP_QUALITY_META = [
  { id: 'low',    label: 'Low',    blurb: '⅛ native · fastest' },
  { id: 'medium', label: 'Medium', blurb: '¼ native · balanced' },
  { id: 'high',   label: 'High',   blurb: '½ native · denser, slower' },
  { id: 'ultra',  label: 'Ultra',  blurb: 'Full native · slowest' },
]

// Dense — Stage B fusion (fuseDepthMaps). Mirrored by DenseModal.vue.
// UI units: depthTolPct is a %, ÷100 on run; in `auto` mode minViews/maxCost are
// derived from the data (the modal sends null).
export const DENSE_FUSE_DEFAULTS = {
  auto: true,        // derive minViews + maxCost from the data
  minViews: 2,       // manual cross-view consistency count (when not auto)
  depthTolPct: 1.0,  // manual depth agreement tolerance, % of depth
  maxCost: 0.6,      // manual per-pixel cost gate (when not auto)
  step: 1,           // fusion pixel stride (full res; spatial merge dedupes overlap)
  // ── Geometric outlier filters (WS4; 0 disables each) ──
  minTriAngleDeg: 2.0, // min triangulation angle between the reference and an agreeing
                       // view — kills sky/haze pixels that only "agree" at ~0° parallax
  maxIncidenceDeg: 80, // max angle between the surface normal and the viewing ray —
                       // thins edge-on vegetation shells (0/90 disables; fallback normals inert)
  removeIsolated: true, // drop low-support voxel cells with too few occupied neighbours
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
  compression: 'none',  // DEM/ortho GeoTIFF: 'none' | 'deflate'
  applyGeoref: true,    // cloud: transform into the project CRS when a georef fit exists
  downsampleCell: 0,    // cloud: voxel downsample cell in world units; 0 = off
  jpegQuality: 0.9,     // ortho JPEG quality (0–1)
}

// Point-cloud / mesh import (ImportCloudModal.vue → useReconstructionStore.importCloud).
// Coordinates import verbatim into the current frame — no CRS reprojection.
export const IMPORT_CLOUD_DEFAULTS = {
  unitScale: 1,      // multiply coordinates: 1 = m, 0.01 = cm, 0.001 = mm source units
  swapYZ: false,     // Y-up source (many mesh tools) → Z-up
  subsampleCell: 0,  // voxel subsample cell in world units after scaling; 0 = off
}

// Mesh (screened Poisson, core/products/mesh.js + crates/mesh). Mirrored by
// MeshModal.vue. `screening` is the Poisson point-fitting weight (the vendored
// library's quality lever; the classic PoissonRecon "samples per node" knob is not
// exposed — see crates/mesh/src/lib.rs). `trimFactor` multiplies the dense cloud's
// merge cell to set the world-unit trim radius. UI: trimFactor 0 ⇒ no trimming.
export const MESH_DEFAULTS = {
  depth: 8,          // octree max depth (detail vs cost/RAM)
  screening: 4,      // Poisson point-fitting weight; 0 disables screening
  trimFactor: 6,     // trim radius = trimFactor × dense mergeCell; 0 = no trim
  colorize: true,    // transfer dense-cloud colour onto the mesh vertices
}
// Mesh quality presets — octree depth is the detail/cost lever (deltas; medium ≡ defaults).
export const MESH_PRESETS = {
  low:    { depth: 6 },
  medium: {},
  high:   { depth: 10 },
}
export const MESH_PRESET_META = [
  { id: 'low',    label: 'Coarse',   blurb: 'Octree depth 6 · quick preview' },
  { id: 'medium', label: 'Balanced', blurb: 'Octree depth 8 · default' },
  { id: 'high',   label: 'Fine',     blurb: 'Octree depth 10 · detailed, slow' },
]

// Cloud editing (core/products/cloudEdit.js). Mirrored by FilterCloudModal.vue /
// CropCloudModal.vue / MergeCloudsModal.vue. These edit **dense** clouds only — a
// sparse cloud carries the per-point view-tracks the dense/ortho/COLMAP paths read,
// so it is not editable here (see the module docstring).
//
// The filter's `methods` list is ordered and each stage feeds the next, so the
// default order is deliberate: cheap linear rejections first, the O(N·27-cell)
// neighbour sweep last, over the smallest cloud.
export const FILTER_CLOUD_DEFAULTS = {
  methods: ['sor'],   // any of 'range' | 'voxel' | 'isolated' | 'sor', in run order
  // Statistical outlier removal.
  sorK: 12,           // neighbours averaged per point
  sorStdRatio: 1.5,   // drop above mean + ratio·σ; lower = more aggressive
  // Voxel downsample. 0 ⇒ auto (the dense run's merge cell, filled in by the store).
  voxelCell: 0,
  // Isolated-cluster removal. 0 ⇒ auto (4× the estimated point spacing).
  isolatedCell: 0,
  isolatedMinNeighbors: 2,  // occupied neighbour cells needed to keep a low-support cell
  isolatedMaxSupport: 2,    // cells with more points than this are never tested
  // Elevation / brightness band. null ⇒ unbounded on that side.
  zMin: null, zMax: null, lumaMin: null, lumaMax: null,
}
// Filter presets — deltas over the defaults; 'medium' ≡ defaults.
export const FILTER_CLOUD_PRESETS = {
  light:  { methods: ['sor'], sorStdRatio: 2.5 },
  medium: {},
  strong: { methods: ['isolated', 'sor'], sorStdRatio: 1.0 },
}
export const FILTER_CLOUD_PRESET_META = [
  { id: 'light',  label: 'Light',    blurb: 'Outlier removal only · trims obvious flyers' },
  { id: 'medium', label: 'Balanced', blurb: 'Outlier removal at 1.5σ · default' },
  { id: 'strong', label: 'Strong',   blurb: 'Isolated clusters + 1.0σ · may bite into thin detail' },
]

// Crop. Bounds are prefilled from the source cloud's bbox by the modal; a null
// component means "unbounded on that side", so a Z-only crop needs no X/Y numbers.
export const CROP_CLOUD_DEFAULTS = {
  minX: null, minY: null, minZ: null,
  maxX: null, maxY: null, maxZ: null,
  invert: false,      // keep what falls OUTSIDE the box instead
}

// Merge. `cell` voxel-dedupes the result — the seam where two overlapping clouds
// meet is otherwise double-density. 0 ⇒ plain concatenation.
export const MERGE_CLOUDS_DEFAULTS = {
  cell: 0,
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

// Automatic fiducial measurement on film scans (core/sfm/fiducialDetect.js,
// driven by useImagesStore.autoDetectFiducials). Mirrored by
// FiducialDetectModal.vue. The algorithm's own knobs (template size, coarse
// scale, refine window) are NOT here — they are co-located with the algorithm as
// FIDUCIAL_DETECT_TUNING, per the self-contained-module exception.
export const FIDUCIAL_DETECT_DEFAULTS = {
  mode: 'automatic',     // generated family prototypes; no marked reference scan
  family: 'generic',     // generic | right-angle | cut-45 | frame
  rotationK: 0,          // clockwise quarter-turns relative to certificate layout
  bootstrapMinScore: 0.28,
  searchRadiusPct: 4,   // search window half-size, % of max(image w, h)
  minScore: 0.7,        // absolute ZNCC floor
  maxRmsUm: 30,         // affine-fit RMS gate (µm) — matches manual-marking quality
  overwrite: false,     // replace existing (manual) observations
  tryRotations: true,   // probe for a 90° scan rotation before searching
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
