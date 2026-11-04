import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { planeCosts, PLANE_COST_INVALID as INVALID } from '../sfm/reconstruction.js'

// The PatchMatch plane cost, through the Rust code a CPU depth map run scores hypotheses
// with (mvs.rs plane_costs). The WebGPU kernel (workers/gpu/patchmatch.wgsl) computes the
// same cost; its run-time A/B check compares it against this one.
beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

// Per-patch intensity-variance floor of the cost (mvs.rs and patchmatch.wgsl VAR_FLOOR).
const VAR_FLOOR = 1e-6

// One source's cost (or, `agg`, the best-K cost over `src` when it is an array).
//   ref: { gray, w, h, fx, fy, cx, cy };  src: { gray, w, h, fx, fy, cx, cy, R, t, mask? }
//   bil: { sigmaSpatial, sigmaColor } or null;  step: between window samples
async function costOf(ref, src, u, v, depth, n, radius, bil = null, step = 1, agg = false, bestK = 1) {
  const srcs = (Array.isArray(src) ? src : [src]).map((s) => ({
    gray: s.gray,
    w: s.w,
    h: s.h,
    K: { fx: s.fx, fy: s.fy, cx: s.cx, cy: s.cy },
    R: s.R,
    t: s.t,
    mask: s.mask ?? null,
  }))
  const [r] = await planeCosts(
    ref.gray,
    ref.w,
    ref.h,
    { fx: ref.fx, fy: ref.fy, cx: ref.cx, cy: ref.cy },
    srcs,
    [{ u, v, depth, n }],
    { window: radius, bestK, sigmaSpatial: bil?.sigmaSpatial ?? 0, sigmaColor: bil?.sigmaColor ?? 0, windowStep: step },
  )
  return agg ? r.agg : r.costs[0]
}

// A textured w×h gray image (diagonal ramp) so ZNCC has variance to work with.
function ramp(w, h) {
  const g = new Uint8Array(w * h)
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) g[v * w + u] = (u * 7 + v * 13) % 256
  return g
}

const W = 16,
  H = 16
const K = { fx: 20, fy: 20, cx: 8, cy: 8 }
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const refOf = (gray) => ({ gray, w: W, h: H, ...K })
const srcOf = (gray, R = I, t = [0, 0, 0]) => ({ gray, w: W, h: H, ...K, R, t })

