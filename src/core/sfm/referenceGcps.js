import { makeFrame, frameFromScaledLocal } from '../products/projection.js'
import { frameFromSimilarity } from '../products/georef.js'
import { applyHomography } from '../features/guidedTiles.js'
import { pixelToWorld } from '../io/rasterSample.js'
import { centreToMarkPx } from './displayFrame.js'
import { matchConfidence } from './referenceMatch.js'

// The orthophoto's coordinate frame (SfM ↔ its map coordinates), from its record.
export function orthoFrame(ortho) {
  const spec = ortho.frame
  if (!spec) throw new Error('Rebuild the orthophoto to record its coordinate frame')
  let frame
  if (spec.kind === 'similarity') frame = frameFromSimilarity(spec, spec.crs, spec)
  else {
    if (!spec.origin || !spec.east || !spec.north || !spec.up) throw new Error('Orthophoto frame is incomplete')
    frame = makeFrame(spec)
    if (spec.kind === 'scaled-local') frame = frameFromScaledLocal(frame, spec.scale)
  }
  if (!frame) throw new Error('Invalid orthophoto scale')
  return frame
}

/**
 * Candidate controls from the matcher's result (workers/ops/referenceGcps.js).
 * Each candidate is an existing measured sparse track whose ortho position lies
 * within `maxDistance` working pixels of a verified match — the photo marks are
 * the track's own measurements, never invented. Its reference position is the
 * matched reference feature moved by the track's offset from it under that
 * tile's homography, so the local model only carries the last pixel or two.
 *
 * Candidates are spread over the block: the best (by matchConfidence) in each
 * cell of a √limit × √limit grid first, then the next best anywhere at least
 * 24 working px from the rest. Coordinates are in the reference CRS; `residual`
 * is the anchoring match's distance from its tile model in working pixels (the
 * coarser native resolution of the two rasters), `residualRefPx` the same in
 * reference pixels.
 *
 * match: { a, b, tile, residual } native pixel-edge coordinates (ortho a,
 * reference b); tiles[k]: { H, inliers, ratio }; kl/kr: native px per working px.
 * `accept(x, y)` (reference CRS), when given, keeps only candidates it accepts —
 * stable ground — before the spread, so the grid fills from accepted candidates.
 */
export function referenceGcpCandidates({
  points,
  images,
  ortho,
  reference,
  matches,
  tiles,
  kl = 1,
  kr = 1,
  maxDistance = 2,
  limit = 30,
  accept = null,
}) {
  const frame = orthoFrame(ortho)
  const imageByUuid = new Map(images.map((image) => [image.uuid, image]))
  const radius = maxDistance * kl,
    cell = radius
  const bins = new Map(),
    key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  for (let index = 0; index < points.length; index++) {
    const [x, y] = frame.fromSfm(points.xyz(index))
    // Native pixel-edge position in the ortho (the GeoTIFF convention the matches use).
    const u = (x - ortho.originX) / ortho.gsd,
      v = (ortho.originY - y) / ortho.gsd
    if (u < 0 || v < 0 || u >= ortho.width || v >= ortho.height) continue
    const k = key(u, v)
    if (!bins.has(k)) bins.set(k, [])
    bins.get(k).push({ index, u, v })
  }
  const pool = [],
    used = new Set()
  for (const match of [...matches].sort((p, q) => p.residual - q.residual)) {
    let nearest = null,
      best = radius ** 2
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const p of bins.get(key(match.a[0] + dx * cell, match.a[1] + dy * cell)) || []) {
          const d = (p.u - match.a[0]) ** 2 + (p.v - match.a[1]) ** 2
          if (d < best && !used.has(p.index)) {
            nearest = p
            best = d
          }
        }
      }
    if (!nearest) continue
    const observations = []
    points.forEachPixel(nearest.index, (uuid, mx, my) => {
      const image = imageByUuid.get(uuid)
      if (!image || !Number.isFinite(my)) return
      // A candidate becomes a mark: back to the click convention (displayFrame.js
      // makePinholeToMark; without a mapper, just the half-pixel shift).
      const pixel = image.toScan ? image.toScan(mx, my) : { x: centreToMarkPx(mx), y: centreToMarkPx(my) }
      if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) return
      observations.push({ imageName: image.name, px: pixel.x, py: pixel.y })
    })
    if (observations.length < 2) continue
    const tile = tiles[match.tile]
    const mapped = applyHomography(tile.H, nearest.u, nearest.v),
      base = applyHomography(tile.H, ...match.a)
    const referencePixel = [match.b[0] + mapped[0] - base[0], match.b[1] + mapped[1] - base[1]]
    const { width, height } = reference
    if (
      !referencePixel.every(Number.isFinite) ||
      referencePixel[0] < 0 ||
      referencePixel[1] < 0 ||
      (width && referencePixel[0] >= width) ||
      (height && referencePixel[1] >= height)
    )
      continue
    const world = pixelToWorld(reference, ...referencePixel)
    if (accept && !accept(world.x, world.y)) continue
    used.add(nearest.index)
    pool.push({
      pointIndex: nearest.index,
      x: world.x,
      y: world.y,
      z: null,
      observations,
      local: [nearest.u, nearest.v],
      reference: referencePixel,
      tile: match.tile,
      offsetPx: Math.sqrt(best) / kl,
      residual: match.residual,
      residualRefPx: match.residual * kr,
      confidence: matchConfidence({
        ratio: tile.ratio,
        inliers: tile.inliers,
        residual: match.residual,
        observations: observations.length,
      }),
    })
  }
  return spreadCandidates(pool, ortho.width, ortho.height, { limit, minSeparation: 24 * kl })
}

