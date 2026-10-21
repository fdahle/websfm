import { describe, expect, it } from 'vitest'
import { fitFiducialTransform, applyFiducialTransform, invertFiducialTransform } from './fiducialCalibration.js'

// A KH-9-like frame at 28 µm/px: 46 × 23 cm film, a 1 cm reseau, the film deformed by a
// smooth field (up to ~60 µm) and placed on the scanner rotated + shifted.
const PITCH = 0.028,
  STEP = 10,
  W = 460,
  H = 230
const warp = (x, y) => {
  const u = x / (W / 2),
    v = y / (H / 2)
  return [
    0.06 * (0.6 * Math.sin(Math.PI * u + 0.4) * Math.cos(0.5 * Math.PI * v) + 0.4 * u * v),
    0.06 * (0.6 * Math.cos(0.5 * Math.PI * u) * Math.sin(Math.PI * v - 1.2) + 0.3 * (u * u - 1 / 3)),
  ]
}
const th = 0.004,
  sx = 31,
  sy = -18
// Exposed film mm → scan px (deform, then place), and its inverse by iteration.
const toScan = (x, y) => {
  const [dx, dy] = warp(x, y),
    qx = x + dx,
    qy = y + dy
  const xr = Math.cos(th) * qx - Math.sin(th) * qy,
    yr = Math.sin(th) * qx + Math.cos(th) * qy
  return { px: 8000 + sx + xr / PITCH, py: 4000 + sy - yr / PITCH }
}
const toFilm = (px, py) => {
  const xr = (px - 8000 - sx) * PITCH,
    yr = -(py - 4000 - sy) * PITCH
  const qx = Math.cos(th) * xr + Math.sin(th) * yr,
    qy = -Math.sin(th) * xr + Math.cos(th) * yr
  let x = qx,
    y = qy
  for (let k = 0; k < 6; k++) {
    const [dx, dy] = warp(x, y)
    x = qx - dx
    y = qy - dy
  }
  return { x, y }
}
let seed = 3
const rnd = () => {
  seed = (1664525 * seed + 1013904223) >>> 0
  return seed / 4294967296
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())

function crosses({ noisePx = 0.15, drop = 0, outlier = false } = {}) {
  const pairs = []
  for (let gy = -110; gy <= 110; gy += STEP)
    for (let gx = -230; gx <= 230; gx += STEP) {
      if (rnd() < drop) continue
      const s = toScan(gx, gy)
      pairs.push({ px: s.px + noisePx * gauss(), py: s.py + noisePx * gauss(), xMm: gx, yMm: gy })
    }
  if (outlier) pairs[200].px += 25
  return pairs
}

// The model's error against the truth at random film points, in scan pixels.
function errorPx(fit) {
  let worst = 0,
    sum = 0,
    n = 0
  for (let k = 0; k < 2000; k++) {
    const x = (rnd() - 0.5) * 440,
      y = (rnd() - 0.5) * 210
    const s = toScan(x, y),
      m = applyFiducialTransform({ x: s.px, y: s.py }, fit)
    const e = Math.hypot(m.x - x, m.y - y) / PITCH
    worst = Math.max(worst, e)
    sum += e * e
    n++
  }
  return { rms: Math.sqrt(sum / n), worst }
}

describe('the reseau transform (SAT-5)', () => {
  it('recovers a deformed, rotated scan to well under half a pixel; the affine alone cannot', () => {
    const pairs = crosses()
    const fit = fitFiducialTransform(pairs, 'reseau', { spacingMm: STEP })
    const affine = fitFiducialTransform(pairs, 'affine')
    expect(fit.residual.nx).toBe(47)
    expect(fit.residual.ny).toBe(23)
    const e = errorPx(fit),
      ea = errorPx(affine)
    expect(e.rms).toBeLessThan(0.15)
    expect(e.worst).toBeLessThan(0.5)
    expect(ea.rms).toBeGreaterThan(0.6) // the deformation an affine leaves (> 0.5 px)
    expect(fit.affineRmsUm).toBeGreaterThan(15)
    expect(fit.rmsUm).toBeLessThan(8) // ≈ the detection noise left at the crosses
  })

  it('inverts exactly (mm → scan → mm)', () => {
    const fit = fitFiducialTransform(crosses(), 'reseau', { spacingMm: STEP })
    for (const [x, y] of [
      [0, 0],
      [200, -100],
      [-225, 105],
      [123.4, 56.7],
    ]) {
      const s = invertFiducialTransform({ x, y }, fit),
        m = applyFiducialTransform(s, fit)
      expect(Math.hypot(m.x - x, m.y - y) * 1000).toBeLessThan(0.01)
      const t = toFilm(s.x, s.y)
      expect(Math.hypot(t.x - x, t.y - y) / PITCH).toBeLessThan(0.5)
    }
  })

  it('drops a mis-detected cross and fills missing ones from their neighbours', () => {
    const fit = fitFiducialTransform(crosses({ drop: 0.15, outlier: true }), 'reseau', { spacingMm: STEP })
    expect(fit.outliers).toBe(1)
    expect(fit.crosses).toBeLessThan(47 * 23)
    expect(errorPx(fit).worst).toBeLessThan(0.5)
  })

  it('refuses a reseau fit without a spacing', () => {
    expect(fitFiducialTransform(crosses(), 'reseau')).toBeNull()
  })
})
