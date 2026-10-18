// Video import: which frames of a video become images. Pure — the browser side
// (utils/videoSource.js) seeks the <video>, draws a reduced frame and hands the
// luma here; this module scores it and chooses the frames.
//
// Two modes:
//   • interval — a frame every N seconds or every N frames (`intervalTimes`);
//   • auto — keyframe selection from per-sample scores (`selectKeyframes`). The
//     video is sampled a few times a second; each sample gets a sharpness score
//     (variance of the Laplacian, as Tools ▸ Image quality uses) and an estimate of
//     how far the view has travelled since the start (`createMotionTracker`). Frames
//     are then spaced by travelled distance, not by time, so a pause yields one frame
//     and a fast pan yields many, and the sharpest frame in each spacing window wins.
//
// Travel is measured in frame widths: 0.2 means the image content has moved by a
// fifth of the frame since the previous keyframe, i.e. ~80 % of it is still shared.

import { resampleArea } from '../features/imageQuality.js'

// Analysis constants, co-located with the algorithm (see the note atop core/tuning.js).
export const VIDEO_ANALYSIS = Object.freeze({
  /** Samples per second of video in the analysis pass. */
  rate: 4,
  /** Cap on analysis samples; a long video is sampled more sparsely to stay under it. */
  maxSamples: 3000,
  /** Long side (px) of the frame the sharpness is measured on. */
  sharpDim: 512,
  /** Long side (px) of the frame the motion is measured on (then halved twice). */
  motionDim: 160,
  /**
   * Motion is measured against an anchor frame, not the previous sample, so slow
   * drift below one pixel per sample still adds up and sensor noise does not. The
   * anchor moves on once the view has travelled this far from it (frame widths).
   */
  reanchor: 0.03,
  /** Two frames no longer show the same view — a cut, or motion too fast to
   *  follow — when their mean absolute difference at the best shift exceeds this
   *  share of the anchor's own mean absolute deviation (two unrelated frames score
   *  ~1.4, the same view with noise and blur well under 0.5). Counted as a full
   *  frame width of travel. Relative, so a dim or hazy video is judged like a
   *  contrasty one. */
  lostRatio: 0.8,
  /** Floor (luma, 0..1) under that deviation, so a featureless view (sky, a wall)
   *  is not "lost" on sensor noise. */
  minContrast: 0.02,
  /** Samples in the rolling median a sample's sharpness is compared with. */
  sharpWindow: 31,
  /** A keyframe is picked from the last `slack` of each spacing step (0.5 = from
   *  half a step to a full step after the previous one). */
  slack: 0.5,
  /** Interval mode never plans more frames than this. */
  maxIntervalFrames: 20000,
})

// ── Files ─────────────────────────────────────────────────────────────────────

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp|mpe?g)$/i

/** Is this dropped/picked file a video? MIME type first, extension as fallback. */
export function isVideoFile(file) {
  if (!file) return false
  if (String(file.type ?? '').startsWith('video/')) return true
  return VIDEO_EXT.test(String(file.name ?? ''))
}

/**
 * The timestamp part of a frame name: minutes, seconds and milliseconds, zero-padded
 * to the video's length so the names sort in time order ("01m02.500s").
 */
export function frameTimestamp(t, duration = t) {
  const ms = Math.max(0, Math.round(t * 1000))
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const width = Math.max(2, String(Math.floor(Math.max(duration, t) / 60)).length)
  return `${String(min).padStart(width, '0')}m${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}s`
}

/** `<video name>_<timestamp>.<ext>`, e.g. `walk_00m12.345s.jpg`. */
export function frameFileName(videoName, t, duration, ext = 'jpg') {
  const base = String(videoName ?? 'video').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'video'
  return `${base}_${frameTimestamp(t, duration)}.${ext}`
}

// ── Timing ────────────────────────────────────────────────────────────────────

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240]

/**
 * Frame rate from a run of presented-frame media times (seconds), e.g. from
 * requestVideoFrameCallback while the video plays. The median gap between distinct
 * times, snapped to a common rate within 1 %. null when there are too few frames.
 */
