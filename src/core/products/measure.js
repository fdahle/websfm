// Coordinates are already in the raster's recorded frame. No implicit scaling.
import { sampleRaster, worldToPixel } from '../io/rasterSample.js'

export function polylineLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

export function planimetricArea(points) {
  if (points.length < 3) return 0
  const side = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    if (i === 0 && j === points.length - 1) continue
    const a = points[i], b = points[(i + 1) % points.length], c = points[j], d = points[(j + 1) % points.length]
    if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return null
  }
  // Translate before summing: survey coordinates can be millions of metres.
  const origin = points[0]
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    twice += (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y)
  }
  return Math.abs(twice) / 2
}

export function sampleProfile(grid, points, { step, maxSamples = 4096 } = {}) {
  if (points.length < 2) return []
  const length = polylineLength(points)
  const cell = Math.min(Math.abs(grid.geoTransform.scaleX), Math.abs(grid.geoTransform.scaleY))
  const spacing = Math.max(step > 0 ? step : cell, length / Math.max(1, maxSamples - points.length))
  if (!(spacing > 0)) return []
  const zOffset = grid.zOffset || 0
  const samples = []
  let distance = 0
  const sample = (x, y, d) => {
    // Preserve holes even when the shared sampler could borrow a neighbour.
    const pixel = worldToPixel(grid, x, y)
    const c = Math.floor(pixel.col), r = Math.floor(pixel.row), index = r * grid.width + c
    const valid = c >= 0 && r >= 0 && c < grid.width && r < grid.height
      && (!grid.mask || grid.mask[index]) && Number.isFinite(grid.data[index])
      && (grid.nodata == null || grid.data[index] !== grid.nodata)
    samples.push({ distance: d, z: valid ? sampleRaster(grid, x, y) + zOffset : null })
  }
  sample(points[0].x, points[0].y, 0)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const segment = Math.hypot(b.x - a.x, b.y - a.y)
    if (!segment) continue
    const n = Math.max(1, Math.ceil(segment / spacing))
    for (let j = 1; j <= n; j++) sample(a.x + (b.x - a.x) * j / n, a.y + (b.y - a.y) * j / n, distance + segment * j / n)
    distance += segment
  }
  return samples
}

// Is DEM cell (c, r) a real elevation? Same rule as the profile: masked, NaN and
// nodata cells are holes, never borrowed from a neighbour.
function validCell(grid, c, r) {
  if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return false
  const i = r * grid.width + c
  return (!grid.mask || !!grid.mask[i]) && Number.isFinite(grid.data[i])
    && (grid.nodata == null || grid.data[i] !== grid.nodata)
}

// Least-squares plane z = a·(x−x0) + b·(y−y0) + c through ≥3 points, centred so
// survey-sized coordinates do not swamp the normal equations. null when the
// points are (nearly) collinear — a plane through them is undetermined.
export function fitBasePlane(points) {
  const n = points.length
  if (n < 3) return null
  let x0 = 0, y0 = 0
  for (const p of points) { x0 += p.x; y0 += p.y }
  x0 /= n; y0 /= n
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0, span = 0
  for (const p of points) {
    const dx = p.x - x0, dy = p.y - y0
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy
    sxz += dx * p.z; syz += dy * p.z; sz += p.z
    span = Math.max(span, Math.abs(dx), Math.abs(dy))
  }
  const det = sxx * syy - sxy * sxy
  // Relative test: the determinant scales with span⁴·n².
  if (!(det > 1e-12 * (span ** 4) * n * n)) return null
  return { x0, y0, a: (sxz * syy - syz * sxy) / det, b: (syz * sxx - sxz * sxy) / det, c: sz / n }
}

/**
 * Cut/fill volume of a DEM inside a polygon, relative to a base surface — the
 * stockpile measurement. Each DEM cell whose CENTRE lies inside the polygon
 * contributes (z − base)·cellArea: positive to `cut` (material above the base),
 * negative to `fill`. Holes are never interpolated: they are counted, and
 * `coverage` (valid ÷ inside cells) says how much of the polygon was measured, so
 * a volume over a patchy DEM cannot pass for a complete one.
 *
 * base:
 *   'plane'  — least-squares plane through the DEM heights at the polygon vertices
 *              (exact for 3 vertices; the usual stockpile toe surface)
 *   'lowest' — horizontal plane at the lowest vertex height
 *   'custom' — horizontal plane at `height`
 *
 * Units: horizontal² × vertical, exactly as the grid records them; no scaling.
 * Returns { cut, fill, net, cellArea, insideCells, validCells, coverage, base }
 * or { error } ('polygon' | 'self-intersecting' | 'base' | 'no-data').
 */
