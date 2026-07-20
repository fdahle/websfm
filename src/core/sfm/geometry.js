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

// Estimate the scene's "up" direction (unit [x, y, z], in the arbitrary SfM frame)
// from the camera poses, for *viewing* only — the frame stays gauge-free, only the
// view (and the ground grid) is oriented to this vector. This is why buildings
// look level in COLMAP/Metashape viewers with no georeferencing.
//
// Two candidates, because neither works everywhere:
//   • the **image-up axis** mean — the negated 2nd row of each world→cam R (row 1
//     is image-y, which points *down*). Photographers rarely roll the camera, so
//     for terrestrial imagery this points at true vertical. On *nadir aerial* it is
//     horizontal (it lies along the flight heading) — dead wrong.
//   • the negated **viewing-direction** mean (3rd row of R) — correct for nadir
//     aerial (all cameras look down), meaningless for horizontal imagery, and
//     cancelling for a convergent object-scan rig.
// The discriminator is the cameras' own baseline geometry, scored on two axes of
// the camera-centre covariance:
//   + the **thinnest** axis — surveys hold a roughly constant height, so the
//     direction the centres *don't* spread in is vertical. Only meaningful when the
//     centres spread in two dimensions (a block/grid); a single strip is collinear,
//     which leaves two equally-thin axes and no reading.
//   − the **dominant** axis — the direction the survey travelled, which up is never.
// A nadir block scores the viewing-dir up at +1 and the image-up axis at ~0, so the
// aerial case resolves; a facade strip ties (both candidates are perpendicular to
// the wall run) and keeps the image-up axis. Ties, collinear rigs and cameras with
// no centres all fall back to the image-up axis — the historical behaviour.
//
// Known tie: a single nadir strip flown with image-x along-track gives neither
// candidate a signal. Fly/geo-reference a block, or set the CRS, for that one.
//
// Returns null with < 2 cameras or a degenerate mean (e.g. a pure pano spin), so
// callers fall back to world +Z. Accepts a Map<*, {R,t}> or an array of { R, t }.
export function estimateUpFromCameras(cameras) {
  const list = cameras && typeof cameras.values === 'function'
    ? [...cameras.values()] : (cameras || [])
  if (list.length < 2) return null

  let ax = 0, ay = 0, az = 0   // Σ image-up axes
  let vx = 0, vy = 0, vz = 0   // Σ viewing directions
  let n = 0
  for (const cam of list) {
    const R = cam?.R
    if (!R) continue
    ax -= R[1][0]; ay -= R[1][1]; az -= R[1][2]
    vx += R[2][0]; vy += R[2][1]; vz += R[2][2]
    n++
  }
  if (!n) return null

  const axisUp = unit([ax, ay, az])
  // |mean viewing dir| ≪ 1 ⇒ the directions largely cancel (convergent rig): no
  // coherent nadir reading, so there is nothing to weigh against the image axes.
  const viewUp = Math.hypot(vx, vy, vz) / n >= 0.3
    ? unit([-vx, -vy, -vz])
    : null
  if (!viewUp) return axisUp
  if (!axisUp) return viewUp

  const b = baselineAxes(list)
  if (!b) return axisUp
  const score = (c) =>
    (b.thin ? Math.abs(dot3(c, b.thin)) : 0) -
    (b.travel ? Math.abs(dot3(c, b.travel)) : 0)
  // Only switch on a clear margin, so an ambiguous rig keeps the historical answer.
  return (score(viewUp) - score(axisUp) > 0.3) ? viewUp : axisUp
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function unit(v) {
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null
}

// Principal axes of the camera centres:
//   travel — largest-variance axis (where the survey went), null if the centres are
//            too tightly clustered for any direction to mean something.
//   thin   — smallest-variance axis, but ONLY when the middle axis clearly outweighs
//            it (λ3 < 0.15·λ2). A collinear strip has λ2 ≈ λ3 ≈ 0, where "thinnest"
//            picks an arbitrary vector out of a whole perpendicular plane.
// Returns null when there are no usable centres at all.
function baselineAxes(list) {
  const C = []
  for (const cam of list) {
    if (!cam?.R || !cam?.t) continue
    C.push(cameraCenter(cam))
  }
  if (C.length < 2) return null
  let mx = 0, my = 0, mz = 0
  for (const c of C) { mx += c[0]; my += c[1]; mz += c[2] }
  mx /= C.length; my /= C.length; mz /= C.length
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const c of C) {
    const dx = c[0] - mx, dy = c[1] - my, dz = c[2] - mz
    xx += dx * dx; xy += dx * dy; xz += dx * dz
    yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  const trace = xx + yy + zz
  if (!(trace > 1e-12)) return null

  const { values, vectors } = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]])
  const order = [0, 1, 2].sort((a, c) => values[c] - values[a]) // descending λ
  const [lo, mid, hi] = order
  return {
    travel: unit(vectors[lo]),
    thin: values[mid] > 1e-12 && values[hi] < 0.15 * values[mid]
      ? unit(vectors[hi])
      : null,
  }
}

// Eigen-decomposition of a symmetric 3×3 by cyclic Jacobi rotations. Returns
// { values: [λ…], vectors: [v…] } with vectors[i] the unit eigenvector for values[i].
// Dependency-free and plenty accurate for a covariance this small.
function jacobiEigen3(M) {
  const a = [M[0].slice(), M[1].slice(), M[2].slice()]
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) off += a[p][q] * a[p][q]
    if (off < 1e-24) break
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q]
        a[k][p] = c * akp - s * akq
        a[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k]
        a[p][k] = c * apk - s * aqk
        a[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q]
        v[k][p] = c * vkp - s * vkq
        v[k][q] = s * vkp + c * vkq
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    // v is column-major (column i = eigenvector i); transpose to rows.
    vectors: [0, 1, 2].map((i) => [v[0][i], v[1][i], v[2][i]]),
  }
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
