import { describe, it, expect } from 'vitest'
import { sampleRaster, worldToPixel, pixelToWorld, rasterBounds } from './rasterSample.js'

// A 4×3 north-up raster at origin (100, 200), 10-unit cells. Row 0 is the
// NORTHERN edge, so scaleY is negative — the GeoTIFF convention.
function makeDesc(data, extra = {}) {
  return {
    width: 4,
    height: 3,
    data,
    geoTransform: { originX: 100, originY: 200, scaleX: 10, scaleY: -10 },
    ...extra,
  }
}

// Values are just the linear index, so every assertion is easy to reason about.
const ramp = Float32Array.from({ length: 12 }, (_, i) => i)

describe('worldToPixel / pixelToWorld', () => {
  it('round-trips', () => {
    const d = makeDesc(ramp)
    const p = worldToPixel(d, 145, 175)
    expect(p).toEqual({ col: 4.5, row: 2.5 })
    expect(pixelToWorld(d, p.col, p.row)).toEqual({ x: 145, y: 175 })
  })

  it('puts cell (0,0) centre at origin + half a cell, south-east of the origin', () => {
    const d = makeDesc(ramp)
    expect(pixelToWorld(d, 0.5, 0.5)).toEqual({ x: 105, y: 195 })
  })

  it('returns null without a usable geotransform', () => {
    expect(worldToPixel({ geoTransform: { scaleX: 0, scaleY: -1 } }, 0, 0)).toBeNull()
    expect(pixelToWorld(null, 0, 0)).toBeNull()
  })
})

describe('rasterBounds', () => {
  it('normalises min/max regardless of scale sign', () => {
    // 4 cols × 10 = 40 wide, 3 rows × 10 = 30 tall, hanging south of y=200.
    expect(rasterBounds(makeDesc(ramp))).toEqual([100, 170, 140, 200])
  })
})

describe('sampleRaster', () => {
  it('returns the cell value at a cell centre', () => {
    const d = makeDesc(ramp)
    // Cell (0,0) centre → value 0; cell (2,1) centre → value 1*4+2 = 6.
    expect(sampleRaster(d, 105, 195)).toBeCloseTo(0)
    expect(sampleRaster(d, 125, 185)).toBeCloseTo(6)
  })

  it('interpolates bilinearly between four valid neighbours', () => {
    const d = makeDesc(ramp)
    // Midway between cells (0,0)=0 and (1,0)=1 horizontally, on row 0's centre.
    expect(sampleRaster(d, 110, 195)).toBeCloseTo(0.5)
    // Dead centre of the 2×2 block (0,0),(1,0),(0,1),(1,1) = 0,1,4,5 → 2.5.
    expect(sampleRaster(d, 110, 190)).toBeCloseTo(2.5)
  })

  it('returns null outside the raster', () => {
    const d = makeDesc(ramp)
    expect(sampleRaster(d, 0, 0)).toBeNull()
    expect(sampleRaster(d, 1000, 195)).toBeNull()
  })

  // Nodata must never be averaged into a bilinear result — a -9999 folded into a
  // neighbourhood produces a plausible-looking but badly wrong elevation.
  it('never blends a nodata sentinel into a bilinear sample', () => {
    const data = Float32Array.from(ramp)
    data[1] = -9999
    const d = makeDesc(data, { nodata: -9999 })
    const v = sampleRaster(d, 110, 195)
    // Falls back to the nearest valid cell rather than averaging in -9999.
    expect(v).not.toBeLessThan(0)
    expect(v).toBeGreaterThanOrEqual(0)
  })

  it('treats NaN as nodata for float planes', () => {
    const data = Float32Array.from(ramp)
    data[0] = NaN
    data[1] = NaN
    data[4] = NaN
    data[5] = NaN
    const d = makeDesc(data)
    // Every neighbour of this position is NaN ⇒ null, not 0.
    expect(sampleRaster(d, 110, 190)).toBeNull()
  })

  it('honours an explicit mask (the computed-DEM shape)', () => {
    const mask = new Uint8Array(12).fill(1)
    mask[0] = 0
    const d = makeDesc(ramp, { mask })
    // Cell (0,0) is masked out; the sample falls back to a valid neighbour.
    expect(sampleRaster(d, 105, 195)).not.toBeNull()
    expect(sampleRaster(d, 105, 195)).not.toBe(0)
  })

  it('falls back to the nearest valid cell before giving up', () => {
    const data = new Float32Array(12).fill(NaN)
    data[11] = 42 // only cell (3,2) is valid
    const d = makeDesc(data)
    expect(sampleRaster(d, 135, 175)).toBe(42)
  })

  it('returns null for a missing descriptor', () => {
    expect(sampleRaster(null, 0, 0)).toBeNull()
  })
})
