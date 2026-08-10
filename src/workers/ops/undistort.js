import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { scaleK } from '../../core/sfm/geometry.js'
import {
  resampleRgba, pinholeFrameSize, validSampleRect, cropRgba, shiftPrincipalPoint,
} from '../../core/products/undistort.js'

// Undistorted-image export: resample one source image into the pinhole frame the
// sparse model already lives in, so an external dense/mesh pipeline (OpenMVS, MVE,
// MVS-Texturing — everything downstream of COLMAP `image_undistorter`) can consume
// websfm's cameras with no distortion model at all.
//
// One image per call, deliberately: the caller loops and persists each result, so
// peak memory is one image rather than the batch. A 100 MP scan is ~400 MB as
// RGBA — the `maxDim` option exists for exactly that case.
//
// The geometry is entirely shared code (core/sfm/displayFrame.js for the map,
// core/products/undistort.js for the resampling); only pixel decode/encode is
// worker-local, which is why `rasterize` is injected the same way dense gets it.
export function makeUndistortOps({ rasterize }) {
  // args: [{ url, K, dist, selfCal, fid, mode, maxDim, format, quality }]
  //   K       — the BA-refined pinhole intrinsics for this image (native/canonical px)
  //   fid     — { A|transform, frame } for a film scan, else null
  //   mode    — 'crop' (largest all-valid rect, COLMAP blank_pixels=0) | 'full'
  //   maxDim  — 0/null ⇒ native resolution
  // → { bytes, width, height, K, rect, mime } with `bytes` transferred.
  async function undistortImage([{
    url, K, dist = null, selfCal = null, fid = null,
    mode = 'crop', maxDim = 0, format = 'jpeg', quality = 0.92,
  }], { emit }) {
    const log = (m, l = 'info') => emit('log', [m, l, 'Export'])
    const r = await rasterize(url, maxDim > 0 ? maxDim : Infinity)

    // The source grid is whatever rasterize gave us; the output grid is the
    // pinhole frame (the canonical frame for a film scan — usually a very
    // different size from the scan raster).
    const srcScale = r.scale
    const outScale = fid
      ? (maxDim > 0 ? Math.min(1, maxDim / Math.max(fid.frame.width, fid.frame.height)) : 1)
      : r.scale
    const { width: ow, height: oh } = pinholeFrameSize({
      meta: { width: r.natW, height: r.natH }, fiducial: fid, scale: outScale,
    })
    const map = makeSampleMap({ K, dist, selfCal, fiducial: fid, outScale, srcScale })

    let data = resampleRgba(r, map, ow, oh)

    // Crop away the margin that samples outside the source. Without it the edge
    // clamp in sampleRgbaBilinear smears the border pixel across that margin,
    // which a downstream matcher reads as real image content.
    let rect = { x: 0, y: 0, width: ow, height: oh }
    if (mode === 'crop') {
      const valid = validSampleRect(map, ow, oh, r.width, r.height)
      if (!valid) {
        log(`Undistort: no fully-valid region for this image — writing the full frame instead`, 'warn')
      } else {
        rect = valid
      }
    }
    data = cropRgba(data, ow, oh, rect)
    const Kout = shiftPrincipalPoint(scaleK(K, outScale), rect)

    const mime = format === 'png' ? 'image/png' : 'image/jpeg'
    const canvas = new OffscreenCanvas(rect.width, rect.height)
    canvas.getContext('2d').putImageData(new ImageData(data, rect.width, rect.height), 0, 0)
    const blob = await canvas.convertToBlob(
      mime === 'image/png' ? { type: mime } : { type: mime, quality })
    const bytes = await blob.arrayBuffer()

    // `outScale` + `rect` are what the caller needs to move the model's
    // observations (which are in K's full-resolution pinhole frame) onto this
    // output grid: px_out = px · outScale − rect.origin.
    return {
      result: { bytes, width: rect.width, height: rect.height, K: Kout, rect, outScale, mime },
      transfer: [bytes],
    }
  }

  return { undistortImage }
}
