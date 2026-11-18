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

// A rolling-shutter camera (`cam.rs = { v, h, tau }`, rollingShutter.js) sees a point
// from where it was when its row was read: X − τ·s·v with s = (row − cy)/h. The row
// depends on that place, so take it from the global-shutter projection `first` and
// iterate (the shift is pixels, so a few steps converge far below a pixel's
// thousandth). `proj(x, y, z)` is the camera's own projection → { u, v } or null.
export function projectRollingShutter(rs, cy, x, y, z, first, proj) {
  let p = first
  for (let i = 0; i < 4 && p; i++) {
    const k = (rs.tau * (p.v - cy)) / rs.h
    p = proj(x - k * rs.v[0], y - k * rs.v[1], z - k * rs.v[2])
  }
  return p
}

// The global-shutter camera a rolling-shutter one (`cam.rs`) was when it read `row`:
// moved by τ·s·v, s = (row − cy)/h, so t − τ·s·R·v. An observation at that row projects
// through it exactly, as bundle adjustment models it (the row is the observation's own,
// not solved for). A global-shutter camera is returned as it is.
export function rowCamera(cam, row) {
  const rs = cam.rs
  if (!(rs?.h > 0)) return cam
  const k = (rs.tau * (row - cam.K.cy)) / rs.h
  const { R, t, K } = cam
  return {
    R,
    t: [0, 1, 2].map((i) => t[i] - k * (R[i][0] * rs.v[0] + R[i][1] * rs.v[1] + R[i][2] * rs.v[2])),
    K,
  }
}

// Project a world point through { R, t, K } to pixel coords. Returns { u, v } or
// null when the point lies on the camera plane (|z_cam| ≈ 0). Points *behind* the
// camera still project (negative depth) — callers gate cheirality separately.
// A rolling-shutter camera (`cam.rs`) projects through projectRollingShutter.
export function projectPoint(cam, x, y, z) {
  const first = projectGlobal(cam, x, y, z)
  if (!first || !(cam.rs?.h > 0)) return first
  return projectRollingShutter(cam.rs, cam.K.cy, x, y, z, first, (a, b, c) => projectGlobal(cam, a, b, c))
}

function projectGlobal(cam, x, y, z) {
  const { R, t, K } = cam
  const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
  const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
  const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
  if (!isFinite(zc) || Math.abs(zc) < 1e-9) return null
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy }
}

// Like projectPoint but requires the point in front of the camera (z_cam > 0) and
// also returns that depth (the principal row's). Returns { u, v, depth } or null.
// A rolling-shutter camera (`cam.rs`) projects through projectRollingShutter.
export function projectWithDepth(cam, x, y, z) {
  const { R, t, K } = cam
  const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2]
  if (!(zc > 1e-9)) return null
  const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0]
  const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1]
  const first = { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy }
  if (!(cam.rs?.h > 0)) return { ...first, depth: zc }
  const p = projectRollingShutter(cam.rs, K.cy, x, y, z, first, (a, b, c) => projectGlobal(cam, a, b, c))
  return p ? { u: p.u, v: p.v, depth: zc } : null
}

