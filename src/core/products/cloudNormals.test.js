import { describe, it, expect } from 'vitest'
import { estimateNormals, eigenSym3 } from './cloudNormals.js'

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

function cloudOf(n, gen, Type = Float64Array) {
  const pos = new Type(n * 3)
  for (let i = 0; i < n; i++) pos.set(gen(i), i * 3)
  return { count: n, pos }
}

// Every normal finite and unit length (Float32 rounding tolerance).
function expectUnitFinite(nrm) {
  for (let i = 0; i < nrm.length / 3; i++) {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2]
    expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true)
    expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(1e-6)
  }
}

function minDot(nrm, ref) {
  let worst = Infinity
  for (let i = 0; i < nrm.length / 3; i++) {
    const d = nrm[i * 3] * ref[0] + nrm[i * 3 + 1] * ref[1] + nrm[i * 3 + 2] * ref[2]
    if (d < worst) worst = d
  }
  return worst
}

// Fibonacci sphere: near-uniform points on a sphere of radius r about c.
function sphere(n, r = 1, c = [0, 0, 0]) {
  const g = Math.PI * (3 - Math.sqrt(5))
  return cloudOf(n, (i) => {
    const y = 1 - (2 * (i + 0.5)) / n
    const rr = Math.sqrt(1 - y * y)
    return [c[0] + r * rr * Math.cos(g * i), c[1] + r * y, c[2] + r * rr * Math.sin(g * i)]
  })
}

describe('eigenSym3', () => {
  // A = R·diag(λ)·Rᵀ for a random rotation; recover λ and check A·v = λ·v.
  function randomRotation(r) {
    const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5]
    const l = Math.hypot(...q); const [w, x, y, z] = q.map((v) => v / l)
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
  }
  function compose(R, lam) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) A[i][j] += R[i][k] * lam[k] * R[j][k]
    }
    return A
  }

  it('recovers eigenpairs of random symmetric matrices, incl. repeated and zero eigenvalues', () => {
    const r = rng(11)
    const spectra = [[0.1, 0.5, 2], [0, 0, 1], [0, 1, 1], [1, 1, 1], [0, 0, 0], [1e-9, 0.3, 0.7], [-1, 0, 3]]
    for (let trial = 0; trial < 2000; trial++) {
      const lam = trial < spectra.length ? spectra[trial] : [r() * 4 - 1, r() * 4 - 1, r() * 4 - 1]
      const A = compose(randomRotation(r), lam)
      const out = eigenSym3(A[0][0], A[0][1], A[0][2], A[1][1], A[1][2], A[2][2])
      const sorted = [...lam].sort((a, b) => a - b)
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(out[k] - sorted[k])).toBeLessThan(1e-9)
        const v = [out[3 + k * 3], out[4 + k * 3], out[5 + k * 3]]
        expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-12)
        for (let i = 0; i < 3; i++) {
          const Av = A[i][0] * v[0] + A[i][1] * v[1] + A[i][2] * v[2]
          expect(Math.abs(Av - out[k] * v[i])).toBeLessThan(1e-9)
        }
      }
    }
  })
})

