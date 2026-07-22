// Conservative secondary-model recovery for incremental SfM.
//
// A stranded image block is reconstructed with a small halo of already-registered
// boundary cameras. The halo gives the two arbitrary SfM frames common camera centres
// and orientations. We merge only when a 7-DOF similarity is supported by >=3 common
// cameras AND the independent camera rotations agree; otherwise the secondary result
// remains a separate model. No threshold is relaxed in either reconstruction.

import { cameraCenter } from './geometry.js'
import { fitSimilarity, applySimilarity } from '../products/georef.js'

const transpose = (R) => [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]]
const mul = (A, B) => Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
  A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]))
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))

export function secondaryJobs(input, primary, opts = {}) {
  const minImages = opts.minImages ?? 8
  const maxBoundary = opts.maxBoundary ?? 12
  const registered = new Set((primary.cameras || []).map((c) => c.uuid))
  const byId = new Map((input.images || []).map((im) => [im.uuid, im]))
  const accepted = (input.pairs || []).filter((p) => p.status === 'done' && !p.weak && p.inlierCount > 0)
  const components = primary.summary?.unregisteredComponents || []
  const jobs = []
  for (const component of components) {
    const ids = component.imageUuids || []
    if (ids.length < minImages) continue
    const set = new Set(ids)
    const score = new Map()
    for (const p of accepted) {
      const aInside = set.has(p.idA), bInside = set.has(p.idB)
      if (aInside === bInside) continue
      const boundary = aInside ? p.idB : p.idA
      if (registered.has(boundary)) score.set(boundary, (score.get(boundary) || 0) + p.inlierCount)
    }
    const boundaryIds = [...score].sort((a, b) => b[1] - a[1]).slice(0, maxBoundary).map(([id]) => id)
    // A component may touch the primary through only one or two immediate bridge
    // cameras (South Building's signature). Two centres cannot determine a stable
    // similarity, so grow the halo through strong primary-primary edges until it has
    // enough independently placed overlap cameras. These extra cameras are not used
    // to weaken the bridge; they are reconstructed normally inside the local model.
    const halo = new Set(boundaryIds)
    while (boundaryIds.length < maxBoundary) {
      const candidates = new Map()
      for (const p of accepted) {
        if (!registered.has(p.idA) || !registered.has(p.idB)) continue
        const a = halo.has(p.idA), b = halo.has(p.idB)
        if (a === b) continue
        const id = a ? p.idB : p.idA
        candidates.set(id, Math.max(candidates.get(id) || 0, p.inlierCount))
      }
      if (!candidates.size) break
      const next = [...candidates].sort((a, b) => b[1] - a[1])[0][0]
      halo.add(next); boundaryIds.push(next)
    }
    const all = new Set([...ids, ...boundaryIds])
    const images = [...all].map((id) => byId.get(id)).filter(Boolean)
    const pairs = (input.pairs || []).filter((p) => all.has(p.idA) && all.has(p.idB))
    jobs.push({ componentIds: ids, boundaryIds, images, pairs })
  }
  return jobs
}

function rotationErrorDeg(A, B) {
  const D = mul(A, transpose(B))
  return Math.acos(clamp((D[0][0] + D[1][1] + D[2][2] - 1) / 2, -1, 1)) * 180 / Math.PI
}

function diameter(points) {
  let d = 0
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
    d = Math.max(d, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]))
  return d
}

