// List thumbnails (TODO ▸ SC-8): one small JPEG per image, made once and persisted
// (`images-derived/{uuid}.thumb`, utils/opfs.js), so lists, tables, grids and the 3D
// view's camera glyphs never decode the full-resolution photo per row. The pixel
// work runs in workers/thumbnail.worker.js; this file holds the size rule and the
// decode → resize → encode step, which needs only createImageBitmap + OffscreenCanvas
// (both exist in a worker), no DOM.

export const THUMB_MAX_DIM = 256
export const THUMB_QUALITY = 0.8
// Error-message prefix for a source URL that could not be read at all.
export const SOURCE_UNREADABLE = 'thumbnail source unreadable:'

// Output size: the long side becomes `maxDim` (never upscaled), aspect kept, ≥ 1 px.
export function thumbnailSize(width, height, maxDim = THUMB_MAX_DIM) {
  const w = Math.max(1, Math.round(width || 1)),
    h = Math.max(1, Math.round(height || 1))
  const s = Math.min(1, maxDim / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

// The createImageBitmap resize request. Only ONE side is given, so the browser keeps
// the (orientation-corrected) aspect ratio itself; asking for the side the hint says
// is longer lets a decoder that supports it decode at reduced size. A wrong or
// missing hint (EXIF rotation, unknown dims) only means the bitmap comes back a bit
// larger than needed and the canvas draw finishes the downscale.
export function decodeResizeOptions(hint, maxDim = THUMB_MAX_DIM) {
  const portrait = hint?.width > 0 && hint?.height > 0 && hint.height > hint.width
  const longSide = portrait ? hint.height : hint?.width
  if (longSide > 0 && longSide <= maxDim) return { resizeQuality: 'medium' }
  return portrait ? { resizeHeight: maxDim, resizeQuality: 'medium' } : { resizeWidth: maxDim, resizeQuality: 'medium' }
}

// source: a Blob, or a URL string (blob: URLs resolve in a worker of this origin).
// → { blob (image/jpeg), width, height, sourceWidth, sourceHeight }
export async function renderThumbnail(source, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY, hint = null } = {}) {
  let blob = source
  if (typeof source === 'string') {
    // Tagged so the caller can tell "the image's URL is dead" (heal the image) from
    // "this image will not decode" (give up on its thumbnail).
    let resp
    try {
      resp = await fetch(source)
    } catch (err) {
      throw new Error(`${SOURCE_UNREADABLE} ${err?.message ?? err}`)
    }
    if (!resp.ok) throw new Error(`${SOURCE_UNREADABLE} HTTP ${resp.status}`)
    blob = await resp.blob()
  }
  let bmp
  try {
    bmp = await createImageBitmap(blob, decodeResizeOptions(hint, maxDim))
  } catch {
    // An engine that rejects the resize options still decodes the plain call.
    bmp = await createImageBitmap(blob)
  }
  try {
    const { width, height } = thumbnailSize(bmp.width, bmp.height, maxDim)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, width, height)
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    return { blob: out, width, height, sourceWidth: bmp.width, sourceHeight: bmp.height }
  } finally {
    bmp.close?.()
  }
}
