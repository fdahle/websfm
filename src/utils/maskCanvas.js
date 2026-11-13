// Mask canvas I/O: decoding a mask source, drawing it at a working size and encoding
// the PNG. The pixel rules (what is excluded, how sizes reduce) are pure and live in
// core/mask.js; this file only moves pixels in and out of canvases. Works on the main
// thread and in workers (OffscreenCanvas).

import {
  maskLookupFromRgba,
  maskStorageSize,
  normalizeMaskPixels,
  paintBorderExclude,
  scaleBorderSides,
  unionMaskPixels,
  upsampleLookupNearest,
} from '../core/mask.js'

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

// Any mask source drawn at w×h as ImageData: a File/Blob or URL string, or
// already-decoded pixels `{ width, height, rgba }` (a TIFF, which the browser
// cannot decode: workers/ops/tiff.js decodes it first).
async function rasterizeAt(source, w, h) {
  if (source?.rgba) {
    const rgba =
      source.rgba instanceof Uint8ClampedArray
        ? source.rgba
        : new Uint8ClampedArray(source.rgba.buffer, source.rgba.byteOffset, source.rgba.byteLength)
    const decoded = new ImageData(rgba, source.width, source.height)
    if (source.width === w && source.height === h) return decoded
    source = await createImageBitmap(decoded)
  } else {
    source = await createImageBitmap(await maskBlob(source))
  }
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  source.close()
  return ctx.getImageData(0, 0, w, h)
}

// Decode any mask source (see rasterizeAt), draw it for a w×h image
// (maskStorageSize: w×h itself unless the image is a very large scan), normalize
// to the exclude convention, and return the PNG Blob. With `base` (the image's
// stored mask) the result is the union of the two. Used for importing a file as a
// mask and for rescaling a mask across images of a different resolution.
export async function maskFromSource(source, nativeW, nativeH, { base = null } = {}) {
  const { w, h } = maskStorageSize(nativeW, nativeH)
  const id = await rasterizeAt(source, w, h)
  normalizeMaskPixels(id.data)
  if (base) unionMaskPixels(id.data, (await rasterizeAt(base, w, h)).data)
  // A CPU canvas: a GPU-backed one uploads the whole mask as one image, and a few
  // 10,000-px scan masks on parallel workers ran Chrome's GPU process out of memory
  // (Skia OOM, three GPU-process crashes, then the tab was on SwiftShader).
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(id, 0, 0)
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
