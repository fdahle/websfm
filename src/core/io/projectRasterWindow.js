// The window of a reference raster to read when the whole raster is too large for one
// plane (Chrome caps one buffer at 2 GiB: a Float32 DEM of ~23,000² cells): the
// project's area, from its images' positions, with a margin. Pure: the caller passes the
// positions and the lon/lat → raster CRS transform.

import { MAX_BUFFER_BYTES } from '../bufferLimit.js'

const M_PER_DEG = 111320

/**
 * `points`: [[lon, lat], …] of the project's images. `toRaster(lon, lat)` → [x, y] in
 * the raster's CRS. `geoTransform`, `width`, `height`: the full raster. The area is the
 * points' box grown on each side by `marginFrac` of its extent, and by at least
 * `minMarginM` metres (an aerial image sees well past its camera; one image alone has
 * no extent). Returns [x0, y0, x1, y1] in pixels of the full raster, clamped to it, or
 * null: no points, the area outside the raster, or a window still too large for one
 * plane at `cellBytes` a cell.
 */
export function projectRasterWindow({
  points,
  toRaster,
  geoTransform,
  width,
  height,
  cellBytes = 4,
  marginFrac = 0.5,
  minMarginM = 1000,
}) {
  const ok = (points ?? []).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
  if (!ok.length) return null
  let lon0 = Infinity,
    lon1 = -Infinity,
    lat0 = Infinity,
    lat1 = -Infinity
  for (const [lon, lat] of ok) {
    lon0 = Math.min(lon0, lon)
    lon1 = Math.max(lon1, lon)
    lat0 = Math.min(lat0, lat)
    lat1 = Math.max(lat1, lat)
  }
  const midLat = (lat0 + lat1) / 2
  const mLat = minMarginM / M_PER_DEG,
    mLon = minMarginM / (M_PER_DEG * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)))
  const dLon = Math.max(marginFrac * (lon1 - lon0), mLon),
    dLat = Math.max(marginFrac * (lat1 - lat0), mLat)
  lon0 -= dLon
  lon1 += dLon
  lat0 = Math.max(-90, lat0 - dLat)
  lat1 = Math.min(90, lat1 + dLat)
  // The area's outline, sampled (a projection bends the box's edges), in raster pixels.
  const { originX, originY, scaleX, scaleY } = geoTransform
  let c0 = Infinity,
    c1 = -Infinity,
    r0 = Infinity,
    r1 = -Infinity
  const N = 16
  for (let i = 0; i <= N; i++) {
    const f = i / N
    for (const [lon, lat] of [
      [lon0 + f * (lon1 - lon0), lat0],
      [lon0 + f * (lon1 - lon0), lat1],
      [lon0, lat0 + f * (lat1 - lat0)],
      [lon1, lat0 + f * (lat1 - lat0)],
    ]) {
      const [x, y] = toRaster(lon, lat)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const c = (x - originX) / scaleX,
        r = (y - originY) / scaleY
      c0 = Math.min(c0, c)
      c1 = Math.max(c1, c)
      r0 = Math.min(r0, r)
      r1 = Math.max(r1, r)
    }
  }
  const x0 = Math.max(0, Math.floor(c0)),
    y0 = Math.max(0, Math.floor(r0)),
    x1 = Math.min(width, Math.ceil(c1)),
    y1 = Math.min(height, Math.ceil(r1))
  if (!(x1 > x0 && y1 > y0)) return null
  if ((x1 - x0) * (y1 - y0) * cellBytes > MAX_BUFFER_BYTES) return null
  return [x0, y0, x1, y1]
}
