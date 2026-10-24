/* global FileReaderSync */
// Compute-image sources for the workers: a plain image URL (decoded whole, as
// always) or a tiled pyramid (core/io/rasterPyramid.js) for an image past the canvas
// limit. Worker-only (OffscreenCanvas, Compression/DecompressionStream).
//
// Tiles are the raw pixel bytes (1 channel for a gray scan, 3 for RGB), deflate-raw
// compressed — not PNG: reading one needs no image decode, only an inflate and a row
// copy, and a gray scan stays one byte per pixel instead of the canvas's four. Built
// with the native CompressionStream; read with fflate's synchronous inflate, so a
// window read is synchronous like a bitmap crop (the fiducial matcher's callback is).
//
//   descriptor = { kind: 'pyramid', index, blob }   (index: rasterPyramid buildIndex)

import {
  planPyramid,
  buildIndex,
  createLevelCascade,
  levelFor,
  levelScale,
  tilesForRect,
  tileRange,
  PYRAMID_TUNING,
} from '../core/io/rasterPyramid.js'
import { percentileRange } from '../core/io/tonalStretch.js'
import { readTiffTag } from '../utils/tiff.js'
import { inflateSync } from 'fflate'

export const isPyramid = (src) => src?.kind === 'pyramid'

async function deflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).blob()
}

let geotiffModule
async function openTiff(blob) {
  geotiffModule ??= import('geotiff')
  const g = await geotiffModule
  // fromBlob reads ranges with FileReader (browser); node tests hand small blobs whole.
  return typeof FileReader === 'undefined' ? g.fromArrayBuffer(await blob.arrayBuffer()) : g.fromBlob(blob)
}

// ── build ───────────────────────────────────────────────────────────────────

/**
 * Build a pyramid from a TIFF without decoding it whole: row bands are read by
 * window (geotiff), converted to 8-bit gray or RGB (16-bit: stretched between the
 * 0.5 / 99.5 % levels of an overview, as the full transcode does), and streamed
 * through the level cascade; each finished tile is compressed at once.
 * Returns { index, blob, displayBlob, thumbBlob, srcInfo }.
 */
export async function buildPyramidFromTiff(
  file,
  {
    tileSize = PYRAMID_TUNING.tileSize,
    minLong = PYRAMID_TUNING.minLong,
    onProgress,
    displayMax = 8192,
    previews = true,
  } = {},
) {
  const tiff = await openTiff(file)
  const image = await tiff.getImage()
  const W = image.getWidth(),
    H = image.getHeight()
  const spp = image.getSamplesPerPixel()
  const fd = image.getFileDirectory()
  const bpsRaw = image.getBitsPerSample?.() ?? (await readTiffTag(fd, 'BitsPerSample'))
  const bps = Array.isArray(bpsRaw) ? bpsRaw[0] : bpsRaw
  const photometric = image.getPhotometricInterpretation?.() ?? (await readTiffTag(fd, 'PhotometricInterpretation'))
  const gray = (spp === 1 || spp === 2) && (photometric === 0 || photometric === 1)
  const channels = gray ? 1 : 3
  const plain = (bps === 8 || bps === 16) && (gray || photometric === 2)
  const srcInfo = {
    width: W,
    height: H,
    samplesPerPixel: spp,
    bitsPerSample: bps,
    photometric,
    srcBytes: file.size,
    channels,
  }

  // 16-bit: one stretch for the whole image, from a decimated overview.
  let range = null
  if (plain && bps === 16) {
    const s = Math.min(1, 2048 / Math.max(W, H))
    const ov = await image.readRasters({
      interleave: true,
      width: Math.max(1, Math.round(W * s)),
      height: Math.max(1, Math.round(H * s)),
    })
    range = percentileRange(ov, spp)
    srcInfo.stretch = range
  }
  const toChannels = (raw, rows) => {
    const n = W * rows,
      out = new Uint8Array(n * channels)
    if (!plain) {
      // readRGB: always 3 channels. A gray scan that is not 8/16-bit (1/4/12-bit,
      // float) comes back with R = G = B, so it keeps one channel: its R.
      if (channels === 3) {
        out.set(raw.subarray ? raw.subarray(0, n * 3) : Array.prototype.slice.call(raw, 0, n * 3))
        return out
      }
      for (let i = 0; i < n; i++) out[i] = raw[i * 3]
      return out
    }
    const lo = range?.lo ?? 0,
      span = range ? Math.max(1, range.hi - range.lo) : 1
    const invert = gray && photometric === 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        let v = raw[i * spp + c]
        if (range) v = Math.min(255, Math.max(0, Math.round(((v - lo) * 255) / span)))
        out[i * channels + c] = invert ? 255 - v : v
      }
    }
    return out
  }

  const plan = planPyramid(W, H, { tileSize, minLong })
  const tiles = plan.levels.map((L) => new Array(L.cols * L.rows))
  const pending = []
  const cascade = createLevelCascade(plan, channels, (k, y0, rows, data) => {
    const L = plan.levels[k]
    const row = y0 / tileSize
    for (let col = 0; col < L.cols; col++) {
      const x0 = col * tileSize,
        w = Math.min(tileSize, L.width - x0)
      const t = new Uint8Array(w * rows * channels)
      for (let r = 0; r < rows; r++)
        t.set(data.subarray((r * L.width + x0) * channels, (r * L.width + x0 + w) * channels), r * w * channels)
      pending.push(
        deflate(t).then((b) => {
          tiles[k][row * L.cols + col] = b
        }),
      )
    }
  })
  for (let y = 0; y < H; y += tileSize) {
    const y1 = Math.min(H, y + tileSize)
    const window = [0, y, W, y1]
    const raw = plain
      ? await image.readRasters({ window, interleave: true })
      : await image.readRGB({ window, interleave: true })
    cascade.push(toChannels(raw, y1 - y), y1 - y)
    // Keep at most a few bands' tiles compressing at once.
    if (pending.length > 4 * plan.levels[0].cols) await Promise.all(pending.splice(0))
    onProgress?.(y1, H)
  }
  cascade.finish()
  await Promise.all(pending)
  const flat = tiles.flat()
  const index = buildIndex(
    plan,
    flat.map((b) => b.size),
    channels,
  )
  const desc = { kind: 'pyramid', index, blob: new Blob(flat) }

  if (!previews) return { ...desc, displayBlob: null, thumbBlob: null, srcInfo }
  // Display JPEG and thumbnail from the levels, never from native pixels.
  const levelAt = (maxLong) => plan.levels.findIndex((L) => Math.max(L.width, L.height) <= maxLong)
  const displayBlob = await encodeLevel(desc, Math.max(0, levelAt(displayMax)), 'image/jpeg', 0.9)
  const tk = levelAt(1024)
  const thumbBlob = await encodeLevel(desc, tk < 0 ? plan.levels.length - 1 : tk, 'image/jpeg', 0.7, 512)
  return { ...desc, displayBlob, thumbBlob, srcInfo }
}

