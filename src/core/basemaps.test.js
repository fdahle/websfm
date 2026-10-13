import { describe, it, expect } from 'vitest'
import { basemapReason, customAttribution, decodeTerrarium, hillshade, tileUrlError } from './basemaps.js'

const UTM = { basemap: 'osm', geographic: false }

describe('basemapReason', () => {
  it('offers every base layer in an ordinary CRS', () => {
    for (const v of ['auto', 'streets', 'satellite', 'terrain', 'none']) expect(basemapReason(v, UTM)).toBe('')
  })

  it('greys the Mercator tile sets out for a polar CRS', () => {
    const polar = { basemap: 'gibs' }
    expect(basemapReason('satellite', polar)).toMatch(/polar/)
    expect(basemapReason('terrain', polar)).toMatch(/polar/)
    expect(basemapReason('auto', polar)).toBe('')
  })

  it('recognises a fetched polar projection by its area of use', () => {
    expect(basemapReason('satellite', { basemap: 'osm', worldExtent: [-180, -90, 180, -60] })).toMatch(/polar/)
    // Svalbard-sized area: high latitude, but inside the tiles.
    expect(basemapReason('satellite', { basemap: 'osm', worldExtent: [10, 74, 35, 81] })).toBe('')
    // A geographic CRS spans pole to pole and still reprojects the tiles.
    expect(basemapReason('satellite', { basemap: 'osm', geographic: true, worldExtent: [-180, -90, 180, 90] })).toBe('')
  })

  it('greys every base layer in the model frame', () => {
    expect(basemapReason('streets', null)).toMatch(/model frame/)
  })
})

describe('terrain hillshade', () => {
  const rgba = (elevations) => {
    const out = new Uint8ClampedArray(elevations.length * 4)
    elevations.forEach((e, i) => {
      const v = e + 32768
      out[i * 4] = Math.floor(v / 256); out[i * 4 + 1] = Math.floor(v) % 256; out[i * 4 + 2] = Math.round((v % 1) * 256)
      out[i * 4 + 3] = 255
    })
    return out
  }

  it('decodes Terrarium elevations', () => {
    expect([...decodeTerrarium(rgba([0, 1234.5, -50]), 3, 1)]).toEqual([0, 1234.5, -50])
  })

  it('shades flat ground evenly and lights a north-west slope more than a south-east one', () => {
    const w = 8, h = 8, z = 14, y = 8000
    const flat = hillshade(new Float32Array(w * h), w, h, z, y)
    expect(new Set([...flat].filter((_, i) => i % 4 === 0)).size).toBe(1)
    // Elevation rising towards the south-east: the slope faces the north-west sun.
    const facingNw = Float32Array.from({ length: w * h }, (_, i) => (i % w + Math.floor(i / w)) * 5)
    const facingSe = facingNw.map((e) => -e)
    expect(hillshade(facingNw, w, h, z, y)[0]).toBeGreaterThan(flat[0])
    expect(hillshade(facingSe, w, h, z, y)[0]).toBeLessThan(flat[0])
  })
})

describe('custom satellite source', () => {
  it('accepts an XYZ template, or empty for the default', () => {
    expect(tileUrlError('')).toBe('')
    expect(tileUrlError('https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=abc')).toBe('')
    expect(tileUrlError('https://example.com/{z}/{x}/{-y}.png')).toBe('')
  })

  it('rejects a URL without a scheme or placeholders', () => {
    expect(tileUrlError('example.com/{z}/{x}/{y}.png')).toMatch(/https/)
    expect(tileUrlError('https://example.com/tiles.png')).toMatch(/placeholders/)
  })

  it('escapes the attribution and falls back to the host', () => {
    expect(customAttribution('https://x.org/{z}/{x}/{y}', '<b>Me</b>')).toBe('&#60;b&#62;Me&#60;/b&#62;')
    expect(customAttribution('https://tiles.example.com/{z}/{x}/{y}.png?key=1', '')).toBe('tiles.example.com')
  })
})
