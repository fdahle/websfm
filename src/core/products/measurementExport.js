// Saved measurements (useMeasurementsStore) as CSV and GeoJSON. Pure: the caller
// resolves what the project knows (units, the export frame, staleness, a
// reprojection function with its CRSs already registered) into `ctx`.
//
// Every number leaves with its unit. A raster measurement keeps the units and the
// ground scale it was saved with (RasterMeasurements.vue); a 3D measurement is
// re-measured from its points in the unit THE resolver gives now (cloudUnits.js),
// the same rule the 3D toolbox lists it by. Coordinates are written in the frame
// they were measured in, and a CRS is only ever named when that frame has one: a
// model-unit or local-frame measurement is labelled as such, never placed.
//
// GeoJSON comes in two flavours (the export dialog's Coordinates choice):
//   'project' — the project CRS, named in the legacy `crs` member, as the app's
//               other GeoJSON exports (contours, polygon layers) write it. Exact
//               coordinates, heights kept as the third coordinate. Read by QGIS and
//               GDAL, and by this app's own GeoJSON import.
//   'wgs84'   — RFC 7946: longitude/latitude on WGS 84. RFC 7946 makes a third
//               coordinate an ellipsoidal height, which a project height is not
//               (no geoid model here), so geometries are 2D and the measured frame
//               coordinates, heights included, ride along in `frame_coordinates`.
// A measurement whose frame has no CRS (a local DEM, an unreferenced model, an
// imported cloud's file coordinates) cannot be placed in either: its geometry is
// null and its frame coordinates are kept in `frame_coordinates`. When NO
// measurement has a CRS, the file is written in the measured frame ('local'): no
// `crs`, `georeferenced: false`, and every feature says which frame it is in.

import { planimetricArea, polygon3d, polyline3d, polylineLength } from './measure.js'
import { volumeUnitLabel } from './rasterUnits.js'
import { measureUnitLabel } from './cloudUnits.js'
import { applySimilarity } from './georef.js'

export const MEASUREMENT_KINDS = {
  length: 'Ruler',
  area: 'Area',
  profile: 'Elevation profile',
  volume: 'Volume',
  length3d: '3D distance',
  area3d: '3D area',
}

export const is3dMeasurement = (record) => record?.kind === 'length3d' || record?.kind === 'area3d'

// Columns, in order. Each value column's unit sits in the `*_unit` column after its
// group; `coverage_pct` is a percentage and `ground_scale_factor` has no unit.
export const MEASUREMENT_COLUMNS = [
  'name', 'kind', 'measured_on', 'stale',
  'length', 'horizontal_length', 'height_change', 'perimeter', 'length_unit',
  'area', 'footprint_area', 'area_unit',
  'elevation_min', 'elevation_max', 'relief', 'base_height', 'elevation_unit',
  'volume_cut', 'volume_fill', 'volume_net', 'volume_unit', 'base', 'coverage_pct',
  'ground_scale_factor', 'vertices', 'coordinate_frame', 'coordinate_unit', 'saved_at',
]

/**
 * The CRS a raster measurement's coordinates are in: the one it recorded, else the
 * one in its source stamp (measurementRecord.js measurementStamp, element 4).
 * `'local'` and missing both mean "no CRS" (null).
 */
export function rasterRecordCrs(record) {
  let crs = record?.crs
  if (crs === undefined && typeof record?.stamp === 'string') {
    try { crs = JSON.parse(record.stamp)?.[4] } catch { crs = null }
  }
  return crs && crs !== 'local' ? crs : null
}

const round = (v, digits = 6) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null)
const VOLUME_BASES = { plane: 'best-fit plane', lowest: 'lowest vertex', custom: 'custom height' }

/**
 * One saved measurement as a flat row of values with units, plus its geometry in
 * the frame it was measured in.
 * ctx:
 *   stale(record)     → boolean (source raster/layer or frame changed)
 *   sourceName(record) → what it was measured on, for the `measured_on` column
 *   units3d(record)   → { scale, unit, label } (cloudUnits.js) for a 3D measurement
 *   frame3d(record)   → { sim, crs, unit, label, up } the frame a 3D measurement's
 *                       points are written in (exportFrame.js similarityForExport for a
 *                       computed layer; sim null for an imported one's file coordinates).
 *                       `up` (model frame) splits a length into horizontal and height
 *                       when the record did not save its own.
 * → { id, fields: {column → value}, frame: { crs, label, unit }, coords, closed, profile }
 */
