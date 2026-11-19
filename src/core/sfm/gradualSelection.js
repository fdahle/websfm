import { cameraCenter, projectWithDepth, triangulationAngle } from './geometry.js'
import { buildCameraPriorConstraints, qualifyingGcps, buildGcpAnchors } from './surveyConstraints.js'
import { SFM_TUNING } from '../tuning.js'
import { tieWeightOf } from './baObservations.js'
import { distortPixel, undistortPixel } from './distortion.js'

// A camera's view pixel → the pixel its lens recorded. A lens may carry `layers`, the
// lenses its view was undistorted by, innermost last (an older run's radial correction
// on top of its sensor's lens: [correction, sensor lens]); they are put back in turn.
function recordedPixel(x, y, K, lens) {
  if (!lens?.layers) return distortPixel(x, y, K, lens)
  let p = { x, y }
  for (const layer of lens.layers) p = distortPixel(p.x, p.y, K, layer)
  return p
}

// points: SparsePoints. Per point, as columns (transferable, no object per point):
//   error  RMS reprojection error in px (NaN: no stored observation; Infinity: behind a camera)
//   track  views in the model's cameras;   angle  largest triangulation angle, degrees
export function sparsePointMetrics(cameras, points) {
  const centers = new Map([...cameras].map(([id, camera]) => [id, cameraCenter(camera)]))
  const n = points.length
  const error = new Float32Array(n),
    track = new Uint16Array(n),
    angle = new Float32Array(n)
  const seen = [],
    p = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < n; i++) {
    p.x = points.x(i)
    p.y = points.y(i)
    p.z = points.z(i)
    seen.length = 0
    points.forEachView(i, (id) => {
      if (cameras.has(id)) seen.push(centers.get(id))
    })
    let squared = 0,
      observations = 0,
      best = 0
    points.forEachPixel(i, (id, px, py) => {
      const camera = cameras.get(id)
      if (!camera || !Number.isFinite(py)) return
      const projected = projectWithDepth(camera, p.x, p.y, p.z)
      if (!projected) {
        squared = Infinity
        observations++
        return
      }
      squared += (projected.u - px) ** 2 + (projected.v - py) ** 2
      observations++
    })
    for (let a = 0; a < seen.length; a++)
      for (let b = 0; b < a; b++) best = Math.max(best, triangulationAngle(seen[a], seen[b], p))
    error[i] = observations ? Math.sqrt(squared / observations) : NaN
    track[i] = Math.min(seen.length, 65535)
    angle[i] = best
  }
  return { count: n, error, track, angle }
}

export function selectedSparseIndices(metrics, { metric, threshold }) {
  if (!['error', 'track', 'angle'].includes(metric) || !Number.isFinite(threshold) || threshold < 0)
    throw new Error('Invalid gradual-selection threshold')
  const values = metrics[metric],
    indices = []
  for (let i = 0; i < metrics.count; i++) {
    const v = values[i]
    if (Number.isNaN(v)) continue
    if (metric === 'error' ? v > threshold : v < threshold) indices.push(i)
  }
  return indices
}

