// Cloud-to-cloud alignment: transform representation, manual transforms, point-pair
// fits and ICP. Pure, no Vue/Pinia/OPFS/DOM — plain data in, plain data out, side
// effects via the injected `onLog` / `onProgress`.
//
// One transform representation everywhere:
//   tf = { scale = 1, R: [[…],[…],[…]] (row-major rotation), t: [x,y,z] }
//   p' = scale·R·p + t
// A flat row-major 4×4 `matrix` (16 numbers, last row 0 0 0 1) is the interchange
// form (CloudCompare / PDAL / text fields); `transformFromMatrix` / `matrixFromTransform`
// convert. A matrix that is not a similarity (shear, anisotropic scale, reflection)
// is still accepted by default and comes back as `{ scale:null, R:null, linear, t,
// isSimilarity:false }` — `transformCloud` / `composeTransforms` apply it, ICP and
// the report refuse it. Composition reads like function application:
// `composeTransforms(a, b)` = "b, then a".
//
// Precision: survey coordinates are ~1e6. Every least-squares solve here (pair fit,
// ICP) runs in a local frame centred on the reference centroid, in double precision,
// and the result is moved back out (t_world = t_local + c − s·R·c). Transformed
// positions are always written as Float64Array.
//
// ICP (`icpAlign`): a seeded random subsample of the source, exact 1-NN
// correspondences against the reference (core/products/knn.js — the one neighbour
// index), rejection beyond `maxDistance`, then a trimmed set (best `trim` fraction
// by distance). Point-to-plane solves the linearised small-angle 6-DoF (7 with
// scale) least squares about the correspondence centroid; point-to-point solves
// Horn's closed form each iteration. Point-to-plane needs reference normals; their
// estimation is NOT done here (core/products/cloudNormals.js) — without them it
// falls back to point-to-point and says so. A mesh reference uses its vertices,
// with area-weighted vertex normals averaged from the incident faces.
//
// Dense-scale invariant: typed arrays only for per-point data; inputs are never
// mutated.

import { fitSimilarity } from './georef.js'
import { buildKnnIndex, knnQuery } from './knn.js'

// ── Small linear-algebra helpers (3×3 row-major arrays) ──────────────────────

const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const mat3Mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const mat3Vec = (A, v) => [
  A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
  A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
  A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
]
const det3 = (A) =>
  A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
  - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
  + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
// Cofactor matrix: cof(A) = det(A)·A⁻ᵀ, the normal transform up to scale.
const cof3 = (A) => [
  [A[1][1] * A[2][2] - A[1][2] * A[2][1], A[1][2] * A[2][0] - A[1][0] * A[2][2], A[1][0] * A[2][1] - A[1][1] * A[2][0]],
  [A[0][2] * A[2][1] - A[0][1] * A[2][2], A[0][0] * A[2][2] - A[0][2] * A[2][0], A[0][1] * A[2][0] - A[0][0] * A[2][1]],
  [A[0][1] * A[1][2] - A[0][2] * A[1][1], A[0][2] * A[1][0] - A[0][0] * A[1][2], A[0][0] * A[1][1] - A[0][1] * A[1][0]],
]

/** Rotation by angle |w| about axis w (Rodrigues) — exactly orthonormal. */
function rodrigues(wx, wy, wz) {
  const a = Math.hypot(wx, wy, wz)
  if (a < 1e-300) return I3()
  const x = wx / a, y = wy / a, z = wz / a
  const c = Math.cos(a), s = Math.sin(a), q = 1 - c
  return [
    [c + x * x * q, x * y * q - z * s, x * z * q + y * s],
    [y * x * q + z * s, c + y * y * q, y * z * q - x * s],
    [z * x * q - y * s, z * y * q + x * s, c + z * z * q],
  ]
}

/** Gram–Schmidt on the rows — keeps an accumulated rotation from drifting. */
function orthonormalize(R) {
  const r0 = R[0].slice(), r1 = R[1].slice()
  let l = Math.hypot(r0[0], r0[1], r0[2]); r0[0] /= l; r0[1] /= l; r0[2] /= l
  const d = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2]
  r1[0] -= d * r0[0]; r1[1] -= d * r0[1]; r1[2] -= d * r0[2]
  l = Math.hypot(r1[0], r1[1], r1[2]); r1[0] /= l; r1[1] /= l; r1[2] /= l
  const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]]
  return [r0, r1, r2]
}

/** Rotation angle of R in radians (atan2 form — accurate for tiny angles too). */
export function rotationAngle(R) {
  const tr = R[0][0] + R[1][1] + R[2][2]
  const vx = R[2][1] - R[1][2], vy = R[0][2] - R[2][0], vz = R[1][0] - R[0][1]
  return Math.atan2(0.5 * Math.hypot(vx, vy, vz), 0.5 * (tr - 1))
}

// Dense solve of a small system (n ≤ 7) by Gaussian elimination with partial
// pivoting. A is a Float64Array(n·n), row-major; both inputs are overwritten.
function solveSmall(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r
    if (!(Math.abs(A[piv * n + c]) > 0)) return null
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t }
      const t = b[c]; b[c] = b[piv]; b[piv] = t
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c]
      if (f === 0) continue
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k]
      b[r] -= f * b[c]
    }
  }
  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r]
    for (let k = r + 1; k < n; k++) v -= A[r * n + k] * x[k]
    x[r] = v / A[r * n + r]
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null
  return x
}

// ── Transform representation ─────────────────────────────────────────────────

/** The identity transform. */
export function identityTransform() {
  return { scale: 1, R: I3(), t: [0, 0, 0] }
}

