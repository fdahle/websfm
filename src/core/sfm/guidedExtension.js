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
 * @param {object} tracks   TrackStore (trackStore.js)
 * @param {(img:number, kp:number) => {arr:Uint8Array, off:number}|null} descOf
 */
export function trackDistanceThreshold(tracks, descOf, { quantile = 0.9, maxSamples = 20000 } = {}) {
  const multi = []
  tracks.forEachPoint((p) => { if (tracks.viewCount(p) >= 3) multi.push(p) })
  if (!multi.length) return null
  const step = Math.max(1, Math.floor(multi.length / maxSamples))
  const d = []
  for (let i = 0; i < multi.length; i += step) {
    // The first two observations of the track.
    let img0 = -1, kp0 = -1, img1 = -1, kp1 = -1
    tracks.someView(multi[i], (img, kp) => {
      if (img0 < 0) { img0 = img; kp0 = kp; return false }
      img1 = img; kp1 = kp
      return true
    })
    const a = descOf(img0, kp0), b = descOf(img1, kp1)
    if (a && b) d.push(dist2(a.arr, a.off, b.arr, b.off))
  }
  if (!d.length) return null
  d.sort((x, y) => x - y)
  return d[Math.min(d.length - 1, Math.floor(quantile * d.length))]
}

/**
 * @param {object} o
 * @param {object} o.tracks                  TrackStore (trackStore.js); additions go here
 * @param {object} o.ids                     makeImageIds: uuid ↔ image index
 * @param {Map} o.cameras                    uuid → { R, t, K }
 * @param {(img:number) => {n:number, xy:Float64Array}|null} o.keypointsAt   the image's KeypointSet
 * @param {(img:number, kp:number) => {arr:Uint8Array, off:number}|null} o.descOf
 * @param {number} o.gatePx                  search radius = the reprojection gate
 * @param {number} [o.maxDist2]              squared descriptor threshold (else measured)
 * @param {number} [o.ratio]                 best must beat the runner-up by this ratio
 * @param {number} [o.quantile]              track-distance quantile that sets the threshold
 * @param {number} [o.refObs]                compare against at most this many observations
 * @param {(p:number, img:number, kp:number) => void} [o.onAdd]  called per accepted observation
 */
export function guidedExtendTracks({ tracks, ids, cameras, keypointsAt, descOf, gatePx,
  maxDist2 = null, ratio = 0.8, quantile = 0.9, refObs = 3, onAdd = null }) {
  const tau2 = maxDist2 ?? trackDistanceThreshold(tracks, descOf, { quantile })
  const stats = { tau: tau2 == null ? null : Math.sqrt(tau2) / 512, projections: 0, windows: 0, proposals: 0,
    added: 0, lifted: 0, pointsExtended: 0 }
  if (tau2 == null) return stats
  const r2 = gatePx * gatePx
  const ratio2 = ratio * ratio

  // Per-camera keypoint grid (cell = gate) and keypoint bounds, in camera order.
  const camList = [] // { img, cam, grid }
  for (const [uuid, cam] of cameras) {
    const img = ids.img(uuid)
    const kps = keypointsAt(img)
    if (!kps?.n) { camList.push({ img, cam, grid: null }); continue }
    const cells = new Map()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const xy = kps.xy
    for (let i = 0; i < kps.n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1]
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y
      const key = Math.floor(x / gatePx) * 1e6 + Math.floor(y / gatePx)
      const c = cells.get(key); if (c) c.push(i); else cells.set(key, [i])
    }
    camList.push({ img, cam, grid: { xy, cells, minX, minY, maxX, maxY } })
  }

  const proposals = []
  const refs = []
  tracks.forEachPoint((p) => {
    refs.length = 0
    tracks.someView(p, (img, k) => { const d = descOf(img, k); if (d) refs.push(d); return refs.length >= refObs })
    if (!refs.length) return
    const px = tracks.x(p), py = tracks.y(p), pz = tracks.z(p)
    for (const { img, cam, grid: g } of camList) {
      if (tracks.viewKp(p, img) >= 0) continue
      if (!g) continue
      stats.projections++
      const pr = projectWithDepth(cam, px, py, pz)
      if (!pr || pr.u < g.minX || pr.u > g.maxX || pr.v < g.minY || pr.v > g.maxY) continue
      const cx = Math.floor(pr.u / gatePx), cy = Math.floor(pr.v / gatePx)
      let best = Infinity, second = Infinity, bestKp = -1, any = false
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = g.cells.get(gx * 1e6 + gy)
          if (!cell) continue
          for (const i of cell) {
            if ((g.xy[2 * i] - pr.u) ** 2 + (g.xy[2 * i + 1] - pr.v) ** 2 > r2) continue
            if (tracks.pointAt(img, i) >= 0) continue
            const cd = descOf(img, i)
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
        proposals.push({ p, img, kp: bestKp, d2: best })
      }
    }
  })
  stats.proposals = proposals.length

  // Resolve best-first: a keypoint joins one point, a point gains one view per camera.
  proposals.sort((a, b) => a.d2 - b.d2)
  const claimed = new Map() // img → Set<kp>
  const extended = new Set()
  for (const pr of proposals) {
    if (tracks.viewKp(pr.p, pr.img) >= 0) continue
    let c = claimed.get(pr.img)
    if (!c) { c = new Set(); claimed.set(pr.img, c) }
    if (c.has(pr.kp) || tracks.pointAt(pr.img, pr.kp) >= 0) continue
    c.add(pr.kp)
    const before = tracks.viewCount(pr.p)
    tracks.addView(pr.p, pr.img, pr.kp)
    onAdd?.(pr.p, pr.img, pr.kp)
    stats.added++
    if (before === 2) stats.lifted++
    extended.add(pr.p)
  }
  stats.pointsExtended = extended.size
  return stats
}

/**
 * Were the additions right? Compare the final residuals of the guided observations that
 * survived the filter and BA with every other observation's. False additions would sit
 * anywhere inside the search gate, so their median would be far above the population's;
 * true ones look like the rest of the model. Observations are keyed by (image, keypoint):
 * a point can be merged or renumbered after the addition, its observation cannot.
 * @param {{uuid:string, kp:number}[]} additions
 * @param {(visit: (uuid:string, kp:number, residualPx:number|null) => void) => void} forEachObservation
 *   walks the model's current observations, in point then view order
 */
export function auditGuidedAdditions(additions, forEachObservation) {
  const key = (uuid, kp) => `${uuid}|${kp}`
  const added = new Set(additions.map((a) => key(a.uuid, a.kp)))
  const mine = [], rest = []
  forEachObservation((uuid, kp, r) => {
    if (r == null) return
    ;(added.has(key(uuid, kp)) ? mine : rest).push(r)
  })
  const q = (arr, f) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * a.length))] }
  return {
    proposed: additions.length, survived: mine.length,
    medianPx: q(mine, 0.5), p90Px: q(mine, 0.9), restMedianPx: q(rest, 0.5), restP90Px: q(rest, 0.9),
  }
}
