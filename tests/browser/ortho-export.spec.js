import { test, expect } from '@playwright/test'

// Export Orthophoto's empty pixels through the real export worker: the alpha band by
// default, or three bands with a NODATA value (core/products/orthoBands.js).

test('an ortho GeoTIFF keeps its alpha band, or writes RGB with a NODATA value', async ({ page }) => {
  await page.goto('/tests/browser/harness.html')
  const result = await page.evaluate(async () => {
    const { writeCog, geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const { exportOrthoFile } = await import('/src/workers/computeClient.js')
    const { openRaster, readWindowBytes } = await import('/src/workers/cogRead.js')
    // 4×1: covered red, covered black (equals NODATA 0), empty, covered white.
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 7, 7, 7, 0, 255, 255, 255, 255])
    const cog = writeCog({
      width: 4,
      height: 1,
      samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
      photometric: 2,
      extraSamples: [2],
      data,
      pixelScale: [1, 1, 0],
      tiepoint: [0, 0, 0, 500000, 6000000, 0],
      geoKeys: geoKeysForEpsg(32632, false),
    })
    const file = new Blob([cog], { type: 'image/tiff' })
    const read = async (opts) => {
      const { blob } = await exportOrthoFile({ file, format: 'geotiff', crs: { code: 32632 }, ...opts })
      const image = await openRaster(blob)
      return {
        bands: image.getSamplesPerPixel(),
        nodata: image.getGDALNoData(),
        bytes: [...(await readWindowBytes(image, 0, 0, 4, 1))],
      }
    }
    return { rgba: await read({}), rgb: await read({ alpha: false, nodata: 0 }) }
  })
  expect(result.rgba.bands).toBe(4)
  expect(result.rgba.nodata).toBeNull()
  expect(result.rgb.bands).toBe(3)
  expect(result.rgb.nodata).toBe(0)
  expect(result.rgb.bytes).toEqual([255, 1, 1, 1, 1, 1, 0, 0, 0, 255, 255, 255])
})
