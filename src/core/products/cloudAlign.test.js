import { describe, it, expect } from 'vitest'
import {
  transformFromMatrix, matrixFromTransform, composeTransforms, parseMatrixText, transformCloud,
  transformFromEuler, fitPointPairs, icpAlign, alignmentReport, applyTransform, rotationAngle,
  identityTransform,
} from './cloudAlign.js'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// Standard normal (Box–Muller).
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-300)) * Math.cos(2 * Math.PI * r())

function axisAngle(axis, deg) {
  const l = Math.hypot(...axis), [x, y, z] = axis.map((v) => v / l)
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), q = 1 - c
  return [
    [c + x * x * q, x * y * q - z * s, x * z * q + y * s],
    [y * x * q + z * s, c + y * y * q, y * z * q - x * s],
    [z * x * q - y * s, z * y * q + x * s, c + z * z * q],
  ]
}
const matMul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const transpose = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]])

// Rotation (angle) between two rotation matrices, degrees.
const rotErrDeg = (A, B) => rotationAngle(matMul(A, transpose(B))) * 180 / Math.PI

// Rigid move about a centre: p' = R(p − c) + c + d.
function moveAbout(R, c, d) {
  const Rc = [0, 1, 2].map((i) => R[i][0] * c[0] + R[i][1] * c[1] + R[i][2] * c[2])
  return { scale: 1, R, t: [0, 1, 2].map((i) => c[i] - Rc[i] + d[i]) }
}

// Sinusoidal terrain at survey offsets with analytic normals.
const OX = 512345.5, OY = 4123456.25, OZ = 1500
const AMP = 5, LX = 40, LY = 55
const height = (x, y) => AMP * Math.sin(2 * Math.PI * x / LX) * Math.cos(2 * Math.PI * y / LY) + 0.02 * x
function terrain(n, { seed = 1, noise = 0.01, x0 = 0, x1 = 100, y0 = 0, y1 = 100, withNormals = true } = {}) {
  const r = rng(seed)
  const pos = new Float64Array(n * 3), nrm = withNormals ? new Float32Array(n * 3) : null
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * r(), y = y0 + (y1 - y0) * r()
    pos[i * 3] = OX + x; pos[i * 3 + 1] = OY + y; pos[i * 3 + 2] = OZ + height(x, y)
    if (nrm) {
      const gx = AMP * (2 * Math.PI / LX) * Math.cos(2 * Math.PI * x / LX) * Math.cos(2 * Math.PI * y / LY) + 0.02
      const gy = -AMP * (2 * Math.PI / LY) * Math.sin(2 * Math.PI * x / LX) * Math.sin(2 * Math.PI * y / LY)
      const l = Math.hypot(gx, gy, 1)
      nrm[i * 3] = -gx / l; nrm[i * 3 + 1] = -gy / l; nrm[i * 3 + 2] = 1 / l
    }
  }
  return { count: n, pos, nrm, noise, seed }
}
// Independent Gaussian noise on a copy of positions.
function withNoise(cloud, sigma, seed) {
  const r = rng(seed), pos = Float64Array.from(cloud.pos)
  for (let i = 0; i < pos.length; i++) pos[i] += sigma * gauss(r)
  return { ...cloud, pos }
}
const inverseOf = (tf) => {
  const Rt = transpose(tf.R), s = tf.scale ?? 1
  const Rtt = [0, 1, 2].map((i) => Rt[i][0] * tf.t[0] + Rt[i][1] * tf.t[1] + Rt[i][2] * tf.t[2])
  return { scale: 1 / s, R: Rt, t: Rtt.map((v) => -v / s) }
}

