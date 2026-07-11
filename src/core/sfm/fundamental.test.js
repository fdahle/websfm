import { describe, it, expect } from 'vitest'
import { fitFundamental, sampsonDistPx, sampsonRmsPx, eigSymN } from './fundamental.js'

// Deterministic LCG so the synthetic geometry is reproducible.
function lcg(seed = 42) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// ── Synthetic two-view rig ────────────────────────────────────────────────────
// Camera A at the origin, camera B rotated + translated; F built analytically as
// Kb⁻ᵀ [t]× R Ka⁻¹ for the convention xbᵀ F xa = 0 (Xb = R·Xa + t).
const K = { fx: 1200, fy: 1200, cx: 800, cy: 600 }

function rodrigues(axis, deg) {
  const th = (deg * Math.PI) / 180
  const n = Math.hypot(...axis)
  const [x, y, z] = axis.map((v) => v / n)
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ]
}

function groundTruthF(R, t) {
  const Tx = [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]
  const mul = (A, B) => {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j]
    return C
  }
  const E = mul(Tx, R)
  const Kinv = [[1 / K.fx, 0, -K.cx / K.fx], [0, 1 / K.fy, -K.cy / K.fy], [0, 0, 1]]
  const KinvT = [[1 / K.fx, 0, 0], [0, 1 / K.fy, 0], [-K.cx / K.fx, -K.cy / K.fy, 1]]
  return mul(KinvT, mul(E, Kinv))
}

// Generate n clean correspondences for pose (R, t).
function makePairs(R, t, n, rnd) {
  const ptsA = [], ptsB = []
  while (ptsA.length < n) {
    const X = [(rnd() - 0.5) * 6, (rnd() - 0.5) * 4, 4 + rnd() * 6]
    const Xb = [
      R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0],
      R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1],
      R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2],
    ]
    if (X[2] <= 0.1 || Xb[2] <= 0.1) continue
    const pa = { x: K.fx * (X[0] / X[2]) + K.cx, y: K.fy * (X[1] / X[2]) + K.cy }
    const pb = { x: K.fx * (Xb[0] / Xb[2]) + K.cx, y: K.fy * (Xb[1] / Xb[2]) + K.cy }
    ptsA.push(pa); ptsB.push(pb)
  }
  return { ptsA, ptsB }
}

const normF = (F) => {
  let s = 0
  for (const r of F) for (const v of r) s += v * v
  s = Math.sqrt(s)
  // Sign convention: make the largest-magnitude element positive.
  let big = 0, sign = 1
  for (const r of F) for (const v of r) if (Math.abs(v) > big) { big = Math.abs(v); sign = Math.sign(v) }
  return F.map((r) => r.map((v) => (v / s) * sign))
}

describe('eigSymN', () => {
  it('recovers the spectrum of a diagonal matrix, descending', () => {
    const { values, vectors } = eigSymN([[3, 0, 0], [0, 7, 0], [0, 0, 1]])
    expect(values[0]).toBeCloseTo(7, 10)
    expect(values[1]).toBeCloseTo(3, 10)
    expect(values[2]).toBeCloseTo(1, 10)
    expect(Math.abs(vectors[0][1])).toBeCloseTo(1, 10) // eigenvector of 7 is e2
  })
})

describe('fitFundamental', () => {
  const R = rodrigues([0.1, 1, 0.05], 8)
  const t = [1, 0.15, 0.1]
  const Fgt = groundTruthF(R, t)

  it('fits an F with near-zero Sampson error on clean correspondences', () => {
    const { ptsA, ptsB } = makePairs(R, t, 80, lcg(7))
    const fit = fitFundamental(ptsA, ptsB)
    expect(fit).not.toBeNull()
    expect(fit.rmsPx).toBeLessThan(1e-6)
    expect(sampsonRmsPx(fit.F, ptsA, ptsB)).toBeLessThan(1e-6)
  })

  it('recovers the ground-truth F up to scale', () => {
    const { ptsA, ptsB } = makePairs(R, t, 80, lcg(11))
    const fit = fitFundamental(ptsA, ptsB)
    const a = normF(fit.F), b = normF(Fgt)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      expect(a[i][j]).toBeCloseTo(b[i][j], 6)
    }
  })

  it('survives a contaminated inlier set via trimming', () => {
    const rnd = lcg(23)
    const { ptsA, ptsB } = makePairs(R, t, 100, rnd)
    // 15% gross outliers appended (random pixels — like a few repetitive-structure
    // mismatches that slipped past RANSAC).
    const oA = [...ptsA], oB = [...ptsB]
    for (let i = 0; i < 15; i++) {
      oA.push({ x: rnd() * 1600, y: rnd() * 1200 })
      oB.push({ x: rnd() * 1600, y: rnd() * 1200 })
    }
    const fit = fitFundamental(oA, oB)
    expect(fit).not.toBeNull()
    // Judge on the clean subset only — the outliers should have been trimmed away.
    expect(sampsonRmsPx(fit.F, ptsA, ptsB)).toBeLessThan(0.05)
  })

  it('returns null with fewer than 8 correspondences', () => {
    const { ptsA, ptsB } = makePairs(R, t, 7, lcg(3))
    expect(fitFundamental(ptsA, ptsB)).toBeNull()
  })
})

describe('sampsonDistPx', () => {
  it('is ~0 for a true correspondence and grows with perturbation', () => {
    const R = rodrigues([0, 1, 0], 6)
    const t = [1, 0, 0]
    const Fgt = groundTruthF(R, t)
    const { ptsA, ptsB } = makePairs(R, t, 10, lcg(5))
    expect(sampsonDistPx(Fgt, ptsA[0], ptsB[0])).toBeLessThan(1e-6)
    // Perpendicular-ish perturbation of the B point registers as epipolar error.
    const off = { x: ptsB[0].x, y: ptsB[0].y + 10 }
    expect(sampsonDistPx(Fgt, ptsA[0], off)).toBeGreaterThan(1)
  })
})
