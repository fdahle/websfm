// Calibrated relative pose: the five-point essential-matrix solver (Stewénius,
// Engels & Nistér 2006, action-matrix form) inside a deterministic RANSAC.
//
// Why the SfM init needs it: matching verifies each pair with an UNCALIBRATED
// fundamental matrix, and the init used to turn that F into E = Kbᵀ F Ka. On a
// (near-)planar scene F is not determined — every F in a two-parameter family fits
// points on one plane — so RANSAC returns an arbitrary member and Kᵀ F K is no
// essential matrix at all (σ2/σ1 ≈ 0.6 instead of 1). Its decomposition is a wrong
// pose. Measured on Casa Grande 1978 aerial film (flat desert, nadir), pair 49–50:
// F → E gave a 174–800 px init reprojection median and 12/37 cameras registered,
// while the five-point E on the same matches gives 0.61 px. The calibrated
// five-point problem has no planar degeneracy, which is why COLMAP estimates E
// directly whenever K is known.
//
// All coordinates here are NORMALISED image coordinates ((u − cx)/fx, (v − cy)/fy).
// E is row-major (9 numbers) with x2ᵀ E x1 = 0.

// ── polynomials in (x, y, z), degree ≤ 3, as Float64Array(20) over MONOMIALS ──
// Order: the ten cubics first (eliminated), then the ten monomials of degree ≤ 2,
// which form the quotient-ring basis (10 solutions).
const MONOMIALS = [
  [3, 0, 0], [2, 1, 0], [2, 0, 1], [1, 2, 0], [1, 1, 1], [1, 0, 2], [0, 3, 0], [0, 2, 1], [0, 1, 2], [0, 0, 3],
  [2, 0, 0], [1, 1, 0], [1, 0, 1], [0, 2, 0], [0, 1, 1], [0, 0, 2], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0],
]
const monoKey = (a, b, c) => a * 16 + b * 4 + c
const MONO_INDEX = new Map(MONOMIALS.map((m, i) => [monoKey(...m), i]))
const BASIS = MONOMIALS.slice(10)

function polyMul(p, q) {
  const out = new Float64Array(20)
  for (let i = 0; i < 20; i++) {
    if (p[i] === 0) continue
    const [a, b, c] = MONOMIALS[i]
    for (let j = 0; j < 20; j++) {
      if (q[j] === 0) continue
      const [d, e, f] = MONOMIALS[j]
      const k = MONO_INDEX.get(monoKey(a + d, b + e, c + f))
      if (k === undefined) throw new Error('five-point: degree overflow')
      out[k] += p[i] * q[j]
    }
  }
  return out
}
const polyAdd = (p, q, s = 1) => p.map((v, i) => v + s * q[i])
const polyScale = (p, s) => p.map((v) => v * s)

function polyEval(p, x, y, z) {
  let v = 0
  for (let i = 0; i < 20; i++) if (p[i]) { const [a, b, c] = MONOMIALS[i]; v += p[i] * x ** a * y ** b * z ** c }
  return v
}
function polyGrad(p, x, y, z) {
  let gx = 0, gy = 0, gz = 0
  for (let i = 0; i < 20; i++) {
    if (!p[i]) continue
    const [a, b, c] = MONOMIALS[i]
    if (a) gx += p[i] * a * x ** (a - 1) * y ** b * z ** c
    if (b) gy += p[i] * b * x ** a * y ** (b - 1) * z ** c
    if (c) gz += p[i] * c * x ** a * y ** b * z ** (c - 1)
  }
  return [gx, gy, gz]
}
// Gauss–Newton on the ten cubic constraints: the eigen step gives each root to
// ~1e-4..1e-8; a few steps bring it to machine precision.
function polishRoot(eqs, x, y, z) {
  for (let it = 0; it < 6; it++) {
    const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Jtr = [0, 0, 0]
    let rr = 0
    for (const e of eqs) {
      const r = polyEval(e, x, y, z), g = polyGrad(e, x, y, z)
      rr += r * r
      for (let i = 0; i < 3; i++) { Jtr[i] += g[i] * r; for (let j = 0; j < 3; j++) JtJ[i][j] += g[i] * g[j] }
    }
    if (rr < 1e-30) break
    const d = solve3(JtJ, Jtr)
    if (!d) break
    x -= d[0]; y -= d[1]; z -= d[2]
  }
  return [x, y, z]
}
function solve3(A, b) {
  const [[a, b1, c], [d, e, f], [g, h, i]] = A
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g)
  if (!(Math.abs(det) > 1e-300)) return null
  return [
    (b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ]
}

