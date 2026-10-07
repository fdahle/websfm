// Pure fundamental-matrix estimation (normalized 8-point + trimmed re-fit).
//
// Why this exists: pairwise F is fitted during MATCHING, on keypoints in raw
// (distorted / scan) space. When a calibrated Brown model moves the keypoints at
// SfM ingest (undistortPixel), every consumer of that stale F — the init pair's essential decomposition — keeps
// operating on distorted-space geometry. For a mild lens that is a rounding error;
// for a wide-angle (k1 ≈ −0.14 ⇒ tens of px mid-field) it systematically bends the
// relative rotations. sfm.js
// therefore re-fits F per pair on the undistorted coordinates before anything
// reads it. The stored matches are already RANSAC inliers, so no re-RANSAC is
// needed — a least-squares 8-point with a couple of trim rounds (drop Sampson
// outliers, re-fit) is both cheap and stable.
//
// Convention: F satisfies xbᵀ · F · xa = 0 with xa/xb homogeneous PIXEL coords of
// image A / image B — the same convention fundamentalToEssential (E = Kbᵀ F Ka)
// and the matching worker use. F is returned as a row-major 3×3 nested array.

// ── Symmetric Jacobi eigensolver (n×n) ───────────────────────────────────────
// Classic cyclic Jacobi. n is 9 (AᵀA of the 8-point design) or 3 (FᵀF for the
// rank-2 projection) — tiny, so no pivoting sophistication needed. Returns
// { values, vectors } with vectors[i] the eigenvector (as an array) for values[i],
// sorted descending.
export function eigSymN(Ain) {
  const n = Ain.length
  const A = Ain.map((r) => r.slice())
  const V = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q]
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
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
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a])
  return {
    values: order.map((i) => A[i][i]),
    vectors: order.map((i) => V.map((row) => row[i])),
  }
}

// Hartley normalization: translate centroid to origin, scale mean distance to √2.
// Returns { T } (3×3) and the transformed points.
function normalizePoints(pts) {
  let mx = 0, my = 0
  for (const p of pts) { mx += p.x; my += p.y }
  mx /= pts.length; my /= pts.length
  let dist = 0
  for (const p of pts) dist += Math.hypot(p.x - mx, p.y - my)
  dist /= pts.length
  const s = dist > 1e-12 ? Math.SQRT2 / dist : 1
  return {
    T: [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]],
    pts: pts.map((p) => ({ x: s * (p.x - mx), y: s * (p.y - my) })),
  }
}

const mul3 = (A, B) => {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0
    for (let k = 0; k < 3; k++) v += A[i][k] * B[k][j]
    C[i][j] = v
  }
  return C
}
const t3 = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]]

// Project a 3×3 matrix to the nearest rank-2 matrix (zero the smallest singular
// value) via SVD built from the Jacobi eigen decomposition of FᵀF.
function rank2(F) {
  const FtF = mul3(t3(F), F)
  const { values, vectors } = eigSymN(FtF)
  const sv = values.map((v) => Math.sqrt(Math.max(0, v)))
  // U columns: uᵢ = F·vᵢ / σᵢ (only the two we keep).
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 2; i++) {
    if (sv[i] < 1e-14) continue
    const v = vectors[i]
    const u = [
      F[0][0] * v[0] + F[0][1] * v[1] + F[0][2] * v[2],
      F[1][0] * v[0] + F[1][1] * v[1] + F[1][2] * v[2],
      F[2][0] * v[0] + F[2][1] * v[1] + F[2][2] * v[2],
    ].map((x) => x / sv[i])
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r][c] += sv[i] * u[r] * v[c]
  }
  return out
}

// Sampson distance (px) of one correspondence under F (first-order geometric error).
export function sampsonDistPx(F, pa, pb) {
  const Fa = [
    F[0][0] * pa.x + F[0][1] * pa.y + F[0][2],
    F[1][0] * pa.x + F[1][1] * pa.y + F[1][2],
    F[2][0] * pa.x + F[2][1] * pa.y + F[2][2],
  ]
  const Ftb = [
    F[0][0] * pb.x + F[1][0] * pb.y + F[2][0],
    F[0][1] * pb.x + F[1][1] * pb.y + F[2][1],
  ]
  const err = pb.x * Fa[0] + pb.y * Fa[1] + Fa[2]
  const denom = Fa[0] * Fa[0] + Fa[1] * Fa[1] + Ftb[0] * Ftb[0] + Ftb[1] * Ftb[1]
  if (denom < 1e-20) return Infinity
  return Math.abs(err) / Math.sqrt(denom)
}

