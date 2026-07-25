import { describe, expect, it } from 'vitest'
import { detectFiducialSpots, makeDetectionPrototype } from './fiducialDetection.js'
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
