import { describe, it, expect } from 'vitest'
import {
  hasDistortion, distortNormalized, undistortNormalized,
  undistortPixel, distortPixel, distortionOf,
  coeffsForModel, inferDistortionModel, DISTORTION_MODELS,
  isFisheyeModel, parseDistortionModelName, undistortKeypoint, FISHEYE_MAX_RAY_DEG,
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

  it('inverts strong barrel distortion exactly out to the corner (the fold depends on it)', () => {
    // 4000×3000, f=3000: the fixed-point scheme was 0.46 px off here at k1=−0.18
    // and 3.4 px at −0.20, errors the self-cal fold baked into every keypoint.
    const K = { fx: 3000, fy: 3000, cx: 2000, cy: 1500 }
    for (const d of [{ k1: -0.18 }, { k1: -0.2, k2: 0.02 }, { k1: -0.12, k2: -0.01, p1: 0.002, p2: -0.001 }]) {
      let maxErr = 0
      for (const [u, v] of [[0, 0], [4000, 3000], [0, 3000], [4000, 0], [1000, 2500]]) {
        const dp = distortPixel(u, v, K, d)
        const up = undistortPixel(dp.x, dp.y, K, d)
        maxErr = Math.max(maxErr, Math.hypot(up.x - u, up.y - v))
      }
      expect(maxErr).toBeLessThan(1e-6)
    }
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

describe('distortion (rational, OpenCV CALIB_RATIONAL_MODEL)', () => {
  const R = { k1: 0.3, k2: -0.05, k3: 0.01, k4: 0.4, k5: -0.02, k6: 0.005, p1: 5e-4, p2: -3e-4 }

  it('forward matches the rational formula and reduces to Brown without k4…k6', () => {
    const x = 0.5, y = -0.4, r2 = x * x + y * y
    const radial = (1 + R.k1 * r2 + R.k2 * r2 ** 2 + R.k3 * r2 ** 3) / (1 + R.k4 * r2 + R.k5 * r2 ** 2 + R.k6 * r2 ** 3)
    const [xd, yd] = distortNormalized(x, y, R)
    expect(xd).toBeCloseTo(x * radial + 2 * R.p1 * x * y + R.p2 * (r2 + 2 * x * x), 12)
    expect(yd).toBeCloseTo(y * radial + R.p1 * (r2 + 2 * y * y) + 2 * R.p2 * x * y, 12)
    expect(distortNormalized(x, y, { ...D, k4: 0, k5: 0, k6: 0 })).toEqual(distortNormalized(x, y, D))
  })

  it('inverts exactly across a wide frame', () => {
    const K = { fx: 1200, fy: 1200, cx: 2000, cy: 1500 }
    let maxErr = 0
    for (const [u, v] of [[0, 0], [4000, 3000], [0, 3000], [3100, 200], [2000, 1500]]) {
      const dp = distortPixel(u, v, K, R)
      const up = undistortPixel(dp.x, dp.y, K, R)
      maxErr = Math.max(maxErr, Math.hypot(up.x - u, up.y - v))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('the rational model keeps k4…k6 and nothing outside it', () => {
    const sensor = { ...R, distortionModel: 'rational' }
    expect(distortionOf(sensor)).toEqual(R)
    // Brown ignores the denominator terms entirely (bag shape unchanged).
    expect(distortionOf({ ...sensor, distortionModel: 'brown' }))
      .toEqual({ k1: R.k1, k2: R.k2, k3: R.k3, p1: R.p1, p2: R.p2 })
    expect(inferDistortionModel({ k1: 0.1, k5: 0.01 })).toBe('rational')
  })
})

describe('distortion (Kannala–Brandt fisheye)', () => {
  // A GoPro-like 4000×3000 frame: f ≈ 1700 px puts the corner ~84° off-axis.
  const K = { fx: 1700, fy: 1700, cx: 2000, cy: 1500 }
  const F = { fisheye: true, k1: 0.05, k2: -0.01, k3: 0.002, k4: -0.0003 }

  it('equidistant with all k zero: the recorded radius is the ray angle', () => {
    // x = 1 is a 45° ray; an equidistant lens records it at θ = π/4.
    const [xd, yd] = distortNormalized(1, 0, { fisheye: true })
    expect(xd).toBeCloseTo(Math.PI / 4, 12)
    expect(yd).toBe(0)
    // θd = θ·(1 + k1·θ²) for the one-term model (COLMAP SIMPLE_RADIAL_FISHEYE).
    const [xd1] = distortNormalized(1, 0, { fisheye: true, k1: 0.1 })
    expect(xd1).toBeCloseTo((Math.PI / 4) * (1 + 0.1 * (Math.PI / 4) ** 2), 12)
    expect(distortNormalized(0, 0, F)).toEqual([0, 0])
  })

  it('a zero-coefficient fisheye still counts as distortion', () => {
    expect(hasDistortion({ fisheye: true, k1: 0, k2: 0, k3: 0, k4: 0 })).toBe(true)
    expect(distortionOf({ distortionModel: 'fisheye' })).toEqual({ fisheye: true, k1: 0, k2: 0, k3: 0, k4: 0 })
    // Only the model's own terms are live.
    expect(distortionOf({ distortionModel: 'fisheye2', k1: 0.1, k2: 0.2, k3: 0.3, k4: 0.4, p1: 0.01 }))
      .toEqual({ fisheye: true, k1: 0.1, k2: 0.2, k3: 0, k4: 0 })
    expect(isFisheyeModel('fisheye1')).toBe(true)
    expect(isFisheyeModel('brown')).toBe(false)
    expect(isFisheyeModel(undefined)).toBe(false)
  })

  it('inverts exactly out to a wide ray', () => {
    let maxErr = 0
    // Pinhole pixels up to tan(80°)·f off-centre.
    for (const [u, v] of [[2000, 1500], [3000, 1500], [2000 + 1700 * 3, 1500 + 1700 * 2], [100, 2900], [-6000, -4000]]) {
      const dp = distortPixel(u, v, K, F)
      const up = undistortPixel(dp.x, dp.y, K, F)
      maxErr = Math.max(maxErr, Math.hypot(up.x - u, up.y - v))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('a ray at or past 90° has no pinhole image', () => {
    // Equidistant: radius π/2·f is exactly 90° off-axis; beyond it the ray points backwards.
    const [x, y] = undistortNormalized(Math.PI / 2 + 0.1, 0, { fisheye: true })
    expect(x).toBeNaN()
    expect(y).toBeNaN()
  })

  it('undistortKeypoint drops rays past the ingest limit and leaves Brown alone', () => {
    const lim = (FISHEYE_MAX_RAY_DEG * Math.PI) / 180
    const inside = undistortKeypoint(K.cx + K.fx * (lim - 0.01), K.cy, K, { fisheye: true })
    const outside = undistortKeypoint(K.cx + K.fx * (lim + 0.01), K.cy, K, { fisheye: true })
    expect(Number.isFinite(inside.x)).toBe(true)
    expect(outside.x).toBeNaN()
    expect(undistortKeypoint(3900, 2900, K, D)).toEqual(undistortPixel(3900, 2900, K, D))
  })
})

describe('parseDistortionModelName', () => {
  it('reads our ids, COLMAP names and other tools\' spellings', () => {
    expect(parseDistortionModelName('fisheye')).toBe('fisheye')
    expect(parseDistortionModelName('OPENCV_FISHEYE')).toBe('fisheye')
    expect(parseDistortionModelName('fisheye_opencv')).toBe('fisheye')
    expect(parseDistortionModelName('RADIAL_FISHEYE')).toBe('fisheye2')
    expect(parseDistortionModelName('FULL_OPENCV')).toBe('rational')
    expect(parseDistortionModelName('OPENCV')).toBe('brown')
    expect(parseDistortionModelName('Brown-Conrady')).toBe('brown')
    expect(parseDistortionModelName('perspective')).toBe('pinhole')
    expect(parseDistortionModelName('DJI FC6310')).toBeNull()
    expect(parseDistortionModelName('')).toBeNull()
  })

  it('every model maps to a COLMAP name that parses back to it', () => {
    for (const m of DISTORTION_MODELS) expect(parseDistortionModelName(m.colmap)).toBe(m.id)
  })
})
