// Brown–Conrady lens distortion (radial k1,k2,k3 + tangential p1,p2).
//
// The pipeline is pinhole everywhere; distortion is removed once, "at ingest",
// so no downstream consumer (triangulation, PnP, BA, the three PatchMatch kernels,
// DEM, ortho) has to know about it:
//   • sparse keypoints → undistortPixel (iterative inverse; run per keypoint)
//   • dense/ortho rasters → distortNormalized (closed-form forward; per output px,
//     building the undistorted→distorted sample map)
//
// Convention: (x, y) are NORMALISED image coords, x = (u − cx) / fx. The forward
// model maps an ideal (undistorted) normalised point to where the real lens
// recorded it; the inverse recovers the ideal point from an observed one.

// True when any coefficient is non-zero (so callers can cheaply skip the no-op).
export function hasDistortion(d) {
  return !!d && !!(d.k1 || d.k2 || d.k3 || d.p1 || d.p2)
}

// Forward Brown–Conrady: ideal normalised (x,y) → distorted normalised [xd,yd].
export function distortNormalized(x, y, d = {}) {
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = d || {}
  const r2 = x * x + y * y
  const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
  const xy = x * y
  const xd = x * radial + 2 * p1 * xy + p2 * (r2 + 2 * x * x)
  const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * xy
  return [xd, yd]
}

// Inverse: distorted normalised (xd,yd) → ideal normalised [x,y] by fixed-point
// iteration (the standard OpenCV scheme). Converges in a handful of steps for
// lens-grade coefficients; strong fisheye is out of scope for this model.
export function undistortNormalized(xd, yd, d = {}, iters = 8) {
  const { k1 = 0, k2 = 0, k3 = 0, p1 = 0, p2 = 0 } = d || {}
  let x = xd, y = yd
  for (let i = 0; i < iters; i++) {
    const r2 = x * x + y * y
    const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
    const xy = x * y
    const dxT = 2 * p1 * xy + p2 * (r2 + 2 * x * x)
    const dyT = p1 * (r2 + 2 * y * y) + 2 * p2 * xy
    x = (xd - dxT) / radial
    y = (yd - dyT) / radial
  }
  return [x, y]
}

// Undistort a DISTORTED pixel (as observed) into the ideal pinhole pixel it should
// occupy under intrinsics K. Returns { x, y } in pixels; a no-op when d is zero.
export function undistortPixel(u, v, K, d) {
  if (!hasDistortion(d)) return { x: u, y: v }
  const { fx, fy, cx, cy } = K
  const [x, y] = undistortNormalized((u - cx) / fx, (v - cy) / fy, d)
  return { x: fx * x + cx, y: fy * y + cy }
}

// Forward: an ideal pinhole pixel → the distorted pixel the lens recorded there.
// Used to build the sample map for raster undistortion (and to test round-trips).
export function distortPixel(u, v, K, d) {
  if (!hasDistortion(d)) return { x: u, y: v }
  const { fx, fy, cx, cy } = K
  const [xd, yd] = distortNormalized((u - cx) / fx, (v - cy) / fy, d)
  return { x: fx * xd + cx, y: fy * yd + cy }
}

// Pull the five Brown coefficients off a sensor-like object into a plain bag (or
// null when all zero) — the shape the worker/sfm marshalling forwards.
export function distortionOf(sensor) {
  if (!sensor) return null
  const d = { k1: sensor.k1 || 0, k2: sensor.k2 || 0, k3: sensor.k3 || 0, p1: sensor.p1 || 0, p2: sensor.p2 || 0 }
  return hasDistortion(d) ? d : null
}
