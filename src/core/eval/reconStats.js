// Pure reconstruction statistics for the Evaluate ▸ Recon Report view
// (PLAN-eval-views step 2). No Vue/Pinia/DOM — sparse cameras + points in, plain
// stats out. The central rule of the eval tab: DERIVE from the cloud, don't extend
// the run summary. Everything here recomputes from `views` / `viewsPx` + cameras,
// so it also works for an imported COLMAP cloud that has no summary at all.

import { projectPoint } from '../sfm/geometry.js'

// Track length = how many registered views observe a point (`point.views` is a
// Map uuid→kpIdx). Histogram bins 2..7 individually, then an '8+' catch-all.
// Returns [{ views, count, pct }] including empty bins, so the chart has a stable
// x-axis. `views` is the numeric bin (2..7) or the string '8+' for the last.
// Points with fewer than 2 views (untracked) are ignored — they aren't tie points.
export function trackLengthHistogram(points) {
  const bins = new Map()          // binKey → count
  for (let v = 2; v <= 7; v++) bins.set(v, 0)
  bins.set('8+', 0)
  let total = 0
  for (const p of points || []) {
    const n = p.views ? p.views.size : 0
    if (n < 2) continue
    const key = n >= 8 ? '8+' : n
    bins.set(key, bins.get(key) + 1)
    total++
  }
  const out = []
  for (const [views, count] of bins) {
    out.push({ views, count, pct: total ? (count / total) * 100 : 0 })
  }
  return out
}

// Reprojection residual stats over every observation of every point. For each
// point, projects its 3D position with each viewing camera and measures the pixel
// distance to the stored observation (`viewsPx`, the BA pinhole-frame pixel — the
// same frame the cameras are in, so residuals stay coherent on film-scan / self-cal
// projects). Observations whose uuid is absent from `cameras` are skipped (an
// imported model may reference images not loaded); points lacking `viewsPx` are
// skipped whole (legacy clouds). `n` reports how many residuals were measured so
// the caller can say what it covered rather than silently reporting a subset.
export function reprojectionStats(cameras, points) {
  const res = []
  for (const p of points || []) {
    if (!p.viewsPx || !p.viewsPx.size) continue
    for (const [uuid, px] of p.viewsPx) {
      const cam = cameras.get(uuid)
      if (!cam) continue
      const proj = projectPoint(cam, p.x, p.y, p.z)
      if (!proj) continue
      res.push(Math.hypot(proj.u - px[0], proj.v - px[1]))
    }
  }
  const n = res.length
  if (!n) return { n: 0, mean: null, median: null, p95: null, max: null }
  res.sort((a, b) => a - b)
  const mean = res.reduce((a, b) => a + b, 0) / n
  const pct = (q) => res[Math.min(n - 1, Math.floor(q * n))]
  return { n, mean, median: pct(0.5), p95: pct(0.95), max: res[n - 1] }
}