describe('plane cost', () => {
  const gray = ramp(W, H)
  const n = [0, 0, -1] // frontal plane

  it('is ~0 when the source is identical with identity pose (perfect correlation)', async () => {
    // t=0, R=I ⇒ every reference pixel warps to itself ⇒ ZNCC = 1 ⇒ cost = 0.
    const c = await costOf(refOf(gray), srcOf(gray), 8, 8, 5, n, 2)
    expect(c).toBeLessThan(1e-6)
  })

  it('bottoms out at the TRUE depth through a non-zero baseline (homography sign)', async () => {
    // The t=0 cases above can't catch a wrong sign on the t·nᵀ/d term (it vanishes).
    // Build a real disparity: ref cam = world, src cam translated +tx in x ⇒ relative
    // pose R=I, t=[tx,0,0]. For a fronto-parallel plane at depth Z (n=[0,0,-1]) the
    // exact warp is su = u + fx·tx/Z, sv = v. Synthesize src so src(u+shift,v)=ref(u,v);
    // the cost at the true (Z, n) must be ~0 — and higher at a wrong depth.
    const w = 64,
      h = 64,
      k = { fx: 80, fy: 80, cx: 32, cy: 32 }
    const Z = 5,
      tx = 0.6,
      shift = (k.fx * tx) / Z
    // Smooth (band-limited) texture so the horizontal-shift round-trip is exact
    // under bilinear sampling; a wrong depth then stands out cleanly.
    const refG = new Uint8Array(w * h)
    for (let vv = 0; vv < h; vv++)
      for (let uu = 0; uu < w; uu++)
        refG[vv * w + uu] = Math.round(128 + 120 * Math.sin(uu * 0.7) * Math.cos(vv * 0.5)) & 255
    const srcG = new Uint8Array(w * h)
    for (let vv = 0; vv < h; vv++)
      for (let uu = 0; uu < w; uu++) {
        const rx = uu - shift
        const x0 = Math.floor(rx),
          f = rx - x0
        srcG[vv * w + uu] =
          rx < 0 || rx > w - 2 ? 0 : Math.round(refG[vv * w + x0] * (1 - f) + refG[vv * w + x0 + 1] * f)
      }
    const refO = { gray: refG, w, h, ...k }
    const srcO = { gray: srcG, w, h, ...k, R: I, t: [tx, 0, 0] }
    const cTrue = await costOf(refO, srcO, 32, 32, Z, [0, 0, -1], 2)
    const cWrong = await costOf(refO, srcO, 32, 32, Z * 1.5, [0, 0, -1], 2)
    expect(cTrue).toBeLessThan(1e-3) // near-perfect correlation at the true geometry
    expect(cWrong).toBeGreaterThan(0.2) // a wrong depth is clearly worse
  })

  it('is ~2 when the source is the photometric inverse (anti-correlation)', async () => {
    const inv = gray.map((g) => 255 - g)
    const c = await costOf(refOf(gray), srcOf(inv), 8, 8, 5, n, 2)
    expect(c).toBeGreaterThan(2 - 1e-6)
  })

  it('returns the INVALID sentinel when the warp leaves the source image', async () => {
    // A large translation pushes the warped patch far outside the source bounds:
    // no measurement, so aggregation can exclude it rather than average a 2.0 in.
    const c = await costOf(refOf(gray), srcOf(gray, I, [1000, 1000, 0]), 8, 8, 5, n, 2)
    expect(c).toBeGreaterThanOrEqual(1e8)
    expect(c).toBe(INVALID)
  })

  it('returns the INVALID sentinel when the warp lands on a masked source texel', async () => {
    // Whole source masked ⇒ every warped sample is excluded, like out-of-bounds.
    const mask = new Uint8Array(W * H).fill(1)
    const c = await costOf(refOf(gray), { ...srcOf(gray), mask }, 8, 8, 5, n, 2)
    expect(c).toBe(INVALID)
  })

  it('is independent of intensity scale of each signal (ZNCC invariance)', async () => {
    // Halving the source brightness must not change ZNCC ⇒ same cost.
    const half = gray.map((g) => (g / 2) | 0)
    const a = await costOf(refOf(gray), srcOf(gray), 8, 8, 5, n, 2)
    const b = await costOf(refOf(gray), srcOf(half), 8, 8, 5, n, 2)
    expect(Math.abs(a - b)).toBeLessThan(1e-3)
  })
})

