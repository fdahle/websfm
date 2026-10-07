// Clip a DEM or orthophoto to polygon(s) — pure, no Vue/Pinia/OPFS/DOM.
//
// Polygons arrive in WORLD coordinates of the raster's own frame (the caller
// reprojects GeoJSON from its source CRS first — like core/io/geojson.js, this
// module is CRS-agnostic). They are moved into pixel space once:
//
//   col = (x − originX) / gsd        row = (originY − y) / gsd
//
// so pixel (c, r) covers [c, c+1) × [r, r+1) and its centre sits at (c+½, r+½).
//
// Inside test. A pixel is inside when its CENTRE is (the same rule as
// measure.js polygonVolume), by a scanline fill with the even-odd rule over one
// polygon's rings — outer ring and holes together, so a hole subtracts whatever
// its winding. Separate polygons (a MultiPolygon, a FeatureCollection) are
// UNIONED, not even-odd'ed against each other, so two overlapping fields do not
// cancel. A centre exactly on an edge counts inside on the left/top edge and
// outside on the right/bottom one, so two polygons sharing an edge claim each
// pixel exactly once. Cost: each edge contributes one crossing per scanline it
// spans, then each row fills its spans — O(pixels + edges·rows), never
// O(pixels·edges).
//
// allTouched additionally sets every pixel whose open interior the boundary
// passes through (GDAL's ALL_TOUCHED, minus its habit of also taking the
// outside neighbour of an edge lying exactly on a pixel boundary — such a pixel
// shares only a line with the polygon, zero area).

const SNAP = 1e-9
// World→pixel arithmetic leaves 2.9999999997 where the user drew 3; snap so a
// boundary drawn on a pixel edge stays on it (matters only for allTouched).
const snap = (v) => { const r = Math.round(v); return Math.abs(v - r) < SNAP ? r : v }

function isVertex(v) {
  return (Array.isArray(v) && typeof v[0] === 'number')
    || (v != null && typeof v === 'object' && !Array.isArray(v) && typeof v.x === 'number' && typeof v.y === 'number')
}

