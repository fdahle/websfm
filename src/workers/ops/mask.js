import { rgbaToGray } from '../../core/sfm/geometry.js'
import { detectFrameMargins } from '../../core/maskFrame.js'
import { FRAME_MASK_TUNING } from '../../core/tuning.js'

// Auto Mask's pixel rules, one photo per call (core/maskFrame.js): the photo is read
// reduced (a large scan's pyramid level) and the result comes back in that raster's px
// with its scale, so the caller can make a group's frames consistent before scaling.
export function makeMaskOps({ rasterize }) {
  async function detectPhotoFrame([url, options = {}]) {
    const { maxDim = FRAME_MASK_TUNING.maxDim } = options
    const r = await rasterize(url, maxDim)
    const gray = rgbaToGray(r.data, r.width, r.height)
    const m = detectFrameMargins(gray, r.width, r.height)
    const [sx, sy] = r.scaleXY ?? [r.scale, r.scale]
    return { result: { ...m, width: r.width, height: r.height, sx, sy, natW: r.natW, natH: r.natH } }
  }
  return { detectPhotoFrame }
}
