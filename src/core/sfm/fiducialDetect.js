// Automatic fiducial-mark measurement on film scans (F4 follow-up).
//
// Marking 4–8 fiducials by hand on every scanned frame is the most tedious part
// of the film path. Within one scan batch the film frame lands in nearly the same
// scan position every time, so a template cut from ONE reference image plus a
// small search window finds the same mark on every other image of that sensor.
// That is the HSfM / MicMac-Kugelhupf approach: ZNCC template matching, coarse to
// fine, with a sub-pixel quadratic peak fit.
//
// ZNCC (zero-mean normalized cross-correlation) rather than raw correlation
// because scans of the same batch vary in exposure and development density; the
// zero-mean + energy normalization makes the score invariant to affine intensity
// change, which is exactly the nuisance parameter here.
//
// This module is PURE and worker-safe (no Vue/Pinia/OPFS/DOM). Grayscale images
// are `{ data: Float32Array, width, height }`, row-major, values 0..255; patches
// are square `{ data: Float32Array, size }`.
//
// Division of labour with the worker: cropping full-resolution windows out of a
// 10k×10k scan needs OffscreenCanvas (materializing the whole RGBA raster is
// ~400 MB), so the orchestrator here takes an injected `cropWindow` callback —
// the same "side effects via injected hooks" shape as `onLog`/`onProgress`
// elsewhere in core. The math stays here; the pixels stay in the worker.
//
// Gating deliberately does NOT happen in the detector: it needs population stats
// across every image of the sensor plus the sensor's calibrated mm layout, so it
// lives in `gateFiducialDetections` below and is driven by the store.

import { fitFiducialAffine } from './fiducials.js'

/**
 * Internal algorithm tuning (the self-contained-module exception in CLAUDE.md —
 * these are not user knobs; the user-facing ones live in `defaults.user.js` as
 * `FIDUCIAL_DETECT_DEFAULTS`). Exported so tests can read them rather than
 * duplicating the numbers.
 */
export const FIDUCIAL_DETECT_TUNING = {
  templateHalf: 32,     // template = (2·half+1)² px cut from the reference image
  coarseScale: 1 / 8,   // coarse-pass downscale of window + template
  refineHalf: 48,       // full-res refine window half-size around the coarse peak
}

// ── basic image / patch helpers ────────────────────────────────────────────

/**
 * RGBA byte raster → grayscale float image. Rec. 601 luma, matching
 * `geometry.js` `rgbaToGray` (which returns Uint8 — we keep float precision here
 * because ZNCC sums over it and the sub-pixel fit reads the tails).
 * @returns {{ data: Float32Array, width: number, height: number }}
 */
export function grayFromRgba(rgba, width, height) {
  const n = width * height
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    data[i] = rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114
  }
  return { data, width, height }
}

// Edge-clamped pixel read — out-of-bounds reads return the nearest border pixel
// rather than 0, so a template overlapping the raster edge doesn't correlate
// against a phantom black band.
function at(gray, x, y) {
  const cx = x < 0 ? 0 : x >= gray.width ? gray.width - 1 : x
  const cy = y < 0 ? 0 : y >= gray.height ? gray.height - 1 : y
  return gray.data[cy * gray.width + cx]
}

/**
 * Square patch centred on `(cx, cy)` (rounded to integer px), edge-clamped.
 * Returns `null` when the centre is outside the image.
 * @returns {null | { data: Float32Array, size: number }}
 */
export function extractPatch(gray, cx, cy, half) {
  const x0 = Math.round(cx), y0 = Math.round(cy)
  if (x0 < 0 || y0 < 0 || x0 >= gray.width || y0 >= gray.height) return null
  const size = 2 * half + 1
  const data = new Float32Array(size * size)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      data[r * size + c] = at(gray, x0 - half + c, y0 - half + r)
    }
  }
  return { data, size }
}

