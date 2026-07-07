// Tiled detection — the pure geometry/merge helpers behind native-resolution
// keypoint extraction. Running the detector on the whole (downsampled) image
// caps a learned detector at its output-grid density and OOMs the WebGPU EP on
// large inputs; instead we split the detect-space raster into overlapping tiles,
// run the detector per tile, offset the coords back, and merge. This module owns
// only the *math* (tile grid, sub-raster slice, positional NMS, auto tile size) —
// it's DOM/Vue/ORT-free so it unit-tests in Node. The orchestration (calling the
// SIFT/SuperPoint runners per tile) lives in workers/ops/detect.js, which is where
// the detectors already live.

/**
 * Cover a width×height raster with (possibly overlapping) tiles ≤ tileSize.
 * Steps by `tileSize − overlap`; the last row/column is pinned flush to the far
 * edge so no strip is ever left undetected. A dimension ≤ tileSize yields a single
 * full-span tile in that axis.
 *
 * @returns {{x:number,y:number,w:number,h:number}[]} tile origins + sizes (px)
 */
export function planTiles(width, height, tileSize, overlap) {
  const ts = Math.max(1, Math.floor(tileSize))
  const ov = Math.max(0, Math.min(Math.floor(overlap) || 0, ts - 1))
  const step = Math.max(1, ts - ov)
  const starts = (total) => {
    if (total <= ts) return [0]
    const s = []
    for (let p = 0; p + ts < total; p += step) s.push(p)
    const last = total - ts
    if (s[s.length - 1] !== last) s.push(last) // flush the final tile to the edge
    return s
  }
  const xs = starts(width)
  const ys = starts(height)
  const tiles = []
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x, y, w: Math.min(ts, width - x), h: Math.min(ts, height - y) })
    }
  }
  return tiles
}

/**
 * Copy one tile's RGBA pixels out of a full-raster RGBA buffer into a tight
 * tile-local buffer the detector runner can consume directly.
 *
 * @param {Uint8ClampedArray|Uint8Array} data  full raster, RGBA row-major, w*h*4
 * @param {number} width  full raster width (px)
 * @param {number} _height  full raster height (px) — for symmetry/validation
 * @param {{x:number,y:number,w:number,h:number}} tile
 * @returns {Uint8ClampedArray} tile RGBA, tile.w*tile.h*4
 */
export function sliceRaster(data, width, _height, tile) {
  const { x, y, w, h } = tile
  const out = new Uint8ClampedArray(w * h * 4)
  const rowBytes = w * 4
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * width + x) * 4
    out.set(data.subarray(src, src + rowBytes), row * rowBytes)
  }
  return out
}

/**
 * Positional non-max suppression over merged keypoints: keep the highest-response
 * point within `radius` px of any already-kept one. Duplicates only really arise
 * in the overlap bands (one blob detected in two adjacent tiles), so this is the
 * seam-dedup step. Grid-accelerated (cell = radius) so it stays ~O(n) on the
 * 10–20k points tiling can produce.
 *
 * @param {{x:number,y:number,response:number}[]} items
 * @param {number} radius  suppression radius in the same px space as x,y
 * @returns {number[]} kept indices into `items`, strongest-response first
 */
export function nmsByPosition(items, radius) {
  const n = items.length
  if (n === 0) return []
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => items[b].response - items[a].response)
  if (!(radius > 0)) return order // radius 0 ⇒ no dedup, just response-sorted

  const cell = radius
  const r2 = radius * radius
  const grid = new Map() // "cx,cy" → kept indices in that cell
  const kept = []
  for (const i of order) {
    const { x, y } = items[i]
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    let dup = false
    for (let gx = cx - 1; gx <= cx + 1 && !dup; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !dup; gy++) {
        const bucket = grid.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const j of bucket) {
          const dx = items[j].x - x
          const dy = items[j].y - y
          if (dx * dx + dy * dy < r2) { dup = true; break }
        }
      }
    }
    if (dup) continue
    kept.push(i)
    const key = `${cx},${cy}`
    const b = grid.get(key)
    if (b) b.push(i)
    else grid.set(key, [i])
  }
  return kept
}

/**
 * Largest GPU-safe square tile for a given storage-buffer binding limit. A fully
 * convolutional detector's peak activation is ≈ tile_area × channels × 4 B; we
 * invert that against `maxBindingBytes` with a safety margin, round down to a
 * GPU-friendly multiple of 32, and clamp. With no GPU info (CPU SIFT, or no
 * adapter) memory isn't the constraint, so return the large `max` default.
 *
 * @param {object} a
 * @param {number} a.maxBindingBytes  adapter maxStorageBufferBindingSize (0 = unknown)
 * @param {number} [a.bytesPerPx=512]  peak channels×4 proxy (128ch conservative)
 * @param {number} [a.safety=0.6]
 * @param {number} [a.min=384] @param {number} [a.max=1536]
 * @returns {number} tile size (px)
 */
export function autoTileSize({ maxBindingBytes, bytesPerPx = 512, safety = 0.6, min = 384, max = 1536 }) {
  if (!(maxBindingBytes > 0)) return max
  const px = Math.sqrt((maxBindingBytes * safety) / bytesPerPx)
  const rounded = Math.floor(px / 32) * 32
  return Math.max(min, Math.min(max, rounded))
}
