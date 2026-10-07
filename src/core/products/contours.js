// Contour lines from a DEM height grid — pure, no Vue/Pinia/OPFS/DOM.
//
// Input is the app's DEM grid (dem.js): { width, height, data:Float32Array
// (row-major, row 0 = north), mask?:Uint8Array (1 = valid), gsd, originX,
// originY } with originX/originY the top-left CORNER of pixel (0,0). Samples
// sit at cell centres (`cellCenter`), so the marching-squares lattice is the
// grid of cell centres and a quad is four neighbouring centres. Coordinates come
// out in the grid's own frame — no CRS logic here (Scale & units: the caller
// knows what unit the frame is in).
//
// Marching squares, with three rules that make the output topologically clean:
//   - "Above" is `v >= level`. A level equal to a sample value then puts the
//     sample on one side consistently, so a contour touches that vertex once
//     instead of producing two coincident lines from both neighbours.
//   - Saddles (diagonal corners above) are resolved by the quad-centre mean:
//     centre above ⇒ the above corners connect through the middle and each
//     below corner is cut off by its own segment; centre below ⇒ the reverse.
//     Both segments of a saddle stay on opposite sides of the centre, so lines
//     of one level never cross.
//   - No contour enters a quad with any nodata corner (non-finite value or
//     mask 0). Lines therefore stop at the edge of a hole and stay open.
// Segments are joined by the lattice EDGE they cross, an exact integer id
// (horizontal edge (c,r)→(c+1,r) = 2·(r·W+c), vertical (c,r)→(c,r+1) =
// 2·(r·W+c)+1), never by float equality of endpoints. An edge is shared by at
// most two quads and a quad contributes at most one segment per edge, so every
// edge has degree ≤ 2 per level: chains start at degree-1 edges (open lines),
// and whatever remains is a set of closed rings.
//
// Work is O(Σ quads × levels crossing that quad): each quad's min/max selects
// the levels it can carry, so a fine interval on a mostly flat DEM stays cheap.

import { cellCenter } from './dem.js'
import { writeDxf } from './dxf.js'

export const MAX_CONTOUR_LEVELS = 10000

// Levels base + k·interval within [min, max] (inclusive), ascending.
// Throws when interval is not positive/finite or the count exceeds the cap.
export function contourLevels({ min, max }, { interval, base = 0 } = {}) {
  if (!(Number.isFinite(interval) && interval > 0)) throw new Error(`Contour interval must be a positive number (got ${interval})`)
  if (!Number.isFinite(base)) throw new Error(`Contour base must be finite (got ${base})`)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return []
  const kStart = Math.ceil((min - base) / interval)
  const kEnd = Math.floor((max - base) / interval)
  const count = kEnd - kStart + 1
  if (count > MAX_CONTOUR_LEVELS) {
    throw new Error(`Contour interval ${interval} gives ${count} levels over ${min}…${max} (limit ${MAX_CONTOUR_LEVELS}); use a larger interval`)
  }
  const levels = []
  for (let k = kStart; k <= kEnd; k++) {
    const L = base + k * interval
    if (L >= min && L <= max) levels.push(L)
  }
  return levels
}

// Is `level` an index contour (every indexEvery-th level counted from base)?
function isIndexLevel(level, base, interval, indexEvery) {
  if (!(indexEvery > 0)) return false
  const k = Math.round((level - base) / interval)
  const n = Math.round(indexEvery)
  return ((k % n) + n) % n === 0
}

function lineLength(pts, closed) {
  const n = pts.length / 2
  let len = 0
  for (let i = 1; i < n; i++) len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1])
  if (closed && n > 1) len += Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1])
  return len
}

// [1/4, 1/2, 1/4] moving average, `iterations` times. Open lines keep their
// endpoints (they lie on a nodata/grid edge); closed rings wrap. Vertex count
// is unchanged. Strong smoothing shrinks rings slightly toward their centroid.
function smoothLine(pts, closed, iterations) {
  const n = pts.length / 2
  if (n < 3 || !(iterations > 0)) return pts
  let src = pts
  for (let it = 0; it < iterations; it++) {
    const dst = new Float64Array(src.length)
    for (let i = 0; i < n; i++) {
      let p = i - 1, q = i + 1
      if (!closed && (i === 0 || i === n - 1)) { dst[2 * i] = src[2 * i]; dst[2 * i + 1] = src[2 * i + 1]; continue }
      if (p < 0) p = n - 1
      if (q >= n) q = 0
      dst[2 * i] = 0.25 * src[2 * p] + 0.5 * src[2 * i] + 0.25 * src[2 * q]
      dst[2 * i + 1] = 0.25 * src[2 * p + 1] + 0.5 * src[2 * i + 1] + 0.25 * src[2 * q + 1]
    }
    src = dst
  }
  return src
}

