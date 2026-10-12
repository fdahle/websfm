import { describe, it, expect } from 'vitest'
import { createFlatRasterSource, productDescriptor, createProductRasterSource } from './rasterSource.js'
import { rasterizeDem, cellCenter } from '../products/dem.js'

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

describe('computed products as raster sources', () => {
  const dem = rasterizeDem([{ x: 0, y: 0, z: 1 }, { x: 4, y: 0, z: 2 }, { x: 0, y: 3, z: 3 }, { x: 4, y: 3, z: 4 }],
    { gsd: 1, fillRadius: 0 })

  it('normalises a computed grid to a north-up corner geotransform', () => {
    expect(productDescriptor(dem).geoTransform).toEqual({ originX: dem.originX, originY: dem.originY, scaleX: 1, scaleY: -1 })
    expect(productDescriptor({ width: 2, height: 2, geoTransform: { originX: 5 } }).geoTransform).toEqual({ originX: 5 })
    expect(productDescriptor({ width: 2, height: 2 })).toBeNull()
  })

  it('samples a DEM cell centre to that cell and agrees with dem.js on geometry', () => {
    const src = createProductRasterSource('dem', dem)
    for (let row = 0; row < dem.height; row++) for (let col = 0; col < dem.width; col++) {
      const i = row * dem.width + col
      if (!dem.mask[i]) continue
      const [x, y] = cellCenter(dem, col, row)
      expect(src.sampleAt(x, y)).toBe(dem.data[i])
      expect(src.worldToPixel(x, y)).toEqual({ col: col + 0.5, row: row + 0.5 })
    }
    expect(src.unsafePlane()).toBe(dem.data)
    expect(src.rgba()).toBeNull()
  })

  it('exposes an ortho through rgba with no value plane', () => {
    const rgba = new Uint8ClampedArray(4)
    const src = createProductRasterSource('ortho', { width: 1, height: 1, gsd: 1, originX: 0, originY: 1, rgba })
    expect(src.rgba()).toBe(rgba)
    expect(src.unsafePlane()).toBeNull()
  })
})

describe('cellValueAt (cursor readout)', () => {
  // 3×1 DEM, middle cell nodata. A readout over the hole must say "no data";
  // sampleAt keeps its documented neighbour fallback for GCP Z fill.
  const meta = { width: 3, height: 1, nodata: -9999, geoTransform: { originX: 0, originY: 1, scaleX: 1, scaleY: -1 } }
  const src = createFlatRasterSource(meta, new Float32Array([10, -9999, 30]))

  it('reads the containing cell and never a neighbour', () => {
    expect(src.cellValueAt(1.5, 0.5)).toBeNull()
    expect(src.cellValueAt(1.01, 0.99)).toBeNull()
    expect(src.sampleAt(1.5, 0.5)).not.toBeNull()
    expect(src.cellValueAt(0.2, 0.3)).toBe(10)
    expect(src.cellValueAt(2.9, 0.1)).toBe(30)
  })

  it('reads null off the raster and for a computed DEM hole', () => {
    expect(src.cellValueAt(-0.1, 0.5)).toBeNull()
    expect(src.cellValueAt(3, 0.5)).toBeNull()
    const dem = createProductRasterSource('dem', { width: 2, height: 1, gsd: 1, originX: 0, originY: 1,
      data: new Float32Array([5, NaN]) })
    expect(dem.cellValueAt(1.5, 0.5)).toBeNull()
    expect(dem.cellValueAt(0.5, 0.5)).toBe(5)
  })
})
