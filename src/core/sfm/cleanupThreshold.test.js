import { describe, it, expect } from 'vitest'
import { adaptiveReprojThreshold, CLEANUP_THRESHOLD_DEFAULTS } from './cleanupThreshold.js'

// A healthy model: the bulk sits well under the absolute gate, a few gross
// outliers above it. The absolute threshold must still decide — this is the
// no-op case that keeps existing baselines byte-identical.
const healthy = [
  ...Array.from({ length: 95 }, (_, i) => 0.3 + i * 0.02), // 0.30 … 2.18 px
  40, 60, 90, 120, 180,                                     // gross tail
]

// A systematically shifted model (wrong focal): EVERY residual is above the
// absolute gate, so an absolute filter would delete the whole model.
const shifted = Array.from({ length: 100 }, (_, i) => 15 + i * 0.4) // 15.0 … 54.6 px

describe('adaptiveReprojThreshold', () => {
  it('keeps the absolute threshold when the model is healthy', () => {
    const r = adaptiveReprojThreshold(healthy, 8, { maxRemovedFrac: 0.1 })
    expect(r.adaptive).toBe(false)
    expect(r.px).toBe(8)
  })

  it('removes only the gross tail on a healthy model', () => {
    const { px } = adaptiveReprojThreshold(healthy, 8, { maxRemovedFrac: 0.1 })
    expect(healthy.filter((v) => v > px)).toHaveLength(5)
  })

  it('raises the threshold rather than deleting a systematically shifted model', () => {
    const r = adaptiveReprojThreshold(shifted, 8, { maxRemovedFrac: 0.1 })
    expect(r.adaptive).toBe(true)
    expect(r.px).toBeGreaterThan(8)
    // Absolute gate would have removed all 100; the bound holds it to ~10.
    expect(shifted.filter((v) => v > 8)).toHaveLength(100)
    expect(shifted.filter((v) => v > r.px).length).toBeLessThanOrEqual(10)
  })

  it('never removes more than maxRemovedFrac, for any fraction', () => {
    for (const frac of [0.05, 0.1, 0.25, 0.5]) {
      const { px } = adaptiveReprojThreshold(shifted, 8, { maxRemovedFrac: frac })
      const removed = shifted.filter((v) => v > px).length
      expect(removed).toBeLessThanOrEqual(Math.ceil(frac * shifted.length))
    }
  })

  it('is a no-op on an empty residual set', () => {
    const r = adaptiveReprojThreshold([], 8)
    expect(r).toMatchObject({ px: 8, adaptive: false, quantilePx: null })
  })

  it('clamps a nonsense fraction instead of inverting the filter', () => {
    // frac > 1 would index below zero and return the minimum residual, which as a
    // threshold removes nearly everything — the exact failure being guarded.
    const r = adaptiveReprojThreshold(shifted, 8, { maxRemovedFrac: 4 })
    expect(shifted.filter((v) => v > r.px)).toHaveLength(shifted.length - 1)
    const neg = adaptiveReprojThreshold(shifted, 8, { maxRemovedFrac: -1 })
    expect(shifted.filter((v) => v > neg.px)).toHaveLength(0)
  })

  it('does not mutate the caller’s residual array', () => {
    const input = [9, 1, 5, 3]
    adaptiveReprojThreshold(input, 2, { maxRemovedFrac: 0.5 })
    expect(input).toEqual([9, 1, 5, 3])
  })

  it('exposes a tighter bound for the pre-BA pass than the filter passes', () => {
    expect(CLEANUP_THRESHOLD_DEFAULTS.preBaMaxRemovedFrac)
      .toBeLessThan(CLEANUP_THRESHOLD_DEFAULTS.filterMaxRemovedFrac)
  })
})
