// The largest single ArrayBuffer the browser hands out. Chrome 155 (Linux, page and
// workers alike) refuses any buffer past 2³¹ − 2 MiB = 2,145,386,496 bytes with "Array
// buffer allocation failed", however much memory is free (bisected 2026-10-17). It is
// a per-buffer wall, not a budget: a cloud's positions as Float64 xyz fit up to ≈ 89 M
// points, as Float32 up to ≈ 179 M. Code that would build one larger buffer must split
// it, read a level-of-detail octree instead, or refuse with this explanation.
export const MAX_BUFFER_BYTES = 2 ** 31 - 2 ** 21

export const MAX_FLOAT64_XYZ_POINTS = Math.floor(MAX_BUFFER_BYTES / 24)

/** The engine refusing a buffer (V8: RangeError "Array buffer allocation failed" / "Invalid array length"). */
export const isBufferAllocationFailure = (err) => err instanceof RangeError
  && /array buffer allocation failed|invalid array buffer length|invalid typed array length|invalid array length/i.test(err.message ?? '')

/** The user-facing reason, for `what` (e.g. "this cloud") holding `points` points. */
export function tooManyPointsMessage(what, points = null) {
  return `${what}${points ? ` (${points.toLocaleString()} points)` : ''} is too large to hold at once: the browser `
    + `caps one buffer at 2 GiB, about ${Math.floor(MAX_FLOAT64_XYZ_POINTS / 1e6)} million points at full precision.`
}

/** The user-facing refusal for a raster whose full plane (`bytesPerCell` per cell) would
 *  not fit in one buffer: what it would need, and what to import instead. */
export function rasterTooLargeMessage(name, width, height, bytesPerCell = 4) {
  const gb = (width * height * bytesPerCell) / 1e9
  const side = Math.floor(Math.sqrt(MAX_BUFFER_BYTES / bytesPerCell))
  return `${name} is ${width.toLocaleString()} × ${height.toLocaleString()} cells: its full-resolution plane needs `
    + `${gb.toFixed(2)} GB in one buffer, and the browser caps one buffer at 2 GiB (about ${side.toLocaleString()} × `
    + `${side.toLocaleString()} cells). Import a coarser or cropped copy, e.g. gdal_translate -tr with twice the cell `
    + 'size, or -projwin around your area.'
}
