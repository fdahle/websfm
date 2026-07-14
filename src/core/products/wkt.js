// Minimal OGC WKT1 CRS strings for `.prj` sidecars. proj4 does not ship WKT
// definitions, and we have no embedded EPSG parameter database, so this covers
// the cases whose parameters are either well-known (WGS84 geographic) or
// formulaic (WGS84 UTM zones) and returns null otherwise — the caller then falls
// back to writing the raw proj4/EPSG string. Pure: code in, string (or null) out.

// WGS84 datum + geographic CS fragment, reused by every WGS84-based projected CRS.
const WGS84_GEOGCS =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,'
  + 'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],'
  + 'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
  + 'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
  + 'AUTHORITY["EPSG","4326"]]'

// WGS84 UTM: EPSG 326{zone} (north) / 327{zone} (south), zone 1–60.
function utmWkt(code) {
  const north = code >= 32601 && code <= 32660
  const south = code >= 32701 && code <= 32760
  if (!north && !south) return null
  const zone = code - (north ? 32600 : 32700)
  const centralMeridian = 6 * zone - 183
  const falseNorthing = south ? 10000000 : 0
  const hemi = north ? 'N' : 'S'
  return (
    `PROJCS["WGS 84 / UTM zone ${zone}${hemi}",${WGS84_GEOGCS},`
    + 'PROJECTION["Transverse_Mercator"],'
    + `PARAMETER["latitude_of_origin",0],`
    + `PARAMETER["central_meridian",${centralMeridian}],`
    + 'PARAMETER["scale_factor",0.9996],'
    + 'PARAMETER["false_easting",500000],'
    + `PARAMETER["false_northing",${falseNorthing}],`
    + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],'
    + 'AXIS["Easting",EAST],AXIS["Northing",NORTH],'
    + `AUTHORITY["EPSG","${code}"]]`
  )
}

// Return an OGC WKT1 string for an EPSG code, or null when we can't build a
// correct one (the caller then writes the proj4/EPSG string instead).
export function epsgToWkt(code) {
  if (!code) return null
  if (code === 4326) return WGS84_GEOGCS
  return utmWkt(code)
}
