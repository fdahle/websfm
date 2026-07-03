// Projection frame for DEM / orthophoto products — pure, no Vue/Pinia/OPFS/DOM.
//
// The sparse/dense SfM output lives in an arbitrary "world" frame (up-to-scale,
// axes point nowhere meaningful). A DEM/ortho need a *vertical* direction: an
// axis to call "height" and an XY plane to rasterise onto. This module derives
// that vertical from the camera geometry (nadir aerial sets look roughly down,
// so their mean viewing direction defines the vertical) with a PCA-of-cloud
// fallback, and packages it as a "frame".
//
// A frame is a small object with two inverse maps and metadata:
//   frame.fromSfm([x,y,z] world)  → [x,y,z] target   (z = height)
//   frame.toSfm([x,y,z] target)   → [x,y,z] world
//   frame.crs   — 'local' here; georef.js builds CRS-tagged frames the same way
//   frame.unit  — 'model' (up-to-scale) unless a georeference sets real units
// DEM/ortho only ever talk to a frame through these two maps, so the georeferenced
// path (georef.js) drops in with no changes downstream.
//
// Conventions match geometry.js: rotation R is row-major [[…],[…],[…]] mapping
// world→camera (x_cam = R·x_world + t); t is [x,y,z].

// ── small vector helpers ─────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a) => Math.hypot(a[0], a[1], a[2])
const normalize = (a) => {
  const n = norm(a)
  return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 0]
}

// Camera centre C = -Rᵀt (world coords). Duplicated from geometry.js so this
// module stays a leaf (no cross-import), matching the file's one-purpose rule.
function cameraCenter({ R, t }) {
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

// Optical axis (viewing direction, +Z_cam) in world coords: Rᵀ·[0,0,1] = the
// third row of R. Points from the camera toward what it looks at.
function viewingDir({ R }) {
  return normalize([R[2][0], R[2][1], R[2][2]])
}

// ── vertical estimation ──────────────────────────────────────────────────────

// Estimate "up" from the cameras: nadir aerial cameras all look roughly down, so
// the mean viewing direction is roughly the ground direction and up = −that.
// Returns a unit vector, or null if the cameras give no coherent direction (e.g.
// a convergent object-scan rig, where the mean viewing dir cancels out).
export function estimateUpFromCameras(cameras) {
  let sx = 0, sy = 0, sz = 0, n = 0
  for (const cam of cameras) {
    const d = viewingDir(cam)
    sx += d[0]; sy += d[1]; sz += d[2]; n++
  }
  if (n === 0) return null
  const mean = [sx / n, sy / n, sz / n]
  // |mean| ≪ 1 ⇒ viewing directions largely cancel (not a coherent nadir set).
  if (norm(mean) < 0.3) return null
  return normalize([-mean[0], -mean[1], -mean[2]])
}

// Estimate "up" from the point cloud: the ground is the dominant plane, so the
// smallest-variance principal axis of the points is its normal. Sign is
// disambiguated by `hint` (typically the camera-based up) so height increases
// toward the cameras. Returns a unit vector, or null for degenerate input.
export function estimateUpFromCloud(points, hint = null) {
  const n = points.length
  if (n < 3) return null
  let cx = 0, cy = 0, cz = 0
  for (const p of points) { cx += p.x; cy += p.y; cz += p.z }
  cx /= n; cy /= n; cz /= n
  // Symmetric 3×3 covariance.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const p of points) {
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz
    xx += dx * dx; xy += dx * dy; xz += dx * dz
    yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  const cov = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]
  const axis = smallestEigenvector(cov)
  if (!axis) return null
  const up = normalize(axis)
  if (hint && dot(up, hint) < 0) return scale(up, -1)
  return up
}

// Smallest-eigenvalue eigenvector of a symmetric 3×3 matrix via inverse power
// iteration on (M − λI) with λ a small shift below the trace. Deflation-free and
// dependency-free (matches the crate's no-dependency spirit); enough for a plane
// normal. Returns null if the matrix is singular/degenerate.
function smallestEigenvector(M) {
  const tr = M[0][0] + M[1][1] + M[2][2]
  const shift = tr * 1e-6 + 1e-12
  // A = M − shift·I, then iterate v ← A⁻¹v to converge on the smallest mode.
  const A = [
    [M[0][0] - shift, M[0][1], M[0][2]],
    [M[1][0], M[1][1] - shift, M[1][2]],
    [M[2][0], M[2][1], M[2][2] - shift],
  ]
  let v = [1, 1, 1]
  for (let it = 0; it < 50; it++) {
    const nv = solve3(A, v)
    if (!nv) return null
    const len = norm(nv)
    if (len < 1e-20) return null
    const next = scale(nv, 1 / len)
    if (Math.abs(Math.abs(dot(next, v)) - 1) < 1e-10) { v = next; break }
    v = next
  }
  return v
}

