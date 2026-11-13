// Reading the global terrain's Terrarium tiles (core/basemaps.js TERRAIN) from the
// network into elevations; core/terrainHeights.js samples them.
import { TERRAIN, decodeTerrarium } from '../core/basemaps.js'

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
