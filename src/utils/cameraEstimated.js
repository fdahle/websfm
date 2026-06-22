// Pull "estimated" (bundle-adjusted) camera parameters out of a reconstruction
// camera record: { R: [[3×3]], t: [3], K: { fx, fy, cx, cy } }.
//
// Intrinsics (K) are in pixels and meaningful regardless of georeferencing.
// The camera centre C = -Rᵀ·t is in the reconstruction's own model space — it is
// NOT in the project CRS unless the model has been georeferenced, so callers
// should label it accordingly.

export function estimatedIntrinsics(cam) {
  if (!cam?.K) return null
  const { fx, fy, cx, cy } = cam.K
  return {
    focal: fx ?? null,
    focalY: fy ?? null,
    cx: cx ?? null,
    cy: cy ?? null,
  }
}

// Camera centre in model space: C = -Rᵀ·t
export function estimatedCenter(cam) {
  if (!cam?.R || !cam?.t) return null
  const R = cam.R, t = cam.t
  const x = -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2])
  const y = -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2])
  const z = -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2])
  return [x, y, z]
}

// Omega/phi/kappa (degrees) from the rotation matrix, using the common
// Rz(κ)·Ry(φ)·Rx(ω) photogrammetric convention. Returned for display only.
export function estimatedAngles(cam) {
  if (!cam?.R) return null
  const R = cam.R
  const deg = (r) => (r * 180) / Math.PI
  const phi = Math.asin(Math.max(-1, Math.min(1, R[0][2])))
  let omega, kappa
  if (Math.abs(R[0][2]) < 0.999999) {
    omega = Math.atan2(-R[1][2], R[2][2])
    kappa = Math.atan2(-R[0][1], R[0][0])
  } else {
    // Gimbal lock — fall back to a stable decomposition.
    omega = Math.atan2(R[2][1], R[1][1])
    kappa = 0
  }
  return { omega: deg(omega), phi: deg(phi), kappa: deg(kappa) }
}
