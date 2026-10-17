// Pure top-down coverage/overlap binning for the Quality Report ▸ Coverage section
// (PLAN-eval-quality-hub WS4). Answers "where is my survey thin" — bins tie points
// into an XY grid and reports, per cell, the point count and the MAX view count
// (how many images see that patch of ground; 2 = bare minimum, ≥3 comfortable).
//
// No Vue/Pinia/DOM. Points + camera centres in a chosen 2D frame (the caller picks
// SfM or the local-vertical georef frame and passes already-projected x,y), plain
// typed-array grid out — the section paints it to a canvas.

// points: SparsePoints (x, y are the planar coords; viewCount the views). cams: [{ x, y }] camera centres (same frame). opts:
//   { targetCells = 60 } — approx number of cells along the longer axis.
// → { cols, rows, cellSize, minX, minY, count:Uint32Array, maxViews:Uint16Array,
//     maxCount, cams:[{x,y}], bbox:{minX,minY,maxX,maxY} }
// count[r*cols+c] = tie points in the cell; maxViews = largest view count seen there.
export function coverageGrid(points, cams = [], opts = {}) {
  const targetCells = opts.targetCells || 60
  const pts = points
  if (!pts?.length) {
    return {
      cols: 0, rows: 0, cellSize: 0, minX: 0, minY: 0,
      count: new Uint32Array(0), maxViews: new Uint16Array(0),
      maxCount: 0, cams: cams.map((c) => ({ x: c.x, y: c.y })),
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const x = pts.x(i), y = pts.y(i)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const spanX = Math.max(1e-9, maxX - minX)
  const spanY = Math.max(1e-9, maxY - minY)
  const cellSize = Math.max(spanX, spanY) / targetCells
  const cols = Math.max(1, Math.ceil(spanX / cellSize))
  const rows = Math.max(1, Math.ceil(spanY / cellSize))

  const count = new Uint32Array(cols * rows)
  const maxViews = new Uint16Array(cols * rows)
  let maxCount = 0
  for (let i = 0; i < n; i++) {
    const c = Math.min(cols - 1, Math.floor((pts.x(i) - minX) / cellSize))
    const r = Math.min(rows - 1, Math.floor((pts.y(i) - minY) / cellSize))
    const idx = r * cols + c
    count[idx]++
    if (count[idx] > maxCount) maxCount = count[idx]
    const v = pts.viewCount(i)
    if (v > maxViews[idx]) maxViews[idx] = v
  }

  return {
    cols, rows, cellSize, minX, minY, count, maxViews, maxCount,
    cams: cams.map((c) => ({ x: c.x, y: c.y })),
    bbox: { minX, minY, maxX, maxY },
  }
}
