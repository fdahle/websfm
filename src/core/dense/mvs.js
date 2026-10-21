// Dense reconstruction (Multi-View Stereo) — pure compute, no Vue/Pinia/OPFS/DOM.
// Mirrors core/sfm/sfm.js: plain data in, plain data out, side effects via hooks. The
// worker (compute.worker.js) decodes image pixels (OffscreenCanvas) and calls
// these; the store keeps reactive state + persistence.
//
// Pipeline (two standalone stages, like Metashape's Build Depth Maps → Build
// Point Cloud):
//   A. computeDepthMaps — per reference image: pick source views, seed a depth
//      range from the sparse cloud, run PatchMatch (compute_depth_map in the
//      reconstruction crate). Produces one depth map per image.
//   B. fuseDepthMaps    — reproject depth pixels to 3D, keep those consistent
//      across ≥k views, colour from the reference pixel. Produces a dense cloud.

// The engine is split by stage; this module re-exports every entry point so existing
// imports keep working:
//   denseGeometry.js   relativePose, project/unprojectPixel, the frustum-slice cull
//   denseOptions.js    numOpt/boolOpt (engine-boundary option sanitizers)
//   depthMap.js        Stage A per image: source views, seeding, pyramid, depthMapForImage,
//                      filterDepthMap, quality presets, depthMapSettings
//   geomFilter.js      the cross-view geometric filter (resident + streamed)
//   voxelAccumulator.js  mergePointsSpatial, createVoxelAccumulator, cell-size clamp
//   fusionPlan.js      Stage B pre-passes, preflight, slab plan, fusionGates
//   fusion.js          Stage B slab pass, finishFusion, resident + streamed runners

// Re-exported for the compute worker, which imports them from this module.
export { cameraCenter, scaleK, rgbaToGray } from '../sfm/geometry.js'

export { relativePose } from './denseGeometry.js'
export {
  selectSourceViews,
  seedDepthFromSparse,
  depthMapForImage,
  filterDepthMap,
  qualityToMaxDim,
  fitDepthQuality,
  autoBestK,
  depthMapSettings,
} from './depthMap.js'
export {
  filterCandidates,
  geomFilterLoopShare,
  filterDepthMapsGeometric,
  filterDepthMapsGeometricStreamed,
  logFilterCache,
  applyPackedMask,
  filterSettings,
  filterConfig,
  logFilterTotals,
  requiredConsistentViews,
  emptyFilterTotals,
} from './geomFilter.js'
export { mergePointsSpatial, createVoxelAccumulator } from './voxelAccumulator.js'
export { fusionCostStats, planFusionSlabs, fusionGates } from './fusionPlan.js'
export {
  fuseDepthMaps,
  fuseDepthMapsStreamed,
  streamedEligible,
  logFusionStream,
  mergeFusionCounters,
  finishFusion,
} from './fusion.js'