export function polygonVolume(grid, points, { base = 'plane', height = null } = {}) {
  if (points.length < 3) return { error: 'polygon' }
  if (planimetricArea(points) == null) return { error: 'self-intersecting' }
  const { scaleX, scaleY } = grid.geoTransform
  const zOffset = grid.zOffset || 0
  const vertexHeights = points.map(p => {
    const px = worldToPixel(grid, p.x, p.y)
    if (!px || !validCell(grid, Math.floor(px.col), Math.floor(px.row))) return null
    const z = sampleRaster(grid, p.x, p.y)
    return Number.isFinite(z) ? z + zOffset : null
  })
  const known = points.map((p, i) => ({ x: p.x, y: p.y, z: vertexHeights[i] })).filter(p => p.z != null)
  let baseAt, baseInfo
  if (base === 'custom') {
    if (!Number.isFinite(height)) return { error: 'base' }
    baseAt = () => height
    baseInfo = { kind: 'custom', height }
  } else if (base === 'lowest') {
    if (!known.length) return { error: 'base' }
    let low = Infinity
    for (const p of known) if (p.z < low) low = p.z
    baseAt = () => low
    baseInfo = { kind: 'lowest', height: low }
  } else {
    const plane = fitBasePlane(known)
    if (!plane) return { error: 'base' }
    baseAt = (x, y) => plane.a * (x - plane.x0) + plane.b * (y - plane.y0) + plane.c
    baseInfo = { kind: 'plane', plane }
  }
  baseInfo.vertexHeights = vertexHeights

  // Scanline fill in pixel space: a cell is inside when its centre (c+½, r+½) is.
  const poly = points.map(p => worldToPixel(grid, p.x, p.y))
  let minRow = Infinity, maxRow = -Infinity
  for (const p of poly) { if (p.row < minRow) minRow = p.row; if (p.row > maxRow) maxRow = p.row }
  const cellArea = Math.abs(scaleX * scaleY)
  let cut = 0, fill = 0, insideCells = 0, validCells = 0
  const xs = []
  for (let r = Math.ceil(minRow - 0.5); r + 0.5 <= maxRow; r++) {
    const yc = r + 0.5
    xs.length = 0
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i]
      if ((a.row > yc) !== (b.row > yc)) xs.push(a.col + (yc - a.row) * (b.col - a.col) / (b.row - a.row))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let c = Math.ceil(xs[k] - 0.5); c + 0.5 < xs[k + 1]; c++) {
        insideCells++
        if (!validCell(grid, c, r)) continue
        validCells++
        const x = grid.geoTransform.originX + (c + 0.5) * scaleX
        const y = grid.geoTransform.originY + yc * scaleY
        const dz = grid.data[r * grid.width + c] + zOffset - baseAt(x, y)
        if (dz > 0) cut += dz * cellArea
        else fill -= dz * cellArea
      }
    }
  }
  if (!validCells) return { error: 'no-data', insideCells }
  return { cut, fill, net: cut - fill, cellArea, insideCells, validCells,
    coverage: validCells / insideCells, base: baseInfo }
}

/**
 * Grid → ground for a projected CRS. Grid distances are the ground distance times
 * the point scale factor k (0.980 at 80°S in EPSG:3031, 1.0004 on a UTM edge), so
 * lengths divide by k and areas by k². Heights are not scaled by the projection,
 * so a volume (Σ cell area · Δz) divides by k² too. k = 1 (local / model frames,
 * or no CRS) is the identity. Over a measurement-sized extent k is constant to
 * ~1e-5, so one value at the raster centre serves.
 */
export function groundVolume(v, k = 1) {
  if (!v || v.error || k === 1) return v
  const a = 1 / (k * k)
  return { ...v, cut: v.cut * a, fill: v.fill * a, net: v.net * a, cellArea: v.cellArea * a, groundScale: k }
}
