import { describe, expect, it } from 'vitest'
import { bootstrapFiducialsFromGray, estimateFilmBounds, makeFiducialPrototype, normalizedFiducialLayout, rotateUnitPoint } from './fiducialBootstrap.js'

const MARKS = [
  { id: 'TL', xMm: -100, yMm: -80 }, { id: 'TR', xMm: 100, yMm: -80 },
  { id: 'BR', xMm: 100, yMm: 80 }, { id: 'BL', xMm: -100, yMm: 80 },
]

function raster(family = 'generic', variant = 1) {
  const width = 241, height = 201
  const data = new Float32Array(width * height).fill(230)
  const layout = normalizedFiducialLayout(MARKS)
  const insetX = width * 0.025, insetY = height * 0.025
  for (const m of layout) {
    const p = makeFiducialPrototype(family, 13, variant)
    const cx = Math.round(insetX + m.nx * (width - 1 - 2 * insetX))
    const cy = Math.round(insetY + m.ny * (height - 1 - 2 * insetY))
    const h = (p.size - 1) >> 1
    for (let y = 0; y < p.size; y++) for (let x = 0; x < p.size; x++) {
      data[(cy - h + y) * width + cx - h + x] = p.data[y * p.size + x] ? 230 : 20
    }
  }
  return { data, width, height, scale: 1, natW: width, natH: height }
}

describe('fiducial bootstrap', () => {
  it('uses explicit clockwise unit-square rotations', () => {
    expect(rotateUnitPoint(0.2, 0.3, 1)).toEqual({ x: 0.7, y: 0.2 })
    expect(rotateUnitPoint(0.2, 0.3, 2)).toEqual({ x: 0.8, y: 0.7 })
  })

  it('finds and identifies four generic cross marks without a scanned template', () => {
    const out = bootstrapFiducialsFromGray(raster(), MARKS, { family: 'generic', searchRadiusFrac: 0.04, minPeakMargin: 0 })
    expect(out.status).toBe('ok')
    expect(out.strong).toHaveLength(4)
    for (const d of out.strong) {
      const truth = normalizedFiducialLayout(MARKS).find((m) => m.id === d.fidId)
      const x = 241 * 0.025 + truth.nx * (240 - 2 * 241 * 0.025)
      const y = 201 * 0.025 + truth.ny * (200 - 2 * 201 * 0.025)
      expect(Math.hypot(d.px - x, d.py - y)).toBeLessThan(1.2)
    }
  })

  it('supports right-angle prototypes and contrast inversion', () => {
    const img = raster('right-angle', 0)
    for (let i = 0; i < img.data.length; i++) img.data[i] = 255 - img.data[i]
    const out = bootstrapFiducialsFromGray(img, MARKS, { family: 'right-angle', searchRadiusFrac: 0.04, minPeakMargin: 0 })
    expect(out.status).toBe('ok')
  })

  it('fails safely when the calibrated layout is degenerate', () => {
    const out = bootstrapFiducialsFromGray(raster(), MARKS.map((m) => ({ ...m, yMm: 0 })))
    expect(out.status).toBe('failed')
    expect(out.detections).toEqual([])
  })

  it('measures a strong film rectangle and refuses frame marks without one', () => {
    const width = 100, height = 80, data = new Float32Array(width * height).fill(10)
    for (let y = 7; y <= 71; y++) for (let x = 9; x <= 90; x++) data[y * width + x] = 200
    const bounds = estimateFilmBounds({ data, width, height })
    expect(bounds.left).toBe(9); expect(bounds.right).toBe(90)
    expect(bounds.top).toBe(7); expect(bounds.bottom).toBe(71)
    expect(bootstrapFiducialsFromGray({ data, width, height }, MARKS, { family: 'frame' }).status).toBe('ok')
    const flat = { data: new Float32Array(width * height).fill(100), width, height }
    expect(bootstrapFiducialsFromGray(flat, MARKS, { family: 'frame' }).status).toBe('failed')
  })
})