export function spreadCandidates(pool, width, height, { limit = 30, minSeparation = 24 } = {}) {
  const g = Math.max(1, Math.round(Math.sqrt(limit)))
  const byConfidence = [...pool].sort((p, q) => q.confidence - p.confidence)
  const cellOf = (c) =>
    Math.min(g - 1, Math.floor((c.local[0] / width) * g)) + g * Math.min(g - 1, Math.floor((c.local[1] / height) * g))
  const chosen = [],
    cells = new Set()
  const far = (c) => chosen.every((o) => Math.hypot(o.local[0] - c.local[0], o.local[1] - c.local[1]) >= minSeparation)
  for (const c of byConfidence)
    if (!cells.has(cellOf(c)) && far(c)) {
      cells.add(cellOf(c))
      chosen.push(c)
    }
  for (const c of byConfidence) if (chosen.length < limit && !chosen.includes(c) && far(c)) chosen.push(c)
  return chosen.slice(0, limit).sort((p, q) => q.confidence - p.confidence)
}

// How much of the block the candidates span: the occupied share of a 4×4 grid
// over the ortho and their convex hull's share of its area. Control bunched in
// one corner fits a similarity there and extrapolates everywhere else.
export function candidateCoverage(candidates, width, height) {
  const cells = new Set(
    candidates.map(
      (c) => Math.min(3, Math.floor((c.local[0] / width) * 4)) + 4 * Math.min(3, Math.floor((c.local[1] / height) * 4)),
    ),
  )
  return { cells: cells.size, of: 16, hull: hullArea(candidates.map((c) => c.local)) / (width * height) }
}

function hullArea(pts) {
  if (pts.length < 3) return 0
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list) => {
    const h = []
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop()
      h.push(q)
    }
    h.pop()
    return h
  }
  const hull = [...half(p), ...half([...p].reverse())]
  let a = 0
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i],
      [x1, y1] = hull[(i + 1) % hull.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/**
 * Planimetric 1σ of a position read off a reference raster, in the units of
 * `gsd` (its pixel size measured in the project CRS). With a declared absolute
 * accuracy of the reference, that and the pick's own error (`residualPx`
 * reference pixels) add in quadrature; without one the pixel size is the floor
 * — a feature cannot be located better than a pixel of an ortho whose own
 * geolocation is undeclared, and a match that sits r px off its model is r px.
 */
export function referenceSigma({ gsd, residualPx = 0, declared = null }) {
  if (!(gsd > 0)) return null
  return declared > 0 ? Math.hypot(declared, gsd * residualPx) : gsd * Math.max(1, residualPx)
}

// The reference's pixel size at a native pixel, in project units: the mean
// length of one pixel step along each axis after `toProject` (reference CRS →
// project CRS). Exact for geographic references, feet, and grid scale factors.
export function pixelSizeAt(reference, col, row, toProject) {
  const at = (c, r) => {
    const w = pixelToWorld(reference, c, r)
    return toProject([w.x, w.y])
  }
  const p = at(col, row),
    px = at(col + 1, row),
    py = at(col, row + 1)
  return (Math.hypot(px[0] - p[0], px[1] - p[1]) + Math.hypot(py[0] - p[0], py[1] - p[1])) / 2
}

/**
 * A GCP's ground position read off a reference raster (A-5): the native
 * pixel-edge point (col, row) in project coordinates, with its planimetric σ in
 * GCP accuracy units — project units, but metres when the project CRS is
 * `geographic` (useGcpsStore addGcps), measured in a local frame at the pick. A
 * pick is good to one displayed pixel, so `displayFactor` (native pixels per
 * pixel on screen, > 1 when only a downsampled preview is drawn) widens σ; the
 * reference's declared horizontal accuracy (`declared`, same units) adds in
 * quadrature. → { x, y, gsd, sigma }; x/y NaN when the point cannot be transformed.
 */
export function referencePick(
  reference,
  col,
  row,
  { toProject, geographic = false, declared = null, displayFactor = 1 },
) {
  const world = pixelToWorld(reference, col, row)
  const [x, y] = toProject([world.x, world.y])
  const k = 111320,
    cosLat = Math.cos((y * Math.PI) / 180)
  const toAccuracy = geographic
    ? (p) => {
        const [lon, lat] = toProject(p)
        return [(lon - x) * k * cosLat, (lat - y) * k]
      }
    : toProject
  const gsd = pixelSizeAt(reference, col, row, toAccuracy)
  return { x, y, gsd, sigma: referenceSigma({ gsd, residualPx: displayFactor, declared }) }
}
