import { describe, it, expect } from 'vitest'
import { clipRasterEffects } from './clipRaster.js'

describe('clipRasterEffects', () => {
  it('words the polygon source and the output', () => {
    expect(clipRasterEffects({}, { measurement: 'Field', polygons: 1 }).polygon).toBe(
      'The area of measurement "Field".',
    )
    expect(clipRasterEffects({}, { mode: 'file' }).polygon).toMatch(/^Choose a GeoJSON file/)
    expect(clipRasterEffects({ compression: 'none' }, { product: 'ortho' }).save).toMatch(/transparent, uncompressed/)
  })
})
