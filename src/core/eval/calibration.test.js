import { describe, it, expect } from 'vitest'
import { radialCurve, focalDelta } from './calibration.js'

describe('radialCurve', () => {
  it('starts at 0 and follows Δr = r·(k1 r² + …)', () => {
    const c = radialCurve({ k1: -0.1 }, 1, 4)
    expect(c).toHaveLength(5)
    expect(c[0]).toEqual({ r: 0, dr: 0 })
    // At r=1: dr = 1·(-0.1·1) = -0.1
    expect(c[4].r).toBeCloseTo(1, 9)
    expect(c[4].dr).toBeCloseTo(-0.1, 9)
    // At r=0.5: dr = 0.5·(-0.1·0.25) = -0.0125
    expect(c[2].dr).toBeCloseTo(-0.0125, 9)
  })

  it('is all-zero for a pinhole (no coeffs)', () => {
    const c = radialCurve({}, 1, 3)
    expect(c.every((p) => p.dr === 0)).toBe(true)
  })
})

describe('focalDelta', () => {
  it('computes px and pct delta', () => {
    expect(focalDelta(3050, 3000)).toEqual({ deltaPx: 50, deltaPct: (50 / 3000) * 100 })
  })
  it('is null-safe', () => {
    expect(focalDelta(null, 3000)).toEqual({ deltaPx: null, deltaPct: null })
    expect(focalDelta(3000, null)).toEqual({ deltaPx: null, deltaPct: null })
  })
})
