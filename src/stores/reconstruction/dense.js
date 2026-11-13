import { createDepthRun } from './depthRun.js'
import { createMeshRun } from './meshRun.js'
import { createFusionRun } from './fusionRun.js'
import { isAbort } from '../../workers/computeClient.js'

// The dense pipeline, split out of useReconstructionStore: Stage A depth maps
// (PatchMatch MVS in the workers, persisted per image), the saved-map filter,
// fusion into the dense cloud (streamed over the worker pool when the maps are on
// disk), and Poisson meshing. Each run checks it is still current — same project,
// same main sparse model — before it commits anything.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createDense({
  beginStreamedDepthMaps,
  clipToRegion,
  clouds,
  denseSummary,
  depthMapInput,
  depthMaps,
  depthMapsMeta,
  depthSummary,
  images,
  imagesStore,
  isPersisting,
  loadDepthIndexIntoMeta,
  log,
  mainSparseCloud,
  meshSource,
  meshSources,
  save,
  persistDepthMaps,
  projects,
  reconStatus,
  sensors,
  summary,
  upsertDenseCloud,
  upsertMeshCloud,
  withRegion,
  activeRegion,
}) {
  // A run's Cancel rejects with an AbortError (computeClient.js cancelRun): a cancel,
  // logged as one, the status back to idle — not an error.
  const cancelled = (err, what, area = 'Products') => {
    if (!isAbort(err)) return false
    log(`${what} cancelled`, 'info', area)
    reconStatus.value = 'idle'
    return true
  }
  // Depth maps, meshing (before fusion, which takes its pageCloudBytes) and fusion,
  // each in its own file beside this one.
  const { computeDepthMaps, depthCameraKeys, filterSavedDepthMaps } = createDepthRun({
    activeRegion,
    beginStreamedDepthMaps,
    cancelled,
    depthMaps,
    depthMapsMeta,
    depthSummary,
    images,
    imagesStore,
    isPersisting,
    log,
    mainSparseCloud,
    persistDepthMaps,
    projects,
    reconStatus,
    sensors,
    summary,
    withRegion,
  })
  const { generateMesh, meshDepthInputs, pageCloudBytes } = createMeshRun({
    activeRegion,
    cancelled,
    clipToRegion,
    clouds,
    denseSummary,
    log,
    meshSource,
    meshSources,
    reconStatus,
    save,
    upsertMeshCloud,
  })
  const { densify, densifyParallel } = createFusionRun({
    cancelled,
    denseSummary,
    depthMapInput,
    depthMaps,
    images,
    loadDepthIndexIntoMeta,
    log,
    mainSparseCloud,
    pageCloudBytes,
    projects,
    reconStatus,
    save,
    summary,
    upsertDenseCloud,
    withRegion,
  })

  return {
    computeDepthMaps,
    depthCameraKeys,
    filterSavedDepthMaps,
    densifyParallel,
    densify,
    generateMesh,
    meshDepthInputs,
  }
}
