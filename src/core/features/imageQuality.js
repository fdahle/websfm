// Per-image quality: a sharpness score for finding blurry frames, plus exposure
// diagnostics. The Metashape "Estimate Image Quality" analogue. Pure: a decoded
// raster in, plain numbers out — the worker owns decoding.
//
// Sharpness is the variance of the 3×3 Laplacian of luma. A blurred image has
// lost its high frequencies, and the Laplacian is a high-pass filter, so its
// response variance drops monotonically as blur grows. Motion blur from a moving
// drone is the common case this exists to catch: it silently costs keypoints,
// matches and dense coverage without ever raising an error.
//
// Two things make the raw number meaningful, and both are documented where they
// happen:
//   1. The image is resampled to a FIXED analysis size first (see
//      `analyzeImageQuality`). The Laplacian is a per-pixel operator, so on the
//      native grid its variance is denominated in "per native pixel" — a unit
//      that differs between a 20 MP and a 45 MP camera looking at the same scene
//      ("a threshold is only a constant if its unit is"). Resampling to a fixed
//      longest side makes the unit "per 1/analysisMaxDim of the frame".
//   2. The score is still scene-dependent (a snowfield has little texture
//      however sharp the lens), so ranking is done relative to the batch median
//      (`relativeQuality`), not against an absolute threshold.

import { rgbaToGray } from '../sfm/geometry.js'

export const IMAGE_QUALITY_DEFAULTS = Object.freeze({
  analysisMaxDim: 1024,
  tiles: 4,
  /** Luma at or above this (of 255) counts as clipped highlight. */
  overexposedLevel: 250,
  /** Luma at or below this (of 255) counts as crushed shadow. */
  underexposedLevel: 5,
  /** A tile needs this many valid Laplacian samples to report a variance. */
  minTileSamples: 16,
})

export const QUALITY_VERDICT_DEFAULTS = Object.freeze({
  /** Blurry when sharpness / batch median falls below this. */
  minRelative: 0.5,
  /** Over/underexposed when that share of valid pixels exceeds this. */
  maxClipped: 0.25,
})

/**
 * Area-resampling taps for one axis, `nSrc` → `nDst` (nDst ≤ nSrc).
 *
 * Output pixel j covers the source EDGE-space interval [j/s, (j+1)/s) with
 * s = nDst/nSrc, so its centre sits at native (j + ½)/s − ½ — the
 * centre-aligned convention of `core/sfm/geometry.js` `toScaledPx` /
 * `fromScaledPx`, the same one every other resample in the app keeps. Each
 * source pixel contributes its overlap with that interval, normalised, which
 * is an exact box (area) filter for any non-integer factor.
 */
function areaTaps(nSrc, nDst) {
  const inv = nSrc / nDst
  const start = new Int32Array(nDst)
  const count = new Int32Array(nDst)
  const maxTaps = Math.ceil(inv) + 1
  const weights = new Float64Array(nDst * maxTaps)
  for (let j = 0; j < nDst; j++) {
    const lo = j * inv
    const hi = Math.min(nSrc, (j + 1) * inv)
    const i0 = Math.floor(lo)
    const i1 = Math.min(nSrc, Math.ceil(hi))
    start[j] = i0
    count[j] = i1 - i0
    const norm = 1 / (hi - lo)
    for (let i = i0; i < i1; i++) {
      const cover = Math.min(hi, i + 1) - Math.max(lo, i)
      weights[j * maxTaps + (i - i0)] = cover * norm
    }
  }
  return { start, count, weights, maxTaps }
}

/**
 * Separable area downscale of a single-channel plane into a Float32Array,
 * multiplying every value by `gain` (used to normalise to 0..1).
 */
function resampleArea(src, w, h, outW, outH, gain) {
  const out = new Float32Array(outW * outH)
  if (outW === w && outH === h) {
    for (let i = 0; i < w * h; i++) out[i] = src[i] * gain
    return out
  }
  const tx = areaTaps(w, outW)
  const ty = areaTaps(h, outH)
  // Horizontal pass: every source row → outW columns.
  const tmp = new Float32Array(outW * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    const orow = y * outW
    for (let j = 0; j < outW; j++) {
      const s0 = row + tx.start[j]
      const n = tx.count[j]
      const wo = j * tx.maxTaps
      let acc = 0
      for (let k = 0; k < n; k++) acc += src[s0 + k] * tx.weights[wo + k]
      tmp[orow + j] = acc
    }
  }
  // Vertical pass: accumulate weighted tmp rows into each output row.
  for (let i = 0; i < outH; i++) {
    const orow = i * outW
    const n = ty.count[i]
    const wo = i * ty.maxTaps
    for (let k = 0; k < n; k++) {
      const wk = ty.weights[wo + k] * gain
      const trow = (ty.start[i] + k) * outW
      for (let j = 0; j < outW; j++) out[orow + j] += tmp[trow + j] * wk
    }
  }
  return out
}

