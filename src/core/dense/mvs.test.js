import { describe, it, expect } from 'vitest'
import {
  filterDepthMap, depthMapForImage, qualityToMaxDim, autoBestK, autoFusionMaxCost,
  fuseDepthMaps, mergePointsSpatial, createVoxelAccumulator, filterDepthMapsGeometric,
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
    // Summary is attached to the returned flat typed array for cross-run comparison (Q3).
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.summary).toBeTruthy()
    expect(out.summary.cullBreakdown).toHaveProperty('lowViewsPct')
  })

  it('autoFusionMaxCost returns the median and matches an exact sort on sampled input', () => {
    // A distribution large enough to force subsampling (maxSamples tiny) — the sampled
    // p50/p70 must land within a small tolerance of the exact percentiles.
    const N = 50_000
    const depth = new Float32Array(N).fill(1)
    const cost = new Float32Array(N)
    for (let i = 0; i < N; i++) cost[i] = i / (N - 1) // uniform 0..1
    const exactMedian = 0.5, exactP70 = 0.7
    const { median, raw, n } = autoFusionMaxCost([{ depth, cost }], { maxSamples: 2000, lo: 0, hi: 1 })
    expect(n).toBe(N)                         // true valid count, not the sample size
    expect(median).toBeCloseTo(exactMedian, 2)
    expect(raw).toBeCloseTo(exactP70, 2)
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
    // Disable the WS4 geometric filters: this fixture's two cameras share a pose
    // (zero parallax), which the min-triangulation-angle gate would correctly cull —
    // but here we're exercising only the spatial merge.
    const out = fuseDepthMaps([mk('a'), mk('b')], { minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false }, () => {})
    // 8 candidate px kept (both maps agree everywhere) but 4 distinct world cells.
    expect(out.summary.keptPct).toBeGreaterThan(0)
    expect(out.summary.mergedPct).toBeGreaterThan(0)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.count).toBeLessThanOrEqual(4)   // merged cell count
    expect(out.length).toBe(out.count * 6)      // flat [x,y,z,r,g,b] per point
  })
})