/**
 * Box-filter (average-pooling) downscale of a square patch. `scale` ∈ (0,1].
 *
 * The output size is forced ODD. A template must have a well-defined centre
 * pixel: `znccAt` derives `half = (size−1)/2` and offsets its reads by it, so an
 * even size makes `half` a half-integer, every read a fractional array index,
 * every sample `undefined`, and every score NaN — which the zero-denominator
 * guard then quietly reports as 0. With the shipped defaults (65px template,
 * ⅛ coarse scale → 8) that would have made the entire coarse pass score zero
 * everywhere while looking like a legitimate "no match".
 * @returns {{ data: Float32Array, size: number }}
 */
export function downscalePatch(patch, scale) {
  const raw = Math.max(1, Math.round(patch.size * scale))
  const outSize = Math.min(patch.size, raw % 2 ? raw : raw + 1)
  if (outSize >= patch.size) return { data: patch.data.slice(), size: patch.size }
  const data = new Float32Array(outSize * outSize)
  const step = patch.size / outSize
  for (let r = 0; r < outSize; r++) {
    const r0 = Math.floor(r * step), r1 = Math.max(r0 + 1, Math.floor((r + 1) * step))
    for (let c = 0; c < outSize; c++) {
      const c0 = Math.floor(c * step), c1 = Math.max(c0 + 1, Math.floor((c + 1) * step))
      let sum = 0, n = 0
      for (let y = r0; y < r1 && y < patch.size; y++) {
        for (let x = c0; x < c1 && x < patch.size; x++) { sum += patch.data[y * patch.size + x]; n++ }
      }
      data[r * outSize + c] = n ? sum / n : 0
    }
  }
  return { data, size: outSize }
}

/**
 * Rotate a square patch by k·90° CLOCKWISE (k ∈ 0..3).
 * Standard CW form: `new[r][c] = old[S−1−c][r]`.
 * (2×2 check: [[a,b],[c,d]] → [[c,a],[d,b]].)
 * @returns {{ data: Float32Array, size: number }}
 */
export function rotatePatch90(patch, k) {
  const kk = ((k % 4) + 4) % 4
  if (kk === 0) return { data: patch.data.slice(), size: patch.size }
  const S = patch.size
  let src = patch.data
  let dst = src
  for (let step = 0; step < kk; step++) {
    dst = new Float32Array(S * S)
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) dst[r * S + c] = src[(S - 1 - c) * S + r]
    }
    src = dst
  }
  return { data: dst, size: S }
}

/**
 * Map a pixel coordinate of a `W×H` image into the frame of that image rotated
 * k·90° CLOCKWISE. Written out explicitly per rotation because interop
 * conventions are the #1 bug source in this codebase (CLAUDE.md).
 *
 *   k=0                 → (x, y)              image stays W×H
 *   k=1 (CW  90°)       → (H−1−y, x)          image becomes H×W
 *   k=2 (CW 180°)       → (W−1−x, H−1−y)      image stays W×H
 *   k=3 (CW 270°/CCW90) → (y, W−1−x)          image becomes H×W
 *
 * @returns {{ x: number, y: number }}
 */
export function rotatePoint90(x, y, k, width, height) {
  switch (((k % 4) + 4) % 4) {
    case 1: return { x: height - 1 - y, y: x }
    case 2: return { x: width - 1 - x, y: height - 1 - y }
    case 3: return { x: y, y: width - 1 - x }
    default: return { x, y }
  }
}

// ── ZNCC matching ──────────────────────────────────────────────────────────

// Template mean + zero-mean energy, precomputed once per template.
function templateStats(tpl) {
  const n = tpl.data.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += tpl.data[i]
  const mean = sum / n
  let energy = 0
  for (let i = 0; i < n; i++) { const d = tpl.data[i] - mean; energy += d * d }
  return { mean, energy }
}

