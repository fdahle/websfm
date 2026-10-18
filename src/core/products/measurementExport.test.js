import { describe, expect, it } from 'vitest'
import {
  describeMeasurement, measurementsCsv, measurementsGeoJson, measurementWkt, rasterRecordCrs, geoJsonMode,
  MEASUREMENT_COLUMNS,
} from './measurementExport.js'
import { measurementStamp } from './measurementRecord.js'
import { similarityForExport } from './exportFrame.js'

const UTM = 'EPSG:32632'
// A ruler, an area and a volume on a UTM DEM (ground scale 1.0004), a profile on a
// local-frame DEM, and two 3D measurements on a computed mesh.
const ruler = { id: 'r1', name: 'Fence', kind: 'length', source: 'product:dem', crs: UTM, unit: 'm', verticalUnit: 'm',
  groundScale: 1.0004, world: [{ x: 500000, y: 5e6 }, { x: 500030, y: 5e6 + 40 }], distance: 50 / 1.0004, savedAt: Date.UTC(2026, 9, 18) }
const area = { id: 'a1', name: 'Roof', kind: 'area', source: 'product:dem', crs: UTM, unit: 'm', groundScale: 1,
  world: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], area: 12 }
const volume = { id: 'v1', name: 'Pile, north', kind: 'volume', source: 'reference:x', unit: 'm', verticalUnit: 'ft', groundScale: 2,
  stamp: measurementStamp({ id: 'x', importedAt: 1, width: 1, height: 1, crs: UTM }),
  world: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  volume: { cut: 10, fill: 2, net: 8, coverage: 0.875, insideCells: 16, base: { kind: 'custom', height: 101.5 } } }
const profile = { id: 'p1', name: 'Section', kind: 'profile', source: 'product:dem', crs: 'local', unit: 'model units',
  world: [{ x: 1, y: 2 }, { x: 4, y: 6 }], distance: 5,
  profile: [{ distance: 0, z: 3 }, { distance: 2.5, z: null }, { distance: 5, z: 7.5 }] }
const line3d = { id: 'l3', name: 'Distance 1 (3D)', kind: 'length3d', source: 'cloud:m', cloudName: 'Mesh',
  points3d: [[0, 0, 0], [3, 0, 4]], up: [0, 0, 1], unitSnapshot: { scale: 1, unit: 'model', label: 'model units' }, vertices: [] }
const area3d = { id: 'w3', name: 'Wall', kind: 'area3d', source: 'cloud:m', cloudName: 'Mesh',
  points3d: [[0, 0, 0], [2, 0, 0], [2, 0, 3], [0, 0, 3]], up: [0, 0, 1], vertices: [] }

describe('describeMeasurement', () => {
  it('keeps a raster measurement\'s saved units and ground scale', () => {
    const r = describeMeasurement(ruler, { sourceName: () => 'DEM' })
    expect(r.fields).toMatchObject({ name: 'Fence', kind: 'Ruler', measured_on: 'DEM', length_unit: 'm',
      ground_scale_factor: 1.0004, coordinate_frame: UTM, coordinate_unit: 'm', vertices: 2, saved_at: '2026-10-18T00:00:00.000Z' })
    expect(r.fields.length).toBeCloseTo(49.98, 2)
    expect(r.frame.crs).toBe(UTM)
    expect(r.closed).toBe(false)
  })

  it('gives an area its perimeter and a volume its unit, base and coverage', () => {
    const a = describeMeasurement(area).fields
    expect(a).toMatchObject({ area: 12, area_unit: 'm²', perimeter: 14, length: null })
    const v = describeMeasurement(volume)
    // The ground scale divides the planimetric area (16 grid units² / 2²) and perimeter.
    expect(v.fields).toMatchObject({ volume_cut: 10, volume_fill: 2, volume_net: 8, volume_unit: 'm²·ft',
      coverage_pct: 87.5, base: 'custom height', base_height: 101.5, elevation_unit: 'ft', area: 4, perimeter: 8 })
    // An older record without `crs` reads it from its source stamp.
    expect(v.frame.crs).toBe(UTM)
  })

  it('summarises a profile and never places a local frame', () => {
    const p = describeMeasurement(profile, { sourceName: () => 'DEM' })
    expect(p.fields).toMatchObject({ length: 5, length_unit: 'model units', elevation_min: 3, elevation_max: 7.5,
      relief: 4.5, elevation_unit: 'model units', coordinate_frame: 'local frame of DEM' })
    expect(p.frame.crs).toBeNull()
    expect(p.profile).toEqual([[0, 3], [2.5, null], [5, 7.5]])
  })

  it('re-measures 3D points in the resolver\'s unit and splits horizontal from height', () => {
    const metres = { scale: 2, unit: 'm', label: 'm' }
    const r = describeMeasurement(line3d, { units3d: () => metres })
    expect(r.fields).toMatchObject({ length: 10, horizontal_length: 6, height_change: 8, length_unit: 'm' })
    expect(r.coords).toEqual([[0, 0, 0], [3, 0, 4]])
    const w = describeMeasurement(area3d, { units3d: () => metres }).fields
    expect(w).toMatchObject({ area: 24, footprint_area: 0, perimeter: 20, area_unit: 'm²' })
  })

  it('without an up direction, reports only what is frame-independent', () => {
    const r = describeMeasurement({ ...line3d, up: undefined })
    expect(r.fields.length).toBe(5)
    expect(r.fields.horizontal_length).toBeNull()
    expect(r.fields.length_unit).toBe('model units')
  })

  it('writes 3D points through the export similarity into the CRS', () => {
    const resolved = { source: 'georef', unit: 'm', crs: UTM, scale: 2,
      frameSpec: { kind: 'similarity', scale: 2, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [500000, 5e6, 100] } }
    const { sim, crs } = similarityForExport(resolved)
    const r = describeMeasurement(line3d, { frame3d: () => ({ sim, crs, unit: 'm', label: crs }), units3d: () => ({ scale: 2, unit: 'm', label: 'm' }) })
    expect(r.coords).toEqual([[500000, 5e6, 100], [500006, 5e6, 108]])
    expect(r.frame).toEqual({ crs: UTM, label: UTM, unit: 'm' })
  })
})