async function encodeLevel(desc, k, type, quality, maxLong = Infinity) {
  const L = desc.index.levels[k]
  const r = readLevelRect(await openPyramid(desc), k, { x0: 0, y0: 0, x1: L.width, y1: L.height })
  // CPU canvases (as core/mask.js maskFromSource): pixels in, an encode out.
  let canvas = new OffscreenCanvas(r.width, r.height)
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(r.data, r.width, r.height), 0, 0)
  if (Math.max(r.width, r.height) > maxLong) {
    const s = maxLong / Math.max(r.width, r.height)
    const small = new OffscreenCanvas(Math.max(1, Math.round(r.width * s)), Math.max(1, Math.round(r.height * s)))
    small.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, small.width, small.height)
    canvas = small
  }
  return canvas.convertToBlob({ type, quality })
}

// ── read ────────────────────────────────────────────────────────────────────

// Decoded tiles, bounded by bytes (fiducial and GCP windows revisit the same tiles).
const TILE_CACHE_BYTES = 256 * 1024 ** 2
const tileCache = new Map()
let tileCacheBytes = 0
/**
 * Open a pyramid for synchronous reads. In a worker each tile's bytes are sliced off
 * the Blob on demand with FileReaderSync — the container (1–3 GB for a native KH-9
 * frame) is never held whole. Without FileReaderSync (node tests) the Blob is read
 * once into memory.
 */
export async function openPyramid(desc) {
  if (typeof FileReaderSync !== 'undefined') {
    const reader = new FileReaderSync()
    return {
      ...desc,
      readRange: (offset, length) => new Uint8Array(reader.readAsArrayBuffer(desc.blob.slice(offset, offset + length))),
    }
  }
  const bytes = new Uint8Array(await desc.blob.arrayBuffer())
  return { ...desc, readRange: (offset, length) => bytes.subarray(offset, offset + length) }
}

function tileBytes(src, k, col, row) {
  const key = `${src.index.bytes}:${src.blob.size}:${k}:${col}:${row}`
  const hit = tileCache.get(key)
  if (hit) {
    tileCache.delete(key)
    tileCache.set(key, hit)
    return hit
  }
  const { offset, length } = tileRange(src.index, k, col, row)
  const bytes = inflateSync(src.readRange(offset, length))
  tileCache.set(key, bytes)
  tileCacheBytes += bytes.length
  while (tileCacheBytes > TILE_CACHE_BYTES && tileCache.size > 1) {
    const [oldKey, old] = tileCache.entries().next().value
    tileCache.delete(oldKey)
    tileCacheBytes -= old.length
  }
  return bytes
}

