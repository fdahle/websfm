import { describe, it, expect } from 'vitest'
import { utmZone, suggestProjectedCrs, formatLatLon } from './crsSuggest.js'

describe('utmZone', () => {
  it('follows the 6° grid', () => {
    expect(utmZone(44.57, 5.28)).toBe(31) // St Nazaire-le-Désert, Drôme
    expect(utmZone(0, -180)).toBe(1)
    expect(utmZone(0, 179.9)).toBe(60)
    expect(utmZone(-33.9, 18.4)).toBe(34) // Cape Town
  })

  it('applies the Norway and Svalbard exceptions', () => {
    expect(utmZone(60.4, 5.3)).toBe(32) // Bergen, 31V by the grid
    expect(utmZone(78.2, 15.6)).toBe(33) // Longyearbyen
    expect(utmZone(79.0, 8.0)).toBe(31)
    expect(utmZone(76.0, 40.0)).toBe(37)
  })
})

describe('suggestProjectedCrs', () => {
  it('suggests the UTM zone of the median position', () => {
    const s = suggestProjectedCrs([{ lat: 44.5688, lon: 5.2755 }, { lat: 44.569, lon: 5.276 }])
    expect(s).toMatchObject({ code: 'EPSG:32631', name: 'WGS 84 / UTM zone 31N', count: 2 })
  })

  it('uses the southern UTM series south of the equator', () => {
    expect(suggestProjectedCrs([{ lat: -33.9, lon: 18.4 }]).code).toBe('EPSG:32734')
  })

  it('is not moved by one stray position', () => {
    const pts = [...Array(9)].map(() => ({ lat: 44.57, lon: 5.27 }))
    pts.push({ lat: 0, lon: 0 }) // a GPS glitch
    expect(suggestProjectedCrs(pts).code).toBe('EPSG:32631')
  })

  it('switches to polar stereographic outside the UTM domain', () => {
    expect(suggestProjectedCrs([{ lat: -82.5, lon: 160 }]).code).toBe('EPSG:3031')
    expect(suggestProjectedCrs([{ lat: 85, lon: -40 }]).code).toBe('EPSG:3413')
    expect(suggestProjectedCrs([{ lat: -75, lon: -70 }]).code).toBe('EPSG:32719') // UTM reaches 80°S
  })

  it('returns null without usable positions', () => {
    expect(suggestProjectedCrs([])).toBeNull()
    expect(suggestProjectedCrs(null)).toBeNull()
    expect(suggestProjectedCrs([{ lat: NaN, lon: 3 }, { lat: 120, lon: 3 }])).toBeNull()
  })
})

describe('formatLatLon', () => {
  it('prints hemisphere letters', () => {
    expect(formatLatLon(44.56881, 5.27548)).toBe('44.5688°N 5.2755°E')
    expect(formatLatLon(-77.85, -166.67)).toBe('77.8500°S 166.6700°W')
  })
})
