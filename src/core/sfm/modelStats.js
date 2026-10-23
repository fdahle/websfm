// Read-only health measures of a single-model run's current state (singleModel.js and
// the stages it wires): residual summaries, the per-observation reprojection residuals
// and the track-length histogram. Pure — every input is passed in; nothing is mutated.

import { hasKp, kpX, kpY } from './keypointSet.js'

// Summary statistics for an array of numbers (e.g. reprojection residuals, px).
// Returns { mean, median, p95, max, count }; all zero when empty.
export function numStats(arr) {
  const n = arr.length
  if (n === 0) return { mean: 0, median: 0, p95: 0, max: 0, count: 0 }
  // A typed array sorts numerically and natively: the comparator sort of a plain array
  // was seconds a run on a big block (every BA logs these). Same order, same sum.
  const sorted = Float64Array.from(arr).sort()
  let sum = 0
  for (let i = 0; i < n; i++) sum += sorted[i]
  const at = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]
  return { mean: sum / n, median: at(0.5), p95: at(0.95), max: sorted[n - 1], count: n }
}

// One-line formatter for a numStats result.
export function fmtStats(s) {
  return (
    `mean ${s.mean.toFixed(2)}px, median ${s.median.toFixed(2)}px, ` +
    `p95 ${s.p95.toFixed(2)}px, max ${s.max.toFixed(2)}px (${s.count} obs)`
  )
}

// Reprojection-error statistics (pixels) over every observation currently in
// the model: project each 3D point into each camera that sees it and compare
// to the detected keypoint. The single clearest health signal for the model.
// `images` is the run's image list, indexed as the track store indexes images.
// It runs after every bundle adjustment and registration pass, over every observation
// (813 k on quarry), so each image's camera is unpacked once (a uuid Map lookup per
// observation, and projectPoint's result object, were seconds a run and most of its
// garbage). The arithmetic is projectPoint's, in the same order: the same residuals.
export function modelResiduals({ tracks, cameras, ids, images }) {
  const residuals = []
  const camAt = new Array(images.length).fill(null)
  for (let img = 0; img < images.length; img++) {
    const cam = images[img] ? cameras.get(ids.uuid(img)) : null
    if (!cam || !cam.K) continue
    const { R, t, K } = cam
    camAt[img] = [
      R[0][0],
      R[0][1],
      R[0][2],
      R[1][0],
      R[1][1],
      R[1][2],
      R[2][0],
      R[2][1],
      R[2][2],
      t[0],
      t[1],
      t[2],
      K.fx,
      K.fy,
      K.cx,
      K.cy,
    ]
  }
  tracks.forEachPoint((p) => {
    const x = tracks.x(p),
      y = tracks.y(p),
      z = tracks.z(p)
    tracks.forEachView(p, (img, kpIdx) => {
      const c = camAt[img]
      if (!c) return
      const set = images[img].kp
      if (!hasKp(set, kpIdx)) return
      const xc = c[0] * x + c[1] * y + c[2] * z + c[9]
      const yc = c[3] * x + c[4] * y + c[5] * z + c[10]
      const zc = c[6] * x + c[7] * y + c[8] * z + c[11]
      if (!isFinite(zc) || Math.abs(zc) < 1e-9) return
      residuals.push(
        Math.hypot(c[12] * (xc / zc) + c[14] - kpX(set, kpIdx), c[13] * (yc / zc) + c[15] - kpY(set, kpIdx)),
      )
    })
  })
  return residuals
}

// Track-length histogram { t2, t3, t4 } (2-view / 3-view / 4+-view counts).
export function trackHist(tracks) {
  let t2 = 0,
    t3 = 0,
    t4 = 0
  tracks.forEachPoint((p) => {
    const n = tracks.viewCount(p)
    if (n <= 2) t2++
    else if (n === 3) t3++
    else t4++
  })
  return { t2, t3, t4 }
}