// Trace contours.
//   opts: interval (required, grid z units), base = 0, indexEvery = 5 (0 ⇒ no
//         index lines), minLength = 0 (world units; shorter lines dropped),
//         smooth = 0 (moving-average iterations)
// Returns { levels, lines: [{ level, index, points: Float64Array (x,y pairs),
//           closed }] }. A closed ring does NOT repeat its first vertex.
export function traceContours(grid, opts = {}, onLog) {
  const { interval, base = 0, indexEvery = 5, minLength = 0, smooth = 0 } = opts
  const { width: W, height: H, data, mask } = grid
  const valid = (i) => Number.isFinite(data[i]) && (!mask || mask[i] !== 0)

  let min = Infinity, max = -Infinity, nValid = 0
  for (let i = 0; i < W * H; i++) {
    if (!valid(i)) continue
    const v = data[i]
    if (v < min) min = v
    if (v > max) max = v
    nValid++
  }
  // Validate the interval even on an empty grid (a bad request is still bad).
  const levels = contourLevels(nValid ? { min, max } : { min: 0, max: 0 }, { interval, base })
  if (!nValid || W < 2 || H < 2) {
    onLog?.('Contours: no valid DEM samples to contour', 'warn', 'Products')
    return { levels: nValid ? levels : [], lines: [] }
  }

  // Per level: flat list of segments as edge-id pairs.
  const segs = levels.map(() => [])
  const firstAbove = (v) => { // first level index with levels[k] > v
    let lo = 0, hi = levels.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (levels[m] > v) hi = m; else lo = m + 1 }
    return lo
  }
  const val = new Float64Array(4)
  const above = [false, false, false, false]
  const edge = [0, 0, 0, 0] // top, right, bottom, left
  let skippedQuads = 0, saddles = 0
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const i0 = r * W + c, i1 = i0 + 1, i2 = i0 + W + 1, i3 = i0 + W
      if (!valid(i0) || !valid(i1) || !valid(i2) || !valid(i3)) { skippedQuads++; continue }
      val[0] = data[i0]; val[1] = data[i1]; val[2] = data[i2]; val[3] = data[i3]
      let qMin = val[0], qMax = val[0]
      for (let k = 1; k < 4; k++) { if (val[k] < qMin) qMin = val[k]; if (val[k] > qMax) qMax = val[k] }
      if (qMin === qMax) continue
      edge[0] = 2 * i0          // top    (c,r)→(c+1,r)
      edge[1] = 2 * i1 + 1      // right  (c+1,r)→(c+1,r+1)
      edge[2] = 2 * i3          // bottom (c,r+1)→(c+1,r+1)
      edge[3] = 2 * i0 + 1      // left   (c,r)→(c,r+1)
      // Levels with qMin < L ≤ qMax are the ones that split this quad.
      for (let li = firstAbove(qMin); li < levels.length && levels[li] <= qMax; li++) {
        const L = levels[li]
        let code = 0
        for (let k = 0; k < 4; k++) { above[k] = val[k] >= L; if (above[k]) code |= 1 << k }
        const out = segs[li]
        if (code === 0b0101 || code === 0b1010) {
          // Saddle. Corner k is bounded by edges k (clockwise side) and k-1.
          saddles++
          const centreAbove = (val[0] + val[1] + val[2] + val[3]) / 4 >= L
          for (let k = 0; k < 4; k++) {
            if (above[k] === centreAbove) continue // connected through centre
            out.push(edge[(k + 3) & 3], edge[k]) // cut off corner k
          }
          continue
        }
        // Exactly two crossed edges; edge e joins corners e and e+1.
        let a = -1, b = -1
        for (let e = 0; e < 4; e++) {
          if (above[e] !== above[(e + 1) & 3]) { if (a < 0) a = e; else b = e }
        }
        out.push(edge[a], edge[b])
      }
    }
  }

  // Crossing point of `level` on lattice edge `id`.
  const edgePoint = (id, level, dst, o) => {
    const i = id >> 1
    const c = i % W, r = (i - c) / W
    const j = (id & 1) ? i + W : i + 1
    const v0 = data[i], v1 = data[j]
    const t = (level - v0) / (v1 - v0)
    const [x0, y0] = cellCenter(grid, c, r)
    if (id & 1) { dst[o] = x0; dst[o + 1] = y0 - t * grid.gsd }
    else { dst[o] = x0 + t * grid.gsd; dst[o + 1] = y0 }
  }

  const lines = []
  let dropped = 0, degenerate = 0
  for (let li = 0; li < levels.length; li++) {
    const s = segs[li]
    const nSeg = s.length / 2
    if (!nSeg) continue
    const L = levels[li]
    // edge id → up to two segment indices.
    const adj = new Map()
    for (let k = 0; k < nSeg; k++) {
      for (const e of [s[2 * k], s[2 * k + 1]]) {
        const list = adj.get(e)
        if (list) list.push(k); else adj.set(e, [k])
      }
    }
    const used = new Uint8Array(nSeg)
    // Walk from edge `start` through segment `seg`; returns the edge sequence.
    const walk = (start, seg) => {
      const chain = [start]
      let cur = start
      while (seg >= 0) {
        used[seg] = 1
        const next = s[2 * seg] === cur ? s[2 * seg + 1] : s[2 * seg]
        chain.push(next)
        cur = next
        const list = adj.get(cur)
        seg = -1
        for (const k of list) if (!used[k]) { seg = k; break }
      }
      return chain
    }
    const emit = (chain, closed) => {
      const n = closed ? chain.length - 1 : chain.length // ring: last edge == first
      const raw = new Float64Array(n * 2)
      // A level equal to a sample puts crossings at t = 0, i.e. on the vertex
      // itself, for every edge leaving it: collapse those repeats, and drop a
      // line that collapses to nothing (a sample exactly at a local maximum).
      let m = 0
      for (let k = 0; k < n; k++) {
        edgePoint(chain[k], L, raw, 2 * m)
        if (m > 0 && raw[2 * m] === raw[2 * m - 2] && raw[2 * m + 1] === raw[2 * m - 1]) continue
        m++
      }
      if (closed && m > 1 && raw[0] === raw[2 * m - 2] && raw[1] === raw[2 * m - 1]) m--
      if (m < (closed ? 3 : 2)) { degenerate++; return }
      let pts = m === n ? raw : raw.slice(0, 2 * m)
      if (smooth > 0) pts = smoothLine(pts, closed, Math.round(smooth))
      if (minLength > 0 && lineLength(pts, closed) < minLength) { dropped++; return }
      lines.push({ level: L, index: isIndexLevel(L, base, interval, indexEvery), points: pts, closed })
    }
    // Open lines first: start at every degree-1 edge.
    for (const [e, list] of adj) {
      if (list.length === 1 && !used[list[0]]) emit(walk(e, list[0]), false)
    }
    // Remaining segments are closed rings.
    for (let k = 0; k < nSeg; k++) {
      if (used[k]) continue
      const chain = walk(s[2 * k], k)
      emit(chain, chain[chain.length - 1] === chain[0])
    }
  }

  const nClosed = lines.reduce((a, l) => a + (l.closed ? 1 : 0), 0)
  onLog?.(
    `Contours: ${lines.length} lines (${nClosed} closed) over ${levels.length} levels ` +
    `(interval ${interval}, base ${base}, z ${min.toFixed(3)}…${max.toFixed(3)}); ` +
    `${saddles} saddle cells, ${skippedQuads} nodata cells skipped` +
    (dropped ? `, ${dropped} shorter than ${minLength} dropped` : '') +
    (degenerate ? `, ${degenerate} zero-length (level on a sample) dropped` : '') +
    (smooth > 0 ? `, smoothed ×${Math.round(smooth)}` : ''),
    'info', 'Products')
  return { levels, lines }
}

