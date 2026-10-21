import { describe, expect, it } from 'vitest'
import { GIBS_CAPABILITIES, ORT_RUNTIME, TILE_CACHE_MAX_ZOOM, tileCacheFor } from './offlineCache.js'
import { SATELLITE, TERRAIN } from './basemaps.js'

const esri = (z, x, y) => SATELLITE.url.replace('{z}', z).replace('{y}', y).replace('{x}', x)

describe('tileCacheFor', () => {
  it('caches each built-in source up to the zoom limit', () => {
    expect(tileCacheFor('https://tile.openstreetmap.org/0/0/0.png')?.name).toBe('websfm-tiles-osm')
    expect(tileCacheFor(`https://tile.openstreetmap.org/${TILE_CACHE_MAX_ZOOM}/2100/1350.png`)?.name).toBe(
      'websfm-tiles-osm',
    )
    expect(tileCacheFor(esri(9, 270, 170))?.name).toBe('websfm-tiles-satellite')
    expect(tileCacheFor(TERRAIN.url(12, 2100, 1350))?.name).toBe('websfm-tiles-terrain')
  })

  it('skips levels above the limit', () => {
    expect(tileCacheFor(`https://tile.openstreetmap.org/${TILE_CACHE_MAX_ZOOM + 1}/4200/2700.png`)).toBeNull()
    expect(tileCacheFor('https://tile.openstreetmap.org/18/134000/86000.png')).toBeNull()
    expect(tileCacheFor(esri(19, 1, 1))).toBeNull()
    expect(tileCacheFor(TERRAIN.url(13, 1, 1))).toBeNull()
  })

  it('caches NASA GIBS polar tiles in both request encodings', () => {
    const kvp =
      'https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/wmts.cgi?layer=SCAR_Land_Water_Map' +
      '&style=default&tilematrixset=250m&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fpng' +
      '&TileMatrix=2&TileCol=1&TileRow=3'
    const rest =
      'https://gibs.earthdata.nasa.gov/wmts/epsg3413/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/3/2/1.jpeg'
    expect(tileCacheFor(kvp)?.name).toBe('websfm-tiles-polar')
    expect(tileCacheFor(rest)?.name).toBe('websfm-tiles-polar')
  })

  it('keeps capabilities documents, unrelated hosts and look-alike paths out of the tile caches', () => {
    const caps = 'https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities'
    expect(tileCacheFor(caps)).toBeNull()
    expect(GIBS_CAPABILITIES.pattern.test(caps)).toBe(true)
    expect(tileCacheFor('https://example.com/tile.openstreetmap.org/3/1/1.png')).toBeNull()
    expect(tileCacheFor('https://epsg.io/28992.proj4')).toBeNull()
  })
})

describe('ORT_RUNTIME', () => {
  it('matches the versioned runtime files and the hashed bundle copy', () => {
    expect(ORT_RUNTIME.pattern.test('https://example.org/ort/1.27.0/ort-wasm-simd-threaded.jsep.wasm')).toBe(true)
    expect(ORT_RUNTIME.pattern.test('https://example.org/ort/1.27.0/ort-wasm-simd-threaded.mjs')).toBe(true)
    expect(ORT_RUNTIME.pattern.test('https://example.org/assets/ort-wasm-simd-threaded.asyncify-CvvOzbbq.wasm')).toBe(
      true,
    )
    expect(ORT_RUNTIME.pattern.test('https://example.org/assets/sqlite3-BVKGSWc-.wasm')).toBe(false)
  })
})