export function alignSecondary(primary, secondary, componentIds, opts = {}) {
  const maxPositionRmsFrac = opts.maxPositionRmsFrac ?? 0.02
  const maxMedianRotationDeg = opts.maxMedianRotationDeg ?? 3
  const maxRotationDeg = opts.maxRotationDeg ?? 8
  const maxScaleSpread = opts.maxScaleSpread ?? 0.05
  const maxFocalDiff = opts.maxFocalDiff ?? 0.03
  const maxRadialCoeffDiff = opts.maxRadialCoeffDiff ?? 0.05
  const pcam = new Map((primary.cameras || []).map((c) => [c.uuid, c]))
  const scam = new Map((secondary.cameras || []).map((c) => [c.uuid, c]))
  const common = [...scam.keys()].filter((id) => pcam.has(id))
  if (common.length < 3) return { accepted: false, reason: `only ${common.length}/3 shared cameras`, common }
  const pairs = common.map((id) => ({ src: cameraCenter(scam.get(id)), dst: cameraCenter(pcam.get(id)) }))
  const sim = fitSimilarity(pairs)
  if (!sim) return { accepted: false, reason: 'shared camera centres are degenerate', common }
  const span = diameter(pairs.map((p) => p.dst))
  const rmsFrac = sim.rms / Math.max(span, 1e-12)
  const Qt = transpose(sim.R)
  const rotErrors = common.map((id) => rotationErrorDeg(mul(scam.get(id).R, Qt), pcam.get(id).R)).sort((a, b) => a - b)
  const medianRotationDeg = rotErrors[rotErrors.length >> 1]
  const worstRotationDeg = rotErrors[rotErrors.length - 1]
  const focalDiff = Math.max(...common.map((id) => {
    const a = scam.get(id).K?.fx, b = pcam.get(id).K?.fx
    return a > 0 && b > 0 ? Math.abs(a - b) / b : 0
  }))
  const pDist = new Map((primary.summary?.selfCalDistortion || []).map((d) => [d.sensorId, d]))
  const sDist = new Map((secondary.summary?.selfCalDistortion || []).map((d) => [d.sensorId, d]))
  let radialCoeffDiff = 0
  for (const [sid, a] of pDist) {
    const b = sDist.get(sid)
    if (!b) continue
    for (const k of ['k1', 'k2', 'k3']) radialCoeffDiff = Math.max(radialCoeffDiff, Math.abs((a[k] || 0) - (b[k] || 0)))
  }
  let scaleSpread = 0
  if (pairs.length >= 4) {
    const scales = pairs.map((_, omit) => fitSimilarity(pairs.filter((__, i) => i !== omit))?.scale).filter((x) => x > 0)
    if (scales.length) scaleSpread = (Math.max(...scales) - Math.min(...scales)) / sim.scale
  }
  const diagnostics = { common, sim, rmsFrac, medianRotationDeg, worstRotationDeg, scaleSpread, focalDiff, radialCoeffDiff }
  if (rmsFrac > maxPositionRmsFrac) return { accepted: false, reason: `shared-camera position RMS ${(100 * rmsFrac).toFixed(1)}% of span`, ...diagnostics }
  if (medianRotationDeg > maxMedianRotationDeg || worstRotationDeg > maxRotationDeg)
    return { accepted: false, reason: `shared-camera rotation disagreement median ${medianRotationDeg.toFixed(1)}°, max ${worstRotationDeg.toFixed(1)}°`, ...diagnostics }
  if (scaleSpread > maxScaleSpread) return { accepted: false, reason: `leave-one-out scale spread ${(100 * scaleSpread).toFixed(1)}%`, ...diagnostics }
  if (focalDiff > maxFocalDiff) return { accepted: false, reason: `shared-camera focal disagreement ${(100 * focalDiff).toFixed(1)}%`, ...diagnostics }
  if (radialCoeffDiff > maxRadialCoeffDiff) return { accepted: false, reason: `self-calibration radial disagreement ${radialCoeffDiff.toFixed(3)}`, ...diagnostics }

  const transformedCameras = (secondary.cameras || []).map((cam) => {
    const R = mul(cam.R, Qt)
    const Rd = [
      R[0][0] * sim.t[0] + R[0][1] * sim.t[1] + R[0][2] * sim.t[2],
      R[1][0] * sim.t[0] + R[1][1] * sim.t[1] + R[1][2] * sim.t[2],
      R[2][0] * sim.t[0] + R[2][1] * sim.t[1] + R[2][2] * sim.t[2],
    ]
    return { ...cam, R, t: cam.t.map((v, i) => sim.scale * v - Rd[i]) }
  })
  const component = new Set(componentIds)
  const transformedPoints = (secondary.points || [])
    .filter((p) => (p.views || []).some((v) => component.has(v[0])))
    .map((p) => {
      const q = applySimilarity(sim, [p.x, p.y, p.z])
      return { ...p, x: q[0], y: q[1], z: q[2] }
    })
  return { accepted: true, transformedCameras, transformedPoints, ...diagnostics }
}

export function mergeAligned(primary, aligned) {
  const cameraMap = new Map((primary.cameras || []).map((c) => [c.uuid, c]))
  let addedCameras = 0
  for (const c of aligned.transformedCameras) if (!cameraMap.has(c.uuid)) { cameraMap.set(c.uuid, c); addedCameras++ }
  const points = [...(primary.points || []), ...aligned.transformedPoints]
  const n3 = points.reduce((n, p) => n + ((p.views?.length || 0) >= 3 ? 1 : 0), 0)
  return {
    ...primary,
    cameras: [...cameraMap.values()],
    points,
    summary: {
      ...(primary.summary || {}),
      nCameras: cameraMap.size,
      nPoints: points.length,
      pct3plusViewTracks: points.length ? 100 * n3 / points.length : 0,
      secondaryMerge: {
        addedCameras,
        addedPoints: aligned.transformedPoints.length,
        sharedCameras: aligned.common.length,
        alignmentRmsFrac: aligned.rmsFrac,
        medianRotationDeg: aligned.medianRotationDeg,
        scaleSpread: aligned.scaleSpread,
      },
    },
  }
}
