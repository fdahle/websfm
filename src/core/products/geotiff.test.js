import { describe, it, expect } from 'vitest'
import { fromArrayBuffer } from 'geotiff'
import { writeGeoTiff, writeCog, geoKeysForEpsg } from './geotiff.js'

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

  it('writes the Compression tag (1 default, 8 when compressed) with the strip as-is', () => {
    const base = {
      width: 1, height: 1,
      samples: [{ bits: 32, format: 3 }],
      photometric: 1, extraSamples: null,
      pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 0, 0],
      geoKeys: geoKeysForEpsg(null, false),
    }
    const uncompressed = parseTiff(writeGeoTiff({ ...base, data: new Uint8Array(4) }))
    expect(uncompressed.tags.get(259)).toEqual([1]) // no compression

    // Compressed path: caller passes pre-deflated bytes + tag 8; the writer stores
    // them verbatim and records StripByteCounts = their length.
    const fakeCompressed = new Uint8Array([9, 9, 9])
    const t = parseTiff(writeGeoTiff({ ...base, data: fakeCompressed, compression: 8 }))
    expect(t.tags.get(259)).toEqual([8])            // Adobe DEFLATE
    expect(t.tags.get(279)).toEqual([3])            // StripByteCounts = compressed length
    const off = t.tags.get(273)[0]
    expect([t.dv.getUint8(off), t.dv.getUint8(off + 1), t.dv.getUint8(off + 2)]).toEqual([9, 9, 9])
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

// Round-trip through the real `geotiff` reader — the same library the app reads
// imported rasters with, so "readable back" means readable by the actual consumer.
const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)

// geotiff 3.x IFDs are lazy — `fd.TileOffsets` is ALWAYS undefined (see the
// readTiffTag note in src/utils/tiff.js). Tags must be loaded, not read.
const tag = (img, name) => {
  const fd = img.getFileDirectory()
  return typeof fd.loadValue === 'function' ? fd.loadValue(name) : fd[name]
}

function ramp(w, h, spp, Ctor = Float32Array) {
  const a = new Ctor(w * h * spp)
  for (let i = 0; i < w * h; i++) for (let s = 0; s < spp; s++) a[i * spp + s] = i + s * 1000
  return a
}

const cogBase = {
  samples: [{ bits: 32, format: 3 }],
  photometric: 1, extraSamples: null,
  pixelScale: [10, 10, 0], tiepoint: [0, 0, 0, 100, 200, 0],
  geoKeys: geoKeysForEpsg(3031, false),
}

