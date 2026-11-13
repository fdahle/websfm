// Framing the 3D view (Viewer3D.vue): how big the camera glyphs are, and robust
// bounds of a cloud for the view presets and the grid.
import * as THREE from 'three'
import { median as statsMedian, quantileNearest } from '../../core/stats.js'

// The visual size of the camera frustums / image thumbnails is driven by how
// tightly the cameras were shot (median nearest-neighbour spacing), NOT by the
// point-cloud extent. Point-cloud radius is a poor proxy: a small/compact sparse
// cloud — or one whose radius is inflated by a few stray triangulated points —
// makes every quad the same big size regardless of camera spacing, so they pile
// up and overlap. Nearest-neighbour spacing is invariant to those outliers and to
// absolute scene scale, so adjacent frustums roughly touch instead of overlapping.
// 0 for no values (the framing then falls back to its defaults).
const median = (arr) => (arr.length ? statsMedian(arr) : 0)
const percentile = (arr, q) => (arr.length ? quantileNearest(Float64Array.from(arr).sort(), q) : 0)
// centres: THREE.Vector3[] of camera centres. Returns the frustum forward depth.
export function cameraFrustumDepth(centres, points3d) {
  // Preferred: median nearest-neighbour distance between camera centres.
  if (centres.length >= 2) {
    const nn = []
    for (let i = 0; i < centres.length; i++) {
      let best = Infinity
      for (let j = 0; j < centres.length; j++) {
        if (i === j) continue
        const d = centres[i].distanceTo(centres[j])
        if (d < best) best = d
      }
      if (best < Infinity) nn.push(best)
    }
    const med = median(nn)
    if (med > 0) return med * 0.6 // adjacent quads (half-width 0.3·d) stay clear
  }
  // Fallback (<2 cameras): robust point radius about the centroid — 95th
  // percentile so a handful of outlier points can't blow up the scale.
  if (points3d.length > 0) {
    let mx = 0,
      my = 0,
      mz = 0
    for (const p of points3d) {
      mx += p.x
      my += p.y
      mz += p.z
    }
    mx /= points3d.length
    my /= points3d.length
    mz /= points3d.length
    const r = percentile(
      points3d.map((p) => Math.hypot(p.x - mx, p.y - my, p.z - mz)),
      0.95,
    )
    if (r > 0) return r * 0.15
  }
  return 0.15
}

// Robust scene bounds from a flat position buffer: a per-axis *median* centre and a
// 95th-percentile radius, so a handful of stray far points (common in sparse clouds)
// can't inflate the framing or the grid span — the raw Three.js bounding sphere
// (Ritter) is outlier-sensitive and made sparse↔dense frame very differently. Also
// returns the 2nd/98th-percentile extent *along `up`* for grid placement. Sub-
// samples to ≤ SAMPLE points so million-point dense clouds stay cheap on the main
// thread.
const BOUNDS_SAMPLE = 20000
export function robustBounds(positions, count, up) {
  const step = Math.max(1, Math.floor(count / BOUNDS_SAMPLE))
  const xs = [],
    ys = [],
    zs = []
  for (let i = 0; i < count; i += step) {
    xs.push(positions[i * 3])
    ys.push(positions[i * 3 + 1])
    zs.push(positions[i * 3 + 2])
  }
  const cx = median(xs),
    cy = median(ys),
    cz = median(zs)
  const dists = [],
    alongs = []
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - cx,
      dy = ys[k] - cy,
      dz = zs[k] - cz
    dists.push(Math.hypot(dx, dy, dz))
    alongs.push(dx * up.x + dy * up.y + dz * up.z)
  }
  return {
    center: new THREE.Vector3(cx, cy, cz),
    radius: percentile(dists, 0.95) || 1,
    alongMin: percentile(alongs, 0.02),
    alongMax: percentile(alongs, 0.98),
  }
}
