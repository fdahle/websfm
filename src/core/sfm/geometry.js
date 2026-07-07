// Shared pinhole-camera geometry — pure, no Vue/Pinia/OPFS/DOM/WASM. Used by both
// the sparse pipeline (core/sfm/sfm.js) and the dense pipeline (core/dense/mvs.js), which
// previously each carried their own copies of these helpers.
//
// Conventions: rotation R is row-major [[…],[…],[…]]; translation t is [x,y,z];
// a pose maps world→camera as x_cam = R·x_world + t. K is { fx, fy, cx, cy }.

// Camera centre in world coords: C = -Rᵀt.
export function cameraCenter({ R, t }) {
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

// Project a world point through { R, t, K } to pixel coords. Returns { u, v } or
// null when the point lies on the camera plane (|z_cam| ≈ 0). Points *behind* the
// camera still project (negative depth) — callers gate cheirality separately.
export function projectPoint(cam, x, y, z) {
  const { R, t, K } = cam
  const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
  const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
  const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
  if (!isFinite(zc) || Math.abs(zc) < 1e-9) return null
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy }
}

// Like projectPoint but requires the point in front of the camera (z_cam > 0) and
// also returns that depth. Returns { u, v, depth } or null. (Dense MVS reprojection.)
export function projectWithDepth(cam, x, y, z) {
  const { R, t, K } = cam
  const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
  if (!(zc > 1e-9)) return null
  const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
  const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy, depth: zc }
}

// Triangulation (parallax) angle in degrees at world point `p`, between the two
// camera centres Ca and Cb. Small angle ⇒ ill-conditioned depth.
export function triangulationAngle(Ca, Cb, p) {
  const ax = p.x - Ca[0], ay = p.y - Ca[1], az = p.z - Ca[2]
  const bx = p.x - Cb[0], by = p.y - Cb[1], bz = p.z - Cb[2]
  const na = Math.hypot(ax, ay, az), nb = Math.hypot(bx, by, bz)
  if (na === 0 || nb === 0) return 0
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (na * nb)))
  return Math.acos(c) * 180 / Math.PI
}

// Median parallax angle (deg) between two cameras over a set of 3D points.
export function medianTriangulationAngle(camA, camB, pts) {
  if (!pts.length) return 0
  const Ca = cameraCenter(camA)
  const Cb = cameraCenter(camB)
  const angles = pts.map((p) => triangulationAngle(Ca, Cb, p))
  if (!angles.length) return 0
  angles.sort((a, b) => a - b)
  return angles[angles.length >> 1]
}

// Scale intrinsics K to a working resolution (longest side × `scale`).
export function scaleK(K, scale) {
  return { fx: K.fx * scale, fy: K.fy * scale, cx: K.cx * scale, cy: K.cy * scale }
}

// RGBA pixel buffer → grayscale Uint8Array (Rec. 601 luma).
export function rgbaToGray(data, w, h) {
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) | 0
  }
  return gray
}