// ── small dense linear algebra ──
// Null space of the 5×9 epipolar system: the 4 eigenvectors of AᵀA with the smallest
// eigenvalues (Jacobi, symmetric 9×9).
function jacobiEig(Ain) {
  const n = Ain.length
  const A = Ain.map((r) => Float64Array.from(r))
  const V = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r })
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q]
    if (off < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q]
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k]
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const vals = A.map((r, i) => r[i])
  const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b])
  return { values: order.map((i) => vals[i]), vectors: order.map((i) => V.map((r) => r[i])) }
}

// Real eigenvalues of a general real matrix: Hessenberg reduction + Francis
// double-shift QR (after Numerical Recipes' elmhes/hqr). Complex pairs are dropped.
function realEigenvalues(Min) {
  const n = Min.length
  const a = Min.map((r) => Float64Array.from(r))
  // elmhes: Gaussian elimination with pivoting to upper Hessenberg form.
  for (let m = 1; m < n - 1; m++) {
    let x = 0, i = m
    for (let j = m; j < n; j++) if (Math.abs(a[j][m - 1]) > Math.abs(x)) { x = a[j][m - 1]; i = j }
    if (i !== m) {
      for (let j = m - 1; j < n; j++) { const t = a[i][j]; a[i][j] = a[m][j]; a[m][j] = t }
      for (let j = 0; j < n; j++) { const t = a[j][i]; a[j][i] = a[j][m]; a[j][m] = t }
    }
    if (x !== 0) {
      for (i = m + 1; i < n; i++) {
        let y = a[i][m - 1]
        if (y !== 0) {
          y /= x
          a[i][m - 1] = y
          for (let j = m; j < n; j++) a[i][j] -= y * a[m][j]
          for (let j = 0; j < n; j++) a[j][m] += y * a[j][i]
        }
      }
    }
  }
  for (let i = 2; i < n; i++) for (let j = 0; j < i - 1; j++) a[i][j] = 0
  // hqr
  const wr = new Float64Array(n), wi = new Float64Array(n)
  let anorm = 0
  for (let i = 0; i < n; i++) for (let j = Math.max(i - 1, 0); j < n; j++) anorm += Math.abs(a[i][j])
  let nn = n - 1, t = 0
  while (nn >= 0) {
    let its = 0, l
    do {
      for (l = nn; l >= 1; l--) {
        const s = Math.abs(a[l - 1][l - 1]) + Math.abs(a[l][l])
        if (Math.abs(a[l][l - 1]) <= 1e-15 * (s || anorm)) { a[l][l - 1] = 0; break }
      }
      const x = a[nn][nn]
      if (l === nn) { wr[nn] = x + t; wi[nn--] = 0 }
      else {
        const y = a[nn - 1][nn - 1], w = a[nn][nn - 1] * a[nn - 1][nn]
        if (l === nn - 1) {
          const p = 0.5 * (y - x), q = p * p + w, z = Math.sqrt(Math.abs(q))
          const xx = x + t
          if (q >= 0) {
            const zz = p + (p >= 0 ? Math.abs(z) : -Math.abs(z))
            wr[nn - 1] = wr[nn] = xx + zz
            if (zz) wr[nn] = xx - w / zz
            wi[nn - 1] = wi[nn] = 0
          } else {
            wr[nn - 1] = wr[nn] = xx + p
            wi[nn - 1] = -(wi[nn] = z)
          }
          nn -= 2
        } else {
          if (its === 60) throw new Error('five-point: QR did not converge')
          let xs = x, ys = y, ws = w
          if (its === 10 || its === 20) {
            t += x
            for (let i = 0; i <= nn; i++) a[i][i] -= x
            const s = Math.abs(a[nn][nn - 1]) + Math.abs(a[nn - 1][nn - 2])
            xs = ys = 0.75 * s
            ws = -0.4375 * s * s
          }
          ++its
          let m, p, q, r, z
          for (m = nn - 2; m >= l; m--) {
            z = a[m][m]
            r = xs - z
            const s0 = ys - z
            p = (r * s0 - ws) / a[m + 1][m] + a[m][m + 1]
            q = a[m + 1][m + 1] - z - r - s0
            r = a[m + 2][m + 1]
            const s = Math.abs(p) + Math.abs(q) + Math.abs(r)
            p /= s; q /= s; r /= s
            if (m === l) break
            const u = Math.abs(a[m][m - 1]) * (Math.abs(q) + Math.abs(r))
            const v = Math.abs(p) * (Math.abs(a[m - 1][m - 1]) + Math.abs(z) + Math.abs(a[m + 1][m + 1]))
            if (u <= 1e-15 * v) break
          }
          for (let i = m + 2; i <= nn; i++) {
            a[i][i - 2] = 0
            if (i !== m + 2) a[i][i - 3] = 0
          }
          for (let k = m; k <= nn - 1; k++) {
            if (k !== m) {
              p = a[k][k - 1]; q = a[k + 1][k - 1]; r = 0
              if (k !== nn - 1) r = a[k + 2][k - 1]
              const xx = Math.abs(p) + Math.abs(q) + Math.abs(r)
              if (xx !== 0) { p /= xx; q /= xx; r /= xx }
              else continue
              const s = (p >= 0 ? 1 : -1) * Math.sqrt(p * p + q * q + r * r)
              if (s === 0) continue
              a[k][k - 1] = -s * xx
              p += s; const xk = p / s, yk = q / s, zk = r / s; q /= p; r /= p
              for (let j = k; j <= nn; j++) {
                p = a[k][j] + q * a[k + 1][j]
                if (k !== nn - 1) { p += r * a[k + 2][j]; a[k + 2][j] -= p * zk }
                a[k + 1][j] -= p * yk; a[k][j] -= p * xk
              }
              const mmin = nn < k + 3 ? nn : k + 3
              for (let i = l; i <= mmin; i++) {
                p = xk * a[i][k] + yk * a[i][k + 1]
                if (k !== nn - 1) { p += zk * a[i][k + 2]; a[i][k + 2] -= p * r }
                a[i][k + 1] -= p * q; a[i][k] -= p
              }
            } else {
              const s = (p >= 0 ? 1 : -1) * Math.sqrt(p * p + q * q + r * r)
              if (s === 0) continue
              if (l !== m) a[k][k - 1] = -a[k][k - 1]
              p += s; const xk = p / s, yk = q / s, zk = r / s; q /= p; r /= p
              for (let j = k; j <= nn; j++) {
                p = a[k][j] + q * a[k + 1][j]
                if (k !== nn - 1) { p += r * a[k + 2][j]; a[k + 2][j] -= p * zk }
                a[k + 1][j] -= p * yk; a[k][j] -= p * xk
              }
              const mmin = nn < k + 3 ? nn : k + 3
              for (let i = l; i <= mmin; i++) {
                p = xk * a[i][k] + yk * a[i][k + 1]
                if (k !== nn - 1) { p += zk * a[i][k + 2]; a[i][k + 2] -= p * r }
                a[i][k + 1] -= p * q; a[i][k] -= p
              }
            }
          }
        }
      }
    } while (l < nn - 1)
  }
  const out = []
  for (let i = 0; i < n; i++) if (Math.abs(wi[i]) <= 1e-9 * (1 + Math.abs(wr[i]))) out.push(wr[i])
  return out
}

