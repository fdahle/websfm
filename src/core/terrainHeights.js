import { TERRAIN, decodeTerrarium } from './basemaps.js'
import { TILE_CACHE_MAX_ZOOM } from './offlineCache.js'

// Ground heights from the global terrain: the Terrarium tiles the Terrain basemap
// shades (core/basemaps.js TERRAIN), read as numbers. Their sources (SRTM, NOAA
// ETOPO1 and others) are heights above mean sea level, taken here as EGM96, the
// geoid SRTM is referenced to.
export const TERRAIN_DATUM = 'geoid:EGM96'

// Levels past 12 only resample the ~30 m sources, and the service worker keeps
// tiles up to TILE_CACHE_MAX_ZOOM, so a project area the map has shown is
// sampled offline from the same tiles.
export const TERRAIN_MAX_ZOOM = Math.min(TILE_CACHE_MAX_ZOOM, TERRAIN.maxZoom)
// A large area is read at a coarser level rather than as hundreds of tiles.
export const TERRAIN_MAX_TILES = 64

// Fractional Web-Mercator tile coordinates of a lon/lat at level z.
export function tileCoords(lon, lat, z) {
  const n = 2 ** z
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n]
}

// The finest level at which a lon/lat box spans at most TERRAIN_MAX_TILES tiles.
export function terrainZoom([west, south, east, north]) {
  for (let z = TERRAIN_MAX_ZOOM; z > 0; z--) {
    const [x0, y0] = tileCoords(west, north, z)
    const [x1, y1] = tileCoords(east, south, z)
    const tiles = (Math.floor(x1) - Math.floor(x0) + 1) * (Math.floor(y1) - Math.floor(y0) + 1)
    if (tiles <= TERRAIN_MAX_TILES) return z
  }
  return 0
}

// One Terrarium tile as elevations in metres ({ elev, w, h }, row-major).
export async function fetchTerrariumTile(z, x, y, { signal } = {}) {
  const res = await fetch(TERRAIN.url(z, x, y), { signal })
  if (!res.ok) throw new Error(`Terrain tile ${z}/${x}/${y}: HTTP ${res.status}`)
  // The PNG's bytes ARE the elevations: no colour management, no premultiply.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width: w, height: h } = bitmap
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return { elev: decodeTerrarium(ctx.getImageData(0, 0, w, h).data, w, h), w, h }
}

/**
 * Heights of the global terrain at level `zoom`: `heightAt(lon, lat)` → metres
 * above EGM96, bilinear between pixel centres (clamped at a tile's edge), or
 * null where the tile could not be read. Each tile is fetched once; the first
 * failure is kept in `error` for the caller's report. `loadTile(z, x, y)` →
 * { elev, w, h } is injectable for tests.
 */
export function terrainSampler(zoom, { loadTile = fetchTerrariumTile } = {}) {
  const tiles = new Map()
  const tileAt = (x, y) => {
    const key = `${x}/${y}`
    if (!tiles.has(key)) {
      tiles.set(
        key,
        Promise.resolve()
          .then(() => loadTile(zoom, x, y))
          .catch((err) => {
            sampler.error ??= err?.message ?? String(err)
            return null
          }),
      )
    }
    return tiles.get(key)
  }
  const sampler = {
    zoom,
    error: null,
    // Start every tile of a lon/lat box at once, rather than one per first query.
    async prefetch([west, south, east, north]) {
      const [x0, y0] = tileCoords(west, north, zoom).map(Math.floor)
      const [x1, y1] = tileCoords(east, south, zoom).map(Math.floor)
      const all = []
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) all.push(tileAt(x, y))
      await Promise.all(all)
    },
    async heightAt(lon, lat) {
      const [tx, ty] = tileCoords(lon, lat, zoom)
      const x = Math.floor(tx),
        y = Math.floor(ty)
      const tile = await tileAt(x, y)
      if (!tile) return null
      const { elev, w, h } = tile
      const px = Math.max(0, Math.min(w - 1, (tx - x) * w - 0.5))
      const py = Math.max(0, Math.min(h - 1, (ty - y) * h - 0.5))
      const c0 = Math.floor(px),
        r0 = Math.floor(py)
      const c1 = Math.min(w - 1, c0 + 1),
        r1 = Math.min(h - 1, r0 + 1)
      const fx = px - c0,
        fy = py - r0
      const at = (r, c) => elev[r * w + c]
      const top = at(r0, c0) * (1 - fx) + at(r0, c1) * fx
      const bottom = at(r1, c0) * (1 - fx) + at(r1, c1) * fx
      return top * (1 - fy) + bottom * fy
    },
    get tileCount() {
      return tiles.size
    },
  }
  return sampler
}
