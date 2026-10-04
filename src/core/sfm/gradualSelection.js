import { cameraCenter, projectWithDepth, triangulationAngle } from './geometry.js'
import { buildCameraPriorConstraints, qualifyingGcps, buildGcpAnchors } from './surveyConstraints.js'
import { SFM_TUNING } from '../tuning.js'

export function sparsePointMetrics(cameras, points) {
  const centers = new Map([...cameras].map(([id, camera]) => [id, cameraCenter(camera)]))
  return points.map(point => {
    const views = [...(point.views || [])].filter(([id]) => cameras.has(id))
    let squared = 0, observations = 0, angle = 0
    for (const [id, pixel] of point.viewsPx || []) {
      const camera = cameras.get(id)
      if (!camera || !pixel?.every(Number.isFinite)) continue
      const projected = projectWithDepth(camera, point.x, point.y, point.z)
      if (!projected) { squared = Infinity; observations++; continue }
      squared += (projected.u - pixel[0]) ** 2 + (projected.v - pixel[1]) ** 2
      observations++
    }
    for (let i = 0; i < views.length; i++) for (let j = 0; j < i; j++)
      angle = Math.max(angle, triangulationAngle(centers.get(views[i][0]), centers.get(views[j][0]), point))
    return { error: observations ? Math.sqrt(squared / observations) : null, track: views.length, angle }
  })
}

export function selectedSparseIndices(metrics, { metric, threshold }) {
  if (!['error', 'track', 'angle'].includes(metric) || !Number.isFinite(threshold) || threshold < 0)
    throw new Error('Invalid gradual-selection threshold')
  const indices = []
  metrics.forEach((value, i) => {
    if (value[metric] != null && (metric === 'error' ? value[metric] > threshold : value[metric] < threshold)) indices.push(i)
  })
  return indices
}

// Work on a disposable worker copy. Keep calibration fixed: viewsPx already
// contains the canonical observations from the completed reconstruction.
//
// `constraints` = { gcps, cameraPriors } in the survey frame (GCP marks in the
// pinhole frame, keyed by uuid) — the same evidence the solve was held to. Without
// them a re-solve can only lower the reprojection cost, so the ≤-cost gate always
// passed while it quietly undid a GCP doming correction.
export async function refineSparseSelection(cameras, points, settings, bundleAdjust, constraints = {}) {
  const removed = new Set(selectedSparseIndices(sparsePointMetrics(cameras, points), settings))
  if (!removed.size) throw new Error('No points selected')
  const kept = points.filter((_, i) => !removed.has(i))
  if (kept.length < 6) throw new Error('Selection must leave at least six points')
  const entries = [...cameras], cameraIndices = new Map(entries.map(([id], i) => [id, i]))
  const observations = [], support = new Uint32Array(entries.length)
  kept.forEach((p, ptIdx) => {
    let n = 0
    for (const [id, pixel] of p.viewsPx || []) {
      const camIdx = cameraIndices.get(id)
      if (camIdx == null || !pixel?.every(Number.isFinite)) continue
      observations.push({ camIdx, ptIdx, x: pixel[0], y: pixel[1] }); support[camIdx]++; n++
    }
    if (n < 2) throw new Error('Every surviving point needs stored observations in at least two cameras')
  })
  if (support.some(n => n < 6)) throw new Error('Selection would leave a camera with fewer than six observations')
  // A disconnected observation graph has independent gauges; do not silently
  // refine it as one model after removing its bridging tracks.
  const parent = entries.map((_, i) => i)
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]))
  for (const p of kept) {
    const ids = [...p.viewsPx.keys()].map(id => cameraIndices.get(id)).filter(i => i != null)
    for (let i = 1; i < ids.length; i++) parent[root(ids[i])] = root(ids[0])
  }
  if (new Set(parent.map((_, i) => root(i))).size > 1) throw new Error('Selection would disconnect the camera network')
  const uuidList = entries.map(([id]) => id)
  const { gcps = [], cameraPriors = [] } = constraints
  let anchorSetup = null, anchorError = null
  const qualifying = qualifyingGcps(gcps, cameras)
  if (qualifying.length >= 3) {
    const setup = await buildGcpAnchors({ cameras, qualifying, camIdxOf: cameraIndices, firstPointIndex: kept.length })
    if (setup.error) anchorError = setup.error
    else anchorSetup = setup
  }
  const priorSet = buildCameraPriorConstraints({ cameras, cameraPriors, uuidList,
    minCameras: SFM_TUNING.cameraPriorBaMinCameras,
    reference: anchorSetup ? { fit: anchorSetup.fit, frame: anchorSetup.frame } : null })
  const constrained = !!(anchorSetup || priorSet)
  const result = await bundleAdjust(entries.map(([, c]) => c), entries.map(([, c]) => c.K),
    anchorSetup ? [...kept, ...anchorSetup.anchorPts] : kept,
    anchorSetup ? [...observations, ...anchorSetup.observations] : observations,
    { maxIters: 30, refineIntrinsics: 'none',
      ...(anchorSetup ? { gcpAnchors: anchorSetup.anchors } : {}),
      ...(priorSet ? { cameraPriors: priorSet.priors } : {}) })
  // An unconstrained re-solve must not raise the residual. A constrained one may,
  // within the allowance the main solve grants survey constraints (sfm.js).
  const allowance = constrained
    ? Math.max(SFM_TUNING.cameraPriorMaxReprojIncreasePx, (result?.costBefore ?? 0) * SFM_TUNING.cameraPriorMaxReprojIncreaseFrac)
    : (result?.costBefore ?? 0) * 0.001
  if (!result || !Number.isFinite(result.costAfter) || result.costAfter > result.costBefore + allowance
      || result.points3d.length !== kept.length + (anchorSetup?.anchorPts.length ?? 0)
      || result.cameras.length !== entries.length
      || result.points3d.some(p => ![p.x, p.y, p.z].every(Number.isFinite))
      || result.cameras.some(c => ![...c.R.flat(), ...c.t].every(Number.isFinite)))
    throw new Error('Refinement failed or increased the residual; the original model is unchanged')
  return {
    status: 'done', removed: removed.size, costBefore: result.costBefore, costAfter: result.costAfter,
    constraints: { gcpAnchors: anchorSetup?.anchors.length ?? 0, cameraPriors: priorSet?.priors.length ?? 0,
      ...(anchorError ? { gcpError: anchorError } : {}) },
    cameras: new Map(entries.map(([id, c], i) => [id, { ...c, ...result.cameras[i] }])),
    // Only the real points: anchor points were scratch space for this solve.
    points: kept.map((p, i) => ({ ...p, ...result.points3d[i] })),
  }
}