/**
 * Internal: any accepted transform form → { A (3×3 linear part), t }.
 * Accepts { scale, R, t }, { linear, t }, { matrix }, or a bare 16/12-number array.
 */
function affineOf(tf) {
  if (tf == null) return { A: I3(), t: [0, 0, 0] }
  if (Array.isArray(tf) || ArrayBuffer.isView(tf)) {
    const m = transformFromMatrix(tf)
    return affineOf(m)
  }
  if (tf.linear) return { A: tf.linear.map((r) => r.slice()), t: (tf.t ?? [0, 0, 0]).slice() }
  if (tf.R) {
    const s = tf.scale ?? 1
    return { A: tf.R.map((r) => r.map((v) => s * v)), t: (tf.t ?? [0, 0, 0]).slice() }
  }
  if (tf.matrix) return affineOf(transformFromMatrix(tf.matrix))
  throw new Error('Unrecognised transform: expected { scale, R, t }, { linear, t } or a 4×4 matrix.')
}

/** Internal: a similarity { scale, R, t } from any accepted form, or throw. */
function similarityOf(tf, what = 'transform') {
  if (tf == null) return identityTransform()
  if (tf.R && !tf.linear) return { scale: tf.scale ?? 1, R: tf.R.map((r) => r.slice()), t: (tf.t ?? [0, 0, 0]).slice() }
  const m = Array.isArray(tf) || ArrayBuffer.isView(tf) ? tf : (tf.matrix ?? matrixFromTransform(tf))
  const s = transformFromMatrix(m)
  if (!s.isSimilarity) throw new Error(`The ${what} must be a rotation + uniform scale + translation; this one shears, scales unevenly or mirrors.`)
  return { scale: s.scale, R: s.R, t: s.t }
}

/** Apply a transform (any accepted form) to one point → [x, y, z]. */
export function applyTransform(tf, p) {
  const { A, t } = affineOf(tf)
  const q = mat3Vec(A, p)
  return [q[0] + t[0], q[1] + t[1], q[2] + t[2]]
}

/**
 * Flat row-major 4×4 (16 numbers) or 3×4 (12) → transform.
 * @param {ArrayLike<number>} m
 * @param {{ requireSimilarity?: boolean, tolerance?: number }} [opts]
 *   tolerance: max |RRᵀ − I| entry for the linear part to count as scale·rotation
 *   (text matrices carry ~6–9 significant digits, so not exact zero).
 * @returns {{ scale:number|null, R:number[][]|null, t:number[], isSimilarity:boolean,
 *   linear?:number[][], matrix:number[] }} — for a non-similarity `scale`/`R` are null
 *   and `linear` carries the 3×3 linear part.
 */
export function transformFromMatrix(m, { requireSimilarity = false, tolerance = 1e-6 } = {}) {
  const len = m?.length
  if (len !== 16 && len !== 12) {
    throw new Error(`Expected 16 numbers (a 4×4 matrix) or 12 (3×4), got ${len ?? 0}.`)
  }
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(m[i])) throw new Error(`Matrix entry ${i + 1} is not a finite number.`)
  }
  let w = 1
  if (len === 16) {
    const persp = Math.max(Math.abs(m[12]), Math.abs(m[13]), Math.abs(m[14]))
    if (persp > 1e-12 * Math.max(1, Math.abs(m[15]))) {
      throw new Error('The last row of the 4×4 matrix must be 0 0 0 1 — perspective transforms are not supported.')
    }
    if (!(Math.abs(m[15]) > 0)) throw new Error('The 4×4 matrix has 0 in its bottom-right entry.')
    w = m[15]
  }
  const A = [[m[0] / w, m[1] / w, m[2] / w], [m[4] / w, m[5] / w, m[6] / w], [m[8] / w, m[9] / w, m[10] / w]]
  const t = [m[3] / w, m[7] / w, m[11] / w]
  const det = det3(A)
  const norm = Math.max(...A.flat().map(Math.abs))
  if (!(Math.abs(det) > 1e-12 * norm * norm * norm)) {
    throw new Error('The matrix is singular (it flattens space) — not a usable transform.')
  }
  let isSimilarity = false
  let R = null, scale = null
  if (det > 0) {
    const s = Math.cbrt(det)
    const Rc = A.map((r) => r.map((v) => v / s))
    let dev = 0
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const d = Rc[i][0] * Rc[j][0] + Rc[i][1] * Rc[j][1] + Rc[i][2] * Rc[j][2] - (i === j ? 1 : 0)
      dev = Math.max(dev, Math.abs(d))
    }
    if (dev <= tolerance) { isSimilarity = true; R = Rc; scale = s }
  }
  if (requireSimilarity && !isSimilarity) {
    throw new Error(det < 0
      ? 'The matrix mirrors space (negative determinant) — not a rotation + scale + translation.'
      : 'The matrix shears or scales unevenly — not a rotation + uniform scale + translation.')
  }
  const matrix = [A[0][0], A[0][1], A[0][2], t[0], A[1][0], A[1][1], A[1][2], t[1], A[2][0], A[2][1], A[2][2], t[2], 0, 0, 0, 1]
  return isSimilarity
    ? { scale, R, t, isSimilarity, matrix }
    : { scale: null, R: null, t, isSimilarity, linear: A, matrix }
}

/** Transform (any accepted form) → flat row-major 4×4 (plain number[16]). */
export function matrixFromTransform(tf) {
  const { A, t } = affineOf(tf)
  return [A[0][0], A[0][1], A[0][2], t[0], A[1][0], A[1][1], A[1][2], t[1], A[2][0], A[2][1], A[2][2], t[2], 0, 0, 0, 1]
}

