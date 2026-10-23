import { describe, expect, it } from 'vitest'
import { projectRasterWindow } from './projectRasterWindow.js'

// A geographic raster, 0.0001° cells, north-up, its corner at (10°E, 50°N).
const geo = { originX: 10, originY: 50, scaleX: 0.0001, scaleY: -0.0001 }
const identity = (lon, lat) => [lon, lat]

describe('projectRasterWindow', () => {
  it('reads the images’ box grown by half its extent', () => {
    const w = projectRasterWindow({
      points: [
        [10.2, 49.8],
        [10.3, 49.7],
      ],
      toRaster: identity,
      geoTransform: geo,
      width: 100000,
      height: 100000,
      minMarginM: 0,
    })
    // lon 10.15–10.35, lat 49.65–49.85 → columns 1500–3500, rows 1500–3500, rounded
    // outward (by at most a cell).
    const want = [1500, 1500, 3500, 3500]
    w.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(1))
    expect(w[0]).toBeLessThanOrEqual(1500)
    expect(w[2]).toBeGreaterThanOrEqual(3500)
  })

  it('takes at least the minimum margin around a single image', () => {
    const [x0, y0, x1, y1] = projectRasterWindow({
      points: [[10.25, 49.75]],
      toRaster: identity,
      geoTransform: geo,
      width: 100000,
      height: 100000,
    })
    // 1 km ≈ 0.009° of latitude ≈ 90 rows each side.
    expect(y1 - y0).toBeGreaterThan(170)
    expect(y1 - y0).toBeLessThan(190)
    expect(x1 - x0).toBeGreaterThan(y1 - y0) // a degree of longitude is shorter at 50°N
  })

  it('clamps to the raster, and is null without points, outside it, or still too large', () => {
    const base = { toRaster: identity, geoTransform: geo, width: 1000, height: 1000, minMarginM: 0 }
    const one = projectRasterWindow({ ...base, points: [[10.01, 49.99]] })
    one.forEach((v) => expect(Math.abs(v - 100)).toBeLessThanOrEqual(1))
    expect(projectRasterWindow({ ...base, points: [[9.9, 49.99]], minMarginM: 30000 })[0]).toBe(0) // clamped
    expect(projectRasterWindow({ ...base, points: [] })).toBeNull()
    expect(projectRasterWindow({ ...base, points: [[20, 40]] })).toBeNull()
    const huge = {
      ...base,
      width: 1e6,
      height: 1e6,
      points: [
        [10, 50],
        [14, 46],
      ],
    }
    expect(projectRasterWindow(huge)).toBeNull()
  })
})
