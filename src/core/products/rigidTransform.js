// Rigid and similarity transforms of clouds: the one transform representation,
// manual transforms (a matrix, Euler angles), composition and the point-pair fit. ICP
// is core/products/icp.js. Pure, no Vue/Pinia/OPFS/DOM — plain data in, plain data out.
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
// The small 3×3 helpers, similarityOf and vertexCount are exported for icp.js.

import { fitSimilarity } from './georef.js'

// ── Small linear-algebra helpers (3×3 row-major arrays) ──────────────────────

const I3 = () => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
export const mat3Mul = (A, B) =>
  A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
export const mat3Vec = (A, v) => [
  A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
  A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
  A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
]
const det3 = (A) =>
  A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
  A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
  A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
// Cofactor matrix: cof(A) = det(A)·A⁻ᵀ, the normal transform up to scale.
const cof3 = (A) => [
  [A[1][1] * A[2][2] - A[1][2] * A[2][1], A[1][2] * A[2][0] - A[1][0] * A[2][2], A[1][0] * A[2][1] - A[1][1] * A[2][0]],
  [A[0][2] * A[2][1] - A[0][1] * A[2][2], A[0][0] * A[2][2] - A[0][2] * A[2][0], A[0][1] * A[2][0] - A[0][0] * A[2][1]],
  [A[0][1] * A[1][2] - A[0][2] * A[1][1], A[0][2] * A[1][0] - A[0][0] * A[1][2], A[0][0] * A[1][1] - A[0][1] * A[1][0]],
]

/** Rotation by angle |w| about axis w (Rodrigues) — exactly orthonormal. */
export function rodrigues(wx, wy, wz) {
  const a = Math.hypot(wx, wy, wz)
  if (a < 1e-300) return I3()
  const x = wx / a,
    y = wy / a,
    z = wz / a
  const c = Math.cos(a),
    s = Math.sin(a),
    q = 1 - c
  return [
    [c + x * x * q, x * y * q - z * s, x * z * q + y * s],
    [y * x * q + z * s, c + y * y * q, y * z * q - x * s],
    [z * x * q - y * s, z * y * q + x * s, c + z * z * q],
  ]
}

/** Gram–Schmidt on the rows — keeps an accumulated rotation from drifting. */
export function orthonormalize(R) {
  const r0 = R[0].slice(),
    r1 = R[1].slice()
  let l = Math.hypot(r0[0], r0[1], r0[2])
  r0[0] /= l
  r0[1] /= l
  r0[2] /= l
  const d = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2]
  r1[0] -= d * r0[0]
  r1[1] -= d * r0[1]
  r1[2] -= d * r0[2]
  l = Math.hypot(r1[0], r1[1], r1[2])
  r1[0] /= l
  r1[1] /= l
  r1[2] /= l
  const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]]
  return [r0, r1, r2]
}

/** Rotation angle of R in radians (atan2 form — accurate for tiny angles too). */
export function rotationAngle(R) {
  const tr = R[0][0] + R[1][1] + R[2][2]
  const vx = R[2][1] - R[1][2],
    vy = R[0][2] - R[2][0],
    vz = R[1][0] - R[0][1]
  return Math.atan2(0.5 * Math.hypot(vx, vy, vz), 0.5 * (tr - 1))
}

