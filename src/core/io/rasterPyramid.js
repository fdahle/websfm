// Tiled image pyramids for compute images past the browser's canvas limit (dev plan
// SAT-4). Pure: geometry and the container index only — no canvas, no worker.
//
// A native KH-9 mapping-camera scan is ~65,700 × 32,900 px (2.2 GP). Chrome caps one
// canvas at 32,767 px a side and ~268 MP, and an ImageBitmap or PNG of it cannot be
// made either, while every compute consumer read its image through one full decode
// (rasterize → createImageBitmap). No default step needs native pixels in one piece,
// though: detection works at ≤ 6,000 px, depth at Medium is ¼ native, and fiducial /
// GCP work reads small windows. So the image is stored as a pyramid of tiles and read
// at the level a request needs.
//
// Levels. Level 0 is native; level k is the 2×2 box mean of level k−1, so its grid
// is native scaled by exactly 2^-k in the pixel-centre convention (geometry.js
// toScaledPx: native x ↔ (x + ½)·2^-k − ½). Its size is ceil(native / 2^k): an odd
// edge leaves a partial last pixel, whose box replicates the edge. Levels stop at the
// first whose long side is ≤ `minLong`.
//
// Container. One Blob per image: every tile's PNG, level by level, row-major,
// concatenated; an index records each tile's byte offset and length. One file (not
// hundreds) in OPFS, and cheap to hand to a worker (a Blob is a handle; a tile is a
// slice).
//
//   index = { version: 1, width, height, tileSize, channels,
//             levels: [{ width, height, cols, rows, offsets: number[], lengths: number[] }] }

export const PYRAMID_VERSION = 1

// Above either limit an image becomes a pyramid: the canvas limits (32,767 px a side;
// 268 MP area, Chrome) with margin, so a transcode or full-resolution canvas is never
// attempted where it cannot exist.
export const PYRAMID_TUNING = {
  maxSidePx: 30000,
  maxAreaPx: 200e6,
  tileSize: 2048,
  minLong: 1024,
}

export function needsPyramid(width, height, t = PYRAMID_TUNING) {
  return width > t.maxSidePx || height > t.maxSidePx || width * height > t.maxAreaPx
}

/** The level sizes and tile grids for a width × height image. */
export function planPyramid(width, height, { tileSize = PYRAMID_TUNING.tileSize, minLong = PYRAMID_TUNING.minLong } = {}) {
  const levels = []
  let w = width, h = height
  for (;;) {
    levels.push({ width: w, height: h, cols: Math.ceil(w / tileSize), rows: Math.ceil(h / tileSize) })
    if (Math.max(w, h) <= minLong || (w === 1 && h === 1)) break
    w = Math.ceil(w / 2); h = Math.ceil(h / 2)
  }
  return { width, height, tileSize, levels }
}

/** Level k's scale against native (both axes): exactly 2^-k. */
export const levelScale = (k) => 2 ** -k

/**
 * The coarsest level that still holds `scale` × native: 2^-k ≥ scale. A request at
 * scale ≥ 1 reads level 0.
 */
export function levelFor(plan, scale) {
  if (!(scale < 1)) return 0
  const k = Math.floor(Math.log2(1 / scale) + 1e-9)
  return Math.max(0, Math.min(plan.levels.length - 1, k))
}

/**
 * Tiles of level `k` that a level-pixel rect [x0, x1) × [y0, y1) touches, each with
 * the part it supplies: { col, row, sx, sy, sw, sh } in tile pixels and { dx, dy } in
 * rect pixels.
 */
export function tilesForRect(plan, k, { x0, y0, x1, y1 }) {
  const L = plan.levels[k], ts = plan.tileSize
  const ax0 = Math.max(0, Math.floor(x0)), ay0 = Math.max(0, Math.floor(y0))
  const ax1 = Math.min(L.width, Math.ceil(x1)), ay1 = Math.min(L.height, Math.ceil(y1))
  const out = []
  if (ax1 <= ax0 || ay1 <= ay0) return out
  for (let row = Math.floor(ay0 / ts); row <= Math.floor((ay1 - 1) / ts); row++) {
    for (let col = Math.floor(ax0 / ts); col <= Math.floor((ax1 - 1) / ts); col++) {
      const tx0 = col * ts, ty0 = row * ts
      const sx = Math.max(ax0, tx0) - tx0, sy = Math.max(ay0, ty0) - ty0
      const sw = Math.min(ax1, tx0 + ts) - tx0 - sx, sh = Math.min(ay1, ty0 + ts) - ty0 - sy
      out.push({ col, row, sx, sy, sw, sh, dx: tx0 + sx - ax0, dy: ty0 + sy - ay0 })
    }
  }
  return out
}

