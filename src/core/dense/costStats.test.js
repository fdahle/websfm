import { describe, expect, it } from 'vitest'
import { costStats } from './costStats.js'

// The histogram resolves 2 / 4096 of the cost range; a bin reports its centre.
const BIN = 2 / 4096

describe('costStats', () => {
  it('reports the median and p95 of the costs where there is a depth', () => {
    // Costs 0.00, 0.01, … 0.99 over 100 pixels with depth.
    const n = 100
    const depth = new Float32Array(n).fill(5)
    const cost = Float32Array.from({ length: n }, (_, i) => i / 100)
    const s = costStats(depth, cost)
    expect(s.valid).toBe(n)
    // R type-7 rank round(q·(n−1)): the 50th and the 94th smallest, 0.50 and 0.94.
    expect(Math.abs(s.median - 0.5)).toBeLessThanOrEqual(BIN)
    expect(Math.abs(s.p95 - 0.94)).toBeLessThanOrEqual(BIN)
  })

  it('leaves out the pixels without a depth, whatever their cost', () => {
    const depth = Float32Array.of(1, 0, -1, NaN, 2)
    const cost = Float32Array.of(0.2, 1.9, 1.9, 1.9, 0.2)
    const s = costStats(depth, cost)
    expect(s.valid).toBe(2)
    expect(Math.abs(s.median - 0.2)).toBeLessThanOrEqual(BIN)
  })

  it('clamps costs to [0, 2] and is zero without any depth', () => {
    const s = costStats(Float32Array.of(1, 1, 1), Float32Array.of(5, 5, -1))
    expect(s.median).toBeGreaterThan(2 - BIN)
    expect(s.median).toBeLessThanOrEqual(2)
    expect(costStats(Float32Array.of(1), Float32Array.of(-1)).median).toBeLessThanOrEqual(BIN)
    expect(costStats(new Float32Array(3), new Float32Array(3))).toEqual({ median: 0, p95: 0, valid: 0 })
  })
})
