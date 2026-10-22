// The global terrain (core/terrainHeights.js: the Terrarium tiles the Terrain basemap
// shades, ~30 m at best) as a surface in a DEM's CRS, for Measure ▸ Volume with the
// base "Background terrain" (DEM of difference without an imported reference DEM).
// `sample(x, y)` answers synchronously once the tiles under the DEM are read, in the
// DEM's vertical datum when the terrain's (EGM96) converts to it.
import { ensureProjection, transformer } from './crs.js'
import { terrainSampler, terrainZoom, TERRAIN_DATUM, fetchTerrariumTile } from './terrainHeights.js'
import { heightShifter } from './verticalDatum.js'

export const TERRAIN_SURFACE_NAME = 'Background terrain'
// Web-Mercator tiles stop here: no terrain nearer the poles.
const MAX_LAT = 85.0511

// The lon/lat box of a projected box: a grid of points over it, since its edges
// curve in longitude/latitude (and a polar box holds its pole inside).
function lonLatBox([x0, y0, x1, y1], toLonLat) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity
  const N = 8
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++) {
      const [lon, lat] = toLonLat(x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N)
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      w = Math.min(w, lon)
      e = Math.max(e, lon)
      s = Math.min(s, lat)
      n = Math.max(n, lat)
    }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

// `bounds` [xmin, ymin, xmax, ymax] of the DEM in `crs`; `datum` its vertical datum
// (null / 'unknown': the terrain's heights are used as they are, and `datumNote` says
// so). Throws when the terrain cannot cover the DEM at all.
export async function terrainSurface({ crs, bounds, datum = null, loadTile = fetchTerrariumTile }) {
  if (!crs || crs === 'local') throw new Error('The DEM has no coordinate system to find the terrain under it')
  await ensureProjection(crs)
  const toLonLat = transformer(crs, 'EPSG:4326')
  const box = lonLatBox(bounds, toLonLat)
  if (!box) throw new Error('The DEM cannot be placed in longitude/latitude')
  if (box[1] > MAX_LAT || box[3] < -MAX_LAT)
    throw new Error('The background terrain stops at 85° latitude, short of this DEM')
  // A box across the antimeridian or around a pole spans all longitudes: read it whole.
  const full = box[2] - box[0] > 180
  const clipped = [full ? -180 : box[0], Math.max(-MAX_LAT, box[1]), full ? 180 : box[2], Math.min(MAX_LAT, box[3])]
  const sampler = terrainSampler(terrainZoom(clipped), { loadTile })
  await sampler.prefetch(clipped)
  if (!sampler.loadedCount)
    throw new Error(`The background terrain could not be read${sampler.error ? `: ${sampler.error}` : ''}`)
  const known = datum && datum !== 'unknown'
  const shiftAt = known ? await heightShifter(TERRAIN_DATUM, datum) : null
  return {
    name: TERRAIN_SURFACE_NAME,
    zoom: sampler.zoom,
    // Why the heights may be offset, or '' when they are in the DEM's datum.
    datumNote: !known
      ? "The DEM's vertical datum is unknown: the terrain's heights (EGM96 geoid) are compared as they are."
      : shiftAt
        ? ''
        : "The terrain's heights (EGM96 geoid) cannot be converted to the DEM's vertical datum; compared as they are.",
    sample(x, y) {
      let lon, lat
      try {
        ;[lon, lat] = toLonLat(x, y)
      } catch {
        return null
      }
      if (!(Math.abs(lat) <= MAX_LAT)) return null
      const h = sampler.heightAtLoaded(lon, lat)
      if (h == null) return null
      return shiftAt ? h + shiftAt(lon, lat) : h
    },
  }
}
