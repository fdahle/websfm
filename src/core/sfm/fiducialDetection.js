// Anonymous fiducial-spot detection. This module deliberately knows nothing
// about camera certificates, metric marks, focal length or principal point.
//
// The prototype / frame / peak math lives in `fiducialPrimitives.js`, shared with
// the calibrated-layout policy in `fiducialBootstrap.js`. This module owns only
// the anonymous-slot policy: declared slots → search centres → accept/review.

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
}

/** Analytic prototype at this policy's stroke width (thinner than bootstrap's). */
export function makeDetectionPrototype(family, size, variant = 0) {
  return makeFiducialPrototype(family, size, variant, { strokeFrac: FIDUCIAL_DETECTION_TUNING.strokeFrac })
}

/** The film rectangle, measured over this policy's outer band. */
export function estimateDetectionFrame(gray, maxFrac = 0.22) {
  return estimateFrameBounds(gray, maxFrac)
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
    const confidence = clamp((hit.score - cfg.minScore) / Math.max(1e-6, 1 - cfg.minScore), 0, 1)
    const d = { slot, px: hit.x, py: hit.y, family, source: 'shape', confidence,
      score: hit.score, peakMargin: hit.margin, scale: hit.size, reviewed: false }
    if (hit.score >= cfg.minScore && hit.margin >= cfg.minPeakMargin && frameOk) accepted.push(d)
    else drafts.push({ ...d, reason: !frameOk ? 'frame-uncertain' : hit.score < cfg.minScore ? 'weak-peak' : 'two-peaks' })
  }
  return { accepted, drafts, frame, requested: slots.length, family, positions }
}
