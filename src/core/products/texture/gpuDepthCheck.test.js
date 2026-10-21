import { describe, it, expect } from 'vitest'
// The GPU depth pass's A/B check (workers/gpu/textureDepthGpu.js). Here, not next to
// it: the vitest include covers src/core, not src/workers.
import { compareDepth } from '../../../workers/gpu/textureDepthGpu.js'

describe('compareDepth', () => {
  const view = (n, covered, z = 5) => Float32Array.from({ length: n }, (_, i) => (i < covered ? z : Infinity))

  it('judges the covered pixels only: an empty GPU pass does not pass', () => {
    // The mesh covers 1 % of the view; the GPU drew nothing. Counting empty-vs-empty
    // pixels, this agreed 99 %.
    const r = compareDepth(view(10000, 0), view(10000, 100))
    expect(r.agree).toBe(0)
    expect(r.covered).toBe(100)
    expect(r.coverage).toBeCloseTo(0.01, 6)
  })

  it('agrees where both passes hold the same depth, within the tolerance', () => {
    const cpu = view(1000, 500),
      gpu = view(1000, 500, 5 * (1 + 1e-3))
    gpu[0] = 9 // one pixel off
    const r = compareDepth(gpu, cpu)
    expect(r.agree).toBeCloseTo(499 / 500, 9)
    expect(r.coverage).toBeCloseTo(0.5, 9)
  })

  it('reports no coverage on an empty view', () => {
    expect(compareDepth(view(100, 0), view(100, 0))).toEqual({ agree: 0, covered: 0, coverage: 0 })
  })
})
