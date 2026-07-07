// Browsers other than Safari (Chrome/Skia, Firefox) can't decode TIFF in an
// <img>, new Image(), or createImageBitmap — Safari only works because WebKit
// hands decoding to Apple's system ImageIO. Since the whole app (viewer,
// metadata dimension probe, and the worker's rasterize) consumes `image.url`
// through the browser's native decoder, TIFF inputs are invisible everywhere in
// Chrome. We fix it once, at ingest/restore, by transcoding the TIFF to a PNG
// blob and using that as `image.url` — every downstream consumer then works
// unchanged in every browser.
import { fromBlob } from 'geotiff'

// True for anything that looks like a TIFF, from a File/Blob (type + name) or a
// bare filename string (used on restore, where the OPFS Blob carries no name).
export function isTiff(fileOrName) {
  if (!fileOrName) return false
  const name = (typeof fileOrName === 'string' ? fileOrName : fileOrName.name || '').toLowerCase()
  const type = typeof fileOrName === 'string' ? '' : (fileOrName.type || '').toLowerCase()
  return type === 'image/tiff' || type === 'image/tif' || name.endsWith('.tif') || name.endsWith('.tiff')
}

// Decode a TIFF blob (handles BigTIFF / tiled / compressed / geo, via geotiff)
// into a PNG blob the browser renders natively. Returns { blob, width, height }.
// readRGB() resolves photometric interpretation (RGB / grayscale / palette /
// CMYK / YCbCr) to 8-bit RGB, so we just pack it into RGBA and re-encode.
export async function tiffToDisplayBlob(blob) {
  const tiff = await fromBlob(blob)
  const image = await tiff.getImage()
  const width = image.getWidth()
  const height = image.getHeight()

  const rgb = await image.readRGB({ interleave: true })
  const spp = rgb.length / (width * height) // 3 (RGB) or 4 (RGBA)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let px = 0, s = 0; px < width * height; px++, s += spp) {
    rgba[px * 4]     = rgb[s]
    rgba[px * 4 + 1] = rgb[s + 1]
    rgba[px * 4 + 2] = rgb[s + 2]
    rgba[px * 4 + 3] = spp === 4 ? rgb[s + 3] : 255
  }

  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)
  const out = await canvas.convertToBlob({ type: 'image/png' })
  return { blob: out, width, height }
}

// Convenience: given a File/Blob (+ optional name for restore Blobs), return a
// browser-displayable object URL — transcoding TIFF, passing everything else
// straight through URL.createObjectURL.
export async function displayUrlFor(blob, name = null) {
  if (isTiff(name ?? blob)) {
    const { blob: png } = await tiffToDisplayBlob(blob)
    return URL.createObjectURL(png)
  }
  return URL.createObjectURL(blob)
}
