import { describe, it, expect } from 'vitest'
import { planeCostRef, aggregateValidCosts, INVALID } from './planeCost.js'

// A textured w×h gray image (diagonal ramp) so ZNCC has variance to work with.
function ramp(w, h) {
  const g = new Uint8Array(w * h)
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) g[v * w + u] = (u * 7 + v * 13) % 256
  return g
}

const W = 16, H = 16
const K = { fx: 20, fy: 20, cx: 8, cy: 8 }
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const refOf = (gray) => ({ gray, w: W, h: H, ...K })
const srcOf = (gray, R = I, t = [0, 0, 0]) => ({ gray, w: W, h: H, ...K, R, t })

describe('planeCostRef', () => {
  const gray = ramp(W, H)
  const n = [0, 0, -1] // frontal plane

  it('is ~0 when the source is identical with identity pose (perfect correlation)', () => {
    // t=0, R=I ⇒ every reference pixel warps to itself ⇒ ZNCC = 1 ⇒ cost = 0.
    const c = planeCostRef(refOf(gray), srcOf(gray), 8, 8, 5, n, 2)
    expect(c).toBeLessThan(1e-6)
  })

  it('bottoms out at the TRUE depth through a non-zero baseline (homography sign)', () => {
    // The t=0 cases above can't catch a wrong sign on the t·nᵀ/d term (it vanishes).
    // Build a real disparity: ref cam = world, src cam translated +tx in x ⇒ relative
    // pose R=I, t=[tx,0,0]. For a fronto-parallel plane at depth Z (n=[0,0,-1]) the
    // exact warp is su = u + fx·tx/Z, sv = v. Synthesize src so src(u+shift,v)=ref(u,v);
    // the cost at the true (Z, n) must be ~0 — and higher at a wrong depth.
    const w = 64, h = 64, k = { fx: 80, fy: 80, cx: 32, cy: 32 }
    const Z = 5, tx = 0.6, shift = k.fx * tx / Z
    // Smooth (band-limited) texture so the horizontal-shift round-trip is exact
    // under bilinear sampling; a wrong depth then stands out cleanly.
    const refG = new Uint8Array(w * h)
    for (let vv = 0; vv < h; vv++) for (let uu = 0; uu < w; uu++)
      refG[vv * w + uu] = Math.round(128 + 120 * Math.sin(uu * 0.7) * Math.cos(vv * 0.5)) & 255
    const srcG = new Uint8Array(w * h)
    for (let vv = 0; vv < h; vv++) for (let uu = 0; uu < w; uu++) {
      const rx = uu - shift
      const x0 = Math.floor(rx), f = rx - x0
      srcG[vv * w + uu] = (rx < 0 || rx > w - 2) ? 0
        : Math.round(refG[vv * w + x0] * (1 - f) + refG[vv * w + x0 + 1] * f)
    }
    const refO = { gray: refG, w, h, ...k }
    const srcO = { gray: srcG, w, h, ...k, R: I, t: [tx, 0, 0] }
    const cTrue = planeCostRef(refO, srcO, 32, 32, Z, [0, 0, -1], 2)
    const cWrong = planeCostRef(refO, srcO, 32, 32, Z * 1.5, [0, 0, -1], 2)
    expect(cTrue).toBeLessThan(1e-3)     // near-perfect correlation at the true geometry
    expect(cWrong).toBeGreaterThan(0.2)  // a wrong depth is clearly worse
  })

  it('is ~2 when the source is the photometric inverse (anti-correlation)', () => {
    const inv = gray.map((g) => 255 - g)
    const c = planeCostRef(refOf(gray), srcOf(inv), 8, 8, 5, n, 2)
    expect(c).toBeGreaterThan(2 - 1e-6)
  })

  it('returns the INVALID sentinel when the warp leaves the source image', () => {
    // A large translation pushes the warped patch far outside the source bounds:
    // no measurement, so aggregation can exclude it rather than average a 2.0 in.
    const c = planeCostRef(refOf(gray), srcOf(gray, I, [1000, 1000, 0]), 8, 8, 5, n, 2)
    expect(c).toBeGreaterThanOrEqual(1e8)
    expect(c).toBe(INVALID)
  })

  it('returns the INVALID sentinel when the warp lands on a masked source texel', () => {
    // Whole source masked ⇒ every warped sample is excluded, like out-of-bounds.
    const mask = new Uint8Array(W * H).fill(1)
    const c = planeCostRef(refOf(gray), { ...srcOf(gray), mask }, 8, 8, 5, n, 2)
    expect(c).toBe(INVALID)
  })

  it('is independent of intensity scale of each signal (ZNCC invariance)', () => {
    // Halving the source brightness must not change ZNCC ⇒ same cost.
    const half = gray.map((g) => (g / 2) | 0)
    const a = planeCostRef(refOf(gray), srcOf(gray), 8, 8, 5, n, 2)
    const b = planeCostRef(refOf(gray), srcOf(half), 8, 8, 5, n, 2)
    expect(Math.abs(a - b)).toBeLessThan(1e-3)
  })
})

describe('aggregateValidCosts (best-K over valid sources)', () => {
  it('excludes an out-of-bounds source; agg == mean of the two valid costs', () => {
    // One INVALID (no measurement) + two valid ⇒ mean of the two valid only.
    const c = aggregateValidCosts([0.2, INVALID, 0.4], 3)
    expect(c).toBeCloseTo(0.3, 12)
  })

  it('returns the max cost 2.0 when every source is out of bounds', () => {
    expect(aggregateValidCosts([INVALID, INVALID], 3)).toBe(2.0)
  })

  it('a masked (INVALID) source behaves like an out-of-bounds one', () => {
    // Same result whether the excluded source is masked or OOB — both are INVALID.
    expect(aggregateValidCosts([0.5, INVALID], 2)).toBeCloseTo(0.5, 12)
  })

  it('clamps bestK to the valid count (bestK > nValid)', () => {
    // Two valid sources, bestK 4 ⇒ mean of both (not padded with sentinels).
    expect(aggregateValidCosts([0.1, INVALID, 0.3, INVALID], 4)).toBeCloseTo(0.2, 12)
  })

  it('takes the k smallest of the valid costs when nValid > bestK', () => {
    expect(aggregateValidCosts([0.9, 0.1, 0.5, 0.3], 2)).toBeCloseTo(0.2, 12) // (0.1+0.3)/2
  })
})