/** RGBA pixels of a level-pixel rect of level k (clipped to the level); `src` from openPyramid. */
export function readLevelRect(src, k, rect) {
  const { index } = src
  const L = index.levels[k],
    C = index.channels,
    ts = index.tileSize
  const x0 = Math.max(0, Math.floor(rect.x0)),
    y0 = Math.max(0, Math.floor(rect.y0))
  const x1 = Math.min(L.width, Math.ceil(rect.x1)),
    y1 = Math.min(L.height, Math.ceil(rect.y1))
  const w = Math.max(0, x1 - x0),
    h = Math.max(0, y1 - y0)
  const out = new Uint8ClampedArray(w * h * 4)
  for (const p of tilesForRect(index, k, { x0, y0, x1, y1 })) {
    const t = tileBytes(src, k, p.col, p.row)
    const tw = Math.min(ts, L.width - p.col * ts)
    for (let r = 0; r < p.sh; r++) {
      let s = ((p.sy + r) * tw + p.sx) * C,
        d = ((p.dy + r) * w + p.dx) * 4
      for (let x = 0; x < p.sw; x++, s += C, d += 4) {
        if (C === 1) {
          out[d] = out[d + 1] = out[d + 2] = t[s]
        } else {
          out[d] = t[s]
          out[d + 1] = t[s + 1]
          out[d + 2] = t[s + 2]
        }
        out[d + 3] = 255
      }
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * rasterize() for a pyramid: the whole image, long side ≤ maxDim, with the same
 * result shape ({ data, width, height, scale, scaleXY, natW, natH }).
 */
export function rasterizePyramid(src, maxDim) {
  const { width: natW, height: natH } = src.index
  const scale = Math.min(1, maxDim / Math.max(natW, natH))
  // Within 2 % of a level: that level as it is, no resample (and none of the canvas
  // copies a resample makes — each the size of the result).
  const k = levelFor(src.index, scale, { slack: LEVEL_SLACK })
  const L = src.index.levels[k]
  if (k > 0 && L.width >= (natW * scale) / (1 + LEVEL_SLACK)) {
    const lvl = readLevelRect(src, k, { x0: 0, y0: 0, x1: L.width, y1: L.height })
    // A level's pixel is exactly 2^k native pixels (rasterPyramid.js), whatever its
    // last partial column.
    const s = levelScale(k)
    return { data: lvl.data, width: L.width, height: L.height, scale: s, scaleXY: [s, s], natW, natH }
  }
  const r = rasterizePyramidTo(src, Math.max(1, Math.round(natW * scale)), Math.max(1, Math.round(natH * scale)))
  return { ...r, scale }
}
const LEVEL_SLACK = 0.02

/**
 * The whole image resampled to exactly width × height: the coarsest level at or above
 * that scale, resampled over the native extent (edge-aligned, as drawImage of the
 * full image does), so `scaleXY` = target / native per axis exactly as for a URL.
 */
export function rasterizePyramidTo(src, width, height) {
  const { width: natW, height: natH } = src.index
  if (
    width > PYRAMID_TUNING.maxSidePx ||
    height > PYRAMID_TUNING.maxSidePx ||
    width * height > PYRAMID_TUNING.maxAreaPx
  ) {
    throw new Error(
      `rasterize: ${width}×${height} px of a ${natW}×${natH} image exceeds one canvas ` +
        `(≤ ${PYRAMID_TUNING.maxSidePx} px a side, ≤ ${PYRAMID_TUNING.maxAreaPx / 1e6} MP) — use a lower resolution`,
    )
  }
  const k = levelFor(src.index, Math.max(width / natW, height / natH))
  const L = src.index.levels[k]
  const lvl = readLevelRect(src, k, { x0: 0, y0: 0, x1: L.width, y1: L.height })
  let data = lvl.data
  if (width !== L.width || height !== L.height) {
    const from = new OffscreenCanvas(L.width, L.height)
    from.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(lvl.data, L.width, L.height), 0, 0)
    const dst = new OffscreenCanvas(width, height)
    const ctx = dst.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingQuality = 'high'
    // The native extent in level pixels (the last pixel may be partial).
    const s = levelScale(k)
    ctx.drawImage(from, 0, 0, natW * s, natH * s, 0, 0, width, height)
    data = ctx.getImageData(0, 0, width, height).data
  }
  return { data, width, height, scale: width / natW, scaleXY: [width / natW, height / natH], natW, natH }
}

/** RGBA of a native-pixel rect (fiducial / GCP windows), at level 0. */
export function readNativeRect(src, rect) {
  return readLevelRect(src, 0, rect)
}
