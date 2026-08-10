import { describe, it, expect } from 'vitest'
import {
  parseGeoJson,
  looksLikeGeoJson,
  guessNameKey,
  geoJsonToGcps,
  geoJsonToFootprints,
} from './geojson.js'

const pointFeature = (coords, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: coords },
  properties: props,
})

const polyFeature = (rings, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: rings },
  properties: props,
})

describe('parseGeoJson', () => {
  it('classifies a FeatureCollection of points', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [pointFeature([1, 2], { name: 'A' }), pointFeature([3, 4], { name: 'B' })],
    }
    const r = parseGeoJson(JSON.stringify(fc))
    expect(r.kind).toBe('points')
    expect(r.features).toHaveLength(2)
    expect(r.propertyKeys).toEqual(['name'])
  })

  it('classifies polygons', () => {
    const fc = { type: 'FeatureCollection', features: [polyFeature([[[0, 0], [1, 0], [1, 1], [0, 0]]])] }
    expect(parseGeoJson(JSON.stringify(fc)).kind).toBe('polygons')
  })

  it('classifies a mixed collection', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [pointFeature([1, 2]), polyFeature([[[0, 0], [1, 0], [1, 1], [0, 0]]])],
    }
    expect(parseGeoJson(JSON.stringify(fc)).kind).toBe('mixed')
  })

  it('accepts a single bare Feature', () => {
    const r = parseGeoJson(JSON.stringify(pointFeature([1, 2])))
    expect(r.kind).toBe('points')
    expect(r.features).toHaveLength(1)
  })

  it('accepts a bare geometry', () => {
    const r = parseGeoJson(JSON.stringify({ type: 'Point', coordinates: [1, 2] }))
    expect(r.kind).toBe('points')
    expect(r.features).toHaveLength(1)
  })

  it('returns empty on invalid JSON', () => {
    const r = parseGeoJson('not json {')
    expect(r).toMatchObject({ kind: 'empty', features: [], sourceCrs: 'EPSG:4326' })
  })

  it('reads an EPSG source CRS from the crs member', () => {
    const fc = {
      type: 'FeatureCollection',
      crs: { properties: { name: 'urn:ogc:def:crs:EPSG::32632' } },
      features: [pointFeature([1, 2])],
    }
    expect(parseGeoJson(JSON.stringify(fc)).sourceCrs).toBe('EPSG:32632')
  })

  it('defaults source CRS to EPSG:4326 when none is present', () => {
    expect(parseGeoJson(JSON.stringify(pointFeature([1, 2]))).sourceCrs).toBe('EPSG:4326')
  })
})

describe('looksLikeGeoJson', () => {
  it('accepts .geojson / .json extensions', () => {
    expect(looksLikeGeoJson('points.geojson', '')).toBe(true)
    expect(looksLikeGeoJson('data.json', '')).toBe(true)
  })

  it('sniffs the content for a GeoJSON type token', () => {
    expect(looksLikeGeoJson('data.txt', '{"type":"FeatureCollection","features":[]}')).toBe(true)
  })

  it('rejects plain delimited text', () => {
    expect(looksLikeGeoJson('gcps.csv', 'name,x,y\nA,1,2')).toBe(false)
  })
})

describe('guessNameKey', () => {
  it('prefers "name" over other keys', () => {
    expect(guessNameKey(['id', 'name', 'label'])).toBe('name')
  })

  it('is case-insensitive but returns the original key', () => {
    expect(guessNameKey(['Foo', 'ID'])).toBe('ID')
  })

  it('falls back to the first key when none match', () => {
    expect(guessNameKey(['foo', 'bar'])).toBe('foo')
  })

  it('returns null with no keys', () => {
    expect(guessNameKey([])).toBeNull()
  })
})

describe('geoJsonToGcps', () => {
  it('converts Point features into GCPs with numeric coordinates', () => {
    const gcps = geoJsonToGcps([pointFeature([10, 20, 30], { name: 'P1' })], 'name')
    expect(gcps).toEqual([{ name: 'P1', x: 10, y: 20, z: 30,
      accuracyX: null, accuracyY: null, accuracyZ: null,
      correlationXY: null, correlationXZ: null, correlationYZ: null, observations: [] }])
  })

  it('expands a MultiPoint into one GCP per coordinate', () => {
    const f = {
      type: 'Feature',
      geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
      properties: {},
    }
    const gcps = geoJsonToGcps([f], null)
    expect(gcps.map((g) => [g.x, g.y])).toEqual([[1, 2], [3, 4]])
    expect(gcps[0].name).toBe('GCP 1')
  })

  it('skips non-Point geometries', () => {
    const gcps = geoJsonToGcps([polyFeature([[[0, 0], [1, 0], [1, 1], [0, 0]]])], null)
    expect(gcps).toHaveLength(0)
  })

  it('sets z to null when there is no third coordinate', () => {
    const gcps = geoJsonToGcps([pointFeature([1, 2])], null)
    expect(gcps[0].z).toBeNull()
  })
})

describe('geoJsonToFootprints', () => {
  it('extracts a polygon ring', () => {
    const fps = geoJsonToFootprints(
      [polyFeature([[[0, 0], [1, 0], [1, 1], [0, 0]]], { name: 'F1' })],
      'name',
    )
    expect(fps).toHaveLength(1)
    expect(fps[0]).toMatchObject({ name: 'F1', imageName: 'F1' })
    expect(fps[0].rings[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]])
  })

  it('expands a MultiPolygon into one footprint per part', () => {
    const f = {
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 5]]],
        ],
      },
      properties: {},
    }
    const fps = geoJsonToFootprints([f], null)
    expect(fps).toHaveLength(2)
  })

  it('drops degenerate rings with fewer than 3 points', () => {
    const fps = geoJsonToFootprints([polyFeature([[[0, 0], [1, 1]]])], null)
    expect(fps).toHaveLength(0)
  })

  it('skips non-Polygon geometries', () => {
    const fps = geoJsonToFootprints([pointFeature([1, 2])], null)
    expect(fps).toHaveLength(0)
  })
})
