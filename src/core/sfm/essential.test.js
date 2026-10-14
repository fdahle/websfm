import { describe, it, expect } from 'vitest'
import { fivePoint, ransacEssential, sampsonSq } from './essential.js'

let s = 7
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
const rot = (a, b, c) => {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)]
  return [[ca * cb, ca * sb * sc - sa * cc, ca * sb * cc + sa * sc], [sa * cb, sa * sb * sc + ca * cc, sa * sb * cc - ca * sc], [-sb, cb * sc, cb * cc]]
}
const trueE = (R, t) => {
  const S = [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]
  const E = S.map((r) => [0, 1, 2].map((j) => r[0] * R[0][j] + r[1] * R[1][j] + r[2] * R[2][j])).flat()
  const n = Math.hypot(...E)
  return E.map((v) => v / n)
}
// Points with depth spread `relief` around 5 (relief 0 = one plane facing camera A).
function scene(R, t, n, relief) {
  const x1 = [], x2 = []
  for (let i = 0; i < n; i++) {
    const X = [(rnd() - 0.5) * 4, (rnd() - 0.5) * 4, 5 + relief * (rnd() - 0.5)]
    const Y = [0, 1, 2].map((r) => R[r][0] * X[0] + R[r][1] * X[1] + R[r][2] * X[2] + t[r])
    x1.push([X[0] / X[2], X[1] / X[2]]); x2.push([Y[0] / Y[2], Y[1] / Y[2]])
  }
  return { x1, x2 }
}
const dist = (E, Et) => Math.min(Math.hypot(...E.map((v, i) => v - Et[i])), Math.hypot(...E.map((v, i) => v + Et[i])))

describe('fivePoint', () => {
  it('recovers the true essential matrix from five generic correspondences', () => {
    let hit = 0
    for (let k = 0; k < 100; k++) {
      const R = rot((rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3)
      const t = [rnd() - 0.5, rnd() - 0.5, (rnd() - 0.5) * 0.2]
      const { x1, x2 } = scene(R, t, 5, 3)
      const sols = fivePoint(x1, x2)
      for (const E of sols) for (let i = 0; i < 5; i++) expect(sampsonSq(E, x1[i], x2[i])).toBeLessThan(1e-14)
      if (sols.some((E) => dist(E, trueE(R, t)) < 1e-6)) hit++
    }
    expect(hit).toBeGreaterThanOrEqual(99)
  })
})

describe('ransacEssential', () => {
  it('finds the pose of a near-planar nadir pair where Kᵀ F K is degenerate, with outliers', () => {
    // Lateral baseline over flat ground (0.5 % relief): the Casa Grande failure case.
    const R = rot(0.01, -0.005, 0.008), t = [-1, 0.03, 0.002]
    const { x1, x2 } = scene(R, t, 400, 0.025)
    const sigma = 0.5 / 6000 // 0.5 px noise at f = 6000 px
    for (let i = 0; i < x1.length; i++) {
      x2[i][0] += sigma * (rnd() - 0.5) * 2; x2[i][1] += sigma * (rnd() - 0.5) * 2
      if (i % 5 === 0) x2[i] = [(rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8] // 20 % outliers
    }
    const r = ransacEssential(x1, x2, { thresh: 1.5 / 6000 })
    expect(r).not.toBeNull()
    expect(r.count).toBeGreaterThanOrEqual(300)
    expect(dist(r.E, trueE(R, t))).toBeLessThan(0.02)
  })

  it('keeps the planar twin as an alternative so the true pose is always on the table', () => {
    // Exactly planar ground, lateral nadir baseline: two exact solutions (the true one and
    // its twin). Whichever RANSAC ranks first, the true E must be among the alternatives.
    const R = rot(0.004, -0.003, 0.006), t = [-1, 0.02, 0.001]
    const { x1, x2 } = scene(R, t, 300, 0)
    const sigma = 0.3 / 6000
    for (let i = 0; i < x1.length; i++) { x2[i][0] += sigma * (rnd() - 0.5) * 2; x2[i][1] += sigma * (rnd() - 0.5) * 2 }
    const r = ransacEssential(x1, x2, { thresh: 1.5 / 6000, maxIters: 2000 })
    expect(r.alternatives.length).toBeGreaterThanOrEqual(1)
    expect(r.alternatives[0].E).toEqual(r.E)
    expect(Math.min(...r.alternatives.map((a) => dist(a.E, trueE(R, t))))).toBeLessThan(0.02)
  })

  it('is deterministic', () => {
    const R = rot(0.1, 0.05, -0.02), t = [0.8, 0.1, 0.05]
    const { x1, x2 } = scene(R, t, 200, 2)
    const a = ransacEssential(x1, x2, { thresh: 1e-3 }), b = ransacEssential(x1, x2, { thresh: 1e-3 })
    expect(a.count).toBe(b.count)
    expect(a.E).toEqual(b.E)
  })
})