// Triangulation (parallax) angle in degrees at world point `p`, between the two
// camera centres Ca and Cb. Small angle ⇒ ill-conditioned depth.
export function triangulationAngle(Ca, Cb, p) {
  const ax = p.x - Ca[0],
    ay = p.y - Ca[1],
    az = p.z - Ca[2]
  const bx = p.x - Cb[0],
    by = p.y - Cb[1],
    bz = p.z - Cb[2]
  const na = Math.hypot(ax, ay, az),
    nb = Math.hypot(bx, by, bz)
  if (na === 0 || nb === 0) return 0
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (na * nb)))
  return (Math.acos(c) * 180) / Math.PI
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
// `aerial`: the project is an aerial survey (the sign then follows the cameras'
// viewing direction, see `signed` below).
export function estimateUpFromCameras(cameras, { aerial = false, points = null } = {}) {
  const list = cameras && typeof cameras.values === 'function' ? [...cameras.values()] : cameras || []
  if (list.length < 2) return null

  let ax = 0,
    ay = 0,
    az = 0 // Σ image-up axes
  let vx = 0,
    vy = 0,
    vz = 0 // Σ viewing directions
  let n = 0
  const dirs = []
  for (const cam of list) {
    const R = cam?.R
    if (!R) continue
    ax -= R[1][0]
    ay -= R[1][1]
    az -= R[1][2]
    vx += R[2][0]
    vy += R[2][1]
    vz += R[2][2]
    dirs.push(unit([R[2][0], R[2][1], R[2][2]]))
    n++
  }
  if (!n) return null

  const axisUp = unit([ax, ay, az])
  // |mean viewing dir| ≪ 1 ⇒ the directions largely cancel (convergent rig): no
  // coherent nadir reading, so there is nothing to weigh against the image axes.
  // Trimmed to the block's main look (trimmedViewDirection: TMA obliques).
  const down = Math.hypot(vx, vy, vz) / n >= 0.3 ? trimmedViewDirection(dirs) : null
  const viewUp = down && [-down[0], -down[1], -down[2]]
  // Outside an aerial project the image-up axes have the last word on the SIGN.
  // Cameras that look UP at their subject (a facade shot from the street) have a
  // viewing-direction "up" that points at the ground, and the camera plane took
  // its sign from it: South Building (128 frames, ~60° up) showed upside down. An
  // unrolled camera's image-up axis leans up whether it looks up or down, so where
  // it leans clearly along the answer it is right. Not in aerial sets: a scanned
  // frame can be stored rotated, and there the cameras look down by definition.
  const signed = (u) => (!aerial && axisUp && dot3(u, axisUp) < -IMAGE_UP_SIGN_COS ? [-u[0], -u[1], -u[2]] : u)
  // A level camera plane seen obliquely outranks both readings (planeUpOverride).
  const plane = planeUpOverride(list, viewUp, axisUp)
  if (plane) return signed(plane.up)
  // A mixed vertical/oblique block, read against its ground plane (mixedLookUp).
  const mixed = points ? mixedLookUp(list, viewUp, points) : null
  if (mixed) return signed(mixed.up)
  if (!viewUp) return axisUp
  if (!axisUp) return viewUp

  const b = baselineAxes(list)
  if (!b) return axisUp
  const score = (c) => (b.thin ? Math.abs(dot3(c, b.thin)) : 0) - (b.travel ? Math.abs(dot3(c, b.travel)) : 0)
  // Only switch on a clear margin, so an ambiguous rig keeps the historical answer.
  return score(viewUp) - score(axisUp) > 0.3 ? signed(viewUp) : axisUp
}

// ── Up from the camera-centre PLANE ──────────────────────────────────────────
// A drone flight plan holds one altitude, and a walk or turntable ring one height,
// so camera centres that spread in two directions but not the third lie in a
// level plane: its normal is up. That is the only camera signal that survives an
// OBLIQUE capture. St Nazaire (127 DJI frames, all facing south at −26°/−50°
// pitch) puts the viewing-direction "up" 55° off vertical and the image-up axes
// ~36° off, while the centres' thin axis is 0.06 m against 6–18 m of spread.
//
// It overrides the viewing-direction reading only when the cameras look obliquely
// at the plane (> PLANE_UP_OBLIQUE_DEG from its normal). A nadir set keeps the
// viewing direction: there both agree on level ground, and on a terrain-following
// flight the plane tilts with the slope while the gimbal still points down. The
// threshold separates the two: terrain-following slopes rarely exceed ~25°, an
// oblique gimbal setting is usually ≥ 30° off nadir. An oblique set shallower than
// that keeps the old (tilted) viewing-direction reading — no worse than before.
// Known blind spot (unchanged from before): a vertical camera grid in front of a
// facade is planar with cameras looking along the normal, exactly like a nadir
// block turned 90°; nothing here can tell them apart.
export const PLANE_UP_OBLIQUE_DEG = 25
// How clearly the image-up axes must lean against an estimated up (cos 60°) to
// overrule its sign: estimateUpFromCameras, and the aerial check camerasLookUp.
export const IMAGE_UP_SIGN_COS = 0.5
const PLANE_THIN_RATIO = 0.05 // thinnest std ≤ 5% of the middle one ⇒ planar
const PLANE_SPREAD_RATIO = 0.2 // middle std ≥ 20% of the largest ⇒ not a single strip

