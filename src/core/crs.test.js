import { beforeAll, describe, it, expect } from 'vitest'
import { ensureProjection, transform, isGeographic, axisLabels } from './crs.js'

// Catalog CRS resolve from their built-in proj4 def — no network or OPFS needed.
// EPSG:3031 is the Antarctic Polar Stereographic case the project relies on.
beforeAll(async () => {
  await ensureProjection('EPSG:4326')
  await ensureProjection('EPSG:3031')
  await ensureProjection('EPSG:32632')
})

describe('transform', () => {
  it('is the identity when from === to (and copies, not aliases)', () => {
    const coord = [123.4, 56.7]
    const out = transform(coord, 'EPSG:4326', 'EPSG:4326')
    expect(out).toEqual(coord)
    expect(out).not.toBe(coord)
  })

  it('passes the Z component through unchanged', () => {
    const [, , z] = transform([0, -75, 1234.5], 'EPSG:4326', 'EPSG:3031')
    expect(z).toBe(1234.5)
  })

  it('round-trips WGS84 → UTM 32N → WGS84', () => {
    const lonlat = [9.0, 48.0] // within UTM zone 32N
    const utm = transform(lonlat, 'EPSG:4326', 'EPSG:32632')
    const back = transform(utm, 'EPSG:32632', 'EPSG:4326')
    expect(back[0]).toBeCloseTo(lonlat[0], 6)
    expect(back[1]).toBeCloseTo(lonlat[1], 6)
  })
})

describe('polar CRS (EPSG:3031, Antarctic Polar Stereographic)', () => {
  it('maps the South Pole to the projection origin', () => {
    const [x, y] = transform([0, -90], 'EPSG:4326', 'EPSG:3031')
    expect(x).toBeCloseTo(0, 3)
    expect(y).toBeCloseTo(0, 3)
  })

  it('round-trips a high-southern-latitude point with sub-millimetre error', () => {
    const lonlat = [137.5, -75.25] // deep in Antarctica
    const polar = transform(lonlat, 'EPSG:4326', 'EPSG:3031')
    // Sanity: a real projected position, far from the origin, in metres.
    expect(Math.hypot(polar[0], polar[1])).toBeGreaterThan(1e5)

    const back = transform(polar, 'EPSG:3031', 'EPSG:4326')
    expect(back[0]).toBeCloseTo(lonlat[0], 6)
    expect(back[1]).toBeCloseTo(lonlat[1], 6)
  })

  it('places longitude 0° on the +Y (north-up) axis from the pole', () => {
    // On a south polar stereographic with lon_0=0, the 0° meridian runs along
    // increasing Y; points just off the pole at lon 0 have x≈0, y>0.
    const [x, y] = transform([0, -80], 'EPSG:4326', 'EPSG:3031')
    expect(x).toBeCloseTo(0, 3)
    expect(y).toBeGreaterThan(0)
  })
})

describe('catalog metadata', () => {
  it('classifies geographic vs projected', () => {
    expect(isGeographic('EPSG:4326')).toBe(true)
    expect(isGeographic('EPSG:3031')).toBe(false)
  })

  it('labels axes per CRS', () => {
    expect(axisLabels('EPSG:4326')).toEqual(['Lon', 'Lat', 'Alt'])
    expect(axisLabels('EPSG:3031')).toEqual(['Easting', 'Northing', 'Up'])
  })
})
