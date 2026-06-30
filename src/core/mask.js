// Mask helpers shared by the compute worker (consuming masks during SIFT/MVS),
// the Mask Manager modal, and the image viewer's inline import.
//
// Convention: a mask marks the pixels to EXCLUDE. Stored masks are PNGs where
// excluded pixels are opaque red (255,0,0,255) and kept pixels are fully
// transparent (alpha 0). So "is this pixel masked?" reduces to an alpha test.
// `normalizeMaskPixels` converts an arbitrary imported image into that form
// (bright OR opaque source pixels → excluded), so every stored mask is uniform.

// ── Pure (DOM-free, unit-tested) ───────────────────────────────────────────────

// Build a flat 0/1 "is-masked" lookup (length w*h) from RGBA pixel data of a
// normalized mask. Masked == opaque. Used by the worker to drop keypoints/depth.
export function maskLookupFromRgba(data, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0
  return out
}

// Normalize arbitrary RGBA in place to the red-exclude / transparent-keep
// convention: a source pixel that is bright or opaque becomes excluded.
// Mirrors the original inline logic in ViewerImage's mask import.
export function normalizeMaskPixels(data) {
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    if (lum > 127 || data[i + 3] > 127) {
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255
    } else {
      data[i + 3] = 0
    }
  }
  return data
}

// ── Canvas I/O (works on main thread and in workers via OffscreenCanvas) ───────

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsDataURL(blob)
  })
}

// Decode any mask source (File/Blob or a dataUrl string), draw it into a w×h
// canvas, normalize to the exclude convention, and return a PNG dataUrl sized to
// w×h. Used for importing a file as a mask and for rescaling a mask across
// images of a different resolution.
export async function maskFromSource(source, w, h) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  const bmp = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const id = ctx.getImageData(0, 0, w, h)
  normalizeMaskPixels(id.data)
  ctx.putImageData(id, 0, 0)
  const out = await canvas.convertToBlob({ type: 'image/png' })
  return blobToDataUrl(out)
}

// Rasterize a stored mask dataUrl to a w×h "is-masked" lookup. Used by the
// compute worker to test keypoint / depth-map pixels against the mask.
export async function buildMaskLookup(dataUrl, w, h) {
  const blob = await (await fetch(dataUrl)).blob()
  const bmp = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return maskLookupFromRgba(ctx.getImageData(0, 0, w, h).data, w, h)
}
