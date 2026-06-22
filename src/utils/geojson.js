// GeoJSON import parsing.
//
// A GeoJSON file can carry Point/MultiPoint features (which we import as Ground
// Control Points) or Polygon/MultiPolygon features (which we import as image
// footprints). This module classifies a file by geometry type and converts
// features into the raw shapes the GCP / footprint importers consume.
//
// Like gcp.js, this module is CRS-agnostic: it returns numbers in the file's own
// coordinates. The caller transforms them from the chosen source CRS into the
// project CRS. The GeoJSON `crs` member, when present, is only used to seed the
// source-CRS picker.

const POINT_TYPES = new Set(['Point', 'MultiPoint'])
const POLY_TYPES = new Set(['Polygon', 'MultiPolygon'])

// Property keys we prefer when guessing the name / image-name field.
const NAME_KEYS = ['name', 'id', 'image', 'img', 'photo', 'file', 'filename', 'label', 'title']

// Normalize a GeoJSON `crs` member to an "EPSG:xxxx" code, or null.
// Handles `urn:ogc:def:crs:EPSG::32632`, `EPSG:32632`, and bare numbers.
function readCrs(geojson) {
  const name = geojson?.crs?.properties?.name
  if (typeof name !== 'string') return null
  const m = /epsg:*:?(\d+)/i.exec(name) || /^(\d+)$/.exec(name)
  return m ? `EPSG:${m[1]}` : null
}

function featuresOf(geojson) {
  if (!geojson) return []
  if (geojson.type === 'FeatureCollection') return geojson.features || []
  if (geojson.type === 'Feature') return [geojson]
  // A bare geometry — wrap it as a feature with no properties.
  if (geojson.type && geojson.coordinates) return [{ type: 'Feature', geometry: geojson, properties: {} }]
  return []
}

// Parse + classify a GeoJSON file.
// Returns { kind: 'points'|'polygons'|'mixed'|'empty', features, sourceCrs, propertyKeys }.
export function parseGeoJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { kind: 'empty', features: [], sourceCrs: 'EPSG:4326', propertyKeys: [] }
  }

  const features = featuresOf(data).filter((f) => f?.geometry?.type)
  let hasPoints = false
  let hasPolys = false
  const keys = new Set()

  for (const f of features) {
    const t = f.geometry.type
    if (POINT_TYPES.has(t)) hasPoints = true
    else if (POLY_TYPES.has(t)) hasPolys = true
    for (const k of Object.keys(f.properties || {})) keys.add(k)
  }

  let kind = 'empty'
  if (hasPoints && hasPolys) kind = 'mixed'
  else if (hasPoints) kind = 'points'
  else if (hasPolys) kind = 'polygons'

  return {
    kind,
    features,
    sourceCrs: readCrs(data) || 'EPSG:4326',
    propertyKeys: [...keys],
  }
}

// Quick check used by the import router to decide whether a file is GeoJSON
// before fully parsing it.
export function looksLikeGeoJson(fileName, text) {
  if (/\.(geojson|json)$/i.test(fileName || '')) return true
  const head = text.slice(0, 2000)
  return /"type"\s*:\s*"(FeatureCollection|Feature|Point|MultiPoint|Polygon|MultiPolygon)"/.test(head)
}

// Pick the best name property from the available keys (case-insensitive).
export function guessNameKey(propertyKeys) {
  const lc = propertyKeys.map((k) => k.toLowerCase())
  for (const want of NAME_KEYS) {
    const i = lc.indexOf(want)
    if (i !== -1) return propertyKeys[i]
  }
  return propertyKeys[0] || null
}

function nameFrom(props, nameKey, fallback) {
  const v = nameKey != null ? props?.[nameKey] : null
  return v != null && v !== '' ? String(v) : fallback
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Convert Point/MultiPoint features into raw GCPs (file's own coordinates).
// Shape matches what useGcps.addGcps consumes: { name, x, y, z, observations }.
export function geoJsonToGcps(features, nameKey) {
  const gcps = []
  let i = 0
  for (const f of features) {
    const t = f.geometry?.type
    if (!POINT_TYPES.has(t)) continue
    const coords = t === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const c of coords) {
      const x = num(c?.[0]); const y = num(c?.[1])
      if (x == null || y == null) continue
      i++
      gcps.push({
        name: nameFrom(f.properties, nameKey, `GCP ${i}`),
        x, y, z: num(c?.[2]),
        observations: [],
      })
    }
  }
  return gcps
}

// Convert Polygon/MultiPolygon features into raw footprints (file's own coords).
// Shape: { name, imageName, rings: [[ [x,y], ... ], ...] } — one entry per polygon,
// rings = outer ring followed by any holes. MultiPolygon yields one entry per part.
export function geoJsonToFootprints(features, nameKey) {
  const footprints = []
  let i = 0
  for (const f of features) {
    const t = f.geometry?.type
    if (!POLY_TYPES.has(t)) continue
    const polys = t === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const poly of polys) {
      const rings = (poly || [])
        .map((ring) => ring.map((c) => [num(c?.[0]), num(c?.[1])]).filter((c) => c[0] != null && c[1] != null))
        .filter((ring) => ring.length >= 3)
      if (!rings.length) continue
      i++
      const name = nameFrom(f.properties, nameKey, `Footprint ${i}`)
      footprints.push({ name, imageName: name, rings })
    }
  }
  return footprints
}
