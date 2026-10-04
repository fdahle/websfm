// Screen-space point selection for the 3D viewer's rectangle / lasso tool. Pure:
// plain typed arrays + a 4×4 matrix in, a Uint8Array mask out. No three.js, so the
// same function can run on the main thread (live highlight) or in a worker.
//
// Contract:
//   - `matrix` is a 16-element COLUMN-MAJOR clip-from-buffer transform (three.js
//     `Matrix4.elements` of projection · view · model), applied to the positions
//     exactly as they sit in `pos`. The viewer passes its Float32 render buffer and
//     the matrix that draws it, so what is highlighted is precisely what was drawn —
//     re-deriving the selection from the Float64 source in another frame would
//     disagree with the screen for points on the shape's edge.
//   - Shapes live in NDC (x right, y up, both −1…1). The caller converts pointer
//     pixels once; nothing here knows the canvas size.
//   - Selection goes THROUGH the cloud: there is no occlusion test, so a point
//     hidden behind a surface is selected too (CloudCompare's segment tool works the
//     same way). Points outside the clip volume are never selected: behind the
//     camera (w ≤ 0), or nearer/farther than the near/far planes (|z_clip| > w) —
//     the GPU clips those away, and a near-clip slice into a cloud must not let a
//     lasso delete the invisible foreground it cut off.
//   - `indices` (optional) restricts candidates to the points actually drawn — a
//     style that hides classes draws through an index buffer, and a point the user
//     cannot see must not be deletable by a lasso around empty screen.
//
// Dense-scale: one pass, no per-point allocation, no spread of per-point arrays.

/** Even-odd point-in-polygon. `poly` is a flat [x0,y0,x1,y1,…] array. */
export function pointInPolygon(x, y, poly) {
  let inside = false
  const n = poly.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1]
    const xj = poly[j * 2], yj = poly[j * 2 + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Compile `poly` into an even-odd test that gives exactly `pointInPolygon`'s
 * answer at a fraction of the cost. A freehand lasso gains a vertex every few
 * pixels (~1,500 for a full-screen loop), and walking every edge for every one of
 * millions of points froze the UI for seconds. Between two consecutive distinct
 * vertex heights the set of edges a horizontal ray can cross is fixed, so the
 * edges are bucketed once per band (CSR) and a point only tests its own band's
 * few edges — with the same half-open `(yi > y) !== (yj > y)` rule and the same
 * crossing expression, so the result is bit-identical, not an approximation.
 */
export function bandedPolygonTest(poly) {
  const n = poly.length >> 1
  const ys = Float64Array.from({ length: n }, (_, i) => poly[i * 2 + 1]).sort()
  let m = 0
  for (let i = 0; i < n; i++) if (i === 0 || ys[i] !== ys[m - 1]) ys[m++] = ys[i]
  const bands = Math.max(0, m - 1) // band k covers [ys[k], ys[k+1])
  // First index whose height is ≥ v (v is always one of the distinct heights here).
  const lower = (v) => {
    let lo = 0, hi = m
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ys[mid] < v) lo = mid + 1; else hi = mid }
    return lo
  }
  const span = new Int32Array(n * 2) // per edge: [firstBand, endBand)
  const counts = new Int32Array(bands + 1)
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = poly[i * 2 + 1], yj = poly[j * 2 + 1]
    if (yi === yj) continue // a horizontal edge never satisfies the crossing rule
    const a = lower(Math.min(yi, yj)), b = lower(Math.max(yi, yj))
    span[i * 2] = a; span[i * 2 + 1] = b
    for (let k = a; k < b; k++) counts[k + 1]++
  }
  for (let k = 0; k < bands; k++) counts[k + 1] += counts[k]
  const edges = new Int32Array(counts[bands])
  const fill = counts.slice(0, bands)
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (poly[i * 2 + 1] === poly[j * 2 + 1]) continue
    for (let k = span[i * 2]; k < span[i * 2 + 1]; k++) edges[fill[k]++] = i
  }
  return (x, y) => {
    // Band containing y: the last k with ys[k] ≤ y. Outside [ys[0], ys[m-1]) no
    // edge satisfies the half-open rule, exactly as in the full walk.
    let lo = 0, hi = m
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ys[mid] <= y) lo = mid + 1; else hi = mid }
    const k = lo - 1
    if (k < 0 || k >= bands) return false
    let inside = false
    for (let e = counts[k]; e < counts[k + 1]; e++) {
      const i = edges[e], j = i === 0 ? n - 1 : i - 1
      const xi = poly[i * 2], yi = poly[i * 2 + 1]
      const xj = poly[j * 2], yj = poly[j * 2 + 1]
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

// Normalise a shape to { test(x,y), minX, maxX, minY, maxY } with a bbox for a cheap
// reject before the polygon walk. Returns null for a degenerate shape.
function compileShape(shape) {
  if (shape?.kind === 'rect') {
    const minX = Math.min(shape.x0, shape.x1), maxX = Math.max(shape.x0, shape.x1)
    const minY = Math.min(shape.y0, shape.y1), maxY = Math.max(shape.y0, shape.y1)
    if (!(maxX > minX && maxY > minY)) return null
    return { minX, maxX, minY, maxY, test: () => true }
  }
  if (shape?.kind === 'lasso') {
    const poly = shape.points
    if (!poly || poly.length < 6) return null
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] < minX) minX = poly[i]; if (poly[i] > maxX) maxX = poly[i]
      if (poly[i + 1] < minY) minY = poly[i + 1]; if (poly[i + 1] > maxY) maxY = poly[i + 1]
    }
    if (!(maxX > minX && maxY > minY)) return null
    return { minX, maxX, minY, maxY, test: bandedPolygonTest(poly) }
  }
  return null
}

/**
 * Select the points whose projection falls inside `shape`, combined with an
 * existing mask by `op`:
 *   'replace'  → only the new hits
 *   'add'      → base ∪ hits
 *   'subtract' → base \ hits
 * Returns { mask: Uint8Array(count), selected } — `selected` is the popcount, so
 * callers never recount a multi-million mask.
 */
export function screenSelectMask(pos, count, { matrix, shape, indices = null, base = null, op = 'replace' } = {}) {
  const mask = op !== 'replace' && base?.length === count ? base.slice() : new Uint8Array(count)
  let selected = 0
  if (op !== 'replace' && base?.length === count) for (let i = 0; i < count; i++) selected += mask[i]
  const s = compileShape(shape)
  if (!s || !matrix || matrix.length !== 16) return { mask, selected }
  const m = matrix
  const setTo = op === 'subtract' ? 0 : 1
  const visit = (i) => {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    const w = m[3] * x + m[7] * y + m[11] * z + m[15]
    if (!(w > 0)) return
    const zc = m[2] * x + m[6] * y + m[10] * z + m[14]
    if (zc < -w || zc > w) return
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w
    if (nx < s.minX || nx > s.maxX) return
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
    if (ny < s.minY || ny > s.maxY) return
    if (!s.test(nx, ny)) return
    if (mask[i] !== setTo) { mask[i] = setTo; selected += setTo ? 1 : -1 }
  }
  if (indices) for (let k = 0; k < indices.length; k++) { if (indices[k] < count) visit(indices[k]) }
  else for (let i = 0; i < count; i++) visit(i)
  return { mask, selected }
}

/** Indices of the set entries of a mask (for drawing a highlight overlay). */
export function maskIndices(mask, selected) {
  const out = new Uint32Array(selected)
  let o = 0
  for (let i = 0; i < mask.length && o < selected; i++) if (mask[i]) out[o++] = i
  return out
}