// The signed plane normal, or null when the centres are not a usable plane, the
// cameras look near-perpendicular at it (nadir: keep `viewUp`), or no candidate
// can give it a sign. `viewUp`/`axisUp`: the viewing-direction and image-up
// readings (either may be null); the sign follows the first one present.
// → { up, viewTiltDeg } — viewTiltDeg = angle between viewUp and the plane normal.
export function planeUpOverride(cameras, viewUp = null, axisUp = null) {
  const list = cameras && typeof cameras.values === 'function' ? [...cameras.values()] : cameras || []
  const C = []
  for (const cam of list) if (cam?.R && cam?.t) C.push(cameraCenter(cam))
  if (C.length < 4) return null
  let mx = 0,
    my = 0,
    mz = 0
  for (const c of C) {
    mx += c[0]
    my += c[1]
    mz += c[2]
  }
  mx /= C.length
  my /= C.length
  mz /= C.length
  let xx = 0,
    xy = 0,
    xz = 0,
    yy = 0,
    yz = 0,
    zz = 0
  for (const c of C) {
    const dx = c[0] - mx,
      dy = c[1] - my,
      dz = c[2] - mz
    xx += dx * dx
    xy += dx * dy
    xz += dx * dz
    yy += dy * dy
    yz += dy * dz
    zz += dz * dz
  }
  if (!(xx + yy + zz > 1e-12)) return null
  const { values, vectors } = jacobiEigen3([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ])
  const [hi, mid, lo] = [0, 1, 2].sort((a, c) => values[c] - values[a])
  const s1 = Math.sqrt(Math.max(0, values[hi])),
    s2 = Math.sqrt(Math.max(0, values[mid]))
  const s3 = Math.sqrt(Math.max(0, values[lo]))
  if (!(s2 >= PLANE_SPREAD_RATIO * s1) || !(s3 <= PLANE_THIN_RATIO * s2)) return null
  let n = unit(vectors[lo])
  if (!n) return null
  const ref = viewUp ?? axisUp
  if (!ref) return null
  if (dot3(n, ref) < 0) n = [-n[0], -n[1], -n[2]]
  const viewTiltDeg = viewUp ? (Math.acos(Math.min(1, Math.abs(dot3(n, viewUp)))) * 180) / Math.PI : null
  if (viewTiltDeg != null && viewTiltDeg <= PLANE_UP_OBLIQUE_DEG) return null
  return { up: n, viewTiltDeg }
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// ── The viewing-direction mean, trimmed to the block's main look ─────────────
// A historical (TMA) block mixes vertical frames with left and right obliques that
// look ~60° off nadir. On Rachel (30 V, 12 L, 16 R) the obliques do not balance and
// the plain mean sits 21° off vertical, under PLANE_UP_OBLIQUE_DEG, so the camera
// plane did not take over and every local DEM and ortho came out tilted 21°, their
// relief sheared by hundreds of metres. Each pass keeps the cameras within the next
// angle of the current mean and re-averages: there the 30 verticals remain, 0.3° off.
// A nadir block, nadir with obliques all round, or one oblique look (St Nazaire's two
// pitches 24° apart) keeps the plain mean; a pass that would keep fewer than 3
// cameras stops. `dirs`: unit viewing directions. → the trimmed mean (unit) or null.
const VIEW_TRIM_DEG = [40, 30, 25, 25, 25]
export function trimmedViewDirection(dirs) {
  let m = unit(dirs.reduce((s, d) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]], [0, 0, 0]))
  for (const deg of VIEW_TRIM_DEG) {
    if (!m) return null
    const cos = Math.cos((deg * Math.PI) / 180)
    const keep = dirs.filter((d) => dot3(d, m) >= cos)
    if (keep.length < 3) break
    m = unit(keep.reduce((s, d) => [s[0] + d[0], s[1] + d[1], s[2] + d[2]], [0, 0, 0]))
  }
  return m
}

// ── Mixed looks: the vertical group, or the ground plane ─────────────────────
// trimmedViewDirection keeps the block's main look, which is the verticals only while
// they are the larger group. A partial TMA model can be mostly one oblique side:
// Rachel's first run kept 12 left obliques and 4 verticals, the trim settled on the
// obliques, and the model and every view of it came out ~60° off level. The cloud's
// ground plane says which look is vertical. When the camera reading is more than
// MIXED_LOOK_DEG off the plane's normal, the group of viewing directions within
// MIXED_LOOK_DEG of it gives up instead; when no group is, and the reading is more than
// OBLIQUE_ONLY_DEG off (an oblique-only model; a nadir flight over a 25° slope is not
// one), the normal itself does. A nadir set agrees with its ground within a few degrees
// and is never touched; the plane counts only where it is clearly flat (the smallest
// spread ≤ GROUND_FLAT_RATIO of the middle one), which an object scan is not.
const MIXED_LOOK_DEG = 25
const OBLIQUE_ONLY_DEG = 40
const VIEW_GROUP_DEG = 25 // directions within this of a group's seed belong to it
const GROUND_FLAT_RATIO = 0.3
const GROUND_SAMPLE = 20000 // points read for the plane (an even stride)
const GROUND_TRIM = 0.9 // the nearest share of them around the median centre

const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot3(a, b)))) * 180) / Math.PI