// One constrained bundle adjustment over a disposable copy of the model — the
// solve gradual selection and Optimize cameras share. Builds the observations from
// the stored (canonical, pinhole-frame) view pixels, refuses a camera left without
// support or a network that falls apart, holds the solve to the survey evidence,
// and accepts it only under the cost rule. `subject` words the refusals for the
// calling tool ("Selection would…" / "The model has…").
//
// `constraints` = { gcps, cameraPriors, detectScaleFactor } in the survey frame (GCP
// marks in the pinhole frame, keyed by uuid) — the same evidence the solve was held
// to. Without them a re-solve can only lower the reprojection cost, so the ≤-cost gate
// always passed while it quietly undid a GCP doming correction. A tie point weighs as
// the run weighed it, one detection pixel (tieWeightOf, the run's `detectScaleFactor`
// from summary.gates): at weight 1 the ties pulled the model back towards its tie-only
// shape by f² against the GCPs and positions.
//
// `lensOf(uuid)` (optional) names the fisheye cameras: their observations go to the
// solve in the pixels the lens recorded, with the lens on K (bundleSession.js
// lensFrame, the same frame the reconstruction solved them in).
async function constrainedRefine(cameras, kept, bundleAdjust, constraints, { subject, baOpts = {}, lensOf = null }) {
  const entries = [...cameras],
    cameraIndices = new Map(entries.map(([id], i) => [id, i]))
  const observations = [],
    support = new Uint32Array(entries.length)
  const tieWeight = tieWeightOf(constraints.detectScaleFactor)
  const weights = tieWeight === 1 ? {} : { weightX: tieWeight, weightY: tieWeight }
  for (let ptIdx = 0; ptIdx < kept.length; ptIdx++) {
    let n = 0
    kept.forEachPixel(ptIdx, (id, x, y) => {
      const camIdx = cameraIndices.get(id)
      if (camIdx == null || !Number.isFinite(y)) return
      observations.push({ camIdx, ptIdx, x, y, ...weights })
      support[camIdx]++
      n++
    })
    if (n < 2) throw new Error('Every surviving point needs stored observations in at least two cameras')
  }
  if (support.some((n) => n < 6)) throw new Error(`${subject.would} leave a camera with fewer than six observations`)
  // A disconnected observation graph has independent gauges; do not silently
  // refine it as one model.
  const parent = entries.map((_, i) => i)
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])))
  for (let i = 0; i < kept.length; i++) {
    let first = -1
    kept.forEachPixel(i, (id) => {
      const c = cameraIndices.get(id)
      if (c == null) return
      if (first < 0) first = c
      else parent[root(c)] = root(first)
    })
  }
  if (new Set(parent.map((_, i) => root(i))).size > 1) throw new Error(`${subject.would} disconnect the camera network`)
  const uuidList = entries.map(([id]) => id)
  const { gcps = [], cameraPriors = [] } = constraints
  let anchorSetup = null,
    anchorError = null
  const qualifying = qualifyingGcps(gcps, cameras)
  if (qualifying.length >= 3) {
    const setup = await buildGcpAnchors({ cameras, qualifying, camIdxOf: cameraIndices, firstPointIndex: kept.length })
    if (setup.error) anchorError = setup.error
    else anchorSetup = setup
  }
  const priorSet = buildCameraPriorConstraints({
    cameras,
    cameraPriors,
    uuidList,
    minCameras: SFM_TUNING.cameraPriorBaMinCameras,
    reference: anchorSetup ? { fit: anchorSetup.fit, frame: anchorSetup.frame } : null,
  })
  const constrained = !!(anchorSetup || priorSet)
  const lenses = entries.map(([id]) => lensOf?.(id) ?? null)
  // A Brown lens solves in the pixels it recorded with the whole lens on K (bundle.rs
  // `fullLens`, as bundleSession.js lensFrame): a camera without one gets a zero lens.
  const fullLens = lenses.some((l) => l && !l.fisheye)
  const Ks = entries.map(([, c], i) =>
    lenses[i]?.fisheye
      ? {
          ...c.K,
          fisheye: true,
          fisheyeTerms: 4,
          k1: lenses[i].k1,
          k2: lenses[i].k2,
          k3: lenses[i].k3,
          k4: lenses[i].k4,
        }
      : fullLens
        ? {
            ...c.K,
            k1: lenses[i]?.k1 || 0,
            k2: lenses[i]?.k2 || 0,
            k3: lenses[i]?.k3 || 0,
            p1: lenses[i]?.p1 || 0,
            p2: lenses[i]?.p2 || 0,
          }
        : c.K,
  )
  const toLensFrame = (o) => {
    const lens = lenses[o.camIdx]
    if (!lens) return o
    const p = recordedPixel(o.x, o.y, entries[o.camIdx][1].K, lens)
    return { ...o, x: p.x, y: p.y }
  }
  const allObs = anchorSetup ? [...observations, ...anchorSetup.observations] : observations
  let pos = kept.pos
  if (anchorSetup) {
    pos = new Float64Array(kept.pos.length + 3 * anchorSetup.anchorPts.length)
    pos.set(kept.pos)
    anchorSetup.anchorPts.forEach((a, j) => pos.set([a.x, a.y, a.z], kept.pos.length + 3 * j))
  }
  const result = await bundleAdjust(
    entries.map(([, c]) => c),
    Ks,
    pos,
    lenses.some(Boolean) ? allObs.map(toLensFrame) : allObs,
    {
      maxIters: 30,
      refineIntrinsics: 'none',
      ...baOpts,
      ...(fullLens ? { fullLens: true } : {}),
      flatPoints: true,
      ...(anchorSetup ? { gcpAnchors: anchorSetup.anchors } : {}),
      ...(priorSet ? { cameraPriors: priorSet.priors } : {}),
    },
  )
  // An unconstrained re-solve must not raise the residual. A constrained one may,
  // within the allowance the main solve grants survey constraints (bundleSession.js).
  const allowance = constrained
    ? Math.max(
        SFM_TUNING.cameraPriorMaxReprojIncreasePx,
        (result?.costBefore ?? 0) * SFM_TUNING.cameraPriorMaxReprojIncreaseFrac,
      )
    : (result?.costBefore ?? 0) * 0.001
  if (
    !result ||
    !Number.isFinite(result.costAfter) ||
    result.costAfter > result.costBefore + allowance ||
    result.pos?.length !== 3 * (kept.length + (anchorSetup?.anchorPts.length ?? 0)) ||
    result.cameras.length !== entries.length ||
    !result.pos.every(Number.isFinite) ||
    result.cameras.some((c) => ![...c.R.flat(), ...c.t].every(Number.isFinite))
  )
    throw new Error('Refinement failed or increased the residual; the original model is unchanged')
  return {
    result,
    entries,
    constraints: {
      gcpAnchors: anchorSetup?.anchors.length ?? 0,
      cameraPriors: priorSet?.priors.length ?? 0,
      ...(anchorError ? { gcpError: anchorError } : {}),
    },
  }
}

