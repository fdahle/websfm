import { describe, it, expect } from 'vitest'
import { writeGeoTiff, geoKeysForEpsg } from './geotiff.js'

// Minimal baseline-TIFF reader (little-endian) — enough to verify the writer.
function parseTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(bytes[0]).toBe(0x49); expect(bytes[1]).toBe(0x49)   // 'II'
  expect(dv.getUint16(2, true)).toBe(42)
  const ifd = dv.getUint32(4, true)
  const n = dv.getUint16(ifd, true)
  const tags = new Map()
  const SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 }
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12
    const tag = dv.getUint16(p, true)
    const type = dv.getUint16(p + 2, true)
    const count = dv.getUint32(p + 4, true)
    const bytesLen = count * SIZE[type]
    const valOff = bytesLen <= 4 ? p + 8 : dv.getUint32(p + 8, true)
    const vals = []
    for (let k = 0; k < count; k++) {
      const o = valOff + k * SIZE[type]
      if (type === 3) vals.push(dv.getUint16(o, true))
      else if (type === 4) vals.push(dv.getUint32(o, true))
      else if (type === 12) vals.push(dv.getFloat64(o, true))
    }
    tags.set(tag, vals)
  }
  return { dv, tags }
}

describe('writeGeoTiff', () => {
  it('writes a georeferenced single-band float DEM readable back', () => {
    const data = new Float32Array([1.5, 2.5, 3.5, 4.5]) // 2×2
    const tif = writeGeoTiff({
      width: 2, height: 2,
      samples: [{ bits: 32, format: 3 }],
      photometric: 1, extraSamples: null,
      data: new Uint8Array(data.buffer),
      pixelScale: [10, 10, 0],
      tiepoint: [0, 0, 0, 100, 200, 0],
      geoKeys: geoKeysForEpsg(3031, false),
      gdalNoData: -9999,
    })
    const { dv, tags } = parseTiff(tif)
    expect(tags.get(256)).toEqual([2])       // width
    expect(tags.get(257)).toEqual([2])       // height
    expect(tags.get(258)).toEqual([32])      // bits per sample
    expect(tags.get(339)).toEqual([3])       // SampleFormat = float
    expect(tags.get(277)).toEqual([1])       // 1 sample
    expect(tags.get(33550)).toEqual([10, 10, 0])          // pixel scale
    expect(tags.get(33922)).toEqual([0, 0, 0, 100, 200, 0]) // tiepoint
    // GeoKeyDirectory: header [1,1,0,3] then the projected-CS key holds 3031.
    const gk = tags.get(34735)
    expect(gk.slice(0, 4)).toEqual([1, 1, 0, 3])
    expect(gk).toContain(3031)
    // Strip data starts at offset 8; first float is the first DEM cell.
    const stripOff = tags.get(273)[0]
    expect(stripOff).toBe(8)
    expect(dv.getFloat32(stripOff, true)).toBeCloseTo(1.5, 5)
  })

  it('writes an RGBA raster with 4 samples + alpha extra-sample', () => {
    const rgba = new Uint8Array([10, 20, 30, 255,  40, 50, 60, 128]) // 2×1
    const tif = writeGeoTiff({
      width: 2, height: 1,
      samples: [1, 2, 3, 4].map(() => ({ bits: 8, format: 1 })),
      photometric: 2, extraSamples: [2],
      data: rgba,
      pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 0, 0],
      geoKeys: geoKeysForEpsg(null, false),
    })
    const { tags } = parseTiff(tif)
    expect(tags.get(277)).toEqual([4])           // samples per pixel
    expect(tags.get(258)).toEqual([8, 8, 8, 8])  // bits per sample
    expect(tags.get(262)).toEqual([2])           // RGB
    expect(tags.get(338)).toEqual([2])           // ExtraSamples = unassociated alpha
    // No EPSG → user-defined model type, still a valid geotransform.
    expect(tags.get(34735).slice(0, 4)).toEqual([1, 1, 0, 2])
  })

  it('emits a GDAL_NODATA tag only when a nodata value is given', () => {
    const base = {
      width: 1, height: 1,
      samples: [{ bits: 32, format: 3 }],
      photometric: 1, extraSamples: null,
      data: new Uint8Array(new Float32Array([0]).buffer),
      pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 0, 0],
      geoKeys: geoKeysForEpsg(3031, false),
    }
    const withNoData = parseTiff(writeGeoTiff({ ...base, gdalNoData: -9999 }))
    expect(withNoData.tags.has(42113)).toBe(true)
    const without = parseTiff(writeGeoTiff(base))
    expect(without.tags.has(42113)).toBe(false)
  })
})

describe('geoKeysForEpsg', () => {
  it('sets a projected model type + ProjectedCSType key', () => {
    expect(geoKeysForEpsg(3031, false)).toEqual([
      [1024, 0, 1, 1], [1025, 0, 1, 1], [3072, 0, 1, 3031],
    ])
  })

  it('sets a geographic model type + GeographicType key', () => {
    expect(geoKeysForEpsg(4326, true)).toEqual([
      [1024, 0, 1, 2], [1025, 0, 1, 1], [2048, 0, 1, 4326],
    ])
  })

  it('falls back to a user-defined model when no code is given', () => {
    expect(geoKeysForEpsg(null, false)).toEqual([[1024, 0, 1, 32767], [1025, 0, 1, 1]])
  })
})