// Right null vector of (M − λI) (10×10): smallest-eigenvalue eigenvector of BᵀB.
function nullVector(M, lambda) {
  const n = M.length
  const B = M.map((r, i) => r.map((v, j) => v - (i === j ? lambda : 0)))
  const BtB = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n)
    for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += B[k][i] * B[k][j]; r[j] = s }
    return r
  })
  return jacobiEig(BtB).vectors[0]
}

/**
 * Essential matrices consistent with five normalised correspondences.
 * x1, x2: arrays of [x, y] (≥ 5; exactly the first five are used).
 * Returns up to 10 row-major 9-arrays (real solutions only).
 */
export function fivePoint(x1, x2) {
  // Epipolar constraint rows: coefficient of E_ij is x2_i · x1_j (homogeneous).
  const A = []
  for (let k = 0; k < 5; k++) {
    const [u1, v1] = x1[k], [u2, v2] = x2[k]
    A.push([u2 * u1, u2 * v1, u2, v2 * u1, v2 * v1, v2, u1, v1, 1])
  }
  const AtA = Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => {
    let s = 0
    for (let k = 0; k < 5; k++) s += A[k][i] * A[k][j]
    return s
  }))
  const ns = jacobiEig(AtA).vectors.slice(0, 4) // X, Y, Z, W
  // E entries as linear polynomials x·X + y·Y + z·Z + W.
  const iX = MONO_INDEX.get(monoKey(1, 0, 0)), iY = MONO_INDEX.get(monoKey(0, 1, 0))
  const iZ = MONO_INDEX.get(monoKey(0, 0, 1)), i1 = MONO_INDEX.get(monoKey(0, 0, 0))
  const E = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => {
    const p = new Float64Array(20)
    p[iX] = ns[0][3 * r + c]; p[iY] = ns[1][3 * r + c]; p[iZ] = ns[2][3 * r + c]; p[i1] = ns[3][3 * r + c]
    return p
  }))
  // Constraints: det(E) = 0 and 2 E Eᵀ E − tr(E Eᵀ) E = 0.
  const eqs = []
  const det = polyAdd(polyAdd(
    polyMul(E[0][0], polyAdd(polyMul(E[1][1], E[2][2]), polyMul(E[1][2], E[2][1]), -1)),
    polyMul(E[0][1], polyAdd(polyMul(E[1][0], E[2][2]), polyMul(E[1][2], E[2][0]), -1)), -1),
    polyMul(E[0][2], polyAdd(polyMul(E[1][0], E[2][1]), polyMul(E[1][1], E[2][0]), -1)))
  eqs.push(det)
  const EEt = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => {
    let p = polyMul(E[r][0], E[c][0])
    p = polyAdd(p, polyMul(E[r][1], E[c][1]))
    return polyAdd(p, polyMul(E[r][2], E[c][2]))
  }))
  const tr = polyAdd(polyAdd(EEt[0][0], EEt[1][1]), EEt[2][2])
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let p = polyMul(EEt[r][0], E[0][c])
      p = polyAdd(p, polyMul(EEt[r][1], E[1][c]))
      p = polyAdd(p, polyMul(EEt[r][2], E[2][c]))
      eqs.push(polyAdd(polyScale(p, 2), polyMul(tr, E[r][c]), -1))
    }
  }
  // Gauss–Jordan on the 10×20 system: each cubic monomial in terms of the basis.
  const M = eqs.map((e) => Float64Array.from(e))
  for (let col = 0; col < 10; col++) {
    let piv = col
    for (let r = col + 1; r < 10; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-14) return []
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col]
    for (let j = col; j < 20; j++) M[col][j] /= d
    for (let r = 0; r < 10; r++) {
      if (r === col || M[r][col] === 0) continue
      const f = M[r][col]
      for (let j = col; j < 20; j++) M[r][j] -= f * M[col][j]
    }
  }
  // Action matrix of multiplication by x on the basis (row i: x·b_i in the basis).
  const act = BASIS.map(([a, b, c]) => {
    const row = new Float64Array(10)
    const k = MONO_INDEX.get(monoKey(a + 1, b, c))
    if (k >= 10) row[k - 10] = 1
    else for (let j = 0; j < 10; j++) row[j] = -M[k][10 + j]
    return row
  })
  const out = []
  const bx = MONO_INDEX.get(monoKey(1, 0, 0)) - 10, by = MONO_INDEX.get(monoKey(0, 1, 0)) - 10
  const bz = MONO_INDEX.get(monoKey(0, 0, 1)) - 10, b1 = MONO_INDEX.get(monoKey(0, 0, 0)) - 10
  let lambdas
  try { lambdas = realEigenvalues(act.map((r) => Array.from(r))) } catch { return [] }
  for (const lam of lambdas) {
    const v = nullVector(act.map((r) => Array.from(r)), lam)
    if (Math.abs(v[b1]) < 1e-12) continue
    const [x, y, z] = polishRoot(eqs, v[bx] / v[b1], v[by] / v[b1], v[bz] / v[b1])
    const e = new Array(9)
    for (let i = 0; i < 9; i++) e[i] = x * ns[0][i] + y * ns[1][i] + z * ns[2][i] + ns[3][i]
    const nrm = Math.hypot(...e)
    if (!(nrm > 0) || !Number.isFinite(nrm)) continue
    out.push(e.map((w) => w / nrm))
  }
  return out
}