describe('estimateNormals', () => {
  it('noisy plane z = 0 with orient up → (0, 0, 1)', () => {
    const r = rng(1)
    const cloud = cloudOf(4000, () => [r() * 10, r() * 10, (r() - 0.5) * 0.01])
    const { nrm, stats } = estimateNormals(cloud, { k: 16, orient: { kind: 'up', up: [0, 0, 1] } })
    expectUnitFinite(nrm)
    expect(minDot(nrm, [0, 0, 1])).toBeGreaterThan(0.98)
    expect(stats.estimated).toBe(4000)
    expect(stats.fallback).toBe(0)
    expect(stats.planarity).toBeGreaterThan(0)
    expect(stats.planarity).toBeLessThan(0.01)
  })

  it('orient up with a downward reference flips every normal', () => {
    const r = rng(2)
    const cloud = cloudOf(500, () => [r() * 5, r() * 5, 0])
    const { nrm, stats } = estimateNormals(cloud, { orient: { kind: 'up', up: [0, 0, -2] } })
    expect(minDot(nrm, [0, 0, -1])).toBeGreaterThan(0.999)
    expect(stats.flipped + stats.estimated).toBeGreaterThan(0)
  })

  it('tilted plane → its normal', () => {
    const r = rng(3)
    // z = 0.5x + 0.2y  ⇒ normal ∝ (−0.5, −0.2, 1).
    const cloud = cloudOf(3000, () => { const x = r() * 8, y = r() * 8; return [x, y, 0.5 * x + 0.2 * y + (r() - 0.5) * 1e-3] })
    const l = Math.hypot(0.5, 0.2, 1)
    const expected = [-0.5 / l, -0.2 / l, 1 / l]
    const { nrm } = estimateNormals(cloud, { k: 12 })
    expectUnitFinite(nrm)
    expect(minDot(nrm, expected)).toBeGreaterThan(0.995)
  })

  it('vertical wall with orient up: ambiguous sign stays finite and horizontal', () => {
    const r = rng(4)
    const cloud = cloudOf(800, () => [r() * 4, 2, r() * 4])
    const { nrm } = estimateNormals(cloud, {})
    expectUnitFinite(nrm)
    for (let i = 0; i < 800; i++) expect(Math.abs(nrm[i * 3 + 1])).toBeGreaterThan(0.999)
  })

  it('sphere with the centre as viewpoint → normals point inward', () => {
    const c = [3, -2, 5]
    const cloud = sphere(3000, 2, c)
    const { nrm, stats } = estimateNormals(cloud, { k: 16, orient: { kind: 'viewpoints', points: new Float64Array(c) } })
    expectUnitFinite(nrm)
    for (let i = 0; i < 3000; i++) {
      const p = [cloud.pos[i * 3] - c[0], cloud.pos[i * 3 + 1] - c[1], cloud.pos[i * 3 + 2] - c[2]]
      const d = (nrm[i * 3] * p[0] + nrm[i * 3 + 1] * p[1] + nrm[i * 3 + 2] * p[2]) / 2
      expect(d).toBeLessThan(-0.99) // inward ≈ −p̂
    }
    expect(stats.planarity).toBeLessThan(0.01)
  })

  it('sphere with far outside viewpoints → outward on the near side (nearest camera wins)', () => {
    const cloud = sphere(3000, 1)
    // Two cameras: one far above (+z), one far below (−z). Each hemisphere is near
    // one of them, so every point should face outward.
    const cams = new Float64Array([0, 0, 100, 0, 0, -100])
    const { nrm } = estimateNormals(cloud, { orient: { kind: 'viewpoints', points: cams } })
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const z = cloud.pos[i * 3 + 2]
      if (Math.abs(z) < 0.3) continue // near the equator the far camera's ray is tangent
      const p = [cloud.pos[i * 3], cloud.pos[i * 3 + 1], z]
      expect(nrm[i * 3] * p[0] + nrm[i * 3 + 1] * p[1] + nrm[i * 3 + 2] * p[2]).toBeGreaterThan(0.99)
      checked++
    }
    expect(checked).toBeGreaterThan(1500)
  })

  it('a single far viewpoint orients the near side outward', () => {
    const cloud = sphere(2000, 1)
    const { nrm } = estimateNormals(cloud, { orient: { kind: 'viewpoints', points: [0, 0, 50] } })
    for (let i = 0; i < 2000; i++) {
      const z = cloud.pos[i * 3 + 2]
      if (z < 0.3) continue
      const p = [cloud.pos[i * 3], cloud.pos[i * 3 + 1], z]
      expect(nrm[i * 3] * p[0] + nrm[i * 3 + 1] * p[1] + nrm[i * 3 + 2] * p[2]).toBeGreaterThan(0.99)
    }
  })

  it('survey-offset coordinates (+2.5e6) give the same normals as at the origin', () => {
    const r = rng(5)
    const pts = []
    for (let i = 0; i < 2000; i++) {
      const x = r() * 20, y = r() * 20
      pts.push([x, y, Math.sin(x * 0.3) + 0.2 * y + (r() - 0.5) * 0.02])
    }
    const O = 2.5e6
    const a = cloudOf(2000, (i) => pts[i])
    const b = cloudOf(2000, (i) => [pts[i][0] + O, pts[i][1] + O, pts[i][2] + 1000])
    const na = estimateNormals(a, { k: 12 }).nrm
    const nb = estimateNormals(b, { k: 12 }).nrm
    let maxDiff = 0
    for (let i = 0; i < na.length; i++) maxDiff = Math.max(maxDiff, Math.abs(na[i] - nb[i]))
    expect(maxDiff).toBeLessThan(1e-4)
  })

  it('collinear points take the perpendicular closest to the reference', () => {
    const cloud = cloudOf(50, (i) => [i * 0.1, i * 0.05, 0])
    const { nrm, stats } = estimateNormals(cloud, { k: 6 })
    expectUnitFinite(nrm)
    expect(stats.fallback).toBe(0)
    expect(minDot(nrm, [0, 0, 1])).toBeGreaterThan(0.999)
    // A sloped line: normal ⟂ line and as close to up as possible.
    const s = cloudOf(30, (i) => [i, 0, i])
    const res = estimateNormals(s, { k: 4 }).nrm
    const e = [-Math.SQRT1_2, 0, Math.SQRT1_2]
    expect(minDot(res, e)).toBeGreaterThan(0.999)
  })

  it('duplicates, n < k and too few neighbours fall back to the reference', () => {
    const dup = cloudOf(10, () => [5, 5, 5])
    const r1 = estimateNormals(dup, { k: 8 })
    expectUnitFinite(r1.nrm)
    expect(r1.stats).toEqual({ estimated: 0, fallback: 10, flipped: 0, planarity: null })
    expect(minDot(r1.nrm, [0, 0, 1])).toBeCloseTo(1, 6)

    const two = cloudOf(2, (i) => [i, 0, 0])
    const r2 = estimateNormals(two, { k: 16 })
    expectUnitFinite(r2.nrm)
    expect(r2.stats.fallback).toBe(2)

    // Fallback with viewpoints takes the direction to the nearest camera.
    const r3 = estimateNormals(two, { orient: { kind: 'viewpoints', points: [0, 10, 0] } })
    expect(r3.nrm[1]).toBeCloseTo(1, 5)

    // Mixed: a plane plus a few duplicates of one point still estimates the plane.
    const r = rng(6)
    const mixed = cloudOf(300, (i) => (i < 20 ? [1, 1, 0] : [r() * 3, r() * 3, 0]))
    const r4 = estimateNormals(mixed, { k: 30 })
    expectUnitFinite(r4.nrm)
    expect(minDot(r4.nrm, [0, 0, 1])).toBeGreaterThan(0.999)
  })

  it('radius limit turns isolated points into fallbacks', () => {
    const r = rng(7)
    const cloud = cloudOf(405, (i) => (i < 400 ? [r(), r(), 0] : [100 + i * 10, 0, 7]))
    const { stats } = estimateNormals(cloud, { k: 8, radius: 0.5 })
    expect(stats.fallback).toBe(5)
    expect(stats.estimated).toBe(400)
  })

  it("'existing' keeps the sign of the cloud's normals, else falls back to up", () => {
    const r = rng(8)
    const cloud = cloudOf(500, () => [r() * 5, r() * 5, 0])
    cloud.nrm = new Float32Array(500 * 3)
    for (let i = 0; i < 500; i++) cloud.nrm[i * 3 + 2] = i % 2 ? -0.7 : 0.7
    const before = cloud.nrm.slice()
    const posBefore = cloud.pos.slice()
    const logs = []
    const { nrm } = estimateNormals(cloud, { orient: { kind: 'existing' } }, (m, l) => logs.push([m, l]))
    for (let i = 0; i < 500; i++) expect(nrm[i * 3 + 2]).toBeCloseTo(i % 2 ? -1 : 1, 5)
    // Inputs untouched.
    expect(cloud.nrm).toEqual(before)
    expect(cloud.pos).toEqual(posBefore)
    expect(logs.length).toBeGreaterThan(0)

    const bare = cloudOf(100, () => [r(), r(), 0])
    const warn = []
    const res = estimateNormals(bare, { orient: { kind: 'existing' } }, (m, l) => warn.push(l))
    expect(warn).toContain('warn')
    expect(minDot(res.nrm, [0, 0, 1])).toBeGreaterThan(0.999)
  })

  it('accepts a Float32 position buffer and reports monotonic progress ending at 1', () => {
    const r = rng(9)
    const cloud = cloudOf(1000, () => [r() * 10, r() * 10, (r() - 0.5) * 0.01], Float32Array)
    const fr = []
    const { nrm } = estimateNormals(cloud, {}, undefined, (f) => fr.push(f))
    expectUnitFinite(nrm)
    expect(fr[fr.length - 1]).toBe(1)
    for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThanOrEqual(fr[i - 1])
  })

  it('empty cloud', () => {
    const { nrm, stats } = estimateNormals({ count: 0, pos: new Float64Array(0) })
    expect(nrm.length).toBe(0)
    expect(stats).toEqual({ estimated: 0, fallback: 0, flipped: 0, planarity: null })
  })

  it('flipped counts sign corrections', () => {
    const r = rng(10)
    const cloud = cloudOf(400, () => [r() * 4, r() * 4, 0])
    const up = estimateNormals(cloud, { orient: { kind: 'up', up: [0, 0, 1] } }).stats
    const down = estimateNormals(cloud, { orient: { kind: 'up', up: [0, 0, -1] } }).stats
    // Whatever sign PCA happens to return, exactly one of the two references flips it.
    expect(up.flipped + down.flipped).toBe(400)
  })

  it.skipIf(!process.env.BENCH)('bench: 1M-point terrain, k = 16', () => {
    const r = rng(12)
    const n = 1_000_000
    const cloud = cloudOf(n, () => {
      const x = r() * 1000, y = r() * 1000
      return [x + 4.5e5, y + 1.3e6, 30 * Math.sin(x / 80) * Math.cos(y / 120) + (r() - 0.5) * 0.05]
    })
    const t0 = performance.now()
    const { nrm, stats } = estimateNormals(cloud, { k: 16 })
    const ms = performance.now() - t0
    console.log(`estimateNormals 1M (k=16): ${(ms / 1000).toFixed(2)} s`, stats)
    expect(nrm.length).toBe(3 * n)
    expect(stats.estimated).toBe(n)
  }, 600_000)
})