// → [[x, y], …] with finite numbers, the GeoJSON closing vertex dropped, or null
// when fewer than 3 distinct vertices remain.
function cleanRing(ring) {
  if (!Array.isArray(ring)) return null
  const out = []
  for (const v of ring) {
    if (!isVertex(v)) continue
    const x = Array.isArray(v) ? v[0] : v.x
    const y = Array.isArray(v) ? v[1] : v.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const prev = out[out.length - 1]
    if (prev && prev[0] === x && prev[1] === y) continue
    out.push([x, y])
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
  return out.length >= 3 ? out : null
}

// One polygon (array of rings) → cleaned rings, or null if its outer ring is
// unusable. Degenerate holes are dropped; a degenerate outer drops the polygon.
function cleanPolygon(rings) {
  const outer = cleanRing(rings[0])
  if (!outer) return null
  const out = [outer]
  for (let i = 1; i < rings.length; i++) {
    const hole = cleanRing(rings[i])
    if (hole) out.push(hole)
  }
  return out
}

/**
 * Normalise any accepted polygon input to `[[outerRing, ...holes], …]`, each
 * ring `[[x, y], …]` (not closed). Accepts: a ring ([x,y] or {x,y} vertices),
 * a polygon (array of rings), an array of polygons (bare rings allowed as
 * elements), or a GeoJSON Geometry/Feature/FeatureCollection.
 */
export function normalizePolygons(input) {
  if (input == null) return []
  if (!Array.isArray(input)) return typeof input === 'object' && input.type ? polygonsFromGeoJSON(input).polygons : []
  if (!input.length) return []
  if (isVertex(input[0])) return [cleanPolygon([input])].filter(Boolean)
  if (Array.isArray(input[0]) && isVertex(input[0][0])) return [cleanPolygon(input)].filter(Boolean)
  const out = []
  for (const el of input) {
    if (el && !Array.isArray(el) && el.type) { for (const p of polygonsFromGeoJSON(el).polygons) out.push(p) }
    else if (Array.isArray(el) && el.length) {
      const p = isVertex(el[0]) ? cleanPolygon([el]) : cleanPolygon(el)
      if (p) out.push(p)
    }
  }
  return out
}

/**
 * Polygons out of a GeoJSON FeatureCollection / Feature / GeometryCollection /
 * Polygon / MultiPolygon. Any other geometry (points, lines, null geometry) is
 * skipped and counted in `ignored`, so the caller can say "2 non-polygon
 * features ignored" instead of silently clipping to less than the file holds.
 * Coordinates are returned verbatim (file CRS); reprojecting is the caller's.
 * → { polygons: [[outer, ...holes], …], ignored }
 */
export function polygonsFromGeoJSON(geojson) {
  const polygons = []
  let ignored = 0
  const visit = (g) => {
    if (!g || typeof g !== 'object') { ignored++; return }
    switch (g.type) {
      case 'FeatureCollection':
        for (const f of g.features || []) visit(f)
        return
      case 'Feature':
        if (!g.geometry) { ignored++; return }
        visit(g.geometry)
        return
      case 'GeometryCollection':
        for (const gg of g.geometries || []) visit(gg)
        return
      case 'Polygon': {
        const p = Array.isArray(g.coordinates) ? cleanPolygon(g.coordinates) : null
        if (p) polygons.push(p); else ignored++
        return
      }
      case 'MultiPolygon':
        for (const rings of g.coordinates || []) {
          const p = Array.isArray(rings) ? cleanPolygon(rings) : null
          if (p) polygons.push(p); else ignored++
        }
        return
      default:
        ignored++
    }
  }
  visit(geojson)
  return { polygons, ignored }
}

// Even-odd scanline fill of one polygon's pixel-space rings, OR-ed into `mask`.
function fillPolygon(mask, w, h, rings) {
  let minRow = Infinity, maxRow = -Infinity
  for (const ring of rings) for (const p of ring) {
    if (p[1] < minRow) minRow = p[1]
    if (p[1] > maxRow) maxRow = p[1]
  }
  const r0 = Math.max(0, Math.ceil(minRow - 0.5))
  const r1 = Math.min(h - 1, Math.ceil(maxRow - 0.5) - 1)
  if (r1 < r0) return
  const rows = new Array(r1 - r0 + 1)
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i]
      if (a[1] === b[1]) continue // horizontal: never crosses a centre line
      const lo = a[1] < b[1] ? a : b, hi = a[1] < b[1] ? b : a
      // Centre lines yc = r + ½ with lo.y ≤ yc < hi.y (half-open: a shared
      // vertex is counted once).
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
  for (let k = 0; k < rows.length; k++) {
    const xs = rows[k]
    if (!xs) continue
    xs.sort((p, q) => p - q)
    const off = (r0 + k) * w
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Centres c+½ in [xs[i], xs[i+1]).
      const c0 = Math.max(0, Math.ceil(xs[i] - 0.5))
      const c1 = Math.min(w - 1, Math.ceil(xs[i + 1] - 0.5) - 1)
      if (c1 >= c0) mask.fill(1, off + c0, off + c1 + 1)
    }
  }
}

// Columns whose open interval (c, c+1) meets [xa, xb] (xa ≤ xb), in row r.
function markSpan(mask, w, r, xa, xb) {
  let c0, c1
  if (xa === xb) {
    if (Number.isInteger(xa)) return // a vertical line on a pixel edge
    c0 = c1 = Math.floor(xa)
  } else {
    c0 = Math.floor(xa)
    c1 = Math.ceil(xb) - 1
  }
  c0 = Math.max(0, c0); c1 = Math.min(w - 1, c1)
  if (c1 >= c0) mask.fill(1, r * w + c0, r * w + c1 + 1)
}

// Every pixel whose open interior the segment a→b passes through. Walks the
// pixel-row strips the segment spans — O(rows + touched cells) per edge.
function markSegment(mask, w, h, a, b) {
  const lo = a[1] <= b[1] ? a : b, hi = a[1] <= b[1] ? b : a
  if (lo[1] === hi[1]) {
    if (Number.isInteger(lo[1])) return // horizontal on a pixel edge
    const r = Math.floor(lo[1])
    if (r >= 0 && r < h) markSpan(mask, w, r, Math.min(lo[0], hi[0]), Math.max(lo[0], hi[0]))
    return
  }
  const dxdy = (hi[0] - lo[0]) / (hi[1] - lo[1])
  const ra = Math.max(0, Math.floor(lo[1]))
  const rb = Math.min(h - 1, Math.ceil(hi[1]) - 1)
  for (let r = ra; r <= rb; r++) {
    const y0 = Math.max(lo[1], r), y1 = Math.min(hi[1], r + 1)
    if (!(y1 > y0)) continue
    const x0 = snap(lo[0] + (y0 - lo[1]) * dxdy), x1 = snap(lo[0] + (y1 - lo[1]) * dxdy)
    markSpan(mask, w, r, Math.min(x0, x1), Math.max(x0, x1))
  }
}

