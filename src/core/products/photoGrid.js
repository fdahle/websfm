// Each aligned photo cast onto the ground as a grid of (photo pixel → map point)
// pairs: what the 2D map's Photos layer draws a photo with (mapImageLayer.js), and
// what a georeference annotation can list as its control points. Pure: no Vue,
// Pinia, OPFS or DOM.
//
// The grid is laid over the camera's pinhole frame (the fiducial frame of a film
// scan, so the scan's collar stays off the map). Each node is cast as a ray from the
// bundle-adjusted camera and placed where it meets a height surface, so the photo
// follows the relief between the nodes, not only at its corners. The node's photo
// pixel is the raw pixel the lens recorded that ray at (displayFrame.js
// makePinholeToMark): lens distortion and the film transform are in the pairs.
//
// The rays are cast in the model frame and placed through `toMap`, the frame the
// map draws in (the project CRS through the georeference, or the model map's local
// frame); `toMap` returns [x, y, up] and the height surface is in the same frame.

import { PHOTO_GRID_TUNING } from '../tuning.js'
import { MIN_RAY_DEPRESSION_DEG } from '../footprint.js'
import { cameraCenter } from '../sfm/geometry.js'
import { makePinholeToMark } from '../sfm/displayFrame.js'
import { pinholeFrameSize } from './undistort.js'
import { fillArray } from '../bigArray.js'

const SIN_MIN_DEPRESSION = Math.sin((MIN_RAY_DEPRESSION_DEG * Math.PI) / 180)
// A node is placed once its ray is within this share of the camera's height above
// the surface of it: 1 cm for a camera 100 m up.
const REL_TOL = 1e-4
const MAX_ITER = 40
// Times the first guess is pushed farther out while the ray is still above ground.
const MAX_DOUBLINGS = 8

/**
 * A height surface from points in the map frame: the median height of each cell,
 * cells with too few points filled from coarser averages (push-pull), read
 * bilinearly between cell centres and clamped at the edges, so every (x, y) has a
 * height. `xyz` is interleaved x, y, up. Null for fewer than three points or no
 * horizontal extent.
 * → { heightAt(x, y), cell, cols, rows, filled } (`filled`: cells decided by points)
 */
export function heightSurface(xyz, opts = {}) {
  const {
    cellPts = PHOTO_GRID_TUNING.heightCellPts,
    minPts = PHOTO_GRID_TUNING.heightMinPts,
    maxSide = PHOTO_GRID_TUNING.heightMaxSide,
  } = opts
  const n = Math.floor(xyz.length / 3)
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    count = 0
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i],
      y = xyz[3 * i + 1],
      z = xyz[3 * i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    count++
  }
  const span = Math.max(maxX - minX, maxY - minY)
  if (count < 3 || !(span > 0)) return null
  const area = Math.max((maxX - minX) * (maxY - minY), (span * span) / 1e4)
  const cell = Math.max(Math.sqrt((area / count) * cellPts), span / maxSide)
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell))
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell))

  // Bucket the heights by cell (counting sort), then take each bucket's median.
  const cellOf = fillArray(new Int32Array(n), -1)
  const starts = new Int32Array(cols * rows + 1)
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i],
      y = xyz[3 * i + 1],
      z = xyz[3 * i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const c = Math.min(cols - 1, Math.floor((x - minX) / cell))
    const r = Math.min(rows - 1, Math.floor((y - minY) / cell))
    cellOf[i] = r * cols + c
    starts[cellOf[i] + 1]++
  }
  for (let k = 0; k < cols * rows; k++) starts[k + 1] += starts[k]
  const fill = starts.slice(0, cols * rows)
  const zs = new Float64Array(count)
  for (let i = 0; i < n; i++) if (cellOf[i] >= 0) zs[fill[cellOf[i]]++] = xyz[3 * i + 2]
  const h = fillArray(new Float64Array(cols * rows), NaN)
  let filled = 0
  for (let k = 0; k < cols * rows; k++) {
    const a = starts[k],
      b = starts[k + 1]
    if (b - a < minPts) continue
    const s = zs.subarray(a, b).sort()
    const m = (b - a) >> 1
    h[k] = (b - a) % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    filled++
  }
  if (!filled) return null
  pushPull(h, cols, rows)

  // Bilinear between cell centres; outside the outer centres the edge value holds.
  function heightAt(x, y) {
    const fx = Math.min(cols - 1, Math.max(0, (x - minX) / cell - 0.5))
    const fy = Math.min(rows - 1, Math.max(0, (y - minY) / cell - 0.5))
    const c0 = Math.floor(fx),
      r0 = Math.floor(fy)
    const c1 = Math.min(cols - 1, c0 + 1),
      r1 = Math.min(rows - 1, r0 + 1)
    const tx = fx - c0,
      ty = fy - r0
    const top = h[r0 * cols + c0] * (1 - tx) + h[r0 * cols + c1] * tx
    const bottom = h[r1 * cols + c0] * (1 - tx) + h[r1 * cols + c1] * tx
    return top * (1 - ty) + bottom * ty
  }
  return { heightAt, cell, cols, rows, filled }
}

