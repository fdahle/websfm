// Quality Report statistics of one sparse model, computed ONCE per model (TODO ▸
// SC-8). Each hub section used to derive its own copy on every mount — switching
// Overview → Sparse → Coverage re-projected every observation of a 10⁶-point model
// two or three times — and the per-image table and the reprojection tiles each made
// their own full projection pass. Here one pass over the observations yields both,
// and the result is memoised on the model's identity.
//
// Pure: no Vue/Pinia/DOM. Identity: a sparse cloud's `points` (SparsePoints) and `cameras`
// Map are replaced, never mutated, when the model changes (useReconstructionStore
// upsertSparseCloud builds a new cloud object), so (points, cameras) — plus the
// point count as a cheap guard — names one model.
//
// Results equal reconStats.js reprojectionStats / trackLengthHistogram,
// imageStats.js perImageResiduals and coverage.js coverageGrid exactly (same
// residuals, same summation order); sparseStats.test.js pins that. Callers must
// treat the returned arrays and objects as read-only — they are shared.

import { projectPoint, cameraCenter } from '../sfm/geometry.js'
import { trackLengthHistogram } from './reconStats.js'
import { coverageGrid } from './coverage.js'
import { SparsePoints } from '../sfm/sparsePoints.js'

// One projection per observation → the global distribution and the per-camera rows.
// → { reproj: { n, mean, median, p95, max }, perImage: [{ uuid, nObs, rmsPx, medianPx, maxPx }] }
export function sparseResidualStats(cameras, points) {
  const camIds = [...cameras.keys()]
  const camIndex = new Map(camIds.map((id, i) => [id, i]))
  let cap = 1024, n = 0
  let res = new Float64Array(cap)
  let owner = new Int32Array(cap)
  const pts = points ?? SparsePoints.empty()
  for (let i = 0; i < pts.length; i++) {
    const x = pts.x(i), y = pts.y(i), z = pts.z(i)
    pts.forEachPixel(i, (uuid, px, py) => {
      const cam = cameras.get(uuid)
      if (!cam) return                       // observation of an image not in this model
      const proj = projectPoint(cam, x, y, z)
      if (!proj) return
      if (n === cap) {
        cap *= 2
        const r2 = new Float64Array(cap); r2.set(res); res = r2
        const o2 = new Int32Array(cap); o2.set(owner); owner = o2
      }
      res[n] = Math.hypot(proj.u - px, proj.v - py)
      owner[n] = camIndex.get(uuid)
      n++
    })
  }

  // Per camera: a stable counting sort groups each camera's residuals (in observation
  // order, as perImageResiduals pushes them), then each group is sorted ascending.
  const counts = new Int32Array(camIds.length)
  for (let i = 0; i < n; i++) counts[owner[i]]++
  const start = new Int32Array(camIds.length + 1)
  for (let c = 0; c < camIds.length; c++) start[c + 1] = start[c] + counts[c]
  const grouped = new Float64Array(n)
  const fill = start.slice(0, camIds.length)
  for (let i = 0; i < n; i++) grouped[fill[owner[i]]++] = res[i]
  const perImage = new Array(camIds.length)
  for (let c = 0; c < camIds.length; c++) {
    const nObs = counts[c]
    if (!nObs) { perImage[c] = { uuid: camIds[c], nObs: 0, rmsPx: null, medianPx: null, maxPx: null }; continue }
    const g = grouped.subarray(start[c], start[c + 1]).sort()
    let sq = 0
    for (let k = 0; k < nObs; k++) sq += g[k] * g[k]
    perImage[c] = { uuid: camIds[c], nObs, rmsPx: Math.sqrt(sq / nObs), medianPx: g[nObs >> 1], maxPx: g[nObs - 1] }
  }

  let reproj
  if (!n) reproj = { n: 0, mean: null, median: null, p95: null, max: null }
  else {
    const all = res.subarray(0, n).sort()
    let sum = 0
    for (let k = 0; k < n; k++) sum += all[k]
    const pct = (q) => all[Math.min(n - 1, Math.floor(q * n))]
    reproj = { n, mean: sum / n, median: pct(0.5), p95: pct(0.95), max: all[n - 1] }
  }
  return { reproj, perImage }
}

// Coverage grid of the model, camera centres overlaid (Quality Report ▸ Coverage).
export function sparseCoverage(cameras, points, opts = { targetCells: 64 }) {
  const cams = []
  for (const cam of cameras.values()) {
    const c = cameraCenter(cam)
    if (c) cams.push({ x: c[0], y: c[1] })
  }
  return coverageGrid(points, cams, opts)
}

const memo = new WeakMap() // points → { cameras, count, stats }

// The memoised stats object for (cameras, points). Each field is computed on first
// read and kept: { reproj, perImage, histogram, coverage }.
export function sparseModelStats(cameras, points) {
  const pts = points ?? SparsePoints.empty()
  const cams = cameras || new Map()
  const hit = memo.get(pts)
  if (hit && hit.cameras === cams && hit.count === pts.length) return hit.stats
  let residuals = null, histogram = null, coverage = null
  const stats = {
    get reproj() { return (residuals ??= sparseResidualStats(cams, pts)).reproj },
    get perImage() { return (residuals ??= sparseResidualStats(cams, pts)).perImage },
    get histogram() { return (histogram ??= trackLengthHistogram(pts)) },
    get coverage() { return (coverage ??= sparseCoverage(cams, pts)) },
  }
  memo.set(pts, { cameras: cams, count: pts.length, stats })
  return stats
}