/**
 * a ∘ b — apply `b` first, then `a`. Two similarities compose to a similarity
 * { scale, R, t } exactly; anything else goes through the general affine form.
 */
export function composeTransforms(a, b) {
  const simA = a?.R && !a.linear, simB = b?.R && !b.linear
  if (simA && simB) {
    const sa = a.scale ?? 1, sb = b.scale ?? 1
    const Rtb = mat3Vec(a.R, b.t ?? [0, 0, 0])
    const ta = a.t ?? [0, 0, 0]
    return {
      scale: sa * sb,
      R: mat3Mul(a.R, b.R),
      t: [sa * Rtb[0] + ta[0], sa * Rtb[1] + ta[1], sa * Rtb[2] + ta[2]],
    }
  }
  const fa = affineOf(a), fb = affineOf(b)
  const A = mat3Mul(fa.A, fb.A)
  const At = mat3Vec(fa.A, fb.t)
  const t = [At[0] + fa.t[0], At[1] + fa.t[1], At[2] + fa.t[2]]
  return transformFromMatrix([A[0][0], A[0][1], A[0][2], t[0], A[1][0], A[1][1], A[1][2], t[1], A[2][0], A[2][1], A[2][2], t[2]])
}

/**
 * Parse a pasted matrix: 16 numbers (4×4) or 12 (3×4), row-major, separated by any
 * mix of whitespace, commas and semicolons; brackets are ignored.
 * Throws a readable Error on anything else.
 * @param {string} text
 * @param {{ requireSimilarity?: boolean, tolerance?: number }} [opts] see transformFromMatrix
 */
export function parseMatrixText(text, opts = {}) {
  const tokens = String(text ?? '').replace(/[[\]{}()]/g, ' ').split(/[\s,;]+/).filter(Boolean)
  const nums = tokens.map((tok) => {
    const v = Number(tok)
    if (!Number.isFinite(v)) throw new Error(`Could not read "${tok}" as a number.`)
    return v
  })
  if (nums.length !== 16 && nums.length !== 12) {
    throw new Error(`Expected 16 numbers (4×4) or 12 numbers (3×4), found ${nums.length}.`)
  }
  return transformFromMatrix(nums, opts)
}

/**
 * Build a similarity from user-facing parameters.
 *
 * Convention: right-handed axes, angles in degrees, positive = counter-clockwise
 * when looking down the axis towards the origin. The rotations are about the FIXED
 * (world) axes, applied X first, then Y, then Z — i.e. R = Rz·Ry·Rx. Rotation and
 * scale both act about `pivot`, then `translate` is added:
 *   p' = scale·R·(p − pivot) + pivot + translate
 *
 * @param {{ translate?:number[], rotateDeg?:number[], scale?:number, pivot?:number[] }} params
 * @returns {{ scale:number, R:number[][], t:number[] }}
 */
export function transformFromEuler({ translate = [0, 0, 0], rotateDeg = [0, 0, 0], scale = 1, pivot = [0, 0, 0] } = {}) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Scale must be a positive number.')
  const [ax, ay, az] = rotateDeg.map((d) => (Number(d) || 0) * Math.PI / 180)
  const cx = Math.cos(ax), sx = Math.sin(ax)
  const cy = Math.cos(ay), sy = Math.sin(ay)
  const cz = Math.cos(az), sz = Math.sin(az)
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
  const R = mat3Mul(Rz, mat3Mul(Ry, Rx))
  const Rp = mat3Vec(R, pivot)
  const t = [0, 1, 2].map((i) => pivot[i] + (Number(translate[i]) || 0) - scale * Rp[i])
  return { scale, R, t }
}

/** Point count of a cloud or the vertex count of a mesh. */
function vertexCount(c) {
  if (!c?.pos) return 0
  if (c.idx) return c.nVerts ?? Math.floor(c.pos.length / 3)
  return c.count ?? Math.floor(c.pos.length / 3)
}

/**
 * Transform a flat cloud or mesh → a NEW object (`{ ...cloud, pos, nrm?, idx? }`).
 * Positions are written as Float64Array. Normals are mapped by the linear part's
 * inverse-transpose (for a similarity that is just R) and renormalised; a zero normal
 * stays zero. Colour / attributes / any other field are carried over BY REFERENCE —
 * they are unchanged by a rigid move; a store that transfers buffers to a worker
 * must copy them first. A mirroring transform (det < 0) reverses a mesh's triangle
 * winding (new `idx`), so face orientation keeps meaning "outward".
 * @param {object} cloud
 * @param {object|number[]} tf any accepted transform form (incl. a general affine)
 */