// P1: PatchMatch spatial propagation must intersect a pixel's ray with the
// neighbour's PLANE, not copy the neighbour's raw depth (which only holds fronto-
// parallel). A JS model of the propagation step the mvs.rs / wgsl kernels run, scored
// by the real Rust plane cost, on a synthetic slanted plane.
describe('PatchMatch propagation on a slanted plane (P1 freckle fix)', () => {
  const norm3 = (v) => {
    const m = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / m, v[1] / m, v[2] / m]
  }

  // Two views of ONE slanted plane, rendered by sampling a smooth world-space
  // texture at each pixel's 3D point — so matching intensities are exactly
  // photo-consistent and ZNCC bottoms out at the true (depth, normal).
  function slantedScene() {
    const W = 32,
      H = 32,
      k = { fx: 48, fy: 48, cx: 16, cy: 16 }
    const N = norm3([0.35, 0.0, -1]) // tilted about x, facing the camera (nz<0)
    const D = -5 // plane N·X = D (D<0 ⇒ positive depths)
    const t = [0.25, 0, 0],
      R = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
    const dmin = 3,
      dmax = 8
    const tex = (x, y) => 128 + 110 * Math.sin(1.6 * x + 0.3) * Math.cos(1.8 * y - 0.2)
    const clip = (g) => Math.max(0, Math.min(255, Math.round(g)))
    const rayOf = (u, v) => [(u - k.cx) / k.fx, (v - k.cy) / k.fy, 1]

    const refG = new Uint8Array(W * H),
      gtDepth = new Float64Array(W * H)
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const r = rayOf(u, v)
        const Z = D / (N[0] * r[0] + N[1] * r[1] + N[2])
        gtDepth[v * W + u] = Z
        refG[v * W + u] = clip(tex(Z * r[0], Z * r[1]))
      }
    // Same plane in the source frame (R=I): N·Xs = D + N·t.
    const Ds = D + (N[0] * t[0] + N[1] * t[1] + N[2] * t[2])
    const srcG = new Uint8Array(W * H)
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const r = rayOf(u, v)
        const Zs = Ds / (N[0] * r[0] + N[1] * r[1] + N[2])
        srcG[v * W + u] = clip(tex(Zs * r[0] - t[0], Zs * r[1] - t[1]))
      }
    return {
      ref: { gray: refG, w: W, h: H, ...k },
      src: { gray: srcG, w: W, h: H, ...k, R, t },
      gtDepth,
      N,
      dmin,
      dmax,
      W,
      H,
      k,
    }
  }

  // One PatchMatch run with the normal fixed to ground truth (isolating depth
  // propagation) and a bad constant init (dmax, so nothing is a lucky low), then one
  // seeded GT anchor COLUMN and no random refinement — so the ONLY way GT depth
  // reaches a pixel is propagation. `mode` selects the fixed plane-intersection
  // candidate ('plane') vs the old raw-depth copy ('depth'). The plane is slanted in
  // x, so raw-depth copies across a row are maximally wrong.
  async function run(scene, mode, passes = 8) {
    const { ref, src, N, dmin, dmax, W, H, k, gtDepth } = scene
    const radius = 2
    const agg = (u, v, d) => costOf(ref, src, u, v, d, N, radius, null, 1, true)
    const rayx = (u) => (u - k.cx) / k.fx,
      rayy = (v) => (v - k.cy) / k.fy
    const depth = new Float64Array(W * H),
      cost = new Float64Array(W * H)
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const i = v * W + u
        depth[i] = dmax // deliberately-bad constant init
        cost[i] = await agg(u, v, depth[i])
      }
    const anchorCol = 3
    for (let v = 0; v < H; v++) {
      const i = v * W + anchorCol
      depth[i] = gtDepth[i]
      cost[i] = await agg(anchorCol, v, depth[i])
    }
    const candidate = (u, v, ju, jv) => {
      const j = jv * W + ju
      if (mode === 'depth') return depth[j]
      const nrj = N[0] * rayx(ju) + N[1] * rayy(jv) + N[2]
      const denom = N[0] * rayx(u) + N[1] * rayy(v) + N[2]
      return (depth[j] * nrj) / denom
    }
    const relaxAt = async (u, v) => {
      const i = v * W + u
      const neigh = [
        [u - 1, v],
        [u + 1, v],
        [u, v - 1],
        [u, v + 1],
      ]
      for (const [ju, jv] of neigh) {
        if (ju < 0 || jv < 0 || ju >= W || jv >= H) continue
        const cd = candidate(u, v, ju, jv)
        if (cd <= dmin || cd >= dmax) continue
        const c = await agg(u, v, cd)
        if (c < cost[i]) {
          cost[i] = c
          depth[i] = cd
        }
      }
    }
    for (let p = 0; p < passes; p++) {
      for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) await relaxAt(u, v) // forward
      for (let v = H - 1; v >= 0; v--) for (let u = W - 1; u >= 0; u--) await relaxAt(u, v) // backward
    }
    return depth
  }

  // Accuracy over the *scorable* pixels (where a source measurement exists at GT —
  // border pixels whose warp leaves the source can't be estimated by any method).
  async function fracWithin(scene, depth, tol = 0.01) {
    const { ref, src, N, gtDepth, W, H } = scene
    let ok = 0,
      total = 0
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        if ((await costOf(ref, src, u, v, gtDepth[v * W + u], N, 2)) >= 1e8) continue
        total++
        const i = v * W + u
        if (Math.abs(depth[i] - gtDepth[i]) / gtDepth[i] <= tol) ok++
      }
    return ok / total
  }

  it('fills a slanted plane to ≥95% within 1% via plane-intersection propagation', async () => {
    const scene = slantedScene()
    const frac = await fracWithin(scene, await run(scene, 'plane'))
    expect(frac).toBeGreaterThanOrEqual(0.95)
  })

  it('raw-depth propagation (the old bug) fails on the same slanted plane', async () => {
    const scene = slantedScene()
    const planeFrac = await fracWithin(scene, await run(scene, 'plane'))
    const depthFrac = await fracWithin(scene, await run(scene, 'depth'))
    // The correct method vastly outperforms copying raw neighbour depth.
    expect(depthFrac).toBeLessThan(0.5)
    expect(planeFrac).toBeGreaterThan(depthFrac + 0.4)
  })
})

