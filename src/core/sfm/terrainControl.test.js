import { describe, expect, it } from 'vitest'
import { terrainInitial, terrainCandidates, terrainPasses, median } from './terrainControl.js'
import { icpAlign, applyTransform } from '../products/cloudAlign.js'

describe('terrainInitial', () => {
  it('maps the frame through the prior exactly as the pixel chain does', () => {
    const ortho = { originX: -2.97, originY: 3.34, gsd: 0.0025 }
    const geo = { originX: -2412253, originY: 1288265, scaleX: 4, scaleY: -4 }
    const th = (199 * Math.PI) / 180,
      s = 2.1
    const prior = { a: s * Math.cos(th), b: s * Math.sin(th), tx: 3000, ty: 4200 }
    const tf = terrainInitial(prior, ortho, geo)
    for (const [x, y] of [
      [0, 0],
      [1.3, -2.2],
      [-2.5, 3],
    ]) {
      const u = (x - ortho.originX) / ortho.gsd,
        v = (ortho.originY - y) / ortho.gsd
      const c = prior.a * u - prior.b * v + prior.tx,
        r = prior.b * u + prior.a * v + prior.ty
      const [X, Y, Z] = applyTransform(tf, [x, y, 0.4])
      expect(X).toBeCloseTo(geo.originX + c * geo.scaleX, 6)
      expect(Y).toBeCloseTo(geo.originY + r * geo.scaleY, 6)
      expect(Z).toBeCloseTo(0.4 * tf.scale, 6)
    }
    // A proper rotation about the vertical: metres per frame unit = s · 4 / 0.0025.
    expect(tf.scale).toBeCloseTo((s * 4) / 0.0025, 6)
    expect(tf.R[0][0] * tf.R[1][1] - tf.R[0][1] * tf.R[1][0]).toBeCloseTo(1, 9)
  })
})

describe('terrainCandidates', () => {
  const item = (i, residual, obs = 3) => ({
    pointIndex: i,
    local: [(i % 10) * 100, Math.floor(i / 10) * 100],
    x: i,
    y: 0,
    reference: [i, 0],
    residual,
    observations: Array.from({ length: obs }, (_, k) => ({ imageName: `p${k}`, px: 0, py: 0 })),
  })
  it('keeps tracks seen twice on the aligned surface and on stable ground', () => {
    const items = [item(0, 2), item(1, 80), item(2, -5, 1), item(3, 4, 2), item(4, 1)]
    const out = terrainCandidates(items, { rms: 15, pixel: 16, accept: (x) => x !== 4, width: 1000, height: 1000 })
    // 80 m off the DEM (> 3 × 16), one photo only, and off the stable layer are out.
    expect(out.map((c) => c.pointIndex).sort()).toEqual([0, 3])
    expect(out.find((c) => c.pointIndex === 3).confidence).toBeLessThan(out.find((c) => c.pointIndex === 0).confidence)
    expect(out[0].residualRefPx).toBeCloseTo(15 / 16, 9)
  })
  it('takes the median of the finite values', () => {
    expect(median([3, NaN, 1, 2])).toBe(2)
    expect(median([NaN])).toBeNaN()
  })
})

describe('terrain ICP', () => {
  it('pulls a cloud of ridges in from 400 m and 1° off', () => {
    // 12 × 12 km of ridges, 20 m samples; the "sparse cloud" is 3,000 points of it.
    const h = (x, y) => 600 * Math.sin(x / 1500) * Math.cos(y / 2100) + 300 * Math.sin((x + 2 * y) / 900)
    const pos = [],
      nrm = []
    for (let y = 0; y <= 12000; y += 20)
      for (let x = 0; x <= 12000; x += 20) {
        pos.push(x, y, h(x, y))
        const gx = (h(x + 1, y) - h(x - 1, y)) / 2,
          gy = (h(x, y + 1) - h(x, y - 1)) / 2,
          l = Math.hypot(gx, gy, 1)
        nrm.push(-gx / l, -gy / l, 1 / l)
      }
    const reference = { count: pos.length / 3, pos: new Float64Array(pos), nrm: new Float32Array(nrm) }
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const truth = []
    for (let i = 0; i < 3000; i++) {
      const x = 2000 + 8000 * rnd(),
        y = 2000 + 8000 * rnd()
      truth.push([x, y, h(x, y)])
    }
    // The source: truth moved by a wrong start (400 m, 1°, 1 % scale), in frame units of 1/1000.
    const a = Math.PI / 180,
      k = 1.01
    const src = truth.map(([x, y, z]) => [
      (k * (Math.cos(a) * (x - 6000) - Math.sin(a) * (y - 6000)) + 6000 + 300) / 1000,
      (k * (Math.sin(a) * (x - 6000) + Math.cos(a) * (y - 6000)) + 6000 - 260) / 1000,
      (k * z + 40) / 1000,
    ])
    const points = new Float64Array(src.flat())
    let tf = {
      scale: 1000,
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    }
    const err = (t) =>
      Math.sqrt(
        src.reduce((s, p, i) => {
          const q = applyTransform(t, p)
          return s + (q[0] - truth[i][0]) ** 2 + (q[1] - truth[i][1]) ** 2
        }, 0) / src.length,
      )
    expect(err(tf)).toBeGreaterThan(300)
    for (const pass of terrainPasses(0))
      tf = icpAlign({ count: src.length, pos: points }, reference, {
        ...pass,
        estimateScale: true,
        initial: tf,
        maxIterations: 60,
        trim: 0.8,
      }).transform
    expect(err(tf)).toBeLessThan(10)
  })
})