// Fill the NaN cells of `h` in place: each coarser level averages the known cells
// below it, and an unknown cell takes its parent's value, so a hole gets the mean of
// the nearest known heights at the scale of the hole.
function pushPull(h, cols, rows) {
  if (cols * rows === 1 || !h.some(Number.isNaN)) return
  const cc = Math.ceil(cols / 2),
    cr = Math.ceil(rows / 2)
  const coarse = new Float64Array(cc * cr)
  for (let r = 0; r < cr; r++) {
    for (let c = 0; c < cc; c++) {
      let sum = 0,
        k = 0
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          const rr = 2 * r + dr,
            ccc = 2 * c + dc
          if (rr >= rows || ccc >= cols) continue
          const v = h[rr * cols + ccc]
          if (Number.isFinite(v)) {
            sum += v
            k++
          }
        }
      }
      coarse[r * cc + c] = k ? sum / k : NaN
    }
  }
  pushPull(coarse, cc, cr)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Number.isNaN(h[r * cols + c])) h[r * cols + c] = coarse[(r >> 1) * cc + (c >> 1)]
    }
  }
}

/**
 * One photo's ground grid.
 *   cam       { R, t, K: { fx, fy, cx, cy } }: the aligned camera (world → camera,
 *             OpenCV: looking down +z, image y down), in the model frame
 *   width, height   its pinhole frame (undistort.js pinholeFrameSize)
 *   toScan    (u, v) pinhole pixel → { x, y } raw photo pixel in the mark (edge)
 *             convention (displayFrame.js makePinholeToMark)
 *   scanWidth, scanHeight   the raw photo's size, to give `src` as 0–1
 *   toMap     model point → [x, y, up] in the map frame
 *   heightAt  (x, y) → the surface height in the map frame
 *   cells     cells a side
 * → { cells, src, dst } with (cells + 1)² nodes, row by row from the top-left:
 *   `src` the photo position (0–1, interleaved u, v), `dst` the map position
 *   (interleaved x, y; NaN where the ray never reaches the surface: past the horizon
 *   or too shallow), or null when the camera is not above the surface or no node lands.
 */
export function photoGroundGrid({
  cam,
  width,
  height,
  toScan,
  scanWidth,
  scanHeight,
  toMap,
  heightAt,
  cells = PHOTO_GRID_TUNING.gridCells,
}) {
  const { fx, fy, cx, cy } = cam.K
  if (!(fx > 0) || !(fy > 0) || !(width > 0) || !(height > 0) || !(scanWidth > 0) || !(scanHeight > 0)) return null
  const C = cameraCenter(cam)
  const Cm = toMap(C)
  const below = heightAt(Cm[0], Cm[1])
  const above0 = Cm[2] - below
  if (!(above0 > 0)) return null
  const tol = above0 * REL_TOL
  const R = cam.R
  const at = (d, s) => toMap([C[0] + s * d[0], C[1] + s * d[1], C[2] + s * d[2]])
  // The ray's height above the surface at s, and where it is.
  const f = (d, s) => {
    const p = at(d, s)
    return [p[2] - heightAt(p[0], p[1]), p]
  }

  function cast(u, v) {
    const a = (u - cx) / fx,
      b = (v - cy) / fy
    // Model direction Rᵀ·[a, b, 1].
    const d = [
      R[0][0] * a + R[1][0] * b + R[2][0],
      R[0][1] * a + R[1][1] * b + R[2][1],
      R[0][2] * a + R[1][2] * b + R[2][2],
    ]
    const p1 = at(d, 1)
    const dm = [p1[0] - Cm[0], p1[1] - Cm[1], p1[2] - Cm[2]]
    const len = Math.hypot(dm[0], dm[1], dm[2])
    if (!(len > 0) || -dm[2] / len < SIN_MIN_DEPRESSION) return null
    // First guess: the plane through the surface under the camera; farther out while
    // the ray is still above the ground there; then regula falsi (Illinois) in the
    // bracket, as footprint.js projectFootprintOnTerrain does for the four corners.
    let s0 = 0,
      f0 = above0
    let s1 = (below - Cm[2]) / dm[2]
    let [f1, p] = f(d, s1)
    for (let k = 0; f1 > 0 && k < MAX_DOUBLINGS; k++) {
      s0 = s1
      f0 = f1
      s1 *= 2
      ;[f1, p] = f(d, s1)
    }
    if (!(f1 <= 0)) return null
    let side = 0
    for (let k = 0; k < MAX_ITER && Math.abs(f1) >= tol; k++) {
      const s = s1 - (f1 * (s1 - s0)) / (f1 - f0)
      const [fs, ps] = f(d, s)
      if (!Number.isFinite(fs)) return null
      if (fs > 0) {
        s0 = s
        f0 = fs
        if (side === 1) f1 /= 2
        side = 1
      } else {
        s1 = s
        f1 = fs
        p = ps
        if (side === -1) f0 /= 2
        side = -1
      }
      if (Math.abs(fs) < tol) {
        p = ps
        break
      }
    }
    return p
  }

  const nodes = (cells + 1) * (cells + 1)
  const src = new Float64Array(2 * nodes)
  const dst = fillArray(new Float64Array(2 * nodes), NaN)
  let landed = 0
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const k = j * (cells + 1) + i
      // Pinhole pixel centres span −½ … size − ½; the node sits on the frame's edge.
      const u = (i / cells) * width - 0.5,
        v = (j / cells) * height - 0.5
      const s = toScan(u, v)
      src[2 * k] = s.x / scanWidth
      src[2 * k + 1] = s.y / scanHeight
      const p = cast(u, v)
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
      dst[2 * k] = p[0]
      dst[2 * k + 1] = p[1]
      landed++
    }
  }
  return landed ? { cells, src, dst } : null
}

