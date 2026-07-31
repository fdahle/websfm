// Coordinate Reference System helpers.
//
// A project has one "working" CRS. Everything (image GPS, GCPs, cameras) is
// expressed in it, and the 2D map renders in it. Imported data declares its own
// source CRS and is transformed into the project CRS on the way in.
//
// proj4 does the math; we register definitions with OpenLayers so the map View
// and coordinate transforms understand each code.

import proj4 from 'proj4'
import { register } from 'ol/proj/proj4'
import { get as getOlProjection } from 'ol/proj'

// ── Catalog ─────────────────────────────────────────────────────────────────
// Curated entries shown in the CRS picker. Any other EPSG code can still be used
// via ensureProjection() (UTM is generated; everything else is fetched).
//
// axes: labels for the three components, used so the column mapper / readouts
//       say "Lon/Lat" for geographic and "Easting/Northing" for projected.
// basemap: which tile layer the map should draw behind markers.
//   'osm'  → OpenStreetMap (OL reprojects raster tiles to the view CRS)
//   'gibs' → NASA GIBS WMTS in a matching polar projection (see gibs field)
// extent: validity extent in the projection's own units (projected CRS only),
//         used for the map view and the grid.
// worldExtent: geographic area of use [west, south, east, north] in degrees.
//         Required by the grid; derived automatically when omitted.

export const CRS_CATALOG = [
  {
    code: 'EPSG:4326',
    name: 'WGS 84 (lon/lat)',
    def: '+proj=longlat +datum=WGS84 +no_defs',
    geographic: true,
    axes: ['Lon', 'Lat', 'Alt'],
    basemap: 'osm',
  },
  {
    code: 'EPSG:3857',
    name: 'Web Mercator',
    def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
    geographic: false,
    axes: ['Easting', 'Northing', 'Up'],
    basemap: 'osm',
  },
  {
    code: 'EPSG:3031',
    name: 'Antarctic Polar Stereographic',
    def: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    geographic: false,
    axes: ['Easting', 'Northing', 'Up'],
    extent: [-4194304, -4194304, 4194304, 4194304],
    worldExtent: [-180, -90, 180, -50],
    basemap: 'gibs',
    gibs: { endpoint: 'https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/wmts.cgi', layer: 'SCAR_Land_Water_Map', matrixSet: '250m', format: 'image/png' },
  },
  {
    code: 'EPSG:3413',
    name: 'Arctic Polar Stereographic (NSIDC)',
    def: '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    geographic: false,
    axes: ['Easting', 'Northing', 'Up'],
    extent: [-4194304, -4194304, 4194304, 4194304],
    worldExtent: [-180, 30, 180, 90],
    basemap: 'gibs',
    gibs: { endpoint: 'https://gibs.earthdata.nasa.gov/wmts/epsg3413/best/wmts.cgi', layer: 'BlueMarble_ShadedRelief_Bathymetry', matrixSet: '500m', format: 'image/jpeg' },
  },
  {
    code: 'EPSG:32632',
    name: 'UTM zone 32N (WGS 84)',
    def: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
    geographic: false,
    axes: ['Easting', 'Northing', 'Up'],
    basemap: 'osm',
  },
]

const catalogByCode = new Map(CRS_CATALOG.map((c) => [c.code, c]))
const dynamicInfoByCode = new Map()

export function crsInfo(code) {
  return catalogByCode.get(code) || dynamicInfoByCode.get(code)
    || { code, name: code, geographic: false, axes: ['X', 'Y', 'Z'], basemap: 'osm' }
}

export function axisLabels(code) {
  return crsInfo(code).axes
}

export function isGeographic(code) {
  const catalog = catalogByCode.get(code)
  if (catalog) return !!catalog.geographic
  // Dynamically fetched/custom definitions are not in the curated picker
  // catalog. Once registered, inspect proj4 as well so another geographic EPSG
  // cannot slip through a metric-only computation merely because it is not a preset.
  const def = proj4.defs(code)
  if (!def) return false
  if (typeof def === 'string') return /\+proj=(longlat|latlong)\b/i.test(def)
  return def.projName === 'longlat' || def.projName === 'latlong'
}

// ── Registration ──────────────────────────────────────────────────────────────

// Track what proj4 already knows so we don't re-register or re-fetch.
const registered = new Set(['EPSG:4326', 'EPSG:3857'])

// Cache for definitions fetched from epsg.io, persisted in OPFS across reloads.
let defCache = null
async function loadDefCache() {
  if (defCache) return defCache
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('websfm', { create: true })
    const fh = await dir.getFileHandle('crs-defs.json')
    defCache = JSON.parse(await (await fh.getFile()).text())
  } catch {
    defCache = {}
  }
  return defCache
}
async function saveDefCache() {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('websfm', { create: true })
    const fh = await dir.getFileHandle('crs-defs.json', { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify(defCache || {}))
    await w.close()
  } catch {}
}

// Generate a UTM proj4 def from an EPSG code (326xx = north, 327xx = south).
function utmDef(code) {
  const m = /^EPSG:(326|327)(\d{2})$/.exec(code)
  if (!m) return null
  const zone = parseInt(m[2], 10)
  if (zone < 1 || zone > 60) return null
  const south = m[1] === '327' ? ' +south' : ''
  return `+proj=utm +zone=${zone}${south} +datum=WGS84 +units=m +no_defs`
}

