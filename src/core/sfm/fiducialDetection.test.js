import { describe, expect, it } from 'vitest'
import { detectFiducialSpots, makeDetectionPrototype, nativeRefinePlan, refineDetectionSpot } from './fiducialDetection.js'
import { slotUnitPoint, slotsForPositions } from './fiducialModel.js'

function scan(family = 'generic', positions = 'corners') {
  const width = 241, height = 201, data = new Float32Array(width * height).fill(15)
  const bounds = { l: 8, r: 232, t: 7, b: 193 }
  for (let y = bounds.t; y <= bounds.b; y++) for (let x = bounds.l; x <= bounds.r; x++) data[y * width + x] = 225
  for (const slot of slotsForPositions(positions)) {
    const u = slotUnitPoint(slot), cx = Math.round(bounds.l + u.x * (bounds.r - bounds.l)), cy = Math.round(bounds.t + u.y * (bounds.b - bounds.t))
    const p = makeDetectionPrototype(family, 13, family === 'generic' ? 1 : 0), h = 6
    for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) data[(cy - h + y) * width + cx - h + x] = p.data[y * 13 + x] ? 225 : 20
  }
  return { data, width, height }
}

describe('anonymous fiducial detection', () => {
  it('finds corner slots without any calibration object', () => {
    const out = detectFiducialSpots(scan(), { family: 'generic', positions: 'corners', minPeakMargin: -1 })
    expect(out.accepted.map((d) => d.slot).sort()).toEqual(slotsForPositions('corners').sort())
  })
  it('finds corner and side slots independently of metric layout', () => {
    const out = detectFiducialSpots(scan('right-angle', 'corners+sides'), { family: 'right-angle', positions: 'corners+sides', minPeakMargin: -1 })
    expect(out.accepted).toHaveLength(8)
  })
  // Regression: the two cases above disable the ambiguity gate (minPeakMargin:
  // -1), which is how a broken margin went unnoticed — it was measured against a
  // near-duplicate of the peak itself, so clean marks scored ~0 and were filed as
  // 'two-peaks'. A clean synthetic scan must pass at the SHIPPED default.
  it('accepts unambiguous marks at the default peak-margin gate', () => {
    const out = detectFiducialSpots(scan(), { family: 'generic', positions: 'corners' })
    expect(out.accepted.map((d) => d.slot).sort()).toEqual(slotsForPositions('corners').sort())
    expect(out.drafts).toEqual([])
    for (const d of out.accepted) expect(d.peakMargin).toBeGreaterThan(0)
  })

  it('never invents frame fiducials on a flat image', () => {
    const gray = { data: new Float32Array(100 * 80).fill(100), width: 100, height: 80 }
    const out = detectFiducialSpots(gray, { family: 'frame' })
    expect(out.accepted).toEqual([])
    expect(out.drafts.every((d) => d.reason === 'frame-uncertain')).toBe(true)
  })
})

// The worker's coarse → native path (workers/ops/detect.js), replayed in node: a
// 4× native scan, a box-downsampled thumbnail, then the planned native window.
describe('native refine plan', () => {
  const F = 4, size = 53, family = 'generic', variant = 1
  function nativeScan() {
    const width = 964, height = 804, data = new Float32Array(width * height).fill(15)
    const b = { l: 32, r: 928, t: 28, b: 772 }
    for (let y = b.t; y <= b.b; y++) for (let x = b.l; x <= b.r; x++) data[y * width + x] = 225
    const centres = {}
    for (const slot of slotsForPositions('corners')) {
      const u = slotUnitPoint(slot), cx = Math.round(b.l + u.x * (b.r - b.l)), cy = Math.round(b.t + u.y * (b.b - b.t))
      const p = makeDetectionPrototype(family, size, variant), h = (size - 1) / 2
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[(cy - h + y) * width + cx - h + x] = p.data[y * size + x] ? 225 : 20
      centres[slot] = { x: cx, y: cy }
    }
    return { gray: { data, width, height }, centres }
  }
  const downsample = (g) => {
    const w = g.width / F, h = g.height / F, data = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0
      for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) s += g.data[(y * F + j) * g.width + x * F + i]
      data[y * w + x] = s / (F * F)
    }
    return { data, width: w, height: h }
  }
  // cropGray: the requested rect clamped into the image; origin = true position.
  const crop = (g, x0, y0, w, h) => {
    const ox = Math.max(0, Math.round(x0)), oy = Math.max(0, Math.round(y0))
    const cw = Math.min(g.width - ox, Math.round(w)), ch = Math.min(g.height - oy, Math.round(h))
    const data = new Float32Array(cw * ch)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) data[y * cw + x] = g.data[(oy + y) * g.width + ox + x]
    return { data, width: cw, height: ch, originX: ox, originY: oy }
  }

  it('lands on the native centre with the coarse winner\'s variant and polarity only', () => {
    const { gray, centres } = nativeScan()
    const coarse = detectFiducialSpots(downsample(gray), { family, positions: 'corners' })
    expect(coarse.accepted).toHaveLength(4)
    for (const [i, d] of coarse.accepted.entries()) {
      const plan = nativeRefinePlan(d, 1 / F)
      expect(plan.variants).toEqual([d.variant])
      expect(plan.polarity).toBe(d.polarity)
      expect(plan.radius).toBe(12) // 3 coarse px
      const win = crop(gray, plan.px0 - plan.half, plan.py0 - plan.half, 2 * plan.half + 1, 2 * plan.half + 1)
      const hit = refineDetectionSpot(win, plan.px0 - win.originX, plan.py0 - win.originY, plan.radius,
        { family, prototypeSizes: plan.sizes, variants: plan.variants, polarity: plan.polarity })
      const c = centres[d.slot]
      expect(Math.hypot(win.originX + hit.x - c.x, win.originY + hit.y - c.y)).toBeLessThan(1)
      // Same answer as the old full sweep over a ±0.45·half window, every variant
      // (one mark only: that sweep is the ~70× cost this plan removes).
      if (i > 0) continue
      const oldHalf = Math.max(24, Math.round(plan.sizes[1] * 2.5))
      const oldWin = crop(gray, plan.px0 - oldHalf, plan.py0 - oldHalf, 2 * oldHalf + 1, 2 * oldHalf + 1)
      const old = refineDetectionSpot(oldWin, plan.px0 - oldWin.originX, plan.py0 - oldWin.originY,
        Math.max(4, oldHalf * 0.45), { family, prototypeSizes: plan.sizes })
      expect(Math.hypot(win.originX + hit.x - (oldWin.originX + old.x), win.originY + hit.y - (oldWin.originY + old.y))).toBeLessThan(0.5)
    }
  }, 30000)
  it('does not refine a frame point or a missing-slot guess', () => {
    expect(nativeRefinePlan({ family: 'frame', px: 1, py: 1 }, 0.25)).toBe(null)
    expect(nativeRefinePlan({ family, reason: 'missing-slot', px: 1, py: 1 }, 0.25)).toBe(null)
  })
})
