// Anonymous fiducial-spot detection. This module deliberately knows nothing
// about camera certificates, metric marks, focal length or principal point.
//
// The prototype / frame / peak math lives in `fiducialPrimitives.js`. This module
// owns only the anonymous-slot policy: declared slots → search centres →
// accept/review.

import { bestPrototypeHit, clamp, estimateFrameBounds, makeFiducialPrototype } from './fiducialPrimitives.js'
import { slotsForPositions, slotUnitPoint } from './fiducialModel.js'

export const FIDUCIAL_DETECTION_TUNING = {
  maxDim: 1536,
  searchRadiusFrac: 0.09,
  prototypeSizes: [9, 13, 17, 25],
  minScore: 0.28,
  minPeakMargin: 0.02,
  minFrameConfidence: 0.06,
  strokeFrac: 0.1,
  // Native refine search radius, in coarse pixels (nativeRefinePlan).
  refineRadiusCoarsePx: 3,
}

/** Analytic prototype at this policy's stroke width (thinner than bootstrap's). */
export function makeDetectionPrototype(family, size, variant = 0) {
  return makeFiducialPrototype(family, size, variant, { strokeFrac: FIDUCIAL_DETECTION_TUNING.strokeFrac })
}

/** The film rectangle, measured over this policy's outer band. */
export function estimateDetectionFrame(gray, maxFrac = 0.22) {
  return estimateFrameBounds(gray, maxFrac)
}

/**
 * Native-resolution refine window for one coarse detection (detected at
 * `scale` = coarse/native). The coarse peak is already sub-pixel, so the true
 * centre is within a couple of coarse pixels: search ±`refineRadiusCoarsePx`
 * coarse px, with the coarse winner's variant and polarity and three sizes
 * around its native size. Re-sweeping every orientation and polarity across a
 * ±0.45·half window (≈95 native px on a 10k scan) cost ~100× more and could
 * only add a wrong-orientation peak.
 * Returns null for a detection with nothing to refine — a frame-family point is
 * a geometric construction, and a missing-slot draft is only the slot guess.
 */
export function nativeRefinePlan(d, scale, cfg = FIDUCIAL_DETECTION_TUNING) {
  if (d.family === 'frame' || d.reason === 'missing-slot' || !(scale > 0)) return null
  const px0 = d.px / scale, py0 = d.py / scale
  const nativeSize = Math.max(7, Math.round((d.scale || 13) / scale)) | 1
  const radius = Math.max(4, Math.ceil((cfg.refineRadiusCoarsePx ?? 3) / scale))
  // Window: the template plus the search radius, so every candidate centre is legal.
  const half = ((nativeSize + 4) >> 1) + radius + 2
  return {
    px0, py0, half, radius,
    sizes: [nativeSize - 4, nativeSize, nativeSize + 4].map((s) => Math.max(5, s | 1)),
    variants: Number.isInteger(d.variant) ? [d.variant] : undefined,
    polarity: d.polarity === 'dark' || d.polarity === 'light' ? d.polarity : undefined,
  }
}

/** ZNCC score → 0..1 confidence above the acceptance floor (one scale for every source). */
export function detectionConfidence(score, minScore = FIDUCIAL_DETECTION_TUNING.minScore) {
  return clamp((score - minScore) / Math.max(1e-6, 1 - minScore), 0, 1)
}

export function refineDetectionSpot(gray, cx, cy, radius, options = {}) {
  const cfg = { ...FIDUCIAL_DETECTION_TUNING, ...options }
  return bestPrototypeHit(gray, cx, cy, radius, options.family || 'generic', cfg)
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
    const hit = bestPrototypeHit(gray, cx, cy, radius, family, cfg)
    if (!hit) { drafts.push({ slot, px: cx, py: cy, family, source: 'shape', confidence: 0, reason: 'missing-slot' }); continue }
    const confidence = detectionConfidence(hit.score, cfg.minScore)
    const d = { slot, px: hit.x, py: hit.y, family, source: 'shape', confidence,
      score: hit.score, peakMargin: hit.margin, scale: hit.size,
      variant: hit.variant, polarity: hit.polarity, reviewed: false }
    if (hit.score >= cfg.minScore && hit.margin >= cfg.minPeakMargin && frameOk) accepted.push(d)
    else drafts.push({ ...d, reason: !frameOk ? 'frame-uncertain' : hit.score < cfg.minScore ? 'weak-peak' : 'two-peaks' })
  }
  return { accepted, drafts, frame, requested: slots.length, family, positions }
}
