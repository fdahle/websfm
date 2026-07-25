// Template-free bootstrap for scanned-film fiducials.
// Pure/worker-safe: generated analytic prototypes + the calibrated layout locate
// enough marks to learn the real-image templates used by fiducialDetect.js.
//
// The prototype / frame / peak math lives in `fiducialPrimitives.js`, shared with
// the anonymous-slot policy in `fiducialDetection.js`. This module owns only the
// calibrated-layout policy: metric marks → unit layout → search centres → gating.

import { bestPrototypeHit, estimateFrameBounds, makeFiducialPrototype } from './fiducialPrimitives.js'

export const FIDUCIAL_BOOTSTRAP_TUNING = {
  maxDim: 1536,
  searchRadiusFrac: 0.075,
  frameInsetFrac: 0.025,
  prototypeSizes: [9, 13, 17, 25],
  minScore: 0.28,
  minPeakMargin: 0.025,
  strokeFrac: 0.12,
}

// Re-exported so callers and tests build synthetic scans from the same shapes
// this module searches for.
export { makeFiducialPrototype }

export function rotateUnitPoint(x, y, k) {
  switch (((k % 4) + 4) % 4) {
    case 1: return { x: 1 - y, y: x }
    case 2: return { x: 1 - x, y: 1 - y }
    case 3: return { x: y, y: 1 - x }
    default: return { x, y }
  }
}

/** The film rectangle, measured over this policy's outer band. */
export function estimateFilmBounds(gray, maxFrac = 0.2) {
  return estimateFrameBounds(gray, maxFrac)
}

export function refineFiducialShape(gray, cx, cy, radius, options = {}) {
  const cfg = { ...FIDUCIAL_BOOTSTRAP_TUNING, ...options }
  const family = options.family === 'auto' || !options.family ? 'generic' : options.family
  return bestPrototypeHit(gray, cx, cy, radius, family, cfg)
}

export function normalizedFiducialLayout(marks, rotationK = 0) {
  if (!marks?.length) return []
  const xs = marks.map((m) => m.xMm), ys = marks.map((m) => m.yMm)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  if (!(maxX > minX) || !(maxY > minY)) return []
  return marks.map((m) => {
    const p = rotateUnitPoint((m.xMm - minX) / (maxX - minX), (m.yMm - minY) / (maxY - minY), rotationK)
    return { ...m, nx: p.x, ny: p.y }
  })
}

/** Template-free detections on a downscaled grayscale scan. */
export function bootstrapFiducialsFromGray(gray, marks, options = {}) {
  const cfg = { ...FIDUCIAL_BOOTSTRAP_TUNING, ...options }
  const rotationK = Number.isInteger(options.rotationK) ? options.rotationK : 0
  const family = options.family === 'auto' || !options.family ? 'generic' : options.family
  const layout = normalizedFiducialLayout(marks, rotationK)
  if (layout.length < 3) return { status: 'failed', reason: 'invalid calibrated layout', detections: [], rotationK, family }
  const frame = estimateFilmBounds(gray)
  const useFrame = frame.confidence >= 0.08 && frame.right > frame.left && frame.bottom > frame.top
  const insetX = useFrame ? frame.left : gray.width * cfg.frameInsetFrac
  const insetY = useFrame ? frame.top : gray.height * cfg.frameInsetFrac
  const right = useFrame ? frame.right : gray.width - 1 - insetX
  const bottom = useFrame ? frame.bottom : gray.height - 1 - insetY
  const spanX = right - insetX, spanY = bottom - insetY
  const radius = Math.max(6, cfg.searchRadiusFrac * Math.max(gray.width, gray.height))
  const detections = []
  for (const m of layout) {
    const cx = insetX + m.nx * spanX, cy = insetY + m.ny * spanY
    if (family === 'frame' && useFrame) {
      detections.push({ fidId: m.id, px: cx, py: cy, score: 1, peakMargin: 1, source: 'shape', rotationK })
      continue
    }
    if (family === 'frame') continue
    const hit = bestPrototypeHit(gray, cx, cy, radius, family, cfg)
    if (!hit) continue
    detections.push({ fidId: m.id, px: hit.x, py: hit.y, score: hit.score,
      peakMargin: hit.margin, scale: hit.size, variant: hit.variant, source: 'shape', rotationK })
  }
  const strong = detections.filter((d) => d.score >= cfg.minScore && d.peakMargin >= cfg.minPeakMargin)
  const status = strong.length >= Math.min(4, marks.length) ? 'ok' : strong.length >= 3 ? 'partial' : 'failed'
  return { status, detections, strong, rotationK, family, frame,
    reason: status === 'failed' ? `only ${strong.length} unambiguous mark(s)` : null }
}