// Viewing directions in groups of one look each (TMA: vertical, left, right ~60° apart):
// the direction with the most others within VIEW_GROUP_DEG seeds a group, which takes
// them, and so on. → [{ mean (unit), n }], largest first.
export function viewGroups(dirs) {
  const cos = Math.cos((VIEW_GROUP_DEG * Math.PI) / 180)
  let left = dirs.map((_, i) => i)
  const groups = []
  while (left.length) {
    let seed = left[0],
      most = -1
    for (const i of left) {
      let n = 0
      for (const j of left) if (dot3(dirs[i], dirs[j]) >= cos) n++
      if (n > most) [seed, most] = [i, n]
    }
    const members = left.filter((j) => dot3(dirs[seed], dirs[j]) >= cos)
    const sum = members.reduce((s, j) => [s[0] + dirs[j][0], s[1] + dirs[j][1], s[2] + dirs[j][2]], [0, 0, 0])
    groups.push({ mean: unit(sum), n: members.length })
    const taken = new Set(members)
    left = left.filter((j) => !taken.has(j))
  }
  return groups.filter((g) => g.mean)
}

// The ground plane's normal, pointing at the cameras, or null where the cloud is not
// clearly a plane. `points`: SparsePoints ({ pos }, flat xyz), [{ x, y, z }], or any
// iterable of { x, y, z } with a `length` (the products worker's pointView).
export function groundUp(points, cameras) {
  const flat = points?.pos
  // SparsePoints' pos may hold spare capacity past `length`.
  const n = Math.min(points?.length ?? 0, flat ? Math.floor(flat.length / 3) : Infinity)
  if (n < 20 || !cameras?.length) return null
  const step = Math.max(1, Math.floor(n / GROUND_SAMPLE))
  const P = []
  const keep = (x, y, z) => {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) P.push([x, y, z])
  }
  if (flat) for (let i = 0; i < n; i += step) keep(flat[3 * i], flat[3 * i + 1], flat[3 * i + 2])
  else if (Array.isArray(points)) for (let i = 0; i < n; i += step) keep(points[i].x, points[i].y, points[i].z)
  else {
    let i = 0
    for (const p of points) {
      if (i >= n) break
      if (i % step === 0) keep(p.x, p.y, p.z)
      i++
    }
  }
  if (P.length < 20) return null
  const med = [0, 1, 2].map((k) => {
    const v = P.map((p) => p[k]).sort((a, b) => a - b)
    return v[v.length >> 1]
  })
  const d2 = P.map((p) => (p[0] - med[0]) ** 2 + (p[1] - med[1]) ** 2 + (p[2] - med[2]) ** 2)
  const cut = [...d2].sort((a, b) => a - b)[Math.floor(GROUND_TRIM * (d2.length - 1))]
  const Q = P.filter((_, i) => d2[i] <= cut)
  const c = [0, 1, 2].map((k) => Q.reduce((s, p) => s + p[k], 0) / Q.length)
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (const p of Q) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j]
  }
  const { values, vectors } = jacobiEigen3(M)
  const [, mid, lo] = [0, 1, 2].sort((a, b) => values[b] - values[a])
  if (!(values[mid] > 0) || Math.sqrt(Math.max(0, values[lo]) / values[mid]) > GROUND_FLAT_RATIO) return null
  let up = unit(vectors[lo])
  if (!up) return null
  // Toward the cameras: they fly above the ground.
  let cc = [0, 0, 0]
  for (const cam of cameras) {
    const C = cameraCenter(cam)
    cc = [cc[0] + C[0], cc[1] + C[1], cc[2] + C[2]]
  }
  const toCams = [cc[0] / cameras.length - c[0], cc[1] / cameras.length - c[1], cc[2] / cameras.length - c[2]]
  if (dot3(up, toCams) < 0) up = [-up[0], -up[1], -up[2]]
  return up
}

