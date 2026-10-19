import { applyHomography } from '../features/guidedTiles.js'

// Geometry of the coarse-to-fine ortho-to-reference matcher (workers/ops/
// referenceGcps.js runs the features; this decides where to look). Every
// coordinate here is a NATIVE pixel-edge coordinate of its raster (x = 0 at the
// left edge of column 0), so a homography maps project-ortho pixels straight to
// reference pixels whatever resolution either side was read at.

// A read's working samples → native: sample j's centre sits at c0 + j·scale
// (rasterWindow.js windowToNative; a canvas-resized preview has c0 = ½·scale).
export const sampleAffine = (layout) => [layout.scaleX, 0, layout.centreX0 ?? layout.col + 0.5,
  0, layout.scaleY, layout.centreY0 ?? layout.row + 0.5, 0, 0, 1]

function mul3(A, B) {
  const C = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
    C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]
  return C
}
function invAffine(A) { // [sx 0 cx; 0 sy cy; 0 0 1]
  return [1 / A[0], 0, -A[2] / A[0], 0, 1 / A[4], -A[5] / A[4], 0, 0, 1]
}
export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!det) return null
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

// H between two reads' working samples → H between the two rasters' native pixels.
export function homographyToNative(Hw, fromLayout, toLayout) {
  return mul3(sampleAffine(toLayout), mul3(Hw, invAffine(sampleAffine(fromLayout))))
}

// Reference native pixels per project-ortho native pixel at (x, y): √|det J|.
export function homographyScale(H, x, y, step = 1) {
  const p = applyHomography(H, x, y), px = applyHomography(H, x + step, y), py = applyHomography(H, x, y + step)
  return Math.sqrt(Math.abs((px[0] - p[0]) * (py[1] - p[1]) - (px[1] - p[1]) * (py[0] - p[0]))) / step
}

const clampRect = (x0, y0, x1, y1, w, h) => {
  const col = Math.max(0, Math.floor(x0)), row = Math.max(0, Math.floor(y0))
  const width = Math.min(w, Math.ceil(x1)) - col, height = Math.min(h, Math.ceil(y1)) - row
  return width > 0 && height > 0 ? { col, row, width, height } : null
}

// Bounding rect of native points, padded by `pad` × its larger side (and at least
// `minPad` px) and clipped to the raster; null when it misses the raster entirely.
export function paddedRect(points, width, height, { pad = 0.25, minPad = 0 } = {}) {
  const finite = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (!finite.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of finite) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  const m = Math.max(minPad, pad * Math.max(x1 - x0, y1 - y0))
  return clampRect(x0 - m, y0 - m, x1 + m, y1 + m, width, height)
}

// Where the project ortho lands in the reference under H, padded for the next,
// finer look (the coarse-to-fine refinement window).
export function footprintRect(H, localWidth, localHeight, refWidth, refHeight, pad = 0.15) {
  const corners = [[0, 0], [localWidth, 0], [localWidth, localHeight], [0, localHeight]].map(([x, y]) => applyHomography(H, x, y))
  return paddedRect(corners, refWidth, refHeight, { pad })
}

// Search windows of `region` at subdivision `level`: the region itself, then 3×3
// windows of half its size, then 5×5 of a quarter, each grid at a stride of
// (1 − size) / (n − 1). The overlap is what matters: any footprint up to ¼ of the
// region (level 2) or 1/16 (level 3) sits wholly inside one window, read at 2× or
// 4× the working pixels. A level exists only to give a small footprint more of
// them, so callers stop at the first level that aligns.
export const SEARCH_LEVELS = [null, { size: 1, n: 1 }, { size: 0.5, n: 3 }, { size: 0.25, n: 5 }]
export function searchWindows(region, level) {
  const { size, n } = SEARCH_LEVELS[Math.max(1, Math.min(3, level))]
  if (n === 1) return [region]
  const w = Math.ceil(region.width * size), h = Math.ceil(region.height * size), out = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const col = region.col + Math.floor(region.width * (1 - size) * i / (n - 1))
    const row = region.row + Math.floor(region.height * (1 - size) * j / (n - 1))
    out.push({ col, row, width: Math.min(w, region.col + region.width - col), height: Math.min(h, region.row + region.height - row) })
  }
  return out
}

/**
 * Fine-pass tiles. Both rasters are read at a COMMON resolution — the coarser of
 * the two natives, since neither side can locate a feature better than that — so
 * SIFT sees the same scale and only rotation is left for its orientations.
 * `scale` = reference native px per local native px (homographyScale).
 * Tiles sit on an up-to-`maxPerAxis` grid over the ortho; when the ortho is larger
 * than that many tiles they sample it with gaps: the aim is control spread over
 * the block, not dense matches. Tiles whose coarse look is mostly empty are dropped.
 * `covered(x0, y0, x1, y1)` → fraction of valid ortho pixels in a native rect.
 */
