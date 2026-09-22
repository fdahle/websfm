// Georeferencing — fit a 7-parameter similarity (scale + rotation + translation)
// from the arbitrary SfM world frame to a real-world CRS, so DEM/ortho products
// can be emitted in projected coordinates with true scale. Pure, no
// Vue/Pinia/OPFS/DOM.
//
// This is OPTIONAL: DEM/ortho work in the local frame (projection.js) without it.
// When a georeference exists it supplies a CRS-tagged frame with the same
// fromSfm/toSfm contract, so everything downstream is unchanged.
//
// The fit is Horn's closed-form absolute orientation (unit quaternion), which
// handles scale and needs no SVD dependency (matching the crate's dependency-free
// spirit). Correspondences pair an SfM-frame position with its known CRS
// position — camera centres ↔ imported camera poses, or triangulated GCPs ↔ GCP
// coordinates. Both live in the project CRS already (see usePosesStore / useGcpsStore).

import { makeFrame } from './projection.js'

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// Fit similarity dst ≈ s·R·src + t from ≥3 non-degenerate correspondences.
//   pairs: [{ src:[x,y,z] (SfM), dst:[x,y,z] (CRS), weight?:number }]
// Returns { scale, R (row-major 3×3), t:[x,y,z], rms, count } or null if it can't
// be determined (too few points, or a degenerate/collinear configuration).
export function fitSimilarity(pairs) {
  const n = pairs.length
  if (n < 3) return null

  // A 3D similarity needs finite 3D coordinates and at least three
  // non-collinear points in both frames. A straight flight strip can have lots
  // of correspondences and a tiny residual while rotation about the strip is
  // still unconstrained, so point count / total variance alone is not enough.
  if (pairs.some(({ src, dst }) => !finiteVec3(src) || !finiteVec3(dst))) return null
  if (!hasNonCollinearGeometry(pairs.map((p) => p.src))
      || !hasNonCollinearGeometry(pairs.map((p) => p.dst))) return null
  const weights = pairs.map((p) => Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1)
  const weightSum = weights.reduce((sum, w) => sum + w, 0)

  // Centroids.
  const cs = [0, 0, 0], cd = [0, 0, 0]
  for (let k = 0; k < n; k++) {
    const { src, dst } = pairs[k], w = weights[k]
    cs[0] += w * src[0]; cs[1] += w * src[1]; cs[2] += w * src[2]
    cd[0] += w * dst[0]; cd[1] += w * dst[1]; cd[2] += w * dst[2]
  }
  for (let i = 0; i < 3; i++) { cs[i] /= weightSum; cd[i] /= weightSum }

  // Cross-covariance M[i][j] = Σ src'_i · dst'_j (Horn's S) and Σ|src'|².
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  let srcVar = 0
  const a = [], b = []
  for (let k = 0; k < n; k++) {
    const { src, dst } = pairs[k], w = weights[k]
    const s = sub(src, cs), d = sub(dst, cd)
    a.push(s); b.push(d)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += w * s[i] * d[j]
    srcVar += w * dot(s, s)
  }
  if (srcVar < 1e-20) return null

  // Horn's symmetric 4×4 N from M; its top eigenvector is the rotation quaternion.
  const Sxx = M[0][0], Sxy = M[0][1], Sxz = M[0][2]
  const Syx = M[1][0], Syy = M[1][1], Syz = M[1][2]
  const Szx = M[2][0], Szy = M[2][1], Szz = M[2][2]
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]
  const q = topEigenvector(N)
  if (!q) return null
  let R = quatToMatrix(q)

  // Scale s = Σ dst'·(R·src') / Σ|src'|² (least-squares, given R).
  let num = 0
  for (let k = 0; k < n; k++) {
    const Ra = [
      R[0][0] * a[k][0] + R[0][1] * a[k][1] + R[0][2] * a[k][2],
      R[1][0] * a[k][0] + R[1][1] * a[k][1] + R[1][2] * a[k][2],
      R[2][0] * a[k][0] + R[2][1] * a[k][1] + R[2][2] * a[k][2],
    ]
    num += weights[k] * dot(b[k], Ra)
  }
  let scale = num / srcVar
  if (!(scale > 0) || !isFinite(scale)) return null

  // t = centroid_dst − s·R·centroid_src.
  const Rcs = [
    R[0][0] * cs[0] + R[0][1] * cs[1] + R[0][2] * cs[2],
    R[1][0] * cs[0] + R[1][1] * cs[1] + R[1][2] * cs[2],
    R[2][0] * cs[0] + R[2][1] * cs[1] + R[2][2] * cs[2],
  ]
  let t = [cd[0] - scale * Rcs[0], cd[1] - scale * Rcs[1], cd[2] - scale * Rcs[2]]

  // Horn supports one scalar weight per correspondence. When callers provide a
  // full precision matrix, use Horn only as the stable closed-form seed and
  // refine all seven similarity parameters under the anisotropic objective.
  if (pairs.some((p) => validM3(p.precision))) {
    const refined = refineAnisotropicSimilarity(pairs, { scale, R, t })
    if (refined) ({ scale, R, t } = refined)
  }

  // Residual RMS in CRS units.
  let sse = 0
  for (let k = 0; k < n; k++) {
    const { src, dst } = pairs[k]
    const p = applySimilarity({ scale, R, t }, src)
    sse += weights[k] * ((p[0] - dst[0]) ** 2 + (p[1] - dst[1]) ** 2 + (p[2] - dst[2]) ** 2)
  }
  return { scale, R, t, rms: Math.sqrt(sse / weightSum), count: n }
}