export function transformCloud(cloud, tf) {
  const { A, t } = affineOf(tf)
  const n = vertexCount(cloud)
  const src = cloud.pos
  const pos = new Float64Array(n * 3)
  const a00 = A[0][0], a01 = A[0][1], a02 = A[0][2], a10 = A[1][0], a11 = A[1][1], a12 = A[1][2]
  const a20 = A[2][0], a21 = A[2][1], a22 = A[2][2], t0 = t[0], t1 = t[1], t2 = t[2]
  for (let i = 0; i < n; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2]
    pos[i * 3] = a00 * x + a01 * y + a02 * z + t0
    pos[i * 3 + 1] = a10 * x + a11 * y + a12 * z + t1
    pos[i * 3 + 2] = a20 * x + a21 * y + a22 * z + t2
  }
  const det = det3(A)
  const out = { ...cloud, pos }
  if (cloud.nrm && cloud.nrm.length >= n * 3) {
    // A⁻ᵀ = cof(A)/det; only the direction matters, so cof(A)·sign(det).
    const C = cof3(A), sg = det < 0 ? -1 : 1
    const nrm = new Float32Array(n * 3), sn = cloud.nrm
    for (let i = 0; i < n; i++) {
      const x = sn[i * 3], y = sn[i * 3 + 1], z = sn[i * 3 + 2]
      const nx = sg * (C[0][0] * x + C[0][1] * y + C[0][2] * z)
      const ny = sg * (C[1][0] * x + C[1][1] * y + C[1][2] * z)
      const nz = sg * (C[2][0] * x + C[2][1] * y + C[2][2] * z)
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (l > 0) { nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l }
    }
    out.nrm = nrm
  }
  if (cloud.idx && det < 0) {
    const idx = new Uint32Array(cloud.idx)
    for (let f = 0; f + 2 < idx.length; f += 3) { const v = idx[f + 1]; idx[f + 1] = idx[f + 2]; idx[f + 2] = v }
    out.idx = idx
  }
  return out
}

// ── Point-pair fit ───────────────────────────────────────────────────────────

const finite3 = (v) => v != null && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])

/**
 * Fit the transform mapping each `src` onto its `dst` (picked point pairs).
 * Similarity via georef.js `fitSimilarity` (Horn), solved in a frame centred on the
 * two weighted centroids. Rigid mode (`scale:false`) keeps Horn's rotation — the
 * least-squares rotation does not depend on the scale (Umeyama) — and re-solves only
 * the translation with scale fixed to 1.
 * @param {{ src:number[], dst:number[], weight?:number }[]} pairs ≥ 3
 * @param {{ scale?: boolean }} [opts]
 * @returns {{ transform:{scale,R,t}, rms:number, residuals:number[], count:number, pivot:number[] }}
 *   residuals = |T(src) − dst| per pair (input order); pivot = the src centroid
 *   (alignmentReport reports the shift there).
 * @throws on < 3 pairs, non-finite coordinates or a degenerate (collinear) set.
 */
export function fitPointPairs(pairs, { scale = true } = {}) {
  const n = Array.isArray(pairs) ? pairs.length : 0
  if (n < 3) throw new Error(`Point-pair alignment needs at least 3 pairs (got ${n}).`)
  pairs.forEach((p, i) => {
    if (!finite3(p?.src) || !finite3(p?.dst)) throw new Error(`Pair ${i + 1} has a missing or non-finite coordinate.`)
  })
  const w = pairs.map((p) => (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1))
  const W = w.reduce((a, b) => a + b, 0)
  const cs = [0, 0, 0], cd = [0, 0, 0]
  pairs.forEach((p, k) => { for (let i = 0; i < 3; i++) { cs[i] += w[k] * p.src[i] / W; cd[i] += w[k] * p.dst[i] / W } })
  const local = pairs.map((p, k) => ({
    src: [p.src[0] - cs[0], p.src[1] - cs[1], p.src[2] - cs[2]],
    dst: [p.dst[0] - cd[0], p.dst[1] - cd[1], p.dst[2] - cd[2]],
    weight: w[k],
  }))
  const fit = fitSimilarity(local)
  if (!fit) {
    throw new Error('The point pairs are degenerate: pick at least 3 points that do not lie on one line, in both clouds.')
  }
  const R = fit.R
  let s = fit.scale, tl = fit.t
  if (!scale) {
    // Rigid: same rotation, scale 1, t = mean(dst') − R·mean(src') (both ≈ 0 here).
    s = 1
    const ms = [0, 0, 0], md = [0, 0, 0]
    local.forEach((p, k) => { for (let i = 0; i < 3; i++) { ms[i] += w[k] * p.src[i] / W; md[i] += w[k] * p.dst[i] / W } })
    const Rms = mat3Vec(R, ms)
    tl = [md[0] - Rms[0], md[1] - Rms[1], md[2] - Rms[2]]
  }
  const residuals = local.map((p) => {
    const q = mat3Vec(R, p.src)
    return Math.hypot(s * q[0] + tl[0] - p.dst[0], s * q[1] + tl[1] - p.dst[1], s * q[2] + tl[2] - p.dst[2])
  })
  const rms = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n)
  // World: p' = s·R·(p − cs) + tl + cd  ⇒  t = tl + cd − s·R·cs.
  const Rcs = mat3Vec(R, cs)
  const t = [0, 1, 2].map((i) => tl[i] + cd[i] - s * Rcs[i])
  return { transform: { scale: s, R: R.map((r) => r.slice()), t }, rms, residuals, count: n, pivot: cs }
}

// ── Horn on typed arrays (ICP point-to-point) ────────────────────────────────

// georef.js `fitSimilarity` is the pair fit's solver, but ICP cannot use it: it
// takes an object per pair and runs an O(n²) collinearity test, which at tens of
// thousands of correspondences per iteration is the whole cost. The closed form is
// the same (Horn's quaternion method); this version accumulates the centroids and
// cross-covariance straight from typed arrays.

