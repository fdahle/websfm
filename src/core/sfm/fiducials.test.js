import { describe, it, expect } from 'vitest'
import {
  fitFiducialAffine, canonicalFrame, scanToCanonical, canonicalToScan, mmToScan,
} from './fiducials.js'

// A calibrated 4-corner fiducial layout (mm, certificate origin at frame centre),
// typical of an aerial metric camera (≈212mm frame).
const MARKS = [
  { id: 'F1', xMm: -106, yMm: -106 },
  { id: 'F2', xMm: 106, yMm: -106 },
  { id: 'F3', xMm: 106, yMm: 106 },
  { id: 'F4', xMm: -106, yMm: 106 },
]
const FIDUCIALS = { marks: MARKS, ppxMm: 0.011, ppyMm: -0.004, focalMm: 153.87 }

// Build synthetic scan-pixel observations by applying a known affine mm→px
// (scanner geometry) so we can check exact recovery of its inverse.
function makeObs(marks, { pitchMm = 0.0227, rotDeg = 0, offX = 1000, offY = 1200, shear = 0, noiseMm = 0 } = {}) {
  const c = Math.cos(rotDeg * Math.PI / 180), s = Math.sin(rotDeg * Math.PI / 180)
  return marks.map((m) => {
    // mm → px: rotate+shear+scale then offset. (Inverse of what fit recovers.)
    const xs = m.xMm + shear * m.yMm
    const px = (c * xs - s * m.yMm) / pitchMm + offX
    const py = (s * xs + c * m.yMm) / pitchMm + offY
    const nx = noiseMm ? (Math.random() - 0.5) * 2 * noiseMm : 0
    const ny = noiseMm ? (Math.random() - 0.5) * 2 * noiseMm : 0
    return { px, py, xMm: m.xMm + nx, yMm: m.yMm + ny }
  })
}

describe('fitFiducialAffine', () => {
  it('recovers pixel pitch and a clean affine with no noise', () => {
    const obs = makeObs(MARKS, { pitchMm: 0.0227, rotDeg: 3.2, offX: 900, offY: 1100 })
    const fit = fitFiducialAffine(obs)
    expect(fit).not.toBeNull()
    expect(fit.pitchMm).toBeCloseTo(0.0227, 6)
    expect(fit.rmsUm).toBeLessThan(1e-3) // sub-µm on exact data
    expect(Math.abs(fit.rotDeg)).toBeCloseTo(3.2, 3)
    expect(fit.scaleRatio).toBeCloseTo(1, 4) // isotropic scanner
  })

  it('reports per-mark residuals in µm', () => {
    const obs = makeObs(MARKS, { pitchMm: 0.02, rotDeg: 1 })
    const fit = fitFiducialAffine(obs)
    expect(fit.residualsUm).toHaveLength(4)
    expect(fit.residualsUm.every((r) => r < 1e-3)).toBe(true)
  })

  it('recovers pitch within tolerance under scan noise', () => {
    const obs = makeObs(MARKS, { pitchMm: 0.0227, rotDeg: 2, noiseMm: 0.05 })
    const fit = fitFiducialAffine(obs)
    // 50µm mark noise on a 212mm frame ⇒ pitch still within ~1%.
    expect(fit.pitchMm).toBeGreaterThan(0.0227 * 0.98)
    expect(fit.pitchMm).toBeLessThan(0.0227 * 1.02)
    expect(fit.rmsUm).toBeGreaterThan(0) // noise leaves a residual
  })

  it('rejects fewer than 3 marks', () => {
    expect(fitFiducialAffine([])).toBeNull()
    expect(fitFiducialAffine(makeObs(MARKS.slice(0, 2)))).toBeNull()
  })

  it('rejects collinear marks (degenerate system)', () => {
    const collinear = [
      { px: 0, py: 0, xMm: 0, yMm: 0 },
      { px: 100, py: 0, xMm: 10, yMm: 0 },
      { px: 200, py: 0, xMm: 20, yMm: 0 },
      { px: 300, py: 0, xMm: 30, yMm: 0 },
    ]
    expect(fitFiducialAffine(collinear)).toBeNull()
  })

  it('ignores non-finite observations', () => {
    const obs = makeObs(MARKS)
    obs.push({ px: NaN, py: 1, xMm: 2, yMm: 3 })
    const fit = fitFiducialAffine(obs)
    expect(fit).not.toBeNull()
    expect(fit.residualsUm).toHaveLength(4) // the bad row was dropped
  })
})

describe('canonicalFrame', () => {
  it('K matches focal/pitch arithmetic', () => {
    const pitchMm = 0.0227
    const frame = canonicalFrame(FIDUCIALS, pitchMm)
    expect(frame).not.toBeNull()
    expect(frame.K.fx).toBeCloseTo(153.87 / pitchMm, 6)
    expect(frame.K.fx).toBe(frame.K.fy)
    // Principal point maps through the same mm→px transform.
    expect(frame.K.cx).toBeCloseTo((0.011 - frame.originX) / pitchMm, 6)
    expect(frame.K.cy).toBeCloseTo((-0.004 - frame.originY) / pitchMm, 6)
    // Grid spans the fiducial bbox (212mm) at the given pitch, plus margin.
    expect(frame.width).toBeGreaterThan(212 / pitchMm)
    expect(frame.height).toBeGreaterThan(212 / pitchMm)
  })

  it('rejects a bad pitch or too few marks', () => {
    expect(canonicalFrame(FIDUCIALS, 0)).toBeNull()
    expect(canonicalFrame({ ...FIDUCIALS, marks: MARKS.slice(0, 2) }, 0.02)).toBeNull()
  })
})