// Dense solve of a small system (n ≤ 7) by Gaussian elimination with partial
// pivoting. A is a Float64Array(n·n), row-major; both inputs are overwritten.
export function solveSmall(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r
    if (!(Math.abs(A[piv * n + c]) > 0)) return null
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k]
        A[c * n + k] = A[piv * n + k]
        A[piv * n + k] = t
      }
      const t = b[c]
      b[c] = b[piv]
      b[piv] = t
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
export function similarityOf(tf, what = 'transform') {
  if (tf == null) return identityTransform()
  if (tf.R && !tf.linear) return { scale: tf.scale ?? 1, R: tf.R.map((r) => r.slice()), t: (tf.t ?? [0, 0, 0]).slice() }
  const m = Array.isArray(tf) || ArrayBuffer.isView(tf) ? tf : (tf.matrix ?? matrixFromTransform(tf))
  const s = transformFromMatrix(m)
  if (!s.isSimilarity)
    throw new Error(
      `The ${what} must be a rotation + uniform scale + translation; this one shears, scales unevenly or mirrors.`,
    )
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
  const A = [
    [m[0] / w, m[1] / w, m[2] / w],
    [m[4] / w, m[5] / w, m[6] / w],
    [m[8] / w, m[9] / w, m[10] / w],
  ]
  const t = [m[3] / w, m[7] / w, m[11] / w]
  const det = det3(A)
  const norm = Math.max(...A.flat().map(Math.abs))
  if (!(Math.abs(det) > 1e-12 * norm * norm * norm)) {
    throw new Error('The matrix is singular (it flattens space) — not a usable transform.')
  }
  let isSimilarity = false
  let R = null,
    scale = null
  if (det > 0) {
    const s = Math.cbrt(det)
    const Rc = A.map((r) => r.map((v) => v / s))
    let dev = 0
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = Rc[i][0] * Rc[j][0] + Rc[i][1] * Rc[j][1] + Rc[i][2] * Rc[j][2] - (i === j ? 1 : 0)
        dev = Math.max(dev, Math.abs(d))
      }
    if (dev <= tolerance) {
      isSimilarity = true
      R = Rc
      scale = s
    }
  }
  if (requireSimilarity && !isSimilarity) {
    throw new Error(
      det < 0
        ? 'The matrix mirrors space (negative determinant) — not a rotation + scale + translation.'
        : 'The matrix shears or scales unevenly — not a rotation + uniform scale + translation.',
    )
  }
  const matrix = [
    A[0][0],
    A[0][1],
    A[0][2],
    t[0],
    A[1][0],
    A[1][1],
    A[1][2],
    t[1],
    A[2][0],
    A[2][1],
    A[2][2],
    t[2],
    0,
    0,
    0,
    1,
  ]
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
  const simA = a?.R && !a.linear,
    simB = b?.R && !b.linear
  if (simA && simB) {
    const sa = a.scale ?? 1,
      sb = b.scale ?? 1
    const Rtb = mat3Vec(a.R, b.t ?? [0, 0, 0])
    const ta = a.t ?? [0, 0, 0]
    return {
      scale: sa * sb,
      R: mat3Mul(a.R, b.R),
      t: [sa * Rtb[0] + ta[0], sa * Rtb[1] + ta[1], sa * Rtb[2] + ta[2]],
    }
  }
  const fa = affineOf(a),
    fb = affineOf(b)
  const A = mat3Mul(fa.A, fb.A)
  const At = mat3Vec(fa.A, fb.t)
  const t = [At[0] + fa.t[0], At[1] + fa.t[1], At[2] + fa.t[2]]
  return transformFromMatrix([
    A[0][0],
    A[0][1],
    A[0][2],
    t[0],
    A[1][0],
    A[1][1],
    A[1][2],
    t[1],
    A[2][0],
    A[2][1],
    A[2][2],
    t[2],
  ])
}

/**
 * Parse a pasted matrix: 16 numbers (4×4) or 12 (3×4), row-major, separated by any
 * mix of whitespace, commas and semicolons; brackets are ignored.
 * Throws a readable Error on anything else.
 * @param {string} text
 * @param {{ requireSimilarity?: boolean, tolerance?: number }} [opts] see transformFromMatrix
 */
export function parseMatrixText(text, opts = {}) {
  const tokens = String(text ?? '')
    .replace(/[[\]{}()]/g, ' ')
    .split(/[\s,;]+/)
    .filter(Boolean)
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
export function transformFromEuler({
  translate = [0, 0, 0],
  rotateDeg = [0, 0, 0],
  scale = 1,
  pivot = [0, 0, 0],
} = {}) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Scale must be a positive number.')
  const [ax, ay, az] = rotateDeg.map((d) => ((Number(d) || 0) * Math.PI) / 180)
  const cx = Math.cos(ax),
    sx = Math.sin(ax)
  const cy = Math.cos(ay),
    sy = Math.sin(ay)
  const cz = Math.cos(az),
    sz = Math.sin(az)
  const Rx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ]
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ]
  const Rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ]
  const R = mat3Mul(Rz, mat3Mul(Ry, Rx))
  const Rp = mat3Vec(R, pivot)
  const t = [0, 1, 2].map((i) => pivot[i] + (Number(translate[i]) || 0) - scale * Rp[i])
  return { scale, R, t }
}

