// Pair preselection for matching. Given camera positions, keep only each image's
// nearest neighbours so an ordered strip / block costs ~O(N·k) matches instead of
// the exhaustive O(N²). Pure — the store supplies positions (from imported poses)
// and turns the returned key set back into image pairs.

import { isGeographic, localMetricFrame, transform } from '../crs.js'

// Sorted "uuidA--uuidB" key, matching useMatchesStore.pairId so the store can test
// membership directly.
function pairKey(a, b) {
  return a < b ? `${a}--${b}` : `${b}--${a}`
}

function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

// Camera proximity is horizontal overlap evidence: altitude neither establishes
// nor rules out shared ground. For a geographic working CRS, first project all
// positions into one local azimuthal-equidistant metre frame so degrees are never
// compared with metres. Returns fresh [{ uuid, pos:[x,y] }] plain data.
export function positionsForProximity(items, crs) {
  const valid = items.filter((item) => Number.isFinite(item.pos?.[0]) && Number.isFinite(item.pos?.[1]))
  if (!isGeographic(crs) || valid.length === 0)
    return valid.map((item) => ({ uuid: item.uuid, pos: [item.pos[0], item.pos[1]] }))

  const wgs = valid.map((item) => ({
    uuid: item.uuid,
    pos: transform([item.pos[0], item.pos[1]], crs, 'EPSG:4326'),
  }))
  const lonRad = wgs.map((item) => item.pos[0] * Math.PI / 180)
  const lon = Math.atan2(
    lonRad.reduce((sum, v) => sum + Math.sin(v), 0),
    lonRad.reduce((sum, v) => sum + Math.cos(v), 0),
  ) * 180 / Math.PI
  const lat = wgs.reduce((sum, item) => sum + item.pos[1], 0) / wgs.length
  const metric = localMetricFrame(lon, lat)
  return wgs.map((item) => ({ uuid: item.uuid,
    pos: transform(item.pos, 'EPSG:4326', metric) }))
}

// items: [{ uuid, pos: [x, y, z] }]. Returns a Set of pair keys to match.
// A pair is kept if it is among *either* endpoint's `maxNeighbors` nearest (the
// relation is symmetric), and within `maxDistance` if given.
export function preselectPairs(items, { maxNeighbors = 10, maxDistance = Infinity } = {}) {
  const keep = new Set()
  for (let i = 0; i < items.length; i++) {
    const near = []
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      const d = dist2(items[i].pos, items[j].pos)
      if (d <= maxDistance) near.push([d, items[j].uuid])
    }
    near.sort((a, b) => a[0] - b[0])
    const k = Math.min(maxNeighbors, near.length)
    for (let n = 0; n < k; n++) keep.add(pairKey(items[i].uuid, near[n][1]))
  }
  return keep
}

// ── Footprint-overlap preselection ──────────────────────────────────────────
// When image footprints exist (imported, or synthesised from poses via
// core/footprint.js), overlap on the ground is a better pairing signal than raw
// camera proximity: two nearby cameras pointing away from each other share no
// ground, and a footprint captures exactly that. The common footprint is a convex
// quad (projectFootprint emits a closed 4-corner ring); the clip below is exact
// when the *clip* polygon is convex and a close approximation otherwise. Rings are
// in whatever planar frame the caller works in (the project CRS in practice).

// Drop a repeated closing vertex (GeoJSON rings repeat the first point).
function openRing(ring) {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1]
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1)
  }
  return ring
}

// Twice the signed shoelace area (sign = winding; >0 for CCW). Ring must be open.
function signedArea2(ring) {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % n]
    a += x1 * y2 - x2 * y1
  }
  return a
}
function polygonArea(ring) {
  return Math.abs(signedArea2(ring)) / 2
}

// Axis-aligned bbox [minX, minY, maxX, maxY] of an (open) ring.
function bbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}
function bboxesDisjoint(a, b) {
  return a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]
}

// Sutherland–Hodgman: clip open polygon `subject` by convex open polygon `clip`,
// returning the intersection polygon (empty when they don't overlap). Exact when
// `clip` is convex.
function clipPolygon(subject, clip) {
  // Orient the clip CCW so "inside" is consistently to the left of each edge.
  const clipCcw = signedArea2(clip) < 0 ? clip.slice().reverse() : clip
  let output = subject
  for (let i = 0, n = clipCcw.length; i < n; i++) {
    if (!output.length) break
    const a = clipCcw[i], b = clipCcw[(i + 1) % n]
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
    const intersect = (p, q) => {
      const dx1 = q[0] - p[0], dy1 = q[1] - p[1]
      const dx2 = b[0] - a[0], dy2 = b[1] - a[1]
      const denom = dx1 * dy2 - dy1 * dx2
      if (denom === 0) return q
      const t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / denom
      return [p[0] + t * dx1, p[1] + t * dy1]
    }
    const input = output
    output = []
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length]
      const curIn = inside(cur), prevIn = inside(prev)
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur))
        output.push(cur)
      } else if (prevIn) {
        output.push(intersect(prev, cur))
      }
    }
  }
  return output
}

// Shared-ground fraction of two footprints: intersection area ÷ the *smaller*
// footprint's area (so a small footprint fully inside a large one scores ~1 — a
// strong match candidate, which IoU would underrate). Returns 0..1.
export function footprintOverlap(ringA, ringB) {
  const a = openRing(ringA), b = openRing(ringB)
  if (a.length < 3 || b.length < 3) return 0
  if (bboxesDisjoint(bbox(a), bbox(b))) return 0
  const inter = clipPolygon(a, b)
  if (inter.length < 3) return 0
  const denom = Math.min(polygonArea(a), polygonArea(b))
  return denom > 0 ? polygonArea(inter) / denom : 0
}

// items: [{ uuid, ring: [[x,y], ...] }]. Keep a pair when its footprint overlap
// (shared area ÷ smaller footprint) is ≥ minOverlap (a 0..1 fraction).
export function preselectByFootprintOverlap(items, { minOverlap = 0.3 } = {}) {
  const keep = new Set()
  const boxes = items.map((it) => bbox(openRing(it.ring)))
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (bboxesDisjoint(boxes[i], boxes[j])) continue
      if (footprintOverlap(items[i].ring, items[j].ring) >= minOverlap)
        keep.add(pairKey(items[i].uuid, items[j].uuid))
    }
  }
  return keep
}
