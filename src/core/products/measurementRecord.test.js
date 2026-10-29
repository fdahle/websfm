import { it, expect } from 'vitest'
import {
  isReferenceRaster,
  measuredOn,
  measurementSource,
  measurementStamp,
  measurementStale,
  productOfSource,
} from './measurementRecord.js'
it('invalidates saved measurements for source and frame changes, not display styling', () => {
  const p = {
    id: 'r',
    importedAt: 1,
    width: 50,
    height: 20,
    crs: 'EPSG:3031',
    geoTransform: { originX: 1, originY: 2, scaleX: 3, scaleY: -3 },
  }
  const saved = { stamp: measurementStamp(p) }
  expect(measurementSource('ortho', p)).toBe('reference:r')
  // A computed DEM has an id too (several per project), but no geoTransform.
  const computed = { id: 'dem-1', kind: 'dem', originX: 1, originY: 2, gsd: 3 }
  expect(isReferenceRaster(computed)).toBe(false)
  expect(measurementSource('dem', computed)).toBe('product:dem-1')
  expect(measurementStale(saved, { ...p, style: { gamma: 2 } })).toBe(false)
  for (const patch of [{ importedAt: 2 }, { crs: 'EPSG:3857' }, { vOffset: 3 }, { frameStamp: { revision: 2 } }])
    expect(measurementStale(saved, { ...p, ...patch })).toBe(true)
  expect(measurementStale(saved, p, { stale: true })).toBe(true)
  expect(measurementStale(saved, null)).toBe(true)
})

it('finds a measurement on its own product, and one saved by kind on the main one', () => {
  const dem1 = { id: 'dem-1', kind: 'dem', originX: 0, originY: 0, gsd: 1 }
  const dem2 = { ...dem1, id: 'dem-2' }
  const own = { source: 'product:dem-2' }
  const legacy = { source: 'product:dem' }
  expect(measuredOn(own, 'dem', dem2)).toBe(true)
  expect(measuredOn(own, 'dem', dem1, true)).toBe(false)
  expect(measuredOn(legacy, 'dem', dem1, true)).toBe(true)
  expect(measuredOn(legacy, 'dem', dem2, false)).toBe(false)
  const lookup = { productById: (id) => [dem1, dem2].find((p) => p.id === id) ?? null, mainOf: () => dem1 }
  expect(productOfSource('product:dem-2', lookup)).toBe(dem2)
  expect(productOfSource('product:dem', lookup)).toBe(dem1)
  expect(productOfSource('reference:r', lookup)).toBeNull()
})