const validM3 = (m) => Array.isArray(m) && m.length === 3
  && m.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))

function solveLinear(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (!(Math.abs(M[piv][c]) > 1e-20)) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n]
    for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k]
    x[r] = v / M[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

const mul3 = (A, B) => A.map((row) => B[0].map((_, j) =>
  row.reduce((sum, value, k) => sum + value * B[k][j], 0)))
const skew3 = ([x,y,z]) => [[0,-z,y],[z,0,-x],[-y,x,0]]
const so3 = (w) => {
  const a = Math.hypot(...w)
  if (a < 1e-12) {
    const K = skew3(w)
    return [[1+K[0][0],K[0][1],K[0][2]],[K[1][0],1+K[1][1],K[1][2]],[K[2][0],K[2][1],1+K[2][2]]]
  }
  const u = w.map((v) => v/a), K = skew3(u), c=Math.cos(a), s=Math.sin(a), q=1-c
  return [
    [c+u[0]*u[0]*q, u[0]*u[1]*q-u[2]*s, u[0]*u[2]*q+u[1]*s],
    [u[1]*u[0]*q+u[2]*s, c+u[1]*u[1]*q, u[1]*u[2]*q-u[0]*s],
    [u[2]*u[0]*q-u[1]*s, u[2]*u[1]*q+u[0]*s, c+u[2]*u[2]*q],
  ]
}

function refineAnisotropicSimilarity(pairs, seed) {
  let state = { scale: seed.scale, R: seed.R.map((r) => r.slice()), t: seed.t.slice() }
  const precisionOf = (p) => validM3(p.precision) ? p.precision
    : [[p.weight ?? 1,0,0],[0,p.weight ?? 1,0],[0,0,p.weight ?? 1]]
  const evaluate = (s) => pairs.reduce((sum, pair) => {
    const r = sub(applySimilarity(s, pair.src), pair.dst), P = precisionOf(pair)
    const pr = P.map((row) => dot(row, r))
    return sum + dot(r, pr)
  }, 0)
  let cost = evaluate(state)
  for (let iter = 0; iter < 15; iter++) {
    const H = Array.from({length:7}, () => Array(7).fill(0)), g = Array(7).fill(0)
    for (const pair of pairs) {
      const v = matVec3(state.R, pair.src), sv = v.map((x) => state.scale*x)
      const pred = sv.map((x,i) => x + state.t[i]), r = sub(pred, pair.dst), P = precisionOf(pair)
      const S = skew3(sv)
      const J = Array.from({length:3}, (_, row) => [
        -S[row][0], -S[row][1], -S[row][2], sv[row],
        row === 0 ? 1 : 0, row === 1 ? 1 : 0, row === 2 ? 1 : 0,
      ])
      for (let a=0;a<7;a++) for (let axis=0;axis<3;axis++) {
        const pir = P[axis][0]*r[0]+P[axis][1]*r[1]+P[axis][2]*r[2]
        g[a] += J[axis][a]*pir
        for (let b=0;b<7;b++) for (let k=0;k<3;k++) H[a][b] += J[axis][a]*P[axis][k]*J[k][b]
      }
    }
    for (let i=0;i<7;i++) H[i][i] += 1e-10 * Math.max(1, H[i][i])
    const step = solveLinear(H, g.map((v) => -v))
    if (!step) break
    const candidate = {
      R: mul3(so3(step.slice(0,3)), state.R),
      scale: state.scale * Math.exp(step[3]),
      t: state.t.map((v,i) => v + step[4+i]),
    }
    const next = evaluate(candidate)
    if (!(next < cost)) break
    state = candidate; cost = next
    if (Math.hypot(...step) < 1e-10) break
  }
  return state
}

const matVec3 = (m, v) => m.map((row) => dot(row, v))

const finiteVec3 = (v) => Array.isArray(v) && v.length >= 3
  && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])

