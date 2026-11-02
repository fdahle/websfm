import { describe, it, expect } from 'vitest'
import {
  copDemSearchBody,
  copDemTiles,
  signedHref,
  paddedBox,
  tileWindow,
  mosaicGrid,
  mosaicDem,
  copDemAttribution,
} from './copernicusDem.js'

const ARCSEC = 1 / 3600

describe('the catalogue', () => {
  it('asks for the tiles over a box and reads their file URLs once each', () => {
    expect(copDemSearchBody([11, 47, 12, 48])).toEqual({
      collections: ['cop-dem-glo-30'],
      bbox: [11, 47, 12, 48],
      limit: 100,
    })
    const fc = {
      features: [
        { id: 'a', assets: { data: { href: 'https://x/a.tif' } } },
        { id: 'a2', assets: { data: { href: 'https://x/a.tif' } } },
        { id: 'b', assets: {} },
      ],
    }
    expect(copDemTiles(fc)).toEqual([{ id: 'a', href: 'https://x/a.tif' }])
    expect(signedHref('https://x/a.tif', 'st=1&sig=2')).toBe('https://x/a.tif?st=1&sig=2')
    expect(signedHref('https://x/a.tif?v=1', 'st=1')).toBe('https://x/a.tif?v=1&st=1')
    expect(copDemAttribution()).toMatch(/Copernicus DEM GLO-30/)
  })

  it('pads the box by a share of its larger side, at least a minimum', () => {
    expect(
      paddedBox([
        [11, 47],
        [12, 47.5],
      ]),
    ).toEqual([10.9, 46.9, 12.1, 47.6])
    expect(paddedBox([[11, 47]])).toEqual([10.99, 46.99, 11.01, 47.01])
    expect(paddedBox([[NaN, 1]])).toBeNull()
  })
})

describe('joining tiles', () => {
  const tile = (west, north, widthPx) => ({ west, north, dx: 1 / widthPx, dy: ARCSEC, width: widthPx, height: 3600 })

  it('finds the window of a tile over a box', () => {
    const t = tile(11, 48, 3600)
    expect(tileWindow(t, [11.5, 47.5, 11.75, 47.75])).toEqual({ x0: 1800, y0: 900, x1: 2700, y1: 1800 })
    expect(tileWindow(t, [13, 47, 14, 48])).toBeNull()
  })

  it('takes the finest spacing and refuses an area wider than the limit', () => {
    // Across 50° N, tiles are 3600 columns wide below and 2400 above.
    const g = mosaicGrid([tile(11, 51, 2400), tile(11, 50, 3600)], [11.1, 49.9, 11.2, 50.1])
    expect(g.dx).toBeCloseTo(ARCSEC, 12)
    expect(g.width).toBe(360)
    expect(g.height).toBe(720)
    expect(() => mosaicGrid([tile(11, 48, 3600)], [11, 47, 12, 48], { maxPx: 1000 })).toThrow(/km across/)
    expect(() => mosaicGrid([], [11, 47, 12, 48])).toThrow(/no tile/)
  })

  it('samples each cell from the tile that holds it, NaN off the tiles and on no-data', () => {
    // Two 2 × 2 tiles side by side; the grid is three columns, the last off both.
    const a = { west: 0, north: 2, dx: 1, dy: 1, width: 2, height: 2, data: Float32Array.from([1, 2, 3, -32767]) }
    const b = { west: 2, north: 2, dx: 1, dy: 1, width: 1, height: 2, data: Float32Array.from([5, 6]) }
    const out = mosaicDem([a, b], { west: 0, north: 2, dx: 1, dy: 1, width: 4, height: 2 })
    expect([...out]).toEqual([1, 2, 5, NaN, 3, NaN, 6, NaN])
  })
})
