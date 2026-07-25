import { describe, it, expect } from 'vitest'
import { pickSpreadIndices, sliceDescriptorRows, resolveSubsetGateSize, SUBSET_GATE_SIZE_DEFAULTS } from './subsetGate.js'

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

describe('resolveSubsetGateSize', () => {
  const size = (a, b, opts = {}) => resolveSubsetGateSize(a, b, { floorSize: 200, ...opts }).size

  // The whole point: the sampling FRACTION is what must stay put, because the
  // gate's threshold is applied to a sampled count. A fixed size makes the test
  // ~1/N more severe as keypoint counts rise.
  it('holds the sampling fraction roughly constant above the floor', () => {
    for (const n of [6000, 10000, 20000, 25000]) {
      const { fraction } = resolveSubsetGateSize(n, n, { floorSize: 200 })
      expect(fraction).toBeCloseTo(SUBSET_GATE_SIZE_DEFAULTS.fraction, 2)
    }
  })

  it('reproduces the historical 200 subset at the calibration point', () => {
    // 0.04 × 5000 = 200 — the pairing the shipped subsetGateThreshold was set against.
    expect(size(5000, 5000)).toBe(200)
  })

  it('grows the sample for the Detailed detection preset', () => {
    // 25 000 keypoints/image is SIFT high. A fixed 200 samples 0.8% of each image
    // and expects well under one putative from a genuinely overlapping pair.
    expect(size(25000, 25000)).toBe(1000)
    expect(size(25000, 25000)).toBeGreaterThan(size(5000, 5000))
  })

  it('never drops below the caller-supplied floor', () => {
    for (const n of [50, 200, 1000, 3000]) {
      expect(size(n, n)).toBeGreaterThanOrEqual(200)
    }
  })

  it('treats the user setting as a floor, not an exact size', () => {
    // A user who raised subsetGateSize gets at least that, and more if the
    // keypoint counts warrant it.
    expect(size(5000, 5000, { floorSize: 400 })).toBe(400)
    expect(size(25000, 25000, { floorSize: 400 })).toBe(1000)
  })

  it('respects the cost ceiling even against a larger floor', () => {
    // The ceiling is a hard O(s²) cost bound; the floor is only a preference.
    expect(size(25000, 25000, { floorSize: 5000 })).toBe(SUBSET_GATE_SIZE_DEFAULTS.maxSize)
  })

  it('is monotonic in keypoint count', () => {
    let prev = 0
    for (const n of [500, 1000, 5000, 10000, 20000, 40000]) {
      const v = size(n, n)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('uses the geometric mean of an uneven pair', () => {
    expect(size(2500, 10000)).toBe(size(5000, 5000))
  })

  it('reports why it clamped', () => {
    expect(resolveSubsetGateSize(1000, 1000, { floorSize: 200 }).clamped).toBe('floor')
    expect(resolveSubsetGateSize(40000, 40000, { floorSize: 200 }).clamped).toBe('ceil')
    expect(resolveSubsetGateSize(10000, 10000, { floorSize: 200 }).clamped).toBe(null)
  })

  it('degrades safely on missing counts', () => {
    for (const bad of [0, null, undefined, NaN, -1]) {
      expect(size(bad, 5000)).toBe(200)
    }
  })

  // The gate only earns its place by being much cheaper than the match it skips.
  it('stays far cheaper than the full match it replaces', () => {
    for (const n of [5000, 10000, 25000]) {
      const s = size(n, n)
      expect((s * s) / (n * n)).toBeLessThan(0.01)
    }
  })
})
