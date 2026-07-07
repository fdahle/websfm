import { describe, it, expect } from 'vitest'
import {
  hasDistortion, distortNormalized, undistortNormalized,
  undistortPixel, distortPixel, distortionOf,
  coeffsForModel, inferDistortionModel, DISTORTION_MODELS,
} from './distortion.js'

// A realistic mid-frame camera (1920×1080) with moderate barrel distortion + a
// little tangential — the kind a drone/phone actually has.
const K = { fx: 1400, fy: 1400, cx: 960, cy: 540 }
const D = { k1: -0.12, k2: 0.04, k3: -0.005, p1: 8e-4, p2: -6e-4 }

describe('distortion (Brown–Conrady)', () => {
  it('hasDistortion / distortionOf detect any non-zero coefficient', () => {
    expect(hasDistortion(null)).toBe(false)
    expect(hasDistortion({ k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 })).toBe(false)
    expect(hasDistortion({ k1: -0.1 })).toBe(true)
    expect(distortionOf({ k1: 0, k2: 0, p1: 0 })).toBeNull()
    expect(distortionOf({ k1: -0.1 })).toMatchObject({ k1: -0.1 })
  })

  it('distortion models gate which coefficients distortionOf applies (D3)', () => {
    // Unknown/undefined model → all coefficients (back-compat with pre-model sensors).
    expect(coeffsForModel(undefined)).toEqual(['k1', 'k2', 'k3', 'p1', 'p2'])
    expect(coeffsForModel('radial')).toEqual(['k1'])
    expect(coeffsForModel('pinhole')).toEqual([])

    const full = { k1: -0.1, k2: 0.02, k3: 0.001, p1: 3e-4, p2: -2e-4 }
    // Pinhole ignores every coefficient (a model switch can't leave a term applied).
    expect(distortionOf({ ...full, distortionModel: 'pinhole' })).toBeNull()
    // Radial(k1) applies only k1; k2/k3/p1/p2 are zeroed even though present.
    expect(distortionOf({ ...full, distortionModel: 'radial' }))
      .toEqual({ k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 })
    // Radial(k1,k2) keeps k1,k2 only.
    expect(distortionOf({ ...full, distortionModel: 'radial2' }))
      .toEqual({ k1: -0.1, k2: 0.02, k3: 0, p1: 0, p2: 0 })
    // Brown keeps all five.
    expect(distortionOf({ ...full, distortionModel: 'brown' })).toEqual(full)
  })

  it('inferDistortionModel picks the tightest model covering the coefficients (D3)', () => {
    expect(inferDistortionModel(null)).toBe('pinhole')
    expect(inferDistortionModel({})).toBe('pinhole')
    expect(inferDistortionModel({ k1: -0.1 })).toBe('radial')
    expect(inferDistortionModel({ k1: -0.1, k2: 0.02 })).toBe('radial2')
    expect(inferDistortionModel({ k1: -0.1, p1: 1e-4 })).toBe('brown')
    // Every inferred id is a real model.
    for (const s of [{}, { k1: 1 }, { k2: 1 }, { p2: 1 }])
      expect(DISTORTION_MODELS.some((m) => m.id === inferDistortionModel(s))).toBe(true)
  })

  it('forward and inverse are no-ops with zero coefficients', () => {
    expect(undistortPixel(123, 456, K, null)).toEqual({ x: 123, y: 456 })
    expect(distortPixel(123, 456, K, { k1: 0 })).toEqual({ x: 123, y: 456 })
  })

  it('round-trips distort→undistort within 0.05px across the whole frame', () => {
    let maxErr = 0
    for (let v = 0; v <= 1080; v += 60) {
      for (let u = 0; u <= 1920; u += 60) {
        const dp = distortPixel(u, v, K, D)                 // ideal → distorted
        const up = undistortPixel(dp.x, dp.y, K, D)         // distorted → ideal
        maxErr = Math.max(maxErr, Math.hypot(up.x - u, up.y - v))
      }
    }
    expect(maxErr).toBeLessThan(0.05)
  })

  it('normalized inverse recovers the forward input', () => {
    const [xd, yd] = distortNormalized(0.4, -0.3, D)
    const [x, y] = undistortNormalized(xd, yd, D)
    expect(x).toBeCloseTo(0.4, 5)
    expect(y).toBeCloseTo(-0.3, 5)
  })

  it('barrel distortion pulls points toward the centre (radial < 1 for k1 < 0)', () => {
    // At a corner-ish point, negative k1 shrinks the radius.
    const [xd, yd] = distortNormalized(0.6, 0.4, { k1: -0.15 })
    expect(Math.hypot(xd, yd)).toBeLessThan(Math.hypot(0.6, 0.4))
  })
})