describe('createVoxelAccumulator (streaming fusion merge)', () => {
  // Bounds over a point set, matching how fuseDepthMaps derives them.
  const boundsOf = (pts) => {
    const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
    for (const p of pts) {
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x)
      b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y)
      b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z)
    }
    return b
  }

  it('streaming accumulation produces the same cells + averages as mergePointsSpatial', () => {
    // Random point set spread over a few cells, with colours.
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pts = Array.from({ length: 4000 }, () => {
      const nx = rnd() * 2 - 1, ny = rnd() * 2 - 1, nz = rnd() * 2 - 1
      const m = Math.hypot(nx, ny, nz) || 1
      return {
        x: rnd() * 10 - 5, y: rnd() * 10 - 5, z: rnd() * 10 - 5,
        color: [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)],
        normal: [nx / m, ny / m, nz / m],
      }
    })
    const cell = 1.0

    const ref = mergePointsSpatial(pts, cell)
    const acc = createVoxelAccumulator(cell, boundsOf(pts))
    for (const p of pts) acc.add(p.x, p.y, p.z, p.color[0], p.color[1], p.color[2], p.normal[0], p.normal[1], p.normal[2])
    const flat = acc.finalizeFlat()
    const { nrm } = acc.finalizeNormals()

    // Same number of merged cells.
    expect(acc.count).toBe(ref.length)
    // Same averaged points (order differs, so match by rounded position key).
    const key = (x, y, z) => `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`
    const refMap = new Map(ref.map((p) => [key(p.x, p.y, p.z), p]))
    for (let s = 0; s < acc.count; s++) {
      const o = s * 6
      const r = refMap.get(key(flat[o], flat[o + 1], flat[o + 2]))
      expect(r).toBeTruthy()
      expect(flat[o]).toBeCloseTo(r.x, 3)
      expect(flat[o + 1]).toBeCloseTo(r.y, 3)
      expect(flat[o + 2]).toBeCloseTo(r.z, 3)
      expect(flat[o + 3]).toBe(r.color[0])
      expect(flat[o + 4]).toBe(r.color[1])
      expect(flat[o + 5]).toBe(r.color[2])
      // Normals match the reference (unit, renormalized average).
      const no = s * 3
      expect(nrm[no]).toBeCloseTo(r.normal[0], 4)
      expect(nrm[no + 1]).toBeCloseTo(r.normal[1], 4)
      expect(nrm[no + 2]).toBeCloseTo(r.normal[2], 4)
      expect(Math.hypot(nrm[no], nrm[no + 1], nrm[no + 2])).toBeCloseTo(1, 5)
    }
  })

  it('grows past the initial capacity without losing cells', () => {
    // > 1024 distinct cells forces at least one internal doubling.
    const pts = Array.from({ length: 3000 }, (_, i) => ({ x: i * 10, y: 0, z: 0, color: [1, 2, 3] }))
    const acc = createVoxelAccumulator(1.0, boundsOf(pts))
    for (const p of pts) acc.add(p.x, p.y, p.z, 1, 2, 3)
    expect(acc.count).toBe(3000)
    const flat = acc.finalizeFlat()
    expect(flat.length).toBe(3000 * 6)
  })

  it('filterIsolated (WS4) removes a lone cell but keeps a neighbour cluster', () => {
    // A 2×2×2 block of 8 single-support cells (each has ≥2 occupied neighbours) plus one
    // far-away lone cell. filterIsolated must drop only the lone cell, and finalizeFlat/
    // finalizeNormals must compact around it (stay row-aligned).
    const block = []
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++)
      block.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5 })
    const lone = { x: 50.5, y: 50.5, z: 50.5 }
    const pts = [...block, lone]
    const acc = createVoxelAccumulator(1.0, boundsOf(pts))
    for (const p of pts) acc.add(p.x, p.y, p.z, 10, 20, 30, 0, 0, 1)
    expect(acc.count).toBe(9)
    const removed = acc.filterIsolated({ radius: 1, minNeighbors: 2, maxSupport: 2 })
    expect(removed).toBe(1)
    expect(acc.count).toBe(8)
    const flat = acc.finalizeFlat()
    const { nrm } = acc.finalizeNormals()
    expect(flat.length).toBe(8 * 6)   // compacted, lone cell gone
    expect(nrm.length).toBe(8 * 3)    // row-aligned with flat
    // The surviving points are all in the block (none near the lone cell's 50,50,50).
    for (let s = 0; s < 8; s++) expect(flat[s * 6]).toBeLessThan(10)
  })
})

