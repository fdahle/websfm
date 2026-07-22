import { describe, it, expect } from 'vitest'
import {
  cloudBounds, cloudCount, cropCloud, filterRange, removeIsolated,
  statisticalOutlierFilter, voxelDownsample, filterCloud, mergeClouds,
  estimateSpacing, clampGridCell,
} from './cloudEdit.js'

// Build a flat cloud from [[x,y,z], …] plus optional colours/normals.
function makeCloud(xyz, { col = null, nrm = null } = {}) {
  const n = xyz.length
  const pos = new Float32Array(n * 3)
  xyz.forEach((p, i) => pos.set(p, i * 3))
  const out = { count: n, pos }
  if (col) { out.col = new Uint8Array(n * 3); col.forEach((c, i) => out.col.set(c, i * 3)) }
  if (nrm) { out.nrm = new Float32Array(n * 3); nrm.forEach((v, i) => out.nrm.set(v, i * 3)) }
  return out
}

const xyzOf = (c) => Array.from({ length: cloudCount(c) },
  (_, i) => [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]])

// A dense-ish 6×6×6 lattice at unit spacing — the "real surface" every filter must keep.
function lattice(n = 6, step = 1) {
  const pts = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++)
    pts.push([i * step, j * step, k * step])
  return pts
}

describe('cloudBounds / cloudCount', () => {
  it('returns null bounds for an empty cloud', () => {
    expect(cloudBounds({ count: 0, pos: new Float32Array(0) })).toBeNull()
  })

  it('derives count from pos when absent', () => {
    expect(cloudCount({ pos: new Float32Array(9) })).toBe(3)
  })

  it('spans every axis', () => {
    const b = cloudBounds(makeCloud([[-1, 2, 3], [4, -5, 6]]))
    expect(b).toEqual({ minX: -1, minY: -5, minZ: 3, maxX: 4, maxY: 2, maxZ: 6 })
  })
})

describe('cropCloud', () => {
  const cloud = makeCloud([[0, 0, 0], [5, 5, 5], [10, 10, 10]],
    { col: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] })

  it('keeps points inside the box, inclusive of the bounds', () => {
    const out = cropCloud(cloud, { min: [0, 0, 0], max: [5, 5, 5] })
    expect(xyzOf(out)).toEqual([[0, 0, 0], [5, 5, 5]])
  })

  it('carries colour through, aligned to the kept points', () => {
    const out = cropCloud(cloud, { min: [4, 4, 4], max: [6, 6, 6] })
    expect(Array.from(out.col)).toEqual([4, 5, 6])
  })

  it('inverts to keep everything outside the box', () => {
    const out = cropCloud(cloud, { min: [4, 4, 4], max: [6, 6, 6], invert: true })
    expect(xyzOf(out)).toEqual([[0, 0, 0], [10, 10, 10]])
  })

  it('treats a missing component as unbounded (Z-only crop)', () => {
    const out = cropCloud(cloud, { min: [null, null, 4], max: [null, null, null] })
    expect(xyzOf(out)).toEqual([[5, 5, 5], [10, 10, 10]])
  })

  it('never mutates or aliases the source buffers', () => {
    const out = cropCloud(cloud, { min: [0, 0, 0], max: [5, 5, 5] })
    expect(out.pos.buffer).not.toBe(cloud.pos.buffer)
    expect(cloudCount(cloud)).toBe(3)
  })

  it('returns an empty cloud when nothing survives', () => {
    const out = cropCloud(cloud, { min: [100, 100, 100], max: [200, 200, 200] })
    expect(out.count).toBe(0)
    expect(out.pos.length).toBe(0)
  })
})

describe('filterRange', () => {
  const cloud = makeCloud([[0, 0, 0], [0, 0, 5], [0, 0, 10]],
    { col: [[0, 0, 0], [128, 128, 128], [255, 255, 255]] })

  it('keeps an elevation band', () => {
    expect(xyzOf(filterRange(cloud, { zMin: 1, zMax: 9 }))).toEqual([[0, 0, 5]])
  })

  it('keeps a brightness band', () => {
    expect(xyzOf(filterRange(cloud, { lumaMin: 200 }))).toEqual([[0, 0, 10]])
  })

  it('ignores brightness bounds on a colourless cloud rather than dropping everything', () => {
    const bare = makeCloud([[0, 0, 0], [0, 0, 5]])
    const logs = []
    const out = filterRange(bare, { lumaMin: 200 }, (m, l) => logs.push(l))
    expect(out.count).toBe(2)
    expect(logs).toContain('warn')
  })
})

