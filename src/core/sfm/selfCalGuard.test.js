import { describe, expect, it } from 'vitest'
import { validateSelfCalUpdate } from './selfCalGuard.js'

const base = { fx: 2400, fy: 2400, cx: 1500, cy: 1100 }
const input = (proposed) => ({ before: base, proposed: { ...base, ...proposed }, nominalFx: 2400, width: 3000, height: 2200 })

describe('validateSelfCalUpdate', () => {
  it('accepts the healthy South Building-scale correction', () => {
    expect(validateSelfCalUpdate(input({ fx: 2566, fy: 2566, k1: -0.06, k2: 0.15, k3: -0.18 })).ok).toBe(true)
  })

  it('rejects a single-pass focal runaway', () => {
    const v = validateSelfCalUpdate(input({ fx: 3905, fy: 3905, k1: -0.53 }))
    expect(v).toMatchObject({ ok: false, code: 'focal-step' })
  })

  it('rejects cumulative drift even when the latest step is modest', () => {
    const v = validateSelfCalUpdate({ ...input({ fx: 3533, fy: 3533 }), before: { ...base, fx: 2842, fy: 2842 } })
    expect(v).toMatchObject({ ok: false, code: 'focal-nominal' })
  })

  it('rejects a folded radial curve and a runaway principal point', () => {
    expect(validateSelfCalUpdate(input({ k1: -10 })).code).toBe('radial-fold')
    expect(validateSelfCalUpdate(input({ cx: 2200 })).code).toBe('principal-point')
  })
})