// The up a mixed or oblique look gives, or null to keep the camera reading `viewUp`.
// → { up, source: 'vertical-group' | 'ground-plane', viewTiltDeg, cameras? }
export function mixedLookUp(cameras, viewUp, points) {
  const list = (cameras && typeof cameras.values === 'function' ? [...cameras.values()] : cameras || []).filter(
    (c) => c?.R && c?.t,
  )
  if (!viewUp || !points || list.length < 2) return null
  const ground = groundUp(points, list)
  if (!ground) return null
  const viewTiltDeg = angleDeg(viewUp, ground)
  if (viewTiltDeg <= MIXED_LOOK_DEG) return null
  const dirs = list.map((c) => unit([c.R[2][0], c.R[2][1], c.R[2][2]])).filter(Boolean)
  const vertical = viewGroups(dirs)
    .map((g) => ({ up: [-g.mean[0], -g.mean[1], -g.mean[2]], n: g.n }))
    .filter((g) => g.n >= 2 && angleDeg(g.up, ground) <= MIXED_LOOK_DEG)
    .sort((a, b) => b.n - a.n)[0]
  if (vertical) return { up: vertical.up, source: 'vertical-group', viewTiltDeg, cameras: vertical.n }
  if (viewTiltDeg > OBLIQUE_ONLY_DEG) return { up: ground, source: 'ground-plane', viewTiltDeg }
  return null
}

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
  let mx = 0,
    my = 0,
    mz = 0
  for (const c of C) {
    mx += c[0]
    my += c[1]
    mz += c[2]
  }
  mx /= C.length
  my /= C.length
  mz /= C.length
  let xx = 0,
    xy = 0,
    xz = 0,
    yy = 0,
    yz = 0,
    zz = 0
  for (const c of C) {
    const dx = c[0] - mx,
      dy = c[1] - my,
      dz = c[2] - mz
    xx += dx * dx
    xy += dx * dy
    xz += dx * dz
    yy += dy * dy
    yz += dy * dz
    zz += dz * dz
  }
  const trace = xx + yy + zz
  if (!(trace > 1e-12)) return null

  const { values, vectors } = jacobiEigen3([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ])
  const order = [0, 1, 2].sort((a, c) => values[c] - values[a]) // descending λ
  const [lo, mid, hi] = order
  return {
    travel: unit(vectors[lo]),
    thin: values[mid] > 1e-12 && values[hi] < 0.15 * values[mid] ? unit(vectors[hi]) : null,
  }
}

// Eigen-decomposition of a symmetric 3×3 by cyclic Jacobi rotations. Returns
// { values: [λ…], vectors: [v…] } with vectors[i] the unit eigenvector for values[i].
// Dependency-free and plenty accurate for a covariance this small.
export function jacobiEigen3(M) {
  const a = [M[0].slice(), M[1].slice(), M[2].slice()]
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ])
      off += a[p][q] * a[p][q]
    if (off < 1e-24) break
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1),
        s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p],
          akq = a[k][q]
        a[k][p] = c * akp - s * akq
        a[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k],
          aqk = a[q][k]
        a[p][k] = c * apk - s * aqk
        a[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p],
          vkq = v[k][q]
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
// ── Pixel coordinates across resolutions ──────────────────────────────────────
// Pixel-centre convention: pixel i is centred on coordinate i and covers [i − ½, i + ½]
// (keypoints, K, every sample map). Every resample in the app is centre-aligned —
// canvas drawImage, the dense pyramid's box halving — so a native coordinate x lies
// at (x + ½)·s − ½ on a grid scaled by s, NOT at x·s. The difference is ½ − s/2 px:
// 0.3 px at s = 0.4, and 0.75 native px going back the other way. It cancelled while
// detection and dense used the same scale and the same wrong formula; it surfaced as
// a half-pixel bias against GCP marks (GeoScan checkpoints). Use these two, never x·s.
export const toScaledPx = (x, s) => (x + 0.5) * s - 0.5
export const fromScaledPx = (x, s) => (x + 0.5) / s - 0.5

// K for a grid scaled by s (same convention as toScaledPx: the principal point is a
// pixel coordinate, the focal a length). `scale` is one factor or per axis [sx, sy]:
// a resize to a rounded size scales the axes slightly differently (4107×2054 → 2054×1027
// is 0.50012 × 0.5), and a focal scaled by the wrong one biases depth by their ratio
// (2.4e-4 of the range: 41 m at 170 km on a synthetic KH-9 block).
export function scaleK(K, scale) {
  const [sx, sy] = scaleAxes(scale)
  return { fx: K.fx * sx, fy: K.fy * sy, cx: toScaledPx(K.cx, sx), cy: toScaledPx(K.cy, sy) }
}

// A grid scale as [sx, sy]: a number applies to both axes.
export const scaleAxes = (s) => (Array.isArray(s) ? s : [s, s])

// The per-axis factors a resize from natW×natH to width×height applied: drawImage maps
// the whole source extent onto the whole target, so each axis scales by its own ratio.
export const resizeScale = (width, height, natW, natH) => [width / natW, height / natH]

// RGBA pixel buffer → grayscale Uint8Array (Rec. 601 luma).
export function rgbaToGray(data, w, h) {
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) | 0
  }
  return gray
}