/**
 * Rasterise polygons onto a grid. geo: { width, height, gsd, originX, originY }
 * (originX/Y = top-left corner of pixel (0,0), row 0 = north).
 * polygons: anything normalizePolygons accepts. opts.allTouched: see header.
 * → Uint8Array(width·height), 1 inside.
 */
export function polygonMask(geo, polygons, { allTouched = false } = {}) {
  const { width: w, height: h, gsd, originX, originY } = geo
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) throw new Error('polygonMask: grid needs positive integer width/height')
  if (!(gsd > 0) || !Number.isFinite(originX) || !Number.isFinite(originY)) throw new Error('polygonMask: grid needs gsd > 0 and a finite origin')
  const mask = new Uint8Array(w * h)
  for (const poly of normalizePolygons(polygons)) {
    const rings = poly.map(ring => ring.map(([x, y]) => [snap((x - originX) / gsd), snap((originY - y) / gsd)]))
    fillPolygon(mask, w, h, rings)
    if (allTouched) {
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) markSegment(mask, w, h, ring[j], ring[i])
      }
    }
  }
  return mask
}

/**
 * Tight bounding box of the set pixels of `mask` (laid out on grid.width ×
 * grid.height). Bounds are INCLUSIVE; width/height are given too so nobody has
 * to remember that. → { col0, row0, col1, row1, width, height } or null if empty.
 */
export function clipBounds(grid, mask) {
  const { width: w, height: h } = grid
  let col0 = Infinity, row0 = -1, col1 = -1, row1 = -1
  for (let r = 0; r < h; r++) {
    const off = r * w
    let first = -1, last = -1
    for (let c = 0; c < w; c++) if (mask[off + c]) { if (first < 0) first = c; last = c }
    if (first < 0) continue
    if (row0 < 0) row0 = r
    row1 = r
    if (first < col0) col0 = first
    if (last > col1) col1 = last
  }
  if (row0 < 0) return null
  return { col0, row0, col1, row1, width: col1 - col0 + 1, height: row1 - row0 + 1 }
}

// Geometry/provenance fields that stay true after a clip. Everything else on a
// product record (stats, previews, timestamps, names, frame stamps the caller
// re-issues) is the caller's to re-derive — copying it would carry stale values.
const CARRY = ['crs', 'frame', 'frameStamp', 'nodata', 'surface', 'verticalDatum']
function carried(src) {
  const out = {}
  for (const k of CARRY) if (src[k] !== undefined) out[k] = src[k]
  return out
}

// Output window: the polygon bbox when cropping, else the whole grid.
function windowOf(grid, inside, crop) {
  const b = clipBounds(grid, inside)
  if (!b) return { bounds: null, win: crop ? null : { col0: 0, row0: 0, width: grid.width, height: grid.height } }
  return { bounds: b, win: crop ? b : { col0: 0, row0: 0, width: grid.width, height: grid.height } }
}

/**
 * Clip a DEM grid to polygons. Cells outside become NaN with mask 0; cells
 * inside keep their value and validity (a hole stays a hole). With crop, the
 * result is cut to the polygons' pixel bbox and its origin moves by whole
 * pixels: originX + col0·gsd, originY − row0·gsd, so every kept cell sits
 * exactly where it was.
 * opts: { crop = true, allTouched = false, onLog }
 * → { width, height, gsd, originX, originY, data: Float32Array (Float64Array
 *   if the input was), mask, zMin, zMax, clip: { col0, row0, col1, row1,
 *   insideCells, validCells }, ...crs/frame fields } — or null when cropping
 *   and nothing lies inside.
 */
