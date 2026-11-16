// Text detection with PaddleOCR's PP-OCRv5 mobile detector (DB, Liao et al. 2020):
// the network gives each pixel the probability that it lies inside a text line, and
// the regions above a threshold, grown back by DB's unclip, are the text boxes.
// Pure: the network runs through `run` (core/ocr/session.js in the app, a stub in the
// tests), so the pre- and post-processing here are exactly what the tests check.
//
// The detector reads a raster of any size in overlapping tiles and stitches their
// probability maps before the boxes are found, so a line across a tile edge stays
// one line and memory stays bounded by the tile, not the scan.

import { OCR_TUNING } from '../tuning.js'
import { minAreaRect, rectCorners, orderQuad, unclipRect, polyBounds, insideConvex } from './quad.js'

// The detector's input normalisation (inference.yml ▸ NormalizeImage), per channel of
// a BGR image.
export const DET_MEAN = [0.485, 0.456, 0.406]
export const DET_STD = [0.229, 0.224, 0.225]

/**
 * Tiles covering a w×h raster: each `{ x, y, w, h }` is what the network reads (sides
 * a multiple of 32, padded past the raster's edge where needed), and `keep` the part of
 * it whose probabilities are used, so tiles overlap by `overlap` and each pixel takes
 * the tile where it lies farthest from a seam.
 */
export function detTiles(w, h, tile = OCR_TUNING.detTile, overlap = OCR_TUNING.detOverlap) {
  const axis = (n) => {
    const size = Math.min(tile, Math.ceil(n / 32) * 32)
    if (n <= size) return [{ start: 0, size, keep0: 0, keep1: n }]
    const step = size - overlap
    const count = Math.ceil((n - overlap) / step)
    const out = []
    for (let i = 0; i < count; i++) {
      const start = Math.min(i * step, n - size)
      out.push({ start, size })
    }
    for (let i = 0; i < out.length; i++) {
      const prev = out[i - 1],
        next = out[i + 1]
      out[i].keep0 = prev ? Math.round((prev.start + prev.size + out[i].start) / 2) : 0
      out[i].keep1 = next ? Math.round((out[i].start + out[i].size + next.start) / 2) : n
    }
    return out
  }
  const xs = axis(w),
    ys = axis(h)
  const tiles = []
  for (const ty of ys)
    for (const tx of xs)
      tiles.push({
        x: tx.start,
        y: ty.start,
        w: tx.size,
        h: ty.size,
        keep: { x0: tx.keep0, y0: ty.keep0, x1: tx.keep1, y1: ty.keep1 },
      })
  return tiles
}

/**
 * One tile of a grey raster as the detector's input: Float32 [3, t.h, t.w], the grey
 * value in all three channels normalised per channel, pixels past the raster's edge
 * repeating its last row and column.
 */
export function detInput(gray, w, h, t) {
  const plane = t.w * t.h
  const out = new Float32Array(3 * plane)
  for (let y = 0; y < t.h; y++) {
    const sy = Math.min(h - 1, t.y + y)
    for (let x = 0; x < t.w; x++) {
      const v = gray[sy * w + Math.min(w - 1, t.x + x)] / 255
      const i = y * t.w + x
      out[i] = (v - DET_MEAN[0]) / DET_STD[0]
      out[plane + i] = (v - DET_MEAN[1]) / DET_STD[1]
      out[2 * plane + i] = (v - DET_MEAN[2]) / DET_STD[2]
    }
  }
  return out
}

/** Copy a tile's kept probabilities into the raster-sized map. */
export function stitchTile(prob, w, tileProb, t) {
  const { x0, y0, x1, y1 } = t.keep
  for (let y = y0; y < y1; y++) {
    const row = (y - t.y) * t.w - t.x
    for (let x = x0; x < x1; x++) prob[y * w + x] = tileProb[row + x]
  }
}

/**
 * The text boxes in a probability map (DBPostProcess, PaddleOCR's "fast" box score):
 * pixels above `thresh` form 8-connected regions; each region's minimum-area rectangle
 * is kept when its short side is at least `minSize` and the mean probability inside it
 * reaches `boxThresh`, then grown by the unclip ratio. Returns
 * `[{ quad: [[x, y] ×4], score }]` in map pixels, corners ordered top-left first.
 */
export function dbBoxes(prob, w, h, opts = {}) {
  const {
    thresh = OCR_TUNING.detThresh,
    boxThresh = OCR_TUNING.detBoxThresh,
    unclipRatio = OCR_TUNING.unclipRatio,
    minSize = OCR_TUNING.detMinSize,
    maxCandidates = OCR_TUNING.detMaxCandidates,
  } = opts
  const label = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const boxes = []
  let regions = 0
  for (let start = 0; start < w * h; start++) {
    if (label[start] || !(prob[start] > thresh)) continue
    if (++regions > maxCandidates) break
    // Flood fill one region, keeping its boundary pixels (the hull needs no others).
    let top = 0
    stack[top++] = start
    label[start] = regions
    const boundary = []
    while (top) {
      const p = stack[--top]
      const px = p % w,
        py = (p - px) / w
      let edge = false
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = px + dx,
            ny = py + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            edge = true
            continue
          }
          const q = ny * w + nx
          if (!(prob[q] > thresh)) {
            edge = true
            continue
          }
          if (!label[q]) {
            label[q] = regions
            stack[top++] = q
          }
        }
      if (edge) boundary.push([px, py])
    }
    const rect = minAreaRect(boundary)
    if (!rect || Math.min(rect.w, rect.h) < minSize) continue
    const score = quadMean(prob, w, h, rectCorners(rect))
    if (score < boxThresh) continue
    const grown = unclipRect(rect, unclipRatio)
    if (Math.min(grown.w, grown.h) < minSize + 2) continue
    const quad = orderQuad(rectCorners(grown)).map(([x, y]) => [clamp(x, 0, w), clamp(y, 0, h)])
    boxes.push({ quad, score })
  }
  return boxes
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

// Mean probability over the pixels whose centres lie inside a quad (box_score_fast).
function quadMean(prob, w, h, quad) {
  const [bx0, by0, bx1, by1] = polyBounds(quad)
  const x0 = clamp(Math.floor(bx0), 0, w - 1),
    x1 = clamp(Math.ceil(bx1), 0, w - 1)
  const y0 = clamp(Math.floor(by0), 0, h - 1),
    y1 = clamp(Math.ceil(by1), 0, h - 1)
  let sum = 0,
    n = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (insideConvex(quad, x, y)) {
        sum += prob[y * w + x]
        n++
      }
  return n ? sum / n : 0
}

/**
 * Find the text lines on a grey raster: tiles through `run(input, dims)` (resolving to
 * the network's Float32 output for one tile), stitched, then dbBoxes. Boxes come back
 * in the raster's pixels with their DB score. `onTile(i, n)` reports progress.
 */
export async function detectText(gray, w, h, run, opts = {}) {
  const { tile = OCR_TUNING.detTile, overlap = OCR_TUNING.detOverlap, onTile, signal } = opts
  const prob = new Float32Array(w * h)
  const tiles = detTiles(w, h, tile, overlap)
  for (let i = 0; i < tiles.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const t = tiles[i]
    const out = await run(detInput(gray, w, h, t), [1, 3, t.h, t.w])
    stitchTile(prob, w, out, t)
    onTile?.(i + 1, tiles.length)
  }
  return { boxes: dbBoxes(prob, w, h, opts), tiles: tiles.length }
}