/** Linear-interpolated percentile (p in 0..1) of a plain numeric array. */
function percentile(values, p) {
  if (!values.length) return null
  const s = values.slice().sort((a, b) => a - b)
  const pos = p * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/**
 * Sharpness + exposure for one decoded raster.
 *
 * Resampling: the luma plane is box (area) downscaled, centre-aligned, until
 * its longest side is `analysisMaxDim`; it is never upsampled (upsampling
 * invents no detail and would only flatten the Laplacian). Analysing at a fixed
 * size is what makes the score comparable across cameras of different
 * resolution: the same scene with the same blur, seen by a 2× sensor, lands on
 * the same analysis grid and so gives (nearly) the same variance, where the
 * native-grid variance would differ by roughly the resolution ratio to the
 * 4th power. The box filter also averages away sensor noise, which otherwise
 * dominates a native-resolution Laplacian on high-ISO frames. Images already
 * smaller than `analysisMaxDim` are analysed as-is, so they are comparable to
 * each other but not to larger ones.
 *
 * Sharpness: variance of the 4-neighbour Laplacian (0 1 0 / 1 −4 1 / 0 1 0) of
 * luma normalised to 0..1, over analysis pixels whose whole 3×3 neighbourhood is
 * valid (inside the frame and unmasked) — a mask edge must not read as an edge.
 * `sharpnessP90` is the 90th percentile of the same variance computed per tile
 * on a `tiles × tiles` grid. The two disagree informatively: a shallow
 * depth-of-field frame sharp in one corner has a low `sharpness` but a high
 * `sharpnessP90`; overall motion blur lowers both. Ranking (`relativeQuality`,
 * `qualityVerdicts`) uses `sharpness` by default.
 *
 * Exposure: `meanLuma` (0..1) and the shares of valid analysis pixels with luma
 * ≥ 250/255 (`overexposed`) or ≤ 5/255 (`underexposed`). Measured on the
 * analysis grid, so a clipped region counts by its area, not its pixel count at
 * native resolution; edge pixels that average a clipped and an unclipped region
 * may fall out of either share.
 *
 * A gray input is integer 0..255 by default, or 0..1 for a Float32Array; pass
 * `maxValue` on the raster to override. RGBA luma uses `rgbaToGray` (BT.601).
 *
 * @param {{ width:number, height:number, data:ArrayLike<number>, channels?:1|4, maxValue?:number }} raster
 * @param {{ analysisMaxDim?:number, mask?:ArrayLike<number>|null, tiles?:number }} [opts]
 *   `mask` is w·h at the raster's resolution, nonzero = usable. An analysis
 *   pixel is valid only if every source pixel it covers is usable.
 * @returns {{ sharpness:number|null, sharpnessP90:number|null, meanLuma:number|null,
 *   overexposed:number|null, underexposed:number|null,
 *   analysisWidth:number, analysisHeight:number, scale:number }}
 *   Fields are null when no pixel (or no 3×3 neighbourhood) is valid.
 */
export function analyzeImageQuality(raster, opts = {}) {
  const { width: w, height: h, data, channels = 4 } = raster
  const {
    analysisMaxDim = IMAGE_QUALITY_DEFAULTS.analysisMaxDim,
    mask = null,
    tiles = IMAGE_QUALITY_DEFAULTS.tiles,
  } = opts
  if (!(w > 0 && h > 0)) throw new Error('analyzeImageQuality: empty raster')
  if (channels !== 1 && channels !== 4) throw new Error(`analyzeImageQuality: channels must be 1 or 4, got ${channels}`)
  if (data.length < w * h * channels) throw new Error('analyzeImageQuality: data shorter than width·height·channels')
  if (mask && mask.length < w * h) throw new Error('analyzeImageQuality: mask shorter than width·height')

  const scale = Math.min(1, analysisMaxDim / Math.max(w, h))
  const aw = Math.max(1, Math.round(w * scale))
  const ah = Math.max(1, Math.round(h * scale))

  let gray
  let maxValue
  if (channels === 4) {
    gray = rgbaToGray(data, w, h)
    maxValue = 255
  } else {
    gray = data
    maxValue = raster.maxValue ?? (data instanceof Float32Array || data instanceof Float64Array ? 1 : 255)
  }
  const luma = resampleArea(gray, w, h, aw, ah, 1 / maxValue)

  // Validity on the analysis grid: full coverage by usable source pixels.
  let valid = null
  if (mask) {
    const bin = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) bin[i] = mask[i] ? 1 : 0
    const cover = resampleArea(bin, w, h, aw, ah, 1)
    valid = new Uint8Array(aw * ah)
    for (let i = 0; i < aw * ah; i++) valid[i] = cover[i] >= 0.999 ? 1 : 0
  }

  // Exposure over valid analysis pixels.
  const hiLevel = IMAGE_QUALITY_DEFAULTS.overexposedLevel / 255
  const loLevel = IMAGE_QUALITY_DEFAULTS.underexposedLevel / 255
  let nValid = 0
  let sumLuma = 0
  let nOver = 0
  let nUnder = 0
  for (let i = 0; i < aw * ah; i++) {
    if (valid && !valid[i]) continue
    const v = luma[i]
    nValid++
    sumLuma += v
    // A small tolerance keeps exactly-250 pixels in after the float resample.
    if (v >= hiLevel - 1e-6) nOver++
    if (v <= loLevel + 1e-6) nUnder++
  }

  // Laplacian variance, global and per tile.
  const nT = Math.max(1, Math.floor(tiles))
  const tSum = new Float64Array(nT * nT)
  const tSq = new Float64Array(nT * nT)
  const tN = new Float64Array(nT * nT)
  const tileX = new Int32Array(aw)
  for (let x = 0; x < aw; x++) tileX[x] = Math.min(nT - 1, Math.floor((x * nT) / aw))
  let lSum = 0
  let lSq = 0
  let lN = 0
  for (let y = 1; y < ah - 1; y++) {
    const ty = Math.min(nT - 1, Math.floor((y * nT) / ah))
    const row = y * aw
    for (let x = 1; x < aw - 1; x++) {
      const i = row + x
      if (valid && !(
        valid[i - aw - 1] && valid[i - aw] && valid[i - aw + 1] &&
        valid[i - 1] && valid[i] && valid[i + 1] &&
        valid[i + aw - 1] && valid[i + aw] && valid[i + aw + 1]
      )) continue
      const lap = luma[i - aw] + luma[i + aw] + luma[i - 1] + luma[i + 1] - 4 * luma[i]
      lSum += lap
      lSq += lap * lap
      lN++
      const t = ty * nT + tileX[x]
      tSum[t] += lap
      tSq[t] += lap * lap
      tN[t]++
    }
  }
  const variance = (sum, sq, n) => Math.max(0, sq / n - (sum / n) ** 2)
  const tileVars = []
  for (let t = 0; t < nT * nT; t++) {
    if (tN[t] >= IMAGE_QUALITY_DEFAULTS.minTileSamples) tileVars.push(variance(tSum[t], tSq[t], tN[t]))
  }

  return {
    sharpness: lN > 0 ? variance(lSum, lSq, lN) : null,
    sharpnessP90: percentile(tileVars, 0.9),
    meanLuma: nValid > 0 ? sumLuma / nValid : null,
    overexposed: nValid > 0 ? nOver / nValid : null,
    underexposed: nValid > 0 ? nUnder / nValid : null,
    analysisWidth: aw,
    analysisHeight: ah,
    scale,
  }
}