export function clipDem(grid, polygons, { crop = true, allTouched = false, onLog } = {}) {
  const inside = polygonMask(grid, polygons, { allTouched })
  const { bounds, win } = windowOf(grid, inside, crop)
  if (!win) {
    onLog?.('Clip DEM: no cell centre lies inside the polygon(s)', 'warn', 'Products')
    return null
  }
  const { width: w, data, mask } = grid
  const nodata = typeof grid.nodata === 'number' && Number.isFinite(grid.nodata) ? grid.nodata : null
  const ow = win.width, oh = win.height
  const outData = data instanceof Float64Array ? new Float64Array(ow * oh) : new Float32Array(ow * oh)
  outData.fill(NaN)
  const outMask = new Uint8Array(ow * oh)
  let insideCells = 0, validCells = 0, zMin = Infinity, zMax = -Infinity
  for (let r = 0; r < oh; r++) {
    const srcOff = (win.row0 + r) * w + win.col0, dstOff = r * ow
    for (let c = 0; c < ow; c++) {
      const s = srcOff + c
      if (!inside[s]) continue
      insideCells++
      const z = data[s]
      if ((mask && !mask[s]) || !Number.isFinite(z) || z === nodata) continue
      outData[dstOff + c] = z
      outMask[dstOff + c] = 1
      validCells++
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
    }
  }
  if (zMin > zMax) { zMin = 0; zMax = 0 }
  onLog?.(`Clip DEM: ${insideCells} cells inside (${validCells} with data), `
    + `${crop ? `cropped to ${ow}×${oh} at col ${win.col0}, row ${win.row0}` : `kept ${ow}×${oh}`}`, 'info', 'Products')
  return {
    ...carried(grid),
    width: ow, height: oh, gsd: grid.gsd,
    originX: grid.originX + win.col0 * grid.gsd,
    originY: grid.originY - win.row0 * grid.gsd,
    data: outData, mask: outMask, zMin, zMax,
    clip: { ...(bounds && { col0: bounds.col0, row0: bounds.row0, col1: bounds.col1, row1: bounds.row1 }), insideCells, validCells },
  }
}

/**
 * Clip an RGBA orthophoto to polygons: pixels outside become (0,0,0,0); inside
 * pixels are copied unchanged (their own alpha included). Crop and origin
 * arithmetic as clipDem. An existing `mask` is cropped and AND-ed with the
 * polygons; none is invented otherwise (alpha carries validity).
 * opts: { crop = true, allTouched = false, onLog }
 * → { width, height, gsd, originX, originY, data (same array type as input),
 *   mask?, clip: { col0, row0, col1, row1, insideCells } } or null (crop, empty).
 */
export function clipOrtho(ortho, polygons, { crop = true, allTouched = false, onLog } = {}) {
  const inside = polygonMask(ortho, polygons, { allTouched })
  const { bounds, win } = windowOf(ortho, inside, crop)
  if (!win) {
    onLog?.('Clip ortho: no pixel centre lies inside the polygon(s)', 'warn', 'Products')
    return null
  }
  const { width: w, data, mask } = ortho
  const ow = win.width, oh = win.height
  const Ctor = data instanceof Uint8ClampedArray ? Uint8ClampedArray : Uint8Array
  const outData = new Ctor(ow * oh * 4)
  const outMask = mask ? new Uint8Array(ow * oh) : null
  let insideCells = 0
  for (let r = 0; r < oh; r++) {
    const srcOff = (win.row0 + r) * w + win.col0, dstOff = r * ow
    for (let c = 0; c < ow; c++) {
      const s = srcOff + c
      if (!inside[s]) continue
      insideCells++
      const si = s * 4, di = (dstOff + c) * 4
      outData[di] = data[si]; outData[di + 1] = data[si + 1]; outData[di + 2] = data[si + 2]; outData[di + 3] = data[si + 3]
      if (outMask) outMask[dstOff + c] = mask[s] ? 1 : 0
    }
  }
  onLog?.(`Clip ortho: ${insideCells} pixels inside, `
    + `${crop ? `cropped to ${ow}×${oh} at col ${win.col0}, row ${win.row0}` : `kept ${ow}×${oh}`}`, 'info', 'Products')
  return {
    ...carried(ortho),
    width: ow, height: oh, gsd: ortho.gsd,
    originX: ortho.originX + win.col0 * ortho.gsd,
    originY: ortho.originY - win.row0 * ortho.gsd,
    data: outData,
    ...(outMask && { mask: outMask }),
    clip: { ...(bounds && { col0: bounds.col0, row0: bounds.row0, col1: bounds.col1, row1: bounds.row1 }), insideCells },
  }
}