describe('best-K aggregation over valid sources', () => {
  const gray = ramp(W, H)
  const n = [0, 0, -1]
  // Sources of known cost at the centre pixel: the same image (≈ 0), its inverse (2),
  // two partly correlated ones (in between), one the warp leaves and one fully masked
  // (both INVALID).
  const same = srcOf(gray)
  const inv = srcOf(gray.map((g) => 255 - g))
  const other = new Uint8Array(W * H).map((_, i) => ((i % W) * 11 + ((i / W) | 0) * 3) % 256)
  const mixA = srcOf(gray.map((g, i) => (0.7 * g + 0.3 * other[i]) | 0))
  const mixB = srcOf(gray.map((g, i) => (0.4 * g + 0.6 * other[i]) | 0))
  const oob = srcOf(gray, I, [1000, 1000, 0])
  const masked = { ...srcOf(gray), mask: new Uint8Array(W * H).fill(1) }
  const all = async (srcs, bestK) => {
    const [r] = await planeCosts(
      gray,
      W,
      H,
      K,
      srcs.map((s) => ({ gray: s.gray, w: W, h: H, K, R: s.R, t: s.t, mask: s.mask ?? null })),
      [{ u: 8, v: 8, depth: 5, n }],
      { window: 2, bestK },
    )
    return r
  }

  it('excludes an out-of-bounds source; agg == mean of the two valid costs', async () => {
    const r = await all([same, oob, inv], 3)
    expect(r.costs[1]).toBe(INVALID)
    expect(r.agg).toBeCloseTo((r.costs[0] + r.costs[2]) / 2, 6)
    expect(r.agg).toBeCloseTo(1, 3)
  })

  it('returns the max cost 2.0 when every source is out of bounds', async () => {
    expect((await all([oob, oob], 3)).agg).toBe(2.0)
  })

  it('a masked source behaves like an out-of-bounds one', async () => {
    const a = await all([mixA, masked], 2)
    const b = await all([mixA, oob], 2)
    expect(a.costs[1]).toBe(INVALID)
    expect(a.agg).toBe(b.agg)
    expect(a.agg).toBeCloseTo(a.costs[0], 6)
  })

  it('clamps bestK to the valid count (bestK > nValid)', async () => {
    const r = await all([mixA, oob, mixB, masked], 4)
    expect(r.agg).toBeCloseTo((r.costs[0] + r.costs[2]) / 2, 6)
  })

  it('takes the k smallest of the valid costs when nValid > bestK', async () => {
    const r = await all([inv, mixB, same, mixA], 2)
    const sorted = [...r.costs].sort((a, b) => a - b)
    expect(sorted[1]).toBeLessThan(sorted[2]) // the two smallest are distinct from the rest
    expect(r.agg).toBeCloseTo((sorted[0] + sorted[1]) / 2, 6)
  })
})