/** A tile's size (the last column / row is partial). */
export function tileSize(plan, k, col, row) {
  const L = plan.levels[k], ts = plan.tileSize
  return { width: Math.min(ts, L.width - col * ts), height: Math.min(ts, L.height - row * ts) }
}

/** Byte range of a tile in the container. */
export function tileRange(index, k, col, row) {
  const L = index.levels[k], i = row * L.cols + col
  return { offset: L.offsets[i], length: L.lengths[i] }
}

/** Index a container from the plan and the encoded tile sizes (level by level, row-major). */
export function buildIndex(plan, tileLengths, channels) {
  let offset = 0, t = 0
  const levels = plan.levels.map((L) => {
    const n = L.cols * L.rows
    const offsets = new Array(n), lengths = new Array(n)
    for (let i = 0; i < n; i++, t++) { offsets[i] = offset; lengths[i] = tileLengths[t]; offset += tileLengths[t] }
    return { ...L, offsets, lengths }
  })
  if (t !== tileLengths.length) throw new Error(`pyramid index: ${tileLengths.length} tiles for a plan of ${t}`)
  return { version: PYRAMID_VERSION, width: plan.width, height: plan.height, tileSize: plan.tileSize, channels, levels, bytes: offset }
}

/**
 * Halve a band of rows (2×2 box mean, edge replicated for an odd width / a last odd
 * row). `src` holds `rows` rows of `width` px × `channels` bytes; returns
 * ceil(rows/2) rows of ceil(width/2) px. A trailing odd row is only correct at the
 * image's end — callers keep rows paired until then (createLevelCascade does).
 */
export function halveRows(src, width, rows, channels) {
  const w2 = Math.ceil(width / 2), r2 = Math.ceil(rows / 2)
  const out = new Uint8Array(w2 * r2 * channels)
  const stride = width * channels
  for (let y = 0; y < r2; y++) {
    const a = 2 * y * stride, b = Math.min(2 * y + 1, rows - 1) * stride
    for (let x = 0; x < w2; x++) {
      const p = 2 * x * channels, q = Math.min(2 * x + 1, width - 1) * channels
      for (let c = 0; c < channels; c++) {
        out[(y * w2 + x) * channels + c] = (src[a + p + c] + src[a + q + c] + src[b + p + c] + src[b + q + c] + 2) >> 2
      }
    }
  }
  return out
}

/**
 * Feed native rows top to bottom; every level's full tile rows come out as soon as
 * they are complete: onTileRow(k, y0, rows, data) with `rows` (≤ tileSize) rows of
 * the level's full width starting at level row y0. Memory: one tile row per level
 * plus a pending odd row — ~2·tileSize·width·channels bytes in all, never the image.
 */
export function createLevelCascade(plan, channels, onTileRow) {
  const ts = plan.tileSize
  const state = plan.levels.map((L) => ({ L, buf: new Uint8Array(ts * L.width * channels), filled: 0, y0: 0, carry: null }))
  const emit = (k) => {
    const s = state[k]
    if (!s.filled) return
    onTileRow(k, s.y0, s.filled, s.buf.subarray(0, s.filled * s.L.width * channels))
    s.y0 += s.filled; s.filled = 0
  }
  function push(k, data, rows) {
    const s = state[k]
    const rowBytes = s.L.width * channels
    let r = 0
    while (r < rows) {
      const take = Math.min(ts - s.filled, rows - r)
      s.buf.set(data.subarray(r * rowBytes, (r + take) * rowBytes), s.filled * rowBytes)
      s.filled += take; r += take
      if (s.filled === ts) emit(k)
    }
    if (k + 1 < state.length) {
      // Pair rows for the next level, carrying an odd one to the next push.
      let src = data, n = rows
      if (s.carry) {
        const joined = new Uint8Array((rows + 1) * rowBytes)
        joined.set(s.carry); joined.set(data.subarray(0, rows * rowBytes), rowBytes)
        src = joined; n = rows + 1; s.carry = null
      }
      const even = n - (n % 2)
      if (n % 2) s.carry = src.slice(even * rowBytes, (even + 1) * rowBytes)
      if (even) push(k + 1, halveRows(src.subarray(0, even * rowBytes), s.L.width, even, channels), even / 2)
    }
  }
  function finish(k = 0) {
    const s = state[k]
    if (k + 1 < state.length && s.carry) {
      push(k + 1, halveRows(s.carry, s.L.width, 1, channels), 1)
      s.carry = null
    }
    emit(k)
    if (k + 1 < state.length) finish(k + 1)
  }
  return { push: (data, rows) => push(0, data, rows), finish: () => finish(0) }
}