describe('rasterRecordCrs', () => {
  it('treats local and missing frames as no CRS', () => {
    expect(rasterRecordCrs({ crs: 'local' })).toBeNull()
    expect(rasterRecordCrs({})).toBeNull()
    expect(rasterRecordCrs({ crs: UTM })).toBe(UTM)
  })
})

describe('CSV', () => {
  it('writes one row per measurement with unit columns and quoted text', () => {
    const csv = measurementsCsv([describeMeasurement(volume), describeMeasurement(line3d)])
    const [head, first, second] = csv.trim().split('\n')
    expect(head.split(',')).toEqual([...MEASUREMENT_COLUMNS, 'geometry_wkt'])
    expect(first.startsWith('"Pile, north",Volume,reference:x,no,')).toBe(true)
    expect(first).toContain('m²·ft')
    expect(first).toContain('"POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))"')
    expect(second).toContain('"LINESTRING Z (0 0 0, 3 0 4)"')
  })

  it('names the geometry type by its points', () => {
    expect(measurementWkt({ coords: [[1, 2]], closed: false })).toBe('POINT (1 2)')
    expect(measurementWkt({ coords: [], closed: false })).toBe('')
  })
})

describe('GeoJSON', () => {
  // A stand-in projection: the "WGS 84" of a UTM point is (x / 1e5, y / 1e6).
  const reproject = (coords, from, to) => coords.map((c) => (to === 'EPSG:4326' ? [c[0] / 1e5, c[1] / 1e6, ...c.slice(2)] : c))
  const geo3d = { ...line3d, id: 'g3' }
  const rows = () => [describeMeasurement(ruler), describeMeasurement(profile),
    { ...describeMeasurement(geo3d), frame: { crs: UTM, label: UTM, unit: 'm' }, coords: [[500000, 5e6, 100], [500003, 5e6, 104]] }]

  it('project mode names the CRS and keeps heights; local measurements stay unplaced', () => {
    const fc = measurementsGeoJson(rows(), { mode: 'project', targetCrs: UTM, reproject })
    expect(fc.crs).toEqual({ type: 'name', properties: { name: UTM } })
    expect(fc.georeferenced).toBe(true)
    const [r, p, l] = fc.features
    expect(r.geometry).toEqual({ type: 'LineString', coordinates: [[500000, 5e6], [500030, 5e6 + 40]] })
    expect(r.properties.length_unit).toBe('m')
    expect(p.geometry).toBeNull()
    expect(p.properties.frame_coordinates).toEqual([[1, 2], [4, 6]])
    expect(p.properties.profile).toEqual([[0, 3], [2.5, null], [5, 7.5]])
    expect(l.geometry.coordinates[1]).toEqual([500003, 5e6, 104])
  })

  it('wgs84 mode is RFC 7946: lon/lat only, no crs member, frame coordinates kept', () => {
    const fc = measurementsGeoJson(rows(), { mode: 'wgs84', targetCrs: UTM, reproject })
    expect(fc.crs).toBeUndefined()
    const l = fc.features[2]
    expect(l.geometry.coordinates).toEqual([[5, 5], [5.00003, 5]])
    expect(l.properties.frame_coordinates[1]).toEqual([500003, 5e6, 104])
  })

  it('a project with no CRS anywhere is written in its own frames, not georeferenced', () => {
    const local = [describeMeasurement(profile), describeMeasurement(area3d)]
    expect(geoJsonMode(local, 'wgs84')).toBe('local')
    const fc = measurementsGeoJson(local, { mode: 'wgs84' })
    expect(fc.crs).toBeUndefined()
    expect(fc.georeferenced).toBe(false)
    expect(fc.features[1].geometry.type).toBe('Polygon')
    expect(fc.features[1].geometry.coordinates[0]).toHaveLength(5)
    expect(fc.features[0].properties.coordinate_frame).toBe('local frame of product:dem')
  })
})
