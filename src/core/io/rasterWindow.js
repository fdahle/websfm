// Validate an explicit bounded read before a decoder allocates output planes.
export function rasterWindow(meta, rect = {}, maxDim = 2048, bands = [0]) {
  if (!Number.isInteger(maxDim) || maxDim < 1 || maxDim > 4096) throw new Error('Raster reads require maxDim between 1 and 4096')
  if (!bands.length || bands.length > 8 || bands.some(b => !Number.isInteger(b) || b < 0 || b >= meta.bands)) throw new Error('Invalid raster bands')
  const col = rect.col ?? 0, row = rect.row ?? 0, width = rect.width ?? meta.width, height = rect.height ?? meta.height
  if (![col, row, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid raster window')
  const x0 = Math.max(0, Math.floor(col)), y0 = Math.max(0, Math.floor(row))
  const x1 = Math.min(meta.width, Math.ceil(col + width)), y1 = Math.min(meta.height, Math.ceil(row + height))
  if (x1 <= x0 || y1 <= y0) throw new Error('Raster window is outside the image')
  const scale = Math.min(1, maxDim / Math.max(x1 - x0, y1 - y0))
  const w = Math.max(1, Math.round((x1 - x0) * scale)), h = Math.max(1, Math.round((y1 - y0) * scale))
  if (w * h * bands.length > 16 * 1024 ** 2) throw new Error('Raster window exceeds the sample budget')
  return { window: [x0, y0, x1, y1], width: w, height: h, col: x0, row: y0, scaleX: (x1 - x0) / w, scaleY: (y1 - y0) / h }
}

/**
 * Native pixel-edge coordinates of a point given in a window's WORKING samples
 * (sample-centre convention, index 0 = first sample's centre — what SIFT reports).
 *
 * The read is geotiff's nearest resampling, which takes working sample j from
 * native pixel round(j·scale) — so sample j's centre sits at j·scale + 0.5 in
 * native pixel-edge coordinates, NOT at (j + 0.5)·scale as an area-averaged
 * resize would place it. Using the area convention shifts every point by
 * (scale − 1)/2 native pixels toward the raster origin: ~31 m on a 10 m
 * Sentinel-2 tile read at 1536 px.
 */
export function windowToNative(layout, x, y) {
  return [layout.col + x * layout.scaleX + 0.5, layout.row + y * layout.scaleY + 0.5]
}