// A textured reference warped onto a FLAT source patch (saturated snow, sky,
// shadow) is evidence AGAINST the hypothesis, not a missing measurement. As
// INVALID it dropped out of best-K and let a wrong depth win on a single source's
// chance correlation. Only a flat REFERENCE patch is genuinely unmeasurable.
describe('flat patches: reference ⇒ INVALID, source ⇒ max cost', () => {
  const gray = ramp(W, H)
  const flat = new Uint8Array(W * H).fill(255) // saturated
  const n = [0, 0, -1]

  it('textured ref vs flat (255) source scores the max cost 2.0, not INVALID', async () => {
    const c = await costOf(refOf(gray), srcOf(flat), 8, 8, 5, n, 2)
    expect(c).toBe(2.0)
  })

  it('flat ref returns INVALID whatever the source', async () => {
    expect(await costOf(refOf(flat), srcOf(gray), 8, 8, 5, n, 2)).toBe(INVALID)
    expect(await costOf(refOf(flat), srcOf(flat), 8, 8, 5, n, 2)).toBe(INVALID)
  })

  it('flat sources stay in best-K, so a wrong hypothesis landing on them does not win', async () => {
    // Wrong depth: two of three sources see flat areas, the third a perfect chance
    // match. The old behaviour (flat source ⇒ INVALID) averaged only that one: ≈ 0.
    const wrong = await costOf(refOf(gray), [srcOf(flat), srcOf(flat), srcOf(gray)], 8, 8, 5, n, 2, null, 1, true, 3)
    expect(wrong).toBeCloseTo(4 / 3, 4) // (2 + 2 + 0) / 3
  })
})

// The GPU kernel computes ZNCC in f32. From raw sums (Σx² ≈ 240²·121 ≈ 7e6) the
// variance is a difference of two ~5.8e4 numbers whose true value is ~1 — f32's
// ~7 significant digits leave ~1e-2 relative error. Shifting by the first sample
// keeps every sum O(1)…O(100). Emulate both in f32 (Math.fround on every op) and
// compare against the f64 cost.
describe('ZNCC f32 precision (shifted accumulation, GPU emulation)', () => {
  const f = Math.fround
  function cost32(rv, sv, shifted) {
    let sR = 0,
      sS = 0,
      sRR = 0,
      sSS = 0,
      sRS = 0,
      cnt = 0
    let kR = 0,
      kS = 0
    for (let i = 0; i < rv.length; i++) {
      const r0 = f(rv[i]),
        s0 = f(sv[i])
      if (shifted && cnt === 0) {
        kR = r0
        kS = s0
      }
      const r = f(r0 - kR),
        s = f(s0 - kS)
      sR = f(sR + r)
      sS = f(sS + s)
      sRR = f(sRR + f(r * r))
      sSS = f(sSS + f(s * s))
      sRS = f(sRS + f(r * s))
      cnt = f(cnt + 1)
    }
    const mr = f(sR / cnt),
      ms = f(sS / cnt)
    const vr = f(f(sRR / cnt) - f(mr * mr)),
      vs = f(f(sSS / cnt) - f(ms * ms))
    const cov = f(f(sRS / cnt) - f(mr * ms))
    if (vr < VAR_FLOOR) return INVALID
    if (vs < VAR_FLOOR) return 2.0
    const denom = f(Math.sqrt(f(vr * vs)))
    return f(1 - Math.max(-1, Math.min(1, f(cov / denom))))
  }
  function cost64(rv, sv) {
    const nn = rv.length
    const mr = rv.reduce((a, b) => a + b, 0) / nn,
      ms = sv.reduce((a, b) => a + b, 0) / nn
    let vr = 0,
      vs = 0,
      cov = 0
    for (let i = 0; i < nn; i++) {
      const a = rv[i] - mr,
        b = sv[i] - ms
      vr += a * a
      vs += b * b
      cov += a * b
    }
    return 1 - Math.max(-1, Math.min(1, cov / Math.sqrt(vr * vs)))
  }
  // Deterministic grey 240±1.5 patches (11×11, the kernel's max window), the
  // source a noisy, partly correlated copy — bilinear samples are fractional.
  let seed = 12345
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296
  const patches = []
  for (let p = 0; p < 200; p++) {
    const rv = [],
      sv = []
    for (let i = 0; i < 121; i++) {
      const r = 240 + 3 * (rnd() - 0.5)
      rv.push(r)
      sv.push(Math.min(255, Math.max(0, 240 + 0.6 * (r - 240) + 1.2 * (rnd() - 0.5))))
    }
    patches.push([rv, sv])
  }

  it('shifted f32 sums agree with the f64 cost to < 1e-4', async () => {
    let maxErr = 0
    for (const [rv, sv] of patches) maxErr = Math.max(maxErr, Math.abs(cost32(rv, sv, true) - cost64(rv, sv)))
    expect(maxErr).toBeLessThan(1e-4)
  })

  it('unshifted f32 sums do NOT (the bug this formulation fixes)', async () => {
    const errs = patches.map(([rv, sv]) => Math.abs(cost32(rv, sv, false) - cost64(rv, sv))).sort((a, b) => a - b)
    expect(errs[errs.length - 1]).toBeGreaterThan(1e-3)
    expect(errs[errs.length >> 1]).toBeGreaterThan(1e-4) // median, not one outlier
  })

  it('the Rust cost (shifted sums) matches the textbook two-pass ZNCC', async () => {
    // Identity pose ⇒ the source patch is the source image itself.
    const refG = new Uint8Array(W * H),
      srcG = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      refG[i] = 238 + ((i * 7 + (i >> 4)) % 4)
      srcG[i] = 238 + ((i * 5 + (i >> 4)) % 4)
    }
    const c = await costOf(refOf(refG), srcOf(srcG), 8, 8, 5, [0, 0, -1], 2)
    const rv = [],
      sv = []
    for (let y = 6; y <= 10; y++)
      for (let x = 6; x <= 10; x++) {
        rv.push(refG[y * W + x])
        sv.push(srcG[y * W + x])
      }
    expect(Math.abs(c - cost64(rv, sv))).toBeLessThan(1e-6) // f32 out
  })
})