// ZNCC of `tpl` centred at (x, y) in `gray`. Reads are edge-clamped so a window
// touching the raster border still scores. A flat window (zero variance) scores
// 0 rather than NaN.
function znccAt(gray, tpl, stats, x, y) {
  // Integer half by construction. Templates are odd-sized (see downscalePatch),
  // but flooring here means an even one lands half a pixel off-centre instead of
  // producing fractional array indices — which read as `undefined`, propagate
  // NaN, and get laundered into a plausible-looking score of 0 by the guard
  // below. Degrade, never lie.
  const half = (tpl.size - 1) >> 1
  const S = tpl.size
  const x0 = Math.round(x) - half, y0 = Math.round(y) - half
  let sum = 0
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) sum += at(gray, x0 + c, y0 + r)
  }
  const mean = sum / (S * S)
  let num = 0, energy = 0
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const d = at(gray, x0 + c, y0 + r) - mean
      num += d * (tpl.data[r * S + c] - stats.mean)
      energy += d * d
    }
  }
  const den = Math.sqrt(energy * stats.energy)
  if (!(den > 1e-9)) return 0
  const v = num / den
  return Number.isFinite(v) ? v : 0
}

/**
 * Slide `tpl` over the inclusive centre-position range `[x0..x1]×[y0..y1]` of
 * `gray` and return the best ZNCC position. Brute force is deliberate: the
 * windows are small by construction (see the cost note in the plan), and a
 * wasm/FFT path here would be optimizing something already in the millisecond
 * range.
 * @returns {{ x: number, y: number, score: number }}
 */
export function matchZNCC(gray, tpl, x0, y0, x1, y1) {
  const stats = templateStats(tpl)
  let best = { x: Math.round(x0), y: Math.round(y0), score: -Infinity }
  for (let y = Math.round(y0); y <= Math.round(y1); y++) {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      const score = znccAt(gray, tpl, stats, x, y)
      if (score > best.score) best = { x, y, score }
    }
  }
  if (best.score === -Infinity) best.score = 0
  return best
}

/**
 * Sub-pixel refinement of an integer ZNCC peak: evaluate the 3×3 integer
 * neighbourhood and fit a separable parabola per axis. Degenerate (non-concave)
 * fits contribute 0 rather than shooting off; shifts are clamped to ±0.5 px
 * because a true peak cannot be more than half a pixel from the sampled maximum.
 * @returns {{ x: number, y: number }}
 */
export function subpixelPeak(gray, tpl, px, py) {
  const stats = templateStats(tpl)
  const s = (dx, dy) => znccAt(gray, tpl, stats, px + dx, py + dy)
  const c0 = s(0, 0)
  const parabola = (sm, s0, sp) => {
    const denom = sm - 2 * s0 + sp
    if (!(Math.abs(denom) > 1e-12) || denom >= 0) return 0 // not a concave peak
    const d = (sm - sp) / (2 * denom)
    return Number.isFinite(d) ? Math.max(-0.5, Math.min(0.5, d)) : 0
  }
  return {
    x: px + parabola(s(-1, 0), c0, s(1, 0)),
    y: py + parabola(s(0, -1), c0, s(0, 1)),
  }
}

// ── per-image orchestrator ─────────────────────────────────────────────────

/**
 * Detect every fiducial mark in one target image, coarse-to-fine.
 *
 * @param {object} args
 * @param {{ data: Float32Array, width: number, height: number, scale: number,
 *          natW: number, natH: number }} args.coarse
 *   Whole target image at `scale` (the ACTUAL drawn scale — `coarse.width/natW`
 *   — not the requested `coarseScale`, because the worker's drawImage rounds).
 * @param {{ fidId: string, patch: { data: Float32Array, size: number } }[]} args.templates
 *   Full-resolution templates cut from the reference image.
 * @param {{ fidId: string, px: number, py: number, radius: number }[]} args.predictions
 *   Expected positions with a search radius, in the REFERENCE frame — i.e. the
 *   target's native scan px assuming the target is not rotated. The rotation
 *   pass below remaps them if it finds the scan went through sideways.
 * @param {object} [args.cfg] `{ ...FIDUCIAL_DETECT_TUNING, tryRotations }`.
 * @param {(cx:number, cy:number, half:number) => null | { data: Float32Array,
 *          width: number, height: number, originX: number, originY: number }}
 *   [args.cropWindow]
 *   Injected full-resolution window crop (worker-side; only it has
 *   OffscreenCanvas). `originX/originY` are the native px coords of window pixel
 *   (0,0). Omitted ⇒ coarse-only result (used by tests with small rasters).
 * @param {(msg: string) => void} [args.onLog]
 * @returns {{ fidId: string, px: number, py: number, score: number,
 *             coarseScore: number, rotationK: number }[]}
 *   Always one entry per prediction — gating is the store's job, not the
 *   detector's (it needs thresholds and population stats this layer never sees).
 */