export function estimateFps(mediaTimes) {
  const t = [...new Set((mediaTimes ?? []).filter(Number.isFinite))].sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 1e-4) gaps.push(t[i] - t[i - 1])
  if (gaps.length < 3) return null
  // Dropped frames during playback show up as double gaps; the smallest common gap
  // is the frame period, so take a low quantile rather than the median.
  gaps.sort((a, b) => a - b)
  const period = gaps[Math.floor(gaps.length * 0.25)]
  if (!(period > 0)) return null
  const fps = 1 / period
  const snap = COMMON_FPS.find((c) => Math.abs(c - fps) / c < 0.01)
  return snap ?? Math.round(fps * 100) / 100
}

/**
 * Interval mode: one frame every `every` seconds (unit 'seconds') or every `every`
 * frames (unit 'frames', converted with `fps`; 30 when the rate is unknown). Times
 * start at 0 and stay inside the video.
 */
export function intervalTimes(duration, { every = 1, unit = 'seconds', fps = null } = {}) {
  const n = Number(every)
  if (!(duration > 0) || !(n > 0)) return []
  const dt = unit === 'frames' ? n / (fps > 0 ? fps : 30) : n
  const out = []
  for (let i = 0; out.length < VIDEO_ANALYSIS.maxIntervalFrames; i++) {
    const t = i * dt
    if (t >= duration - 1e-6) break
    out.push(Math.round(t * 1e6) / 1e6)
  }
  return out
}

/**
 * Analysis sample times for the auto mode: `rate` per second, sparser for a long
 * video so there are at most `maxSamples`, never closer than one frame.
 */
export function analysisTimes(duration, fps = null, { rate = VIDEO_ANALYSIS.rate, maxSamples = VIDEO_ANALYSIS.maxSamples } = {}) {
  if (!(duration > 0)) return { step: 0, times: [] }
  const step = Math.max(1 / rate, duration / maxSamples, fps > 0 ? 1 / fps : 0)
  const times = []
  for (let i = 0; ; i++) {
    const t = i * step
    if (t >= duration - 1e-6) break
    times.push(Math.round(t * 1e6) / 1e6)
  }
  return { step, times }
}

// ── Per-frame scores ──────────────────────────────────────────────────────────

/** Luma (0..1) of an RGBA buffer. */
export function lumaOf(rgba, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    out[i] = (rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114) / 255
  }
  return out
}

/** Output size with the long side at most `maxDim` (never upscaled). */
export function fitSize(width, height, maxDim) {
  const w = Math.max(1, Math.round(width || 1)), h = Math.max(1, Math.round(height || 1))
  const s = maxDim > 0 ? Math.min(1, maxDim / Math.max(w, h)) : 1
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

/** Sharpness: variance of the 3×3 Laplacian over the interior pixels. */
export function laplacianVariance(gray, w, h) {
  if (w < 3 || h < 3) return 0
  let sum = 0, sum2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    const r = y * w
    for (let x = 1; x < w - 1; x++) {
      const i = r + x
      const v = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i]
      sum += v; sum2 += v * v; n++
    }
  }
  const mean = sum / n
  return Math.max(0, sum2 / n - mean * mean)
}

/**
 * Both scores' inputs from one luma frame (any size): the sharpness at
 * `sharpDim` and the reduced frame the motion tracker takes, at `motionDim`.
 */
export function scoreFrame(gray, w, h, { sharpDim = VIDEO_ANALYSIS.sharpDim, motionDim = VIDEO_ANALYSIS.motionDim } = {}) {
  const s = fitSize(w, h, sharpDim)
  const sharpGray = s.width === w && s.height === h ? gray : resampleArea(gray, w, h, s.width, s.height, 1)
  const m = fitSize(s.width, s.height, motionDim)
  const motion = resampleArea(sharpGray, s.width, s.height, m.width, m.height, 1)
  return { sharpness: laplacianVariance(sharpGray, s.width, s.height), motion, motionW: m.width, motionH: m.height }
}

// ── Motion ────────────────────────────────────────────────────────────────────
// A cheap optical-flow proxy: a 3×3 grid of blocks, each matched by mean absolute
// difference, coarse to fine over a three-level pyramid (a global shift at ¼ size,
// then each block at ½ and full size, sub-pixel at the end). The travel of a step is
// the median block displacement, as a fraction of the frame width — a pan moves
// every block, a zoom or a roll moves the outer blocks, and a static camera none.