// Solve A·x = b for a 3×3 A by Cramer's rule. Returns null if |A| ≈ 0.
function solve3(A, b) {
  const det =
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
  if (Math.abs(det) < 1e-20) return null
  const col = (c) => {
    const m = [A[0].slice(), A[1].slice(), A[2].slice()]
    m[0][c] = b[0]; m[1][c] = b[1]; m[2][c] = b[2]
    return (
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )
  }
  return [col(0) / det, col(1) / det, col(2) / det]
}

// ── frame construction ───────────────────────────────────────────────────────

// Build a right-handed orthonormal basis {east, north, up} with the given `up`
// as its third (height) axis. East/north are arbitrary in a local frame, so we
// derive them deterministically from a world axis least parallel to up.
function basisFromUp(up) {
  const u = normalize(up)
  // Reference axis least aligned with up (avoids a degenerate projection).
  const ref = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const east = normalize(sub(ref, scale(u, dot(ref, u))))
  const north = normalize(cross(u, east)) // up × east ⇒ east × north = up
  return { east, north, up: u }
}

// Build the local projection frame from cameras (preferred) and/or points. The
// origin is the point-cloud centroid (or camera centroid) so local coords stay
// near zero. `unit:'model'` flags that distances are up-to-scale.
//   cameras: iterable of { R, t }   points: [{ x, y, z }]
export function buildLocalFrame(cameras = [], points = []) {
  const cams = [...cameras]
  let up = estimateUpFromCameras(cams)
  let source = 'cameras'
  if (!up) {
    up = estimateUpFromCloud(points, null)
    source = 'cloud-pca'
  }
  if (!up) { up = [0, 0, 1]; source = 'default-z' }

  // Origin: centroid of the points if present, else of the camera centres.
  let origin = [0, 0, 0]
  if (points.length) {
    let sx = 0, sy = 0, sz = 0
    for (const p of points) { sx += p.x; sy += p.y; sz += p.z }
    origin = [sx / points.length, sy / points.length, sz / points.length]
  } else if (cams.length) {
    let s = [0, 0, 0]
    for (const c of cams) s = add(s, cameraCenter(c))
    origin = scale(s, 1 / cams.length)
  }

  const { east, north, up: u } = basisFromUp(up)
  return makeFrame({ origin, east, north, up: u, crs: 'local', unit: 'model', source })
}

// ── Canonical Z-up orientation (aerial auto-fix) ─────────────────────────────

// Rotation (row-major 3×3) that maps the SfM world into a canonical frame where
// the estimated up is +Z, east is +X, north is +Y. Rows are the basis vectors, so
// canonical = R·world. Returns null when up can't be determined from the cameras
// (e.g. a convergent object-scan rig — nothing to orient). Aerial nadir surveys
// resolve cleanly: cameras look down, so up points toward them and this rotation
// lifts them above the ground (fixes the SfM gauge/flip ambiguity).
export function aerialUpRotation(cameras) {
  const cams = cameras instanceof Map ? [...cameras.values()] : [...cameras]
  const up = estimateUpFromCameras(cams)
  if (!up) return null
  const { east, north, up: u } = basisFromUp(up)
  return [east.slice(), north.slice(), u.slice()]
}

// Apply a world rotation R (row-major 3×3) to a reconstruction: points rotate as
// p' = R·p; a camera pose (x_cam = R_c·x_world + t) becomes R_c' = R_c·Rᵀ with t
// unchanged (the image the camera sees is invariant — we only re-express the
// world). Intrinsics, view-tracks and colour pass through. Returns fresh
// { cameras: Map, points: [] }; inputs are not mutated.
//   cameras: Map<uuid, { R, t, K }>   points: [{ x, y, z, ... }]
export function rotateReconstruction(cameras, points, R) {
  const Rt = [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]],
  ]
  const mul = (A, B) => {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]
    return C
  }
  const newCams = new Map()
  for (const [uuid, cam] of cameras) {
    newCams.set(uuid, { R: mul(cam.R, Rt), t: [...cam.t], K: cam.K })
  }
  const newPts = points.map((p) => ({
    ...p,
    x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z,
    y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z,
    z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z,
  }))
  return { cameras: newCams, points: newPts }
}

// Assemble a frame object from an orthonormal basis + origin. Exposed so georef.js
// (and tests) can build frames from a known basis. The maps are exact inverses.
export function makeFrame({ origin, east, north, up, crs = 'local', unit = 'model', source = null }) {
  const fromSfm = (p) => {
    const d = sub(Array.isArray(p) ? p : [p.x, p.y, p.z], origin)
    return [dot(d, east), dot(d, north), dot(d, up)]
  }
  const toSfm = (c) => add(origin, add(add(scale(east, c[0]), scale(north, c[1])), scale(up, c[2])))
  return { fromSfm, toSfm, origin, east, north, up, crs, unit, source }
}
