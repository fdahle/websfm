// Mask helpers shared by the compute worker (consuming masks during SIFT/MVS),
// the Mask Manager modal, and the image viewer's inline import.
//
// Convention: a mask marks the pixels to EXCLUDE. Stored masks are PNGs where
// excluded pixels are opaque red (255,0,0,255) and kept pixels are fully
// transparent (alpha 0). So "is this pixel masked?" reduces to an alpha test.
// `normalizeMaskPixels` converts an arbitrary imported image into that form, so
// every stored mask is uniform (see there for the import rule).
//
// Resolution: a mask is stored at the image's own size, except for a very large
// scan (one stored as a tiled pyramid, core/io/rasterPyramid.js), whose native size
// is past what a canvas can hold. Its mask is stored reduced (`maskStorageSize`).
// That is safe because every consumer rasterizes a mask to the size it works at
// (`buildMaskLookup`), never assuming the PNG is image-sized.

import { needsPyramid } from './io/rasterPyramid.js'

// ── Pure (DOM-free, unit-tested) ───────────────────────────────────────────────

// Build a flat 0/1 "is-masked" lookup (length w*h) from RGBA pixel data of a
// normalized mask. Masked == opaque. Used by the worker to drop keypoints/depth.
export function maskLookupFromRgba(data, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0
  return out
}

// Does an imported image carry transparency that means something: at least one
// pixel the alpha rule would keep (alpha ≤ 127)? A JPEG, or a PNG saved without an
// alpha channel, is opaque everywhere, and the alpha rule would mask all of it.
export function hasMaskTransparency(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] <= 127) return true
  return false
}

// Normalize arbitrary RGBA in place to the red-exclude / transparent-keep
// convention. Two rules, chosen per file:
//   • With transparency (hasMaskTransparency): a source pixel that is bright OR
//     opaque becomes excluded; transparent dark pixels are kept. The app's own
//     masks (red on transparent) round-trip through this rule unchanged.
//   • Opaque everywhere (JPEG, plain black-and-white PNG): by brightness, BLACK
//     (luminance < 128) is excluded and white is kept, as in Metashape and COLMAP
//     mask files. An all-red stored mask (fully masked, so no transparency) is dark
//     and stays fully masked.
export function normalizeMaskPixels(data) {
  const byAlpha = hasMaskTransparency(data)
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    const excluded = byAlpha ? lum > 127 || data[i + 3] > 127 : lum < 128
    if (excluded) {
      data[i] = 255
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 255
    } else {
      data[i + 3] = 0
    }
  }
  return data
}

// Does an RGBA buffer contain any excluded (opaque, alpha > 127) pixel? Used to
// detect when an erase has removed the last of a mask so it can be dropped
// rather than persisted as an all-transparent PNG. Mirrors the alpha test in
// maskLookupFromRgba.
export function anyExcluded(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] > 127) return true
  return false
}

// Invert a normalized mask in place: excluded pixels (opaque, alpha > 127)
// become kept (transparent), kept pixels become excluded (opaque red). Returns
// the number of excluded pixels AFTER inversion so callers can tell an
// all-clear result (0) from a mask worth keeping.
export function invertMaskPixels(data) {
  let excluded = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 127) {
      data[i + 3] = 0
    } else {
      data[i] = 255
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 255
      excluded++
    }
  }
  return excluded
}

// Paint the outer border of an RGBA buffer to the red-exclude convention. `sides`
// gives the per-edge margin in pixels (top/right/bottom/left, default 0). Margins
// are clamped to half the corresponding dimension, so a side ≥ w/2 (or h/2) simply
// masks everything inward rather than wrapping. Mutates and returns `data`.
// Pure: the unit-testable core of the Auto-Mask "border" strategy.
export function paintBorderExclude(data, w, h, { top = 0, right = 0, bottom = 0, left = 0 } = {}) {
  const t = Math.max(0, Math.min(Math.round(top), Math.floor(h / 2)))
  const b = Math.max(0, Math.min(Math.round(bottom), Math.floor(h / 2)))
  const l = Math.max(0, Math.min(Math.round(left), Math.floor(w / 2)))
  const r = Math.max(0, Math.min(Math.round(right), Math.floor(w / 2)))
  for (let y = 0; y < h; y++) {
    const inV = y >= t && y < h - b // inside the top/bottom bands?
    for (let x = 0; x < w; x++) {
      if (inV && x >= l && x < w - r) continue // interior — leave untouched
      const o = (y * w + x) * 4
      data[o] = 255
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = 255
    }
  }
  return data
}