/**
 * Batch-relative quality: each score divided by the batch median.
 *
 * An absolute Laplacian variance depends on scene texture as much as on focus
 * (fresh snow vs a rock outcrop, same lens, same shutter), so no fixed cut
 * separates sharp from blurry across projects. Within one batch — same camera,
 * same flight, similar terrain — the texture term is roughly shared, so a frame
 * well below its peers is the blurry one. Metashape's image quality value is
 * batch-relative in the same spirit.
 *
 * Non-finite / null scores stay null and do not enter the median. If no score is
 * finite, or the median is ≤ 0 (a batch of featureless frames), the ratio is
 * undefined and every entry is null.
 *
 * @param {Array<number|null|undefined>} scores
 * @returns {Array<number|null>}
 */
export function relativeQuality(scores) {
  const finite = []
  for (const s of scores) if (typeof s === 'number' && Number.isFinite(s)) finite.push(s)
  const med = percentile(finite, 0.5)
  return scores.map((s) =>
    med != null && med > 0 && typeof s === 'number' && Number.isFinite(s) ? s / med : null,
  )
}

/**
 * Flags per image from a batch of `analyzeImageQuality` results.
 *
 * `blurry` when sharpness relative to the batch median is below `minRelative`;
 * `overexposed` / `underexposed` when that share of valid pixels exceeds
 * `maxClipped`. An image with unknown sharpness gets no blur verdict (unknown is
 * not blurry). `ok` = no flags.
 *
 * @param {Array<{ id:any, sharpness:number|null, overexposed?:number|null, underexposed?:number|null }>} results
 * @param {{ minRelative?:number, maxClipped?:number }} [opts]
 * @returns {Array<{ id:any, relative:number|null, flags:Array<'blurry'|'overexposed'|'underexposed'>, ok:boolean }>}
 */
export function qualityVerdicts(results, opts = {}) {
  const {
    minRelative = QUALITY_VERDICT_DEFAULTS.minRelative,
    maxClipped = QUALITY_VERDICT_DEFAULTS.maxClipped,
  } = opts
  const rel = relativeQuality(results.map((r) => r.sharpness))
  return results.map((r, i) => {
    const flags = []
    if (rel[i] != null && rel[i] < minRelative) flags.push('blurry')
    if (r.overexposed != null && r.overexposed > maxClipped) flags.push('overexposed')
    if (r.underexposed != null && r.underexposed > maxClipped) flags.push('underexposed')
    return { id: r.id, relative: rel[i], flags, ok: flags.length === 0 }
  })
}
