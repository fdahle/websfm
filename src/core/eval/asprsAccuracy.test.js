import { describe, expect, it } from 'vitest'
import {
  asprsAccuracy,
  asprsLength,
  asprsStatement,
  axisStats,
  asprsReportSection,
  asprsDemSection,
  checkpointResiduals,
  demCheckpointResiduals,
  ASPRS_MIN_CHECKPOINTS,
} from './asprsAccuracy.js'
import { buildReportHtml } from '../products/report.js'

// n checkpoints whose residuals alternate in sign: mean 0, RMSE = the amplitude.
const alternating = (n, { dx = 0.03, dy = 0.04, dz = 0.01, sx = 0.019, sy = 0.019, sz = 0.02 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const s = i % 2 ? -1 : 1
    return { name: `C${i + 1}`, dx: s * dx, dy: s * dy, dz: s * dz, sx, sy, sz }
  })
const cm = (v) => `${(v * 100).toFixed(1)} cm`

describe('axisStats', () => {
  it('gives the mean, the sample standard deviation and the RMSE', () => {
    const s = axisStats([1, 2, 3, 4])
    expect(s.mean).toBe(2.5)
    expect(s.sd).toBeCloseTo(Math.sqrt(5 / 3), 12) // Σ(x − 2.5)² = 5, over n − 1
    expect(s.rmse).toBeCloseTo(Math.sqrt(30 / 4), 12)
    expect(axisStats([null, NaN]).rmse).toBeNull()
  })
})

describe('asprsAccuracy', () => {
  it('adds the checkpoint survey error to the fit (Edition 2: RMSE₁ 1 cm, RMSE₂ 2 cm → 2.24 cm)', () => {
    const a = asprsAccuracy(alternating(30))
    expect(a.v.fit).toBeCloseTo(0.01, 12)
    expect(a.v.survey).toBeCloseTo(0.02, 12)
    expect(a.v.product).toBeCloseTo(Math.sqrt(0.0005), 12) // 2.236 cm
    // Horizontal: RMSE_H₁ = √(3² + 4²) cm; RMSE_H₂ from σx = σy = 1.9 cm.
    expect(a.h.fit).toBeCloseTo(0.05, 12)
    expect(a.h.survey).toBeCloseTo(0.019 * Math.SQRT2, 12)
    expect(a.h.product).toBeCloseTo(Math.hypot(0.05, 0.019 * Math.SQRT2), 12)
    expect(a.d3.product).toBeCloseTo(Math.hypot(a.h.product, a.v.product), 12)
    expect(a.meanErrorFlags).toEqual([])
    expect(a.blunders).toEqual([])
  })

  it('leaves the survey term out when a checkpoint declares no accuracy, and says so', () => {
    const checks = alternating(30)
    checks[3].sz = null
    const a = asprsAccuracy(checks)
    expect(a.v.survey).toBeNull()
    expect(a.v.product).toBeCloseTo(a.v.fit, 12)
    expect(a.surveyDeclared).toEqual({ h: true, v: false })
  })

  it('keeps 2-D checkpoints out of the vertical figures', () => {
    const checks = alternating(4)
    checks[0].dz = null
    const a = asprsAccuracy(checks)
    expect(a.nH).toBe(4)
    expect(a.nV).toBe(3)
  })

  it('flags a mean error over a quarter of the RMSE and a residual over three times it', () => {
    // A 2 cm shift east on 1 cm of noise: mean 2, RMSE √5 cm.
    const shifted = alternating(30).map((c) => ({ ...c, dx: c.dx / 3 + 0.02 }))
    expect(asprsAccuracy(shifted).meanErrorFlags).toEqual(['x'])
    const withBlunder = [...alternating(30), { name: 'B', dx: 0, dy: 0, dz: 0.5, sx: 0.019, sy: 0.019, sz: 0.02 }]
    expect(asprsAccuracy(withBlunder).blunders).toEqual([{ name: 'B', axis: 'z', value: 0.5 }])
  })
})

describe('asprsStatement', () => {
  it('states compliance only with enough checkpoints and their survey accuracy', () => {
    const ok = asprsStatement(asprsAccuracy(alternating(ASPRS_MIN_CHECKPOINTS)), cm)
    expect(ok[0]).toMatch(/^This data set was tested to meet .* Edition 2 \(2023\) for a 5\.7 cm RMSE_H horizontal/)
    expect(ok[1]).toMatch(/for a 2\.2 cm RMSE_V vertical positional accuracy class\.$/)

    const few = asprsStatement(asprsAccuracy(alternating(12)), cm)
    expect(few[0]).toMatch(/12 checkpoints, fewer than the 30/)
    expect(few[0]).toMatch(/not a compliant ASPRS statement/)

    const undeclared = alternating(30).map((c) => ({ ...c, sz: null }))
    expect(asprsStatement(asprsAccuracy(undeclared), cm)[1]).toMatch(/declare no survey accuracy/)
    expect(asprsStatement(asprsAccuracy([]), cm)).toEqual([])
  })
})

describe('checkpointResiduals', () => {
  it('takes the enabled checkpoints with a residual, and their declared accuracy', () => {
    const gcps = [
      { id: 'a', name: 'A', role: 'check', accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.05 },
      { id: 'b', name: 'B', role: 'control', accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.05 },
      { id: 'c', name: 'C', role: 'check', enabled: false },
      { id: 'd', name: 'D', role: 'check' },
    ]
    const rows = [
      { gcpId: 'a', name: 'A', role: 'check', dx: 0.01, dy: -0.02, dz: 0.03 },
      { gcpId: 'b', name: 'B', role: 'control', dx: 0.01, dy: 0.01, dz: 0.01 },
      { gcpId: 'c', name: 'C', role: 'check', dx: 0.5, dy: 0.5, dz: 0.5 },
      { gcpId: 'd', name: 'D', role: 'check', dx: null, dy: null, dz: null },
    ]
    expect(checkpointResiduals(rows, gcps)).toEqual([
      { name: 'A', dx: 0.01, dy: -0.02, dz: 0.03, sx: 0.02, sy: 0.02, sz: 0.05 },
    ])
  })
})