describe('transform representation', () => {
  it('matrix ↔ transform round-trips and reports isSimilarity', () => {
    const tf = { scale: 1.3, R: axisAngle([1, 2, 3], 20), t: [5, -3, 2] }
    const m = matrixFromTransform(tf)
    expect(m).toHaveLength(16)
    expect(m.slice(12)).toEqual([0, 0, 0, 1])
    const back = transformFromMatrix(m)
    expect(back.isSimilarity).toBe(true)
    expect(back.scale).toBeCloseTo(1.3, 12)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(back.R[i][j]).toBeCloseTo(tf.R[i][j], 12)
    expect(back.t).toEqual(tf.t)
  })

  it('accepts a general affine but flags it, and can require a similarity', () => {
    const shear = [1, 0.5, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]
    const a = transformFromMatrix(shear)
    expect(a.isSimilarity).toBe(false)
    expect(a.R).toBeNull()
    expect(applyTransform(a, [2, 4, 6])).toEqual([5, 6, 9])
    expect(() => transformFromMatrix(shear, { requireSimilarity: true })).toThrow(/shears or scales unevenly/)
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(transformFromMatrix(mirror).isSimilarity).toBe(false)
    expect(() => transformFromMatrix(mirror, { requireSimilarity: true })).toThrow(/mirrors/)
    expect(() => transformFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1])).toThrow(/perspective/)
    expect(() => transformFromMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/singular/)
  })

  it('composes as "b then a"', () => {
    const a = { scale: 2, R: axisAngle([0, 0, 1], 90), t: [1, 0, 0] }
    const b = { scale: 1, R: axisAngle([1, 0, 0], 30), t: [0, 5, -1] }
    const p = [3, -2, 7]
    const ab = composeTransforms(a, b)
    const want = applyTransform(a, applyTransform(b, p))
    const got = applyTransform(ab, p)
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 10)
    expect(ab.scale).toBeCloseTo(2, 12)
    // General affine path.
    const shear = transformFromMatrix([1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    const as = composeTransforms(a, shear)
    const g2 = applyTransform(as, p), w2 = applyTransform(a, applyTransform(shear, p))
    for (let i = 0; i < 3; i++) expect(g2[i]).toBeCloseTo(w2[i], 10)
    expect(as.isSimilarity).toBe(false)
  })

  it('parses 16 and 12 numbers in any separator mix, with readable errors', () => {
    const m16 = parseMatrixText('1 0 0 10\n0 1 0 20\n0,0,1,30\n[0 0 0 1]')
    expect(m16.isSimilarity).toBe(true)
    expect(m16.t).toEqual([10, 20, 30])
    const m12 = parseMatrixText('0 -1 0 1; 1 0 0 2; 0 0 1 3')
    expect(m12.isSimilarity).toBe(true)
    expect(applyTransform(m12, [1, 0, 0])).toEqual([1, 3, 3])
    expect(() => parseMatrixText('1 2 3')).toThrow('Expected 16 numbers (4×4) or 12 numbers (3×4), found 3.')
    expect(() => parseMatrixText('1 0 0 0 0 1 0 0 0 0 1 abc')).toThrow('Could not read "abc" as a number.')
    expect(() => parseMatrixText('2 0 0 0 0 1 0 0 0 0 1 0', { requireSimilarity: true })).toThrow(/unevenly/)
  })

  it('transformFromEuler: X then Y then Z about fixed axes, about the pivot', () => {
    const z90 = transformFromEuler({ rotateDeg: [0, 0, 90] })
    const p = applyTransform(z90, [1, 0, 0])
    expect(p[0]).toBeCloseTo(0, 12); expect(p[1]).toBeCloseTo(1, 12)
    // X 90 then Z 90: y-axis → z-axis (X) → stays z (Z).
    const xz = transformFromEuler({ rotateDeg: [90, 0, 90] })
    const q = applyTransform(xz, [0, 1, 0])
    expect(q[0]).toBeCloseTo(0, 12); expect(q[1]).toBeCloseTo(0, 12); expect(q[2]).toBeCloseTo(1, 12)
    // x-axis: X leaves it, Z sends it to y.
    const q2 = applyTransform(xz, [1, 0, 0])
    expect(q2[1]).toBeCloseTo(1, 12)
    // Pivot stays put under rotation + scale, then the translation is added.
    const pivot = [OX, OY, OZ]
    const tf = transformFromEuler({ rotateDeg: [10, 20, 30], scale: 2, pivot, translate: [1, 2, 3] })
    const pp = applyTransform(tf, pivot)
    expect(pp[0] - OX).toBeCloseTo(1, 6); expect(pp[1] - OY).toBeCloseTo(2, 6); expect(pp[2] - OZ).toBeCloseTo(3, 6)
    expect(() => transformFromEuler({ scale: 0 })).toThrow(/positive/)
  })

  it('transformCloud: Float64 positions, normals rotated, colour by reference, input untouched', () => {
    const cloud = {
      count: 2, pos: new Float32Array([1, 0, 0, 0, 2, 0]), nrm: new Float32Array([1, 0, 0, 0, 0, 1]),
      col: new Uint8Array([1, 2, 3, 4, 5, 6]), attributes: { intensity: new Uint16Array([7, 8]) }, kind: 'dense',
    }
    const before = Float32Array.from(cloud.pos)
    const tf = { scale: 3, R: axisAngle([0, 0, 1], 90), t: [OX, OY, 0] }
    const out = transformCloud(cloud, tf)
    expect(out.pos).toBeInstanceOf(Float64Array)
    expect(out.pos[0]).toBeCloseTo(OX, 9); expect(out.pos[1]).toBeCloseTo(OY + 3, 9)
    expect(out.nrm[0]).toBeCloseTo(0, 6); expect(out.nrm[1]).toBeCloseTo(1, 6)
    expect(out.nrm[5]).toBeCloseTo(1, 6)
    expect(out.col).toBe(cloud.col)
    expect(out.attributes).toBe(cloud.attributes)
    expect(out.kind).toBe('dense')
    expect(cloud.pos).toEqual(before)
    // General affine: normals via inverse-transpose (a plane z = x sheared stays ⟂).
    const shear = transformFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1, 0]) // z' = z + 2x
    const plane = { count: 1, pos: new Float64Array([0, 0, 0]), nrm: new Float32Array([0, 0, 1]) }
    const sh = transformCloud(plane, shear)
    // Tangent (1,0,0) → (1,0,2); the new normal must be ⟂ to it.
    expect(sh.nrm[0] * 1 + sh.nrm[2] * 2).toBeCloseTo(0, 6)
    expect(sh.nrm[2]).toBeGreaterThan(0)
  })

  it('transformCloud flips mesh winding under a mirror', () => {
    const mesh = { nVerts: 3, count: 1, pos: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), idx: new Uint32Array([0, 1, 2]) }
    const out = transformCloud(mesh, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect([...out.idx]).toEqual([0, 2, 1])
    expect([...mesh.idx]).toEqual([0, 1, 2])
    expect(out.count).toBe(1)
    const rigid = transformCloud(mesh, identityTransform())
    expect(rigid.idx).toBe(mesh.idx)
  })
})

