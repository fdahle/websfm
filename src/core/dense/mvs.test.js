import { describe, it, expect } from 'vitest'
import {
  filterDepthMap, depthMapForImage, qualityToMaxDim, autoBestK, fusionCostStats,
  fuseDepthMaps, mergePointsSpatial, createVoxelAccumulator, filterDepthMapsGeometric, filterCandidates, geomFilterLoopShare,
  filterDepthMapsGeometricStreamed, applyPackedMask, fuseDepthMapsStreamed, fusionGates, filterConfig, filterSettings,
  depthMapSettings, streamedEligible,
} from './mvs.js'
import { packSparseForDense } from './sparseInput.js'
import { DENSE_TUNING } from '../tuning.js'
import { DENSE_FUSE_DEFAULTS, DEPTHMAP_DEFAULTS } from '../defaults.user.js'

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
      calls.push({ w, h, iters: opts.iterations, seed: opts.seedDepth, perturbStart: opts.perturbStart })
      return { depth: new Float32Array(w * h).fill(7), cost: new Float32Array(w * h).fill(0.1), width: w, height: h }
    }
    return { fn, calls }
  }

  it('runs coarsest → finest with the working res as the final level', async () => {
    const { fn, calls } = makeMock()
    const out = await depthMapForImage(ref, sources, packSparseForDense(points).pos, { coarseLong: 10 }, fn)
    // 40 → 20 → 10 ⇒ 3 levels.
    expect(calls.map((c) => c.w)).toEqual([10, 20, 40])
    // Refinement continues across levels (5 / 4 / 3 sweeps) instead of restarting.
    expect(calls.map((c) => c.perturbStart)).toEqual([1, 0.125, 0.03125])
    expect(out.width).toBe(W)
    expect(out.height).toBe(H)
  })

  it('gives coarser levels more iterations than the finest', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, packSparseForDense(points).pos, { coarseLong: 10, iterations: 3 }, fn)
    expect(calls[0].iters).toBeGreaterThan(calls[2].iters) // coarsest > finest
    expect(calls[2].iters).toBe(3)                          // finest honours the user setting
  })

  it('seeds coarser levels sparsely but finer levels at full coverage', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, packSparseForDense(points).pos, { coarseLong: 10 }, fn)
    const nonZero = (a) => a.reduce((n, x) => n + (x > 0 ? 1 : 0), 0)
    // Coarsest seed = sparse splat (not every pixel set); finer seeds = upsampled
    // full-coverage depth (constant 7 from the mock ⇒ every pixel > 0).
    expect(nonZero(calls[0].seed)).toBeLessThan(calls[0].seed.length)
    expect(nonZero(calls[1].seed)).toBe(calls[1].seed.length)
    expect(nonZero(calls[2].seed)).toBe(calls[2].seed.length)
  })

  it('runs a single level when the working image is already at the coarse target', async () => {
    const { fn, calls } = makeMock()
    await depthMapForImage(ref, sources, packSparseForDense(points).pos, { coarseLong: 100 }, fn) // 40 ≤ 100
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

  it('fusionCostStats reports the p70 and median of the valid pixels', () => {
    const depth = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const cost = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    const { n, p70, median } = fusionCostStats([{ depth, cost }])
    expect(n).toBe(10)
    expect(p70).toBeCloseTo(0.7, 6)
    expect(median).toBeCloseTo(0.6, 6) // index round(0.5·9) = 5 (round half up)
  })

  it('fusionCostStats ignores holes', () => {
    const depth = Float32Array.from([1, 0, 1, 0])
    const cost = Float32Array.from([0.05, 9, 0.1, 9])
    const { n, p70 } = fusionCostStats([{ depth, cost }])
    expect(n).toBe(2)
    expect(p70).toBeCloseTo(0.1, 6)
  })

  it('fusion gates on the fixed default maxCost, not on the cost distribution', () => {
    // Uniform costs 0..1 over one map: the old adaptive gate (p70 clamped to ≤ 0.45)
    // kept under half; the fixed default keeps every pixel up to it.
    const n = 64
    const map = {
      uuid: 'm', width: 8, height: 8,
      K: { fx: 8, fy: 8, cx: 4, cy: 4 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
      depth: new Float32Array(n).fill(5),
      cost: Float32Array.from({ length: n }, (_, i) => i / (n - 1)),
      rgb: new Uint8Array(n * 3),
    }
    const logs = []
    fuseDepthMaps([map], {}, (m) => logs.push(m))
    expect(logs.some((m) => new RegExp(`maxCost ${DENSE_FUSE_DEFAULTS.maxCost}\\b`).test(m))).toBe(true)
  })

  it('fuseDepthMaps warns when the cost p70 signals a weak distribution', () => {
    // A single 2×2 map of high-cost valid pixels ⇒ p70 > 0.55 ⇒ warn logged.
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

  it('fusionCostStats returns the median and matches an exact sort on sampled input', () => {
    // A distribution large enough to force subsampling (maxSamples tiny) — the sampled
    // p50/p70 must land within a small tolerance of the exact percentiles.
    const N = 50_000
    const depth = new Float32Array(N).fill(1)
    const cost = new Float32Array(N)
    for (let i = 0; i < N; i++) cost[i] = i / (N - 1) // uniform 0..1
    const exactMedian = 0.5, exactP70 = 0.7
    const { median, p70, n } = fusionCostStats([{ depth, cost }], { maxSamples: 2000 })
    expect(n).toBe(N)                         // true valid count, not the sample size
    expect(median).toBeCloseTo(exactMedian, 2)
    expect(p70).toBeCloseTo(exactP70, 2)
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

  it('merges points outside the estimated bounds exactly instead of clamping them to the border', () => {
    // A 4×4 base slab plus a thin spire rising to z = 20 that the bounds estimate missed
    // (fusion samples every 16th pixel, so a pole narrower than that is never sampled).
    // Clamping put every spire point above the slab into one border cell; the overflow
    // map must keep one cell per unit of height, matching mergePointsSpatial.
    const base = []
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) base.push({ x: x + 0.5, y: y + 0.5, z: 0.5, color: [9, 9, 9] })
    const spire = Array.from({ length: 20 }, (_, k) => ({ x: 1.5, y: 1.5, z: k + 1.5, color: [200, 0, 0] }))
    const below = { x: 1.5, y: 1.5, z: -7.5, color: [0, 0, 200] } // and one past the other face
    const pts = [...base, ...spire, below]
    const acc = createVoxelAccumulator(1.0, boundsOf(base))
    for (const p of pts) acc.add(p.x, p.y, p.z, p.color[0], p.color[1], p.color[2])
    expect(acc.count).toBe(mergePointsSpatial(pts, 1.0).length)
    expect(acc.overflowCells).toBe(19 + 1) // z 2.5 … 20.5 above the 1-cell pad, plus −7.5
    const flat = acc.finalizeFlat()
    const zs = []
    for (let o = 0; o < flat.length; o += 6) if (flat[o + 3] === 200) zs.push(flat[o + 2])
    expect(zs.sort((p, q) => p - q)).toEqual(spire.map((p) => p.z)) // every spire cell kept, unaveraged
  })

  it('exact bounds never use the overflow map', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.37 - 9, y: -i * 0.11, z: i * 0.05 }))
    const acc = createVoxelAccumulator(0.25, boundsOf(pts))
    for (const p of pts) acc.add(p.x, p.y, p.z, 0, 0, 0)
    expect(acc.overflowCells).toBe(0)
  })

  it('filterIsolated sees neighbours across the packed grid / overflow boundary', () => {
    // Grid covers a single cell (+ pad); a 3-cell column continues straight up out of it
    // into overflow, and one lone overflow cell floats far away. The column's overflow
    // cells have in-grid and overflow neighbours and must survive; the lone one goes.
    const inside = { x: 0.5, y: 0.5, z: 0.5 }
    const column = [1.5, 2.5, 3.5].map((z) => ({ x: 0.5, y: 0.5, z }))
    const lone = { x: 40.5, y: 0.5, z: 0.5 }
    const acc = createVoxelAccumulator(1.0, boundsOf([inside]))
    for (const p of [inside, ...column, lone]) acc.add(p.x, p.y, p.z, 1, 1, 1)
    expect(acc.overflowCells).toBe(3) // z 2.5, 3.5 and the lone cell (z 1.5 is in the pad)
    expect(acc.filterIsolated({ radius: 1, minNeighbors: 1, maxSupport: 2 })).toBe(1)
    expect(acc.count).toBe(4)
    const flat = acc.finalizeFlat()
    for (let o = 0; o < flat.length; o += 6) expect(flat[o]).toBeLessThan(10) // lone cell gone
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

describe('createVoxelAccumulator index', () => {
  it('grows its slot arrays and hash table from a tiny capacity without losing cells', () => {
    // 50k distinct cells from capacity 16 forces many slot doublings and table rehashes;
    // every re-added point must land back in its own cell.
    const acc = createVoxelAccumulator(1.0, { minX: 0, minY: 0, minZ: 0, maxX: 500, maxY: 100, maxZ: 0 }, { capacity: 16 })
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 50000; i++) acc.add((i % 500) + 0.5, Math.floor(i / 500) + 0.5, 0.5, i % 256, 1, 2)
    }
    expect(acc.count).toBe(50000)
    const flat = acc.finalizeFlat()
    for (let s = 0; s < 50000; s += 4999) {
      expect(flat[s * 6]).toBeCloseTo((s % 500) + 0.5, 6)
      expect(flat[s * 6 + 1]).toBeCloseTo(Math.floor(s / 500) + 0.5, 6)
      expect(flat[s * 6 + 3]).toBe(s % 256) // integer colour sums are exact
    }
  })

  it('presizing leaves the reported footprint at the requested capacity', () => {
    const acc = createVoxelAccumulator(1.0, { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 }, { capacity: 1000 })
    for (let i = 0; i < 1000; i++) acc.add(i % 10 + 0.5, Math.floor(i / 10) % 10 + 0.5, Math.floor(i / 100) + 0.5, 0, 0, 0)
    expect(acc.count).toBe(1000)
    expect(acc.bytes).toBe(1000 * 60 + 2048 * 4) // no slot growth; table 2048 ≥ 2·1000
  })

  // V8 caps a Map at 2^24 entries; the old Map index threw "Map maximum size exceeded"
  // here. ~1.3 GB and several seconds, so opt-in.
  it.skipIf(!process.env.WEBSFM_SLOW_TESTS)('holds more than 2^24 cells', () => {
    const N = 2 ** 24 + 1000, side = 4200
    const acc = createVoxelAccumulator(1.0, { minX: 0, minY: 0, minZ: 0, maxX: side, maxY: side, maxZ: 0 }, { capacity: N })
    for (let i = 0; i < N; i++) acc.add((i % side) + 0.5, Math.floor(i / side) + 0.5, 0.5, 0, 0, 0)
    expect(acc.count).toBe(N)
  }, 120_000)
})

describe('fusion pre-flight (measured cell count)', () => {
  // Two identical fronto-parallel views of a plane at depth 1 (fx 100 ⇒ GSD 0.01).
  const mk = (uuid, W = 40, H = 40) => ({
    uuid, width: W, height: H,
    // cx/cy off the pixel grid by ½ so no pixel lands exactly on a cell boundary.
    K: { fx: 100, fy: 100, cx: W / 2 + 0.5, cy: H / 2 + 0.5 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0],
    depth: new Float32Array(W * H).fill(1),
    cost: new Float32Array(W * H).fill(0.1),
    rgb: new Uint8Array(W * H * 3).fill(128),
  })
  const opts = { minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false, mergeCell: 0.02 }

  it('counts the merge cells exactly on a small scene and bounds the fused count', () => {
    const out = fuseDepthMaps([mk('a'), mk('b')], opts, () => {})
    // 40 px at 0.01 span −0.205…0.185 ⇒ 21 cells of 0.02 per axis, and both views land
    // in the same cells.
    expect(out.summary.estimatedCells).toBe(441)
    expect(out.length / 6).toBeLessThanOrEqual(out.summary.estimatedCells)
  })

  it('the estimate follows the fusion step and the merge cell', () => {
    const fine = fuseDepthMaps([mk('a'), mk('b')], { ...opts, mergeCell: 0.01 }, () => {})
    const stepped = fuseDepthMaps([mk('a'), mk('b')], { ...opts, mergeCell: 0.01, step: 2 }, () => {})
    expect(fine.summary.estimatedCells).toBe(1600)
    expect(stepped.summary.estimatedCells).toBe(400)
  })

  it('hash sampling stays close to the exact count once the scene exceeds the sample cap', () => {
    const exact = fuseDepthMaps([mk('a', 240, 240), mk('b', 240, 240)], { ...opts, mergeCell: 0.01 }, () => {}).summary.estimatedCells
    expect(exact).toBe(240 * 240)
    const cap = DENSE_TUNING.fuseEstimateSampleCap
    DENSE_TUNING.fuseEstimateSampleCap = 1024
    try {
      const sampled = fuseDepthMaps([mk('a', 240, 240), mk('b', 240, 240)], { ...opts, mergeCell: 0.01 }, () => {}).summary.estimatedCells
      expect(Math.abs(sampled / (exact * DENSE_TUNING.fuseEstimateMargin) - 1)).toBeLessThan(0.15)
    } finally { DENSE_TUNING.fuseEstimateSampleCap = cap }
  })

  it('refuses over budget before fusing, without throwing', () => {
    const logs = []
    const out = fuseDepthMaps([mk('a'), mk('b')], { ...opts, memBudgetBytes: 1000 }, (m, l) => logs.push([m, l]))
    expect(out.length).toBe(0)
    expect(out.refused.cells).toBe(441)
    expect(out.refused.total).toBeGreaterThan(1000)
    expect(logs.some(([m, l]) => l === 'error' && m.includes('aborting before the consistency pass'))).toBe(true)
    const ok = fuseDepthMaps([mk('a'), mk('b')], { ...opts, memBudgetBytes: 1e9 }, () => {})
    expect(ok.refused).toBeUndefined()
    expect(ok.length).toBeGreaterThan(0)
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
    maps[0].name = 'reference.jpg'
    maps[0].depth[CENTER] = 2 // a flyer at 2× the true depth, low cost (looks confident)
    const logs = []
    filterDepthMapsGeometric(maps, { minConsistent: 1 }, (m) => logs.push(m))
    // The round trip through b's own depth lands ~5 px away ⇒ b does not vouch for it.
    expect(maps[0].depth[CENTER]).toBe(0)
    expect(maps[0].filterStats.inconsistent).toBeGreaterThan(0)
    expect(maps[0].filterStats.keptPct).toBeGreaterThanOrEqual(0)
    expect(maps[0].filterStats.keptPct).toBeLessThanOrEqual(100)
    expect(logs.some((m) => m.includes('reference.jpg'))).toBe(true)
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

  it('frustum cull is exact: same planes as walking every map, with fewer candidates', async () => {
    // A 6×3 nadir grid over a sloped ground plane, with seeded noise: flyers (depth
    // ×0.5–2), holes, and low-NCC pixels. Far-apart cameras share no ground, so the cull
    // must drop them — and must never drop a map the full walk would have used.
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const S = 24, K = { fx: 24, fy: 24, cx: 12, cy: 12 }
    const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]] // looking straight down
    const mk = (cx, cy, cz) => {
      const t = [-cx, cy, cz] // t = −R·C
      const depth = new Float32Array(S * S), cost = new Float32Array(S * S).fill(0.2)
      for (let v = 0; v < S; v++) {
        for (let u = 0; u < S; u++) {
          // ray (world) = Rᵀ·((u−cx)/fx, (v−cy)/fy, 1); ground z = 0.05·x
          const dx = (u - K.cx) / K.fx, dy = -(v - K.cy) / K.fy, dz = -1
          const s = (0.05 * cx - cz) / (dz - 0.05 * dx)
          const r = rnd(), k = v * S + u
          depth[k] = r < 0.05 ? 0 : r < 0.15 ? s * (0.5 + 1.5 * rnd()) : s
          if (rnd() < 0.05) cost[k] = 0.95
        }
      }
      return { uuid: `${cx},${cy}`, width: S, height: S, K, R, t, depth, cost }
    }
    const build = () => {
      seed = 7
      const out = []
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) out.push(mk(i * 6, j * 6, 10))
      return out
    }
    const a = build(), b = build()
    const sa = filterDepthMapsGeometric(a, { minConsistent: 2 }, () => {})
    const sb = filterDepthMapsGeometric(b, { minConsistent: 2, cull: false }, () => {})
    expect(sa).toEqual(sb)
    for (let i = 0; i < a.length; i++) expect(a[i].depth).toEqual(b[i].depth)
    expect(sa.inconsistent).toBeGreaterThan(0) // the flyers were actually judged

    // The streamed filter (planes read on demand through a tiny LRU, so most reads
    // miss) reaches the same verdict on every pixel.
    const c = build()
    const metas = c.map(({ depth, cost, ...meta }) => meta)
    let reads = 0
    const io = {
      loadReference: async (i) => ({ depth: c[i].depth, cost: c[i].cost }),
      loadDepth: async (i) => { reads++; return c[i].depth },
    }
    const sc = await filterDepthMapsGeometricStreamed(metas, io, { minConsistent: 2, cacheBytes: 3 * S * S * 4 }, () => {})
    expect(sc.totals).toEqual(sa)
    expect(reads).toBeGreaterThan(c.length) // the cache really evicted
    for (let i = 0; i < c.length; i++) {
      expect(applyPackedMask(Float32Array.from(c[i].depth), sc.masks[i])).toEqual(a[i].depth)
      expect(sc.stats[i]).toEqual(a[i].filterStats)
    }

    // Split over workers (disjoint contiguous reference chunks, as the store does):
    // the merged masks, stats and totals are the single run's.
    const chunks = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9, 10], [11, 12, 13, 14, 15, 16, 17]]
    const merged = { considered: 0, kept: 0, lowNcc: 0, inconsistent: 0, lowParallax: 0 }
    for (const refs of chunks) {
      const p = await filterDepthMapsGeometricStreamed(metas, io, { minConsistent: 2, cacheBytes: S * S * 4, refs, summaryLogs: false }, () => {})
      for (const k of Object.keys(merged)) merged[k] += p.totals[k]
      for (const i of refs) {
        expect(applyPackedMask(Float32Array.from(c[i].depth), p.masks[i])).toEqual(a[i].depth)
        expect(p.stats[i]).toEqual(a[i].filterStats)
      }
    }
    expect(merged).toEqual(sc.totals)

    const cand = filterCandidates(build())
    const total = cand.reduce((n, c) => n + c.length, 0)
    expect(total).toBeLessThan(18 * 17) // the corner cameras see none of each other
    expect(total).toBeGreaterThan(0)
  })

  it('does not let a near-duplicate view vouch for a pixel (parallax gate)', () => {
    // b sits 1 mm from a: at ~0° parallax the forward–backward round trip is vacuous —
    // a "sky" pixel at depth 50 projects into b, picks up b's surface at depth 1 and
    // still lands 0.1 px from home. c (10 cm away) sees through the claim. With
    // minConsistent 1, b alone would keep the sky pixel; the gate must refuse b's vote
    // and report the drop as low parallax, while the true surface (c vouches) stays.
    const build = () => {
      const maps = [mkPlane('a', 0), mkPlane('b', -0.001), mkPlane('c', -0.1)]
      maps[0].depth[CENTER] = 50
      return maps
    }
    const ungated = build()
    filterDepthMapsGeometric(ungated, { minConsistent: 1, minGeomAngleDeg: 0 }, () => {})
    expect(ungated[0].depth[CENTER]).toBe(50) // the vacuous vote kept it

    const maps = build()
    const logs = []
    const s = filterDepthMapsGeometric(maps, { minConsistent: 1, minGeomAngleDeg: 3 }, (m) => logs.push(m))
    expect(maps[0].depth[CENTER]).toBe(0)
    // (Also the right-edge strip that only b sees: it, too, has no real second view.)
    expect(maps[0].filterStats.lowParallax).toBeGreaterThan(0)
    expect(s.lowParallax).toBeGreaterThanOrEqual(1)
    expect(maps[0].depth[at(10, 16)]).toBeGreaterThan(0) // real surface: c vouches at 5.7°
    expect(logs.some((m) => m.includes('parallax'))).toBe(true)
  })

  it('applies the parallax gate by default (COLMAP 3°)', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.001)] // only a near-duplicate view
    const s = filterDepthMapsGeometric(maps, { minConsistent: 1 }, () => {})
    expect(maps[0].depth[CENTER]).toBe(0)
    expect(s.lowParallax).toBe(s.considered)
    expect(s.inconsistent).toBe(0)
  })

  it('is disabled by minConsistent 0 (NCC floor only)', () => {
    const maps = [mkPlane('a', 0), mkPlane('b', -0.1)]
    maps[0].depth[CENTER] = 2 // a flyer that the cross-view check would drop
    const s = filterDepthMapsGeometric(maps, { minConsistent: 0 }, () => {})
    expect(maps[0].depth[CENTER]).toBe(2)
    expect(s.inconsistent).toBe(0)
  })
})

