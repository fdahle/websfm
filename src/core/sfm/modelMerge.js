// Merge another project's solved model into this one's (Import ▸ WebSfM Project ▸
// Model: merge it into this model). Pure: plain data in, plain data out.
//
// Two blocks need not overlap to be merged; they need something in common to place
// one in the other's frame. All three ways reduce to points known in both frames,
// B's model frame (src) and A's (dst), and one similarity fitted through them:
//
//   photos   a photo both projects solved: its camera centre in each model, plus the
//            camera rotations, which must agree once B is turned into A's frame.
//   gcps     a GCP or marker of the same name triangulated in each model from its
//            marks (works without surveyed coordinates: markers alone place B).
//   georef   both models georeferenced: B's camera centres taken through B's
//            georeference into B's CRS, into A's CRS, and back through A's
//            georeference into A's model frame.
//
// 'auto' tries them in that order (most direct first) and takes the first accepted.
// The fit is gated like the secondary-model merge (multiModel.js): position RMS
// against the span of the common points, and the leave-one-out scale spread. Nothing
// is adjusted afterwards: the blocks keep their own shape, and a later Optimize Cameras
// or Add to the model ties them where they overlap.
//
// B's cameras keep B's solved lens (per-photo calibration groups, which the frame
// resolver prefers over sensor groups), so merging never re-interprets B's pixels
// through A's lens. B's tracks lose their views on photos both projects hold: those
// number B's keypoints of the photo, and A keeps its own.

import { cameraCenter } from './geometry.js'
import { fitSimilarity, applySimilarity } from '../products/georef.js'
import { SparsePoints } from './sparsePoints.js'

export const MODEL_MERGE_METHODS = ['photos', 'gcps', 'georef']

const transpose = (R) => [
  [R[0][0], R[1][0], R[2][0]],
  [R[0][1], R[1][1], R[2][1]],
  [R[0][2], R[1][2], R[2][2]],
]
const mul = (A, B) =>
  Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]),
  )
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
function rotationErrorDeg(A, B) {
  const R = mul(A, transpose(B))
  return (Math.acos(clamp((R[0][0] + R[1][1] + R[2][2] - 1) / 2, -1, 1)) * 180) / Math.PI
}
function diameter(points) {
  let d = 0
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      d = Math.max(d, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]))
  return d
}

/**
 * A camera { R, t, … } (x_cam = R·X + t) moved by dst = s·Q·src + t_sim. A rolling-shutter
 * camera's centre velocity (rs.v, model units per second, rollingShutter.js) turns and
 * scales with the model.
 */
export function transformCamera(cam, sim) {
  const R = mul(cam.R, transpose(sim.R))
  const Rt = [0, 1, 2].map((i) => R[i][0] * sim.t[0] + R[i][1] * sim.t[1] + R[i][2] * sim.t[2])
  const out = { ...cam, R, t: cam.t.map((v, i) => sim.scale * v - Rt[i]) }
  const v = cam.rs?.v
  if (v) out.rs = { ...cam.rs, v: sim.R.map((r) => sim.scale * (r[0] * v[0] + r[1] * v[1] + r[2] * v[2])) }
  return out
}

// ── Points in both frames ─────────────────────────────────────────────────────

/** Photos solved in both: camsA / camsB Map<uuid, camera>, sharedBtoA Map<B uuid, A uuid>. */
export function sharedPhotoPairs(camsA, camsB, sharedBtoA) {
  const out = []
  for (const [ub, ua] of sharedBtoA) {
    const a = camsA.get(ua),
      b = camsB.get(ub)
    if (a && b) out.push({ label: ub, src: cameraCenter(b), dst: cameraCenter(a) })
  }
  return out
}

/** GCPs triangulated in both: Map<name, [x, y, z]> in each model's frame. */
export function gcpPairs(triA, triB) {
  const out = []
  for (const [name, b] of triB) {
    const a = triA.get(name)
    if (a && b) out.push({ label: name, src: b, dst: a })
  }
  return out.sort((p, q) => String(p.label).localeCompare(String(q.label)))
}

/**
 * B's camera centres carried into A's frame through both georeferences: `toA(p)` maps
 * a point of B's model frame to A's (B georef → B CRS → A CRS → A georef inverse),
 * or returns null where the CRS conversion fails.
 */
