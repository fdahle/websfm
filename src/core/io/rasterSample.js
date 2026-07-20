// THE raster sampler. One bilinear implementation, shared by the computed-DEM
// check (core/eval/demCheck.js) and the imported reference rasters
// (core/io/rasterSource.js) — a second sampler would be a second set of
// half-pixel and nodata bugs.
//
// Raster descriptor (top-left origin, row 0 = the northern edge for a north-up
// raster, which is the GeoTIFF convention and matches core/products/dem.js):
//
//   { width, height, data, nodata?, mask?,
//     geoTransform: { originX, originY, scaleX, scaleY } }
//
// Cell (col,row) *centre* sits at
//   x = originX + (col + 0.5)·scaleX
//   y = originY + (row + 0.5)·scaleY      (scaleY is negative when north-up)
//
// `data` is any indexable numeric array (Float32Array / Int16Array / …), single
// band, row-major. Validity is either an explicit `mask` (1 = valid, the
// computed-DEM shape) or a `nodata` sentinel, or — for float rasters — NaN.

// Is cell (c,r) inside the raster AND carrying a real value?
function valueAt(desc, c, r) {
  const { width, height, data, mask, nodata } = desc
  // An ortho RasterSource has no scalar plane at all (its pixels are RGBA), so
  // "sample a value here" is a legitimate question with the answer "none".
  if (!data) return null
  if (c < 0 || c >= width || r < 0 || r >= height) return null
  const i = r * width + c
  if (mask && !mask[i]) return null
  const v = data[i]
  if (!Number.isFinite(v)) return null
  if (nodata != null && v === nodata) return null
  return v
}

// Bilinear when all four neighbours are valid; else the nearest valid cell; else
// null. Returning null (rather than 0) is load-bearing — a nodata hole reported
// as an elevation of 0 is an error you only notice after it has poisoned a fit.
export function sampleRaster(desc, x, y) {
  if (!desc) return null
  const { originX, originY, scaleX, scaleY } = desc.geoTransform || {}
  if (!scaleX || !scaleY) return null

  // Fractional cell coordinates (cell centre c sits at fc = c).
  const fc = (x - originX) / scaleX - 0.5
  const fr = (y - originY) / scaleY - 0.5

  const c0 = Math.floor(fc)
  const r0 = Math.floor(fr)
  const c1 = c0 + 1
  const r1 = r0 + 1

  const v00 = valueAt(desc, c0, r0)
  const v10 = valueAt(desc, c1, r0)
  const v01 = valueAt(desc, c0, r1)
  const v11 = valueAt(desc, c1, r1)

  if (v00 != null && v10 != null && v01 != null && v11 != null) {
    const tx = fc - c0
    const ty = fr - r0
    const top = v00 * (1 - tx) + v10 * tx
    const bot = v01 * (1 - tx) + v11 * tx
    return top * (1 - ty) + bot * ty
  }

  // Nearest valid cell, then any of the four bilinear neighbours.
  const near = valueAt(desc, Math.round(fc), Math.round(fr))
  if (near != null) return near
  for (const v of [v00, v10, v01, v11]) if (v != null) return v
  return null
}

// World coordinate → fractional pixel coordinate (no clamping, no sampling).
// Used by the raster viewer and by GCP picking, which needs the inverse map.
export function worldToPixel(desc, x, y) {
  const { originX, originY, scaleX, scaleY } = desc?.geoTransform || {}
  if (!scaleX || !scaleY) return null
  return { col: (x - originX) / scaleX, row: (y - originY) / scaleY }
}

// Fractional pixel coordinate → world coordinate, at the *cell centre* of the
// pixel containing it. The exact inverse convention of worldToPixel.
export function pixelToWorld(desc, col, row) {
  const { originX, originY, scaleX, scaleY } = desc?.geoTransform || {}
  if (!scaleX || !scaleY) return null
  return { x: originX + col * scaleX, y: originY + row * scaleY }
}

// Raster bounds in world coordinates as [minX, minY, maxX, maxY], normalised so
// min < max regardless of the sign of scaleX/scaleY.
export function rasterBounds(desc) {
  const { width, height } = desc || {}
  const a = pixelToWorld(desc, 0, 0)
  const b = pixelToWorld(desc, width, height)
  if (!a || !b) return null
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
}
