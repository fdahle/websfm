// Template-free bootstrap for scanned-film fiducials.
// Pure/worker-safe: generated analytic prototypes + the calibrated layout locate
// enough marks to learn the real-image templates used by fiducialDetect.js.

import { matchZNCC, subpixelPeak } from './fiducialDetect.js'

export const FIDUCIAL_BOOTSTRAP_TUNING = {
  maxDim: 1536,
  searchRadiusFrac: 0.075,
  frameInsetFrac: 0.025,
  prototypeSizes: [9, 13, 17, 25],
  minScore: 0.28,
  minPeakMargin: 0.025,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function rotateUnitPoint(x, y, k) {
  switch (((k % 4) + 4) % 4) {
    case 1: return { x: 1 - y, y: x }
    case 2: return { x: 1 - x, y: 1 - y }
    case 3: return { x: y, y: 1 - x }
    default: return { x, y }
  }
}

// Generated prototypes deliberately describe families, not a particular scan.
// Values are zero/one; ZNCC removes their mean and target exposure.
export function makeFiducialPrototype(family, size, variant = 0) {
  const S = size % 2 ? size : size + 1
  const h = (S - 1) / 2
  const data = new Float32Array(S * S).fill(1)
  const dark = (x, y) => { if (x >= 0 && y >= 0 && x < S && y < S) data[y * S + x] = 0 }
  const r = Math.max(1, Math.round(S * 0.12))
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - h, dy = y - h
    if (family === 'generic') {
      if (variant % 3 === 0 && dx * dx + dy * dy <= (S * 0.18) ** 2) dark(x, y) // dot
      else if (variant % 3 === 1 && (Math.abs(dx) <= r || Math.abs(dy) <= r)) dark(x, y) // crosshair
      else { // ring + centre
        const d = Math.hypot(dx, dy), rr = S * 0.29
        if (Math.abs(d - rr) <= r || d <= r) dark(x, y)
      }
    } else if (family === 'right-angle') {
      const q = variant % 4
      const sx = q === 0 || q === 3 ? 1 : -1
      const sy = q < 2 ? 1 : -1
      if ((Math.abs(dy) <= r && dx * sx >= 0) || (Math.abs(dx) <= r && dy * sy >= 0)) dark(x, y)
    } else if (family === 'cut-45') {
      if (Math.abs(dx + dy) <= r || (dx * dx + (dy + S * 0.25) ** 2 <= (S * 0.12) ** 2)) dark(x, y)
    }
  }
  return { data, size: S }
}

function invertPatch(p) {
  const data = new Float32Array(p.data.length)
  for (let i = 0; i < data.length; i++) data[i] = 1 - p.data[i]
  return { data, size: p.size }
}

function variantsFor(family) {
  if (family === 'right-angle') return 4
  if (family === 'generic') return 3
  return 1
}

function bestPrototypeHit(gray, cx, cy, radius, family, cfg) {
  let best = null
  const hits = []
  for (const size of cfg.prototypeSizes) {
    const half = (size - 1) >> 1
    const x0 = clamp(Math.round(cx - radius), half, gray.width - 1 - half)
    const y0 = clamp(Math.round(cy - radius), half, gray.height - 1 - half)
    const x1 = clamp(Math.round(cx + radius), half, gray.width - 1 - half)
    const y1 = clamp(Math.round(cy + radius), half, gray.height - 1 - half)
    if (x1 < x0 || y1 < y0) continue
    for (let v = 0; v < variantsFor(family); v++) {
      const base = makeFiducialPrototype(family, size, v)
      for (const tpl of [base, invertPatch(base)]) {
        const hit = matchZNCC(gray, tpl, x0, y0, x1, y1)
        hits.push({ ...hit, tpl, size, variant: v })
        if (!best || hit.score > best.score) best = { ...hit, tpl, size, variant: v }
      }
    }
  }
  if (!best) return null
  // Runner-up must be spatially distinct; adjacent samples describe one peak.
  let second = -1
  for (const h of hits) {
    if (Math.hypot(h.x - best.x, h.y - best.y) <= Math.max(2, best.size / 3)) continue
    if (h.score > second) second = h.score
  }
  const sub = subpixelPeak(gray, best.tpl, best.x, best.y)
  return { ...best, x: sub.x, y: sub.y, margin: best.score - second }
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

export function estimateFilmBounds(gray, maxFrac = 0.2) {
  const profile = (vertical) => {
    const n = vertical ? gray.width : gray.height
    const cross = vertical ? gray.height : gray.width
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = 0; j < cross; j++) sum += vertical ? gray.data[j * gray.width + i] : gray.data[i * gray.width + j]
      out[i] = sum / cross
    }
    return out
  }
  const edge = (p, fromStart) => {
    const limit = Math.max(2, Math.floor(p.length * maxFrac))
    let bestI = fromStart ? 1 : p.length - 2, best = 0
    for (let q = 1; q < limit; q++) {
      const i = fromStart ? q : p.length - 1 - q
      const d = Math.abs(p[i] - p[i + (fromStart ? -1 : 1)])
      if (d > best) { best = d; bestI = i }
    }
    return { at: bestI, strength: best }
  }
  const xp = profile(true), yp = profile(false)
  const l = edge(xp, true), r = edge(xp, false), t = edge(yp, true), b = edge(yp, false)
  const range = Math.max(...gray.data) - Math.min(...gray.data) || 1
  const confidence = Math.min(l.strength, r.strength, t.strength, b.strength) / range
  return { left: l.at, right: r.at, top: t.at, bottom: b.at, confidence }
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
