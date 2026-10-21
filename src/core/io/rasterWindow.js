// Validate an explicit bounded read before a decoder allocates output planes.
export function rasterWindow(meta, rect = {}, maxDim = 2048, bands = [0]) {
  if (!Number.isInteger(maxDim) || maxDim < 1 || maxDim > 4096)
    throw new Error('Raster reads require maxDim between 1 and 4096')
  if (!bands.length || bands.length > 8 || bands.some((b) => !Number.isInteger(b) || b < 0 || b >= meta.bands))
    throw new Error('Invalid raster bands')
  const col = rect.col ?? 0,
    row = rect.row ?? 0,
    width = rect.width ?? meta.width,
    height = rect.height ?? meta.height
  if (![col, row, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error('Invalid raster window')
  const x0 = Math.max(0, Math.floor(col)),
    y0 = Math.max(0, Math.floor(row))
  const x1 = Math.min(meta.width, Math.ceil(col + width)),
    y1 = Math.min(meta.height, Math.ceil(row + height))
  if (x1 <= x0 || y1 <= y0) throw new Error('Raster window is outside the image')
  const scale = Math.min(1, maxDim / Math.max(x1 - x0, y1 - y0))
  const w = Math.max(1, Math.round((x1 - x0) * scale)),
    h = Math.max(1, Math.round((y1 - y0) * scale))
  if (w * h * bands.length > 16 * 1024 ** 2) throw new Error('Raster window exceeds the sample budget')
  return {
    window: [x0, y0, x1, y1],
    width: w,
    height: h,
    col: x0,
    row: y0,
    scaleX: (x1 - x0) / w,
    scaleY: (y1 - y0) / h,
  }
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
  return [
    (layout.centreX0 ?? layout.col + 0.5) + x * layout.scaleX,
    (layout.centreY0 ?? layout.row + 0.5) + y * layout.scaleY,
  ]
}

// Native pixels per pixel of a reduced-resolution level. Overviews are halvings
// (ours floor the size, GDAL's ceil it), so a ratio within 2 % of a power of two
// is that power: W / levelW itself drifts by up to a native pixel across the image.
export function levelFactor(full, level) {
  return [full.width / level.width, full.height / level.height].map((f) => {
    const p = 2 ** Math.round(Math.log2(f))
    return Math.abs(f / p - 1) < 0.02 ? p : f
  })
}

/**
 * The coarsest level (index into `levels`, full resolution first) that still has
 * at least the sampling a downsampled read asks for, and the read re-expressed on
 * it: `levelWindow` in that level's pixels, the per-axis native pixels per working
 * sample, and the native pixel-edge position of working sample 0's centre (a level
 * pixel k covers native [k·f, (k+1)·f), so its centre is f·(k + ½)). Reading a
 * 1536-px look at a 30k-px COG from its overview decodes ~1/400 of the pixels.
 */
export function overviewLayout(layout, levels) {
  const full = levels[0]
  let best = 0
  for (let i = 1; i < levels.length; i++) {
    const [fx, fy] = levelFactor(full, levels[i])
    if (fx <= layout.scaleX * 1.0001 && fy <= layout.scaleY * 1.0001) best = i
  }
  if (best === 0) return { ...layout, level: 0, levelWindow: layout.window }
  const [fx, fy] = levelFactor(full, levels[best]),
    [x0, y0, x1, y1] = layout.window
  const ox0 = Math.floor(x0 / fx),
    oy0 = Math.floor(y0 / fy)
  const ox1 = Math.max(ox0 + 1, Math.min(levels[best].width, Math.ceil(x1 / fx)))
  const oy1 = Math.max(oy0 + 1, Math.min(levels[best].height, Math.ceil(y1 / fy)))
  return {
    ...layout,
    level: best,
    levelWindow: [ox0, oy0, ox1, oy1],
    scaleX: (fx * (ox1 - ox0)) / layout.width,
    scaleY: (fy * (oy1 - oy0)) / layout.height,
    centreX0: fx * (ox0 + 0.5),
    centreY0: fy * (oy0 + 0.5),
  }
}