// Work on a disposable worker copy. Keep calibration fixed: the view pixels already
// contain the canonical observations from the completed reconstruction.
export async function refineSparseSelection(cameras, points, settings, bundleAdjust, constraints = {}) {
  const removed = new Set(selectedSparseIndices(sparsePointMetrics(cameras, points), settings))
  if (!removed.size) throw new Error('No points selected')
  const kept = points.select(points.indicesWhere((i) => !removed.has(i)))
  if (kept.length < 6) throw new Error('Selection must leave at least six points')
  const {
    result,
    entries,
    constraints: held,
  } = await constrainedRefine(cameras, kept, bundleAdjust, constraints, { subject: { would: 'Selection would' } })
  return {
    status: 'done',
    removed: removed.size,
    costBefore: result.costBefore,
    costAfter: result.costAfter,
    constraints: held,
    cameras: new Map(entries.map(([id, c], i) => [id, { ...c, ...result.cameras[i] }])),
    // Only the real points: anchor points were scratch space for this solve.
    points: kept.withPositions(result.pos.slice(0, 3 * kept.length)),
  }
}

// Optimize cameras (Tools ▸ Model ▾): re-run bundle adjustment on the finished
// model with the focal length (and optionally the principal point, or the whole lens)
// free, shared per sensor, every point kept. The staple step after adding GCPs or
// cleaning points.
//
// The model is pinhole by invariant (CLAUDE.md ▸ Pipelines ▸ 3): its observations are
// the recorded pixels with the lens taken out. 'f' and 'f,cxcy' solve in that view and
// keep the lens. 'full' (Metashape's f, cx, cy, k1–k3, p1, p2) puts each camera's lens
// back on its observations, as Sparse Model's solves do (bundleSession.js lensFrame),
// solves the whole lens with the poses and points, and re-derives the view with the new
// lens about the new K; the caller records the new lens in the model's calibration, so
// dense, the GCP marks and every view of the photos use it.
//
// settings: { refine: 'f' | 'f,cxcy' | 'full', sensorOfUuid: { [uuid]: int },
//   lensOfUuid: { [uuid]: lens } — the model's lens per camera: a fisheye's for every
//   mode, a Brown one ({ k1, k2, k3, p1, p2 }) too for 'full', which may carry `layers`
//   (recordedPixel) when its view was undistorted by more than one lens }
export const OPTIMIZE_REFINE_MODES = ['f', 'f,cxcy', 'full']
// A focal that moves more than this is a runaway, not a refinement (the B4 seed
// went fx 2389 → 4796 while the cost fell): refuse rather than commit it.
export const OPTIMIZE_MAX_FOCAL_CHANGE = 0.2

