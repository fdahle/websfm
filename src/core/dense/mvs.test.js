import { describe, it, expect } from 'vitest'
import {
  filterDepthMap, depthMapForImage, qualityToMaxDim, autoBestK, autoFusionMaxCost,
  fuseDepthMaps, mergePointsSpatial,
} from './mvs.js'

// Build a w×h Float32Array depth plane from a 2-D array of numbers (0 = hole).
const plane = (rows) => Float32Array.from(rows.flat())

describe('filterDepthMap', () => {
  it('leaves a uniform field untouched', () => {
    const w = 4, h = 4
    const depth = plane(Array.from({ length: h }, () => Array(w).fill(5)))
    const { depth: out, removed } = filterDepthMap(depth, w, h, { radius: 1 })
    expect(removed).toBe(0)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(5)
  })

  it('drops a speckle (flying pixel) that disagrees with its neighbours', () => {
    const w = 3, h = 3
    // Centre pixel is a flying point (100) in an otherwise-uniform field (5).
    const depth = plane([
      [5, 5, 5],
      [5, 100, 5],
      [5, 5, 5],
    ])
    const { depth: out, removed } = filterDepthMap(depth, w, h, { radius: 1, relTol: 0.1 })
    expect(out[4]).toBe(0)      // centre dropped
    expect(removed).toBe(1)
    expect(out[0]).toBe(5)      // a corner survives, set to its local median (5)
  })

  it('drops an isolated valid pixel with too few valid neighbours', () => {
    const w = 5, h = 5
    const depth = new Float32Array(w * h) // all holes
    depth[12] = 7                          // a single lone valid pixel at the centre
    const { depth: out, removed } = filterDepthMap(depth, w, h, { radius: 1, minValidNeighbors: 4 })
    expect(out[12]).toBe(0)
    expect(removed).toBe(1)
  })

  it('does not mutate the input buffer', () => {
    const w = 3, h = 3
    const depth = plane([[5, 5, 5], [5, 100, 5], [5, 5, 5]])
    filterDepthMap(depth, w, h, { radius: 1 })
    expect(depth[4]).toBe(100) // original untouched
  })
})

describe('depthMapForImage — coarse-to-fine pyramid (Step 2)', () => {
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const K = { fx: 40, fy: 40, cx: 20, cy: 20 }
  const W = 40, H = 40
  // Sparse points spread across depth 5..9, near the image centre (project in front).
  const points = [
    { x: 0, y: 0, z: 5 }, { x: 0.1, y: 0, z: 6 }, { x: 0, y: 0.1, z: 7 },
    { x: 0.1, y: 0.1, z: 8 }, { x: -0.1, y: 0, z: 9 }, { x: 0, y: -0.1, z: 6.5 },
  ]
  const ref = { gray: new Uint8Array(W * H), width: W, height: H, K, cam: { R: I, t: [0, 0, 0] } }
  const sources = [{ gray: new Uint8Array(W * H), w: W, h: H, K, cam: { R: I, t: [-1, 0, 0] } }]

  // Kernel stub: records each level's dims/iters/seed, returns a constant valid map.
  const makeMock = () => {
    const calls = []
    const fn = async (g, w, h, k, srcs, opts) => {
      calls.push({ w, h, iters: opts.iterations, seed: opts.seedDepth })
      return { depth: new Float32Array(w * h).fill(7), cost: new Float32Array(w * h).fill(0.1), width: w, height: h }
    }
    return { fn, calls }
  }

  it('runs coarsest → finest with the working res as the final level', async () => {
    const { fn, calls } = makeMock()
    const out = await depthMapForImage(ref, sources, points, { coarseLong: 10 }, fn)
    // 40 → 20 → 10 ⇒ 3 levels.
    expect(calls.map((c) => c.w)).toEqual([10, 20, 40])
    expect(out.width).toBe(W)
    expect(out.height).toBe(H)
  })

  it('gives coarser levels more iterations than the finest', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, points, { coarseLong: 10, iterations: 3 }, fn)
    expect(calls[0].iters).toBeGreaterThan(calls[2].iters) // coarsest > finest
    expect(calls[2].iters).toBe(3)                          // finest honours the user setting
  })

  it('seeds coarser levels sparsely but finer levels at full coverage', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, points, { coarseLong: 10 }, fn)
    const nonZero = (a) => a.reduce((n, x) => n + (x > 0 ? 1 : 0), 0)
    // Coarsest seed = sparse splat (not every pixel set); finer seeds = upsampled
    // full-coverage depth (constant 7 from the mock ⇒ every pixel > 0).
    expect(nonZero(calls[0].seed)).toBeLessThan(calls[0].seed.length)
    expect(nonZero(calls[1].seed)).toBe(calls[1].seed.length)
    expect(nonZero(calls[2].seed)).toBe(calls[2].seed.length)
  })

  it('runs a single level when the working image is already at the coarse target', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, points, { coarseLong: 100 }, fn) // 40 ≤ 100
    expect(calls.length).toBe(1)
    expect(calls[0].w).toBe(W)
  })
})

