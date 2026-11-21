// Coarse tie points out of the survey-held solves (pure).
//
// A tie point found at a coarse level of the keypoint pyramid is a large blob whose
// centre can shift with the viewing angle; over a nadir block such a shift is radial, so
// it trades with the focal and the flying height, which no image residual shows. Against
// camera positions, GCPs or a reference DEM that pull is a height bias. So the solves
// held to survey data (bundleSession.js: camera priors, GCP anchors, the DEM hold) leave
// out every point whose keypoints are coarse for their photos, and the points come back
// afterwards, triangulated on the final cameras (restoreCoarsePoints), so the sparse
// cloud and every later stage keep them.
//
// "Coarse" is relative to each photo's finest keypoint scale s₀ (keypointSet.js
// minKeypointScale), so the rule follows the detection resolution, not a pixel size: a
// point is coarse when the median of scale / s₀ over its views exceeds `maxRatio`. A
// view without a scale (learned detectors, imported matches) counts as fine; when no
// photo has scales the rule does nothing. A photo left with fewer than `minObsPerPhoto`
// observations keeps its finest points up to that count (its own, higher threshold), so
// a weak block is not stripped bare.

import { hasKp, minKeypointScale } from './keypointSet.js'
import { projectPoint } from './geometry.js'

/**
 * Split the points `ids` into the fine ones a held solve uses and the coarse ones it
 * leaves out.
 * @param {object} tracks          trackStore.js
 * @param {Int32Array} ids         point ids (tracks.liveIds())
 * @param {(img:number) => object} keypointsAt  the image's KeypointSet
 * @param {{maxRatio:number, minObsPerPhoto?:number}} opts
 * @returns {{ active: boolean, keep: Int32Array, out: Int32Array, stats: object }}
 *   `active` false (keep = ids, out empty) when no observation has a scale. stats:
 *   { points, pointsKept, obs, obsKept, s0Median (native px), maxRatio, photos,
 *     relaxed (photos given a higher threshold), relaxedMaxRatio, obsPerPhotoMedian,
 *     obsPerPhotoMin }
 */
export function splitCoarseTies(tracks, ids, keypointsAt, { maxRatio, minObsPerPhoto = 0 }) {
  const n = ids.length
  const med = new Float64Array(n)
  const s0Of = new Map()
  const s0 = (img) => {
    let v = s0Of.get(img)
    if (v === undefined) {
      v = minKeypointScale(keypointsAt(img))
      s0Of.set(img, v)
    }
    return v
  }
  let anyScale = false
  let obs = 0
  const buf = []
  for (let r = 0; r < n; r++) {
    buf.length = 0
    tracks.forEachView(ids[r], (img, kp) => {
      const set = keypointsAt(img)
      if (!hasKp(set, kp)) return
      const sc = set.scale?.[kp] ?? 0
      const s = s0(img)
      const ratio = sc > 0 && s > 0 ? sc / s : 0
      if (ratio > 0) anyScale = true
      buf.push(ratio)
    })
    obs += buf.length
    if (!buf.length) continue
    buf.sort((a, b) => a - b)
    med[r] = buf[buf.length >> 1]
  }
  const stats = {
    points: n,
    pointsKept: n,
    obs,
    obsKept: obs,
    s0Median: 0,
    maxRatio,
    photos: 0,
    relaxed: 0,
    relaxedMaxRatio: maxRatio,
    obsPerPhotoMedian: 0,
    obsPerPhotoMin: 0,
  }
  if (!anyScale || !(maxRatio > 0)) return { active: false, keep: ids, out: new Int32Array(0), stats }

  // Per photo: the medians of the points it sees, and how many of them pass the rule.
  const byPhoto = new Map() // img → number[] of point medians
  for (let r = 0; r < n; r++) {
    const m = med[r]
    tracks.forEachView(ids[r], (img, kp) => {
      if (!hasKp(keypointsAt(img), kp)) return
      let a = byPhoto.get(img)
      if (!a) byPhoto.set(img, (a = []))
      a.push(m)
    })
  }
  // A photo's threshold: maxRatio, or higher when that keeps fewer than minObsPerPhoto
  // of its observations (the minObsPerPhoto-th finest point's ratio).
  const thr = new Map()
  for (const [img, a] of byPhoto) {
    let kept = 0
    for (const m of a) if (m <= maxRatio) kept++
    if (minObsPerPhoto > 0 && kept < minObsPerPhoto && a.length > kept) {
      a.sort((x, y) => x - y)
      const t = a[Math.min(minObsPerPhoto, a.length) - 1]
      thr.set(img, t)
      stats.relaxed++
      if (t > stats.relaxedMaxRatio) stats.relaxedMaxRatio = t
    }
  }
  const keepMask = new Uint8Array(n)
  let nKeep = 0
  for (let r = 0; r < n; r++) {
    let ok = med[r] <= maxRatio
    if (!ok && thr.size)
      tracks.forEachView(ids[r], (img) => {
        const t = thr.get(img)
        if (t !== undefined && med[r] <= t) ok = true
      })
    if (ok) {
      keepMask[r] = 1
      nKeep++
    }
  }
  const keep = new Int32Array(nKeep),
    out = new Int32Array(n - nKeep)
  const perPhoto = new Map()
  let obsKept = 0
  for (let r = 0, a = 0, b = 0; r < n; r++) {
    if (keepMask[r]) {
      keep[a++] = ids[r]
      tracks.forEachView(ids[r], (img, kp) => {
        if (!hasKp(keypointsAt(img), kp)) return
        obsKept++
        perPhoto.set(img, (perPhoto.get(img) ?? 0) + 1)
      })
    } else out[b++] = ids[r]
  }
  const counts = [...byPhoto.keys()].map((img) => perPhoto.get(img) ?? 0).sort((x, y) => x - y)
  const s0s = [...byPhoto.keys()]
    .map(s0)
    .filter((v) => v > 0)
    .sort((x, y) => x - y)
  stats.pointsKept = nKeep
  stats.obsKept = obsKept
  stats.photos = counts.length
  stats.obsPerPhotoMedian = counts.length ? counts[counts.length >> 1] : 0
  stats.obsPerPhotoMin = counts.length ? counts[0] : 0
  stats.s0Median = s0s.length ? s0s[s0s.length >> 1] : 0
  return { active: true, keep, out, stats }
}