// Unit eigenvector of the largest eigenvalue of a symmetric 4×4 (cyclic Jacobi).
function topEigen4(N) {
  const A = Float64Array.from(N)
  const V = new Float64Array(16); V[0] = V[5] = V[10] = V[15] = 1
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0, diag = 0
    for (let i = 0; i < 4; i++) {
      diag += A[i * 5] * A[i * 5]
      for (let j = i + 1; j < 4; j++) off += A[i * 4 + j] * A[i * 4 + j]
    }
    if (off === 0 || off <= 1e-32 * diag) break
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) {
      const apq = A[p * 4 + q]
      if (apq === 0) continue
      const theta = (A[q * 5] - A[p * 5]) / (2 * apq)
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < 4; k++) {
        const akp = A[k * 4 + p], akq = A[k * 4 + q]
        A[k * 4 + p] = c * akp - s * akq; A[k * 4 + q] = s * akp + c * akq
      }
      for (let k = 0; k < 4; k++) {
        const apk = A[p * 4 + k], aqk = A[q * 4 + k]
        A[p * 4 + k] = c * apk - s * aqk; A[q * 4 + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 4; k++) {
        const vkp = V[k * 4 + p], vkq = V[k * 4 + q]
        V[k * 4 + p] = c * vkp - s * vkq; V[k * 4 + q] = s * vkp + c * vkq
      }
    }
  }
  let best = 0
  for (let i = 1; i < 4; i++) if (A[i * 5] > A[best * 5]) best = i
  const v = [V[best], V[4 + best], V[8 + best], V[12 + best]]
  const l = Math.hypot(v[0], v[1], v[2], v[3])
  return l > 0 ? v.map((x) => x / l) : null
}

/**
 * Least-squares b ≈ s·R·a + t over m pairs of Float64Array(3m) (local coordinates).
 * @returns {{scale,R,t}|null}
 */
function hornArrays(a, b, m, withScale) {
  const ca = [0, 0, 0], cb = [0, 0, 0]
  for (let k = 0; k < m; k++) for (let i = 0; i < 3; i++) { ca[i] += a[k * 3 + i]; cb[i] += b[k * 3 + i] }
  for (let i = 0; i < 3; i++) { ca[i] /= m; cb[i] /= m }
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0, va = 0
  for (let k = 0; k < m; k++) {
    const ax = a[k * 3] - ca[0], ay = a[k * 3 + 1] - ca[1], az = a[k * 3 + 2] - ca[2]
    const bx = b[k * 3] - cb[0], by = b[k * 3 + 1] - cb[1], bz = b[k * 3 + 2] - cb[2]
    Sxx += ax * bx; Sxy += ax * by; Sxz += ax * bz
    Syx += ay * bx; Syy += ay * by; Syz += ay * bz
    Szx += az * bx; Szy += az * by; Szz += az * bz
    va += ax * ax + ay * ay + az * az
  }
  if (!(va > 0)) return null
  const q = topEigen4([
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ])
  if (!q) return null
  const [w, x, y, z] = q
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  let s = 1
  if (withScale) {
    // s = Σ b'·(R·a') / Σ|a'|² — the same estimator as fitSimilarity.
    const M = [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]]
    let num = 0
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) num += R[j][i] * M[i][j]
    s = num / va
    if (!(s > 0)) return null
  }
  const Rca = mat3Vec(R, ca)
  return { scale: s, R, t: [cb[0] - s * Rca[0], cb[1] - s * Rca[1], cb[2] - s * Rca[2]] }
}

// ── ICP ──────────────────────────────────────────────────────────────────────

// mulberry32 — small, fast, deterministic.
function prng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// k distinct indices of [0, n) — Floyd's algorithm (O(k) memory, deterministic for
// a seed), returned sorted so the sample walks the source buffer in order.
function sampleIndices(n, k, seed) {
  if (k >= n) {
    const all = new Int32Array(n)
    for (let i = 0; i < n; i++) all[i] = i
    return all
  }
  const rand = prng(seed)
  const set = new Set()
  for (let j = n - k; j < n; j++) {
    const r = Math.floor(rand() * (j + 1))
    set.add(set.has(r) ? j : r)
  }
  return Int32Array.from(set).sort()
}

// Reference points + optional unit normals in the local frame (centred on `c`).
// A mesh contributes its vertices and area-weighted face normals summed per vertex.
function referenceGeometry(reference) {
  const isMesh = !!reference.idx
  const m = vertexCount(reference)
  const src = reference.pos
  let cx = 0, cy = 0, cz = 0, valid = 0
  for (let i = 0; i < m; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    cx += x; cy += y; cz += z; valid++
  }
  if (!valid) return null
  const c = [cx / valid, cy / valid, cz / valid]
  const pos = new Float64Array(m * 3)
  for (let i = 0; i < m; i++) {
    pos[i * 3] = src[i * 3] - c[0]; pos[i * 3 + 1] = src[i * 3 + 1] - c[1]; pos[i * 3 + 2] = src[i * 3 + 2] - c[2]
  }
  let nrm = null
  if (isMesh) {
    const acc = new Float64Array(m * 3), idx = reference.idx
    const tris = Math.min(reference.count ?? Infinity, Math.floor(idx.length / 3))
    for (let f = 0; f < tris; f++) {
      const a = idx[f * 3], b = idx[f * 3 + 1], d = idx[f * 3 + 2]
      if (a >= m || b >= m || d >= m) continue
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
      const vx = pos[d * 3] - pos[a * 3], vy = pos[d * 3 + 1] - pos[a * 3 + 1], vz = pos[d * 3 + 2] - pos[a * 3 + 2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      if (!Number.isFinite(nx + ny + nz)) continue
      for (const v of [a, b, d]) { acc[v * 3] += nx; acc[v * 3 + 1] += ny; acc[v * 3 + 2] += nz }
    }
    nrm = acc
  } else if (reference.nrm && reference.nrm.length >= m * 3) {
    nrm = reference.nrm
  }
  let unitN = null
  if (nrm) {
    unitN = new Float64Array(m * 3)
    for (let i = 0; i < m; i++) {
      const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2]
      const l = Math.sqrt(x * x + y * y + z * z)
      if (l > 0 && Number.isFinite(l)) { unitN[i * 3] = x / l; unitN[i * 3 + 1] = y / l; unitN[i * 3 + 2] = z / l }
    }
  }
  return { c, pos, nrm: unitN, count: m, isMesh }
}