describe('filterDepthMapsGeometric (cross-view consistency)', () => {
  // Two cameras offset along x by 0.1, both viewing a fronto-parallel plane at depth 1.
  // The reprojection is an exact 10 px shift (fx·b/D = 100·0.1/1), so a pixel on the
  // true surface round-trips back to itself with 0 error and only the filter decides.
  const W = 32, H = 32
  const mkPlane = (uuid, tx) => ({
    uuid, width: W, height: H,
    K: { fx: 100, fy: 100, cx: 16, cy: 16 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [tx, 0, 0],
    depth: new Float32Array(W * H).fill(1),
    cost: new Float32Array(W * H).fill(0.1),
    rgb: new Uint8Array(W * H * 3).fill(120),
  })
  const at = (u, v) => v * W + u
  const CENTER = at(16, 16)

  it('keeps a pixel both views independently agree on', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    const s = filterDepthMapsGeometric(maps, { minConsistent: 1 }, () => {})
    expect(maps[0].depth[CENTER]).toBeGreaterThan(0)
    expect(s.kept).toBeGreaterThan(0)
    expect(s.inconsistent).toBeLessThan(s.considered)
  })

  it('drops a flying pixel no other view supports', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    maps[0].depth[CENTER] = 2 // a flyer at 2× the true depth, low cost (looks confident)
    filterDepthMapsGeometric(maps, { minConsistent: 1 }, () => {})
    // The round trip through b's own depth lands ~5 px away ⇒ b does not vouch for it.
    expect(maps[0].depth[CENTER]).toBe(0)
    // …and its neighbours, which are on the true surface, are untouched.
    expect(maps[0].depth[at(10, 16)]).toBeGreaterThan(0)
  })

  it('applies the absolute NCC floor regardless of cross-view agreement', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    maps[0].cost[CENTER] = 0.95 // ncc 0.05 < 0.1 floor — geometrically fine, photometrically junk
    const s = filterDepthMapsGeometric(maps, { minConsistent: 1, minNcc: 0.1 }, () => {})
    expect(maps[0].depth[CENTER]).toBe(0)
    expect(s.lowNcc).toBe(1)
  })

  it('skips the cross-view check for a single map rather than rejecting everything', () => {
    const maps = [mkPlane('a', 0)]
    const s = filterDepthMapsGeometric(maps, { minConsistent: 2 }, () => {})
    // No other view exists — "no evidence" must not read as "inconsistent".
    expect(s.inconsistent).toBe(0)
    expect(maps[0].depth[CENTER]).toBeGreaterThan(0)
  })

  it('judges every map against the unfiltered planes (no order-dependent cascade)', () => {
    // Regression: filtering in place would let map A's rejections remove the evidence
    // map B is judged against, cascading drops in map order. Here A is entirely
    // rejected by the NCC floor; B's geometry is sound and must survive on A's
    // *original* depths — exactly as COLMAP filters against the pass-1 maps.
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    maps[0].cost.fill(0.95) // every pixel of A fails the NCC floor
    filterDepthMapsGeometric(maps, { minConsistent: 1, minNcc: 0.1 }, () => {})
    expect(maps[0].depth[CENTER]).toBe(0)        // A dropped on NCC
    expect(maps[1].depth[CENTER]).toBeGreaterThan(0) // B still vouched for by A's real surface

    // And the verdict must not depend on which map is listed first.
    const rev = [mkPlane('b', -0.1), mkPlane('a', 0)]
    rev[1].cost.fill(0.95)
    filterDepthMapsGeometric(rev, { minConsistent: 1, minNcc: 0.1 }, () => {})
    expect(rev[0].depth[CENTER]).toBeGreaterThan(0)
    expect(rev[1].depth[CENTER]).toBe(0)
  })

  it('is disabled by minConsistent 0 (NCC floor only)', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    maps[0].depth[CENTER] = 2 // a flyer that the cross-view check would drop
    const s = filterDepthMapsGeometric(maps, { minConsistent: 0 }, () => {})
    expect(maps[0].depth[CENTER]).toBe(2)
    expect(s.inconsistent).toBe(0)
  })
})