/** Point count of a cloud or the vertex count of a mesh. */
export function vertexCount(c) {
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
  const a00 = A[0][0],
    a01 = A[0][1],
    a02 = A[0][2],
    a10 = A[1][0],
    a11 = A[1][1],
    a12 = A[1][2]
  const a20 = A[2][0],
    a21 = A[2][1],
    a22 = A[2][2],
    t0 = t[0],
    t1 = t[1],
    t2 = t[2]
  for (let i = 0; i < n; i++) {
    const x = src[i * 3],
      y = src[i * 3 + 1],
      z = src[i * 3 + 2]
    pos[i * 3] = a00 * x + a01 * y + a02 * z + t0
    pos[i * 3 + 1] = a10 * x + a11 * y + a12 * z + t1
    pos[i * 3 + 2] = a20 * x + a21 * y + a22 * z + t2
  }
  const det = det3(A)
  const out = { ...cloud, pos }
  if (cloud.nrm && cloud.nrm.length >= n * 3) {
    // A⁻ᵀ = cof(A)/det; only the direction matters, so cof(A)·sign(det).
    const C = cof3(A),
      sg = det < 0 ? -1 : 1
    const nrm = new Float32Array(n * 3),
      sn = cloud.nrm
    for (let i = 0; i < n; i++) {
      const x = sn[i * 3],
        y = sn[i * 3 + 1],
        z = sn[i * 3 + 2]
      const nx = sg * (C[0][0] * x + C[0][1] * y + C[0][2] * z)
      const ny = sg * (C[1][0] * x + C[1][1] * y + C[1][2] * z)
      const nz = sg * (C[2][0] * x + C[2][1] * y + C[2][2] * z)
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (l > 0) {
        nrm[i * 3] = nx / l
        nrm[i * 3 + 1] = ny / l
        nrm[i * 3 + 2] = nz / l
      }
    }
    out.nrm = nrm
  }
  if (cloud.idx && det < 0) {
    const idx = new Uint32Array(cloud.idx)
    for (let f = 0; f + 2 < idx.length; f += 3) {
      const v = idx[f + 1]
      idx[f + 1] = idx[f + 2]
      idx[f + 2] = v
    }
    out.idx = idx
  }
  return out
}

// ── Point-pair fit ───────────────────────────────────────────────────────────

const finite3 = (v) =>
  v != null && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])

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
  const cs = [0, 0, 0],
    cd = [0, 0, 0]
  pairs.forEach((p, k) => {
    for (let i = 0; i < 3; i++) {
      cs[i] += (w[k] * p.src[i]) / W
      cd[i] += (w[k] * p.dst[i]) / W
    }
  })
  const local = pairs.map((p, k) => ({
    src: [p.src[0] - cs[0], p.src[1] - cs[1], p.src[2] - cs[2]],
    dst: [p.dst[0] - cd[0], p.dst[1] - cd[1], p.dst[2] - cd[2]],
    weight: w[k],
  }))
  const fit = fitSimilarity(local)
  if (!fit) {
    throw new Error(
      'The point pairs are degenerate: pick at least 3 points that do not lie on one line, in both clouds.',
    )
  }
  const R = fit.R
  let s = fit.scale,
    tl = fit.t
  if (!scale) {
    // Rigid: same rotation, scale 1, t = mean(dst') − R·mean(src') (both ≈ 0 here).
    s = 1
    const ms = [0, 0, 0],
      md = [0, 0, 0]
    local.forEach((p, k) => {
      for (let i = 0; i < 3; i++) {
        ms[i] += (w[k] * p.src[i]) / W
        md[i] += (w[k] * p.dst[i]) / W
      }
    })
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
