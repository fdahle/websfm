import { describe, it, expect } from 'vitest'
import { buildLod, chooseLayout, chunkLevelFor, distributeLod, buildChunks, finishLod } from './build.js'
import { decodeHierarchy, childrenOf } from './hierarchy.js'
import { decodeNode } from './nodeCodec.js'
import { nodeCube, keyString, GRID } from './octree.js'

// Chunk files and the data file in memory, as the worker keeps them in OPFS.
function memoryStores() {
  const files = new Map() // name → blocks, each appended whole (and read within one)
  let held = 0,
    peak = 0
  const tmp = {
    files,
    get peak() {
      return peak
    },
    async append(name, u8) {
      ;(files.get(name) ?? files.set(name, []).get(name)).push(u8)
      held += u8.length
      peak = Math.max(peak, held)
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
      for (const b of files.get(name) ?? []) held -= b.length
      files.delete(name)
    },
  }
  const chunks = []
  let size = 0
  const out = {
    async write(u8) {
      const at = size
      chunks.push(u8)
      size += u8.length
      return at
    },
    bytes() {
      const all = new Uint8Array(size)
      let o = 0
      for (const c of chunks) {
        all.set(c, o)
        o += c.length
      }
      return all
    },
  }
  return { tmp, out }
}

// Terrain with a dense cluster (a tower: a fifth of the points in 4 m × 4 m) so one
// chunk is far over the limit and has to be re-split.
function cloud(n) {
  let s = 5
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const pos = new Float32Array(3 * n),
    col = new Uint8Array(3 * n),
    cls = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const tower = i % 5 === 0
    const x = tower ? 600 + rnd() * 4 : rnd() * 1000,
      y = tower ? 300 + rnd() * 4 : rnd() * 1000
    pos[3 * i] = x
    pos[3 * i + 1] = y
    pos[3 * i + 2] = tower ? rnd() * 80 : 3 * Math.sin(x / 40) + rnd() * 0.1
    col[3 * i] = i & 255
    col[3 * i + 1] = (i >> 8) & 255
    col[3 * i + 2] = (i >> 16) & 255
    cls[i] = tower ? 6 : 2
  }
  return { pos, col, cls }
}

function sourceOf({ pos, col, cls }, batch = 50000) {
  const count = pos.length / 3
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[3 * i + k])
      max[k] = Math.max(max[k], pos[3 * i + k])
    }
  return {
    count,
    bounds: { min, max },
    colour: true,
    attributes: [{ name: 'classification', type: 'uint8' }],
    async *batches() {
      for (let s = 0; s < count; s += batch) {
        const e = Math.min(count, s + batch)
        yield {
          count: e - s,
          pos: pos.subarray(3 * s, 3 * e),
          col: col.subarray(3 * s, 3 * e),
          attributes: { classification: cls.subarray(s, e) },
        }
      }
    },
  }
}