export function crossGeorefPairs(camsB, toA) {
  const out = []
  for (const [uuid, cam] of camsB) {
    const src = cameraCenter(cam)
    const dst = toA(src)
    if (dst && dst.every(Number.isFinite)) out.push({ label: uuid, src, dst })
  }
  return out
}

// ── The fit ───────────────────────────────────────────────────────────────────

/**
 * One similarity B → A through `pairs`, gated. → { accepted, reason?, sim, n, rms,
 * rmsFrac, scaleSpread }. rmsFrac is the position RMS over the span of the common
 * points in A's frame, so it does not depend on the model's arbitrary scale.
 */
export function fitModelAlignment(pairs, opts = {}) {
  const minPairs = opts.minPairs ?? 3
  const maxRmsFrac = opts.maxRmsFrac ?? 0.02
  const maxScaleSpread = opts.maxScaleSpread ?? 0.05
  const n = pairs.length
  if (n < minPairs) return { accepted: false, reason: `${n} of the ${minPairs} needed`, n }
  const sim = fitSimilarity(pairs)
  if (!sim) return { accepted: false, reason: 'they lie on a line', n }
  const span = diameter(pairs.map((p) => p.dst))
  const rmsFrac = sim.rms / Math.max(span, 1e-12)
  let scaleSpread = 0
  if (n >= 4) {
    const scales = pairs
      .map((_, omit) => fitSimilarity(pairs.filter((__, i) => i !== omit))?.scale)
      .filter((s) => s > 0)
    if (scales.length) scaleSpread = (Math.max(...scales) - Math.min(...scales)) / sim.scale
  }
  const out = { sim, n, rms: sim.rms, rmsFrac, scaleSpread }
  if (rmsFrac > maxRmsFrac)
    return { ...out, accepted: false, reason: `they disagree by ${(100 * rmsFrac).toFixed(1)} % of their span` }
  if (scaleSpread > maxScaleSpread)
    return {
      ...out,
      accepted: false,
      reason: `the scale moves ${(100 * scaleSpread).toFixed(1)} % without one of them`,
    }
  return { ...out, accepted: true }
}

/** Shared photos: B's camera rotations, turned into A's frame, against A's. */
export function rotationAgreement(camsA, camsB, sharedBtoA, sim, opts = {}) {
  const maxMedianDeg = opts.maxMedianDeg ?? 3
  const maxDeg = opts.maxDeg ?? 8
  const Qt = transpose(sim.R)
  const errs = []
  for (const [ub, ua] of sharedBtoA) {
    const a = camsA.get(ua),
      b = camsB.get(ub)
    if (a && b) errs.push(rotationErrorDeg(mul(b.R, Qt), a.R))
  }
  errs.sort((x, y) => x - y)
  const medianDeg = errs.length ? errs[errs.length >> 1] : 0
  const worstDeg = errs.length ? errs[errs.length - 1] : 0
  const accepted = medianDeg <= maxMedianDeg && worstDeg <= maxDeg
  return {
    accepted,
    medianDeg,
    worstDeg,
    ...(accepted ? {} : { reason: `the camera directions disagree (median ${medianDeg.toFixed(1)}°)` }),
  }
}

/**
 * Align B to A by `method` ('auto' | 'photos' | 'gcps' | 'georef'). `inputs` holds what
 * each method needs; a method whose input is missing is skipped:
 *   { camsA, camsB, sharedBtoA, triA, triB, toA }
 * → { accepted, method, sim, …fit, tried: [{ method, accepted, reason }] }.
 */
export function alignModels(inputs, method = 'auto', opts = {}) {
  const order = method === 'auto' ? MODEL_MERGE_METHODS : [method]
  const tried = []
  for (const m of order) {
    let pairs = null
    if (m === 'photos' && inputs.sharedBtoA?.size)
      pairs = sharedPhotoPairs(inputs.camsA, inputs.camsB, inputs.sharedBtoA)
    else if (m === 'gcps' && inputs.triA && inputs.triB) pairs = gcpPairs(inputs.triA, inputs.triB)
    else if (m === 'georef' && inputs.toA) pairs = crossGeorefPairs(inputs.camsB, inputs.toA)
    if (!pairs) {
      tried.push({ method: m, accepted: false, reason: UNAVAILABLE[m] })
      continue
    }
    const fit = fitModelAlignment(pairs, opts[m] ?? {})
    let result = { method: m, ...fit }
    if (fit.accepted && m === 'photos') {
      const rot = rotationAgreement(inputs.camsA, inputs.camsB, inputs.sharedBtoA, fit.sim, opts.rotation)
      result = { ...result, rotation: rot, accepted: rot.accepted, ...(rot.accepted ? {} : { reason: rot.reason }) }
    }
    tried.push({ method: m, accepted: result.accepted, n: fit.n, reason: result.reason ?? null })
    if (result.accepted) return { ...result, tried }
  }
  return { accepted: false, method: null, tried }
}

