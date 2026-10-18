import { describe, it, expect, vi } from 'vitest'
import { writeArrayBuffer } from 'geotiff'

// The preview encode needs OffscreenCanvas (a browser API); the parse under test
// does not depend on it.
vi.mock('../workers/rasterPreview.js', () => ({
  rasterToDataUrl: async () => 'data:image/png;base64,',
  rasterToPng: async () => new Blob([]),
}))
// A tiny buffer wall, so a small test raster stands in for a 2 GiB one.
vi.mock('../core/bufferLimit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  MAX_BUFFER_BYTES: 4 * 40 * 40,
}))

const { makeIoOps, sampleBytes } = await import('../workers/ops/io.js')

// A north-up single-band GeoTIFF DEM, 1-unit cells at (1000, 2000).
function demTiff(values, width, height, { bits = 32, nodata = null } = {}) {
  const Arr = bits === 64 ? Float64Array : Float32Array
  return writeArrayBuffer(Arr.from(values), {
    width, height, SamplesPerPixel: 1, BitsPerSample: [bits], SampleFormat: [3],
    PhotometricInterpretation: 1, PlanarConfiguration: 1,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 1000, 2000, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633,
    ...(nodata != null ? { GDAL_NODATA: `${nodata}\0` } : {}),
  })
}

const parse = (buffer, extra = {}) => makeIoOps().parseRaster(
  [{ buffer, name: 'test.tif', forceKind: 'dem', ...extra }], { emit: () => {} })

describe('parseRaster nodata', () => {
  for (const nodata of [-3.4e38, -9999.9]) {
    it(`folds a Float32 band's ${nodata} nodata to NaN`, async () => {
      const values = Array.from({ length: 16 }, (_, i) => (i < 4 ? nodata : 100 + i))
      const { result } = await parse(demTiff(values, 4, 4, { nodata }))
      const plane = result.plane
      expect(Number.isNaN(plane[0]) && Number.isNaN(plane[3])).toBe(true)
      expect(plane[4]).toBe(104)
      expect(result.meta.zMin).toBe(104)
      expect(result.meta.zMax).toBe(115)
    })
  }
})

describe('parseRaster buffer wall', () => {
  it('counts a Float64 band at 8 bytes a cell', async () => {
    expect(sampleBytes(64)).toBe(8)
    expect(sampleBytes(32)).toBe(4)
    expect(sampleBytes(12)).toBe(2)
    expect(sampleBytes(1)).toBe(1)
    // 30 × 30 cells: a 3.6 kB Float32 plane fits the 6.4 kB wall, the 7.2 kB Float64
    // band read does not.
    const values = Array.from({ length: 900 }, (_, i) => i)
    await expect(parse(demTiff(values, 30, 30, { bits: 32 }))).resolves.toBeTruthy()
    await expect(parse(demTiff(values, 30, 30, { bits: 64 }))).rejects.toThrow(/caps one buffer at 2 GiB/)
  })
})