export function detectFiducialsInImage({ coarse, templates, predictions, cfg = {}, cropWindow, onLog }) {
  const { coarseScale, refineHalf } = { ...FIDUCIAL_DETECT_TUNING, ...cfg }
  const tryRotations = cfg.tryRotations !== false
  const byId = new Map(templates.map((t) => [t.fidId, t.patch]))
  const scale = coarse.scale
  const natW = coarse.natW, natH = coarse.natH

  // ── rotation pass ────────────────────────────────────────────────────────
  // A scan fed through the scanner the other way round moves every mark, so the
  // per-mark search windows would all miss. Resolve the global 90° multiple ONCE
  // (coarse, first prediction only) before any windowed search.
  //
  // If the target's content is the reference rotated CW by k, then the mark's
  // appearance in the target is the reference template rotated CW by k — so we
  // rotate the TEMPLATE and search the un-rotated target, and remap predictions
  // through the same k. Everything downstream is then in plain target coords.
  //
  // Each k is probed in its OWN predicted window rather than by sweeping the
  // whole coarse image. That is not just cheaper — it is the only version that
  // discriminates. A whole-image sweep on a real scan searches ~1.5M coarse
  // positions with a template that downscaling has reduced to ~8px (64 samples),
  // where a spurious ZNCC near 1.0 is essentially guaranteed for every k; all
  // four then tie and the margin guard below rejects every rotation, including
  // the true one. Rotating the PREDICTION per k keeps the search space at one
  // small window, so the scores mean something.
  //
  // All marks vote, not just the first. One mark is not enough evidence: fiducial
  // marks are usually IDENTICAL to each other, so a wrong-k window frequently
  // lands on a different genuine mark and scores nearly as well as the right one.
  //
  // KNOWN LIMIT: when the marks are identical AND their layout is symmetric under
  // the rotation (the common 4-corners-of-a-rectangle case), every k aligns every
  // mark with *some* real mark and the probe is genuinely undecidable from
  // template evidence alone. The margin guard then keeps k=0 — the right failure,
  // since a whole batch is normally scanned in one consistent orientation. A
  // rotated scan in that configuration still needs manual marking.
  let rotationK = 0
  const probes = predictions.filter((p) => byId.has(p.fidId))
  if (tryRotations && probes.length) {
    const meanScore = (k) => {
      let sum = 0
      for (const pred of probes) {
        const tpl = downscalePatch(rotatePatch90(byId.get(pred.fidId), k), coarseScale)
        const [sw, sh] = k % 2 ? [natH, natW] : [natW, natH]
        const p = rotatePoint90(pred.px, pred.py, k, sw, sh)
        const cx = p.x * scale, cy = p.y * scale
        const r = Math.max(1, pred.radius * scale)
        sum += matchZNCC(coarse, tpl, cx - r, cy - r, cx + r, cy + r).score
      }
      return sum / probes.length
    }
    const scores = [0, 1, 2, 3].map(meanScore)
    let bestK = 0
    for (let k = 1; k < 4; k++) if (scores[k] > scores[bestK]) bestK = k
    // The winner must beat EVERY other hypothesis by the margin, not just k=0.
    // Checking only against k=0 is not enough: identical marks in a layout that
    // maps onto itself make two non-zero rotations score alike, and picking the
    // marginally-higher one is a confident wrong answer — the worst outcome,
    // since it silently mis-assigns every fidId. A tie must fall back to k=0.
    const ROTATION_MARGIN = 0.1
    const decisive = scores.every((s, k) => k === bestK || scores[bestK] > s + ROTATION_MARGIN)
    rotationK = decisive ? bestK : 0
    onLog?.(`rotation probe: k=${rotationK}${decisive ? '' : ' (undecided → assuming unrotated)'}`
      + ` (mean zncc ${scores.map((s) => s.toFixed(3)).join(' / ')} for k=0..3)`)
  }

  const results = []
  for (const pred of predictions) {
    const full = byId.get(pred.fidId)
    if (!full) continue
    const tplFull = rotatePatch90(full, rotationK)
    const tplCoarse = downscalePatch(tplFull, coarseScale)

    // Prediction into the rotated frame, then into coarse px.
    // The rotation maps FROM the reference frame, so it must be parameterised by
    // the reference frame's dimensions — which for an odd k are the target's
    // native dims swapped (target = reference rotated 90°, so target natW is the
    // reference's height). Using the target's own dims here silently mirrors
    // every prediction on non-square scans.
    const [srcW, srcH] = rotationK % 2 ? [natH, natW] : [natW, natH]
    const p = rotatePoint90(pred.px, pred.py, rotationK, srcW, srcH)
    const cx = p.x * scale, cy = p.y * scale
    const r = Math.max(1, pred.radius * scale)
    const hit = matchZNCC(coarse, tplCoarse, cx - r, cy - r, cx + r, cy + r)
    const coarseScore = hit.score

    // Coarse peak back to native px (centre of the coarse cell).
    let px = (hit.x + 0.5) / scale
    let py = (hit.y + 0.5) / scale
    let score = coarseScore

    // ── full-resolution refine ─────────────────────────────────────────────
    const win = cropWindow?.(px, py, refineHalf)
    if (win) {
      const half = (tplFull.size - 1) / 2
      const gray = { data: win.data, width: win.width, height: win.height }
      const best = matchZNCC(gray, tplFull, half, half, win.width - 1 - half, win.height - 1 - half)
      const sub = subpixelPeak(gray, tplFull, best.x, best.y)
      px = win.originX + sub.x
      py = win.originY + sub.y
      score = best.score
    }

    onLog?.(`${pred.fidId}: predicted (${pred.px.toFixed(1)}, ${pred.py.toFixed(1)}) → matched (${px.toFixed(1)}, ${py.toFixed(1)}), zncc ${score.toFixed(3)} (coarse ${coarseScore.toFixed(3)})`)
    results.push({ fidId: pred.fidId, px, py, score, coarseScore, rotationK })
  }
  return results
}