const UNAVAILABLE = {
  photos: 'no photo is in both models',
  gcps: 'no GCP or marker is triangulated in both models',
  georef: 'the two models are not both georeferenced',
}

// ── The merge ─────────────────────────────────────────────────────────────────

/**
 * B's model in A's frame, merged with A's (`a` may be null: B comes in alone).
 *   a, b        { cameras: Map<uuid, camera>, points: SparsePoints, calibration? }
 *   sim         B → A (null: B is already in A's frame)
 *   sharedBtoA  Map<B uuid, A uuid> — photos both projects hold
 *   sensorOfB   Map<B uuid, B sensor id> — to find B's lens for each B camera
 * → { cameras, points, calibration, added: { cameras, points }, dropped: { cameras, views } }
 */
export function mergeModels(a, b, { sim = null, sharedBtoA = new Map(), sensorOfB = new Map() } = {}) {
  const camsA = a?.cameras ?? new Map()
  const cameras = new Map(camsA)
  let addedCameras = 0,
    droppedCameras = 0
  const movedB = new Map() // B uuid → the camera as it lands in A (A's uuid for a shared photo)
  for (const [ub, cam] of b.cameras) {
    const uuid = sharedBtoA.get(ub) ?? ub
    if (cameras.has(uuid)) {
      droppedCameras++
      continue
    }
    const moved = sim ? transformCamera(cam, sim) : cam
    cameras.set(uuid, moved)
    movedB.set(ub, uuid)
    addedCameras++
  }

  // B's tracks without their views on shared photos (B's keypoint numbers of them).
  const sharedB = new Set(sharedBtoA.keys())
  const { points: bKept } = (b.points ?? SparsePoints.empty()).withoutViews(sharedB, 2)
  let bPoints = bKept
  if (sim && bKept.length) {
    const pos = new Float64Array(3 * bKept.length)
    for (let i = 0; i < bKept.length; i++) pos.set(applySimilarity(sim, bKept.xyz(i)), 3 * i)
    bPoints = bKept.withPositions(pos)
  }
  let droppedViews = 0 // views on shared photos
  const src = b.points ?? SparsePoints.empty()
  for (let k = 0; k < src.viewTotal; k++) if (sharedB.has(src.viewUuids[src.vcam[k]])) droppedViews++
  const points = SparsePoints.concat([a?.points ?? SparsePoints.empty(), bPoints])

  return {
    cameras,
    points,
    calibration: mergeCalibration(a?.calibration ?? null, b.calibration ?? null, movedB, sensorOfB),
    added: { cameras: addedCameras, points: bPoints.length },
    dropped: { cameras: droppedCameras, views: droppedViews, points: (b.points?.length ?? 0) - bKept.length },
  }
}

// A's calibration with B's lens for each camera B brings, as a per-photo group (the
// resolver looks an image's own group up before its sensor's), and B's film transforms.
function mergeCalibration(calA, calB, movedB, sensorOfB) {
  if (!calB) return calA
  const groupBy = new Map(
    (calB.groups ?? []).map((g) => [g.sensorId != null ? `sensor:${g.sensorId}` : `image:${g.imageUuid}`, g]),
  )
  const groups = [...(calA?.groups ?? [])]
  for (const [ub, uuid] of movedB) {
    const sid = sensorOfB.get(ub)
    const g = groupBy.get(`image:${ub}`) ?? (sid != null ? groupBy.get(`sensor:${sid}`) : null)
    if (!g) continue
    const { sensorId: _s, imageUuid: _i, ...lens } = g
    groups.push({ imageUuid: uuid, ...structuredClone(lens) })
  }
  const fiducialTransforms = [...(calA?.fiducialTransforms ?? [])]
  for (const t of calB.fiducialTransforms ?? [])
    if (movedB.has(t.uuid)) fiducialTransforms.push({ ...structuredClone(t), uuid: movedB.get(t.uuid) })
  return { ...(calA ?? { source: calB.source ?? 'run' }), groups, fiducialTransforms }
}