// Geographic area of use for a UTM zone, parsed straight from the proj4 string.
// Works for any datum (WGS84, NAD83, …) since only the zone/hemisphere matters.
function utmWorldExtent(def) {
  const zone = Number(/\+zone=(\d+)/.exec(def || '')?.[1])
  if (!zone || zone < 1 || zone > 60) return null
  const south = /\+south\b/.test(def || '')
  const lon0 = zone * 6 - 183
  return south ? [lon0 - 6, -80, lon0 + 6, 0] : [lon0 - 6, 0, lon0 + 6, 84]
}

// Project a geographic [w,s,e,n] box into `code`, returning the projected
// bounding box of its corners (and edge midpoints). Null if nothing transforms
// to finite numbers.
function projectExtent(world, code) {
  const [w, s, e, n] = world
  const samples = [
    [w, s], [w, n], [e, s], [e, n],
    [(w + e) / 2, s], [(w + e) / 2, n], [w, (s + n) / 2], [e, (s + n) / 2],
  ]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, ok = false
  for (const pt of samples) {
    let x, y
    try { [x, y] = proj4('EPSG:4326', code, pt) } catch { continue }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    ok = true
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  }
  return ok ? [minX, minY, maxX, maxY] : null
}

// Give the OpenLayers projection both a projected extent and a geographic
// worldExtent. The OL graticule layer requires both; without them it throws on
// every render. Catalog values win; otherwise we derive from the proj4 def.
function setProjectionExtents(code, def, { extent, worldExtent } = {}) {
  const proj = getOlProjection(code)
  if (!proj) return

  const world = worldExtent || utmWorldExtent(def) || [-180, -85, 180, 85]
  proj.setWorldExtent(world)

  const ext = extent || projectExtent(world, code)
  if (ext) proj.setExtent(ext)
}

function applyDef(code, def, opts) {
  proj4.defs(code, def)
  register(proj4)
  registered.add(code)
  setProjectionExtents(code, def, opts)
}

// Make sure `code` is usable by proj4 and OpenLayers. Resolves the definition
// from the catalog, a generated UTM def, the OPFS cache, or epsg.io.
export async function ensureProjection(code, supplied = null) {
  if (registered.has(code)) return true

  // Search results from the embedded EPSG index carry their definition and
  // area of use, avoiding a second lookup and making CRS selection work offline.
  if (supplied?.def) {
    dynamicInfoByCode.set(code, {
      code,
      name: supplied.name || code,
      geographic: !!supplied.geographic,
      axes: supplied.geographic ? ['Lon', 'Lat', 'Alt'] : ['Easting', 'Northing', 'Up'],
      basemap: 'osm',
      worldExtent: supplied.worldExtent,
    })
    applyDef(code, supplied.def, { worldExtent: supplied.worldExtent })
    return true
  }

  const cat = catalogByCode.get(code)
  if (cat?.def) { applyDef(code, cat.def, { extent: cat.extent, worldExtent: cat.worldExtent }); return true }

  const utm = utmDef(code)
  if (utm) { applyDef(code, utm); return true }

  const cache = await loadDefCache()
  if (cache[code]) { applyDef(code, cache[code]); return true }

  // Last resort: fetch the proj4 string from epsg.io (one network call, cached).
  const num = /^EPSG:(\d+)$/.exec(code)?.[1]
  if (!num) throw new Error(`Unsupported CRS code: ${code}`)
  const res = await fetch(`https://epsg.io/${num}.proj4`)
  if (!res.ok) throw new Error(`Could not resolve ${code} (epsg.io ${res.status})`)
  const def = (await res.text()).trim()
  if (!def.startsWith('+')) throw new Error(`Invalid definition for ${code}`)
  cache[code] = def
  await saveDefCache()
  applyDef(code, def)
  return true
}

// ── Transforms ────────────────────────────────────────────────────────────────

// Transform a single [x, y] (or [x, y, z]) from one CRS to another.
// Both CRS must already be ensured. Returns a new array; z passes through.
export function transform(coord, from, to) {
  if (from === to) return coord.slice()
  const [x, y] = proj4(from, to, [coord[0], coord[1]])
  return coord.length > 2 ? [x, y, coord[2]] : [x, y]
}

// Ensure both endpoints, then transform. Async convenience wrapper.
export async function transformAsync(coord, from, to) {
  await ensureProjection(from)
  await ensureProjection(to)
  return transform(coord, from, to)
}

// Register a local azimuthal-equidistant *metric* frame centred on (lon, lat)
// (WGS84 degrees) and return its synthetic proj4 code. Used to do metric geometry
// (e.g. footprint ray-casting, which needs 1 unit = 1 metre) when the working CRS
// is geographic: transform into this frame, compute in metres, transform back.
// aeqd is valid everywhere — including the poles, where UTM is undefined. Only
// registered with proj4 (not OpenLayers), since it exists purely for `transform`.
export function localMetricFrame(lon, lat) {
  const code = `LOCAL:aeqd:${lon.toFixed(5)}:${lat.toFixed(5)}`
  if (!proj4.defs(code)) {
    proj4.defs(code, `+proj=aeqd +lat_0=${lat} +lon_0=${lon} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`)
  }
  return code
}