// ── QC gates ───────────────────────────────────────────────────────────────

function median(values) {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The three QC gates, in order. Pure so the decision logic is testable without a
 * store, a worker, or a browser.
 *
 *   1. absolute — a detection scoring below `minScore` is rejected outright.
 *   2. population — per fidId, take the median score across everything that
 *      survived gate 1 and reject detections more than `POPULATION_BAND` below
 *      it. This is the gate that catches *confident-wrong* matches: a mark that
 *      locks onto the wrong feature can still clear 0.7 in absolute terms, but
 *      it will not match how that same mark scores on every other scan of the
 *      batch. Needs the whole population, which is why detections are buffered
 *      and applied in a second pass.
 *   3. geometric — join the survivors with the sensor's calibrated mm layout and
 *      fit the interior-orientation affine. If `rmsUm` exceeds the gate, drop
 *      the single worst-residual mark and refit ONCE (one bad mark is the common
 *      failure; two means the image is genuinely wrong). Still over ⇒ the image
 *      fails and nothing is written for it — a bad interior orientation is worse
 *      than none, because it silently poisons every downstream pose.
 *
 * @param {{ uuid: string, name?: string, detections: { fidId: string, px: number,
 *          py: number, score: number, rotationK?: number }[] }[]} resultsPerImage
 * @param {{ id: string, xMm: number, yMm: number }[]} marks Sensor's calibrated marks.
 * @param {{ minScore: number, maxRmsUm: number }} cfg
 * @returns {{ uuid: string, name?: string, status: 'ok'|'partial'|'failed',
 *   accepted: { fidId, px, py, score }[], rejected: { fidId, reason, score }[],
 *   rmsUm: number|null, rotationK: number }[]}
 */
export function gateFiducialDetections(resultsPerImage, marks, cfg = {}) {
  const { minScore = 0.7, maxRmsUm = 30 } = cfg
  const POPULATION_BAND = 0.2
  const markById = new Map((marks || []).map((m) => [m.id, m]))

  // Gate 1 — absolute score floor.
  const staged = resultsPerImage.map((img) => {
    const accepted = [], rejected = []
    for (const d of img.detections || []) {
      if (!markById.has(d.fidId)) { rejected.push({ fidId: d.fidId, reason: 'unknown mark', score: d.score }); continue }
      if (!(d.score >= minScore)) { rejected.push({ fidId: d.fidId, reason: `score ${d.score.toFixed(3)} < ${minScore}`, score: d.score }); continue }
      accepted.push(d)
    }
    return { uuid: img.uuid, name: img.name, accepted, rejected, rotationK: img.detections?.[0]?.rotationK ?? 0 }
  })

  // Gate 2 — per-mark population median band.
  const scoresByFid = new Map()
  for (const img of staged) {
    for (const d of img.accepted) {
      if (!scoresByFid.has(d.fidId)) scoresByFid.set(d.fidId, [])
      scoresByFid.get(d.fidId).push(d.score)
    }
  }
  const medianByFid = new Map([...scoresByFid].map(([fidId, s]) => [fidId, median(s)]))
  for (const img of staged) {
    const keep = []
    for (const d of img.accepted) {
      const med = medianByFid.get(d.fidId)
      if (Number.isFinite(med) && d.score < med - POPULATION_BAND) {
        img.rejected.push({ fidId: d.fidId, reason: `score ${d.score.toFixed(3)} below batch median ${med.toFixed(3)}`, score: d.score })
      } else keep.push(d)
    }
    img.accepted = keep
  }

  // Gate 3 — affine RMS, with a single worst-mark drop-and-refit.
  return staged.map((img) => {
    const fitOn = (dets) => fitFiducialAffine(dets.map((d) => {
      const m = markById.get(d.fidId)
      return { px: d.px, py: d.py, xMm: m.xMm, yMm: m.yMm }
    }))

    let accepted = img.accepted
    let fit = accepted.length >= 3 ? fitOn(accepted) : null

    // Drop-and-refit, but ONLY with ≥5 marks. An affine has 6 DOF, so any 3
    // points fit one exactly: with 4 marks, dropping the true outlier and
    // dropping a good mark BOTH leave a 3-point exact fit with rms 0, so the
    // outlier is mathematically unlocalizable — a "repair" there would be a coin
    // flip that writes a wrong interior orientation. 4-mark images that miss the
    // gate therefore fail outright and go back to the user. (Same lesson as the
    // GCP robust fit, METHODS.md §6.5: never let a fit that the outlier has
    // already dragged decide which point is the outlier.)
    if (fit && fit.rmsUm > maxRmsUm && accepted.length >= 5) {
      // Leave-one-out rather than largest-residual: with redundancy this low the
      // outlier still inflates every other mark's residual (masking), and the
      // largest residual is often an innocent mark. Refitting without each
      // candidate in turn measures the thing we actually care about.
      let bestDrop = -1, bestFit = null
      for (let i = 0; i < accepted.length; i++) {
        const trial = fitOn(accepted.filter((_, j) => j !== i))
        if (trial && (!bestFit || trial.rmsUm < bestFit.rmsUm)) { bestFit = trial; bestDrop = i }
      }
      if (bestFit && bestFit.rmsUm <= maxRmsUm) {
        const dropped = accepted[bestDrop]
        img.rejected.push({
          fidId: dropped.fidId,
          reason: `affine outlier (batch rms ${fit.rmsUm.toFixed(1)} µm → ${bestFit.rmsUm.toFixed(1)} µm without it)`,
          score: dropped.score,
        })
        accepted = accepted.filter((_, j) => j !== bestDrop)
        fit = bestFit
      }
    }

    // < 3 surviving marks cannot constrain the affine at all, so there is no
    // interior orientation to write — that is a failure, not a partial success.
    const status = !fit || fit.rmsUm > maxRmsUm ? 'failed'
      : img.rejected.length ? 'partial' : 'ok'
    return {
      uuid: img.uuid, name: img.name, status,
      accepted: status === 'failed' ? [] : accepted,
      rejected: img.rejected,
      rmsUm: fit ? fit.rmsUm : null,
      rotationK: img.rotationK,
    }
  })
}