describe('plane cost — bilateral weighting', () => {
  // An object edge: the left half is the object, on the hypothesised plane, the right
  // half a background of another colour that the source sees shifted (parallax).
  const W = 32,
    H = 32
  const tex = (x, y) => 60 + 40 * Math.sin(x * 0.9) * Math.cos(y * 0.7)
  const bg = (x, y) => 200 + 30 * Math.sin(x * 1.3) * Math.cos(y * 0.9)
  const refGray = new Uint8Array(W * H).map((_, i) => {
    const x = i % W,
      y = (i / W) | 0
    return x < 16 ? tex(x, y) : bg(x, y)
  })
  const srcGray = new Uint8Array(W * H).map((_, i) => {
    const x = i % W,
      y = (i / W) | 0
    return x < 16 ? tex(x, y) : bg(x + 3, y)
  })
  const cam = { w: W, h: H, fx: 30, fy: 30, cx: 16, cy: 16 }
  const ref = { gray: refGray, ...cam }
  const src = {
    gray: srcGray,
    ...cam,
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
  }
  const n = [0, 0, -1]

  it('off is the plain cost exactly', async () => {
    expect(await costOf(ref, src, 13, 16, 5, n, 3, { sigmaSpatial: 3, sigmaColor: 0 })).toBe(
      await costOf(ref, src, 13, 16, 5, n, 3),
    )
  })

  it('on, the other side of the edge barely counts', async () => {
    const plain = await costOf(ref, src, 13, 16, 5, n, 3)
    const bil = await costOf(ref, src, 13, 16, 5, n, 3, { sigmaSpatial: 3, sigmaColor: 25 })
    expect(plain).toBeGreaterThan(0.01) // the shifted background costs the plain window
    expect(bil).toBeLessThan(plain / 10)
  })
})
