import { projectWithDepth } from './geometry.js'

// ── Projection-guided track extension (pure) ─────────────────────────────────
// Every South Building run discarded 46–73k two-view points that had no verified
// correspondence into a third registered image (MAT-06): matching missed those
// observations, track building did not drop them. Global matching has to decide among
// all of an image's keypoints, so a feature with a near-twin elsewhere (repetitive
// façade texture) fails the ratio test there. Once the poses exist that ambiguity is
// gone: the point can only appear within a few pixels of its projection.
//
// So, per point and per registered camera that does not observe it: project, take the
// unused keypoints within the reprojection gate, and accept the best by descriptor
// distance when it is (a) close in absolute terms — under a threshold measured from
// this run's own multi-view tracks — and (b) clearly better than the runner-up in the
// same small window. Proposals are then resolved greedily, best first, so one keypoint
// joins at most one point and one point gains at most one keypoint per camera. The
// caller's filter + bundle adjustment then treat the additions like any other
// observation. COLMAP has no equivalent; its completion only uses existing matches.
//
// Descriptors are COLMAP-style uint8 (RootSIFT × 512), 128 per keypoint.

const DIM = 128

function dist2(a, ao, b, bo) {
  let s = 0
  for (let i = 0; i < DIM; i++) { const d = a[ao + i] - b[bo + i]; s += d * d }
  return s
}

/**
 * The squared-distance acceptance threshold, measured: the `quantile` of distances
 * between two observations of the same point over tracks with ≥3 views (verified,
 * multi-view evidence). Deterministic sampling: every k-th point.
 */
export function trackDistanceThreshold(points3d, descOf, { quantile = 0.9, maxSamples = 20000 } = {}) {
  const multi = points3d.filter((p) => p.views.size >= 3)
  if (!multi.length) return null
  const step = Math.max(1, Math.floor(multi.length / maxSamples))
  const d = []
  for (let i = 0; i < multi.length; i += step) {
    const obs = [...multi[i].views]
    const a = descOf(obs[0][0], obs[0][1]), b = descOf(obs[1][0], obs[1][1])
    if (a && b) d.push(dist2(a.arr, a.off, b.arr, b.off))
  }
  if (!d.length) return null
  d.sort((x, y) => x - y)
  return d[Math.min(d.length - 1, Math.floor(quantile * d.length))]
}

/**
 * @param {object} o
 * @param {Array} o.points3d                 [{ x, y, z, views: Map<uuid, kpIdx> }]
 * @param {Map} o.cameras                    uuid → { R, t, K }
 * @param {(uuid:string) => {n:number, xy:Float64Array}|null} o.keypointsOf   the image's KeypointSet
 * @param {(uuid:string, kp:number) => {arr:Uint8Array, off:number}|null} o.descOf
 * @param {Map} o.viewIndex                  uuid → Map<kpIdx, point>
 * @param {(pt:object, uuid:string, kp:number) => void} o.addView
 * @param {number} o.gatePx                  search radius = the reprojection gate
 * @param {number} [o.maxDist2]              squared descriptor threshold (else measured)
 * @param {number} [o.ratio]                 best must beat the runner-up by this ratio
 * @param {number} [o.quantile]              track-distance quantile that sets the threshold
 * @param {number} [o.refObs]                compare against at most this many observations
 * @param {(pt:object, uuid:string, kp:number) => void} [o.onAdd]  called per accepted observation
 */