// Translation-invariant collinearity test. Compare the largest squared cross
// product with the squared cloud energy, making the threshold scale-independent.
function hasNonCollinearGeometry(points) {
  const c = [0, 0, 0]
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2] }
  c[0] /= points.length; c[1] /= points.length; c[2] /= points.length
  const centred = points.map((p) => sub(p, c))
  const energy = centred.reduce((sum, p) => sum + dot(p, p), 0)
  if (!(energy > 1e-20)) return false
  let maxCross2 = 0
  for (let i = 0; i < centred.length; i++) for (let j = i + 1; j < centred.length; j++) {
    const a = centred[i], b = centred[j]
    const cx = a[1] * b[2] - a[2] * b[1]
    const cy = a[2] * b[0] - a[0] * b[2]
    const cz = a[0] * b[1] - a[1] * b[0]
    maxCross2 = Math.max(maxCross2, cx * cx + cy * cy + cz * cz)
  }
  return maxCross2 > energy * energy * 1e-12
}

// Apply dst = s·R·src + t.
export function applySimilarity({ scale, R, t }, p) {
  return [
    scale * (R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2]) + t[0],
    scale * (R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2]) + t[1],
    scale * (R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2]) + t[2],
  ]
}

// Wrap a fitted similarity as a frame (fromSfm = apply, toSfm = inverse), so
// DEM/ortho consume it exactly like a local frame. `crs` tags the target.
export function frameFromSimilarity(sim, crs, { unit = 'm', metresPerUnit = 1 } = {}) {
  const { scale, R, t } = sim
  const fromSfm = (p) => applySimilarity(sim, Array.isArray(p) ? p : [p.x, p.y, p.z])
  // Inverse: src = Rᵀ·(dst − t)/s.
  const toSfm = (c) => {
    const d = [(c[0] - t[0]) / scale, (c[1] - t[1]) / scale, (c[2] - t[2]) / scale]
    return [
      R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2],
      R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2],
      R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2],
    ]
  }
  return { ...makeFrame({ origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1], crs, unit, source: 'georef' }), fromSfm, toSfm, scale, R, t, metresPerUnit }
}

// ── linear-algebra helpers (dependency-free) ─────────────────────────────────

// Unit eigenvector of the largest eigenvalue of a symmetric matrix, via Jacobi
// rotation to diagonalise. Works for the 4×4 quaternion matrix here.
function topEigenvector(A0) {
  const n = A0.length
  const A = A0.map((r) => r.slice())
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    // Largest off-diagonal magnitude.
    let p = 0, q = 1, off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (Math.abs(A[i][j]) > off) { off = Math.abs(A[i][j]); p = i; q = j }
    }
    if (off < 1e-14) break
    const app = A[p][p], aqq = A[q][q], apq = A[p][q]
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app)
    const c = Math.cos(phi), s = Math.sin(phi)
    for (let k = 0; k < n; k++) {
      const akp = A[k][p], akq = A[k][q]
      A[k][p] = c * akp - s * akq
      A[k][q] = s * akp + c * akq
    }
    for (let k = 0; k < n; k++) {
      const apk = A[p][k], aqk = A[q][k]
      A[p][k] = c * apk - s * aqk
      A[q][k] = s * apk + c * aqk
    }
    for (let k = 0; k < n; k++) {
      const vkp = V[k][p], vkq = V[k][q]
      V[k][p] = c * vkp - s * vkq
      V[k][q] = s * vkp + c * vkq
    }
  }
  // Column of V for the largest diagonal (eigenvalue).
  let best = 0
  for (let i = 1; i < n; i++) if (A[i][i] > A[best][best]) best = i
  const v = V.map((row) => row[best])
  const len = Math.hypot(...v)
  return len > 1e-12 ? v.map((x) => x / len) : null
}

// Unit quaternion [w,x,y,z] → row-major 3×3 rotation.
function quatToMatrix([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}