function half(d, w, h) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1)
  const out = new Float32Array(w2 * h2)
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x
      const r = Math.min(2 * x + 1, w - 1) - 2 * x
      const b = Math.min(2 * y + 1, h - 1) - 2 * y
      out[y * w2 + x] = (d[i] + d[i + r] + d[i + b * w] + d[i + b * w + r]) / 4
    }
  }
  return { d: out, w: w2, h: h2 }
}

function zeroMean(d) {
  let s = 0
  for (let i = 0; i < d.length; i++) s += d[i]
  const m = s / (d.length || 1)
  const out = new Float32Array(d.length)
  for (let i = 0; i < d.length; i++) out[i] = d[i] - m
  return out
}

/** The three-level, mean-removed pyramid the tracker compares. */
export function motionPyramid(gray, w, h) {
  const l0 = { d: zeroMean(gray), w, h }
  const l1 = half(l0.d, w, h)
  const l2 = half(l1.d, l1.w, l1.h)
  return [l0, l1, l2]
}

// Mean |a(x, y) − b(x + dx, y + dy)| over the region of `a`, using only pixels whose
// shifted position lies inside `b`; Infinity when under half the region overlaps.
function regionDiff(a, b, x0, y0, x1, y1, dx, dy) {
  const { w, h } = a
  let s = 0, n = 0
  const ya = Math.max(y0, -dy), yb = Math.min(y1, h - dy)
  const xa = Math.max(x0, -dx), xb = Math.min(x1, w - dx)
  for (let y = ya; y < yb; y++) {
    const ra = y * w, rb = (y + dy) * w + dx
    for (let x = xa; x < xb; x++) { s += Math.abs(a.d[ra + x] - b.d[rb + x]); n++ }
  }
  return n * 2 >= (x1 - x0) * (y1 - y0) ? s / n : Infinity
}

function searchShift(a, b, region, cx, cy, radius) {
  let best = { dx: cx, dy: cy, diff: Infinity }
  for (let dy = cy - radius; dy <= cy + radius; dy++) {
    for (let dx = cx - radius; dx <= cx + radius; dx++) {
      const diff = regionDiff(a, b, region[0], region[1], region[2], region[3], dx, dy)
      if (diff < best.diff || (diff === best.diff && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) {
        best = { dx, dy, diff }
      }
    }
  }
  return best
}

function regionStd(a, [x0, y0, x1, y1]) {
  let s = 0, s2 = 0, n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = a.d[y * a.w + x]; s += v; s2 += v * v; n++ }
  return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0
}

// Parabola through three samples around a minimum: the sub-sample offset in [-½, ½].
function subSample(fm, f0, fp) {
  const den = fm - 2 * f0 + fp
  if (!(den > 0) || !Number.isFinite(den)) return 0
  return Math.max(-0.5, Math.min(0.5, (fm - fp) / (2 * den)))
}

/**
 * Displacement of `cur` against `ref` (both from `motionPyramid`).
 * → { motion (frame widths, median over textured blocks), global {dx, dy} at full
 *   size, diff (mean abs difference at the global shift), atBound (the global search
 *   hit its edge: the view moved faster than it can follow), blocks }
 */