/**
 * The height surface of a sparse cloud's tie points (`pos`: interleaved x, y, z in the
 * model frame, as SparsePoints holds them) in the map frame `toMap`, or null
 * (heightSurface).
 */
export function cloudHeightSurface(pos, toMap, opts) {
  const n = Math.floor((pos?.length ?? 0) / 3)
  const xyz = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const q = toMap([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]])
    xyz[3 * i] = q[0]
    xyz[3 * i + 1] = q[1]
    xyz[3 * i + 2] = q[2]
  }
  return heightSurface(xyz, opts)
}

/**
 * One image's ground grid from the aligned model: its camera, its frame model (the
 * lens, any self-calibration on top, the film transform: displayFrame.js
 * makeFrameModelResolver) and the photo's own size. Null for an image the model did
 * not align, one whose film frame the run lacks, or one with no size yet.
 *   image   { meta: { width, height } }   cam   the model's camera for it
 */
export function alignedPhotoGrid({ image, cam, frameModel = null, toMap, heightAt, cells }) {
  if (!cam?.K || frameModel?.filmMissing) return null
  const scanWidth = image?.meta?.width,
    scanHeight = image?.meta?.height
  if (!(scanWidth > 0) || !(scanHeight > 0)) return null
  const { dist = null, selfCal = null, fiducial = null } = frameModel ?? {}
  const { width, height } = pinholeFrameSize({ meta: { width: scanWidth, height: scanHeight }, fiducial })
  const toScan = makePinholeToMark({ K: cam.K, dist, selfCal, fiducial })
  return photoGroundGrid({ cam, width, height, toScan, scanWidth, scanHeight, toMap, heightAt, cells })
}

/**
 * Each aligned photo's ground grid in one map frame, made when first asked for and
 * kept, over one height surface of the tie points made with the first grid. What the
 * Photos layer and the Allmaps export both cast with.
 *   cameras     Map uuid → camera (the sparse cloud's)
 *   pos         the tie points, interleaved x, y, z (SparsePoints `pos`)
 *   toMap       model point → [x, y, up] in the map frame
 *   frameModel  image → its frame model (displayFrame.js makeFrameModelResolver), or null
 * → (image) → grid | null
 */
export function photoGridBuilder({ cameras, pos, toMap, frameModel = null, cells }) {
  let surface
  const grids = new Map()
  return (image) => {
    if (grids.has(image.id)) return grids.get(image.id)
    const cam = image.uuid ? cameras.get(image.uuid) : null
    let grid = null
    if (cam) {
      if (surface === undefined) surface = cloudHeightSurface(pos, toMap)
      if (surface) {
        const fm = frameModel?.(image) ?? null
        grid = alignedPhotoGrid({ image, cam, frameModel: fm, toMap, heightAt: surface.heightAt, cells })
      }
    }
    grids.set(image.id, grid)
    return grid
  }
}

/**
 * A ground grid as the Photos layer's triangles, { src: [[u, v] × 3] (0–1), dst:
 * [[x, y] × 3] }, two a cell; a cell with a node that did not land is left out.
 */
export function gridMesh({ cells, src, dst }) {
  const out = []
  const n = cells + 1
  const uv = (k) => [src[2 * k], src[2 * k + 1]]
  const xy = (k) => [dst[2 * k], dst[2 * k + 1]]
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i,
        b = a + 1,
        c = a + n + 1,
        d = a + n
      if ([a, b, c, d].some((k) => Number.isNaN(dst[2 * k]))) continue
      out.push({ src: [uv(a), uv(b), uv(c)], dst: [xy(a), xy(b), xy(c)] })
      out.push({ src: [uv(a), uv(c), uv(d)], dst: [xy(a), xy(c), xy(d)] })
    }
  }
  return out
}
