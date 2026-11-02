import { describe, it, expect } from 'vitest'
import {
  TILE,
  tileResolution,
  lonLatToTile,
  tileToLonLat,
  tmsRow,
  zoomRange,
  tileRange,
  tileSourceGrid,
  sampleTile,
  downsampleChildren,
  mbtilesMetadata,
} from './webTiles.js'

describe('tile maths', () => {
  it('places lon/lat on the Web Mercator tile grid and back', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual([1, 1])
    expect(lonLatToTile(-180, 85.0511287798066, 3)[1]).toBeCloseTo(0, 9)
    const [x, y] = lonLatToTile(-81.7523, 41.3041, 17)
    const [lon, lat] = tileToLonLat(x, y, 17)
    expect(lon).toBeCloseTo(-81.7523, 9)
    expect(lat).toBeCloseTo(41.3041, 9)
    expect(tmsRow(0, 3)).toBe(7)
    expect(tileResolution(0, 0)).toBeCloseTo(156543.034, 2)
  })

  it('writes zooms from a tile or two of the whole area down to the orthophoto pixel', () => {
    // A 2 cm orthophoto of ~200 m at 41° N.
    const bbox = [-81.754, 41.303, -81.7515, 41.305]
    const { minZoom, maxZoom } = zoomRange({ gsd: 0.02, lat: 41.304, bbox })
    expect(tileResolution(41.304, maxZoom)).toBeLessThanOrEqual(0.02)
    expect(tileResolution(41.304, maxZoom - 1)).toBeGreaterThan(0.02)
    const fits = tileRange(bbox, minZoom),
      finer = tileRange(bbox, minZoom + 1)
    expect(fits.x1 - fits.x0 <= 1 && fits.y1 - fits.y0 <= 1).toBe(true)
    expect(finer.x1 - finer.x0 > 1 || finer.y1 - finer.y0 > 1).toBe(true)
    expect(minZoom).toBeLessThan(maxZoom)
    expect(zoomRange({ gsd: 1e-6, lat: 0, bbox, cap: 20 }).maxZoom).toBe(20)
  })
})

describe('tileSourceGrid and sampleTile', () => {
  it('resamples a source that is the tile itself back to the same pixels', () => {
    // A source raster laid on tile (z 10, x 300, y 400) pixel for pixel.
    const [z, x, y] = [10, 300, 400]
    const toSource = (lon, lat) => {
      const [tx, ty] = lonLatToTile(lon, lat, z)
      return [(tx - x) * TILE - 0.5, (ty - y) * TILE - 0.5]
    }
    const grid = tileSourceGrid(z, x, y, toSource)
    expect(grid[0]).toBeCloseTo(0, 6)
    expect(grid[2 * (TILE * TILE - 1)]).toBeCloseTo(TILE - 1, 6)
    const src = new Uint8ClampedArray(TILE * TILE * 4)
    for (let i = 0; i < TILE * TILE; i++) src.set([i % 256, (i >> 8) % 256, 7, 255], i * 4)
    src[3] = 0 // one nodata cell
    const out = new Uint8ClampedArray(TILE * TILE * 4)
    expect(sampleTile(grid, src, TILE, TILE, 0, 0, out)).toBe(true)
    expect([...out.slice(4 * 1000, 4 * 1001)]).toEqual([...src.slice(4 * 1000, 4 * 1001)])
    expect(out[3]).toBe(0)
  })

  it('leaves pixels outside the source transparent', () => {
    const grid = new Float64Array(TILE * TILE * 2).fill(-50)
    const out = new Uint8ClampedArray(TILE * TILE * 4)
    expect(sampleTile(grid, new Uint8ClampedArray(16).fill(255), 2, 2, 0, 0, out)).toBe(false)
  })
})

describe('downsampleChildren', () => {
  it('averages each 2 × 2 block of its four children', () => {
    const solid = (v) => new Uint8ClampedArray(TILE * TILE * 4).map((_, i) => (i % 4 === 3 ? 255 : v))
    const out = downsampleChildren([solid(10), solid(20), null, solid(40)])
    expect([...out.slice(0, 4)]).toEqual([10, 10, 10, 255])
    expect([...out.slice((TILE - 1) * 4, TILE * 4)]).toEqual([20, 20, 20, 255])
    expect(out[TILE * (TILE - 1) * 4 + 3]).toBe(0)
    expect(downsampleChildren([null, null, null, null])).toBeNull()
  })
})

describe('mbtilesMetadata', () => {
  it('names the format, bounds and zooms', () => {
    const m = Object.fromEntries(
      mbtilesMetadata({ name: 'site', format: 'jpg', bbox: [1, 2, 3, 4], minZoom: 14, maxZoom: 21 }),
    )
    expect(m).toMatchObject({ format: 'jpg', bounds: '1,2,3,4', minzoom: '14', maxzoom: '21', center: '2,3,17' })
  })
})