/** Squared Sampson distance of one normalised correspondence to E. */
export function sampsonSq(E, p1, p2) {
  const [x1, y1] = p1, [x2, y2] = p2
  const Ex1 = [E[0] * x1 + E[1] * y1 + E[2], E[3] * x1 + E[4] * y1 + E[5], E[6] * x1 + E[7] * y1 + E[8]]
  const Etx2 = [E[0] * x2 + E[3] * y2 + E[6], E[1] * x2 + E[4] * y2 + E[7], E[2] * x2 + E[5] * y2 + E[8]]
  const r = x2 * Ex1[0] + y2 * Ex1[1] + Ex1[2]
  const d = Ex1[0] * Ex1[0] + Ex1[1] * Ex1[1] + Etx2[0] * Etx2[0] + Etx2[1] * Etx2[1]
  return d > 0 ? (r * r) / d : Infinity
}

/**
 * RANSAC over the five-point solver. x1, x2: normalised [x, y] correspondences.
 * `thresh`: Sampson inlier threshold in normalised units (pixels / focal).
 * Deterministic (LCG seeded by the input size) so runs reproduce.
 * Returns { E, inliers (Uint8Array), count, alternatives } or null.
 *
 * `alternatives`: the distinct models (up to sign) that scored within `altFrac` of the
 * best, best first. Over a plane the calibrated problem has TWO exact solutions (the
 * "twin": camera moving along the plane normal instead of across it), and their
 * inlier counts differ by noise — which one RANSAC returns is a coin flip. Casa Grande
 * 1978: one seed took the twin, the whole block registered onto it at 0.75 px, and
 * no similarity could fit the GCPs (9 km). The caller disambiguates (initPair.js);
 * `minIters` keeps the adaptive stop from ending before both twins were sampled.
 */