describe('geomFilterLoopShare (Stage A progress split)', () => {
  it('gives the loop nearly all of the bar when PatchMatch is slow (WASM)', () => {
    // 60 s/image vs 1 MP × 0.4 µs/px = 0.4 s of filter per map
    const s = geomFilterLoopShare({ loopMs: 600_000, done: 10, total: 100, pxDone: 10e6, usPerPx: 0.4 })
    expect(s).toBeGreaterThan(0.99 - 1e-9)
  })
  it('gives the filter most of the bar when PatchMatch is fast (GPU)', () => {
    // 0.2 s/image vs 0.4 s/map of filter ⇒ loop owns a third
    const s = geomFilterLoopShare({ loopMs: 2_000, done: 10, total: 100, pxDone: 10e6, usPerPx: 0.4 })
    expect(s).toBeCloseTo(1 / 3, 6)
  })
  it('has no opinion before the first image is measured', () => {
    expect(geomFilterLoopShare({ loopMs: 0, done: 0, total: 10, pxDone: 0 })).toBe(null)
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

describe('user-facing numeric options (engine-boundary sanitizing)', () => {
  // A cleared <input v-model.number> hands back '' (and partial input NaN). Destructuring
  // defaults only replace undefined, so '' used to reach the loops: `v += ''` made the
  // row index the string "0" and fusion never finished.
  const mk = (uuid, tx) => ({
    uuid, width: 24, height: 24,
    K: { fx: 100, fy: 100, cx: 12.5, cy: 12.5 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [tx, 0, 0],
    depth: new Float32Array(24 * 24).fill(1),
    cost: new Float32Array(24 * 24).fill(0.1),
    rgb: new Uint8Array(24 * 24 * 3).fill(128),
  })

  it('fusionGates falls back to the documented defaults for blank / non-finite / out-of-range values', () => {
    const defaults = fusionGates({})
    expect(defaults).toMatchObject({
      step: DENSE_FUSE_DEFAULTS.step, depthTolRel: DENSE_FUSE_DEFAULTS.depthTolPct / 100,
      consistencyPx: DENSE_TUNING.consistencyPx, minTriAngleDeg: DENSE_FUSE_DEFAULTS.minTriAngleDeg,
      maxIncidenceDeg: DENSE_FUSE_DEFAULTS.maxIncidenceDeg, removeIsolated: DENSE_FUSE_DEFAULTS.removeIsolated,
    })
    for (const bad of ['', '  ', NaN, null, undefined, Infinity, -Infinity, 'abc', {}, []]) {
      const g = fusionGates({ step: bad, depthTolRel: bad, consistencyPx: bad, minTriAngleDeg: bad, maxIncidenceDeg: bad, removeIsolated: bad })
      expect(g).toEqual(defaults)
    }
    // Out of range: a zero/negative step, a zero tolerance (a cleared % field ÷ 100).
    expect(fusionGates({ step: 0 }).step).toBe(1)
    expect(fusionGates({ step: -3 }).step).toBe(1)
    expect(fusionGates({ step: 0.5 }).step).toBe(1)
    expect(fusionGates({ depthTolRel: 0 }).depthTolRel).toBe(defaults.depthTolRel)
    expect(fusionGates({ depthTolRel: '' / 100 }).depthTolRel).toBe(defaults.depthTolRel)
    expect(fusionGates({ depthTolRel: -0.02 }).depthTolRel).toBe(defaults.depthTolRel)
    expect(fusionGates({ minTriAngleDeg: -1 }).minTriAngleDeg).toBe(defaults.minTriAngleDeg)
    // Valid values pass through; a step is an integer.
    expect(fusionGates({ step: 2.7 }).step).toBe(2)
    expect(fusionGates({ step: '3' }).step).toBe(3)
    expect(fusionGates({ depthTolRel: 0.05, minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false }))
      .toMatchObject({ depthTolRel: 0.05, minTriAngleDeg: 0, maxIncidenceDeg: 0, removeIsolated: false, incidenceOn: false })
  })

  it('a fusion with blank fields terminates and fuses exactly what the defaults fuse', () => {
    const maps = () => [mk('a', 0), mk('b', -0.1), mk('c', -0.2)]
    const expected = fuseDepthMaps(maps(), {}, () => {})
    expect(expected.length).toBeGreaterThan(0)
    const blank = fuseDepthMaps(maps(), {
      step: '', depthTolRel: '' / 100, minViews: '', maxCost: '', minTriAngleDeg: '', maxIncidenceDeg: NaN,
      removeIsolated: '', mergeCell: '',
    }, () => {})
    expect([...blank]).toEqual([...expected])
    expect(blank.summary).toEqual(expected.summary)
  })

  it('the streamed runner terminates on a blank step too', async () => {
    const ms = [mk('a', 0), mk('b', -0.1)]
    const expected = fuseDepthMaps(ms, {}, () => {})
    const out = await fuseDepthMapsStreamed(ms, async (i) => ms[i], { step: '', depthTolRel: NaN }, () => {})
    expect([...out]).toEqual([...expected])
  })

  it('minViews / maxCost: blank means auto / the default gate, real values pass', () => {
    const ms = () => [mk('a', 0), mk('b', -0.1), mk('c', -0.2)]
    const logs = []
    fuseDepthMaps(ms(), { minViews: '', maxCost: NaN }, (m) => logs.push(m))
    expect(logs.find((m) => m.includes('minViews'))).toContain(`minViews 2, maxCost ${DENSE_FUSE_DEFAULTS.maxCost}`)
    logs.length = 0
    fuseDepthMaps(ms(), { minViews: 0, maxCost: -1 }, (m) => logs.push(m))
    expect(logs.find((m) => m.includes('minViews'))).toContain(`minViews 2, maxCost ${DENSE_FUSE_DEFAULTS.maxCost}`)
    logs.length = 0
    fuseDepthMaps(ms(), { minViews: 1, maxCost: 0.5 }, (m) => logs.push(m))
    expect(logs.find((m) => m.includes('minViews'))).toContain('minViews 1, maxCost 0.5')
  })

  it('filterConfig / filterSettings fall back to DEPTHMAP_DEFAULTS', () => {
    const blank = { minNcc: '', maxGeomCost: NaN, minConsistent: '', minGeomAngleDeg: '', cull: '' }
    const want = { minNcc: DEPTHMAP_DEFAULTS.minNcc, maxGeomCost: DEPTHMAP_DEFAULTS.maxGeomCost,
      minConsistent: DEPTHMAP_DEFAULTS.minConsistent, minGeomAngleDeg: DEPTHMAP_DEFAULTS.minGeomAngleDeg }
    expect(filterSettings(blank)).toEqual(want)
    expect(filterConfig(blank)).toEqual(filterConfig({}))
    expect(filterConfig({ maxGeomCost: 0, minConsistent: -1, minNcc: 2, minGeomAngleDeg: -5 })).toEqual(filterConfig({}))
    // 0 consistent views is the documented "off" switch, not out of range.
    expect(filterConfig({ minConsistent: 0 }).minConsistent).toBe(0)
    expect(filterConfig({ minConsistent: 3, minNcc: 0.3, cull: false })).toMatchObject({ minConsistent: 3, minNcc: 0.3, cull: false })
  })

  it('depthMapSettings falls back to the defaults for the Stage A knobs', () => {
    const d = depthMapSettings({})
    expect(d).toMatchObject({
      quality: DEPTHMAP_DEFAULTS.quality, maxSources: DEPTHMAP_DEFAULTS.maxSources, window: DEPTHMAP_DEFAULTS.window,
      iterations: DEPTHMAP_DEFAULTS.iterations, bestK: null, filterRelTol: DEPTHMAP_DEFAULTS.filterRelTol / 100,
      filterRadius: 1, coarseLong: DENSE_TUNING.coarseLong, minAngleDeg: DENSE_TUNING.minAngleDeg,
      speckleFilter: true, geomConsistency: true, streamMaps: false,
      maxGeomCost: DEPTHMAP_DEFAULTS.maxGeomCost, minConsistent: DEPTHMAP_DEFAULTS.minConsistent,
      minNcc: DEPTHMAP_DEFAULTS.minNcc, minGeomAngleDeg: DEPTHMAP_DEFAULTS.minGeomAngleDeg,
    })
    const blank = depthMapSettings({
      quality: '', maxDim: '', maxSources: '', minAngleDeg: NaN, window: '', iterations: '', bestK: '',
      filterRadius: '', filterRelTol: '' / 100, coarseLong: '', maxGeomCost: '', minConsistent: '', minNcc: '',
      minGeomAngleDeg: '', speckleFilter: '', geomConsistency: '', streamMaps: '',
    })
    expect(blank).toEqual(d)
    expect(depthMapSettings({ iterations: 0, window: -1, maxSources: 0, bestK: 0, maxDim: 0 })).toEqual(d)
    expect(depthMapSettings({ window: 4, iterations: 5, bestK: 2, maxDim: 1200, quality: 'high' }))
      .toMatchObject({ window: 4, iterations: 5, bestK: 2, maxDim: 1200, quality: 'high' })
  })

  it('depthMapForImage hands the kernel numbers even when the knobs arrive blank', async () => {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], K = { fx: 40, fy: 40, cx: 20, cy: 20 }
    const ref = { gray: new Uint8Array(1600), width: 40, height: 40, K, cam: { R: I, t: [0, 0, 0] } }
    const src = [{ gray: new Uint8Array(1600), w: 40, h: 40, K, cam: { R: I, t: [-1, 0, 0] } }]
    const pos = packSparseForDense([{ x: 0, y: 0, z: 5 }, { x: 0.1, y: 0, z: 7 }, { x: 0, y: 0.1, z: 9 }]).pos
    const seen = []
    const fn = async (g, w, h, k, srcs, opts) => {
      seen.push(opts)
      return { depth: new Float32Array(w * h).fill(7), cost: new Float32Array(w * h).fill(0.1), width: w, height: h }
    }
    await depthMapForImage(ref, src, pos, { window: '', iterations: '', bestK: NaN, coarseLong: '' }, fn)
    expect(seen.length).toBe(1) // 40 px ≤ the default coarseLong: one level
    expect(seen[0]).toMatchObject({ window: DEPTHMAP_DEFAULTS.window, iterations: DEPTHMAP_DEFAULTS.iterations, bestK: 3 })
  })

  it('filterDepthMap treats blank radius / tolerance as the defaults', () => {
    const depth = plane([[5, 5, 5], [5, 100, 5], [5, 5, 5]])
    expect(filterDepthMap(depth, 3, 3, { radius: '', relTol: NaN, minValidNeighbors: '' }))
      .toEqual(filterDepthMap(depth, 3, 3, {}))
  })
})

describe('depthMapForImage — odd-sized pyramid levels', () => {
  // 41×40 with coarseLong 20 ⇒ two levels, 41×40 → 20×20. The box downsample drops the
  // last odd column, so the coarse grid is the fine one at exactly ½ — not 20/41.
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const K = { fx: 40, fy: 40, cx: 20, cy: 20 }
  const W = 41, H = 40
  const ref = { gray: new Uint8Array(W * H), width: W, height: H, K, cam: { R: I, t: [0, 0, 0] } }
  const sources = [{ gray: new Uint8Array(W * H), w: W, h: H, K, cam: { R: I, t: [-1, 0, 0] } }]
  const pos = packSparseForDense([{ x: 0, y: 0, z: 5 }, { x: 0.1, y: 0, z: 6 }, { x: 0, y: 0.1, z: 7 }, { x: -0.1, y: 0, z: 8 }]).pos

  it('projects a point onto the coarse pixel the box filter put its fine pixel in', async () => {
    const calls = []
    const fn = async (g, w, h, k, srcs, opts) => {
      calls.push({ w, h, K: k, srcK: srcs[0].K, seed: opts.seedDepth })
      // The coarse level answers with depth = 1 + its column, so the next level's seed
      // shows which coarse pixel each fine pixel was upsampled from.
      const depth = new Float32Array(w * h)
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) depth[v * w + u] = 1 + u
      return { depth, cost: new Float32Array(w * h).fill(0.1), width: w, height: h }
    }
    await depthMapForImage(ref, sources, pos, { coarseLong: 20 }, fn)
    expect(calls.map((c) => [c.w, c.h])).toEqual([[20, 20], [41, 40]])
    // A world point that projects onto fine pixel u = 38 (centre). Fine columns 38–39 are
    // box-averaged into coarse column 19, at coarse coordinate (38 + ½)·½ − ½ = 18.75.
    const z = 4, x = (38 - K.cx) / K.fx * z
    for (const Kc of [calls[0].K, calls[0].srcK]) {
      expect(Kc.fx).toBe(K.fx / 2)
      expect(Kc.fy).toBe(K.fy / 2)
      const u = Kc.fx * x / z + Kc.cx
      expect(u).toBeCloseTo(18.75, 10)
      expect(Math.round(u)).toBe(19)
    }
    // Nearest upsample: fine column u came from coarse column ⌊u/2⌋ (the cropped last
    // fine column 40 maps to the last coarse one, 19).
    const seed = calls[1].seed
    for (let u = 0; u < W; u++) expect(seed[10 * W + u]).toBe(1 + Math.min(19, u >> 1))
  })
})

describe('depthMapForImage — Region seeding', () => {
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const K = { fx: 40, fy: 40, cx: 20, cy: 20 }
  const W = 40, H = 40
  const ref = { gray: new Uint8Array(W * H), width: W, height: H, K, cam: { R: I, t: [0, 0, 0] } }
  const sources = [{ gray: new Uint8Array(W * H), w: W, h: H, K, cam: { R: I, t: [-1, 0, 0] } }]

  it('seeds only from the sparse points inside the Region', async () => {
    // Two points inside the Region (depth 5–5.5) and one behind it on the same ray as
    // the first — listed last, so it used to overwrite the good seed at the centre pixel.
    const pos = packSparseForDense([{ x: 0, y: 0, z: 5 }, { x: 0.1, y: 0, z: 5.5 }, { x: 0, y: 0, z: 9 }]).pos
    const region = { min: [-1, -1, 4], max: [1, 1, 6] }
    let seed = null, range = null
    const fn = async (g, w, h, k, srcs, opts) => {
      seed = opts.seedDepth; range = [opts.depthMin, opts.depthMax]
      return { depth: new Float32Array(w * h).fill(5), cost: new Float32Array(w * h).fill(0.1), width: w, height: h }
    }
    await depthMapForImage(ref, sources, pos, { coarseLong: 100, region }, fn)
    expect(seed[20 * W + 20]).toBe(5)
    for (const d of seed) if (d > 0) { expect(d).toBeGreaterThanOrEqual(range[0]); expect(d).toBeLessThanOrEqual(range[1]) }
  })
})

describe('filterDepthMapsGeometricStreamed — candidate cache bound', () => {
  // Eight mutually visible maps of a plane, so every reference's candidates are the seven
  // others; a cache of 2.5 planes can never hold them, and must never hold more.
  const W = 32, H = 32
  const mk = (j) => ({
    uuid: `m${j}`, width: W, height: H,
    K: { fx: 100, fy: 100, cx: 16, cy: 16 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [-0.02 * j, 0, 0],
    depth: new Float32Array(W * H).fill(1), cost: new Float32Array(W * H).fill(0.1),
  })
  const run = async (maps, cacheBytes) => {
    const metas = maps.map(({ depth, cost, ...meta }) => meta)
    let loads = 0
    const io = {
      loadReference: async (i) => ({ depth: maps[i].depth, cost: maps[i].cost }),
      // A fresh copy per read: only the filter's own cache can keep a plane alive.
      loadDepth: async (i) => { loads++; return Float32Array.from(maps[i].depth) },
    }
    const out = await filterDepthMapsGeometricStreamed(metas, io, { minConsistent: 2, cacheBytes }, () => {})
    return { ...out, counted: loads }
  }

  it('never holds more than max(bound, the current reference\'s candidates)', async () => {
    const maps = Array.from({ length: 8 }, (_, j) => mk(j))
    const plane = W * H * 4
    const cand = filterCandidates(maps)
    const candBytes = Math.max(...cand.map((c) => c.length * plane))
    for (const cacheBytes of [2.5 * plane, 6.5 * plane, 7.5 * plane, 20 * plane]) {
      const out = await run(maps, cacheBytes)
      expect(out.loads).toBe(out.counted)
      expect(out.peakCached).toBeLessThanOrEqual(Math.max(cacheBytes, candBytes))
    }
    // With a bound above the candidates' bytes (7 planes), the bound itself is never
    // exceeded — the old order (load all, evict after) held the previous reference's
    // planes on top of this one's: 8 planes here.
    const out = await run(maps, 7.5 * plane)
    expect(out.peakCached).toBeLessThanOrEqual(7.5 * plane)
    // And the verdicts are the in-memory filter's.
    const resident = maps.map((m) => ({ ...m, depth: Float32Array.from(m.depth) }))
    const totals = filterDepthMapsGeometric(resident, { minConsistent: 2 }, () => {})
    expect(out.totals).toEqual(totals)
  })
})

describe('fuseDepthMapsStreamed — eligible-pixel buffers', () => {
  const mk = (W, H) => {
    const depth = new Float32Array(W * H).fill(2), cost = new Float32Array(W * H).fill(0.1)
    for (let i = 0; i < W * H; i += 7) depth[i] = 0
    for (let i = 3; i < W * H; i += 11) cost[i] = 0.95
    return { width: W, height: H, K: { fx: 50, fy: 50, cx: W / 2, cy: H / 2 }, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], depth, cost }
  }
  // The reference loop it replaces: every pixel on the step grid with valid depth, past
  // the cost gate and (tiled) inside the slab, in row-major order.
  const brute = (m, { step, maxCost, slab }) => {
    const idx = [], wp = []
    for (let v = 0; v < m.height; v += step) for (let u = 0; u < m.width; u += step) {
      const i = v * m.width + u, d = m.depth[i]
      if (!(d > 0) || m.cost[i] > maxCost) continue
      const x = (u - m.K.cx) / m.K.fx * d, y = (v - m.K.cy) / m.K.fy * d
      const P = { x, y, z: d }
      if (slab) { const ca = Math.floor(P[slab.key] * slab.inv); if (ca < slab.lo || ca >= slab.hi) continue }
      idx.push(i); wp.push(P.x, P.y, P.z)
    }
    return { idx, wp }
  }

  it.each([
    { step: 1, maxCost: 0.8, slab: null },
    { step: 2, maxCost: 0.8, slab: null },
    { step: 1, maxCost: 0.8, slab: { key: 'x', inv: 10, lo: -3, hi: 4 } },
    { step: 3, maxCost: 0.05, slab: null },
  ])('collects them into exactly sized typed arrays, in scan order: %j', (opts) => {
    const m = mk(37, 23)
    const got = streamedEligible(m, opts)
    const want = brute(m, opts)
    expect(got.idx).toBeInstanceOf(Int32Array)
    expect(got.wp).toBeInstanceOf(Float64Array)
    expect(got.idx.length).toBe(want.idx.length)
    expect(got.wp.length).toBe(3 * want.idx.length)
    expect(got.idx.buffer.byteLength).toBe(4 * want.idx.length) // not a view of a larger buffer
    expect(got.wp.buffer.byteLength).toBe(24 * want.idx.length)
    expect([...got.idx]).toEqual(want.idx)
    expect([...got.wp]).toEqual(want.wp)
  })
})