describe('fuseDepthMaps geometric filters (WS4)', () => {
  // Two cameras sharing a pose (zero parallax) viewing a fronto-parallel plane at depth 1.
  // `normal` (camera-frame) is optional; omit for the view-direction fallback.
  const mk = (uuid, normal) => {
    const m = {
      uuid, width: 4, height: 4,
      K: { fx: 100, fy: 100, cx: 2, cy: 2 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
      depth: new Float32Array(16).fill(1),
      cost: new Float32Array(16).fill(0.1),
      rgb: new Uint8Array(16 * 3).fill(120),
    }
    if (normal) {
      m.normals = new Float32Array(16 * 3)
      for (let i = 0; i < 16; i++) { m.normals[i*3] = normal[0]; m.normals[i*3+1] = normal[1]; m.normals[i*3+2] = normal[2] }
    }
    return m
  }

  it('min triangulation angle culls zero-parallax agreement, but keeps it at 0°', () => {
    const maps = () => [mk('a'), mk('b')] // coincident cameras ⇒ 0° parallax
    const culled = fuseDepthMaps(maps(), { minTriAngleDeg: 2.0, maxIncidenceDeg: 0, removeIsolated: false }, () => {})
    expect(culled.count).toBe(0)               // everything culled as low-parallax
    expect(culled.summary.cullBreakdown.lowParallaxPct).toBeGreaterThan(0)
    const kept = fuseDepthMaps(maps(), { minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false }, () => {})
    expect(kept.count).toBeGreaterThan(0)      // disabled ⇒ points survive
  })

  it('keeps genuine wide-parallax agreement (reference centre passed as array, not object)', () => {
    // Regression: the parallax gate read the reference camera centre as an array while
    // it was passed as {x,y,z}, so the angle came back NaN → maxAngle stayed 0 → every
    // consistency-passing pixel was culled as low-parallax (fusion always yielded 0).
    // Two cameras offset along x by 0.1 at depth 1 give ~5.7° parallax; a fronto-parallel
    // plane at world z=1 reprojects with an exact 10 px shift (fx·b/D = 100·0.1/1), so
    // agreement is exact and only the (correct) angle decides survival.
    const plane = (uuid, tx) => ({
      uuid, width: 32, height: 32,
      K: { fx: 100, fy: 100, cx: 16, cy: 16 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [tx, 0, 0],
      depth: new Float32Array(32 * 32).fill(1),
      cost: new Float32Array(32 * 32).fill(0.1),
      rgb: new Uint8Array(32 * 32 * 3).fill(120),
    })
    const maps = [plane('a', 0), plane('b', -0.1)] // centres (0,0,0) and (0.1,0,0)
    const out = fuseDepthMaps(maps, { minTriAngleDeg: 2.0, maxIncidenceDeg: 0, removeIsolated: false }, () => {})
    expect(out.count).toBeGreaterThan(0) // ~5.7° parallax clears the 2° gate — must survive
  })

  it('grazing-angle reject culls edge-on normals but leaves fallback normals untouched', () => {
    // Edge-on: world normal (1,0,0) ⊥ the near-(0,0,1) viewing ray ⇒ ~90° incidence.
    const edgeOn = fuseDepthMaps([mk('a', [1, 0, 0]), mk('b', [1, 0, 0])],
      { minTriAngleDeg: 0, maxIncidenceDeg: 80, removeIsolated: false }, () => {})
    expect(edgeOn.count).toBe(0)
    expect(edgeOn.summary.cullBreakdown.grazingPct).toBeGreaterThan(0)
    // No per-pixel normals ⇒ view-direction fallback ⇒ cosInc = 1 ⇒ never culled.
    const fallback = fuseDepthMaps([mk('a'), mk('b')],
      { minTriAngleDeg: 0, maxIncidenceDeg: 80, removeIsolated: false }, () => {})
    expect(fallback.count).toBeGreaterThan(0)
    expect(fallback.summary.cullBreakdown.grazingPct).toBe(0)
  })

  it('all filters disabled reproduces the unfiltered output (regression guard)', () => {
    const maps = () => [mk('a'), mk('b')]
    const off = fuseDepthMaps(maps(), { minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false }, () => {})
    // With every geometric filter off, nothing is culled beyond the pre-existing gates.
    expect(off.summary.cullBreakdown.lowParallaxPct).toBe(0)
    expect(off.summary.cullBreakdown.grazingPct).toBe(0)
    expect(off.summary.isolatedRemoved).toBe(0)
    expect(off.count).toBeGreaterThan(0)
  })
})

describe('fuseDepthMaps progress emits', () => {
  it('emits monotonic, throttled progress bounded by the map count', () => {
    // Several maps of valid pixels; collect onProgress calls.
    const mk = (uuid) => ({
      uuid, width: 8, height: 8,
      K: { fx: 100, fy: 100, cx: 4, cy: 4 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
      depth: new Float32Array(64).fill(1),
      cost: new Float32Array(64).fill(0.1),
      rgb: new Uint8Array(64 * 3).fill(100),
    })
    const maps = [mk('a'), mk('b'), mk('c')]
    const emits = []
    fuseDepthMaps(maps, {}, () => {}, { onProgress: (d, t, l) => emits.push({ d, t, l }) })
    expect(emits.length).toBeGreaterThan(0)
    let prev = -Infinity
    for (const e of emits) {
      expect(e.t).toBe(maps.length)          // total is the map count
      expect(e.d).toBeGreaterThanOrEqual(prev) // monotonic non-decreasing
      expect(e.d).toBeLessThanOrEqual(e.t)     // never exceeds total
      prev = e.d
    }
  })
})
