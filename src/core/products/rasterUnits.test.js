import { describe, expect, it } from 'vitest'
import { rasterGroundScale, rasterUnits, unitName, volumeUnitLabel } from './rasterUnits.js'
import { productDescriptor } from '../io/rasterSource.js'

describe('rasterUnits', () => {
  it('prefers the record unit, then the CRS linear unit, then model units', () => {
    expect(rasterUnits({ unit: 'model', crs: 'local' })).toEqual({ horizontal: 'model units', vertical: 'model units' })
    expect(rasterUnits({ unit: 'm', crs: 'EPSG:32633' }).horizontal).toBe('m')
    // An imported raster records only its CRS: a projected metric CRS is metres.
    expect(rasterUnits({ crs: 'EPSG:32633' })).toEqual({ horizontal: 'm', vertical: 'm' })
    expect(rasterUnits({})).toEqual({ horizontal: 'model units', vertical: 'model units' })
    expect(rasterUnits({ unit: 'm', verticalUnit: 'ft' })).toEqual({ horizontal: 'm', vertical: 'ft' })
  })

  it('labels volumes', () => {
    expect(volumeUnitLabel({ horizontal: 'm', vertical: 'm' })).toBe('m³')
    expect(volumeUnitLabel({ horizontal: 'm', vertical: 'ft' })).toBe('m²·ft')
    expect(unitName('model')).toBe('model units')
    expect(unitName(null)).toBeNull()
  })
})

describe('rasterGroundScale', () => {
  const dem = { width: 100, height: 100, gsd: 10, originX: 500000, originY: 5000000 }

  it('is 1 for a local frame and null for a geographic CRS', async () => {
    expect(await rasterGroundScale(productDescriptor(dem), 'local')).toBe(1)
    expect(await rasterGroundScale(productDescriptor(dem), null)).toBe(1)
    expect(
      await rasterGroundScale(productDescriptor({ ...dem, originX: 10, originY: 50, gsd: 0.01 }), 'EPSG:4326'),
    ).toBeNull()
  })

  it('is the UTM scale factor near the central meridian', async () => {
    const k = await rasterGroundScale(productDescriptor(dem), 'EPSG:32633')
    expect(k).toBeGreaterThan(0.9995)
    expect(k).toBeLessThan(0.9997)
  })
})