export async function optimizeCameras(cameras, points, settings, bundleAdjust, constraints = {}) {
  const refine = settings.refine ?? 'f'
  if (!OPTIMIZE_REFINE_MODES.includes(refine)) throw new Error(`Unsupported refinement "${refine}"`)
  const keptIdx = points.indicesWhere((i) => points.pixelCount(i) >= 2)
  const kept = points.select(keptIdx)
  if (kept.length < 6) throw new Error('The model needs at least six points with two or more observations')
  const sensorOf = settings.sensorOfUuid || {}
  const sensorOfCam = [...cameras.keys()].map((id) => (Number.isInteger(sensorOf[id]) ? sensorOf[id] : -1))
  const full = refine === 'full'
  const lensOfUuid = settings.lensOfUuid || {}
  const lensOf = (id) => (lensOfUuid[id]?.fisheye || (full && lensOfUuid[id]) ? lensOfUuid[id] : null)
  const anyFisheye = [...cameras.keys()].some((id) => lensOfUuid[id]?.fisheye)
  // The whole lens: Brown k1–k3 with p1, p2 (bit p), a fisheye's k1–k4.
  const baRefine = full ? `f,cxcy,k1,k2,k3,p${anyFisheye ? ',k4' : ''}` : refine
  const {
    result,
    entries,
    constraints: held,
  } = await constrainedRefine(cameras, kept, bundleAdjust, constraints, {
    subject: { would: 'The model would' },
    baOpts: { refineIntrinsics: baRefine, sensorOfCam },
    lensOf: full ? (id) => lensOf(id) ?? { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 } : lensOf,
  })
  if (!Array.isArray(result.intrinsics) || result.intrinsics.length !== entries.length)
    throw new Error('Refinement returned no intrinsics; the original model is unchanged')
  const intr = result.intrinsics
  let worst = 0
  entries.forEach(([, c], i) => {
    worst = Math.max(worst, Math.abs(intr[i].fx / c.K.fx - 1), Math.abs(intr[i].fy / c.K.fy - 1))
  })
  if (!(worst <= OPTIMIZE_MAX_FOCAL_CHANGE))
    throw new Error(
      `The focal length moved ${(worst * 100).toFixed(0)}% — a runaway, not a refinement; the original model is unchanged`,
    )
  const withCxCy = full || refine.includes('cxcy')
  const newK = new Map(
    entries.map(([id, c], i) => [
      id,
      { ...c.K, fx: intr[i].fx, fy: intr[i].fy, ...(withCxCy ? { cx: intr[i].cx, cy: intr[i].cy } : {}) },
    ]),
  )
  // The lens each camera has after the solve: the solved one for 'full', else its own.
  const newLens = new Map(
    entries.map(([id], i) => {
      if (!full) return [id, lensOf(id)]
      const r = intr[i]
      return [
        id,
        r.fisheye
          ? { fisheye: true, k1: r.k1 || 0, k2: r.k2 || 0, k3: r.k3 || 0, k4: r.k4 || 0 }
          : { k1: r.k1 || 0, k2: r.k2 || 0, k3: r.k3 || 0, p1: r.p1 || 0, p2: r.p2 || 0 },
      ]
    }),
  )
  if (full) {
    for (const lens of newLens.values())
      if (!Object.values(lens).every((v) => v === true || Number.isFinite(v)))
        throw new Error('The lens solve returned no finite terms; the original model is unchanged')
  }
  // A camera's stored observations are its recorded pixels undistorted about its K and
  // lens; dense pairs the lens with the camera's K, so a moved K or a new lens re-derives
  // them (old K and lens → recorded pixel → new K and lens), as selfCalFold.js does.
  const remapPixel = (id, x, y) => {
    const lens0 = lensOf(id),
      lens1 = newLens.get(id),
      K0 = cameras.get(id)?.K
    if ((!lens0 && !lens1) || !K0) return null
    const raw = lens0 ? recordedPixel(x, y, K0, lens0) : { x, y }
    const q = lens1 ? undistortPixel(raw.x, raw.y, newK.get(id), lens1) : raw
    return [q.x, q.y]
  }
  return {
    status: 'done',
    costBefore: result.costBefore,
    costAfter: result.costAfter,
    constraints: held,
    focalChange: worst,
    cameras: new Map(
      entries.map(([id, c], i) => [
        id,
        {
          ...c,
          ...result.cameras[i],
          // The lens is not on K: it goes to the calibration ('full'), and the
          // observations follow the new K and lens below.
          K: newK.get(id),
        },
      ]),
    ),
    // Points the solve could not see (< 2 stored observations) would sit stale
    // against the moved cameras, so they are dropped and counted, not kept.
    points: points.select(keptIdx, { pos: result.pos.slice(0, 3 * kept.length), pixel: remapPixel }),
    dropped: points.length - kept.length,
    // 'full': the solved lens per camera, for the model's calibration.
    ...(full ? { lenses: Object.fromEntries(newLens) } : {}),
  }
}
