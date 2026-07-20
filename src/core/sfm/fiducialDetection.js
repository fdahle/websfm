// Anonymous fiducial-spot detection. This module deliberately knows nothing
// about camera certificates, metric marks, focal length or principal point.

import { matchZNCC, subpixelPeak } from './fiducialDetect.js'
import { slotsForPositions, slotUnitPoint } from './fiducialModel.js'

export const FIDUCIAL_DETECTION_TUNING = {
  maxDim: 1536,
  searchRadiusFrac: 0.09,
  prototypeSizes: [9, 13, 17, 25],
  minScore: 0.28,
  minPeakMargin: 0.02,
  minFrameConfidence: 0.06,
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export function makeDetectionPrototype(family, size, variant = 0) {
  const S = size % 2 ? size : size + 1, h = (S - 1) / 2
  const data = new Float32Array(S * S).fill(1)
  const dark = (x, y) => { if (x >= 0 && y >= 0 && x < S && y < S) data[y * S + x] = 0 }
  const r = Math.max(1, Math.round(S * 0.1))
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - h, dy = y - h
    if (family === 'generic') {
      if (variant % 3 === 0 && dx * dx + dy * dy <= (S * 0.18) ** 2) dark(x, y)
      else if (variant % 3 === 1 && (Math.abs(dx) <= r || Math.abs(dy) <= r)) dark(x, y)
      else { const d = Math.hypot(dx, dy), rr = S * 0.29; if (Math.abs(d - rr) <= r || d <= r) dark(x, y) }
    } else if (family === 'right-angle') {
      const q = variant % 4, sx = q === 0 || q === 3 ? 1 : -1, sy = q < 2 ? 1 : -1
      if ((Math.abs(dy) <= r && dx * sx >= 0) || (Math.abs(dx) <= r && dy * sy >= 0)) dark(x, y)
    } else if (family === 'cut-45') {
      if (Math.abs(dx + dy) <= r || dx * dx + (dy + S * 0.25) ** 2 <= (S * 0.12) ** 2) dark(x, y)
    }
  }
  return { data, size: S }
}

function invert(p) {
  const data = new Float32Array(p.data.length)
  for (let i = 0; i < data.length; i++) data[i] = 1 - p.data[i]
  return { data, size: p.size }
}

export function estimateDetectionFrame(gray, maxFrac = 0.22) {
  const profile = (vertical) => {
    const n = vertical ? gray.width : gray.height, cross = vertical ? gray.height : gray.width
    const p = new Float64Array(n)
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < cross; j++) s += vertical ? gray.data[j * gray.width + i] : gray.data[i * gray.width + j]; p[i] = s / cross }
    return p
  }
  const edge = (p, start) => {
    const lim = Math.max(2, Math.floor(p.length * maxFrac)); let at = start ? 1 : p.length - 2, strength = 0
    for (let q = 1; q < lim; q++) { const i = start ? q : p.length - 1 - q; const d = Math.abs(p[i] - p[i + (start ? -1 : 1)]); if (d > strength) { at = i; strength = d } }
    return { at, strength }
  }
  const xp = profile(true), yp = profile(false), l = edge(xp, true), r = edge(xp, false), t = edge(yp, true), b = edge(yp, false)
  let lo = Infinity, hi = -Infinity
  for (const v of gray.data) { if (v < lo) lo = v; if (v > hi) hi = v }
  const range = hi - lo || 1
  return { left: l.at, right: r.at, top: t.at, bottom: b.at,
    confidence: Math.min(l.strength, r.strength, t.strength, b.strength) / range }
}

function familyVariants(f) { return f === 'generic' ? 3 : f === 'right-angle' ? 4 : 1 }

