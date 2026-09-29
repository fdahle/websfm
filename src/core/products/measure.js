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
  const samples = []
  let distance = 0
  const sample = (x, y, d) => {
    // Preserve holes even when the shared sampler could borrow a neighbour.
    const pixel = worldToPixel(grid, x, y)
    const c = Math.floor(pixel.col), r = Math.floor(pixel.row), index = r * grid.width + c
    const valid = c >= 0 && r >= 0 && c < grid.width && r < grid.height
      && (!grid.mask || grid.mask[index]) && Number.isFinite(grid.data[index])
      && (grid.nodata == null || grid.data[index] !== grid.nodata)
    samples.push({ distance: d, z: valid ? sampleRaster(grid, x, y) : null })
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
