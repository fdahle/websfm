import { describe, it, expect } from 'vitest'
import { buildLod } from './build.js'
import { openLodReader } from './reader.js'
import { streamedEditSource, planTiles, inCore, transformedBounds } from './transform.js'
import { screenSelectMask } from '../products/screenSelect.js'
import { classifyCloudGround } from '../products/groundFilter.js'
import { filterCloud } from '../products/cloudEdit.js'

function stores() {
  const files = new Map(),
    data = []
  let size = 0
  const tmp = {
    async append(name, u8) {
      ;(files.get(name) ?? files.set(name, []).get(name)).push(u8)
    },
    async size(name) {
      return (files.get(name) ?? []).reduce((a, b) => a + b.length, 0)
    },
    async read(name, offset, length) {
      let o = 0
      for (const b of files.get(name)) {
        if (offset < o + b.length) return b.subarray(offset - o, offset - o + length)
        o += b.length
      }
      return new Uint8Array(0)
    },
    async remove(name) {
      files.delete(name)
    },
  }
  const out = {
    async write(u8) {
      const at = size
      data.push(u8)
      size += u8.length
      return at
    },
    blob: () => new Blob(data),
  }
  return { tmp, out }
}

async function build(source, layout) {
  const { tmp, out } = stores()
  const res = await buildLod(source, tmp, out, { leafMax: 4000, layout })
  const { hierarchy, ...lod } = res
  return { lod, reader: await openLodReader(lod, { data: out.blob(), hierarchy: new Blob([hierarchy]) }) }
}

// 200 m × 200 m of rolling ground at 0.25 m with three box buildings 8 m tall.
function scene() {
  const pos = [],
    cls = []
  let s = 9
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const buildings = [
    [40, 40, 70, 60],
    [120, 100, 150, 140],
    [60, 150, 90, 175],
  ]
  for (let x = 0; x < 200; x += 0.5)
    for (let y = 0; y < 200; y += 0.5) {
      const g = 2 * Math.sin(x / 40) + Math.cos(y / 50) + rnd() * 0.05
      const b = buildings.some(([a, c, d, e]) => x >= a && x <= d && y >= c && y <= e)
      pos.push(1000 + x, 2000 + y, b ? g + 8 : g)
      cls.push(b ? 6 : 2)
    }
  // A few floating outliers.
  for (let k = 0; k < 40; k++) {
    pos.push(1000 + rnd() * 200, 2000 + rnd() * 200, 40 + rnd() * 20)
    cls.push(7)
  }
  const n = cls.length
  return { count: n, pos: Float64Array.from(pos), attributes: { classification: Uint8Array.from(cls) } }
}

function boundsOf(c) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < c.count; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c.pos[3 * i + k])
      max[k] = Math.max(max[k], c.pos[3 * i + k])
    }
  return { min, max }
}

async function sceneLod() {
  const c = scene()
  const { lod, reader } = await build(
    {
      // The points' own extent, as a LAS header gives it (the outlier filter's reach
      // derives from it, as it does from a resident cloud's own bounds).
      count: c.count,
      bounds: boundsOf(c),
      colour: false,
      attributes: [{ name: 'classification', type: 'uint8' }],
      async *batches() {
        yield c
      },
    },
    { offset: [1000, 2000, 0], scale: [0.001, 0.001, 0.001] },
  )
  return { c, lod, reader }
}

async function edited(reader, lod, mode, settings) {
  const source = streamedEditSource(reader, lod, mode, settings)
  return build(source, { offset: lod.layout.offset, scale: lod.layout.scale })
}

async function allPoints(reader) {
  const out = []
  for (const node of reader.nodes.values()) if (node.count) out.push(await reader.read(node, { as: 'absolute' }))
  return out
}

