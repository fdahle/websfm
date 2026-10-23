import { setBigArrayCaps } from '../bigArray.js'
import { DENSIFY_CELL_BYTES } from './memBudget.js'
import { describe, it, expect } from 'vitest'
import { fuseDepthMaps, fuseDepthMapsStreamed, finishFusion, mergeFusionCounters } from './mvs.js'
import { orthorectify, orthorectifyStreamed, orthorectifyTiled } from '../products/ortho.js'
import { resampleSurface, resampledGeometry } from '../products/surface.js'
import { orthoStats } from '../eval/orthoStats.js'
import { serializeDepthMap } from './depthMapCodec.js'
import { readDepthFiles, readDepthOnly, readDepthCostMap } from './depthFileReader.js'

function maps() {
  return Array.from({ length: 4 }, (_, j) => {
    const n = 32 * 32
    return {
      uuid: String(j),
      width: 32,
      height: 32,
      K: { fx: 30, fy: 30, cx: 16, cy: 16 },
      R: [
        [1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
      ],
      t: [-j / 4, 0, 10],
      depth: Float32Array.from({ length: n }, (_, i) => (i % 53 === j ? 0 : 10)),
      cost: Float32Array.from({ length: n }, (_, i) => (i % 13) / 30),
      rgb: Uint8Array.from({ length: n * 3 }, (_, i) => (i * 7 + j * 23) % 256),
      normals: Float32Array.from({ length: n * 3 }, (_, i) => (i % 3 === 2 ? -1 : 0)),
    }
  })
}
function files(ms) {
  return ms.map((m) => {
    const { meta, buffers } = serializeDepthMap(m)
    return {
      ...meta,
      files: Object.fromEntries(Object.entries(buffers).map(([k, b]) => [k, b ? new Blob([b]) : null])),
    }
  })
}
describe('bounded map loading', () => {
  it.each([{}, { minViews: 1, minTriAngleDeg: 0, step: 2 }, { mergeCell: 0, maxCost: 0.25, removeIsolated: false }])(
    'fusion agrees exactly with resident maps: %j',
    async (opts) => {
      const ms = maps(),
        entries = files(ms),
        expected = fuseDepthMaps(ms, opts)
      const actual = await fuseDepthMapsStreamed(entries, (i) => readDepthFiles(entries[i]), opts)
      expect(actual.length).toBeGreaterThan(0)
      expect([...actual]).toEqual([...expected])
      expect([...actual.nrm]).toEqual([...expected.nrm])
      expect(actual.summary).toEqual(expected.summary)
    },
  )
  it('reads only depth and cost for the pre-passes, and fuses the identical cloud', async () => {
    const ms = maps(),
      entries = files(ms),
      expected = fuseDepthMaps(ms, {})
    let full = 0,
      light = 0
    const actual = await fuseDepthMapsStreamed(
      entries,
      (i) => (full++, readDepthFiles(entries[i])),
      {},
      () => {},
      { loadLight: (i) => (light++, readDepthCostMap(entries[i])), loadDepth: (i) => readDepthOnly(entries[i]) },
    )
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    expect(light).toBeGreaterThanOrEqual(3 * entries.length) // every pre-pass (saved maps skip the count)
    expect(full).toBe(entries.length) // the fusion pass: each reference once
  })

  it('caps the views per map identically in both runners, and reads fewer planes', async () => {
    // Four maps all see each other: with maxViews 1 each compares with one view only.
    const opts = { maxViews: 1, minViews: 1, minTriAngleDeg: 0 }
    const ms = maps(),
      entries = files(ms),
      expected = fuseDepthMaps(ms, opts)
    let reads = 0
    const load = { loadDepth: (i) => (reads++, readDepthOnly(entries[i])) }
    const actual = await fuseDepthMapsStreamed(
      entries,
      (i) => readDepthFiles(entries[i]),
      opts,
      () => {},
      load,
    )
    expect(actual.length).toBeGreaterThan(0)
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    expect(reads).toBeLessThanOrEqual(4)
  })

  it('culls maps out of view and caches planes, and still fuses the identical cloud', async () => {
    // Two groups 1 km apart: neither sees the other, so every cross-group pair is culled.
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 1000, 0, 10] }))]
    const entries = files(ms),
      expected = fuseDepthMaps(ms, {})
    const logs = []
    let reads = 0
    const actual = await fuseDepthMapsStreamed(
      entries,
      (i) => readDepthFiles(entries[i]),
      { cacheBytes: 2 * 32 * 32 * 4 },
      (m) => logs.push(m),
      {
        loadDepth: (i) => {
          reads++
          return readDepthOnly(entries[i])
        },
      },
    )
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    const culled = Number(/\((\d+) culled/.exec(logs.find((m) => m.includes('culled as out of view')))[1])
    expect(culled).toBe(8 * 4) // each map skips the 4 of the other group
    expect(reads).toBeLessThan(8 * 7)
  })

  it('plans its comparison cache on the known request sequence (fewer reads, same cloud)', async () => {
    // Four mutually visible maps, a two-plane cache: 12 requests, nearest camera first.
    // Evicting the plane wanted furthest ahead read 8 planes over that sequence (LRU
    // missed on all 12); a reference whose pixels are all settled early skips the rest
    // of its views, which saves one more read here.
    const ms = maps(),
      entries = files(ms),
      expected = fuseDepthMaps(ms, {})
    let reads = 0
    const actual = await fuseDepthMapsStreamed(
      entries,
      (i) => readDepthFiles(entries[i]),
      { cacheBytes: 2 * 32 * 32 * 4 },
      () => {},
      {
        loadDepth: (i) => {
          reads++
          return readDepthOnly(entries[i])
        },
      },
    )
    expect([...actual]).toEqual([...expected])
    expect(reads).toBe(7)
  })

  // Tiled fusion emits slab by slab, so the rows come in another order: compare the
  // multiset of [x,y,z,r,g,b,nx,ny,nz] rows.
  const rows = (flat) =>
    Array.from({ length: flat.length / 6 }, (_, i) =>
      [...flat.subarray(i * 6, i * 6 + 6), ...flat.nrm.subarray(i * 3, i * 3 + 3)].join(','),
    ).sort()
  // The cloud (27 B/cell) beside one slab's accumulator less its own share of the cloud.
  const slabBudget = (refused, slabsWanted) =>
    refused.input + 27 * refused.cells + (DENSIFY_CELL_BYTES - 27) * Math.ceil(refused.cells / slabsWanted)
  it.each([
    {},
    { step: 2 },
    { removeIsolated: false, mergeCell: 0.2 },
    { minViews: 1, minTriAngleDeg: 0, mergeCell: 0.15 },
  ])('over budget, fusion in slabs builds the identical cloud: %j', async (opts) => {
    // Two groups far apart along x (the slab axis), so some slabs skip some maps.
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
    const one = fuseDepthMaps(ms, opts)
    const tiled = fuseDepthMaps(ms, {
      ...opts,
      memBudgetBytes: slabBudget(fuseDepthMaps(ms, { ...opts, memBudgetBytes: 1, autoStep: false }).refused, 5),
    })
    expect(tiled.refused).toBeUndefined()
    expect(tiled.summary.slabs).toBeGreaterThan(2)
    expect(one.length).toBeGreaterThan(0)
    expect(rows(tiled)).toEqual(rows(one))
    expect({ ...tiled.summary, slabs: 1 }).toEqual(one.summary)

    const entries = files(ms),
      io = [(i) => readDepthFiles(entries[i]), { cacheBytes: 3 * 32 * 32 * 4 }]
    const sOpts = { ...opts, ...io[1] }
    const refused = (await fuseDepthMapsStreamed(entries, io[0], { ...sOpts, memBudgetBytes: 1, autoStep: false }))
      .refused
    const parts = []
    const streamed = await fuseDepthMapsStreamed(
      entries,
      io[0],
      { ...sOpts, memBudgetBytes: slabBudget(refused, 5) },
      () => {},
      { loadDepth: (i) => readDepthOnly(entries[i]), onTile: (part) => parts.push(part) },
    )
    expect(streamed.length).toBe(0)
    expect(parts.length).toBe(streamed.summary.slabs)
    expect(parts.length).toBeGreaterThan(2)
    // Slabs come in the cloud's layout: { count, pos, col, nrm }.
    const n = parts.reduce((k, p) => k + p.count, 0)
    const joined = new Float32Array(n * 6),
      nrm = new Float32Array(n * 3)
    let o = 0
    for (const p of parts) {
      for (let i = 0; i < p.count; i++)
        for (let c = 0; c < 3; c++) {
          joined[(o + i) * 6 + c] = p.pos[i * 3 + c]
          joined[(o + i) * 6 + 3 + c] = p.col[i * 3 + c]
        }
      nrm.set(p.nrm, o * 3)
      o += p.count
    }
    joined.nrm = nrm
    expect(rows(joined)).toEqual(rows(one))
    expect({ ...streamed.summary, slabs: 1 }).toEqual(one.summary)
  })
  it.each([{}, { removeIsolated: false, mergeCell: 0.2 }])(
    'a plan split over workers, slab by slab, fuses the identical cloud: %j',
    async (opts) => {
      const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
      const one = fuseDepthMaps(ms, opts)
      const entries = files(ms),
        load = (i) => readDepthFiles(entries[i])
      const sOpts = { ...opts, cacheBytes: 2 * 32 * 32 * 4, parallel: 3 }
      const plan = await fuseDepthMapsStreamed(entries, load, { ...sOpts, planOnly: true })
      expect(plan.workers).toBe(3)
      expect(plan.slabs.length).toBeGreaterThanOrEqual(3) // ~ one per worker
      // The plan crosses a worker boundary: it must survive structured cloning.
      const sent = structuredClone(plan)
      // Run the slabs in a scrambled order, as a worker pool would finish them.
      const order = sent.slabs.map((_, i) => i).reverse()
      const bySlab = new Map(),
        counters = []
      for (const i of order) {
        const run = await fuseDepthMapsStreamed(entries, load, { ...sOpts, plan: sent, slabIndices: [i] }, () => {}, {
          loadDepth: (k) => readDepthOnly(entries[k]),
          onTile: (part) => bySlab.set(i, part),
        })
        counters.push(run.counters)
        expect(run.stream.compared).toBeGreaterThanOrEqual(0)
      }
      const parts = sent.slabs.map((_, i) => bySlab.get(i))
      const joined = finishFusion(sent, mergeFusionCounters(counters), parts)
      expect(rows(joined)).toEqual(rows(one))
      expect({ ...joined.summary, slabs: 1 }).toEqual(one.summary)
    },
  )
  it('splits a piece too large for one accumulator into slabs, whatever the budget', () => {
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
    const one = fuseDepthMaps(ms, {})
    const cells = fuseDepthMaps(ms, { memBudgetBytes: 1, autoStep: false }).refused.cells
    const logs = []
    const split = fuseDepthMaps(ms, { limits: { accumulatorCells: Math.ceil(cells / 3) } }, (m) => logs.push(m))
    expect(split.summary.slabs).toBeGreaterThan(2)
    expect(rows(split)).toEqual(rows(one))
    expect(logs.some((m) => m.includes('slabs along'))).toBe(true)
  })
  it('coarsens the step, then refuses, when the cloud is past what one array can hold', () => {
    const ms = maps()
    const cells = fuseDepthMaps(ms, { memBudgetBytes: 1, autoStep: false }).refused.cells
    const logs = []
    const coarse = fuseDepthMaps(ms, { limits: { cloudPoints: cells - 1 } }, (m, l) => logs.push([m, l]))
    expect(coarse.refused).toBeUndefined()
    expect(
      logs.some(([m, l]) => l === 'warn' && m.includes('more than the browser can hold') && m.includes('step 2px')),
    ).toBe(true)
    const refused = fuseDepthMaps(ms, { limits: { cloudPoints: cells - 1 }, autoStep: false }, (m, l) =>
      logs.push([m, l]),
    )
    expect(refused.refused.maxCloudPoints).toBe(cells - 1)
  })
  it('refuses when even the cloud itself does not fit', () => {
    const ms = maps()
    const { cells } = fuseDepthMaps(ms, { memBudgetBytes: 1, autoStep: false }).refused
    const logs = []
    const out = fuseDepthMaps(ms, { memBudgetBytes: 2 * 27 * cells - 1 }, (m, l) => logs.push([m, l]))
    expect(out.refused).toBeTruthy()
    expect(logs.some(([m, l]) => l === 'error' && m.includes('even in slabs'))).toBe(true)
  })

  it('with wasm accumulators, the whole limit holds them and the buffer share only the rest', () => {
    const ms = maps()
    const one = fuseDepthMaps(ms, {})
    const { input, accumulator } = fuseDepthMaps(ms, { memBudgetBytes: 1, autoStep: false }).refused
    expect(accumulator).toBeGreaterThan(1000)
    // The buffer share holds the input only; the accumulator is outside the pool.
    const opts = { memBudgetBytes: input + 1000, ramBudgetBytes: 1e12, autoStep: false }
    const fused = fuseDepthMaps(ms, opts)
    expect(fused.summary.slabs).toBe(1)
    expect(rows(fused)).toEqual(rows(one))
    // Where the accumulators would be ArrayBuffers, the same limits refuse.
    setBigArrayCaps({ wasm: false, memory64: false, shared: false, maxLocalBytes: 2 ** 31, maxShareableBytes: 2 ** 31 })
    try {
      expect(fuseDepthMaps(ms, opts).refused).toBeTruthy()
    } finally {
      setBigArrayCaps(null)
    }
  })

  it('plans with what the open project leaves of the budget and the buffer share', () => {
    const ms = maps()
    const { input, total } = fuseDepthMaps(ms, { memBudgetBytes: 1, autoStep: false }).refused
    const opts = { memBudgetBytes: input + 1000, ramBudgetBytes: total + 1000, autoStep: false }
    expect(fuseDepthMaps(ms, opts).refused).toBeUndefined()
    // The page's clouds come off the whole budget …
    const logs = []
    const held = fuseDepthMaps(ms, { ...opts, pageBytes: 2000, pagePoolBytes: 0 }, (m) => logs.push(m))
    expect(logs.some((m) => m.includes('the open project holds'))).toBe(true)
    expect(held.refused ?? held.summary.slabs > 1).toBeTruthy()
    // … and their plain arrays off the buffer share.
    expect(fuseDepthMaps(ms, { ...opts, pagePoolBytes: 2000 }).refused).toBeTruthy()
  })

  it('depth-only comparison loads give the identical cloud and a monotonic bar', async () => {
    const ms = maps(),
      entries = files(ms),
      expected = fuseDepthMaps(ms, {})
    const progress = []
    const actual = await fuseDepthMapsStreamed(
      entries,
      (i) => readDepthFiles(entries[i]),
      {},
      () => {},
      { loadDepth: (i) => readDepthOnly(entries[i]), onProgress: (d) => progress.push(d) },
    )
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
  })
  it('fused normals face the cameras even when a map stored the opposite sign', () => {
    // Cameras sit at z = 10 looking down on the z = 0 plane. Camera-frame +z normals
    // are world −z: pointing away from every camera, i.e. inward for Poisson.
    const ms = maps().map((m) => ({
      ...m,
      normals: Float32Array.from({ length: 32 * 32 * 3 }, (_, i) => (i % 3 === 2 ? 1 : 0)),
    }))
    const out = fuseDepthMaps(ms, {})
    expect(out.length).toBeGreaterThan(0)
    for (let i = 2; i < out.nrm.length; i += 3) expect(out.nrm[i]).toBeGreaterThan(0.99)
  })
  it('a depth-only load rejects a truncated plane', async () => {
    const entry = files(maps())[0]
    entry.files.depth = new Blob([new Uint8Array(8)])
    await expect(readDepthOnly(entry)).rejects.toThrow('Corrupt depth map')
  })
  it('a load without normals leaves their plane unread and keeps the rest', async () => {
    const entry = files(maps())[0]
    let nrmRead = false
    const nrm = entry.files.nrm
    entry.files.nrm = {
      arrayBuffer: () => {
        nrmRead = true
        return nrm.arrayBuffer()
      },
    }
    const m = await readDepthFiles(entry, { normals: false }),
      full = await readDepthFiles(files(maps())[0])
    expect(nrmRead).toBe(false)
    expect(m.normals).toBeNull()
    expect([...m.depth]).toEqual([...full.depth])
    expect([...m.cost]).toEqual([...full.cost])
    expect([...m.rgb]).toEqual([...full.rgb])
  })
  it.each(['best', 'average'])('orthorectification agrees including gap filling: %s', async (blend) => {
    const ms = maps(),
      entries = files(ms)
    const grid = {
      width: 30,
      height: 30,
      originX: -5,
      originY: 5,
      gsd: 0.3,
      data: new Float32Array(900),
      mask: new Uint8Array(900).fill(1),
    }
    const opts = { blend, maxCost: 0.3 }
    const expected = orthorectify(grid, ms, (p) => p, opts)
    const actual = await orthorectifyStreamed(
      grid,
      entries,
      (i) => readDepthFiles(entries[i]),
      (p) => p,
      opts,
    )
    expect(actual).toEqual(expected)
    if (blend === 'best') expect(new Set(expected.labels).size).toBeGreaterThan(2) // ≥ 2 sources + unlabelled
  })
  // A surface over both camera groups (near x ≈ 0, far x ≈ 30), with relief inside the
  // occlusion tolerance and a ragged hole, so blocks see different maps and the gap
  // fill and the stats' neighbours cross block edges.
  function tiledScene() {
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
    const w = 70,
      h = 20,
      n = w * h
    const data = new Float32Array(n),
      mask = new Uint8Array(n)
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const i = r * w + c
        if ((c - 20) ** 2 + (r - 9) ** 2 < 9 || (c * 7 + r * 3) % 23 === 0) {
          data[i] = NaN
          continue
        }
        data[i] = 0.05 * Math.sin(c / 3) * Math.cos(r / 4)
        mask[i] = 1
      }
    return { ms, surface: { width: w, height: h, gsd: 0.6, originX: -6, originY: 6, data, mask } }
  }
  // The blocks' cores laid back into one plane.
  function assemble(blocks, w, h, withLabels) {
    const rgba = new Uint8ClampedArray(w * h * 4),
      labels = withLabels ? new Uint16Array(w * h) : null
    for (const b of blocks)
      for (let r = 0; r < b.height; r++) {
        rgba.set(b.rgba.subarray(r * b.width * 4, (r + 1) * b.width * 4), ((b.row0 + r) * w + b.col0) * 4)
        if (labels) labels.set(b.labels.subarray(r * b.width, (r + 1) * b.width), (b.row0 + r) * w + b.col0)
      }
    return { rgba, labels }
  }
  // A photo per map at twice the depth map's size, its colour a function of the map.
  const photoFor = (mi, m) => ({
    width: 64,
    height: 64,
    map: (u, v) => ({ x: 2 * u + 0.5, y: 2 * v + 0.5 }),
    data: Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, i) => (i * 11 + mi * 37) % 256),
  })
  it.each([
    [{ blend: 'best', maxCost: 0.3 }, 0.25, 8],
    [{ blend: 'average', maxCost: 0.3 }, 0.25, 16],
    [{ blend: 'best', fillRadius: 3, fillMethod: 'nearest' }, 0.6, 5],
    [{ blend: 'best', fillMethod: 'none' }, 0.45, 7],
    [{ blend: 'best', photos: true }, 0.25, 12],
    [{ blend: 'average', photos: true, affine: true }, 0.3, 9],
  ])(
    'tiled orthorectification ≡ the single pass incl. labels and stats: %j gsd %s block %s',
    async ({ photos, affine, ...opts }, gsd, blockSize) => {
      const { ms, surface } = tiledScene(),
        entries = files(ms)
      // An affine frame at survey-sized coordinates exercises the linearisation.
      const toSfm = affine
        ? ([x, y, z]) => [0.5 * (x - 2.5e6) + 0.1 * (y - 1.2e6), 0.5 * (y - 1.2e6) - 0.1 * (x - 2.5e6), 0.5 * z]
        : (p) => p
      const shift = affine
        ? ({ originX, originY, ...g }) => ({
            ...g,
            originX: 2 * originX + 2.5e6,
            originY: 2 * originY + 1.2e6,
            gsd: 2 * g.gsd,
          })
        : (g) => g
      const surf = affine ? { ...shift(surface), data: surface.data.map((z) => 2 * z), mask: surface.mask } : surface
      const g = affine ? 2 * gsd : gsd
      const geom = resampledGeometry(surf, g, 1 << 16)
      const loadImage = photos ? async (mi, m) => photoFor(mi, m) : null
      const grid = resampleSurface(surf, g, { maxGrid: 1 << 16 })
      const expected = await orthorectifyStreamed(
        grid,
        entries,
        (i) => readDepthFiles(entries[i]),
        toSfm,
        opts,
        () => {},
        loadImage,
      )
      for (const cacheBytes of [0, 1 << 30]) {
        const blocks = []
        const progress = []
        const actual = await orthorectifyTiled(
          surf,
          geom,
          entries,
          (i) => readDepthFiles(entries[i]),
          toSfm,
          { ...opts, blockSize, cacheBytes },
          { loadImage, onBlock: (b) => blocks.push(b), onProgress: (d) => progress.push(d) },
        )
        const { rgba, labels } = assemble(blocks, geom.width, geom.height, !!expected.labels)
        expect(blocks.length).toBe(actual.blocks)
        expect(actual.blocks).toBeGreaterThan(4)
        expect(Buffer.from(rgba.buffer).equals(Buffer.from(expected.rgba.buffer))).toBe(true)
        if (expected.labels) expect([...labels]).toEqual([...expected.labels])
        expect({ covered: actual.covered, sampled: actual.sampled, filled: actual.filled }).toEqual({
          covered: expected.covered,
          sampled: expected.sampled,
          filled: expected.filled,
        })
        expect(actual.stats).toEqual(orthoStats(expected.rgba, grid.width, grid.height, expected.labels))
        expect(actual.surfaceCells).toBe(grid.mask.reduce((n, v) => n + v, 0))
        // The cull: not every block reads every map.
        expect(actual.visits).toBeLessThan(actual.blocks * ms.length)
        for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1])
        if (cacheBytes === 0) expect(actual.mapLoads).toBe(actual.visits)
        else expect(actual.mapLoads).toBe(ms.length)
      }
      expect(expected.covered).toBeGreaterThan(100)
    },
  )
  // The mosaic has no whole-grid reference implementation: its reference is the same
  // code with one block covering the grid. Small blocks must reproduce it bit for bit —
  // labels, feathering, the gains' effect, gap fill and stats — whatever the cache.
  it.each([
    [{ seamWidth: 0 }, 0.25, 7],
    [{ seamWidth: 15 }, 0.25, 6],
    [{ seamWidth: 10, colourBalance: true, photos: true }, 0.3, 8],
    [{ seamWidth: 20, colourBalance: true, photos: true, affine: true, fillRadius: 3, fillMethod: 'nearest' }, 0.25, 5],
    [{ seamWidth: 10, maxCost: 0.3 }, 0.45, 4],
    // Multiband (small pyramids, so the halo stays below the grid) and graph-cut seams
    // (a coarse grid of a few hundred cells, so its cells span several ortho cells).
    [{ seamBlend: 'multiband', blendLevels: 2 }, 0.25, 7],
    [{ seamBlend: 'multiband', blendLevels: 3, colourBalance: true, photos: true }, 0.3, 16],
    [{ seamline: 'graphcut', seamCutCells: 500, seamWidth: 10 }, 0.25, 6],
    [
      {
        seamline: 'graphcut',
        seamCutCells: 300,
        seamBlend: 'multiband',
        blendLevels: 2,
        colourBalance: true,
        photos: true,
        affine: true,
        fillRadius: 3,
      },
      0.25,
      9,
    ],
  ])(
    'a tiled mosaic ≡ one block: %j gsd %s block %s',
    async ({ photos, affine, ...rest }, gsd, blockSize) => {
      const opts = { blend: 'mosaic', ...rest }
      const { ms, surface } = tiledScene(),
        entries = files(ms)
      const toSfm = affine
        ? ([x, y, z]) => [0.5 * (x - 2.5e6) + 0.1 * (y - 1.2e6), 0.5 * (y - 1.2e6) - 0.1 * (x - 2.5e6), 0.5 * z]
        : (p) => p
      const surf = affine
        ? {
            ...surface,
            originX: 2 * surface.originX + 2.5e6,
            originY: 2 * surface.originY + 1.2e6,
            gsd: 2 * surface.gsd,
            data: surface.data.map((z) => 2 * z),
          }
        : surface
      const geom = resampledGeometry(surf, affine ? 2 * gsd : gsd, 1 << 16)
      const loadImage = photos ? async (mi, m) => photoFor(mi, m) : null
      const tile = async (bs, cacheBytes) => {
        const blocks = []
        const res = await orthorectifyTiled(
          surf,
          geom,
          entries,
          (i) => readDepthFiles(entries[i]),
          toSfm,
          { ...opts, blockSize: bs, cacheBytes },
          { loadImage, onBlock: (b) => blocks.push(b) },
        )
        return { res, ...assemble(blocks, geom.width, geom.height, true) }
      }
      const one = await tile(1 << 16, 1 << 30)
      expect(one.res.blocks).toBe(1)
      expect(one.res.covered).toBeGreaterThan(100)
      expect(new Set(one.labels).size).toBeGreaterThan(2)
      if (rest.colourBalance) expect(one.res.mosaic.balance.pairs).toBeGreaterThan(0)
      // The coarse cut grid spans several ortho cells, so its cells cross block edges.
      if (rest.seamline) expect(one.res.mosaic.seamCut.factor).toBeGreaterThan(1)
      for (const cacheBytes of [0, 1 << 30]) {
        const many = await tile(blockSize, cacheBytes)
        expect(many.res.blocks).toBeGreaterThan(4)
        expect(Buffer.from(many.rgba.buffer).equals(Buffer.from(one.rgba.buffer))).toBe(true)
        expect([...many.labels]).toEqual([...one.labels])
        expect(many.res.stats).toEqual(one.res.stats)
        expect(many.res.mosaic).toEqual(one.res.mosaic)
        expect({ covered: many.res.covered, sampled: many.res.sampled }).toEqual({
          covered: one.res.covered,
          sampled: one.res.sampled,
        })
        expect(many.res.stats).toEqual(orthoStats(one.rgba, geom.width, geom.height, one.labels))
      }
    },
    30_000,
  ) // the multiband + graph-cut case takes ~2 s alone, more in a loaded full run
  it("tiles the surface's own grid (gsd 0) cell for cell, holes included", async () => {
    const { ms, surface } = tiledScene()
    const geom = resampledGeometry(surface, 0)
    expect(geom.identity).toBe(true)
    const expected = orthorectify(surface, ms, (p) => p, {})
    const blocks = []
    const actual = await orthorectifyTiled(
      surface,
      geom,
      ms,
      async (i) => ms[i],
      (p) => p,
      { blockSize: 6, mapsResident: true },
      { onBlock: (b) => blocks.push(b) },
    )
    const { rgba, labels } = assemble(blocks, surface.width, surface.height, true)
    expect([...rgba]).toEqual([...expected.rgba])
    expect([...labels]).toEqual([...expected.labels])
    expect(actual.covered).toBe(expected.covered)
  })
  it('rejects a truncated map before fusion', async () => {
    const entry = files(maps())[0]
    entry.files.depth = new Blob([new Uint8Array(4)])
    await expect(readDepthFiles(entry)).rejects.toThrow('Corrupt depth map')
  })
})