// GeoJSON FeatureCollection of 2D LineStrings, elevation in properties.
// A closed ring repeats its first coordinate so it is geometrically closed.
export function contoursToGeoJSON(result, { crs, elevationProperty = 'elevation' } = {}) {
  const features = result.lines.map((line) => {
    const p = line.points
    const coords = []
    for (let k = 0; k < p.length; k += 2) coords.push([p[k], p[k + 1]])
    if (line.closed && coords.length) coords.push([coords[0][0], coords[0][1]])
    return {
      type: 'Feature',
      properties: { [elevationProperty]: line.level, index: line.index },
      geometry: { type: 'LineString', coordinates: coords },
    }
  })
  const fc = { type: 'FeatureCollection', features }
  if (crs) fc.crs = { type: 'name', properties: { name: String(crs) } }
  return fc
}

// DXF (R12): one 2D POLYLINE per line at its elevation, on CONTOUR or
// CONTOUR_INDEX.
export function contoursToDxf(result, opts = {}) {
  const polylines = result.lines.map((line) => {
    const p = line.points
    const points = []
    for (let k = 0; k < p.length; k += 2) points.push([p[k], p[k + 1]])
    return { layer: line.index ? 'CONTOUR_INDEX' : 'CONTOUR', points, closed: line.closed, elevation: line.level }
  })
  return writeDxf({
    layers: [{ name: 'CONTOUR', color: 8 }, { name: 'CONTOUR_INDEX', color: 7 }],
    polylines,
  }, opts)
}
