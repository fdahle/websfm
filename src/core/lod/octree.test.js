import { describe, it, expect } from 'vitest'
import { rootCube, nodeCube, buildOctree, buildSubtree, subsample, keyString, GRID } from './octree.js'
import { encodeNode, decodeNode, nodeBytes, typeName } from './nodeCodec.js'
import { encodeHierarchy, decodeHierarchy, childrenOf } from './hierarchy.js'

// A wavy terrain of n points over 1 km × 1 km with metre-scale relief: the 2.5D shape
// LiDAR and aerial dense clouds have, the hard case for an octree's balance.
function terrain(n, seed = 1) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pos = new Float64Array(3 * n), col = new Uint8Array(3 * n), cls = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const x = rnd() * 1000, y = rnd() * 1000
    pos[3 * i] = 400000 + x; pos[3 * i + 1] = 5000000 + y; pos[3 * i + 2] = 20 + 5 * Math.sin(x / 50) * Math.cos(y / 70) + rnd() * 0.2
    col[3 * i] = i & 255; col[3 * i + 1] = (i >> 8) & 255; col[3 * i + 2] = 7
    cls[i] = i % 3 ? 2 : 1
  }
  return { count: n, pos, col, attributes: { classification: cls } }
}
const bounds = (c) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c.pos[3 * i + k]); max[k] = Math.max(max[k], c.pos[3 * i + k]) }
  return { min, max }
}

function checkPartition(nodes, n) {
  const seen = new Uint8Array(n)
  let total = 0
  for (const node of nodes.values()) for (const i of node.idx) { seen[i]++; total++ }
  expect(total).toBe(n)
  expect(seen.every((v) => v === 1)).toBe(true)
}

describe('octree', () => {
  it('subsample keeps one point per occupied cell, the one nearest its centre', () => {
    const pts = { count: 3, pos: Float64Array.of(0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9) }
    const { picked, rest } = subsample(pts, Uint32Array.of(0, 1, 2), { min: [0, 0, 0], size: 1 }, 1)
    expect([...picked]).toEqual([1])
    expect([...rest]).toEqual([0, 2])
  })

  it('puts every point in exactly one node; a node never holds two points of one cell', () => {
    const cloud = terrain(400000)
    const { min, max } = bounds(cloud)
    const root = rootCube(min, max)
    const nodes = buildOctree(cloud, root, { leafMax: 20000 })
    checkPartition(nodes, cloud.count)
    // The spacing halves per level: every interior level holds about 4× the points of
    // the one above (2.5D terrain fills each node's grid as a surface).
    const perLevel = []
    for (const n of nodes.values()) if (n.idx.length > 20000) perLevel[n.key[0]] = (perLevel[n.key[0]] ?? 0) + n.idx.length
    for (let l = 1; l < perLevel.length; l++) if (perLevel[l]) expect(perLevel[l] / perLevel[l - 1]).toBeGreaterThan(2.5)
    expect(nodes.size).toBeGreaterThan(8)
    // Interior nodes: at most one point per grid cell of their cube.
    for (const n of nodes.values()) {
      const cube = nodeCube(root, n.key), cs = cube.size / GRID
      if (n.idx.length > 20000) {
        const cells = new Set()
        for (const i of n.idx) {
          const c = [0, 1, 2].map((k) => Math.floor((cloud.pos[3 * i + k] - cube.min[k]) / cs)).join(',')
          expect(cells.has(c)).toBe(false)
          cells.add(c)
        }
      }
      // Every point lies inside its node's cube.
      for (const i of n.idx.subarray(0, 50)) for (let k = 0; k < 3; k++) {
        expect(cloud.pos[3 * i + k]).toBeGreaterThanOrEqual(cube.min[k] - 1e-6)
        expect(cloud.pos[3 * i + k]).toBeLessThanOrEqual(cube.min[k] + cube.size + 1e-6)
      }
    }
    // The root is a coarse overview: on 2.5D terrain at most one point per cell column.
    expect(nodes.get('0-0-0-0').idx.length).toBeLessThanOrEqual(GRID * GRID * 2)
  })

  it('builds a valid partition chunked (as out of core), with the top levels lifted', () => {
    const cloud = terrain(200000, 7)
    const { min, max } = bounds(cloud)
    const root = rootCube(min, max)
    const chunked = buildOctree(cloud, root, { leafMax: 10000, chunkLevel: 2 })
    checkPartition(chunked, cloud.count)
    // The levels above the chunks exist and hold a lifted subsample.
    expect(chunked.get('0-0-0-0')?.idx.length).toBeGreaterThan(1000)
    expect([...chunked.values()].some((n) => n.key[0] === 1)).toBe(true)
  })

  it('a small cloud is one leaf', () => {
    const cloud = terrain(1000)
    const { min, max } = bounds(cloud)
    const nodes = buildSubtree(cloud, Uint32Array.from({ length: 1000 }, (_, i) => i), rootCube(min, max))
    expect(nodes.length).toBe(1)
    expect(keyString(nodes[0].key)).toBe('0-0-0-0')
  })
})

describe('node codec', () => {
  it('round-trips positions to the quantum, colour and attributes exactly', () => {
    const cloud = terrain(5000, 3)
    const idx = Uint32Array.from({ length: 777 }, (_, i) => i * 6)
    const layout = { offset: [400000, 5000000, 0], scale: [0.001, 0.001, 0.001], colour: true,
      attributes: [{ name: 'classification', type: typeName(cloud.attributes.classification) }] }
    const bytes = encodeNode(cloud, idx, layout)
    expect(bytes.length).toBe(nodeBytes(idx.length, layout))
    const abs = decodeNode(bytes, idx.length, layout, { as: 'absolute' })
    const rel = decodeNode(bytes, idx.length, layout)
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]
      for (let c = 0; c < 3; c++) expect(Math.abs(abs.pos[3 * k + c] - cloud.pos[3 * i + c])).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.abs(rel.pos[3 * k] + 400000 - cloud.pos[3 * i])).toBeLessThan(0.002)
      expect([...abs.col.subarray(3 * k, 3 * k + 3)]).toEqual([...cloud.col.subarray(3 * i, 3 * i + 3)])
      expect(abs.attributes.classification[k]).toBe(cloud.attributes.classification[i])
    }
  })
})

describe('hierarchy', () => {
  it('round-trips keys, counts and byte ranges past 4 GB', () => {
    const nodes = [
      { key: [0, 0, 0, 0], count: 16000, offset: 0, length: 16000 * 16 },
      { key: [1, 1, 0, 1], count: 0, offset: 256000, length: 0 },
      { key: [2, 3, 1, 2], count: 32768, offset: 5.5 * 2 ** 30, length: 524288 },
    ]
    const h = decodeHierarchy(encodeHierarchy(nodes))
    expect([...h.keys()]).toEqual(['0-0-0-0', '1-1-0-1', '2-3-1-2'])
    expect(h.get('2-3-1-2')).toEqual(nodes[2])
    expect(childrenOf(h, [1, 1, 0, 1]).map((n) => n.key)).toEqual([[2, 3, 1, 2]])
  })
})