describe('scanToCanonical / canonicalToScan round-trip', () => {
  it('is the identity', () => {
    const obs = makeObs(MARKS, { pitchMm: 0.0227, rotDeg: 2.5, shear: 0.001 })
    const fit = fitFiducialAffine(obs)
    const frame = canonicalFrame(FIDUCIALS, fit.pitchMm)
    for (const [px, py] of [[500, 700], [1500, 300], [42.5, 1999.9]]) {
      const { x, y } = scanToCanonical(px, py, fit.A, frame)
      const back = canonicalToScan(x, y, fit.A, frame)
      expect(back.x).toBeCloseTo(px, 6)
      expect(back.y).toBeCloseTo(py, 6)
    }
  })

  it('mmToScan recovers each mark\'s scan pixel (ghost-guide prediction)', () => {
    const opts = { pitchMm: 0.0227, rotDeg: 2.5, offX: 1000, offY: 1200, shear: 0.001 }
    const obs = makeObs(MARKS, opts)
    const fit = fitFiducialAffine(obs)
    // Predicting from the fit reproduces the synthetic scan pixel of every mark.
    MARKS.forEach((m, i) => {
      const p = mmToScan(m.xMm, m.yMm, fit.A)
      expect(p.x).toBeCloseTo(obs[i].px, 4)
      expect(p.y).toBeCloseTo(obs[i].py, 4)
    })
  })

  it('mmToScan returns null on a degenerate affine', () => {
    expect(mmToScan(1, 1, [0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('maps the principal point mm to the canonical K centre', () => {
    const pitchMm = 0.0227
    const frame = canonicalFrame(FIDUCIALS, pitchMm)
    // A scan px whose affine lands exactly on the principal point mm should map to (cx, cy).
    // Use the identity affine (mm == px·pitch offset by origin is not needed here);
    // build A so that scan (0,0) → ppMm directly.
    const A = [pitchMm, 0, FIDUCIALS.ppxMm, 0, pitchMm, FIDUCIALS.ppyMm]
    const { x, y } = scanToCanonical(0, 0, A, frame)
    expect(x).toBeCloseTo(frame.K.cx, 6)
    expect(y).toBeCloseTo(frame.K.cy, 6)
  })
})

describe('y-up fiducial certificates (scan rows run down)', () => {
  // A certificate in the photogrammetric convention: +y towards the top of the
  // frame, i.e. towards SMALLER scan rows. scan→mm is then a reflection.
  const pitchMm = 0.0227
  const obs = MARKS.map((m) => ({ px: 1000 + m.xMm / pitchMm, py: 1200 - m.yMm / pitchMm, xMm: m.xMm, yMm: m.yMm }))
  const fit = fitFiducialAffine(obs)
  const frame = canonicalFrame(FIDUCIALS, fit.pitchMm, { yUp: true })

  it('the fit is a reflection, and the y-up frame undoes it (canonical image not mirrored)', () => {
    expect(fit.A[0] * fit.A[4] - fit.A[1] * fit.A[3]).toBeLessThan(0)
    // Two scan points, one above the other: their canonical order must match.
    const top = scanToCanonical(1000, 300, fit.A, frame), bottom = scanToCanonical(1000, 2000, fit.A, frame)
    expect(top.y).toBeLessThan(bottom.y)
    const left = scanToCanonical(300, 1200, fit.A, frame), right = scanToCanonical(2000, 1200, fit.A, frame)
    expect(left.x).toBeLessThan(right.x)
  })

  it('round-trips exactly and puts the principal point on K', () => {
    for (const [px, py] of [[500, 700], [1500, 300], [42.5, 1999.9]]) {
      const c = scanToCanonical(px, py, fit.A, frame), back = canonicalToScan(c.x, c.y, fit.A, frame)
      expect(back.x).toBeCloseTo(px, 6)
      expect(back.y).toBeCloseTo(py, 6)
    }
    const ppScan = { px: 1000 + FIDUCIALS.ppxMm / pitchMm, py: 1200 - FIDUCIALS.ppyMm / pitchMm }
    const pp = scanToCanonical(ppScan.px, ppScan.py, fit.A, frame)
    expect(pp.x).toBeCloseTo(frame.K.cx, 4)
    expect(pp.y).toBeCloseTo(frame.K.cy, 4)
    // Every mark lands inside the canonical raster.
    for (const o of obs) {
      const c = scanToCanonical(o.px, o.py, fit.A, frame)
      expect(c.y).toBeGreaterThanOrEqual(0)
      expect(c.y).toBeLessThanOrEqual(frame.height)
    }
  })

  it('a frame saved before ySign existed keeps the old mapping', () => {
    const legacy = canonicalFrame(FIDUCIALS, fit.pitchMm)
    expect(legacy.ySign).toBeUndefined()
    const c = scanToCanonical(500, 700, fit.A, legacy)
    const mm = { y: fit.A[3] * 500 + fit.A[4] * 700 + fit.A[5] }
    expect(c.y).toBeCloseTo((mm.y - legacy.originY) / legacy.pitchMm, 9)
  })
})
