// The largest single ArrayBuffer the browser hands out. Chrome 155 (Linux, page and
// workers alike) refuses any buffer past 2³¹ − 2 MiB = 2,145,386,496 bytes with "Array
// buffer allocation failed", however much memory is free (bisected 2026-10-17). It is
// a per-buffer wall, not a budget: a cloud's positions as Float64 xyz fit up to ≈ 89 M
// points, as Float32 up to ≈ 179 M. Code that would build one larger buffer must split
// it, read a level-of-detail octree instead, or refuse with this explanation.
export const MAX_BUFFER_BYTES = 2 ** 31 - 2 ** 21

export const MAX_FLOAT64_XYZ_POINTS = Math.floor(MAX_BUFFER_BYTES / 24)

// The total the same process may hold in ArrayBuffers: 16 GiB, one pool shared by the
// page and every worker of the tab (Chrome 155, Linux, 61 GB RAM, measured 2026-10-20:
// the page got 15 × 1 GiB, a worker 9 more while the page held 6). WebAssembly memories
// are not drawn from it. Past it every allocation fails with the same RangeError.
export const TAB_BUFFER_POOL_BYTES = 16 * 2 ** 30

/** The engine refusing a buffer (V8: RangeError "Array buffer allocation failed" / "Invalid array length"). */
export const isBufferAllocationFailure = (err) => err instanceof RangeError
  && /array buffer allocation failed|invalid array buffer length|invalid typed array length|invalid array length/i.test(err.message ?? '')

// The same failure as it reaches the page: a worker's error crosses as its message only.
const POOL_REFUSED = /array buffer allocation failed|invalid (typed )?array (buffer )?length/i
// A Blob/File read (a saved depth map, a GeoTIFF) on a full pool fails with Chrome's
// NotReadableError, whose message blames file permissions instead (probed 2026-10-20:
// both an OPFS File and an in-memory Blob, the pool filled to its last MiB).
const READ_REFUSED = /requested file could not be read/i

/** A compute error's message, with the reason and `remedy` appended when the browser
 *  refused memory (directly, or as a file read that could not get its buffer). */
export function bufferFailureText(message, remedy) {
  const msg = String(message ?? '')
  const onRead = READ_REFUSED.test(msg)
  if (!onRead && !POOL_REFUSED.test(msg)) return msg
  return `${msg} — ${onRead ? 'almost certainly not a permission problem: ' : ''}the browser tab ran out of `
    + `buffer memory (it holds 16 GB for the page and all its workers, one buffer at most 2 GB). ${remedy}`
}

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
