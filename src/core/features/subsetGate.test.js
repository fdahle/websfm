import { describe, it, expect } from 'vitest'
import { pickSpreadIndices, sliceDescriptorRows } from './subsetGate.js'

// Build kps on a regular WxH grid so we can reason about spatial spread.
function gridKps(w, h) {
  const kps = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) kps.push({ x: x * 10, y: y * 10 })
  return kps
}

describe('pickSpreadIndices', () => {
  it('returns all indices when n <= count', () => {
    const kps = gridKps(3, 3) // 9 points
    const idx = pickSpreadIndices(kps, 20)
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('returns roughly count indices, all in range and unique', () => {
    const kps = gridKps(20, 20) // 400 points
    const idx = pickSpreadIndices(kps, 50)
    expect(idx.length).toBeLessThanOrEqual(60) // ~50, one per grid cell
    expect(idx.length).toBeGreaterThan(30)
    expect(new Set(idx).size).toBe(idx.length) // no dupes
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0), expect(i).toBeLessThan(400)
  })

  it('samples across the whole frame, not one corner', () => {
    const kps = gridKps(20, 20)
    const idx = pickSpreadIndices(kps, 50)
    const xs = idx.map((i) => kps[i].x)
    const ys = idx.map((i) => kps[i].y)
    // spread should cover most of the [0,190] extent in both axes
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(150)
  })

  it('handles degenerate (all-collinear) keypoints without crashing', () => {
    const kps = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 5 }))
    const idx = pickSpreadIndices(kps, 20)
    expect(idx.length).toBeGreaterThan(0)
    expect(new Set(idx).size).toBe(idx.length)
  })
})

describe('sliceDescriptorRows', () => {
  it('gathers the requested rows in order', () => {
    const dim = 4
    // 5 rows: row r is [r, r, r, r]
    const desc = new Float32Array(5 * dim)
    for (let r = 0; r < 5; r++) desc.fill(r, r * dim, r * dim + dim)
    const out = sliceDescriptorRows(desc, [3, 0, 4], dim)
    expect(Array.from(out)).toEqual([3, 3, 3, 3, 0, 0, 0, 0, 4, 4, 4, 4])
  })

  it('produces a compact indices.length x dim buffer', () => {
    const dim = 128
    const desc = new Float32Array(1000 * dim)
    const out = sliceDescriptorRows(desc, [1, 2, 3], dim)
    expect(out.length).toBe(3 * dim)
  })
})