describe('writeCog', () => {
  it('round-trips a tiled full-resolution image pixel-for-pixel', async () => {
    const w = 40, h = 24
    const data = ramp(w, h, 1)
    const bytes = writeCog({ ...cogBase, width: w, height: h, data, tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const img = await tiff.getImage(0)
    expect(img.getWidth()).toBe(w)
    expect(img.getHeight()).toBe(h)
    expect(img.getTileWidth()).toBe(16)
    expect(img.getTileHeight()).toBe(16)
    const [band] = await img.readRasters()
    expect(Array.from(band)).toEqual(Array.from(data))
  })

  it('carries the geotransform and CRS on the full-resolution IFD', async () => {
    const bytes = writeCog({ ...cogBase, width: 40, height: 24, data: ramp(40, 24, 1), tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const img = await tiff.getImage(0)
    expect(img.getOrigin().slice(0, 2)).toEqual([100, 200])
    expect(img.getResolution().slice(0, 2)).toEqual([10, -10])
    expect(img.getGeoKeys().ProjectedCSTypeGeoKey).toBe(3031)
  })

  it('builds overviews down to a single tile, each a reduced-resolution IFD', async () => {
    // 40×24 @ tile 16 → 20×12 → 10×6: three levels, the last inside one tile.
    const bytes = writeCog({ ...cogBase, width: 40, height: 24, data: ramp(40, 24, 1), tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    expect(await tiff.getImageCount()).toBe(3)
    const dims = []
    for (let i = 0; i < 3; i++) {
      const img = await tiff.getImage(i)
      dims.push([img.getWidth(), img.getHeight()])
      // NewSubfileType: 0 for full res, 1 (reduced resolution) for the overviews.
      expect(await tag(img, 'NewSubfileType')).toBe(i === 0 ? 0 : 1)
    }
    expect(dims).toEqual([[40, 24], [20, 12], [10, 6]])
  })

  it('lets the reader pick a reduced IFD for a downscaled read', async () => {
    const bytes = writeCog({ ...cogBase, width: 40, height: 24, data: ramp(40, 24, 1), tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    // The overview-selection assertion: a downscaled read must be served from a
    // reduced IFD, not by decoding the full-resolution one. (Which overview the
    // reader picks is its own heuristic — it happens to take 20×12 and resample;
    // what matters is that it did not touch level 0.)
    const rasters = await tiff.readRasters({ width: 10, height: 6 })
    expect(rasters.width).toBe(10)
    const [full] = await (await tiff.getImage(0)).readRasters()
    const [level1] = await (await tiff.getImage(1)).readRasters()
    // Overview cells are 2×2 means of the ramp (x.5); full-res cells are integers.
    expect(rasters[0][0]).toBe(level1[0])
    expect(rasters[0][0]).not.toBe(full[0])
    expect(Number.isInteger(rasters[0][0])).toBe(false)
  })

  it('averages when downsampling and skips nodata cells', async () => {
    // 2×2 block of 1,3 / 5,NODATA → mean of the three valid values.
    const NODATA = -9999
    const w = 32, h = 32
    const data = new Float32Array(w * h).fill(1)
    data[0] = 1; data[1] = 3; data[w] = 5; data[w + 1] = NODATA
    const bytes = writeCog({
      ...cogBase, width: w, height: h, data, tileSize: 16, gdalNoData: NODATA,
    })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const [ov] = await (await tiff.getImage(1)).readRasters()
    expect(ov[0]).toBeCloseTo((1 + 3 + 5) / 3, 5)
  })

  it('keeps a cell nodata when its whole source block is nodata', async () => {
    const NODATA = -9999
    const w = 32, h = 32
    const data = new Float32Array(w * h).fill(1)
    data[0] = NODATA; data[1] = NODATA; data[w] = NODATA; data[w + 1] = NODATA
    const bytes = writeCog({
      ...cogBase, width: w, height: h, data, tileSize: 16, gdalNoData: NODATA,
    })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const [ov] = await (await tiff.getImage(1)).readRasters()
    expect(ov[0]).toBe(NODATA)
    expect((await tiff.getImage(0)).getGDALNoData()).toBe(NODATA)
  })

  it('handles dimensions that are not a multiple of the tile size', async () => {
    const w = 37, h = 19            // partial edge tiles in both axes
    const data = ramp(w, h, 1)
    const bytes = writeCog({ ...cogBase, width: w, height: h, data, tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const img = await tiff.getImage(0)
    const [band] = await img.readRasters()
    expect(band.length).toBe(w * h)
    expect(Array.from(band)).toEqual(Array.from(data))
  })

  it('writes an image that fits one tile as a single-IFD, inline-offset file', async () => {
    // count===1 makes TileOffsets/TileByteCounts inline fields; getting that
    // wrong makes the reader treat the offset as a pointer to the offset.
    const data = ramp(8, 8, 1)
    const bytes = writeCog({ ...cogBase, width: 8, height: 8, data, tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    expect(await tiff.getImageCount()).toBe(1)
    const [band] = await (await tiff.getImage(0)).readRasters()
    expect(Array.from(band)).toEqual(Array.from(data))
  })

  it.each([
    ['int16', Int16Array, 16, 2],
    ['uint16', Uint16Array, 16, 1],
    ['float32', Float32Array, 32, 3],
  ])('round-trips %s samples', async (_name, Ctor, bits, format) => {
    const w = 40, h = 24
    const data = ramp(w, h, 1, Ctor)
    const bytes = writeCog({
      ...cogBase, samples: [{ bits, format }], width: w, height: h, data, tileSize: 16,
    })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const [band] = await (await tiff.getImage(0)).readRasters()
    expect(band).toBeInstanceOf(Ctor)
    expect(Array.from(band)).toEqual(Array.from(data))
  })

  it('round-trips a multi-band scene interleaved by pixel', async () => {
    const w = 40, h = 24, spp = 6                       // the benchmark shape
    const data = ramp(w, h, spp, Int16Array)
    const bytes = writeCog({
      ...cogBase,
      samples: Array.from({ length: spp }, () => ({ bits: 16, format: 2 })),
      width: w, height: h, data, tileSize: 16,
    })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const img = await tiff.getImage(0)
    expect(img.getSamplesPerPixel()).toBe(spp)
    const bands = await img.readRasters()          // de-interleaved, one array per band
    expect(bands.length).toBe(spp)
    for (let s = 0; s < spp; s++) {
      expect(bands[s][0]).toBe(data[s])
      expect(bands[s][w * h - 1]).toBe(data[(w * h - 1) * spp + s])
    }
  })

  it('lays IFDs before image data with tile offsets ascending (the COG rule)', async () => {
    const bytes = writeCog({ ...cogBase, width: 40, height: 24, data: ramp(40, 24, 1), tileSize: 16 })
    const tiff = await fromArrayBuffer(toBuf(bytes))
    const count = await tiff.getImageCount()
    const perLevel = []
    for (let i = 0; i < count; i++) {
      const offs = Array.from(await tag(await tiff.getImage(i), 'TileOffsets'))
      // Offsets ascend within a level.
      expect(offs).toEqual([...offs].sort((a, b) => a - b))
      perLevel.push(offs)
    }
    // Overview data precedes full-resolution data.
    expect(Math.min(...perLevel[0])).toBeGreaterThan(Math.max(...perLevel.slice(1).flat()))

    // Every IFD (and its external tag values) sits before the first tile byte.
    // Walk the IFD chain by hand — the layout is the thing under test.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let ifdEnd = 0
    let next = dv.getUint32(4, true)
    const chain = []
    while (next) {
      chain.push(next)
      const n = dv.getUint16(next, true)
      // External value blocks are laid out immediately after their own IFD, so
      // the largest referenced value offset bounds this IFD's footprint.
      let end = next + 2 + 12 * n + 4
      for (let i = 0; i < n; i++) {
        const p = next + 2 + i * 12
        const type = dv.getUint16(p + 2, true)
        const cnt = dv.getUint32(p + 4, true)
        const size = { 2: 1, 3: 2, 4: 4, 12: 8 }[type] * cnt
        if (size > 4) end = Math.max(end, dv.getUint32(p + 8, true) + size)
      }
      ifdEnd = Math.max(ifdEnd, end)
      next = dv.getUint32(next + 2 + 12 * n, true)
    }
    expect(chain.length).toBe(count)
    expect(ifdEnd).toBeLessThanOrEqual(Math.min(...perLevel.flat()))
  })

  it('rejects specs it cannot honour', () => {
    const ok = { ...cogBase, width: 4, height: 4, data: new Float32Array(16) }
    expect(() => writeCog({ ...ok, tileSize: 100 })).toThrow(/multiple of 16/)
    expect(() => writeCog({ ...ok, data: new Float32Array(15) })).toThrow(/data length/)
    expect(() => writeCog({ ...ok, data: [1, 2, 3] })).toThrow(/TypedArray/)
    expect(() => writeCog({
      ...ok, samples: [{ bits: 8, format: 1 }, { bits: 16, format: 1 }],
      data: new Float32Array(32),
    })).toThrow(/share bits and format/)
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
