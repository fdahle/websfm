// Coordinates are already in the raster's recorded frame. No implicit scaling.
import { sampleRaster, worldToPixel } from '../io/rasterSample.js'
import { polygonSpans } from './polygonSpans.js'

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
 *   'surface' — a second surface, `surface.sample(x, y) → z | null` in the grid's
 *              own frame: the DEM of difference against a reference DEM (another
 *              epoch, a lidar survey). A cell the base has no height for counts as
 *              unmeasured, like a hole in the DEM. Sampling the base costs a
 *              reprojection per cell, so above `maxSurfaceSamples` inside cells
 *              only every `sampleStep`-th cell of every `sampleStep`-th row is
 *              compared, each standing for sampleStep² cells: the sums are scaled
 *              to the whole polygon (insideCells / sampled cells), and `sampleStep`
 *              is reported so the caller can say the result is an estimate.
 *
 * Units: horizontal² × vertical, exactly as the grid records them; no scaling.
 * Returns { cut, fill, net, cellArea, insideCells, validCells, coverage, base,
 * sampleStep } or { error } ('polygon' | 'self-intersecting' | 'base' | 'no-data').
 */
export const SURFACE_VOLUME_MAX_SAMPLES = 262144 // 512², as the DEM-vs-reference check

export function polygonVolume(grid, points, { base = 'plane', height = null, surface = null,
  maxSurfaceSamples = SURFACE_VOLUME_MAX_SAMPLES } = {}) {
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
  if (base === 'surface') {
    if (typeof surface?.sample !== 'function') return { error: 'base' }
    baseAt = (x, y) => surface.sample(x, y)
    baseInfo = { kind: 'surface', name: surface.name ?? null }
  } else if (base === 'custom') {
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

  // A cell is inside when its centre (c+½, r+½) is — the same spans raster
  // clipping uses (polygonSpans.js). Unclamped: cells off the raster count as
  // inside-but-unmeasured, so a polygon hanging off the edge lowers coverage.
  const ring = points.map(p => { const px = worldToPixel(grid, p.x, p.y); return [px.col, px.row] })
  const cellArea = Math.abs(scaleX * scaleY)
  // A second surface is the costly base (a reprojected sample per cell): above the
  // cap, a regular sub-grid of the inside cells. The planes stay exact.
  let step = 1
  if (base === 'surface' && maxSurfaceSamples > 0) {
    let n = 0
    polygonSpans([ring], (r, c0, c1) => { n += c1 - c0 + 1 })
    if (n > maxSurfaceSamples) step = Math.ceil(Math.sqrt(n / maxSurfaceSamples))
  }
  let cut = 0, fill = 0, insideCells = 0, sampled = 0, validSampled = 0
  polygonSpans([ring], (r, c0, c1) => {
    insideCells += c1 - c0 + 1
    if (step > 1 && r % step) return
    const y = grid.geoTransform.originY + (r + 0.5) * scaleY
    for (let c = step > 1 ? c0 + ((step - (c0 % step)) % step) : c0; c <= c1; c += step) {
      sampled++
      if (!validCell(grid, c, r)) continue
      const x = grid.geoTransform.originX + (c + 0.5) * scaleX
      const b = baseAt(x, y)
      if (b == null || !Number.isFinite(b)) continue
      validSampled++
      const dz = grid.data[r * grid.width + c] + zOffset - b
      if (dz > 0) cut += dz * cellArea
      else fill -= dz * cellArea
    }
  })
  if (!validSampled) return { error: 'no-data', insideCells }
  // Each sampled cell stands for insideCells / sampled of the polygon (exactly 1
  // without a sub-grid).
  const scale = step > 1 ? insideCells / sampled : 1
  cut *= scale; fill *= scale
  const validCells = step > 1 ? Math.round(validSampled * scale) : validSampled
  return { cut, fill, net: cut - fill, cellArea, insideCells, validCells,
    coverage: validSampled / sampled, base: baseInfo, sampleStep: step }
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

// ── 3D measurements (picked in the 3D view) ──────────────────────────────────
// Points are [x, y, z] in the cloud's own coordinates; `up` is the unit vertical
// (the scene's up: the orientation, else the cameras'). Results are coordinate
// lengths and areas: the caller scales them to its unit (cloudUnits.js) and never
// prints a bare number. Differences, never products, of absolute coordinates.

/**
 * Length along a 3D polyline, split into its horizontal and vertical parts.
 * → { length, horizontal, vertical (last − first along up, signed), climb (Σ rises),
 *     segments: [length per segment] } — null for fewer than two points.
 */
export function polyline3d(points, up = [0, 0, 1]) {
  if (!points || points.length < 2) return null
  let length = 0, horizontal = 0, climb = 0
  const segments = []
  for (let i = 1; i < points.length; i++) {
    const d = [0, 1, 2].map((k) => points[i][k] - points[i - 1][k])
    const l = Math.hypot(d[0], d[1], d[2])
    const v = d[0] * up[0] + d[1] * up[1] + d[2] * up[2]
    segments.push(l)
    length += l
    horizontal += Math.sqrt(Math.max(0, l * l - v * v))
    if (v > 0) climb += v
  }
  const first = points[0], last = points[points.length - 1]
  const vertical = (last[0] - first[0]) * up[0] + (last[1] - first[1]) * up[1] + (last[2] - first[2]) * up[2]
  return { length, horizontal, vertical, climb, segments }
}

/**
 * A closed 3D polygon's true area and its footprint. The vector area (Newell's
 * method, Σ pᵢ × pᵢ₊₁ / 2 relative to the first vertex) gives both: its length is the
 * area of the polygon on its best-fit plane — exact when the vertices are coplanar,
 * the projected area when they are not — and its component along `up` is the
 * planimetric footprint. A façade has a large area and a footprint near zero; level
 * ground has the two equal. Self-intersecting outlines are not detected.
 * → { area, footprint, perimeter, normal: unit [x,y,z], planarity (largest distance
 *     of a vertex from the best-fit plane) } — null for fewer than three points.
 */
export function polygon3d(points, up = [0, 0, 1]) {
  if (!points || points.length < 3) return null
  const o = points[0]
  const rel = points.map((p) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]])
  const n = [0, 0, 0]
  let perimeter = 0
  for (let i = 0; i < rel.length; i++) {
    const a = rel[i], b = rel[(i + 1) % rel.length]
    n[0] += a[1] * b[2] - a[2] * b[1]
    n[1] += a[2] * b[0] - a[0] * b[2]
    n[2] += a[0] * b[1] - a[1] * b[0]
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  const len = Math.hypot(n[0], n[1], n[2])
  const area = len / 2
  const footprint = Math.abs(n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / 2
  const normal = len > 0 ? n.map((c) => c / len) : [0, 0, 0]
  // Planarity against the plane through the centroid with that normal.
  const c = [0, 1, 2].map((k) => rel.reduce((s, p) => s + p[k], 0) / rel.length)
  let planarity = 0
  for (const p of rel) planarity = Math.max(planarity, Math.abs((p[0] - c[0]) * normal[0] + (p[1] - c[1]) * normal[1] + (p[2] - c[2]) * normal[2]))
  return { area, footprint, perimeter, normal, planarity }
}
