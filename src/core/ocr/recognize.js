// Text recognition with PaddleOCR's English PP-OCRv5 mobile recogniser (SVTR with a
// CTC head, Du et al. 2022): each text box is cut out upright at 48 px high, the network
// gives every 8-px column a distribution over the characters, and the greedy CTC
// decode reads the line. Pure: the network runs through `run` (core/ocr/session.js).
//
// Text on a scanned photograph runs in any of four directions (a data strip along a
// side reads bottom-to-top or top-to-bottom, a frame turned in the scanner upside
// down). A box is read both ways it can lie (a tall box turned either way, a wide one
// as it is and upside down) and the reading with the higher score is kept.

import { OCR_TUNING } from '../tuning.js'
import { EN_DICT } from './dictEn.js'

export const REC_HEIGHT = 48
// The recogniser's minimum input width (inference.yml ▸ RecResizeImg, 3×48×320): a
// shorter line is padded to it, as PaddleOCR does.
export const REC_MIN_WIDTH = 320

// Unit directions of a box: `u` along its first edge (corner 0 → 1), `v` along its
// second (corner 1 → 2), and their lengths.
function quadFrame(quad) {
  const [p0, p1, p2, p3] = quad
  const w = Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p2[0] - p3[0], p2[1] - p3[1]))
  const h = Math.max(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]), Math.hypot(p2[0] - p1[0], p2[1] - p1[1]))
  return { w, h }
}

/**
 * The ways to read a box, as corner orders whose first edge runs along the text: a
 * wide box (or a square one) as it lies and turned half round; a tall one (height at
 * least `OCR_TUNING.verticalRatio` × width) turned a quarter either way. Each is
 * `{ quad, angle }`, angle the turn in degrees clockwise that makes the text upright.
 */
export function readingOrders(quad) {
  const [p0, p1, p2, p3] = quad
  const { w, h } = quadFrame(quad)
  if (h >= OCR_TUNING.verticalRatio * w)
    return [
      // Text running top to bottom (turned clockwise on the photo): read from p1 down to p2.
      { quad: [p1, p2, p3, p0], angle: 270 },
      // Bottom to top: read from p3 up to p0.
      { quad: [p3, p0, p1, p2], angle: 90 },
    ]
  return [
    { quad: [p0, p1, p2, p3], angle: 0 },
    { quad: [p2, p3, p0, p1], angle: 180 },
  ]
}

/**
 * Cut a box out of a grey raster upright: corner 0 → 1 becomes the top edge, scaled to
 * `REC_HEIGHT` px high (bilinear, edge pixels repeated). Returns
 * `{ data: Uint8Array, w, h }`, width at least 1 and at most `maxWidth`.
 */
export function cropQuad(gray, w, h, quad, maxWidth = OCR_TUNING.recMaxWidth) {
  const [p0, p1, , p3] = quad
  const { w: qw, h: qh } = quadFrame(quad)
  const outH = REC_HEIGHT
  const outW = Math.max(1, Math.min(maxWidth, Math.ceil((outH * qw) / Math.max(qh, 1e-6))))
  const data = new Uint8Array(outW * outH)
  const ux = (p1[0] - p0[0]) / outW,
    uy = (p1[1] - p0[1]) / outW
  const vx = (p3[0] - p0[0]) / outH,
    vy = (p3[1] - p0[1]) / outH
  for (let j = 0; j < outH; j++)
    for (let i = 0; i < outW; i++) {
      // Sample at the output pixel's centre. Quads are in pixel-index coordinates
      // (a raster pixel's centre at integers), as the detector gives them.
      const sx = p0[0] + (i + 0.5) * ux + (j + 0.5) * vx
      const sy = p0[1] + (i + 0.5) * uy + (j + 0.5) * vy
      data[j * outW + i] = bilinear(gray, w, h, sx, sy)
    }
  return { data, w: outW, h: outH }
}

function bilinear(gray, w, h, x, y) {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y
  const x0 = Math.floor(cx),
    y0 = Math.floor(cy)
  const x1 = Math.min(w - 1, x0 + 1),
    y1 = Math.min(h - 1, y0 + 1)
  const fx = cx - x0,
    fy = cy - y0
  const a = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx
  const b = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx
  return Math.round(a * (1 - fy) + b * fy)
}

/**
 * Crops as one batch for the recogniser: Float32 [n, 3, 48, W], v/127.5 − 1 in all
 * three channels, each crop left-aligned and padded with 0 (mid grey) to the batch's
 * width W (the widest crop, at least REC_MIN_WIDTH).
 */
export function recInput(crops) {
  const W = Math.max(REC_MIN_WIDTH, ...crops.map((c) => c.w))
  const plane = REC_HEIGHT * W
  const out = new Float32Array(crops.length * 3 * plane)
  crops.forEach((c, n) => {
    const base = n * 3 * plane
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const v = c.data[y * c.w + x] / 127.5 - 1
        const i = y * W + x
        out[base + i] = v
        out[base + plane + i] = v
        out[base + 2 * plane + i] = v
      }
  })
  return { data: out, dims: [crops.length, 3, REC_HEIGHT, W] }
}

/**
 * Greedy CTC decode of one line (CTCLabelDecode): the most likely class per step,
 * repeats merged, blanks (class 0) dropped. Class i is `dict[i − 1]`, the class past
 * the table a space. The score is the mean probability of the characters kept (0 when
 * none is).
 */
export function ctcDecode(probs, steps, classes, dict = EN_DICT, offset = 0) {
  let text = '',
    sum = 0,
    n = 0,
    prev = -1
  for (let t = 0; t < steps; t++) {
    const row = offset + t * classes
    let best = 0,
      p = probs[row]
    for (let c = 1; c < classes; c++)
      if (probs[row + c] > p) {
        p = probs[row + c]
        best = c
      }
    if (best !== 0 && best !== prev) {
      text += best - 1 < dict.length ? dict[best - 1] : ' '
      sum += p
      n++
    }
    prev = best
  }
  return { text, score: n ? sum / n : 0 }
}

/**
 * Read text boxes on a grey raster. `run(input, dims)` resolves to the network's
 * output `{ data, dims: [n, steps, classes] }` for a batch. Each box is read in both of
 * its reading orders and the better reading kept: returns
 * `[{ text, score, angle }]` in the order of `quads`.
 */
export async function recognizeText(gray, w, h, quads, run, opts = {}) {
  const { batch = OCR_TUNING.recBatch, signal } = opts
  const jobs = []
  quads.forEach((quad, i) => {
    for (const r of readingOrders(quad)) jobs.push({ i, angle: r.angle, crop: cropQuad(gray, w, h, r.quad) })
  })
  // Similar widths in a batch: less padding to read.
  jobs.sort((a, b) => a.crop.w - b.crop.w)
  const best = quads.map(() => null)
  for (let k = 0; k < jobs.length; k += batch) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const part = jobs.slice(k, k + batch)
    const { data, dims } = recInput(part.map((j) => j.crop))
    const out = await run(data, dims)
    const [, steps, classes] = out.dims
    part.forEach((job, n) => {
      const read = ctcDecode(out.data, steps, classes, EN_DICT, n * steps * classes)
      const cur = best[job.i]
      if (!cur || read.score > cur.score) best[job.i] = { ...read, angle: job.angle }
    })
  }
  return best.map((b) => b ?? { text: '', score: 0, angle: 0 })
}
