import { describe, it, expect } from 'vitest'
import { fuseDepthMaps, fuseDepthMapsStreamed, finishFusion, mergeFusionCounters } from './mvs.js'
import { orthorectify, orthorectifyStreamed } from '../products/ortho.js'
import { serializeDepthMap } from './depthMapCodec.js'
import { readDepthFiles, readDepthOnly } from './depthFileReader.js'

function maps() {
  return Array.from({ length: 4 }, (_, j) => {
    const n = 32 * 32
    return { uuid: String(j), width: 32, height: 32, K: { fx: 30, fy: 30, cx: 16, cy: 16 },
      R: [[1,0,0],[0,-1,0],[0,0,-1]], t: [-j / 4, 0, 10],
      depth: Float32Array.from({ length: n }, (_, i) => i % 53 === j ? 0 : 10),
      cost: Float32Array.from({ length: n }, (_, i) => (i % 13) / 30),
      rgb: Uint8Array.from({ length: n * 3 }, (_, i) => (i * 7 + j * 23) % 256),
      normals: Float32Array.from({ length: n * 3 }, (_, i) => i % 3 === 2 ? -1 : 0) }
  })
}
function files(ms) {
  return ms.map(m => { const { meta, buffers } = serializeDepthMap(m)
    return { ...meta, files: Object.fromEntries(Object.entries(buffers).map(([k,b]) => [k,b ? new Blob([b]) : null])) }
  })
}
describe('bounded map loading', () => {
  it.each([{}, { minViews: 1, minTriAngleDeg: 0, step: 2 }, { mergeCell: 0, maxCost: 0.25, removeIsolated: false }])('fusion agrees exactly with resident maps: %j', async opts => {
    const ms = maps(), entries = files(ms), expected = fuseDepthMaps(ms, opts)
    const actual = await fuseDepthMapsStreamed(entries, i => readDepthFiles(entries[i]), opts)
    expect(actual.length).toBeGreaterThan(0)
    expect([...actual]).toEqual([...expected]); expect([...actual.nrm]).toEqual([...expected.nrm])
    expect(actual.summary).toEqual(expected.summary)
  })
  it('culls maps out of view and caches planes, and still fuses the identical cloud', async () => {
    // Two groups 1 km apart: neither sees the other, so every cross-group pair is culled.
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 1000, 0, 10] }))]
    const entries = files(ms), expected = fuseDepthMaps(ms, {})
    const logs = []
    let reads = 0
    const actual = await fuseDepthMapsStreamed(entries, i => readDepthFiles(entries[i]), { cacheBytes: 2 * 32 * 32 * 4 },
      (m) => logs.push(m), { loadDepth: (i) => { reads++; return readDepthOnly(entries[i]) } })
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    const culled = Number(/\((\d+) culled/.exec(logs.find((m) => m.includes('culled as out of view')))[1])
    expect(culled).toBe(8 * 4) // each map skips the 4 of the other group
    expect(reads).toBeLessThan(8 * 7)
  })

  it('plans its comparison cache on the known request sequence (fewer reads, same cloud)', async () => {
    // Four mutually visible maps, a two-plane cache: the sequence is 1,2,3 | 0,2,3 |
    // 0,1,3 | 0,1,2. Evicting the plane wanted furthest ahead reads 8 planes; LRU
    // would miss on all 12.
    const ms = maps(), entries = files(ms), expected = fuseDepthMaps(ms, {})
    let reads = 0
    const actual = await fuseDepthMapsStreamed(entries, i => readDepthFiles(entries[i]), { cacheBytes: 2 * 32 * 32 * 4 },
      () => {}, { loadDepth: (i) => { reads++; return readDepthOnly(entries[i]) } })
    expect([...actual]).toEqual([...expected])
    expect(reads).toBe(8)
  })

  // Tiled fusion emits slab by slab, so the rows come in another order: compare the
  // multiset of [x,y,z,r,g,b,nx,ny,nz] rows.
  const rows = (flat) => Array.from({ length: flat.length / 6 }, (_, i) =>
    [...flat.subarray(i * 6, i * 6 + 6), ...flat.nrm.subarray(i * 3, i * 3 + 3)].join(',')).sort()
  const slabBudget = (refused, slabsWanted) => refused.input + 27 * refused.cells + 85 * Math.ceil(refused.cells / slabsWanted)
  it.each([{}, { step: 2 }, { removeIsolated: false, mergeCell: 0.2 }, { minViews: 1, minTriAngleDeg: 0, mergeCell: 0.15 }])(
    'over budget, fusion in slabs builds the identical cloud: %j', async (opts) => {
      // Two groups far apart along x (the slab axis), so some slabs skip some maps.
      const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
      const one = fuseDepthMaps(ms, opts)
      const tiled = fuseDepthMaps(ms, { ...opts, memBudgetBytes: slabBudget(fuseDepthMaps(ms, { ...opts, memBudgetBytes: 1 }).refused, 5) })
      expect(tiled.refused).toBeUndefined()
      expect(tiled.summary.slabs).toBeGreaterThan(2)
      expect(one.length).toBeGreaterThan(0)
      expect(rows(tiled)).toEqual(rows(one))
      expect({ ...tiled.summary, slabs: 1 }).toEqual(one.summary)

      const entries = files(ms), io = [(i) => readDepthFiles(entries[i]), { cacheBytes: 3 * 32 * 32 * 4 }]
      const sOpts = { ...opts, ...io[1] }
      const refused = (await fuseDepthMapsStreamed(entries, io[0], { ...sOpts, memBudgetBytes: 1 })).refused
      const parts = []
      const streamed = await fuseDepthMapsStreamed(entries, io[0], { ...sOpts, memBudgetBytes: slabBudget(refused, 5) }, () => {},
        { loadDepth: (i) => readDepthOnly(entries[i]), onTile: (flat) => parts.push(flat) })
      expect(streamed.length).toBe(0)
      expect(parts.length).toBe(streamed.summary.slabs)
      expect(parts.length).toBeGreaterThan(2)
      const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0)), nrm = new Float32Array(joined.length / 2)
      let o = 0
      for (const p of parts) { joined.set(p, o * 6); nrm.set(p.nrm, o * 3); o += p.length / 6 }
      joined.nrm = nrm
      expect(rows(joined)).toEqual(rows(one))
      expect({ ...streamed.summary, slabs: 1 }).toEqual(one.summary)
    })
  it.each([{}, { removeIsolated: false, mergeCell: 0.2 }])('a plan split over workers, slab by slab, fuses the identical cloud: %j', async (opts) => {
    const ms = [...maps(), ...maps().map((m, j) => ({ ...m, uuid: `far${j}`, t: [m.t[0] - 30, 0, 10] }))]
    const one = fuseDepthMaps(ms, opts)
    const entries = files(ms), load = (i) => readDepthFiles(entries[i])
    const sOpts = { ...opts, cacheBytes: 2 * 32 * 32 * 4, parallel: 3 }
    const plan = await fuseDepthMapsStreamed(entries, load, { ...sOpts, planOnly: true })
    expect(plan.workers).toBe(3)
    expect(plan.slabs.length).toBeGreaterThanOrEqual(3) // ~ one per worker
    // The plan crosses a worker boundary: it must survive structured cloning.
    const sent = structuredClone(plan)
    // Run the slabs in a scrambled order, as a worker pool would finish them.
    const order = sent.slabs.map((_, i) => i).reverse()
    const bySlab = new Map(), counters = []
    for (const i of order) {
      const run = await fuseDepthMapsStreamed(entries, load, { ...sOpts, plan: sent, slabIndices: [i] }, () => {},
        { loadDepth: (k) => readDepthOnly(entries[k]), onTile: (flat) => bySlab.set(i, flat) })
      counters.push(run.counters)
      expect(run.stream.compared).toBeGreaterThanOrEqual(0)
    }
    const parts = sent.slabs.map((_, i) => bySlab.get(i))
    const joined = finishFusion(sent, mergeFusionCounters(counters), parts)
    expect(rows(joined)).toEqual(rows(one))
    expect({ ...joined.summary, slabs: 1 }).toEqual(one.summary)
  })
  it('refuses when even the cloud itself does not fit', () => {
    const ms = maps()
    const { cells } = fuseDepthMaps(ms, { memBudgetBytes: 1 }).refused
    const logs = []
    const out = fuseDepthMaps(ms, { memBudgetBytes: 2 * 27 * cells - 1 }, (m, l) => logs.push([m, l]))
    expect(out.refused).toBeTruthy()
    expect(logs.some(([m, l]) => l === 'error' && m.includes('even in slabs'))).toBe(true)
  })

  it('depth-only comparison loads give the identical cloud and a monotonic bar', async () => {
    const ms = maps(), entries = files(ms), expected = fuseDepthMaps(ms, {})
    const progress = []
    const actual = await fuseDepthMapsStreamed(entries, i => readDepthFiles(entries[i]), {}, () => {},
      { loadDepth: i => readDepthOnly(entries[i]), onProgress: d => progress.push(d) })
    expect([...actual]).toEqual([...expected])
    expect(actual.summary).toEqual(expected.summary)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
  })
  it('fused normals face the cameras even when a map stored the opposite sign', () => {
    // Cameras sit at z = 10 looking down on the z = 0 plane. Camera-frame +z normals
    // are world −z: pointing away from every camera, i.e. inward for Poisson.
    const ms = maps().map((m) => ({ ...m, normals: Float32Array.from({ length: 32 * 32 * 3 }, (_, i) => (i % 3 === 2 ? 1 : 0)) }))
    const out = fuseDepthMaps(ms, {})
    expect(out.length).toBeGreaterThan(0)
    for (let i = 2; i < out.nrm.length; i += 3) expect(out.nrm[i]).toBeGreaterThan(0.99)
  })
  it('a depth-only load rejects a truncated plane', async () => {
    const entry = files(maps())[0]; entry.files.depth = new Blob([new Uint8Array(8)])
    await expect(readDepthOnly(entry)).rejects.toThrow('Corrupt depth map')
  })
  it.each(['best', 'average'])('orthorectification agrees including gap filling: %s', async blend => {
    const ms = maps(), entries = files(ms)
    const grid = { width: 30, height: 30, originX: -5, originY: 5, gsd: 0.3,
      data: new Float32Array(900), mask: new Uint8Array(900).fill(1) }
    const opts = { blend, maxCost: 0.3 }
    const expected = orthorectify(grid, ms, p => p, opts)
    const actual = await orthorectifyStreamed(grid, entries, i => readDepthFiles(entries[i]), p => p, opts)
    expect(actual).toEqual(expected)
    if (blend === 'best') expect(new Set(expected.labels).size).toBeGreaterThan(2) // ≥ 2 sources + unlabelled
  })
  it('rejects a truncated map before fusion', async () => {
    const entry = files(maps())[0]; entry.files.depth = new Blob([new Uint8Array(4)])
    await expect(readDepthFiles(entry)).rejects.toThrow('Corrupt depth map')
  })
})
