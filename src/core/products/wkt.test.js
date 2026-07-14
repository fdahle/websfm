import { describe, it, expect } from 'vitest'
import { epsgToWkt } from './wkt.js'

describe('epsgToWkt', () => {
  it('emits WGS84 geographic WKT for 4326', () => {
    const wkt = epsgToWkt(4326)
    expect(wkt).toMatch(/^GEOGCS\["WGS 84"/)
    expect(wkt).toContain('AUTHORITY["EPSG","4326"]')
    expect(wkt).toContain('SPHEROID["WGS 84",6378137,298.257223563')
  })

  it('builds a correct UTM north zone (32633 → zone 33N, CM 15)', () => {
    const wkt = epsgToWkt(32633)
    expect(wkt).toMatch(/^PROJCS\["WGS 84 \/ UTM zone 33N"/)
    expect(wkt).toContain('PARAMETER["central_meridian",15]')
    expect(wkt).toContain('PARAMETER["false_northing",0]')
    expect(wkt).toContain('PARAMETER["scale_factor",0.9996]')
    expect(wkt).toContain('AUTHORITY["EPSG","32633"]')
  })

  it('builds a UTM south zone with the 10,000,000 false northing (32701 → 1S, CM −177)', () => {
    const wkt = epsgToWkt(32701)
    expect(wkt).toContain('UTM zone 1S')
    expect(wkt).toContain('PARAMETER["central_meridian",-177]')
    expect(wkt).toContain('PARAMETER["false_northing",10000000]')
  })

  it('returns null for codes we cannot build (caller falls back to proj4)', () => {
    expect(epsgToWkt(3031)).toBeNull()   // Antarctic polar stereographic
    expect(epsgToWkt(25832)).toBeNull()  // ETRS89 UTM
    expect(epsgToWkt(null)).toBeNull()
  })
})