describe('buildLod (out of core)', () => {
  it('stores every point once, re-splits an oversized chunk, and keeps chunk memory bounded', async () => {
    const n = 300000,
      c = cloud(n)
    const src = sourceOf(c)
    const { tmp, out } = memoryStores()
    const progress = []
    const res = await buildLod(src, tmp, out, {
      chunkMax: 40000,
      leafMax: 8000,
      onProgress: (d, t, l) => progress.push(l),
    })
    expect(res.points).toBe(n)
    expect(tmp.files.size).toBe(0) // every chunk file removed
    expect(progress).toContain('Building the octree')

    const data = out.bytes()
    expect(res.dataBytes).toBe(data.length)
    const h = decodeHierarchy(res.hierarchy)
    expect(h.size).toBe(res.nodeCount)
    // Every point once: colour encodes the index.
    const seen = new Uint8Array(n)
    let worst = 0,
      wrongClass = 0,
      doubled = 0
    for (const node of h.values()) {
      const s = keyString(node.key)
      if (node.key[0] > 0)
        expect(h.has(keyString([node.key[0] - 1, node.key[1] >> 1, node.key[2] >> 1, node.key[3] >> 1])), s).toBe(true)
      if (!node.count) {
        expect(childrenOf(h, node.key).length).toBeGreaterThan(0)
        continue
      }
      const pts = decodeNode(data.subarray(node.offset, node.offset + node.length), node.count, res.layout, {
        as: 'absolute',
      })
      const cube = nodeCube(res.root, node.key),
        cs = cube.size / GRID
      const cells = new Set(),
        interior = childrenOf(h, node.key).length > 0
      for (let k = 0; k < node.count; k++) {
        const i = pts.col[3 * k] | (pts.col[3 * k + 1] << 8) | (pts.col[3 * k + 2] << 16)
        seen[i]++
        // The stored position is the source's, to the quantum.
        for (let a = 0; a < 3; a++)
          worst = Math.max(worst, Math.abs(pts.pos[3 * k + a] - c.pos[3 * i + a]) / res.layout.scale[a])
        if (pts.attributes.classification[k] !== c.cls[i]) wrongClass++
        // Interior nodes: one point per grid cell.
        if (interior) {
          const cell = [0, 1, 2]
            .map((a) => Math.min(GRID - 1, Math.floor((pts.pos[3 * k + a] - cube.min[a]) / cs)))
            .join()
          if (cells.has(cell)) doubled++
          cells.add(cell)
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5 + 1e-6)
    expect(wrongClass).toBe(0)
    expect(doubled).toBe(0)
    expect(seen.every((v) => v === 1)).toBe(true)
    // The tower forced chunks below the first chunk level.
    expect(res.levels).toBeGreaterThan(chunkLevelFor(n, 40000) + 2)
    // The chunk files never held much more than the cloud itself (one copy, quantised).
    expect(tmp.peak).toBeLessThan(n * 20 * 1.5)
  })

  it('builds the chunks apart (the pool) into the same octree', async () => {
    const n = 200000,
      c = cloud(n)
    const opts = { chunkMax: 30000, leafMax: 8000 }
    const one = memoryStores()
    const whole = await buildLod(sourceOf(c), one.tmp, one.out, opts)
    // As the pool runs it: sort once, each chunk into a part of its own, then the join
    // (the parts copied into the data file, their offsets moved by where they landed).
    const { tmp, out } = memoryStores()
    const state = await distributeLod(sourceOf(c), tmp, opts)
    expect(state.chunks.length).toBeGreaterThan(3)
    const parts = []
    for (const chunk of state.chunks) {
      const part = memoryStores().out
      const r = await buildChunks([chunk], tmp, part, state, opts)
      parts.push({ ...r, bytes: part.bytes() })
    }
    for (const p of parts) p.base = await out.write(p.bytes)
    const joined = await finishLod(state, parts, out, opts)
    expect(tmp.files.size).toBe(0)
    expect(joined.points).toBe(n)
    expect(joined.nodeCount).toBe(whole.nodeCount)
    expect(joined.dataBytes).toBe(whole.dataBytes)
    // Node by node the same points (the data file is ordered differently).
    const nodes = (res, bytes) => {
      const m = new Map()
      for (const node of decodeHierarchy(res.hierarchy).values()) {
        if (!node.count) continue
        const pts = decodeNode(bytes.subarray(node.offset, node.offset + node.length), node.count, res.layout, {
          as: 'absolute',
        })
        m.set(keyString(node.key), Array.from(pts.col).join(','))
      }
      return m
    }
    const a = nodes(whole, one.out.bytes()),
      b = nodes(joined, out.bytes())
    expect(b.size).toBe(a.size)
    for (const [k, v] of a) expect(b.get(k)).toBe(v)
  })

  it('counts no point outside the extent that only quantised past it', async () => {
    // Coordinates off the 1 mm grid: the lowest rounds down below the measured minimum.
    const n = 2000
    const pos = new Float64Array(3 * n)
    for (let i = 0; i < n; i++) {
      pos[3 * i] = 0.0004 + (i % 50) * 0.37
      pos[3 * i + 1] = 0.0004 + Math.floor(i / 50) * 0.29
      pos[3 * i + 2] = 0.0004 + (i % 7) * 0.11
    }
    const src = sourceOf({ pos, col: new Uint8Array(3 * n), cls: new Uint8Array(n) })
    const { tmp, out } = memoryStores()
    const res = await buildLod(src, tmp, out, { layout: { offset: [0, 0, 0], scale: [0.001, 0.001, 0.001] } })
    expect(res.points).toBe(n)
    expect(res.outside).toBeUndefined()
  })

  it('a LAS layout is kept as given', () => {
    const l = chooseLayout({
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      offset: [100, 200, 0],
      scale: [0.01, 0.01, 0.001],
    })
    expect(l.offset).toEqual([100, 200, 0])
    expect(l.scale).toEqual([0.01, 0.01, 0.001])
    const auto = chooseLayout({ bounds: { min: [400123.4, 5000000, 10], max: [401123.4, 5000500, 60] } })
    expect(auto.scale[0]).toBe(1e-5)
  })
})
