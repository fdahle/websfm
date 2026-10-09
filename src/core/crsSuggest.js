// Suggest a projected working CRS from camera positions in degrees.
//
// A project whose CRS is geographic (EPSG:4326, the default) cannot be
// georeferenced: the SfM→CRS fit is a similarity, and a similarity into degrees
// is meaningless. Geotagged images make the right answer derivable, so the app
// offers it — never applies it silently, since the working CRS is the user's
// choice and changing it reprojects every spatial record.
//
// Rules (pure; no proj4):
//   • UTM on WGS 84 inside its domain (80°S … 84°N), zone from the median
//     position, with the Norway (32V) and Svalbard (31X–37X) exceptions.
//   • Polar stereographic outside it — EPSG:3031 south, EPSG:3413 north — the
//     frames REMA and ArcticDEM ship in, so an imported reference DEM matches.
// The median keeps one stray position (a GPS glitch, a mislabelled image) from
// moving the zone.

const median = (values) => {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// UTM zone number (1–60) for a WGS 84 position, honouring the two standard
// exceptions to the 6° grid.
export function utmZone(lat, lon) {
  const l = ((lon + 180) % 360 + 360) % 360 - 180 // normalise to [-180, 180)
  if (lat >= 56 && lat < 64 && l >= 3 && l < 12) return 32 // south-west Norway
  if (lat >= 72 && lat < 84) { // Svalbard: zones 31, 33, 35, 37 only
    if (l >= 0 && l < 9) return 31
    if (l >= 9 && l < 21) return 33
    if (l >= 21 && l < 33) return 35
    if (l >= 33 && l < 42) return 37
  }
  return Math.min(60, Math.floor((l + 180) / 6) + 1)
}

// `positions`: [{ lat, lon }] in degrees (non-finite entries are ignored).
// Returns { code, name, lat, lon, count } for the median position, or null when
// there is nothing usable.
export function suggestProjectedCrs(positions) {
  const pts = (positions || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 360)
  if (!pts.length) return null
  const lat = median(pts.map((p) => p.lat))
  const lon = median(pts.map((p) => p.lon))
  const base = { lat, lon, count: pts.length }
  if (lat < -80) return { ...base, code: 'EPSG:3031', name: 'Antarctic Polar Stereographic' }
  if (lat >= 84) return { ...base, code: 'EPSG:3413', name: 'Arctic Polar Stereographic (NSIDC)' }
  const zone = utmZone(lat, lon)
  const north = lat >= 0
  return {
    ...base,
    code: `EPSG:${north ? 326 : 327}${String(zone).padStart(2, '0')}`,
    name: `WGS 84 / UTM zone ${zone}${north ? 'N' : 'S'}`,
  }
}

// Human-readable "44.5688°N 5.2755°E" for the log and the UI.
export function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
}
