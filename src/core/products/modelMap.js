// The 2D map in the MODEL frame (CLAUDE.md ▸ map raster layers):
// a top-down view of the sparse model's local frame, for projects that have no
// CRS position. Pure geometry; the map viewer registers MODEL_MAP_CRS as a plain
// metric OpenLayers projection and draws these coordinates as they are.

import { cameraCenter } from '../sfm/geometry.js'

// The OpenLayers projection code of the model-frame map. Not an EPSG code and
// never written to a file: it names "this project's local frame" for the viewer.
export const MODEL_MAP_CRS = 'websfm:model'

const EPS = 1e-9
const sameVec = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === 3 &&
  Math.abs(a[0] - b[0]) < EPS &&
  Math.abs(a[1] - b[1]) < EPS &&
  Math.abs(a[2] - b[2]) < EPS
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// Where a product built in local frame `desc` (its recorded frame descriptor)
// lands in the map's local frame `map`: a pure horizontal translation, or the
// reason it cannot be placed. Two auto local frames of one model share their
// rotation (up from the cameras, east derived from up) and differ only by origin
// — the centroid of whichever points each was built from — so a DEM and an ortho
// built from different clouds still overlay exactly, without resampling.
// → { dx, dy } | { reason }
export function frameOffset(desc, map) {
  if (!desc || (desc.kind !== 'local' && desc.kind !== 'scaled-local')) {
    return { reason: 'it was built in the project CRS' }
  }
  if (!sameVec(desc.east, map.east) || !sameVec(desc.north, map.north) || !sameVec(desc.up, map.up)) {
    return { reason: 'it was built in a differently oriented model frame — rebuild it' }
  }
  const s = desc.kind === 'scaled-local' ? desc.scale : 1
  const sm = map.scale ?? 1
  if (!(Math.abs(s - sm) <= 1e-12 * Math.max(1, Math.abs(sm)))) {
    return { reason: 'it was built at a different scale — rebuild it' }
  }
  const d = [desc.origin[0] - map.origin[0], desc.origin[1] - map.origin[1], desc.origin[2] - map.origin[2]]
  return { dx: sm * dot(d, map.east), dy: sm * dot(d, map.north) }
}

// Registered camera centres in the map frame, as map point records.
//   cameras: [{ imageId, imageName, R, t }]
export function modelMapCameras(cameras, frame) {
  const out = []
  for (const c of cameras) {
    const [x, y] = frame.fromSfm(cameraCenter(c))
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ imageId: c.imageId, imageName: c.imageName, x, y })
  }
  return out
}

// The projection extent for the model map, padded 1000× the content span: OL
// derives the zoom-out limit from it (extent width / 256 px), and a product can
// be far wider than the camera cluster (an oblique or terrestrial capture), so a
// tight box would stop Fit View short of the product. 28 zoom levels below that
// still reach ~span·1e-8, so close-ups lose nothing. Never degenerate (one camera).
//   points: [{ x, y }]   boxes: [[minX, minY, maxX, maxY]]
export function modelMapExtent(points, boxes = []) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  for (const b of boxes) {
    if (b[0] < minX) minX = b[0]
    if (b[2] > maxX) maxX = b[2]
    if (b[1] < minY) minY = b[1]
    if (b[3] > maxY) maxY = b[3]
  }
  if (!(minX <= maxX)) return [-100, -100, 100, 100]
  const span = Math.max(maxX - minX, maxY - minY, 1e-3)
  const pad = span * 1000
  return [minX - pad, minY - pad, maxX + pad, maxY + pad]
}