export function describeMeasurement(record, ctx = {}) {
  const f = Object.fromEntries(MEASUREMENT_COLUMNS.map((c) => [c, null]))
  f.name = record.name ?? ''
  f.kind = MEASUREMENT_KINDS[record.kind] ?? record.kind
  f.measured_on = ctx.sourceName?.(record) ?? record.source ?? ''
  f.stale = !!ctx.stale?.(record)
  f.saved_at = Number.isFinite(record.savedAt) ? new Date(record.savedAt).toISOString() : null
  let frame, coords, closed = false, profile = null

  if (is3dMeasurement(record)) {
    const units = ctx.units3d?.(record) ?? record.unitSnapshot ?? { scale: 1, unit: 'model', label: 'model units' }
    const fr = ctx.frame3d?.(record) ?? { sim: null, crs: null, unit: units.label, label: 'model frame' }
    const pts = (record.points3d ?? []).map((p) => [p[0], p[1], p[2]])
    const up = record.up ?? fr.up ?? null
    f.length_unit = measureUnitLabel(units, 1)
    if (record.kind === 'area3d') {
      closed = true
      const a = polygon3d(pts, up ?? [0, 0, 1])
      f.area_unit = measureUnitLabel(units, 2)
      if (a) {
        f.area = round(a.area * units.scale ** 2)
        if (up) f.footprint_area = round(a.footprint * units.scale ** 2)
        f.perimeter = round(a.perimeter * units.scale)
      }
    } else {
      const l = polyline3d(pts, up ?? [0, 0, 1])
      if (l) {
        f.length = round(l.length * units.scale)
        if (up) {
          f.horizontal_length = round(l.horizontal * units.scale)
          f.height_change = round(l.vertical * units.scale)
        }
      }
    }
    coords = fr.sim ? pts.map((p) => applySimilarity(fr.sim, p)) : pts
    frame = { crs: fr.crs ?? null, label: fr.label, unit: fr.unit }
  } else {
    const k = record.groundScale > 0 ? record.groundScale : 1
    const unit = record.unit || 'model units'
    const vertical = record.verticalUnit || unit
    const world = record.world ?? []
    if (k !== 1) f.ground_scale_factor = round(k, 9)
    f.length_unit = unit
    if (record.kind === 'area' || record.kind === 'volume') {
      closed = true
      const area = record.kind === 'area' ? record.area : planimetricArea(world)
      f.area = area == null ? null : round(record.kind === 'area' ? area : area / (k * k))
      f.area_unit = `${unit}²`
      f.perimeter = world.length > 2 ? round(polylineLength([...world, world[0]]) / k) : null
    } else {
      f.length = round(record.distance)
    }
    if (record.kind === 'profile') {
      profile = (record.profile ?? []).map((p) => [round(p.distance), p.z == null ? null : round(p.z)])
      let lo = Infinity, hi = -Infinity
      for (const [, z] of profile) if (z != null) { lo = Math.min(lo, z); hi = Math.max(hi, z) }
      f.elevation_unit = vertical
      if (lo <= hi) { f.elevation_min = lo; f.elevation_max = hi; f.relief = round(hi - lo) }
    }
    if (record.kind === 'volume') {
      const v = record.volume
      f.volume_unit = volumeUnitLabel({ horizontal: unit, vertical })
      f.elevation_unit = vertical
      if (v && !v.error) {
        f.volume_cut = round(v.cut); f.volume_fill = round(v.fill); f.volume_net = round(v.net)
        f.coverage_pct = round(100 * v.coverage, 2)
        const b = v.base ?? {}
        f.base = b.kind === 'surface' ? `reference DEM "${b.name ?? ''}"` : VOLUME_BASES[b.kind] ?? b.kind ?? null
        if (b.kind === 'lowest' || b.kind === 'custom') f.base_height = round(b.height)
      }
    }
    coords = world.map((p) => [p.x, p.y])
    const crs = rasterRecordCrs(record)
    frame = { crs, label: crs ?? `local frame of ${f.measured_on || 'the raster'}`, unit }
  }
  f.vertices = coords.length
  f.coordinate_frame = frame.label
  f.coordinate_unit = frame.unit
  return { id: record.id, fields: f, frame, coords, closed, profile }
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(v) {
  if (v == null) return ''
  const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const fmtCoord = (v, digits) => String(Number(v.toFixed(digits)))

/** The geometry as WKT in its own frame (the CSV's `geometry_wkt` column). */
export function measurementWkt({ coords, closed }) {
  if (!coords?.length) return ''
  const has3 = coords.every((c) => c.length > 2)
  const pt = (c) => (has3 ? [c[0], c[1], c[2]] : [c[0], c[1]]).map((v) => fmtCoord(v, 6)).join(' ')
  const z = has3 ? ' Z' : ''
  if (closed && coords.length > 2) return `POLYGON${z} ((${[...coords, coords[0]].map(pt).join(', ')}))`
  if (coords.length === 1) return `POINT${z} (${pt(coords[0])})`
  return `LINESTRING${z} (${coords.map(pt).join(', ')})`
}

/** Rows (describeMeasurement) → CSV text: one line per measurement, units in columns. */
export function measurementsCsv(rows) {
  const header = [...MEASUREMENT_COLUMNS, 'geometry_wkt']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([...MEASUREMENT_COLUMNS.map((c) => csvCell(row.fields[c])), csvCell(measurementWkt(row))].join(','))
  }
  return lines.join('\n') + '\n'
}

// ── GeoJSON ─────────────────────────────────────────────────────────────────

/** Which GeoJSON coordinates a set of rows allows: `mode` unless no row has a CRS. */
export function geoJsonMode(rows, mode) {
  return rows.some((r) => r.frame.crs) ? mode : 'local'
}

function geometryOf(coords, closed, digits) {
  const c = coords.map((p) => p.map((v) => Number(v.toFixed(digits))))
  if (!c.length) return null
  if (closed && c.length > 2) return { type: 'Polygon', coordinates: [[...c, c[0]]] }
  if (c.length === 1) return { type: 'Point', coordinates: c[0] }
  return { type: 'LineString', coordinates: c }
}

/**
 * Rows → a GeoJSON FeatureCollection.
 * opts.mode       'project' | 'wgs84' (see the header); forced to 'local' when no row
 *                 has a CRS.
 * opts.targetCrs  the project CRS ('project' mode).
 * opts.reproject  (coords, fromCrs, toCrs) → coords, synchronous, x/y only (z passes
 *                 through); its CRSs must already be registered.
 */
export function measurementsGeoJson(rows, { mode = 'project', targetCrs = null, reproject = null } = {}) {
  const used = geoJsonMode(rows, mode)
  const target = used === 'wgs84' ? 'EPSG:4326' : used === 'project' ? targetCrs : null
  const features = rows.map((row) => {
    const props = { ...row.fields }
    if (row.profile) props.profile = row.profile
    let geometry = null
    if (used === 'local') {
      geometry = geometryOf(row.coords, row.closed, 6)
    } else if (row.frame.crs && target && reproject) {
      const xy = row.frame.crs === target ? row.coords : reproject(row.coords, row.frame.crs, target)
      if (used === 'wgs84') {
        geometry = geometryOf(xy.map((p) => [p[0], p[1]]), row.closed, 9)
        props.frame_coordinates = row.coords.map((p) => p.map((v) => Number(v.toFixed(6))))
      } else {
        geometry = geometryOf(xy, row.closed, 6)
        if (row.frame.crs !== target) props.frame_coordinates = row.coords.map((p) => p.map((v) => Number(v.toFixed(6))))
      }
    } else {
      // No CRS for this one: it cannot be placed in a georeferenced file.
      props.frame_coordinates = row.coords.map((p) => p.map((v) => Number(v.toFixed(6))))
    }
    return { type: 'Feature', id: row.id, geometry, properties: props }
  })
  const fc = { type: 'FeatureCollection', name: 'measurements' }
  if (used === 'project' && /^EPSG:\d+$/i.test(target ?? '')) {
    fc.crs = { type: 'name', properties: { name: target.toUpperCase() } }
  }
  // Foreign members (RFC 7946 §6.1): what the coordinates are, for a human reader.
  fc.coordinate_frame = used === 'wgs84' ? 'WGS 84 longitude/latitude (RFC 7946)'
    : used === 'project' ? target : 'local — see each feature\'s coordinate_frame'
  fc.georeferenced = used !== 'local'
  fc.features = features
  return fc
}
