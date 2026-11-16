import { rgbaToGray } from '../../core/sfm/geometry.js'
import { findText } from '../../core/ocr/ocr.js'
import { OCR_TUNING } from '../../core/tuning.js'

// Text on one photograph (core/ocr/): Auto Mask ▸ Text and the text read from the
// photos. The photo is read at OCR_TUNING.detMaxDim on its long side (a large scan's
// pyramid level, rasterSource.js), and the lines come back in native pixels. Each
// worker keeps its own detector and recogniser sessions (core/ocr/ocr.js), so a run
// spreads the photos over the pool.
export function makeOcrOps({ rasterize }) {
  async function readPhotoText([url, options = {}], { emit } = {}) {
    const onLog = emit ? (msg) => emit('log', [msg]) : undefined
    const { maxDim = OCR_TUNING.detMaxDim, read = true } = options
    const r = await rasterize(url, maxDim)
    const gray = rgbaToGray(r.data, r.width, r.height)
    const [sx, sy] = r.scaleXY ?? [r.scale, r.scale]
    const out = await findText(gray, r.width, r.height, { read, onLog })
    // Detector boxes are in pixel-index coordinates of the reduced raster (a pixel's
    // centre at integers); stored lines are continuous native coordinates (pixel c spans
    // c to c + 1, as a canvas draws), which the masks are drawn in.
    const lines = out.lines.map((l) => ({
      ...l,
      quad: l.quad.map(([x, y]) => [(x + 0.5) / sx, (y + 0.5) / sy]),
    }))
    return {
      result: {
        lines,
        natW: r.natW,
        natH: r.natH,
        width: r.width,
        height: r.height,
        tiles: out.tiles,
        detectMs: out.detectMs,
        readMs: out.readMs,
      },
    }
  }

  return { readPhotoText }
}