describe('quality presets & derived params (Step 3)', () => {
  it('qualityToMaxDim scales the native long side by the preset fraction', () => {
    expect(qualityToMaxDim('low', 8000)).toBe(1000)     // ⅛
    expect(qualityToMaxDim('medium', 8000)).toBe(2000)  // ¼
    expect(qualityToMaxDim('high', 8000)).toBe(4000)    // ½
    expect(qualityToMaxDim('ultra', 8000)).toBe(8000)   // full
  })

  it('qualityToMaxDim floors at 200px and defaults unknown presets to medium', () => {
    expect(qualityToMaxDim('low', 400)).toBe(200)       // 50 → floored to 200
    expect(qualityToMaxDim('bogus', 8000)).toBe(2000)   // unknown → medium (¼)
  })

  it('autoBestK is ceil(nSources/2) clamped to [1,4]', () => {
    expect(autoBestK(1)).toBe(1)
    expect(autoBestK(2)).toBe(1)
    expect(autoBestK(3)).toBe(2)
    expect(autoBestK(6)).toBe(3)
    expect(autoBestK(20)).toBe(4) // clamped
  })

  it('autoFusionMaxCost clamps a weak p70 down to the 0.45 upper bound', () => {
    // depth>0 pixels: costs 0.1..1.0; raw p70 ≈ 0.7, clamped down to hi = 0.45.
    const depth = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const cost = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    const { maxCost, n, raw } = autoFusionMaxCost([{ depth, cost }])
    expect(n).toBe(10)
    expect(maxCost).toBe(0.45)
    expect(raw).toBeCloseTo(0.7, 6)
  })

  it('autoFusionMaxCost leaves an in-range p70 unclamped', () => {
    // p70 index = round(0.7×3) = 2 ⇒ 0.4 (within [0.3, 0.45]) — returned as-is.
    const depth = Float32Array.from([1, 1, 1, 1])
    const cost = Float32Array.from([0.3, 0.35, 0.4, 0.44])
    const { maxCost, raw } = autoFusionMaxCost([{ depth, cost }])
    expect(maxCost).toBeCloseTo(0.4, 6)
    expect(raw).toBeCloseTo(0.4, 6)
  })

  it('autoFusionMaxCost ignores holes and clamps up to the 0.3 lower bound', () => {
    // Only two valid pixels, both very low cost ⇒ p70 below 0.3 ⇒ clamped up to 0.3.
    const depth = Float32Array.from([1, 0, 1, 0])
    const cost = Float32Array.from([0.05, 9, 0.1, 9])
    const { maxCost, n } = autoFusionMaxCost([{ depth, cost }])
    expect(n).toBe(2)
    expect(maxCost).toBe(0.3)
  })

  it('fuseDepthMaps warns when the raw cost p70 signals a weak distribution', () => {
    // A single 2×2 map of high-cost valid pixels ⇒ raw p70 > 0.55 ⇒ warn logged.
    const map = {
      uuid: 'test', width: 2, height: 2,
      K: { fx: 1, fy: 1, cx: 1, cy: 1 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
      depth: Float32Array.from([1, 1, 1, 1]),
      cost: Float32Array.from([0.6, 0.7, 0.8, 0.9]),
      rgb: new Uint8Array(2 * 2 * 3),
    }
    const logs = []
    const out = fuseDepthMaps([map], {}, (m, level) => logs.push({ m, level }))
    expect(logs.some((l) => l.level === 'warn' && /weak cost distribution/.test(l.m))).toBe(true)
    // Summary is attached to the returned array for cross-run comparison (Q3).
    expect(out.summary).toBeTruthy()
    expect(out.summary.cullBreakdown).toHaveProperty('lowViewsPct')
  })
})

describe('mergePointsSpatial (fusion dedupe)', () => {
  it('collapses near-coincident points in one cell to one averaged point', () => {
    // Three duplicate-shell points (same surface from three views) within one cell,
    // plus one distinct point a cell away.
    const pts = [
      { x: 0.00, y: 0.0, z: 0.0, color: [90, 0, 0] },
      { x: 0.01, y: 0.0, z: 0.0, color: [120, 0, 0] },
      { x: 0.02, y: 0.0, z: 0.0, color: [150, 0, 0] },
      { x: 5.00, y: 0.0, z: 0.0, color: [0, 200, 0] },
    ]
    const out = mergePointsSpatial(pts, 1.0)
    expect(out.length).toBe(2)
    const merged = out.find((p) => p.x < 1)
    expect(merged.x).toBeCloseTo(0.01, 6)          // averaged position
    expect(merged.color).toEqual([120, 0, 0])       // averaged colour
  })

  it('is order-independent (same cells regardless of input order)', () => {
    const a = { x: 0.1, y: 0.1, z: 0.1, color: [10, 20, 30] }
    const b = { x: 0.2, y: 0.2, z: 0.2, color: [40, 50, 60] }
    const fwd = mergePointsSpatial([a, b], 1.0)
    const rev = mergePointsSpatial([b, a], 1.0)
    expect(fwd).toEqual(rev)
    expect(fwd.length).toBe(1)
  })

  it('returns the input unchanged when the cell size is non-positive', () => {
    const pts = [{ x: 0, y: 0, z: 0, color: [1, 2, 3] }]
    expect(mergePointsSpatial(pts, 0)).toBe(pts)
    expect(mergePointsSpatial(pts, -1)).toBe(pts)
  })

  it('fuseDepthMaps dedupes cross-view shells into fewer points than kept', () => {
    // Two 2×2 maps viewing the same fronto-parallel plane at depth 1 from identical
    // poses: every kept pixel in map B coincides in world space with map A's, so the
    // spatial merge must roughly halve the raw fused count.
    const mk = (uuid) => ({
      uuid, width: 2, height: 2,
      K: { fx: 100, fy: 100, cx: 1, cy: 1 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
      depth: Float32Array.from([1, 1, 1, 1]),
      cost: Float32Array.from([0.1, 0.1, 0.1, 0.1]),
      rgb: new Uint8Array(2 * 2 * 3).fill(128),
    })
    const out = fuseDepthMaps([mk('a'), mk('b')], {}, () => {})
    // 8 candidate px kept (both maps agree everywhere) but 4 distinct world cells.
    expect(out.summary.keptPct).toBeGreaterThan(0)
    expect(out.summary.mergedPct).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(4)
  })
})
