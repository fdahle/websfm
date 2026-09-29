import { makeFrame, frameFromScaledLocal } from '../products/projection.js'
import { frameFromSimilarity } from '../products/georef.js'
import { applyHomography } from '../features/guidedTiles.js'
import { pixelToWorld } from '../io/rasterSample.js'

// Candidate controls use existing measured image tracks. The reference position
// is estimated locally from a verified ortho feature, not a surveyed coordinate.
export function referenceGcpCandidates({ points, images, ortho, reference, matches, H, localWidth, localHeight, referenceLayout, maxDistance = 2, limit = 30 }) {
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
  const imageByUuid = new Map(images.map(image => [image.uuid, image]))
  const sx = localWidth / ortho.width, sy = localHeight / ortho.height
  const bins = new Map(), cell = maxDistance
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  points.forEach((point, index) => {
    const [x, y] = frame.fromSfm(point)
    // GeoTIFF transforms address pixel edges; SIFT addresses sample centres
    // (index zero). Apply the half-pixel after resizing into the working grid.
    const u = (x - ortho.originX) / ortho.gsd * sx - 0.5
    const v = (ortho.originY - y) / ortho.gsd * sy - 0.5
    if (u < 0 || v < 0 || u >= localWidth || v >= localHeight) return
    const k = key(u, v)
    if (!bins.has(k)) bins.set(k, [])
    bins.get(k).push({ point, index, u, v })
  })
  const candidates = [], used = new Set()
  for (const match of matches) {
    let nearest = null, best = maxDistance ** 2
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const p of bins.get(key(match.a[0] + dx * cell, match.a[1] + dy * cell)) || []) {
        const d = (p.u - match.a[0]) ** 2 + (p.v - match.a[1]) ** 2
        if (d < best && !used.has(p.index)) { nearest = p; best = d }
      }
    }
    if (!nearest || candidates.some(c => Math.hypot(c.local[0] - nearest.u, c.local[1] - nearest.v) < 24)) continue
    const observations = []
    for (const [uuid, measured] of nearest.point.viewsPx || []) {
      const image = imageByUuid.get(uuid)
      if (!image || !measured?.every(Number.isFinite)) continue
      const pixel = image.toScan ? image.toScan(...measured) : { x: measured[0], y: measured[1] }
      if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) continue
      observations.push({ imageName: image.name, px: pixel.x, py: pixel.y })
    }
    if (observations.length < 2) continue
    const mapped = applyHomography(H, nearest.u, nearest.v), base = applyHomography(H, ...match.a)
    // Anchor the local differential to the actual matched reference feature.
    const referencePixel = [match.b[0] + mapped[0] - base[0], match.b[1] + mapped[1] - base[1]]
    if (!referencePixel.every(Number.isFinite) || referencePixel[0] < 0 || referencePixel[1] < 0
        || referencePixel[0] >= referenceLayout.width || referencePixel[1] >= referenceLayout.height) continue
    const world = pixelToWorld(reference,
      referenceLayout.col + (referencePixel[0] + 0.5) * referenceLayout.scaleX,
      referenceLayout.row + (referencePixel[1] + 0.5) * referenceLayout.scaleY)
    used.add(nearest.index)
    candidates.push({ pointIndex: nearest.index, x: world.x, y: world.y, z: null, observations,
      local: [nearest.u, nearest.v], reference: referencePixel, offsetPx: Math.sqrt(best) })
    if (candidates.length >= limit) break
  }
  return candidates
}
