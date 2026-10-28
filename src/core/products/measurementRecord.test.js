import { it, expect } from 'vitest'
import { isReferenceRaster, measurementSource, measurementStamp, measurementStale } from './measurementRecord.js'
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
  expect(measurementSource('dem', computed)).toBe('product:dem')
  expect(measurementStale(saved, { ...p, style: { gamma: 2 } })).toBe(false)
  for (const patch of [{ importedAt: 2 }, { crs: 'EPSG:3857' }, { vOffset: 3 }, { frameStamp: { revision: 2 } }])
    expect(measurementStale(saved, { ...p, ...patch })).toBe(true)
  expect(measurementStale(saved, p, { stale: true })).toBe(true)
  expect(measurementStale(saved, null)).toBe(true)
})