// RMS Sampson distance (px) over a correspondence set.
export function sampsonRmsPx(F, ptsA, ptsB) {
  const n = Math.min(ptsA.length, ptsB.length)
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const d = sampsonDistPx(F, ptsA[i], ptsB[i])
    s += Number.isFinite(d) ? d * d : 0
  }
  return Math.sqrt(s / n)
}

// Least-squares normalized 8-point fit on one correspondence set (no trimming).
function eightPoint(ptsA, ptsB) {
  const na = normalizePoints(ptsA)
  const nb = normalizePoints(ptsB)
  // AᵀA accumulated directly (9×9) — rows never materialised.
  const M = Array.from({ length: 9 }, () => new Array(9).fill(0))
  for (let i = 0; i < ptsA.length; i++) {
    const a = na.pts[i], b = nb.pts[i]
    const row = [b.x * a.x, b.x * a.y, b.x, b.y * a.x, b.y * a.y, b.y, a.x, a.y, 1]
    for (let r = 0; r < 9; r++) for (let c = r; c < 9; c++) M[r][c] += row[r] * row[c]
  }
  for (let r = 0; r < 9; r++) for (let c = 0; c < r; c++) M[r][c] = M[c][r]
  const { vectors } = eigSymN(M)
  const f = vectors[8] // smallest eigenvalue → least-squares null vector
  const Fn = rank2([[f[0], f[1], f[2]], [f[3], f[4], f[5]], [f[6], f[7], f[8]]])
  // Denormalize: F = Tbᵀ · Fn · Ta.
  return mul3(t3(nb.T), mul3(Fn, na.T))
}

// Median Sampson distance of a model over a correspondence set.
function medianSampson(F, ptsA, ptsB) {
  const d = ptsA.map((p, i) => sampsonDistPx(F, p, ptsB[i])).sort((x, y) => x - y)
  return d[d.length >> 1]
}

// Fit F to an (assumed mostly-inlier) correspondence set. A plain least-squares
// 8-point is hijacked by even a few gross outliers (squared error gives them
// enormous leverage), and outliers ARE possible here: matches accepted under
// distorted-space RANSAC can turn grossly wrong once the keypoints are
// undistorted. So: seed with a least-median-of-squares search over a handful of
// small random subsets (deterministic LCG — pure function, reproducible runs),
// then up to `trimRounds` rounds of dropping Sampson outliers (> max(3×median,
// minTrimPx)) and least-squares re-fitting on the survivors. Returns
// { F, rmsPx, used } or null when fewer than 8 usable correspondences remain.
export function fitFundamental(ptsA, ptsB, opts = {}) {
  const trimRounds = opts.trimRounds ?? 3
  const minTrimPx = opts.minTrimPx ?? 1
  const lmedsTrials = opts.lmedsTrials ?? 24
  const all = []
  for (let i = 0; i < Math.min(ptsA.length, ptsB.length); i++) {
    if (ptsA[i] && ptsB[i]) all.push(i)
  }
  if (all.length < 8) return null
  const A = all.map((i) => ptsA[i])
  const B = all.map((i) => ptsB[i])

  // LMedS seed: best-median model over small random subsets. Only worthwhile
  // when there are enough points that a subset differs from the full set.
  let F = eightPoint(A, B)
  if (A.length >= 16) {
    let bestMed = medianSampson(F, A, B)
    let seed = (0x9e3779b9 ^ A.length) >>> 0
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let trial = 0; trial < lmedsTrials; trial++) {
      const idx = new Set()
      while (idx.size < 9) idx.add(Math.floor(rnd() * A.length))
      const sel = [...idx]
      const Ft = eightPoint(sel.map((i) => A[i]), sel.map((i) => B[i]))
      const med = medianSampson(Ft, A, B)
      if (med < bestMed) { bestMed = med; F = Ft }
    }
  }

  // Trim-and-refit against the (robust) seed.
  let ia = A, ib = B
  for (let round = 0; round < trimRounds; round++) {
    const d = ia.map((p, i) => sampsonDistPx(F, p, ib[i]))
    const sorted = [...d].sort((x, y) => x - y)
    const thresh = Math.max(minTrimPx, 3 * sorted[sorted.length >> 1])
    const keepA = [], keepB = []
    for (let i = 0; i < ia.length; i++) {
      if (d[i] <= thresh) { keepA.push(ia[i]); keepB.push(ib[i]) }
    }
    if (keepA.length < 8) break
    const changed = keepA.length !== ia.length
    ia = keepA; ib = keepB
    F = eightPoint(ia, ib)
    if (!changed) break
  }
  return { F, rmsPx: sampsonRmsPx(F, ia, ib), used: ia.length }
}
