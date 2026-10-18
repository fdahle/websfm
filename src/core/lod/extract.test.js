import { describe, it, expect } from 'vitest'
import { buildLod } from './build.js'
import { openLodReader } from './reader.js'
import { planExtract, extractPoints } from './extract.js'

async function terrainLod(n) {
  let s = 4
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pos = new Float64Array(3 * n), cls = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = rnd() * 1000, y = rnd() * 1000
    pos[3 * i] = 5000 + x; pos[3 * i + 1] = 7000 + y; pos[3 * i + 2] = 50 + Math.sin(x / 80) * 4
    cls[i] = x < 500 ? 2 : 6
  }
  const files = new Map(), data = []
  let size = 0
  const tmp = {
    async append(name, u8) { (files.get(name) ?? files.set(name, []).get(name)).push(u8) },
    async size(name) { return (files.get(name) ?? []).reduce((a, b) => a + b.length, 0) },
    async read(name, offset, length) {
      let o = 0
      for (const b of files.get(name)) { if (offset < o + b.length) return b.subarray(offset - o, offset - o + length); o += b.length }
      return new Uint8Array(0)
    },
    async remove(name) { files.delete(name) },
  }
  const out = { async write(u8) { const at = size; data.push(u8); size += u8.length; return at } }
  const res = await buildLod({
    count: n, bounds: { min: [5000, 7000, 45], max: [6000, 8000, 55] }, colour: false,
    attributes: [{ name: 'classification', type: 'uint8' }],
    async *batches() { yield { count: n, pos, attributes: { classification: cls } } },
  }, tmp, out, { leafMax: 4000 })
  const { hierarchy, ...lod } = res
  return { lod, reader: await openLodReader(lod, { data: new Blob(data), hierarchy: new Blob([hierarchy]) }), pos, cls }
}

describe('extract from an octree', () => {
  it('reads everything when the budget allows, and a box and classes exactly', async () => {
    const n = 200_000
    const { lod, reader, pos, cls } = await terrainLod(n)
    const all = planExtract(reader.nodes, lod)
    expect(all.complete).toBe(true)
    expect((await extractPoints(reader, all, lod)).count).toBe(n)
    const box = { min: [5200, 7300, null], max: [5400, 7600, null] }
    let inBox = 0, ground = 0
    for (let i = 0; i < n; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1]
      if (x >= 5200 && x <= 5400 && y >= 7300 && y <= 7600) { inBox++; if (cls[i] === 2) ground++ }
    }
    const plan = planExtract(reader.nodes, lod, { box })
    expect(plan.nodes.length).toBeLessThan(reader.nodes.size)
    expect((await extractPoints(reader, plan, lod, { box })).count).toBe(inBox)
    const g = await extractPoints(reader, plan, lod, { box, classes: new Set([2]), fields: 'xyz' })
    expect(g.count).toBe(ground)
    expect(g.attributes).toEqual({})
  })

  it('meets a budget by stopping at a level: an even thinning, not a cut', async () => {
    const { lod, reader } = await terrainLod(200_000)
    const plan = planExtract(reader.nodes, lod, { maxPoints: 60_000 })
    expect(plan.complete).toBe(false)
    expect(plan.estimate).toBeLessThanOrEqual(60_000)
    const pts = await extractPoints(reader, plan, lod)
    // Spread over the whole extent: every 100 m × 100 m tile has points.
    const tiles = new Set()
    for (let i = 0; i < pts.count; i++) tiles.add(`${Math.floor((pts.pos[3 * i] - 5000) / 100)},${Math.floor((pts.pos[3 * i + 1] - 7000) / 100)}`)
    expect(tiles.size).toBe(100)
    // A spacing need stops sooner than the budget would.
    const coarse = planExtract(reader.nodes, lod, { maxPoints: 60_000, minSpacing: lod.spacing })
    expect(coarse.level).toBe(0)
  })
})

describe('planExtract and the buffer wall', () => {
  it('stops at the last level that fits one Float64 xyz buffer, whatever maxPoints says', () => {
    // Three levels of 1 M, 60 M and 60 M points: all three (121 M) would pass a 6 GB
    // budget but not the 2 GiB buffer (89 M points); the plan keeps the first two.
    const lod = { root: { min: [0, 0, 0], size: 8 }, spacing: 1 }
    const nodes = new Map([
      ['0-0-0-0', { key: [0, 0, 0, 0], count: 1e6 }],
      ['1-0-0-0', { key: [1, 0, 0, 0], count: 60e6 }],
      ['2-0-0-0', { key: [2, 0, 0, 0], count: 60e6 }],
    ])
    const plan = planExtract(nodes, lod, { maxPoints: 125e6 })
    expect(plan.level).toBe(1)
    expect(plan.estimate).toBe(61e6)
    expect(plan.complete).toBe(false)
  })
})