function findPeak(gray, cx, cy, radius, family, cfg) {
  let best = null, second = -Infinity
  for (const size of cfg.prototypeSizes) {
    const half = (size - 1) >> 1
    const x0 = clamp(Math.round(cx - radius), half, gray.width - 1 - half), x1 = clamp(Math.round(cx + radius), half, gray.width - 1 - half)
    const y0 = clamp(Math.round(cy - radius), half, gray.height - 1 - half), y1 = clamp(Math.round(cy + radius), half, gray.height - 1 - half)
    if (x1 < x0 || y1 < y0) continue
    for (let v = 0; v < familyVariants(family); v++) {
      const dark = makeDetectionPrototype(family, size, v)
      const templates = cfg.polarity === 'dark' ? [dark] : cfg.polarity === 'light' ? [invert(dark)] : [dark, invert(dark)]
      for (const tpl of templates) {
        const hit = matchZNCC(gray, tpl, x0, y0, x1, y1)
        if (!best || hit.score > best.score) { if (best) second = Math.max(second, best.score); best = { ...hit, tpl, scale: size, variant: v } }
        else second = Math.max(second, hit.score)
      }
    }
  }
  if (!best) return null
  const sub = subpixelPeak(gray, best.tpl, best.x, best.y)
  return { ...best, x: sub.x, y: sub.y, margin: best.score - second }
}

export function refineDetectionSpot(gray, cx, cy, radius, options = {}) {
  const cfg = { ...FIDUCIAL_DETECTION_TUNING, ...options }
  return findPeak(gray, cx, cy, radius, options.family || 'generic', cfg)
}

export function detectFiducialSpots(gray, options = {}) {
  const cfg = { ...FIDUCIAL_DETECTION_TUNING, ...options }
  // Tolerance belongs to image detection only: 0 is strict, 1 permits weaker
  // and less-isolated candidates to reach the manual review queue.
  const tolerance = clamp(Number(options.tolerance ?? 0.5), 0, 1)
  cfg.minScore += (0.5 - tolerance) * 0.2
  cfg.minPeakMargin += (0.5 - tolerance) * 0.02
  const family = options.family || 'generic', positions = options.positions || 'corners'
  const slots = slotsForPositions(positions), frame = estimateDetectionFrame(gray)
  const frameOk = frame.confidence >= cfg.minFrameConfidence && frame.right > frame.left && frame.bottom > frame.top
  const bounds = frameOk ? frame : { left: gray.width * 0.025, right: gray.width * 0.975, top: gray.height * 0.025, bottom: gray.height * 0.975 }
  const radius = Math.max(6, cfg.searchRadiusFrac * Math.max(gray.width, gray.height))
  const accepted = [], drafts = []
  for (const slot of slots) {
    const u = slotUnitPoint(slot), cx = bounds.left + u.x * (bounds.right - bounds.left), cy = bounds.top + u.y * (bounds.bottom - bounds.top)
    if (family === 'frame') {
      const d = { slot, px: cx, py: cy, family, source: 'frame', confidence: frame.confidence, reviewed: false }
      ;(frameOk ? accepted : drafts).push(frameOk ? d : { ...d, reason: 'frame-uncertain' })
      continue
    }
    const hit = findPeak(gray, cx, cy, radius, family, cfg)
    if (!hit) { drafts.push({ slot, px: cx, py: cy, family, source: 'shape', confidence: 0, reason: 'missing-slot' }); continue }
    const confidence = clamp((hit.score - cfg.minScore) / Math.max(1e-6, 1 - cfg.minScore), 0, 1)
    const d = { slot, px: hit.x, py: hit.y, family, source: 'shape', confidence,
      score: hit.score, peakMargin: hit.margin, scale: hit.scale, reviewed: false }
    if (hit.score >= cfg.minScore && hit.margin >= cfg.minPeakMargin && frameOk) accepted.push(d)
    else drafts.push({ ...d, reason: !frameOk ? 'frame-uncertain' : hit.score < cfg.minScore ? 'weak-peak' : 'two-peaks' })
  }
  return { accepted, drafts, frame, requested: slots.length, family, positions }
}