export function measureMotion(ref, cur, { grid = 3, minTexture = 0.01 } = {}) {
  const [r0, r1, r2] = ref, [c0, c1, c2] = cur
  if (r0.w !== c0.w || r0.h !== c0.h) throw new Error('measureMotion: frames differ in size')
  const R2 = Math.max(2, Math.round(r2.w * 0.2))
  const g = searchShift(r2, c2, [0, 0, r2.w, r2.h], 0, 0, R2)
  const atBound = Math.abs(g.dx) === R2 || Math.abs(g.dy) === R2
  const blocks = []
  for (let by = 0; by < grid; by++) {
    for (let bx = 0; bx < grid; bx++) {
      const reg0 = [Math.floor(bx * r0.w / grid), Math.floor(by * r0.h / grid),
        Math.floor((bx + 1) * r0.w / grid), Math.floor((by + 1) * r0.h / grid)]
      if (regionStd(r0, reg0) < minTexture) continue
      const reg1 = [Math.floor(bx * r1.w / grid), Math.floor(by * r1.h / grid),
        Math.floor((bx + 1) * r1.w / grid), Math.floor((by + 1) * r1.h / grid)]
      const b1 = searchShift(r1, c1, reg1, 2 * g.dx, 2 * g.dy, 2)
      if (!Number.isFinite(b1.diff)) continue
      const b0 = searchShift(r0, c0, reg0, 2 * b1.dx, 2 * b1.dy, 1)
      if (!Number.isFinite(b0.diff)) continue
      const at = (dx, dy) => regionDiff(r0, c0, reg0[0], reg0[1], reg0[2], reg0[3], dx, dy)
      const sx = subSample(at(b0.dx - 1, b0.dy), b0.diff, at(b0.dx + 1, b0.dy))
      const sy = subSample(at(b0.dx, b0.dy - 1), b0.diff, at(b0.dx, b0.dy + 1))
      blocks.push({ dx: b0.dx + sx, dy: b0.dy + sy })
    }
  }
  const scale = 4 // level 2 → full size
  const mags = blocks.length >= 3
    ? blocks.map((b) => Math.hypot(b.dx, b.dy))
    : [Math.hypot(g.dx, g.dy) * scale]
  mags.sort((a, b) => a - b)
  const med = mags.length % 2 ? mags[mags.length >> 1] : (mags[mags.length / 2 - 1] + mags[mags.length / 2]) / 2
  return { motion: med / r0.w, global: { dx: g.dx * scale, dy: g.dy * scale }, diff: g.diff, atBound, blocks }
}

/**
 * Accumulates travel over a run of frames (in order). `push(gray, w, h)` takes the
 * reduced luma frame from `scoreFrame` and returns
 *   { travel, sinceAnchor, fast, lost }
 * travel — frame widths travelled since the first frame (never decreases);
 * fast — the view moved further than the search could follow from the anchor;
 * lost — the frame no longer resembles the anchor (a cut): counted as one full width.
 */
export function createMotionTracker({
  reanchor = VIDEO_ANALYSIS.reanchor, lostRatio = VIDEO_ANALYSIS.lostRatio, minContrast = VIDEO_ANALYSIS.minContrast,
} = {}) {
  let anchor = null
  let anchorContrast = 0
  let base = 0
  let travel = 0
  const setAnchor = (pyr) => {
    anchor = pyr
    const l2 = pyr[2].d
    let s = 0
    for (let i = 0; i < l2.length; i++) s += Math.abs(l2[i])
    anchorContrast = Math.max(minContrast, s / (l2.length || 1))
  }
  return {
    push(gray, w, h) {
      const pyr = motionPyramid(gray, w, h)
      if (!anchor) { setAnchor(pyr); return { travel: 0, sinceAnchor: 0, fast: false, lost: false } }
      const m = measureMotion(anchor, pyr)
      const lost = !(m.diff <= lostRatio * anchorContrast)
      let since = m.motion
      if (lost) {
        base = travel + 1
        setAnchor(pyr)
        since = 0
      } else if (m.motion >= reanchor || m.atBound) {
        base += m.motion
        setAnchor(pyr)
        since = 0
      }
      travel = Math.max(travel, base + since)
      return { travel, sinceAnchor: since, fast: m.atBound, lost }
    },
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

/** Each value over the median of its neighbourhood (`window` samples, centred). */
export function relativeSharpness(values, window = VIDEO_ANALYSIS.sharpWindow) {
  const n = values.length
  const half = Math.max(0, Math.floor(window / 2))
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1)
    const win = values.slice(lo, hi).filter(Number.isFinite).sort((a, b) => a - b)
    const k = win.length
    const med = !k ? 0 : k % 2 ? win[k >> 1] : (win[k / 2 - 1] + win[k / 2]) / 2
    out[i] = med > 0 && Number.isFinite(values[i]) ? values[i] / med : 1
  }
  return out
}