/**
 * Iterative closest point: refine the transform that maps `source` onto `reference`.
 *
 * @param {{count?:number, pos}} source cloud (only positions are read)
 * @param {object} reference cloud ({ pos, nrm? }) or mesh ({ nVerts, pos, idx })
 * @param {object} opts
 * @param {number} opts.maxDistance REQUIRED — correspondences farther apart than this
 *   (in cloud units, after the current transform) are rejected
 * @param {number} [opts.maxIterations=30] solve steps
 * @param {number} [opts.sampleCount=50000] seeded random subsample of the source
 * @param {boolean} [opts.pointToPlane=true] needs reference normals (or a mesh)
 * @param {boolean} [opts.estimateScale=false] 7-DoF similarity instead of rigid —
 *   weakly constrained on near-planar scenes in point-to-plane (scale along a plane
 *   is invisible to a plane distance); prefer point-to-point when scale matters
 * @param {number} [opts.trim=0.9] keep the best fraction of in-range pairs by distance
 * @param {number} [opts.tolerance=1e-6] convergence: the RMS displacement of the
 *   sample between iterations AND the change in rms both below tolerance × the
 *   sample's RMS radius
 * @param {object} [opts.initial] starting transform (similarity), default identity
 * @param {number} [opts.seed=1]
 * @param {(msg:string, level?:string, source?:string)=>void} [onLog]
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {{ transform:{scale,R,t}, rms:number, inlierFraction:number, iterations:number,
 *   converged:boolean, history:{rms:number, inliers:number}[], method:string,
 *   sampleCount:number, pivot:number[] }}
 *   transform maps source → reference and INCLUDES `initial`; rms = RMS Euclidean
 *   distance of the trimmed correspondences at the final transform; inliers /
 *   inlierFraction = sample points with a reference point within maxDistance (before
 *   trimming); history[i] is evaluated at the transform after i solve steps; pivot =
 *   the reference centroid (the local-frame origin).
 * @throws when maxDistance is missing, an input is empty, or too few sample points
 *   lie within maxDistance of the reference at the start.
 */