// 3 × 3 solve by Cramer's rule; null when singular.
function solve3(A, b) {
  const [a, b1, c] = A[0],
    [d, e, f] = A[1],
    [g, h, i] = A[2]
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g)
  if (!(Math.abs(det) > 1e-300)) return null
  return [
    (b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ]
}

/**
 * Move each point of `out` to where its views meet on the current cameras: Gauss–Newton
 * on the reprojection error from its present position (the cameras moved little since it
 * was last solved), the residuals through projectPoint (rolling shutter included), only
 * steps that lower the cost. Returns how many points moved.
 */
export function retriangulatePoints(tracks, out, { cameras, ids, keypointsAt, maxIters = 10 }) {
  let moved = 0
  const views = []
  const cost = (x, y, z) => {
    let s = 0
    for (const v of views) {
      const zc = v.cam.R[2][0] * x + v.cam.R[2][1] * y + v.cam.R[2][2] * z + v.cam.t[2]
      const p = zc > 0 ? projectPoint(v.cam, x, y, z) : null
      if (!p) return Infinity
      s += (p.u - v.px) ** 2 + (p.v - v.py) ** 2
    }
    return s
  }
  for (const p of out) {
    views.length = 0
    tracks.forEachView(p, (img, kp) => {
      const cam = cameras.get(ids.uuid(img))
      const set = keypointsAt(img)
      if (cam && hasKp(set, kp)) views.push({ cam, px: set.xy[2 * kp], py: set.xy[2 * kp + 1] })
    })
    if (views.length < 2) continue
    let x = tracks.x(p),
      y = tracks.y(p),
      z = tracks.z(p)
    let c = cost(x, y, z)
    if (!Number.isFinite(c)) continue
    const x0 = x,
      y0 = y,
      z0 = z
    for (let it = 0; it < maxIters; it++) {
      const H = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]
      const g = [0, 0, 0]
      for (const { cam, px, py } of views) {
        const { R, t, K } = cam
        const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
        const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
        const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
        const q = projectPoint(cam, x, y, z)
        const ru = q.u - px,
          rv = q.v - py
        const ju = [0, 1, 2].map((k) => (K.fx / zc) * (R[0][k] - (xc / zc) * R[2][k]))
        const jv = [0, 1, 2].map((k) => (K.fy / zc) * (R[1][k] - (yc / zc) * R[2][k]))
        for (let a = 0; a < 3; a++) {
          g[a] += ju[a] * ru + jv[a] * rv
          for (let b = 0; b < 3; b++) H[a][b] += ju[a] * ju[b] + jv[a] * jv[b]
        }
      }
      for (let a = 0; a < 3; a++) H[a][a] *= 1 + 1e-9
      const d = solve3(H, [-g[0], -g[1], -g[2]])
      if (!d) break
      const nc = cost(x + d[0], y + d[1], z + d[2])
      if (!(nc < c)) break
      x += d[0]
      y += d[1]
      z += d[2]
      const gain = c - nc
      c = nc
      if (gain <= 1e-12 * Math.max(1, c)) break
    }
    if (x !== x0 || y !== y0 || z !== z0) {
      tracks.setPosition(p, x, y, z)
      moved++
    }
  }
  return moved
}
