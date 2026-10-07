import { describe, it, expect } from 'vitest'
import { cloudUnits, toCoordLength, fromCoordLength, formatMeasure } from './cloudUnits.js'

describe('cloudUnits', () => {
  it('labels a computed cloud in metres only when the project frame supplies them', () => {
    expect(cloudUnits({}, { source: 'georef', scale: 2.5 })).toEqual({ scale: 2.5, unit: 'm', label: 'm' })
    expect(cloudUnits({}, { source: 'scalebars', scale: 0.1 }).unit).toBe('m')
    expect(cloudUnits({}, { source: null, scale: 1 })).toEqual({ scale: 1, unit: 'model', label: 'model units' })
  })

  it('never applies a project scale to an imported cloud', () => {
    expect(cloudUnits({ imported: true }, { source: 'georef', scale: 2.5 })).toEqual({ scale: 1, unit: 'source', label: 'file units' })
  })

  it('converts lengths both ways and formats with a unit, never bare', () => {
    const u = cloudUnits({}, { source: 'georef', scale: 2 })
    expect(toCoordLength(4, u)).toBe(2)
    expect(fromCoordLength(2, u)).toBe(4)
    expect(formatMeasure(3, u, 2)).toBe('12 m²')
    // Locale-formatted (the app follows the user's locale): 1.5 or 1,5.
    expect(formatMeasure(1.5, cloudUnits({}, null), 1)).toMatch(/^1[.,]5 model units$/)
    expect(formatMeasure(2, cloudUnits({ imported: true }, null), 3)).toBe('2 file units³')
    expect(formatMeasure(NaN, u)).toBe('—')
  })
})
