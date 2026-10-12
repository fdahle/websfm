// The ONE "which raster cells are inside this polygon" rule, shared by the volume
// measurement (measure.js polygonVolume) and raster clipping (rasterClip.js), so a
// clip to a measured polygon covers exactly the cells the volume counted.
//
// Pixel space: cell (c, r) covers [c, c+1) × [r, r+1) and is inside when its
// CENTRE (c+½, r+½) is. Scanline fill with the even-odd rule over the rings (an
// outer ring and its holes together). Half-open in both axes: a centre exactly on
// an edge is inside on the left/top edge and outside on the right/bottom one, so
// two polygons sharing an edge claim each cell exactly once, and a shared vertex
// is crossed once. Cost O(cells + edges·rows), never O(cells·edges).
//
// rings: [[[col, row], …], …] in pixel coordinates.
// onSpan(r, c0, c1): every inside run of row r, c0..c1 inclusive.
// bounds { width, height } clamps the spans to the raster; without it spans may
// lie off the raster (the volume counts those as unmeasured, lowering coverage).

export function polygonSpans(rings, onSpan, bounds = null) {
  let minRow = Infinity, maxRow = -Infinity
  for (const ring of rings) for (const p of ring) {
    if (p[1] < minRow) minRow = p[1]
    if (p[1] > maxRow) maxRow = p[1]
  }
  if (!(maxRow > minRow)) return
  let r0 = Math.ceil(minRow - 0.5)
  let r1 = Math.ceil(maxRow - 0.5) - 1
  if (bounds) { r0 = Math.max(0, r0); r1 = Math.min(bounds.height - 1, r1) }
  if (r1 < r0) return
  const rows = new Array(r1 - r0 + 1)
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i]
      if (a[1] === b[1]) continue // horizontal: never crosses a centre line
      const lo = a[1] < b[1] ? a : b, hi = a[1] < b[1] ? b : a
      // Centre lines yc = r + ½ with lo.y ≤ yc < hi.y.
      const ra = Math.max(r0, Math.ceil(lo[1] - 0.5))
      const rb = Math.min(r1, Math.ceil(hi[1] - 0.5) - 1)
      const dxdy = (hi[0] - lo[0]) / (hi[1] - lo[1])
      for (let r = ra; r <= rb; r++) {
        const x = lo[0] + (r + 0.5 - lo[1]) * dxdy
        const k = r - r0
        if (rows[k]) rows[k].push(x); else rows[k] = [x]
      }
    }
  }
  const cMax = bounds ? bounds.width - 1 : Infinity
  for (let k = 0; k < rows.length; k++) {
    const xs = rows[k]
    if (!xs) continue
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Centres c+½ in [xs[i], xs[i+1]).
      let c0 = Math.ceil(xs[i] - 0.5)
      const c1 = Math.min(cMax, Math.ceil(xs[i + 1] - 0.5) - 1)
      if (bounds) c0 = Math.max(0, c0)
      if (c1 >= c0) onSpan(r0 + k, c0, c1)
    }
  }
}