// The size a mask for a w×h image is stored at. Native, except for an image past
// the canvas limit (needsPyramid — where no native-size canvas can exist): then
// reduced so its long side is MASK_LARGE_LONG_SIDE (the cap on such an image's
// display copy, so the viewer never shows it coarser than the mask). Returns { w, h, scale } (scale = stored / native, ≤ 1).
export const MASK_LARGE_LONG_SIDE = 8192
export function maskStorageSize(w, h) {
  if (!needsPyramid(w, h)) return { w, h, scale: 1 }
  const scale = MASK_LARGE_LONG_SIDE / Math.max(w, h)
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale }
}

// Per-side border margins (native px) at a stored mask's `scale`, rounded UP so a
// reduced mask still covers at least the requested band.
export function scaleBorderSides(sides, scale) {
  if (scale === 1) return sides
  const out = {}
  for (const k of ['top', 'right', 'bottom', 'left']) out[k] = Math.ceil((sides[k] ?? 0) * scale)
  return out
}

// Nearest-neighbour upsample of a 0/1 lookup from sw×sh to w×h. Lets
// buildMaskLookup serve a working size past the canvas limit from a smaller raster.
export function upsampleLookupNearest(lut, sw, sh, w, h) {
  const out = new Uint8Array(w * h)
  const xs = new Uint32Array(w)
  for (let x = 0; x < w; x++) xs[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w))
  for (let y = 0; y < h; y++) {
    const row = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h)) * sw
    const o = y * w
    for (let x = 0; x < w; x++) out[o + x] = lut[row + xs[x]]
  }
  return out
}

// ── Canvas I/O (works on main thread and in workers via OffscreenCanvas) ───────
//
// A mask travels as a PNG **Blob**: its bytes live outside the V8 heap, and posting
// one to a worker clones a reference, not the bytes. A base64 data URL string is the
// opposite on both counts — it was held per image for the whole session.

// A data URL decoded synchronously into a Blob (atob; no fetch).
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(5, comma)
  const type = head.split(';')[0] || 'application/octet-stream'
  const body = dataUrl.slice(comma + 1)
  if (!head.includes(';base64')) return new Blob([decodeURIComponent(body)], { type })
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

// Any mask source — a Blob/File, or a data:/blob: URL string — as a Blob.
export async function maskBlob(source) {
  if (typeof source !== 'string') return source
  return source.startsWith('data:') ? dataUrlToBlob(source) : (await fetch(source)).blob()
}

// Decode any mask source (File/Blob or a URL string), draw it into a canvas for a
// w×h image (maskStorageSize: w×h itself unless the image is a very large scan),
// normalize to the exclude convention, and return the PNG Blob. Used for importing
// a file as a mask and for rescaling a mask across images of a different resolution.
export async function maskFromSource(source, nativeW, nativeH) {
  const { w, h } = maskStorageSize(nativeW, nativeH)
  const blob = await maskBlob(source)
  const bmp = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const id = ctx.getImageData(0, 0, w, h)
  normalizeMaskPixels(id.data)
  ctx.putImageData(id, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

// Rasterize a stored mask (Blob or URL) to a w×h "is-masked" lookup. Used by the
// compute worker to test keypoint / depth-map pixels against the mask.
// A working size past the canvas limit is rasterized reduced and upsampled.
export async function buildMaskLookup(source, w, h) {
  const bmp = await createImageBitmap(await maskBlob(source))
  const s = maskStorageSize(w, h)
  const canvas = new OffscreenCanvas(s.w, s.h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, s.w, s.h)
  bmp.close()
  const lut = maskLookupFromRgba(ctx.getImageData(0, 0, s.w, s.h).data, s.w, s.h)
  return s.scale === 1 ? lut : upsampleLookupNearest(lut, s.w, s.h, w, h)
}

// Build a border mask PNG Blob for a w×h image (at maskStorageSize) excluding the
// outer `sides` margins (native px). When `base` (an existing stored mask Blob or
// URL, already in exclude form) is given, it is drawn in first so the result is the
// UNION of that mask and the border (merge mode); pass null to start blank (replace
// mode). Used by Auto Mask's border and the fiducial frame masks.
export async function buildBorderMask(nativeW, nativeH, nativeSides, base = null) {
  const { w, h, scale } = maskStorageSize(nativeW, nativeH)
  const sides = scaleBorderSides(nativeSides, scale)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (base) {
    const bmp = await createImageBitmap(await maskBlob(base))
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
  }
  const id = ctx.getImageData(0, 0, w, h)
  paintBorderExclude(id.data, w, h, sides)
  ctx.putImageData(id, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}
