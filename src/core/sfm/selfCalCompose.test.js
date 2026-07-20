import { describe, it, expect } from 'vitest'
import { fitComposedRadial, radialCurveOk } from './selfCalCompose.js'
import { distortPixel, undistortPixel } from './distortion.js'

const K = { fx: 1000, fy: 1000, cx: 640, cy: 480 }

// A grid of ideal pixels spanning the frame (so the radial fit is well constrained).
function idealGrid() {
  const pts = []
  for (let u = 40; u < 1240; u += 60) for (let v = 40; v < 920; v += 60) pts.push({ x: u, y: v })
  return pts
}

describe('fitComposedRadial', () => {
  it('recovers a single known radial bag from pristine→folded pairs', () => {
    const bag = { k1: -0.12, k2: 0.03, k3: 0 }
    const folded = idealGrid()                                  // ideal (folded) positions
    const pristine = folded.map((p) => distortPixel(p.x, p.y, K, bag)) // as-observed (distorted)
    const fit = fitComposedRadial(pristine, folded, K, { k2: true, k3: false })
    expect(Math.abs(fit.k1 - bag.k1)).toBeLessThan(1e-3)
    expect(Math.abs(fit.k2 - bag.k2)).toBeLessThan(1e-3)
    expect(fit.k3).toBe(0)                                      // column not fit ⇒ exactly 0
    expect(fit.fitRmsPx).toBeLessThan(0.05)
  })

  it('approximates two sequential folds with one composed bag', () => {
    // Two passes: pristine → fold1 (undistort b1) → fold2 (undistort b2). The composed
    // fit from pristine → fold2 should reproduce the net map to sub-pixel.
    const b1 = { k1: -0.10, k2: 0, k3: 0 }
    const b2 = { k1: -0.02, k2: 0.01, k3: 0 }
    const pristine = idealGrid().map((p) => distortPixel(p.x, p.y, K, { k1: -0.12, k2: 0.01, k3: 0 }))
    const fold1 = pristine.map((p) => undistortPixel(p.x, p.y, K, b1))
    const fold2 = fold1.map((p) => undistortPixel(p.x, p.y, K, b2))
    const fit = fitComposedRadial(pristine, fold2, K, { k2: true, k3: false })
    // Reconstruct fold2 from pristine via the single composed bag; compare.
    let maxErr = 0
    for (let i = 0; i < pristine.length; i++) {
      const u = undistortPixel(pristine[i].x, pristine[i].y, K, fit)
      maxErr = Math.max(maxErr, Math.hypot(u.x - fold2[i].x, u.y - fold2[i].y))
    }
    expect(maxErr).toBeLessThan(0.5)
    expect(fit.fitRmsPx).toBeLessThan(0.5)
  })
})

describe('radialCurveOk', () => {
  it('accepts a mild well-behaved barrel bag', () => {
    const res = radialCurveOk({ k1: -0.1, k2: 0.02, k3: 0 }, 0.8, K.fx)
    expect(res.ok).toBe(true)
  })

  it('rejects a non-monotonic runaway higher-order fit', () => {
    // A large positive k3 makes r·d(r²) fold back on itself within the frame.
    const res = radialCurveOk({ k1: -0.5, k2: 0, k3: 3.0 }, 0.9, K.fx)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/non-monotonic|corner shift/)
  })

  // Regression (2026-07-17 building baseline): the guard used an absolute 50px corner-shift
  // ceiling and so flagged *correct* calibrations as runaway on every pass of the run.
  // These are COLMAP's own SIMPLE_RADIAL numbers for that set's Canon EOS 5D + 24mm:
  // f=2970.13, principal point (2184, 1456) on 4368×2912, k1=-0.0852 — a 174px corner
  // shift, 3.5× the old ceiling, on a perfectly ordinary lens.
  it('accepts a real 24mm full-frame calibration (174px corner shift)', () => {
    const fx = 2970.13
    const maxNormR = Math.hypot(2184 / fx, 1456 / fx)
    const res = radialCurveOk({ k1: -0.0852, k2: 0, k3: 0 }, maxNormR, fx)
    const cornerShiftPx = 0.0852 * maxNormR ** 3 * fx
    expect(cornerShiftPx).toBeGreaterThan(150) // the shift really is large in absolute px…
    expect(res.ok).toBe(true)                  // …yet only ~7% of the corner radius
  })

  // The relative ceiling must still bite on an over-bent map. k1 is chosen to stay
  // monotonic (|k1|·r² < ⅓, so the curve never folds) while displacing 30% of the corner
  // radius — i.e. it can only be caught by the corner-shift branch, not the fold branch.
  it('still rejects an over-bent radial map that stays monotonic', () => {
    const res = radialCurveOk({ k1: -0.387, k2: 0, k3: 0 }, 0.88, K.fx)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/corner shift/)
  })
})