describe('voxelDownsample', () => {
  it('collapses coincident points into one averaged point', () => {
    const cloud = makeCloud([[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [10, 0, 0]])
    const out = voxelDownsample(cloud, { cell: 1 })
    expect(out.count).toBe(2)
    expect(out.pos[0]).toBeCloseTo(0.1, 5)
  })

  it('averages colour across the cell', () => {
    const cloud = makeCloud([[0, 0, 0], [0.1, 0, 0]], { col: [[0, 0, 0], [100, 200, 40]] })
    const out = voxelDownsample(cloud, { cell: 1 })
    expect(Array.from(out.col)).toEqual([50, 100, 20])
  })

  it('averages and renormalizes normals', () => {
    const cloud = makeCloud([[0, 0, 0], [0.1, 0, 0]], { nrm: [[1, 0, 0], [0, 1, 0]] })
    const out = voxelDownsample(cloud, { cell: 1 })
    expect(Math.hypot(out.nrm[0], out.nrm[1], out.nrm[2])).toBeCloseTo(1, 5)
  })

  it('is a no-op at cell <= 0', () => {
    const cloud = makeCloud([[0, 0, 0]])
    expect(voxelDownsample(cloud, { cell: 0 })).toBe(cloud)
  })

  it('keeps precision on survey-sized coordinates (origin shift)', () => {
    // Float32 alone cannot hold 500000.25 to cm; the cell-aligned shift is what saves it.
    const cloud = makeCloud([[500000.25, 7000000.5, 100.125]])
    const out = voxelDownsample(cloud, { cell: 0.5 })
    expect(out.pos[0]).toBeCloseTo(500000.25, 2)
    expect(out.pos[1]).toBeCloseTo(7000000.5, 2)
  })
})

describe('statisticalOutlierFilter', () => {
  it('drops a far flyer and keeps the surface', () => {
    const surface = lattice()
    const withFlyer = [...surface, [100, 100, 100]]
    const opts = { k: 6, stdRatio: 2.5 }
    const base = statisticalOutlierFilter(makeCloud(surface), opts)
    const out = statisticalOutlierFilter(makeCloud(withFlyer), opts)
    expect(xyzOf(out)).not.toContainEqual([100, 100, 100])
    expect(out.count).toBe(base.count)
  })

  it('keeps a uniform lattice intact at a tolerant stdRatio', () => {
    // A finite lattice has genuinely sparser corners (3 neighbours at 1, 3 at √2), so a
    // tight ratio legitimately trims them — the filter is not supposed to be a no-op.
    const cloud = makeCloud(lattice())
    expect(statisticalOutlierFilter(cloud, { k: 6, stdRatio: 2.5 }).count).toBe(cloudCount(cloud))
    expect(statisticalOutlierFilter(cloud, { k: 6, stdRatio: 1.5 }).count).toBe(cloudCount(cloud) - 8)
  })

  it('drops a point with no neighbour at all', () => {
    const pts = lattice()
    pts.push([1000, 1000, 1000])
    const out = statisticalOutlierFilter(makeCloud(pts), { k: 6, stdRatio: 100 })
    // Even an absurd stdRatio cannot rescue it: it contributes no distance at all.
    expect(out.count).toBe(pts.length - 1)
  })

  it('passes through clouds too small to have statistics', () => {
    const cloud = makeCloud([[0, 0, 0], [1, 1, 1]])
    expect(statisticalOutlierFilter(cloud, {}).count).toBe(2)
  })
})

describe('removeIsolated', () => {
  it('removes a lone speck but keeps a supported cluster', () => {
    const pts = lattice()
    pts.push([80, 80, 80])
    const out = removeIsolated(makeCloud(pts), { minNeighbors: 2, maxSupport: 2 })
    expect(xyzOf(out)).not.toContainEqual([80, 80, 80])
    expect(out.count).toBe(pts.length - 1)
  })

  it('keeps a well-supported cell even with no occupied neighbours', () => {
    // Five coincident points in one cell, far from anything: support beats isolation.
    const pts = [...lattice(), [80, 80, 80], [80.01, 80, 80], [80, 80.01, 80], [80, 80, 80.01], [80.01, 80.01, 80]]
    const out = removeIsolated(makeCloud(pts), { cell: 1, minNeighbors: 2, maxSupport: 2 })
    expect(xyzOf(out)).toContainEqual([80, 80, 80])
  })
})

describe('filterCloud dispatch', () => {
  it('chains methods in the given order', () => {
    const pts = [[0, 0, 0], [0.1, 0, 0], [0, 0, 50]]
    const out = filterCloud(makeCloud(pts), {
      methods: ['range', 'voxel'],
      range: { zMax: 10 },
      voxel: { cell: 1 },
    })
    expect(out.count).toBe(1)
  })

  it('returns a copy — never the input cloud itself — when no method runs', () => {
    const cloud = makeCloud([[0, 0, 0]])
    const out = filterCloud(cloud, { methods: [] })
    expect(out).not.toBe(cloud)
    expect(out.pos.buffer).not.toBe(cloud.pos.buffer)
    expect(xyzOf(out)).toEqual([[0, 0, 0]])
  })

  it('warns on an unknown method instead of throwing', () => {
    const logs = []
    const out = filterCloud(makeCloud([[0, 0, 0]]), { methods: ['nope'] }, (m, l) => logs.push(l))
    expect(logs).toContain('warn')
    expect(out.count).toBe(1)
  })
})

describe('mergeClouds', () => {
  it('concatenates points in input order', () => {
    const a = makeCloud([[0, 0, 0]])
    const b = makeCloud([[1, 1, 1], [2, 2, 2]])
    expect(xyzOf(mergeClouds([a, b]))).toEqual([[0, 0, 0], [1, 1, 1], [2, 2, 2]])
  })

  it('fills neutral grey for an input without colour when any other has it', () => {
    const a = makeCloud([[0, 0, 0]], { col: [[10, 20, 30]] })
    const b = makeCloud([[1, 1, 1]])
    const out = mergeClouds([a, b])
    expect(Array.from(out.col)).toEqual([10, 20, 30, 200, 200, 200])
  })

  it('drops normals unless every input carries them', () => {
    const a = makeCloud([[0, 0, 0]], { nrm: [[0, 0, 1]] })
    const b = makeCloud([[1, 1, 1]])
    expect(mergeClouds([a, b]).nrm).toBeUndefined()
    const c = makeCloud([[1, 1, 1]], { nrm: [[0, 1, 0]] })
    expect(mergeClouds([a, c]).nrm).toBeInstanceOf(Float32Array)
  })

  it('dedupes the overlap seam when a cell is given', () => {
    const a = makeCloud([[0, 0, 0], [1, 0, 0]])
    const b = makeCloud([[0.05, 0, 0], [1.05, 0, 0]])
    expect(mergeClouds([a, b], { cell: 0.5 }).count).toBe(2)
  })

  it('skips empty inputs and survives an all-empty list', () => {
    expect(mergeClouds([{ count: 0, pos: new Float32Array(0) }]).count).toBe(0)
    expect(mergeClouds([]).count).toBe(0)
  })
})

describe('grid sizing helpers', () => {
  it('grows the cell until the packed key space is representable', () => {
    const huge = { minX: -1e9, minY: -1e9, minZ: -1e9, maxX: 1e9, maxY: 1e9, maxZ: 1e9 }
    const c = clampGridCell(huge, 1e-6)
    const cells = [0, 1, 2].map(() => Math.floor(2e9 / c) + 3).reduce((a, b) => a * b, 1)
    expect(cells).toBeLessThanOrEqual(2 ** 50)
  })

  it('falls back through the non-zero extents of a planar cloud', () => {
    const planar = { minX: 0, minY: 0, minZ: 5, maxX: 10, maxY: 10, maxZ: 5 }
    expect(estimateSpacing(planar, 100)).toBeCloseTo(1, 6)
  })

  it('returns 0 spacing for a degenerate (single-location) cloud', () => {
    expect(estimateSpacing({ minX: 1, minY: 1, minZ: 1, maxX: 1, maxY: 1, maxZ: 1 }, 10)).toBe(0)
  })
})
