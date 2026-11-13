// Reading a photo or film scan for the detection ops without a full-resolution raster:
// a film scan is routinely 10k×10k, and one full RGBA raster of that is ~400 MB, so an
// op decodes to an ImageBitmap ONCE and pulls only the small rectangles it correlates
// over, via source-rect drawImage into a tiny canvas (a pyramid reads its tiles).

import { isPyramid, openPyramid, rasterizePyramidTo, readNativeRect } from '../rasterSource.js'
import { grayFromRgba } from '../../core/sfm/fiducialDetect.js'

// An ImageBitmap of the image, or — for a pyramid (an image past the canvas
// limit, workers/rasterSource.js) — a stand-in with the same width / height /
// close() whose pixels the helpers below read through the tiles.
export async function decodeBitmap(url) {
  if (isPyramid(url)) {
    const pyramid = await openPyramid(url)
    return { pyramid, width: pyramid.index.width, height: pyramid.index.height, close() {} }
  }
  const blob = await (await fetch(url)).blob()
  return await createImageBitmap(blob)
}

// The whole bitmap drawn at width × height, RGBA.
export function scaledRgba(bmp, width, height) {
  if (bmp.pyramid) return rasterizePyramidTo(bmp.pyramid, width, height).data
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height).data
}

// Read one axis-aligned window out of `bmp` as a grayscale float image. The
// requested rect is CLAMPED into the bitmap rather than left to drawImage's
// clip-and-rescale behaviour (which leaves the uncovered part transparent
// black and would correlate the template against a phantom border), so the
// returned `originX/originY` is the true native-px position of pixel (0,0)
// and may differ from what was asked for near an edge.
export function cropGray(bmp, sx, sy, sw, sh) {
  const w = Math.min(sw, bmp.width),
    h = Math.min(sh, bmp.height)
  const x = Math.max(0, Math.min(bmp.width - w, Math.round(sx)))
  const y = Math.max(0, Math.min(bmp.height - h, Math.round(sy)))
  let data
  if (bmp.pyramid) data = readNativeRect(bmp.pyramid, { x0: x, y0: y, x1: x + w, y1: y + h }).data
  else {
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h)
    data = ctx.getImageData(0, 0, w, h).data
  }
  const gray = grayFromRgba(data, w, h)
  return { ...gray, originX: x, originY: y }
}

// The coarse thumbnail rasterize() would make, drawn from an already-decoded
// bitmap — same scale and rounding — so one detection decodes the scan once.
// (A 97 MP PNG decode dominates this op; rasterize + decodeBitmap paid it twice.)
export function downscaleBitmap(bmp, maxDim) {
  const natW = bmp.width,
    natH = bmp.height
  const scale = Math.min(1, maxDim / Math.max(natW, natH))
  const width = Math.round(natW * scale),
    height = Math.round(natH * scale)
  return { data: scaledRgba(bmp, width, height), width, height, scale, natW, natH }
}