function pickGreedy(travel, rel, step, minSharpness, slack) {
  const n = travel.length
  const sharp = (j) => rel[j] >= minSharpness
  // The sharpest index in [a, b), preferring frames that are not blurry; null when
  // `requireSharp` and every one is blurry.
  const best = (a, b, requireSharp) => {
    let bi = null
    for (let j = a; j < b; j++) {
      if (requireSharp && !sharp(j)) continue
      if (bi == null || rel[j] > rel[bi]) bi = j
    }
    return bi
  }
  const indices = []
  let blurryKept = 0, gaps = 0
  // First frame: the sharpest within the first `slack` of a step.
  let end = 0
  while (end < n && travel[end] <= travel[0] + slack * step) end++
  let last = best(0, end, true)
  if (last == null) { last = best(0, end, false); blurryKept++ }
  indices.push(last)
  for (;;) {
    const lo = travel[last] + (1 - slack) * step
    const hi = travel[last] + step
    let a = last + 1
    while (a < n && travel[a] < lo) a++
    if (a >= n) break
    let b = a
    while (b < n && travel[b] <= hi) b++
    if (b === a) {
      // Nothing inside the window: the view jumped past it between two samples.
      gaps++
      last = a
      indices.push(last)
      continue
    }
    let pick = best(a, b, true)
    if (pick == null) {
      // Every candidate is blurry: look a little further for a sharp one (a gap of
      // up to two steps still overlaps), else keep the sharpest blurry frame — a
      // soft frame links the sequence, a missing one can split it.
      let c = b
      while (c < n && travel[c] <= travel[last] + 2 * step) c++
      pick = best(b, c, true)
      // The video ends inside the blur: nothing after it to link to.
      if (pick == null && c >= n) break
      if (pick == null) { pick = best(a, b, false); blurryKept++ }
    }
    last = pick
    indices.push(last)
  }
  return { indices, blurryKept, gaps }
}

/**
 * Choose keyframes from analysis samples `[{ t, sharpness, travel }]` (in time
 * order; `travel` from `createMotionTracker`).
 *
 * Consecutive keyframes are about `1 − overlap/100` frame widths of travel apart:
 * each one is the sharpest sample between half a step and a full step after the
 * previous one, skipping samples whose sharpness is below `minSharpness` × the
 * median of their neighbourhood. When that would give more than `maxFrames`, the
 * step widens until it fits (and the overlap actually reached is reported).
 *
 * → { indices, times, step, overlap (%, as planned), blurry (samples below the
 *     sharpness gate), blurryKept, gaps, travel (total) }
 */
export function selectKeyframes(samples, {
  overlap = 80, maxFrames = 200, minSharpness = 0.5,
  window = VIDEO_ANALYSIS.sharpWindow, slack = VIDEO_ANALYSIS.slack,
} = {}) {
  const n = samples?.length ?? 0
  if (!n) return { indices: [], times: [], step: 0, overlap, blurry: 0, blurryKept: 0, gaps: 0, travel: 0 }
  const rel = relativeSharpness(samples.map((s) => s.sharpness), window)
  const travel = new Float64Array(n)
  for (let i = 0, m = 0; i < n; i++) { m = Math.max(m, Number(samples[i].travel) || 0); travel[i] = m }
  const total = travel[n - 1] - travel[0]
  const step0 = Math.min(1, Math.max(0.01, 1 - (Number(overlap) || 0) / 100))
  let step = step0
  let res = pickGreedy(travel, rel, step, minSharpness, slack)
  const cap = Math.max(2, Math.floor(Number(maxFrames) || 0))
  if (maxFrames > 0 && res.indices.length > cap) {
    // Count falls as the step grows: double to bracket, then bisect.
    let lo = step0, hi = step0
    let hiRes = res
    for (let k = 0; k < 40 && hiRes.indices.length > cap; k++) {
      lo = hi
      hi *= 2
      hiRes = pickGreedy(travel, rel, hi, minSharpness, slack)
    }
    for (let k = 0; k < 40 && hi - lo > 1e-4 * hi; k++) {
      const mid = (lo + hi) / 2
      const r = pickGreedy(travel, rel, mid, minSharpness, slack)
      if (r.indices.length > cap) lo = mid
      else { hi = mid; hiRes = r }
    }
    step = hi
    res = hiRes
  }
  let blurry = 0
  for (let i = 0; i < n; i++) if (rel[i] < minSharpness) blurry++
  return {
    indices: res.indices,
    times: res.indices.map((i) => samples[i].t),
    step,
    overlap: Math.max(0, Math.round((1 - step) * 100)),
    blurry,
    blurryKept: res.blurryKept,
    gaps: res.gaps,
    travel: total,
  }
}
