import { describe, expect, it } from 'vitest'
import { buildPlanarPrior } from './planarPrior.js'

const K = { fx: 50, fy: 50, cx: 20, cy: 15 }
const W = 40,
  H = 30
// A tilted plane z = 4 + 0.05·X in the camera frame: depth along each pixel's ray.
const planeDepth = (u, v) => {
  const rx = (u - K.cx) / K.fx
  return 4 / (1 - 0.05 * rx)
}

function map({ credible }) {
  const depth = new Float32Array(W * H),
    cost = new Float32Array(W * H).fill(0.5)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const i = v * W + u
      depth[i] = planeDepth(u, v)
      if (credible(u, v)) cost[i] = 0.05
    }
  return { depth, cost, width: W, height: H }
}

describe('buildPlanarPrior', () => {
  it('spans a textureless middle with the plane its textured border fixes', () => {
    // Only a 4-px border is credible (texture), the middle is not (a blank wall).
    const dm = map({ credible: (u, v) => u < 4 || v < 4 || u >= W - 4 || v >= H - 4 })
    const p = buildPlanarPrior(dm, K, { grid: 4 })
    expect(p.support).toBeGreaterThan(10)
    expect(p.triangles).toBeGreaterThan(0)
    const i = 15 * W + 20 // the middle
    expect(p.depth[i]).toBeCloseTo(planeDepth(20, 15), 4)
    // The normal of z − 0.05·X = 4: (−0.05, 0, 1) normalised, flipped to face the camera.
    const n = [p.normal[3 * i], p.normal[3 * i + 1], p.normal[3 * i + 2]]
    const want = [0.05, 0, -1].map((x) => x / Math.hypot(0.05, 0, 1))
    n.forEach((x, k) => expect(x).toBeCloseTo(want[k], 4))
    expect(p.covered).toBeGreaterThan(0.8 * W * H)
  })

  it('takes no support where nothing is credible', () => {
    const p = buildPlanarPrior(map({ credible: () => false }), K)
    expect(p.support).toBe(0)
    expect(p.covered).toBe(0)
  })
})