describe('editing a streamed cloud', () => {
  it('replays a screen selection on every point, at every level', async () => {
    const { c, lod, reader } = await sceneLod()
    // Top-down orthographic clip of the offset-relative points: x, y → NDC.
    const matrix = [2 / 200, 0, 0, 0, 0, 2 / 200, 0, 0, 0, 0, 0, 0, -1, -1, 0, 1]
    const shape = { kind: 'rect', x0: -0.5, y0: -0.5, x1: 0, y1: 0.2 }
    const rel = new Float64Array(c.pos.length)
    for (let i = 0; i < c.count; i++) {
      rel[3 * i] = c.pos[3 * i] - 1000
      rel[3 * i + 1] = c.pos[3 * i + 1] - 2000
      rel[3 * i + 2] = c.pos[3 * i + 2]
    }
    const { selected } = screenSelectMask(rel, c.count, { matrix, shape })
    expect(selected).toBeGreaterThan(1000)
    const del = await edited(reader, lod, 'mask', {
      selection: [{ shape, matrix, op: 'replace' }],
      keepSelected: false,
    })
    expect(del.lod.points).toBe(c.count - selected)
    const cls = await edited(reader, lod, 'classify', { selection: [{ shape, matrix, op: 'replace' }], classValue: 9 })
    let water = 0
    for (const p of await allPoints(cls.reader)) for (const v of p.attributes.classification) if (v === 9) water++
    expect(cls.lod.points).toBe(c.count)
    expect(water).toBe(selected)
  })

  it('crops away a box (keeping what lies outside)', async () => {
    const { c, lod, reader } = await sceneLod()
    let inside = 0
    for (let i = 0; i < c.count; i++)
      if (c.pos[3 * i] >= 1050 && c.pos[3 * i] <= 1100 && c.pos[3 * i + 1] <= 2100) inside++
    const r = await edited(reader, lod, 'crop', { min: [1050, null, null], max: [1100, 2100, null] })
    expect(r.lod.points).toBe(c.count - inside)
  })

  it('moves every point, into an octree quantised where the points now are', async () => {
    const { c, lod, reader } = await sceneLod()
    // A quarter turn about z and a shift to UTM-sized coordinates: far beyond what the
    // source's offset and 1 mm steps could store in 32-bit integers.
    const matrix = [0, -1, 0, 500000, 1, 0, 0, 4000000, 0, 0, 1, 100, 0, 0, 0, 1]
    const source = streamedEditSource(reader, lod, 'transform', { matrix })
    const want = transformedBounds(lod.bounds, matrix)
    expect(source.bounds.min[0]).toBeCloseTo(500000 - lod.bounds.max[1], 6)
    expect(source.bounds.min[1]).toBeCloseTo(4000000 + lod.bounds.min[0], 6)
    const r = await build(source, {})
    expect(r.lod.points).toBe(c.count)
    const got = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (const p of await allPoints(r.reader))
      for (let i = 0; i < p.count; i++)
        for (let k = 0; k < 3; k++) {
          got.min[k] = Math.min(got.min[k], p.pos[3 * i + k])
          got.max[k] = Math.max(got.max[k], p.pos[3 * i + k])
        }
    // The points' own extent, moved: inside the moved box, and its x/y sides exact.
    const b = boundsOf(c)
    expect(got.min[0]).toBeCloseTo(500000 - b.max[1], 2)
    expect(got.max[0]).toBeCloseTo(500000 - b.min[1], 2)
    expect(got.min[1]).toBeCloseTo(4000000 + b.min[0], 2)
    expect(got.max[2]).toBeCloseTo(100 + b.max[2], 2)
    for (let k = 0; k < 3; k++) {
      expect(got.min[k]).toBeGreaterThanOrEqual(want.min[k] - 1e-3)
      expect(got.max[k]).toBeLessThanOrEqual(want.max[k] + 1e-3)
    }
  })

  it('tiles cover every point once', () => {
    const lod = { bounds: { min: [0, 0, 0], max: [1000, 600, 10] }, points: 6_000_000 }
    const tiles = planTiles(lod, { tilePoints: 400_000, halo: 20 })
    expect(tiles.length).toBeGreaterThan(10)
    for (const [x, y] of [
      [0, 0],
      [999.99, 599.99],
      [500, 300],
      [-5, 700],
    ]) {
      expect(tiles.filter((t) => inCore(t, x, y)).length).toBe(1)
    }
  })

  it('sizes tiles from where the points are, not from the extent', async () => {
    // A diagonal corridor 2 km long and 20 m wide: most of its bounding box is empty,
    // so tiles sized from the box's mean density would each hold many times the target.
    const n = 200_000,
      pos = new Float64Array(3 * n)
    let s = 3
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < n; i++) {
      const t = rnd() * 2000,
        off = (rnd() - 0.5) * 20
      pos[3 * i] = t + off * 0.7
      pos[3 * i + 1] = t - off * 0.7
      pos[3 * i + 2] = rnd()
    }
    const c = { count: n, pos, attributes: {} }
    const { lod, reader } = await build({
      count: n,
      bounds: boundsOf(c),
      colour: false,
      attributes: [],
      async *batches() {
        yield c
      },
    })
    const target = 10_000,
      halo = 5
    const inBox = (t) => {
      let k = 0
      for (let i = 0; i < n; i++) {
        const x = pos[3 * i],
          y = pos[3 * i + 1]
        if (
          (t.box.min[0] == null || x >= t.box.min[0]) &&
          (t.box.max[0] == null || x <= t.box.max[0]) &&
          (t.box.min[1] == null || y >= t.box.min[1]) &&
          (t.box.max[1] == null || y <= t.box.max[1])
        )
          k++
      }
      return k
    }
    const even = planTiles(lod, { tilePoints: target, halo })
    const fromNodes = planTiles(lod, { tilePoints: target, halo, nodes: reader.nodes })
    expect(Math.max(...even.map(inBox))).toBeGreaterThan(2 * target)
    expect(Math.max(...fromNodes.map(inBox))).toBeLessThan(1.5 * target)
    for (let i = 0; i < n; i += 97)
      expect(fromNodes.filter((t) => inCore(t, pos[3 * i], pos[3 * i + 1])).length).toBe(1)
    // Voxel-aligned: every inner edge on the cell's grid.
    for (const t of planTiles(lod, { tilePoints: target, halo, align: 2.5, nodes: reader.nodes })) {
      for (const v of [...t.core.min, ...t.core.max])
        if (Number.isFinite(v)) expect(Math.abs(v / 2.5 - Math.round(v / 2.5))).toBeLessThan(1e-9)
    }
  })

  it('refuses a tile it could only read thinned', async () => {
    // An octree whose finest level is past one read's buffer: never read, refused.
    const nodes = new Map([
      ['0-0-0-0', { key: [0, 0, 0, 0], count: 10, offset: 0, length: 0 }],
      ['1-0-0-0', { key: [1, 0, 0, 0], count: 200_000_000, offset: 0, length: 0 }],
    ])
    const reader = {
      nodes,
      read: async () => {
        throw new Error('not reached')
      },
    }
    const lod = {
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      root: { min: [0, 0, 0], size: 1 },
      spacing: 1 / 128,
      points: 200_000_010,
      layout: { offset: [0, 0, 0], scale: [1e-6, 1e-6, 1e-6], colour: false, attributes: [] },
    }
    const source = streamedEditSource(reader, lod, 'filter', { methods: ['range'], range: {}, tilePoints: 1e12 })
    await expect(
      (async () => {
        for await (const _ of source.batches());
      })(),
    ).rejects.toThrow(/too dense in one place/)
  })

  it('gives an edited cloud the extent of its own points', async () => {
    const { c, lod, reader } = await sceneLod()
    const r = await edited(reader, lod, 'crop', { min: [null, 2100, null], max: [null, null, null] })
    const kept = { count: 0, pos: [] }
    for (let i = 0; i < c.count; i++)
      if (c.pos[3 * i + 1] < 2100) {
        kept.pos.push(c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2])
        kept.count++
      }
    const want = boundsOf(kept)
    for (let k = 0; k < 3; k++) {
      expect(r.lod.bounds.min[k]).toBeCloseTo(want.min[k], 2)
      expect(r.lod.bounds.max[k]).toBeCloseTo(want.max[k], 2)
    }
    expect(r.lod.bounds.max[1]).toBeLessThan(lod.bounds.max[1] - 90)
  })

  it('classifies the ground tile by tile as the whole cloud does', async () => {
    const { c, lod, reader } = await sceneLod()
    const settings = { clothResolution: 1, rigidness: 2, classThreshold: 0.5, slopeSmoothing: true }
    const whole = classifyCloudGround(c, null, { ...settings, extent: 'all' }).classes
    const truth = new Map()
    for (let i = 0; i < c.count; i++)
      truth.set(
        `${Math.round(c.pos[3 * i] * 1000)},${Math.round(c.pos[3 * i + 1] * 1000)},${Math.round(c.pos[3 * i + 2] * 1000)}`,
        whole[i],
      )
    // Small tiles, so several meet inside the scene.
    const r = await edited(reader, lod, 'classify-ground', { ...settings, tilePoints: 60_000 })
    expect(r.lod.points).toBe(c.count)
    let agree = 0,
      n = 0
    for (const p of await allPoints(r.reader)) {
      for (let k = 0; k < p.count; k++) {
        const w = truth.get(
          `${Math.round(p.pos[3 * k] * 1000)},${Math.round(p.pos[3 * k + 1] * 1000)},${Math.round(p.pos[3 * k + 2] * 1000)}`,
        )
        n++
        if (w === p.attributes.classification[k]) agree++
      }
    }
    expect(agree / n).toBeGreaterThan(0.99)
  }, 60_000)

  it('filters outliers tile by tile', async () => {
    const { c, lod, reader } = await sceneLod()
    const settings = { methods: ['sor'], sor: { k: 12, stdRatio: 2 } }
    const whole = filterCloud(c, settings).count
    // Small tiles; the whole cloud's statistics apply to every one (a first pass).
    // The margin holds the filter's whole reach, so the tile edges change nothing.
    const r = await edited(reader, lod, 'filter', { ...settings, tilePoints: 60_000 })
    expect(r.lod.points).toBe(whole)
    expect(r.lod.points).toBeLessThanOrEqual(c.count - 30) // the floating points went
    // With the isolated-cell filter first: its automatic cell is the whole cloud's.
    const chain = { methods: ['isolated', 'sor'], isolated: {}, sor: { k: 12, stdRatio: 2 } }
    const r2 = await edited(reader, lod, 'filter', { ...chain, tilePoints: 60_000 })
    expect(r2.lod.points).toBe(filterCloud(c, chain).count)
  }, 60_000)
})