export function ransacEssential(x1, x2, { thresh = 1e-3, maxIters = 400, minIters = 64, confidence = 0.999, altFrac = 0.9, maxAlternatives = 4 } = {}) {
  const n = Math.min(x1.length, x2.length)
  if (n < 5) return null
  const t2 = thresh * thresh
  let seed = (0x2545f491 ^ n) >>> 0
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  let bestCount = 0, iters = maxIters
  const top = [] // { E, count }, distinct up to sign, best first
  const same = (a, b) => Math.abs(a.reduce((acc, v, i) => acc + v * b[i], 0)) > 0.999
  const note = (E, c) => {
    const j = top.findIndex((t) => same(t.E, E))
    if (j >= 0) { if (c > top[j].count) top[j] = { E, count: c } } else top.push({ E, count: c })
    top.sort((a, b) => b.count - a.count)
    if (top.length > maxAlternatives * 2) top.length = maxAlternatives * 2
  }
  const s1 = new Array(5), s2 = new Array(5)
  for (let it = 0; it < iters; it++) {
    const idx = new Set()
    while (idx.size < 5) idx.add(Math.floor(rnd() * n))
    let k = 0
    for (const i of idx) { s1[k] = x1[i]; s2[k] = x2[i]; k++ }
    for (const E of fivePoint(s1, s2)) {
      let c = 0
      for (let i = 0; i < n; i++) if (sampsonSq(E, x1[i], x2[i]) <= t2) c++
      if (c >= altFrac * bestCount) note(E, c)
      if (c > bestCount) {
        bestCount = c
        const w = c / n
        const need = Math.log(1 - confidence) / Math.log(Math.max(1e-12, 1 - w ** 5))
        // Never stop before minIters: at a 97 % inlier ratio the adaptive bound is ~3
        // samples, and the planar twin's partner may not be among their roots (Casa
        // Grande pair 48–49: only the twin was found, 74° off the true baseline).
        iters = Math.min(maxIters, Math.max(it + 1, minIters, Math.ceil(need)))
      }
    }
  }
  if (!top.length) return null
  const best = top[0].E
  const inliers = new Uint8Array(n)
  for (let i = 0; i < n; i++) inliers[i] = sampsonSq(best, x1[i], x2[i]) <= t2 ? 1 : 0
  const alternatives = top.filter((t) => t.count >= altFrac * bestCount).slice(0, maxAlternatives)
  return { E: best, inliers, count: bestCount, alternatives }
}
