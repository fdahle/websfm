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
//   pairs: [{ src:[x,y,z] (SfM), dst:[x,y,z] (CRS) }]
// Returns { scale, R (row-major 3×3), t:[x,y,z], rms, count } or null if it can't
// be determined (too few points, or a degenerate/collinear configuration).
export function fitSimilarity(pairs) {
  const n = pairs.length
  if (n < 3) return null

  // Centroids.
  const cs = [0, 0, 0], cd = [0, 0, 0]
  for (const { src, dst } of pairs) {
    cs[0] += src[0]; cs[1] += src[1]; cs[2] += src[2]
    cd[0] += dst[0]; cd[1] += dst[1]; cd[2] += dst[2]
  }
  for (let i = 0; i < 3; i++) { cs[i] /= n; cd[i] /= n }

  // Cross-covariance M[i][j] = Σ src'_i · dst'_j (Horn's S) and Σ|src'|².
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  let srcVar = 0
  const a = [], b = []
  for (const { src, dst } of pairs) {
    const s = sub(src, cs), d = sub(dst, cd)
    a.push(s); b.push(d)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += s[i] * d[j]
    srcVar += dot(s, s)
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
  const R = quatToMatrix(q)

  // Scale s = Σ dst'·(R·src') / Σ|src'|² (least-squares, given R).
  let num = 0
  for (let k = 0; k < n; k++) {
    const Ra = [
      R[0][0] * a[k][0] + R[0][1] * a[k][1] + R[0][2] * a[k][2],
      R[1][0] * a[k][0] + R[1][1] * a[k][1] + R[1][2] * a[k][2],
      R[2][0] * a[k][0] + R[2][1] * a[k][1] + R[2][2] * a[k][2],
    ]
    num += dot(b[k], Ra)
  }
  const scale = num / srcVar
  if (!(scale > 0) || !isFinite(scale)) return null

  // t = centroid_dst − s·R·centroid_src.
  const Rcs = [
    R[0][0] * cs[0] + R[0][1] * cs[1] + R[0][2] * cs[2],
    R[1][0] * cs[0] + R[1][1] * cs[1] + R[1][2] * cs[2],
    R[2][0] * cs[0] + R[2][1] * cs[1] + R[2][2] * cs[2],
  ]
  const t = [cd[0] - scale * Rcs[0], cd[1] - scale * Rcs[1], cd[2] - scale * Rcs[2]]

  // Residual RMS in CRS units.
  let sse = 0
  for (const { src, dst } of pairs) {
    const p = applySimilarity({ scale, R, t }, src)
    sse += (p[0] - dst[0]) ** 2 + (p[1] - dst[1]) ** 2 + (p[2] - dst[2]) ** 2
  }
  return { scale, R, t, rms: Math.sqrt(sse / n), count: n }
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
export function frameFromSimilarity(sim, crs) {
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
  return { ...makeFrame({ origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1], crs, unit: 'm', source: 'georef' }), fromSfm, toSfm, scale, R, t }
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
