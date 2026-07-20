import { describe, it, expect } from 'vitest'
import { createFlatRasterSource } from './rasterSource.js'

const meta = {
  name: 'test.tif',
  kind: 'dem',
  width: 4,
  height: 3,
  bands: 1,
  dtype: 'float32',
  nodata: null,
  geoTransform: { originX: 100, originY: 200, scaleX: 10, scaleY: -10 },
}
const ramp = Float32Array.from({ length: 12 }, (_, i) => i)

describe('createFlatRasterSource', () => {
  it('exposes the RasterSource shape the COG implementation will have to match', () => {
    const s = createFlatRasterSource(meta, ramp)
    for (const key of ['meta', 'sampleAt', 'readWindow', 'previewDataUrl']) {
      expect(s[key], `missing ${key}`).toBeDefined()
    }
  })

  it('samples in the raster\'s own world coordinates', () => {
    const s = createFlatRasterSource(meta, ramp)
    expect(s.sampleAt(105, 195)).toBeCloseTo(0)
    expect(s.sampleAt(125, 185)).toBeCloseTo(6)
    expect(s.sampleAt(0, 0)).toBeNull()
  })

  it('reads a pixel window', () => {
    const s = createFlatRasterSource(meta, ramp)
    const w = s.readWindow({ col: 1, row: 1, width: 2, height: 2 })
    expect(w.width).toBe(2)
    expect(w.height).toBe(2)
    expect([...w.data]).toEqual([5, 6, 9, 10])
  })

  it('clamps a window to the raster instead of reading past the end', () => {
    const s = createFlatRasterSource(meta, ramp)
    const w = s.readWindow({ col: 3, row: 2, width: 10, height: 10 })
    expect(w.width).toBe(1)
    expect(w.height).toBe(1)
    expect([...w.data]).toEqual([11])
  })

  it('returns an empty window when fully outside', () => {
    const s = createFlatRasterSource(meta, ramp)
    const w = s.readWindow({ col: 99, row: 99, width: 4, height: 4 })
    expect(w.width).toBe(0)
    expect(w.data.length).toBe(0)
  })

  it('defaults readWindow to the whole raster', () => {
    const s = createFlatRasterSource(meta, ramp)
    const w = s.readWindow()
    expect(w.width).toBe(4)
    expect(w.height).toBe(3)
    expect([...w.data]).toEqual([...ramp])
  })

  it('carries the preview and rgba through', () => {
    const rgba = new Uint8Array(4 * 3 * 4)
    const s = createFlatRasterSource({ ...meta, kind: 'ortho' }, null, {
      rgba, previewDataUrl: 'data:image/png;base64,xxx',
    })
    expect(s.previewDataUrl()).toBe('data:image/png;base64,xxx')
    expect(s.rgba()).toBe(rgba)
    // An ortho has no scalar plane — sampleAt must say so rather than throw.
    expect(s.sampleAt(105, 195)).toBeNull()
  })

  it('exposes geometry helpers so callers never reach for rasterSample directly', () => {
    const s = createFlatRasterSource(meta, ramp)
    expect(s.worldToPixel(145, 175)).toEqual({ col: 4.5, row: 2.5 })
    expect(s.pixelToWorld(0.5, 0.5)).toEqual({ x: 105, y: 195 })
    expect(s.bounds()).toEqual([100, 170, 140, 200])
  })
})
