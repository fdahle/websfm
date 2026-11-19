import { describe, expect, it } from 'vitest'
import {
  accuracySnapshot,
  compareAccuracy,
  withSnapshot,
  accuracyLogText,
  ACCURACY_HISTORY_MAX,
} from './accuracySnapshot.js'

const ctl = (id, d, loo = null) => ({
  gcpId: id,
  name: id,
  role: 'control',
  dx: d,
  dy: 0,
  dz: d,
  dTotal: Math.hypot(d, d),
  ...(loo != null ? { looDx: loo, looDy: 0, looDz: loo, looTotal: Math.hypot(loo, loo) } : {}),
  observations: [{ reprojPx: 0.5 }],
})
const chk = (id, dx, dz) => ({ gcpId: id, name: id, role: 'check', dx, dy: 0, dz, dTotal: Math.hypot(dx, dz) })

describe('accuracySnapshot', () => {
  it('measures checkpoints apart, and never counts a control point’s own residual', () => {
    const s = accuracySnapshot({ report: [ctl('A', 0.01), ctl('B', 0.01), ctl('C', 0.01), chk('K', 0.03, 0.04)] })
    expect(s.checkpoints).toEqual({ n: 1, h: 0.03, v: 0.04, ids: ['K'] })
    // Three controls: no leave-one-out, so nothing about them is a check.
    expect(s.loo).toBeNull()
    expect(s.independent).toBe(true)
    expect(s.controls.map((c) => c.id)).toEqual(['A', 'B', 'C'])
    expect(s.marksPx).toBeCloseTo(0.5, 9)
  })

  it('takes leave-one-out from four control points, and the cameras only when fitted to the GCPs', () => {
    const report = ['A', 'B', 'C', 'D'].map((id) => ctl(id, 0.001, 0.02))
    const poseResiduals = [
      { uuid: 'u1', dx: 3, dy: 4, dz: 1 },
      { uuid: 'u2', dx: 0, dy: 0, dz: 1 },
    ]
    const byGcps = accuracySnapshot({ report, poseResiduals, method: 'gcps' })
    expect(byGcps.loo.n).toBe(4)
    expect(byGcps.loo.h).toBeCloseTo(0.02, 12)
    expect(byGcps.cameras).toMatchObject({ n: 2, v: 1 })
    expect(byGcps.cameras.h).toBeCloseTo(Math.sqrt(12.5), 12)
    // Fitted to the camera positions, their residual is the fit itself.
    expect(accuracySnapshot({ report, poseResiduals, method: 'poses' }).cameras).toBeNull()
  })

  it('says when nothing is an independent check', () => {
    const s = accuracySnapshot({ report: [ctl('A', 0.01), ctl('B', 0.01), ctl('C', 0.01)], method: 'gcps' })
    expect(s.independent).toBe(false)
    expect(accuracyLogText(s, null)).toMatch(/^no independent check/)
  })
})

describe('compareAccuracy', () => {
  const at = (checks, extra = {}) =>
    accuracySnapshot({ report: [ctl('A', 0.01), ctl('B', 0.01), ctl('C', 0.01), ...checks], ...extra })

  it('calls a lower error on the same checkpoints better, a higher one worse, a tiny one the same', () => {
    const before = at([chk('K', 0.05, 0.06)])
    const after = at([chk('K', 0.03, 0.061)])
    const { rows } = compareAccuracy(after, before)
    expect(rows.find((r) => r.key === 'checkpoints' && r.axis === 'h')).toMatchObject({ verdict: 'better' })
    expect(rows.find((r) => r.key === 'checkpoints' && r.axis === 'v')).toMatchObject({ verdict: 'same' })
    expect(compareAccuracy(before, after).rows[0].verdict).toBe('worse')
  })

  it('does not compare errors measured on other points, and says which points came or went', () => {
    const before = at([chk('K', 0.05, 0.06)])
    const after = accuracySnapshot({
      report: [ctl('A', 0.01), ctl('B', 0.01), ctl('C', 0.01), ctl('K', 0.001), chk('L', 0.01, 0.01)],
    })
    const c = compareAccuracy(after, before)
    expect(c.rows.every((r) => r.verdict === 'changed')).toBe(true)
    expect(c).toMatchObject({ controlsAdded: ['K'], checksAdded: ['L'], checksRemoved: ['K'], controlsRemoved: [] })
    expect(accuracyLogText(after, before)).toMatch(/measured on other points than before/)
  })

  it('marks a check that is new or gone', () => {
    const none = at([])
    const some = at([chk('K', 0.05, 0.06)])
    expect(compareAccuracy(some, none).rows.map((r) => r.verdict)).toEqual(['new', 'new'])
    expect(compareAccuracy(none, some).rows.map((r) => r.verdict)).toEqual(['gone', 'gone'])
  })
})

describe('withSnapshot', () => {
  it('adds nothing for a refit that changed nothing, and keeps the last ones', () => {
    const s = accuracySnapshot({ report: [chk('K', 0.05, 0.06)], at: '1' })
    const h = withSnapshot([], s)
    expect(withSnapshot(h, { ...s, at: '2' })).toBe(h)
    let long = []
    for (let i = 0; i < ACCURACY_HISTORY_MAX + 5; i++)
      long = withSnapshot(long, accuracySnapshot({ report: [chk('K', 0.01 * (i + 1), 0)], at: String(i) }))
    expect(long).toHaveLength(ACCURACY_HISTORY_MAX)
    expect(long.at(-1).at).toBe(String(ACCURACY_HISTORY_MAX + 4))
  })

  it('writes the log line with the value before', () => {
    const before = accuracySnapshot({ report: [chk('K', 0.052, 0.061)] })
    const after = accuracySnapshot({ report: [chk('K', 0.038, 0.047)] })
    expect(accuracyLogText(after, before)).toBe('checkpoints (1) H 0.038 / V 0.047 m, was 0.052 / 0.061 m')
  })
})