describe('fitPointPairs', () => {
  const truth = { scale: 1.3, R: axisAngle([0.3, -0.5, 1], 20), t: [120.5, -340.25, 18] }
  const r = rng(3)
  const src = Array.from({ length: 10 }, () => [1e6 + 200 * r(), 2e6 + 200 * r(), 300 + 50 * r()])
  const pairs = src.map((p) => ({ src: p, dst: applyTransform(truth, p) }))

  it('recovers a known similarity at survey offsets', () => {
    const fit = fitPointPairs(pairs)
    expect(Math.abs(fit.transform.scale - 1.3)).toBeLessThan(1e-9)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      expect(Math.abs(fit.transform.R[i][j] - truth.R[i][j])).toBeLessThan(1e-9)
    }
    // t is the move of the CRS origin, ~1e6 lever arm: compare the mapped points.
    for (const { src: p, dst } of pairs) {
      const q = applyTransform(fit.transform, p)
      for (let i = 0; i < 3; i++) expect(Math.abs(q[i] - dst[i])).toBeLessThan(1e-6)
    }
    expect(fit.rms).toBeLessThan(1e-6)
    expect(fit.residuals).toHaveLength(10)
    expect(alignmentReport(fit).join('\n')).toMatch(/rotation 20\.0000°/)
  })

  it('rigid mode fixes scale to 1 and keeps the best rotation', () => {
    const rigidTruth = { scale: 1, R: truth.R, t: truth.t }
    const rp = src.map((p) => ({ src: p, dst: applyTransform(rigidTruth, p) }))
    const fit = fitPointPairs(rp, { scale: false })
    expect(fit.transform.scale).toBe(1)
    expect(fit.rms).toBeLessThan(1e-6)
    // On scaled data, rigid mode still returns scale 1 (residuals absorb the scale).
    const fs = fitPointPairs(pairs, { scale: false })
    expect(fs.transform.scale).toBe(1)
    expect(rotErrDeg(fs.transform.R, truth.R)).toBeLessThan(1e-9)
    expect(fs.rms).toBeGreaterThan(1)
  })

  it('throws readable errors on too few / degenerate pairs', () => {
    expect(() => fitPointPairs(pairs.slice(0, 2))).toThrow('at least 3 pairs (got 2)')
    const line = [0, 1, 2, 3].map((k) => ({ src: [k, k, k], dst: [k + 1, k, k] }))
    expect(() => fitPointPairs(line)).toThrow(/degenerate/)
    expect(() => fitPointPairs([...pairs.slice(0, 3), { src: [NaN, 0, 0], dst: [0, 0, 0] }])).toThrow(/Pair 4/)
  })
})

