import { describe, it, expect } from 'vitest'
import { fuseDepthMaps, fuseDepthMapsStreamed } from './mvs.js'
import { orthorectify, orthorectifyStreamed } from '../products/ortho.js'
import { serializeDepthMap } from './depthMapCodec.js'
import { readDepthFiles } from './depthFileReader.js'

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
  it.each(['best', 'average'])('orthorectification agrees including gap filling: %s', async blend => {
    const ms = maps(), entries = files(ms)
    const grid = { width: 30, height: 30, originX: -5, originY: 5, gsd: 0.3,
      data: new Float32Array(900), mask: new Uint8Array(900).fill(1) }
    const opts = { blend, maxCost: 0.3 }
    const expected = orthorectify(grid, ms, p => p, opts)
    const actual = await orthorectifyStreamed(grid, entries, i => readDepthFiles(entries[i]), p => p, opts)
    expect(actual).toEqual(expected)
  })
  it('rejects a truncated map before fusion', async () => {
    const entry = files(maps())[0]; entry.files.depth = new Blob([new Uint8Array(4)])
    await expect(readDepthFiles(entry)).rejects.toThrow('Corrupt depth map')
  })
})