export function icpAlign(source, reference, opts = {}, onLog, onProgress) {
  const log = (msg, level = 'info') => onLog?.(msg, level, 'Products')
  const {
    maxIterations = 30, maxDistance, sampleCount = 50000, pointToPlane = true,
    estimateScale = false, tolerance = 1e-6, initial = null, seed = 1, trim = 0.9,
  } = opts
  if (!(maxDistance > 0)) throw new Error('ICP needs a positive maxDistance (the correspondence rejection radius).')
  const nSrc = vertexCount(source)
  if (!nSrc) throw new Error('ICP: the source cloud is empty.')
  const ref = vertexCount(reference) ? referenceGeometry(reference) : null
  if (!ref) throw new Error('ICP: the reference is empty.')
  const trimFrac = Math.min(1, Math.max(0.05, Number(trim) || 0.9))
  let usePlane = !!pointToPlane
  if (usePlane && !ref.nrm) {
    usePlane = false
    log('ICP: the reference has no normals — using point-to-point (estimate normals first for point-to-plane)', 'warn')
  }
  const method = usePlane ? 'point-to-plane' : 'point-to-point'
  const t0 = Date.now()
  const index = buildKnnIndex({ count: ref.count, pos: ref.pos })

  // Sample in the local frame; non-finite source points are dropped.
  const pick = sampleIndices(nSrc, Math.max(1, Math.floor(sampleCount)), seed)
  const c = ref.c
  const sp = new Float64Array(pick.length * 3)
  let m = 0
  for (let k = 0; k < pick.length; k++) {
    const i = pick[k] * 3
    const x = source.pos[i] - c[0], y = source.pos[i + 1] - c[1], z = source.pos[i + 2] - c[2]
    if (!Number.isFinite(x + y + z)) continue
    sp[m * 3] = x; sp[m * 3 + 1] = y; sp[m * 3 + 2] = z; m++
  }
  if (!m) throw new Error('ICP: the source has no finite points.')

  // Current transform in the local frame: q = s·R·p + t (p, q relative to c).
  const init = similarityOf(initial, 'initial transform')
  let s = init.scale, R = init.R
  const Rc = mat3Vec(R, c)
  let t = [0, 1, 2].map((i) => s * Rc[i] + init.t[i] - c[i])

  log(`ICP: ${nSrc.toLocaleString()} source pts → sample ${m.toLocaleString()} (seed ${seed}) · ` +
    `reference ${ref.count.toLocaleString()} ${ref.isMesh ? 'mesh vertices' : 'pts'} · ${method} · ` +
    `maxDistance ${maxDistance} · trim ${Math.round(trimFrac * 100)}% · scale ${estimateScale ? 'estimated' : 'fixed'} · ` +
    `≤ ${maxIterations} iterations, tolerance ${tolerance}`)

  const q = new Float64Array(m * 3), prevQ = new Float64Array(m * 3)
  const pairSrc = new Int32Array(m), pairRef = new Int32Array(m), pairD2 = new Float64Array(m)
  const nnI = new Int32Array(1), nnD = new Float64Array(1)
  const maxD2 = maxDistance * maxDistance
  const minPairs = usePlane ? 6 + (estimateScale ? 1 : 0) : 3
  let radius = 0

  // Transform the sample, find correspondences, trim. Returns the pair count kept.
  const evaluate = () => {
    let found = 0
    const R0 = R[0], R1 = R[1], R2 = R[2]
    for (let k = 0; k < m; k++) {
      const x = sp[k * 3], y = sp[k * 3 + 1], z = sp[k * 3 + 2]
      const qx = s * (R0[0] * x + R0[1] * y + R0[2] * z) + t[0]
      const qy = s * (R1[0] * x + R1[1] * y + R1[2] * z) + t[1]
      const qz = s * (R2[0] * x + R2[1] * y + R2[2] * z) + t[2]
      q[k * 3] = qx; q[k * 3 + 1] = qy; q[k * 3 + 2] = qz
      if (knnQuery(index, qx, qy, qz, 1, nnI, nnD, -1, maxD2)) {
        pairSrc[found] = k; pairRef[found] = nnI[0]; pairD2[found] = nnD[0]; found++
      }
    }
    let kept = found
    let cut = Infinity
    if (found && trimFrac < 1) {
      const sorted = pairD2.slice(0, found).sort()
      cut = sorted[Math.max(0, Math.ceil(trimFrac * found) - 1)]
      kept = 0
      for (let j = 0; j < found; j++) {
        if (pairD2[j] <= cut) { pairSrc[kept] = pairSrc[j]; pairRef[kept] = pairRef[j]; pairD2[kept] = pairD2[j]; kept++ }
      }
    }
    let sse = 0
    for (let j = 0; j < kept; j++) sse += pairD2[j]
    return { inliers: found, kept, rms: kept ? Math.sqrt(sse / kept) : NaN }
  }

  // Sample radius (convergence scale) at the initial pose.
  {
    let mx = 0, my = 0, mz = 0
    for (let k = 0; k < m; k++) { mx += sp[k * 3]; my += sp[k * 3 + 1]; mz += sp[k * 3 + 2] }
    mx /= m; my /= m; mz /= m
    let r2 = 0
    for (let k = 0; k < m; k++) r2 += (sp[k * 3] - mx) ** 2 + (sp[k * 3 + 1] - my) ** 2 + (sp[k * 3 + 2] - mz) ** 2
    radius = s * Math.sqrt(r2 / m) || 1
  }
  const tol = tolerance * radius

  const history = []
  let iterations = 0, converged = false
  let ev = evaluate()
  history.push({ rms: ev.rms, inliers: ev.inliers })
  if (ev.kept < minPairs) {
    throw new Error(`ICP: only ${ev.inliers} of ${m} sampled source points lie within maxDistance (${maxDistance}) ` +
      'of the reference — increase maxDistance or start from a closer initial alignment.')
  }
  log(`ICP iter 0: rms ${ev.rms.toPrecision(4)}, ${ev.inliers.toLocaleString()} in range (${(100 * ev.inliers / m).toFixed(1)}%)`, 'debug')

  const H = new Float64Array(49), g = new Float64Array(7), row = new Float64Array(7)
  while (iterations < maxIterations) {
    // ── Solve one step from the kept pairs ──
    let next = null
    if (usePlane) {
      const dim = estimateScale ? 7 : 6
      // Linearise about the correspondence centroid (decouples rotation from
      // translation): q' = cq + e^σ·Rδ·(q − cq) + tδ, Rδ ≈ I + [ω]×.
      let cx = 0, cy = 0, cz = 0
      for (let j = 0; j < ev.kept; j++) { const k = pairSrc[j] * 3; cx += q[k]; cy += q[k + 1]; cz += q[k + 2] }
      cx /= ev.kept; cy /= ev.kept; cz /= ev.kept
      H.fill(0); g.fill(0)
      const N = ref.nrm, P = ref.pos
      for (let j = 0; j < ev.kept; j++) {
        const k = pairSrc[j] * 3, r = pairRef[j] * 3
        const nx = N[r], ny = N[r + 1], nz = N[r + 2]
        if (nx === 0 && ny === 0 && nz === 0) continue
        const ux = q[k] - cx, uy = q[k + 1] - cy, uz = q[k + 2] - cz
        // residual(δ) = (q − p)·n + ω·(u × n) + tδ·n + σ·(u·n)
        row[0] = uy * nz - uz * ny; row[1] = uz * nx - ux * nz; row[2] = ux * ny - uy * nx
        row[3] = nx; row[4] = ny; row[5] = nz
        if (dim === 7) row[6] = ux * nx + uy * ny + uz * nz
        const r0 = (q[k] - P[r]) * nx + (q[k + 1] - P[r + 1]) * ny + (q[k + 2] - P[r + 2]) * nz
        for (let a = 0; a < dim; a++) {
          g[a] += row[a] * r0
          for (let b = a; b < dim; b++) H[a * dim + b] += row[a] * row[b]
        }
      }
      let maxDiag = 0
      for (let a = 0; a < dim; a++) {
        for (let b = 0; b < a; b++) H[a * dim + b] = H[b * dim + a]
        maxDiag = Math.max(maxDiag, H[a * dim + a])
      }
      // Tiny damping: a direction the surface cannot see (sliding along a plane)
      // gets a ~zero step instead of a singular solve.
      for (let a = 0; a < dim; a++) H[a * dim + a] += 1e-12 * maxDiag + 1e-300
      const rhs = new Float64Array(dim)
      for (let a = 0; a < dim; a++) rhs[a] = -g[a]
      const x = solveSmall(H.slice(0, dim * dim), rhs, dim)
      if (x) {
        const Rd = rodrigues(x[0], x[1], x[2])
        const sd = dim === 7 ? Math.exp(x[6]) : 1
        const Rdc = mat3Vec(Rd, [cx, cy, cz])
        const td = [cx - sd * Rdc[0] + x[3], cy - sd * Rdc[1] + x[4], cz - sd * Rdc[2] + x[5]]
        // δ ∘ current: s' = sδ·s, R' = Rδ·R, t' = sδ·Rδ·t + tδ.
        const Rdt = mat3Vec(Rd, t)
        next = { s: sd * s, R: orthonormalize(mat3Mul(Rd, R)), t: [0, 1, 2].map((i) => sd * Rdt[i] + td[i]) }
      }
    } else {
      // Full Horn re-solve from the ORIGINAL sample points to their matches.
      const a = new Float64Array(ev.kept * 3), b = new Float64Array(ev.kept * 3)
      for (let j = 0; j < ev.kept; j++) {
        const k = pairSrc[j] * 3, r = pairRef[j] * 3
        a[j * 3] = sp[k]; a[j * 3 + 1] = sp[k + 1]; a[j * 3 + 2] = sp[k + 2]
        b[j * 3] = ref.pos[r]; b[j * 3 + 1] = ref.pos[r + 1]; b[j * 3 + 2] = ref.pos[r + 2]
      }
      const fit = hornArrays(a, b, ev.kept, estimateScale)
      if (fit) next = { s: fit.scale, R: fit.R, t: fit.t }
    }
    if (!next) {
      log(`ICP: the ${method} step was singular at iteration ${iterations + 1}; stopping`, 'warn')
      break
    }
    s = next.s; R = next.R; t = next.t
    iterations++
    prevQ.set(q)
    const prevRms = ev.rms
    ev = evaluate()
    history.push({ rms: ev.rms, inliers: ev.inliers })
    let disp = 0
    for (let k = 0; k < m * 3; k++) { const d = q[k] - prevQ[k]; disp += d * d }
    disp = Math.sqrt(disp / m)
    log(`ICP iter ${iterations}: rms ${ev.rms.toPrecision(4)}, ${ev.inliers.toLocaleString()} in range, ` +
      `moved ${disp.toPrecision(3)}`, 'debug')
    onProgress?.(iterations / (maxIterations + 1))
    if (ev.kept < minPairs) {
      log(`ICP: only ${ev.kept} correspondences left within maxDistance; stopping`, 'warn')
      break
    }
    if (disp < tol && Math.abs(ev.rms - prevRms) < tol) { converged = true; break }
  }

  // Back to world: p' = s·R·(p − c) + t + c  ⇒  t_world = t + c − s·R·c.
  const Rcw = mat3Vec(R, c)
  const transform = { scale: s, R, t: [0, 1, 2].map((i) => t[i] + c[i] - s * Rcw[i]) }
  const result = {
    transform, rms: ev.rms, inlierFraction: ev.inliers / m, iterations, converged, history,
    method, sampleCount: m, pivot: c.slice(),
  }
  onProgress?.(1)
  log(`ICP: ${converged ? 'converged' : 'stopped'} after ${iterations} iteration${iterations === 1 ? '' : 's'} in ` +
    `${((Date.now() - t0) / 1000).toFixed(1)} s · ${alignmentReport(result).slice(0, 3).join(' · ')}`,
  converged ? 'info' : 'warn')
  return result
}