describe('icpAlign', () => {
  const N = 50000, SIGMA = 0.01
  const base = terrain(N, { seed: 11 })
  const reference = withNoise(base, SIGMA, 101)
  const centre = [OX + 50, OY + 50, OZ]
  // truth maps source → reference; source = truth⁻¹(reference-shape + other noise).
  const truth = moveAbout(axisAngle([0.2, -0.3, 1], 3), centre, [0.3, -0.25, 0.3]) // |d| ≈ 0.49
  const sourceNoisy = withNoise(base, SIGMA, 202)
  const source = transformCloud({ count: N, pos: sourceNoisy.pos }, inverseOf(truth))

  const shiftErr = (tf) => {
    const a = applyTransform(tf, centre), b = applyTransform(truth, centre)
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  }

  it('point-to-plane recovers 3° + 0.5 m to the noise level', () => {
    const logs = []
    const res = icpAlign(source, reference, { maxDistance: 5 }, (m, l) => logs.push([m, l]))
    expect(res.method).toBe('point-to-plane')
    expect(res.converged).toBe(true)
    expect(rotErrDeg(res.transform.R, truth.R)).toBeLessThan(0.002)
    expect(shiftErr(res.transform)).toBeLessThan(0.005)
    expect(res.transform.scale).toBe(1)
    // Same xy samples, independent noise: NN distance ≈ σ·√2·√3 at most.
    expect(res.rms).toBeLessThan(3 * SIGMA)
    expect(res.inlierFraction).toBeGreaterThan(0.99)
    expect(res.history[0].rms).toBeGreaterThan(res.rms * 10)
    expect(logs.some(([m]) => /ICP: converged/.test(m))).toBe(true)
  })

  it('point-to-point (reference without normals) also recovers it, and says so', () => {
    const logs = []
    const refNoN = { count: N, pos: reference.pos }
    const res = icpAlign(source, refNoN, { maxDistance: 5, maxIterations: 100 }, (m, l) => logs.push([m, l]))
    expect(res.method).toBe('point-to-point')
    expect(logs.some(([m, l]) => l === 'warn' && /point-to-point/.test(m))).toBe(true)
    expect(rotErrDeg(res.transform.R, truth.R)).toBeLessThan(0.005)
    expect(shiftErr(res.transform)).toBeLessThan(0.01)
    expect(res.rms).toBeLessThan(3 * SIGMA)
  })

  it('estimates scale in point-to-point mode', () => {
    const scaled = { ...truth, scale: 1.002 }
    const t2 = composeTransforms(scaled, identityTransform())
    // Make the similarity scale about the centre as well.
    const sc = applyTransform(t2, centre)
    t2.t = t2.t.map((v, i) => v - (sc[i] - applyTransform(truth, centre)[i]))
    const src2 = transformCloud({ count: N, pos: sourceNoisy.pos }, inverseOf(t2))
    const res = icpAlign(src2, { count: N, pos: reference.pos }, { maxDistance: 5, maxIterations: 100, estimateScale: true })
    expect(Math.abs(res.transform.scale - 1.002)).toBeLessThan(1e-4)
    expect(res.rms).toBeLessThan(3 * SIGMA)
  })

  it('works against a mesh reference (vertex normals from faces)', () => {
    const G = 101
    const pos = new Float64Array(G * G * 3)
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 3
      pos[k] = OX + i; pos[k + 1] = OY + j; pos[k + 2] = OZ + height(i, j)
    }
    const idx = []
    for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
      const a = j * G + i
      idx.push(a, a + 1, a + G + 1, a, a + G + 1, a + G)
    }
    const mesh = { nVerts: G * G, count: idx.length / 3, pos, idx: Uint32Array.from(idx) }
    const res = icpAlign(source, mesh, { maxDistance: 5 })
    expect(res.method).toBe('point-to-plane')
    // Vertices are 1 m apart: point-to-plane against them is limited by facet
    // curvature, not by sampling.
    expect(rotErrDeg(res.transform.R, truth.R)).toBeLessThan(0.005)
    expect(shiftErr(res.transform)).toBeLessThan(0.01)
  })

  it('rejects beyond maxDistance on a partial overlap', () => {
    const refHalf = withNoise(terrain(30000, { seed: 21, x0: 0, x1: 100 }), SIGMA, 5)
    const srcBase = withNoise(terrain(30000, { seed: 22, x0: 50, x1: 150, withNormals: false }), SIGMA, 6)
    const t1 = moveAbout(axisAngle([0, 0, 1], 1), centre, [0.3, 0.2, -0.1])
    const src = transformCloud(srcBase, inverseOf(t1))
    const res = icpAlign(src, refHalf, { maxDistance: 1.5 })
    expect(res.inlierFraction).toBeGreaterThan(0.4)
    expect(res.inlierFraction).toBeLessThan(0.6)
    expect(rotErrDeg(res.transform.R, t1.R)).toBeLessThan(0.01)
    const a = applyTransform(res.transform, centre), b = applyTransform(t1, centre)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.02)
  })

  it('is deterministic for a seed and honours `initial`', () => {
    const opts = { maxDistance: 5, sampleCount: 5000, seed: 7 }
    const a = icpAlign(source, reference, opts)
    const b = icpAlign(source, reference, opts)
    expect(b.transform).toEqual(a.transform)
    expect(b.history).toEqual(a.history)
    const c = icpAlign(source, reference, { ...opts, seed: 8 })
    expect(c.transform).not.toEqual(a.transform)
    expect(rotErrDeg(c.transform.R, truth.R)).toBeLessThan(0.01)
    // Starting at the truth: converges immediately and stays there.
    const d = icpAlign(source, reference, { ...opts, initial: truth })
    expect(d.iterations).toBeLessThan(a.iterations)
    expect(rotErrDeg(d.transform.R, truth.R)).toBeLessThan(0.01)
  })

  it('throws clearly without maxDistance or overlap', () => {
    expect(() => icpAlign(source, reference, {})).toThrow(/maxDistance/)
    const far = transformCloud(source, { scale: 1, R: axisAngle([0, 0, 1], 0), t: [1000, 0, 0] })
    expect(() => icpAlign(far, reference, { maxDistance: 1 })).toThrow(/within maxDistance/)
  })
})
