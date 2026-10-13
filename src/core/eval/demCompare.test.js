import { describe, it, expect } from 'vitest'
import {
  compareDemToReference, summarizeDifferences, differenceHistogram, differenceRange, differenceRgba,
} from './demCompare.js'
import { sampleRaster } from '../io/rasterSample.js'

// A w×h DEM, gsd 1, top-left corner at (0, h): z = f(x, y) at each cell centre.
function makeDem(w, h, f, { holes = [] } = {}) {
  const data = new Float32Array(w * h), mask = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c
    data[i] = f(c + 0.5, h - r - 0.5)
    mask[i] = 1
  }
  for (const i of holes) { data[i] = NaN; mask[i] = 0 }
  return { width: w, height: h, gsd: 1, originX: 0, originY: h, data, mask }
}

describe('compareDemToReference', () => {
  it('reports DEM minus reference (positive = DEM above)', async () => {
    const dem = makeDem(4, 4, (x, y) => 100 + x + y)
    const r = await compareDemToReference(dem, (x, y) => 100 + x + y - 2)
    expect(r.compared).toBe(16)
    expect(r.stats.median).toBeCloseTo(2, 6)
    expect(r.stats.mean).toBeCloseTo(2, 6)
    expect(r.stats.nmad).toBeCloseTo(0, 6)
    expect(r.stats.rmse).toBeCloseTo(2, 6)
  })

  it('samples the reference at the DEM cell centres in the DEM frame', async () => {
    const dem = makeDem(3, 2, () => 0)
    const seen = []
    await compareDemToReference(dem, (x, y) => { seen.push([x, y]); return 0 })
    expect(seen).toEqual([[0.5, 1.5], [1.5, 1.5], [2.5, 1.5], [0.5, 0.5], [1.5, 0.5], [2.5, 0.5]])
  })

  it('separates DEM holes from cells the reference does not cover', async () => {
    const dem = makeDem(4, 1, () => 5, { holes: [0] })
    // Reference covers only x < 2.
    const r = await compareDemToReference(dem, (x) => (x < 2 ? 5 : null))
    expect(r.demCells).toBe(3)
    expect(r.compared).toBe(1)
    expect(Number.isNaN(r.diff[0])).toBe(true)
    expect(r.diff[1]).toBe(0)
    expect([...r.demOnly]).toEqual([0, 0, 1, 1])
  })

  it('compares a large DEM on a sub-grid of at most maxSide cells a side', async () => {
    const dem = makeDem(100, 40, () => 1)
    const r = await compareDemToReference(dem, () => 0, { maxSide: 10 })
    expect(r.step).toBe(10)
    expect([r.width, r.height]).toEqual([10, 4])
    expect(r.compared).toBe(40)
  })

  it('round-trips against a reference read through the shared raster sampler', async () => {
    // The same surface as a reference raster offset by half a cell: bilinear on a
    // plane is exact, so the difference is the constant offset everywhere inside.
    const dem = makeDem(6, 6, (x, y) => 2 * x - y)
    const ref = { width: 8, height: 8, data: new Float32Array(64),
      geoTransform: { originX: -1.5, originY: 7.5, scaleX: 1, scaleY: -1 } }
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const x = -1.5 + c + 0.5, y = 7.5 - r - 0.5
      ref.data[r * 8 + c] = 2 * x - y - 0.25
    }
    const res = await compareDemToReference(dem, (x, y) => sampleRaster(ref, x, y))
    expect(res.compared).toBe(36)
    expect(res.stats.min).toBeCloseTo(0.25, 5)
    expect(res.stats.max).toBeCloseTo(0.25, 5)
  })

  it('stops when the signal is aborted', async () => {
    const dem = makeDem(50, 50, () => 0)
    const signal = { aborted: true }
    const r = await compareDemToReference(dem, () => 0, { signal, sliceMs: -1 })
    expect(r).toBeNull()
  })
})

describe('summarizeDifferences', () => {
  it('is null for no values', () => {
    expect(summarizeDifferences(new Float32Array(0))).toBeNull()
  })

  it('keeps the robust statistics on the bulk when there are blunders', () => {
    const v = [-1, -0.5, 0, 0.5, 1, 0, 0, 0, 0, 50]
    const s = summarizeDifferences(v)
    expect(s.median).toBe(0)
    // Sorted |v − median|: 0,0,0,0,0,.5,.5,1,1,50 → median .25 → NMAD 1.4826·.25.
    expect(s.nmad).toBeCloseTo(1.4826 * 0.25, 6)
    expect(s.mean).toBeCloseTo(5, 6)
    expect(s.rmse).toBeGreaterThan(15)
    expect(s.max).toBe(50)
  })

  it('gives NMAD ≈ σ on normally distributed differences', () => {
    // Deterministic Box–Muller from a fixed LCG.
    let seed = 1
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296
    const v = []
    for (let i = 0; i < 20000; i++) v.push(0.3 * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()))
    const s = summarizeDifferences(v)
    expect(s.nmad).toBeCloseTo(0.3, 1)
    expect(s.std).toBeCloseTo(0.3, 1)
    expect(s.le90).toBeCloseTo(0.3 * 1.645, 1)
  })
})

describe('differenceHistogram', () => {
  it('bins inside the range and counts the tails apart', () => {
    const h = differenceHistogram(Float32Array.from([-5, -1, -0.1, 0.1, 1, NaN, 9]), -1, 1, 4)
    expect(h.counts).toEqual([1, 1, 1, 1])
    expect(h.below).toBe(1)
    expect(h.above).toBe(1)
  })

  it('widens a degenerate range', () => {
    const h = differenceHistogram(Float32Array.from([2, 2]), 2, 2, 2)
    expect(h.lo).toBe(1.5)
    expect(h.counts).toEqual([0, 2])
  })
})

describe('difference map', () => {
  it('centres the colour range on zero', () => {
    expect(differenceRange({ q02: 1, q98: 3 })).toBe(3)
    expect(differenceRange({ q02: -4, q98: 2 })).toBe(4)
    expect(differenceRange({ q02: 0, q98: 0 })).toBe(1)
  })

  it('maps zero to the ramp centre, greys DEM-only cells and leaves holes transparent', () => {
    const ramp = (t) => [Math.round(t * 200), 0, 0]
    const rgba = differenceRgba({ width: 4, height: 1, diff: Float32Array.from([0, 2, NaN, NaN]),
      demOnly: Uint8Array.from([0, 0, 1, 0]) }, 1, ramp)
    expect([...rgba.slice(0, 4)]).toEqual([100, 0, 0, 255])
    expect(rgba[4]).toBe(200)
    expect([...rgba.slice(8, 12)]).toEqual([128, 128, 128, 90])
    expect(rgba[15]).toBe(0)
  })
})