// ── Report ───────────────────────────────────────────────────────────────────

const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : +v.toPrecision(4)).toString() : '—')

/**
 * Short human-readable summary of an `icpAlign` or `fitPointPairs` result.
 * The shift is reported at the result's `pivot` (the reference centroid for ICP,
 * the source-pair centroid for a pair fit): `t` itself is the move of the CRS
 * origin, which at survey coordinates is kilometres for a fraction of a degree.
 * @param {object} result
 * @param {{ unit?: string }} [opts] unit label for lengths
 * @returns {string[]}
 */
export function alignmentReport(result, { unit = 'units' } = {}) {
  const lines = []
  const tf = result.transform
  const inl = result.inlierFraction != null
    ? ` over ${(100 * result.inlierFraction).toFixed(1)}% of the sample in range`
    : (result.count != null ? ` over ${result.count} pairs` : '')
  lines.push(`RMS ${fmt(result.rms)} ${unit}${inl}`)
  if (tf?.R) {
    lines.push(`rotation ${(rotationAngle(tf.R) * 180 / Math.PI).toFixed(4)}°`)
    let shift
    if (result.pivot) {
      const p = result.pivot, q = applyTransform(tf, p)
      shift = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
    } else shift = tf.t
    lines.push(`shift ${fmt(Math.hypot(shift[0], shift[1], shift[2]))} ${unit} ` +
      `(${shift.map(fmt).join(', ')})${result.pivot ? ' at the centroid' : ''}`)
    lines.push(`scale ${(tf.scale ?? 1).toFixed(6)}`)
  }
  if (result.iterations != null) {
    lines.push(`${result.method ?? 'ICP'}: ${result.converged ? 'converged' : 'not converged'} after ` +
      `${result.iterations} iteration${result.iterations === 1 ? '' : 's'}`)
  }
  if (Array.isArray(result.residuals) && result.residuals.length) {
    let worst = 0
    result.residuals.forEach((r, i) => { if (r > result.residuals[worst]) worst = i })
    lines.push(`largest pair residual ${fmt(result.residuals[worst])} ${unit} (pair ${worst + 1})`)
  }
  return lines
}
