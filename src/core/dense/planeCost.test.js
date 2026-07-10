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

// P1: PatchMatch spatial propagation must intersect a pixel's ray with the
// neighbour's PLANE, not copy the neighbour's raw depth (which only holds fronto-
// parallel). This is a pure-JS reference of the exact propagation the mvs.rs / wgsl
// kernels now run, driven by the real planeCostRef, on a synthetic slanted plane.
describe('PatchMatch propagation on a slanted plane (P1 freckle fix)', () => {
  const norm3 = (v) => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m] }

  // Two views of ONE slanted plane, rendered by sampling a smooth world-space
  // texture at each pixel's 3D point — so matching intensities are exactly
  // photo-consistent and ZNCC bottoms out at the true (depth, normal).
  function slantedScene() {
    const W = 32, H = 32, k = { fx: 48, fy: 48, cx: 16, cy: 16 }
    const N = norm3([0.35, 0.0, -1])   // tilted about x, facing the camera (nz<0)
    const D = -5                        // plane N·X = D (D<0 ⇒ positive depths)
    const t = [0.25, 0, 0], R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const dmin = 3, dmax = 8
    const tex = (x, y) => 128 + 110 * Math.sin(1.6 * x + 0.3) * Math.cos(1.8 * y - 0.2)
    const clip = (g) => Math.max(0, Math.min(255, Math.round(g)))
    const rayOf = (u, v) => [(u - k.cx) / k.fx, (v - k.cy) / k.fy, 1]

    const refG = new Uint8Array(W * H), gtDepth = new Float64Array(W * H)
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const r = rayOf(u, v)
      const Z = D / (N[0] * r[0] + N[1] * r[1] + N[2])
      gtDepth[v * W + u] = Z
      refG[v * W + u] = clip(tex(Z * r[0], Z * r[1]))
    }
    // Same plane in the source frame (R=I): N·Xs = D + N·t.
    const Ds = D + (N[0] * t[0] + N[1] * t[1] + N[2] * t[2])
    const srcG = new Uint8Array(W * H)
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const r = rayOf(u, v)
      const Zs = Ds / (N[0] * r[0] + N[1] * r[1] + N[2])
      srcG[v * W + u] = clip(tex(Zs * r[0] - t[0], Zs * r[1] - t[1]))
    }
    return {
      ref: { gray: refG, w: W, h: H, ...k }, src: { gray: srcG, w: W, h: H, ...k, R, t },
      gtDepth, N, dmin, dmax, W, H, k,
    }
  }

  // One PatchMatch run with the normal fixed to ground truth (isolating depth
  // propagation) and a bad constant init (dmax, so nothing is a lucky low), then one
  // seeded GT anchor COLUMN and no random refinement — so the ONLY way GT depth
  // reaches a pixel is propagation. `mode` selects the fixed plane-intersection
  // candidate ('plane') vs the old raw-depth copy ('depth'). The plane is slanted in
  // x, so raw-depth copies across a row are maximally wrong.
  function run(scene, mode, passes = 8) {
    const { ref, src, N, dmin, dmax, W, H, k, gtDepth } = scene
    const radius = 2
    const agg = (u, v, d) => aggregateValidCosts([planeCostRef(ref, src, u, v, d, N, radius)], 1)
    const rayx = (u) => (u - k.cx) / k.fx, rayy = (v) => (v - k.cy) / k.fy
    const depth = new Float64Array(W * H), cost = new Float64Array(W * H)
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const i = v * W + u
      depth[i] = dmax        // deliberately-bad constant init
      cost[i] = agg(u, v, depth[i])
    }
    const anchorCol = 3
    for (let v = 0; v < H; v++) {
      const i = v * W + anchorCol
      depth[i] = gtDepth[i]; cost[i] = agg(anchorCol, v, depth[i])
    }
    const candidate = (u, v, ju, jv) => {
      const j = jv * W + ju
      if (mode === 'depth') return depth[j]
      const nrj = N[0] * rayx(ju) + N[1] * rayy(jv) + N[2]
      const denom = N[0] * rayx(u) + N[1] * rayy(v) + N[2]
      return (depth[j] * nrj) / denom
    }
    const relaxAt = (u, v) => {
      const i = v * W + u
      const neigh = [[u - 1, v], [u + 1, v], [u, v - 1], [u, v + 1]]
      for (const [ju, jv] of neigh) {
        if (ju < 0 || jv < 0 || ju >= W || jv >= H) continue
        const cd = candidate(u, v, ju, jv)
        if (cd <= dmin || cd >= dmax) continue
        const c = agg(u, v, cd)
        if (c < cost[i]) { cost[i] = c; depth[i] = cd }
      }
    }
    for (let p = 0; p < passes; p++) {
      for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) relaxAt(u, v)         // forward
      for (let v = H - 1; v >= 0; v--) for (let u = W - 1; u >= 0; u--) relaxAt(u, v) // backward
    }
    return depth
  }

  // Accuracy over the *scorable* pixels (where a source measurement exists at GT —
  // border pixels whose warp leaves the source can't be estimated by any method).
  function fracWithin(scene, depth, tol = 0.01) {
    const { ref, src, N, gtDepth, W, H } = scene
    let ok = 0, total = 0
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      if (planeCostRef(ref, src, u, v, gtDepth[v * W + u], N, 2) >= 1e8) continue
      total++
      const i = v * W + u
      if (Math.abs(depth[i] - gtDepth[i]) / gtDepth[i] <= tol) ok++
    }
    return ok / total
  }

  it('fills a slanted plane to ≥95% within 1% via plane-intersection propagation', () => {
    const scene = slantedScene()
    const frac = fracWithin(scene, run(scene, 'plane'))
    expect(frac).toBeGreaterThanOrEqual(0.95)
  })

  it('raw-depth propagation (the old bug) fails on the same slanted plane', () => {
    const scene = slantedScene()
    const planeFrac = fracWithin(scene, run(scene, 'plane'))
    const depthFrac = fracWithin(scene, run(scene, 'depth'))
    // The correct method vastly outperforms copying raw neighbour depth.
    expect(depthFrac).toBeLessThan(0.5)
    expect(planeFrac).toBeGreaterThan(depthFrac + 0.4)
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
