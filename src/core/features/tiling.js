// Tiled detection — the pure geometry/merge helpers behind native-resolution
// keypoint extraction. Running the detector on the whole (downsampled) image
// caps a learned detector at its output-grid density and OOMs the WebGPU EP on
// large inputs; instead we split the detect-space raster into overlapping tiles,
// run the detector per tile, offset the coords back, and merge. This module owns
// only the *math* (tile grid, sub-raster slice, positional NMS, auto tile size) —
// it's DOM/Vue/ORT-free so it unit-tests in Node. The orchestration (calling the
// SIFT/SuperPoint runners per tile) lives in workers/ops/detect.js, which is where
// the detectors already live.

// The merge is by OWNERSHIP, not by deduplication. Every tile detects over its
// whole extent, but keeps only the keypoints inside its *core*, and the cores
// partition the image. Inside the overlap, the core boundary is the overlap's
// midpoint, so a kept keypoint is always ≥ overlap/2 from any cut edge. That
// clearance is what the overlap buys: SIFT's descriptor window reaches ~10.6σ
// and the clamp-to-edge blur leaks ~3σ further, so a keypoint closer than ~14σ
// to a cut edge gets a different descriptor than the untiled detector would give
// it. The earlier design kept every tile's keypoints and NMS'd the union. That
// left ~2/3 of keypoints with a near-identical twin from a neighbouring tile:
// bit-identical twins passed as orientation siblings, and coarse-scale twins sat
// beyond the NMS radius. The ratio test then rejects BOTH copies, since a
// feature's nearest and second-nearest neighbours are the same blob. On South
// Building that cut putatives 4×.

/**
 * SIFT tile-origin alignment (px). The crate downsamples by plain decimation
 * (even pixels) for up to 5 octaves, so an origin that is a multiple of 2⁴ puts
 * every octave's sample grid on the untiled run's grid. Away from cut edges, a
 * tile then reproduces the untiled detector's keypoints exactly.
 */
export const SIFT_TILE_ALIGN = 16
/** SuperPoint's output cell (px): align origins so tiles share the cell grid. */
export const SUPERPOINT_TILE_ALIGN = 8
/**
 * Cross-tile duplicate radius (detect px), equal to the crate's own
 * `DEDUP_RADIUS_PX`. With ownership, the only duplicates left are one blob
 * localised on both sides of a core boundary.
 */
export const SEAM_NMS_RADIUS = 2

/**
 * Cover a width×height raster with overlapping tiles of at most `tileSize`.
 * `tileSize` is an upper bound: each axis uses the fewest tiles that fit, shrunk to
 * the smallest size that still overlaps every seam by ≥ `overlap`, and spread
 * evenly. The previous edge-pinned final tile could instead overlap its neighbour
 * almost completely, which doubled the detection work for nothing. Origins are
 * rounded up to a multiple of `align`, so the last tile may be up to `align − 1` px
 * narrower than the others. A dimension ≤ tileSize gets a single full-span tile in
 * that axis.
 *
 * Each tile carries `core = {x0, x1, y0, y1}`, the half-open region it owns
 * (±Infinity on image edges). Cores partition the plane; use `tileOwns`.
 *
 * @param {{align?: number}} [opts]
 * @returns {{x:number,y:number,w:number,h:number,core:{x0:number,x1:number,y0:number,y1:number}}[]}
 */
export function planTiles(width, height, tileSize, overlap, { align = 1 } = {}) {
  const ts = Math.max(1, Math.floor(tileSize))
  const ov = Math.max(0, Math.min(Math.floor(overlap) || 0, ts - 1))
  const al = Math.max(1, Math.min(Math.floor(align) || 1, ts))
  const ceilTo = (v) => Math.ceil(v / al) * al
  const axis = (total) => {
    if (total <= ts) return [{ start: 0, size: total, lo: -Infinity, hi: Infinity }]
    // Fewest tiles that leave ≥ ov overlap after rounding origins up to `al`…
    const stepMax = Math.max(1, ts - ov - (al - 1))
    const n = 1 + Math.ceil((total - ts) / stepMax)
    // …then the smallest tile size that still does, so the overlap is what was asked
    // for rather than whatever slack n·tileSize leaves (a 3072 px axis in 1536 px
    // tiles needs 3 tiles, which at full size would overlap by 768 px each).
    const size = Math.min(ts, Math.ceil((total + (n - 1) * (ov + al - 1)) / n))
    const span = total - size
    const starts = []
    for (let i = 0; i < n; i++) {
      const s = i === 0 ? 0 : ceilTo((i * span) / (n - 1))
      if (s !== starts[starts.length - 1]) starts.push(s)
    }
    const spans = starts.map((start) => ({ start, size: Math.min(size, total - start), lo: -Infinity, hi: Infinity }))
    for (let i = 0; i + 1 < spans.length; i++) {
      // Core boundary = midpoint of the overlap with the next tile.
      const cut = Math.floor((spans[i + 1].start + spans[i].start + spans[i].size) / 2)
      spans[i].hi = cut
      spans[i + 1].lo = cut
    }
    return spans
  }
  const xs = axis(width)
  const ys = axis(height)
  const tiles = []
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x: x.start, y: y.start, w: x.size, h: y.size, core: { x0: x.lo, x1: x.hi, y0: y.lo, y1: y.hi } })
    }
  }
  return tiles
}

/** Does `tile` own the full-raster point (x, y)? Exactly one tile of a plan does. */
export function tileOwns(tile, x, y) {
  const c = tile.core
  return x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1
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
 * point within `radius` px of any already-kept one. Grid-accelerated (cell =
 * radius) so it stays ~O(n) on the 10–20k points tiling can produce.
 *
 * Items carrying a `tile` id are only suppressed by a kept item from a DIFFERENT
 * tile: this is the seam step after ownership filtering, and the detector has
 * already deduplicated each tile's own output. Suppressing within a tile would
 * thin the interior differently from an untiled run.
 *
 * Orientation siblings — the keypoints SIFT emits for one extremum's secondary
 * orientations (crates/sift `max_orientations`) — carry bit-identical x, y and scale
 * and are not duplicates of each other; a sibling survives iff no NON-sibling within
 * `radius` was kept, exactly like the crate's own suppression. The stable sort keeps
 * the dominant orientation ahead of its (equal-response) siblings. Items without a
 * `scale` (SuperPoint) never count as siblings.
 *
 * @param {{x:number,y:number,response:number,scale?:number,tile?:number}[]} items
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
    const { x, y, scale, tile } = items[i]
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    let dup = false
    for (let gx = cx - 1; gx <= cx + 1 && !dup; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !dup; gy++) {
        const bucket = grid.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const j of bucket) {
          const o = items[j]
          if (tile !== undefined && o.tile === tile) continue // same tile: the detector already deduplicated it
          if (scale !== undefined && o.x === x && o.y === y && o.scale === scale) continue // sibling
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
