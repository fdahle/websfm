// F13 — the reference DEM a reconstruction is held to (demAnchors.js), as a plain grid
// of heights the compute worker can sample. The reference itself (a raster in its own
// CRS and vertical datum, a stable-ground layer) lives on the main thread; the solve
// works in the run's survey frame (cameraPriors.js surveyFrameFor). So the main thread
// samples it once, on a regular grid over where the block can be, in the survey frame,
// with the places that are not stable ground left NaN, and the worker reads that grid.
// Pure: an extent and a sampler in, a grid out.
//
// grid = { x0, y0, dx, dy, w, h, z: Float32Array(w·h) }: z[j·w + i] is the height at
// (x0 + i·dx, y0 + j·dy), NaN where there is none.

// The area to sample: the box around the places the run knows (camera positions, GCPs,
// in the survey frame), grown by half its size and at least `minMargin` on every side,
// since the ground a camera sees reaches past the camera positions.
export function demHoldExtent(places, { minMargin = 50 } = {}) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const p of places) {
    if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) continue
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  if (!(x1 >= x0 && y1 >= y0)) return null
  const m = Math.max(minMargin, 0.5 * Math.max(x1 - x0, y1 - y0))
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }
}

// Sample `sample(x, y)` (a height or NaN) at most `maxSide` × `maxSide` places, on
// square cells over `extent`.
export function buildDemHoldGrid(extent, sample, { maxSide = 400 } = {}) {
  const spanX = extent.x1 - extent.x0,
    spanY = extent.y1 - extent.y0
  const cell = Math.max(spanX, spanY) / (maxSide - 1) || 1
  const w = Math.max(2, Math.ceil(spanX / cell) + 1),
    h = Math.max(2, Math.ceil(spanY / cell) + 1)
  const z = new Float32Array(w * h)
  let valid = 0
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const v = sample(extent.x0 + i * cell, extent.y0 + j * cell)
      const ok = v != null && Number.isFinite(v)
      z[j * w + i] = ok ? v : NaN
      if (ok) valid++
    }
  return { x0: extent.x0, y0: extent.y0, dx: cell, dy: cell, w, h, z, valid }
}

// (x, y) → the grid's height there, bilinear; NaN outside it or next to a hole (a
// stable-ground edge or the reference's edge is not blended with what lies beyond).
export function demHoldSampler(grid) {
  const { x0, y0, dx, dy, w, h, z } = grid
  return (x, y) => {
    const fx = (x - x0) / dx,
      fy = (y - y0) / dy
    if (!(fx >= 0 && fy >= 0 && fx <= w - 1 && fy <= h - 1)) return NaN
    const i = Math.min(w - 2, Math.floor(fx)),
      j = Math.min(h - 2, Math.floor(fy))
    const tx = fx - i,
      ty = fy - j
    const a = z[j * w + i],
      b = z[j * w + i + 1],
      c = z[(j + 1) * w + i],
      d = z[(j + 1) * w + i + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
}