export function fineTiles({ H, localWidth, localHeight, refWidth, refHeight, scale, tile = 512, maxPerAxis = 6, margin = 32, covered = () => 1, minCovered = 0.2 }) {
  const kl = scale < 1 ? 1 / scale : 1, kr = scale < 1 ? 1 : scale // native px per common px
  const side = tile * kl, nx = Math.min(maxPerAxis, Math.max(1, Math.ceil(localWidth / side))), ny = Math.min(maxPerAxis, Math.max(1, Math.ceil(localHeight / side)))
  const tiles = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (i + 0.5) * localWidth / nx, cy = (j + 0.5) * localHeight / ny
    const local = clampRect(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2, localWidth, localHeight)
    if (!local || covered(local.col, local.row, local.col + local.width, local.row + local.height) < minCovered) continue
    const corners = [[local.col, local.row], [local.col + local.width, local.row], [local.col + local.width, local.row + local.height], [local.col, local.row + local.height]]
    const reference = paddedRect(corners.map(([x, y]) => applyHomography(H, x, y)), refWidth, refHeight, { pad: 0, minPad: margin * kr })
    if (reference) tiles.push({ i, j, local, reference, localMaxDim: Math.ceil(Math.max(local.width, local.height) / kl), refMaxDim: Math.ceil(Math.max(reference.width, reference.height) / kr) })
  }
  return { tiles, kl, kr }
}

// Keep a tile's matches only when they are consistent AND spread out: a repeated
// texture (snow sastrugi, a car park) matches itself in a tight cluster that a
// homography fits perfectly. The inliers' bounding box must span `minSpread` of
// the tile in both directions.
export function acceptTile(fit, pairs, { minInliers = 10, minRatio = 0.3, tileSize, minSpread = 0.2 }) {
  if (!fit || fit.inlierCount < minInliers || fit.inlierCount / Math.max(1, pairs.length) < minRatio) return false
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  pairs.forEach((p, k) => { if (fit.inlierMask[k]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) } })
  return x1 - x0 >= minSpread * tileSize && y1 - y0 >= minSpread * tileSize
}

// A 0–1 score for review ordering, from what the matcher saw: how much of the
// tile agreed (inlier ratio, inlier count up to 30), how tightly this match sits
// on its tile's model (residual in common pixels, 1 px = e^-½), and whether the
// sparse track it anchors is seen in three or more photos.
export function matchConfidence({ ratio, inliers, residual, observations }) {
  return Math.max(0, Math.min(1, ratio)) * Math.min(1, inliers / 30)
    * Math.exp(-0.5 * residual * residual) * (observations >= 3 ? 1 : 0.8)
}

// ── where to search: an approximate footprint, when the project has one ──────

// A lon/lat outline around photo GPS positions: their bounding box padded by half
// its span and at least `minPadMetres` (the photos' ground footprint extends past
// the camera positions by roughly the flying height), sampled along each edge so a
// polar or conic reference CRS bends it correctly. Null without two positions.
export function gpsSearchOutline(lonLats, { minPadMetres = 300, perEdge = 8 } = {}) {
  const pts = lonLats.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (pts.length < 2) return null
  let lon0 = Infinity, lat0 = Infinity, lon1 = -Infinity, lat1 = -Infinity
  for (const [lon, lat] of pts) { lon0 = Math.min(lon0, lon); lat0 = Math.min(lat0, lat); lon1 = Math.max(lon1, lon); lat1 = Math.max(lat1, lat) }
  const midLat = (lat0 + lat1) / 2 * Math.PI / 180
  const padLat = Math.max(0.5 * (lat1 - lat0), minPadMetres / 111320)
  const padLon = Math.max(0.5 * (lon1 - lon0), minPadMetres / (111320 * Math.max(0.01, Math.cos(midLat))))
  const a = [lon0 - padLon, Math.max(-90, lat0 - padLat)], b = [lon1 + padLon, Math.min(90, lat1 + padLat)]
  const out = []
  for (let i = 0; i <= perEdge; i++) {
    const t = i / perEdge, lon = a[0] + t * (b[0] - a[0]), lat = a[1] + t * (b[1] - a[1])
    out.push([lon, a[1]], [lon, b[1]], [a[0], lat], [b[0], lat])
  }
  return out
}

// A native search rect from footprint points already in reference PIXELS; null
// when it covers (nearly) the whole raster anyway, so the caller searches it all.
// Throws when the footprint misses the raster: no amount of matching finds a
// block outside the reference.
export function searchRegion(pixelPoints, width, height, { pad = 0.25 } = {}) {
  const rect = paddedRect(pixelPoints, width, height, { pad, minPad: 64 })
  if (!rect) throw new Error('The reference raster does not cover the expected footprint of the photos')
  return rect.width * rect.height > 0.8 * width * height ? null : rect
}
