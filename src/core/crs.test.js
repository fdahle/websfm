import { beforeAll, describe, it, expect } from 'vitest'
import proj4 from 'proj4'
import { ensureProjection, transform, isGeographic, axisLabels, localMetricFrame,
  metresPerCrsUnit, metresToCrsUnits } from './crs.js'

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

describe('projected CRS linear units', () => {
  it('reports metre CRSs and leaves metre distances unchanged', () => {
    expect(metresPerCrsUnit('EPSG:32632')).toBe(1)
    expect(metresToCrsUnits(10, 'EPSG:32632')).toBe(10)
  })

  it('converts metres into non-metre projected units', () => {
    proj4.defs('TEST:USFT', '+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=us-ft +no_defs')
    expect(metresPerCrsUnit('TEST:USFT')).toBeCloseTo(0.3048006096, 10)
    expect(metresToCrsUnits(1, 'TEST:USFT')).toBeCloseTo(3.2808333333, 8)
  })

  it('does not invent a linear scale for longitude/latitude', () => {
    expect(metresPerCrsUnit('EPSG:4326')).toBeNull()
    expect(metresToCrsUnits(10, 'EPSG:4326')).toBe(10)
  })
})

describe('localMetricFrame (used for footprints in a geographic CRS)', () => {
  // Central Iran — the geographic test-dataset case.
  const lon0 = 53.5, lat0 = 32.5

  it('is metric: 1 unit ≈ 1 metre near the centre', () => {
    const code = localMetricFrame(lon0, lat0)
    // The centre maps to the origin, and a point one arc-second north is ~30.9 m.
    const centre = transform([lon0, lat0], 'EPSG:4326', code)
    expect(centre[0]).toBeCloseTo(0, 3)
    expect(centre[1]).toBeCloseTo(0, 3)
    const north = transform([lon0, lat0 + 1 / 3600], 'EPSG:4326', code)
    expect(north[1]).toBeGreaterThan(29)
    expect(north[1]).toBeLessThan(32)
  })

  it('round-trips lon/lat → local metres → lon/lat', () => {
    const code = localMetricFrame(lon0, lat0)
    const pt = [lon0 + 0.02, lat0 - 0.01]
    const back = transform(transform(pt, 'EPSG:4326', code), code, 'EPSG:4326')
    expect(back[0]).toBeCloseTo(pt[0], 7)
    expect(back[1]).toBeCloseTo(pt[1], 7)
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

  it('classifies registered geographic CRSs outside the curated catalog', () => {
    proj4.defs('EPSG:999001', '+proj=longlat +datum=WGS84 +no_defs')
    expect(isGeographic('EPSG:999001')).toBe(true)
  })

  it('labels axes per CRS', () => {
    expect(axisLabels('EPSG:4326')).toEqual(['Lon', 'Lat', 'Alt'])
    expect(axisLabels('EPSG:3031')).toEqual(['Easting', 'Northing', 'Up'])
  })
})
