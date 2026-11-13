import { upperMedian } from '../stats.js'

// The photos' own ground sample distance in a product's frame: what one photo pixel
// covers on the surface it sees. Per camera, the median distance from its centre to the
// tie points it observes over its focal length (px); the median over cameras. Measured
// in the frame itself, so it is in the frame's unit whatever its scale or CRS.
//
// cameras  Map uuid → { R, t, K } (the sparse model's: x_cam = R·X + t, K at the
//          resolution the photos are read at)
// points   a SparsePoints (core/sfm/sparsePoints.js): pos, vstart, vcam, viewUuids
// toFrame  (p: [x, y, z] model) → [x, y, z] in the frame
// → the GSD (frame units per photo pixel), or null when no camera sees a point.
export function photoGsd(cameras, points, toFrame, { sampleMax = 50_000 } = {}) {
  const n = points?.length ?? 0
  if (!n || !cameras?.size) return null
  const centre = new Map()
  for (const [uuid, cam] of cameras) {
    if (!(cam?.K?.fx > 0)) continue
    const { R, t } = cam
    // C = −Rᵀ t
    const C = [0, 1, 2].map((j) => -(R[0][j] * t[0] + R[1][j] * t[1] + R[2][j] * t[2]))
    centre.set(uuid, { C: toFrame(C), fx: cam.K.fx, d: [] })
  }
  const stride = Math.max(1, Math.ceil(n / sampleMax))
  const { pos, vstart, vcam, viewUuids } = points
  for (let i = 0; i < n; i += stride) {
    const X = toFrame([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]])
    for (let s = vstart[i]; s < vstart[i + 1]; s++) {
      const c = centre.get(viewUuids[vcam[s]])
      if (c) c.d.push(Math.hypot(X[0] - c.C[0], X[1] - c.C[1], X[2] - c.C[2]))
    }
  }
  const perCamera = []
  for (const c of centre.values()) if (c.d.length) perCamera.push(upperMedian(c.d) / c.fx)
  return perCamera.length ? upperMedian(perCamera) : null
}
