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

// The value of the cell CONTAINING world (x, y): no interpolation and no
// neighbour fallback, so a nodata cell reads null. This is what a cursor readout
// shows. `sampleRaster` (below) is for consumers that want a height near a point
// even at a hole's edge (GCP Z fill) — reading a neighbour there is its contract,
// but a readout doing it prints a height over a hole.
export function cellValue(desc, x, y) {
  const { originX, originY, scaleX, scaleY } = desc?.geoTransform || {}
  if (!desc || !scaleX || !scaleY) return null
  return valueAt(desc, Math.floor((x - originX) / scaleX), Math.floor((y - originY) / scaleY))
}

// Bilinear when all four neighbours are valid; else the nearest valid cell; else
// null. Returning null (rather than 0) is load-bearing — a nodata hole reported
// as an elevation of 0 is an error you only notice after it has poisoned a fit.
//
// opts.strict: no borrowing. A point whose own cell (the one containing it) is
// nodata or off the raster reads null, even when a neighbour has a height; a valid
// cell beside a hole reads its own value. For area statistics that must count a
// reference's holes and edges as unmeasured (DEM of difference volumes), where the
// nearest-valid fallback would invent a ring of heights around every hole.
export function sampleRaster(desc, x, y, { strict = false } = {}) {
  if (!desc) return null
  const { originX, originY, scaleX, scaleY } = desc.geoTransform || {}
  if (!scaleX || !scaleY) return null
  if (strict) {
    const own = valueAt(desc, Math.floor((x - originX) / scaleX), Math.floor((y - originY) / scaleY))
    if (own == null) return null
    const v = sampleRaster(desc, x, y)
    // Bilinear needs all four neighbours; otherwise the fallback may have picked a
    // neighbour's height, so keep the cell's own.
    return bilinearComplete(desc, x, y) ? v : own
  }

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

// Are all four bilinear neighbours of world (x, y) valid?
function bilinearComplete(desc, x, y) {
  const { originX, originY, scaleX, scaleY } = desc.geoTransform
  const c0 = Math.floor((x - originX) / scaleX - 0.5),
    r0 = Math.floor((y - originY) / scaleY - 0.5)
  return (
    valueAt(desc, c0, r0) != null &&
    valueAt(desc, c0 + 1, r0) != null &&
    valueAt(desc, c0, r0 + 1) != null &&
    valueAt(desc, c0 + 1, r0 + 1) != null
  )
}

/**
 * The GDAL_NODATA value as the band's own sample type stores it. The tag is ASCII
 * ("-9999.9", "-3.4e+38") and parses to a double, but a Float32 band holds the
 * nearest float32, which is a different number unless the value happens to be
 * representable (−9999.9 is not; neither is the 15-digit −3.40282346638529e+38 GDAL
 * writes for −FLT_MAX). Comparing the band's values with the double then never
 * matches and every nodata cell passes as an elevation. Float32 (and float16) round
 * it like the band does; doubles and integers are unchanged (a non-integer value
 * for an integer band matches nothing, as in GDAL).
 *   sampleFormat — TIFF SampleFormat (1 uint, 2 int, 3 float); bitsPerSample per band
 */
export function nodataForSampleType(nodata, sampleFormat = 1, bitsPerSample = 8) {
  if (nodata == null || !Number.isFinite(nodata)) return nodata ?? null
  if (sampleFormat === 3 && bitsPerSample === 32) return Math.fround(nodata)
  if (sampleFormat === 3 && bitsPerSample === 16) return f16round(nodata)
  return nodata
}

// Round to the nearest IEEE half (geotiff reads float16 bands as float32 values of
// halves). Math.f16round where the runtime has it.
function f16round(v) {
  if (typeof Math.f16round === 'function') return Math.f16round(v)
  if (v === 0 || !Number.isFinite(v)) return v
  const a = Math.abs(v)
  if (a >= 65520) return Math.sign(v) * Infinity
  // Spacing of halves at this magnitude: 2^(e−10), subnormals 2^−24.
  const e = Math.max(-14, Math.floor(Math.log2(a)))
  const q = 2 ** (e - 10)
  let r = a / q
  const f = Math.floor(r),
    d = r - f
  r = d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f // ties to even
  return Math.sign(v) * r * q
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

/**
 * The pixel-EDGE origin this module's conventions use, from GeoTIFF tags.
 * geotiff.js `getOrigin()` returns the tiepoint's model coordinates verbatim,
 * which is only the top-left edge when the tiepoint sits at raster (0,0) and the
 * file is PixelIsArea. Two other legal encodings shift every sample:
 *   - a tiepoint at raster (I, J) ≠ (0, 0) — move back by I·sx, J·sy;
 *   - GTRasterTypeGeoKey = 2 (PixelIsPoint) — the model coordinate names the
 *     CENTRE of pixel (I, J), so the edge is half a cell further back
 *     (GDAL's default reading; 15 m on a 30 m DEM if ignored).
 * `scaleY` is the signed north-up step (negative), as getResolution() returns it.
 */
export function edgeOriginFromTags({ tiepoint = null, origin, scaleX, scaleY, rasterType = 1 }) {
  let [x, y] = origin
  if (tiepoint?.length >= 6) {
    x = tiepoint[3] - tiepoint[0] * scaleX
    y = tiepoint[4] - tiepoint[1] * scaleY
  }
  if (rasterType === 2) {
    x -= 0.5 * scaleX
    y -= 0.5 * scaleY
  }
  return [x, y]
}
