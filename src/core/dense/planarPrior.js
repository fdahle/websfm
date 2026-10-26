// Planar priors for PatchMatch (ACMP: Xu & Tao, AAAI 2020). After the photometric sweeps,
// the credible pixels of a depth map — the cheapest of each grid cell, if its cost is
// below `maxCost` — are triangulated in the image (Delaunay), and every triangle's three
// points span a plane. Each pixel inside a triangle gets that plane's depth on its ray and
// its normal as a prior: a textureless wall between textured edges is spanned by large
// triangles, whose planes tell PatchMatch where the wall is. The prior enters the cost in
// mvs.rs / patchmatch.wgsl (see there); this module only builds it. Pure.

import Delaunator from 'delaunator'

/**
 * @param {{ depth: Float32Array, cost: Float32Array, width: number, height: number }} dm
 *   the first-pass map (a hole has depth ≤ 0)
 * @param {{ fx: number, fy: number, cx: number, cy: number }} K  the map's intrinsics
 * @param {{ grid?: number, maxCost?: number, minCosNormal?: number }} [opts]
 *   grid: support cell size in px; maxCost: the credibility threshold (ACMP 0.1);
 *   minCosNormal: a triangle whose plane meets the viewing ray more obliquely than this
 *   (|cos|) is dropped — near-grazing planes come from points on two different surfaces.
 * @returns {{ depth: Float32Array, normal: Float32Array, support: number, triangles: number, covered: number }}
 *   depth: the prior depth per pixel (0 = none); normal: 3 per pixel, camera frame, facing
 *   the camera (n_z < 0); covered: pixels with a prior.
 */
export function buildPlanarPrior(dm, K, { grid = 5, maxCost = 0.1, minCosNormal = 0.1 } = {}) {
  const { width: w, height: h, depth, cost } = dm
  const npix = w * h
  const outDepth = new Float32Array(npix)
  const outNormal = new Float32Array(3 * npix)
  // 1. Support points: per grid cell, the credible pixel with the lowest cost.
  const pts = []
  for (let by = 0; by < h; by += grid) {
    for (let bx = 0; bx < w; bx += grid) {
      let best = -1,
        bestC = maxCost
      for (let y = by; y < Math.min(h, by + grid); y++) {
        for (let x = bx; x < Math.min(w, bx + grid); x++) {
          const i = y * w + x
          if (depth[i] > 0 && cost[i] < bestC) {
            bestC = cost[i]
            best = i
          }
        }
      }
      if (best >= 0) pts.push(best)
    }
  }
  if (pts.length < 3) return { depth: outDepth, normal: outNormal, support: pts.length, triangles: 0, covered: 0 }
  const coords = new Float64Array(2 * pts.length)
  const P = new Float64Array(3 * pts.length) // the support points in the camera frame
  pts.forEach((i, k) => {
    const u = i % w,
      v = (i / w) | 0,
      d = depth[i]
    coords[2 * k] = u
    coords[2 * k + 1] = v
    P[3 * k] = ((u - K.cx) / K.fx) * d
    P[3 * k + 1] = ((v - K.cy) / K.fy) * d
    P[3 * k + 2] = d
  })
  // 2. Delaunay in the image, 3. one plane per triangle, rasterised.
  const tri = new Delaunator(coords).triangles
  let triangles = 0,
    covered = 0
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]]
    const e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]]
    const e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]]
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const len = Math.hypot(n[0], n[1], n[2])
    if (!(len > 1e-12)) continue
    n = n.map((x) => x / len)
    if (n[2] > 0) n = n.map((x) => -x) // face the camera
    const off = n[0] * P[3 * a] + n[1] * P[3 * a + 1] + n[2] * P[3 * a + 2] // n·X = off
    // Image bounding box of the triangle, then barycentric inside test per pixel.
    const xs = [coords[2 * a], coords[2 * b], coords[2 * c]],
      ys = [coords[2 * a + 1], coords[2 * b + 1], coords[2 * c + 1]]
    const det = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
    if (Math.abs(det) < 1e-9) continue
    let used = false
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
        const l1 = ((x - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (y - ys[0])) / det
        const l2 = ((xs[1] - xs[0]) * (y - ys[0]) - (x - xs[0]) * (ys[1] - ys[0])) / det
        if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue
        // The pixel's ray r = ((x − cx)/fx, (y − cy)/fy, 1) meets the plane at depth off / (n·r).
        const r = [(x - K.cx) / K.fx, (y - K.cy) / K.fy, 1]
        const nr = n[0] * r[0] + n[1] * r[1] + n[2] * r[2]
        if (Math.abs(nr) / Math.hypot(r[0], r[1], r[2]) < minCosNormal) continue
        const d = off / nr
        if (!(d > 0)) continue
        const i = y * w + x
        if (!(outDepth[i] > 0)) covered++
        outDepth[i] = d
        outNormal[3 * i] = n[0]
        outNormal[3 * i + 1] = n[1]
        outNormal[3 * i + 2] = n[2]
        used = true
      }
    }
    if (used) triangles++
  }
  return { depth: outDepth, normal: outNormal, support: pts.length, triangles, covered }
}