describe('asprsLength', () => {
  it('states metres in centimetres and feet in feet', () => {
    expect(asprsLength(0.05676, 'm')).toBe('5.7 cm')
    expect(asprsLength(0.1875, 'US-ft')).toBe('0.188 US-ft')
    expect(asprsLength(null, 'm')).toBe('—')
  })
})

describe('asprsReportSection', () => {
  it('renders in the exported report with the class, the table and the statement', () => {
    const section = asprsReportSection(alternating(30), 'm')
    const html = buildReportHtml({ projectName: 'P', date: '2026-11-13T00:00:00Z', crsUnit: 'm', sections: [section] })
    expect(html).toContain('Accuracy at the checkpoints (ASPRS 2023)')
    expect(html).toContain('5.7 cm') // RMSE_H with the survey error
    expect(html).toContain('2.2 cm') // RMSE_V
    expect(html).toContain('RMSE₂ (survey)')
    expect(html).toContain('tested to meet the ASPRS Positional Accuracy Standards')
    expect(section.rows.map((r) => r.component)).toEqual(['X (east)', 'Y (north)', 'Horizontal', 'Vertical', '3D'])
  })

  it('is left out without checkpoints or in a CRS without a length unit', () => {
    expect(asprsReportSection([], 'm')).toBeNull()
    expect(asprsReportSection(alternating(30), 'CRS units')).toBeNull()
  })

  it('names the blunders and the shifted axes in its note', () => {
    const checks = [...alternating(30), { name: 'B9', dx: 0, dy: 0, dz: 0.5, sx: 0.019, sy: 0.019, sz: 0.02 }]
    expect(asprsReportSection(checks, 'm').note).toMatch(/B9 Z 50\.0 cm/)
  })
})

// The DEM at the checkpoints (NVA): rows as core/eval/demCheck.js sampleDemAtGcps gives them.
describe('asprsDemSection', () => {
  // n checkpoints (σz 2 cm) whose DEM heights alternate ±3 cm about the survey: RMSE₁ 3 cm,
  // product √(3² + 2²) = 3.61 cm; plus a control and a disabled checkpoint, both left out.
  const setup = (n, dz = 0.03) => {
    const gcps = Array.from({ length: n }, (_, i) => ({
      id: `g${i}`,
      name: `C${i + 1}`,
      role: 'check',
      accuracyZ: 0.02,
    }))
    gcps.push({ id: 'ctl', name: 'K1', role: 'control', accuracyZ: 0.02 })
    gcps.push({ id: 'off', name: 'X1', role: 'check', enabled: false, accuracyZ: 0.02 })
    const rows = gcps.map((g, i) => ({ gcpId: g.id, name: g.name, dz: i % 2 ? -dz : dz }))
    return { gcps, rows }
  }

  it('takes the enabled checkpoints the DEM covers and counts the ones it does not', () => {
    const { gcps, rows } = setup(4)
    rows[1].dz = null // on a gap
    const { checks, off } = demCheckpointResiduals(rows, gcps)
    expect(checks.map((c) => c.name)).toEqual(['C1', 'C3', 'C4'])
    expect(off).toBe(1)
    expect(checks[0]).toMatchObject({ dz: 0.03, sz: 0.02 })
  })

  it('states the NVA class with 30 checkpoints and their survey accuracy', () => {
    const { gcps, rows } = setup(30)
    const sec = asprsDemSection(rows, gcps, 'm')
    expect(sec.tiles[0]).toMatchObject({ label: 'RMSE_V (NVA)', value: cm(Math.hypot(0.03, 0.02)) })
    expect(sec.rows).toHaveLength(1)
    expect(sec.rows[0]).toMatchObject({ n: 30, fit: cm(0.03), survey: cm(0.02), rmse: cm(Math.hypot(0.03, 0.02)) })
    expect(sec.note).toMatch(/tested to meet the ASPRS .* for a 3\.6 cm RMSE_V \(NVA\) vertical/)
  })

  it('reports fewer than 30 checkpoints as measured, not compliant', () => {
    const { gcps, rows } = setup(12)
    const sec = asprsDemSection(rows, gcps, 'm')
    expect(sec.note).toMatch(/12 checkpoints, fewer than the 30/)
    expect(sec.note).not.toMatch(/tested to meet/)
    expect(sec.tiles[2]).toMatchObject({ value: '12', tone: 'warn' })
  })

  it('flags a DEM shifted against the checkpoints', () => {
    const { gcps, rows } = setup(30)
    for (const r of rows) r.dz = r.dz + 0.05 // the DEM 5 cm high everywhere
    const sec = asprsDemSection(rows, gcps, 'm')
    expect(sec.tiles[1]).toMatchObject({ label: 'Mean error', value: cm(0.05), tone: 'warn' })
    expect(sec.note).toMatch(/vertical shift/)
  })

  it('is left out with no checkpoint on the DEM or without a length unit', () => {
    const { gcps, rows } = setup(5)
    expect(
      asprsDemSection(
        rows.map((r) => ({ ...r, dz: null })),
        gcps,
        'm',
      ),
    ).toBeNull()
    expect(asprsDemSection(rows, gcps, 'degree')).toBeNull()
  })
})