export function guidedExtendTracks({ points3d, cameras, keypointsOf, descOf, viewIndex, addView, gatePx,
  maxDist2 = null, ratio = 0.8, quantile = 0.9, refObs = 3, onAdd = null }) {
  const tau2 = maxDist2 ?? trackDistanceThreshold(points3d, descOf, { quantile })
  const stats = { tau: tau2 == null ? null : Math.sqrt(tau2) / 512, projections: 0, windows: 0, proposals: 0,
    added: 0, lifted: 0, pointsExtended: 0 }
  if (tau2 == null) return stats
  const r2 = gatePx * gatePx
  const ratio2 = ratio * ratio

  // Per-camera keypoint grid (cell = gate) and keypoint bounds.
  const grids = new Map()
  for (const [uuid] of cameras) {
    const kps = keypointsOf(uuid)
    if (!kps?.n) continue
    const cells = new Map()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const xy = kps.xy
    for (let i = 0; i < kps.n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1]
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y
      const key = Math.floor(x / gatePx) * 1e6 + Math.floor(y / gatePx)
      const c = cells.get(key); if (c) c.push(i); else cells.set(key, [i])
    }
    grids.set(uuid, { xy, cells, minX, minY, maxX, maxY })
  }

  const proposals = []
  for (const pt of points3d) {
    const refs = []
    for (const [u, k] of pt.views) { const d = descOf(u, k); if (d) refs.push(d); if (refs.length >= refObs) break }
    if (!refs.length) continue
    for (const [uuid, cam] of cameras) {
      if (pt.views.has(uuid)) continue
      const g = grids.get(uuid)
      if (!g) continue
      stats.projections++
      const p = projectWithDepth(cam, pt.x, pt.y, pt.z)
      if (!p || p.u < g.minX || p.u > g.maxX || p.v < g.minY || p.v > g.maxY) continue
      const used = viewIndex.get(uuid)
      const cx = Math.floor(p.u / gatePx), cy = Math.floor(p.v / gatePx)
      let best = Infinity, second = Infinity, bestKp = -1, any = false
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = g.cells.get(gx * 1e6 + gy)
          if (!cell) continue
          for (const i of cell) {
            if ((g.xy[2 * i] - p.u) ** 2 + (g.xy[2 * i + 1] - p.v) ** 2 > r2) continue
            if (used?.has(i)) continue
            const cd = descOf(uuid, i)
            if (!cd) continue
            any = true
            let d = Infinity
            for (const ref of refs) d = Math.min(d, dist2(ref.arr, ref.off, cd.arr, cd.off))
            if (d < best) { second = best; best = d; bestKp = i } else if (d < second) second = d
          }
        }
      }
      if (!any) continue
      stats.windows++
      if (best <= tau2 && (second === Infinity || best <= ratio2 * second)) {
        proposals.push({ pt, uuid, kp: bestKp, d2: best })
      }
    }
  }
  stats.proposals = proposals.length

  // Resolve best-first: a keypoint joins one point, a point gains one view per camera.
  proposals.sort((a, b) => a.d2 - b.d2)
  const claimed = new Map() // uuid → Set<kp>
  const extended = new Set()
  for (const pr of proposals) {
    if (pr.pt.views.has(pr.uuid)) continue
    let c = claimed.get(pr.uuid)
    if (!c) { c = new Set(); claimed.set(pr.uuid, c) }
    if (c.has(pr.kp) || viewIndex.get(pr.uuid)?.has(pr.kp)) continue
    c.add(pr.kp)
    const before = pr.pt.views.size
    addView(pr.pt, pr.uuid, pr.kp)
    onAdd?.(pr.pt, pr.uuid, pr.kp)
    stats.added++
    if (before === 2) stats.lifted++
    extended.add(pr.pt)
  }
  stats.pointsExtended = extended.size
  return stats
}

/**
 * Were the additions right? Compare the final residuals of the guided observations that
 * survived the filter and BA with every other observation's. False additions would sit
 * anywhere inside the search gate, so their median would be far above the population's;
 * true ones look like the rest of the model. Observations are keyed by (image, keypoint):
 * bundle adjustment rebuilds the point objects, so object identity does not survive it.
 * @param {{uuid:string, kp:number}[]} additions
 * @param {Iterable<{views:Map<string,number>}>} points   the model's current points
 * @param {(pt:object, uuid:string, kp:number) => number|null} residualOf  px
 */
export function auditGuidedAdditions(additions, points, residualOf) {
  const key = (uuid, kp) => `${uuid}|${kp}`
  const added = new Set(additions.map((a) => key(a.uuid, a.kp)))
  const mine = [], rest = []
  for (const pt of points) {
    for (const [uuid, kp] of pt.views) {
      const r = residualOf(pt, uuid, kp)
      if (r == null) continue
      ;(added.has(key(uuid, kp)) ? mine : rest).push(r)
    }
  }
  const q = (arr, f) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * a.length))] }
  return {
    proposed: additions.length, survived: mine.length,
    medianPx: q(mine, 0.5), p90Px: q(mine, 0.9), restMedianPx: q(rest, 0.5), restP90Px: q(rest, 0.9),
  }
}
