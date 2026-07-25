import { describe, it, expect } from 'vitest'
import {
  SFM_PHASES, phaseOffsets, makeProgressReporter, scopeProgress, sliceRange, RUN_BUDGET,
} from './progressPlan.js'

const collect = () => {
  const calls = []
  const fn = (done, total, label, fraction) => calls.push({ done, total, label, fraction })
  return { calls, fn }
}

describe('phaseOffsets', () => {
  it('lays the phases end to end over 0..1', () => {
    const offs = phaseOffsets()
    const first = offs.get(SFM_PHASES[0].key)
    const last = offs.get(SFM_PHASES[SFM_PHASES.length - 1].key)
    expect(first.start).toBeCloseTo(0, 10)
    expect(last.start + last.span).toBeCloseTo(1, 10)
  })

  it('normalises weights that do not sum to 1', () => {
    const offs = phaseOffsets([{ key: 'a', weight: 3 }, { key: 'b', weight: 1 }])
    expect(offs.get('a').span).toBeCloseTo(0.75, 10)
    expect(offs.get('b').start).toBeCloseTo(0.75, 10)
  })
})

describe('makeProgressReporter', () => {
  it('never emits a fraction outside its range', () => {
    const { calls, fn } = collect()
    const report = makeProgressReporter(fn, { start: 0.2, end: 0.6 })
    for (const p of SFM_PHASES) {
      report(p.key, -5, 'x')
      report(p.key, 5, 'x')
    }
    for (const c of calls) {
      expect(c.fraction).toBeGreaterThanOrEqual(0.2)
      expect(c.fraction).toBeLessThanOrEqual(0.6)
    }
  })

  // The bug this module exists to prevent: the old camera-count bar hit 100% at the
  // end of registration, with BA / retriangulation / track filtering still to run.
  it('leaves headroom after registration completes', () => {
    const { calls, fn } = collect()
    const report = makeProgressReporter(fn)
    report('register', 1, 'all registered')
    expect(calls[0].fraction).toBeLessThan(0.6)
  })

  it('advances monotonically through the phases in order', () => {
    const { calls, fn } = collect()
    const report = makeProgressReporter(fn)
    for (const p of SFM_PHASES) { report(p.key, 0, 'x'); report(p.key, 1, 'x') }
    const fracs = calls.map((c) => c.fraction)
    for (let i = 1; i < fracs.length; i++) expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1])
    expect(fracs[fracs.length - 1]).toBeCloseTo(1, 10)
  })

  it('passes counts through as the numeric readout and falls back to the phase label', () => {
    const { calls, fn } = collect()
    const report = makeProgressReporter(fn)
    report('register', 0.5, undefined, { done: 7, total: 20 })
    expect(calls[0]).toMatchObject({ done: 7, total: 20, label: 'Registering images' })
  })

  it('ignores an unknown phase rather than emitting a wrong fraction', () => {
    const { calls, fn } = collect()
    makeProgressReporter(fn)('nope', 1, 'x')
    expect(calls).toHaveLength(0)
  })

  it('is a no-op without a sink', () => {
    expect(() => makeProgressReporter(undefined)('register', 1, 'x')).not.toThrow()
  })
})

describe('scopeProgress', () => {
  it('remaps a child run 0..1 into its slice', () => {
    const { calls, fn } = collect()
    const scoped = scopeProgress(fn, { start: 0.75, end: 0.85 })
    scoped(0, 10, 'a', 0)
    scoped(5, 10, 'b', 0.5)
    scoped(10, 10, 'c', 1)
    expect(calls.map((c) => c.fraction)).toEqual([0.75, 0.8, 0.85])
  })

  // Two sub-runs each reporting an honest local 0..1 must not rewind the overall bar
  // — this is the "sparse finishes several times" regression.
  it('keeps consecutive sub-runs non-overlapping and ordered', () => {
    const { calls, fn } = collect()
    const a = sliceRange(RUN_BUDGET.recovery, 2, 0)
    const b = sliceRange(RUN_BUDGET.recovery, 2, 1)
    scopeProgress(fn, { start: a[0], end: a[1] })(0, 1, 'x', 1)
    scopeProgress(fn, { start: b[0], end: b[1] })(0, 1, 'x', 0)
    expect(calls[1].fraction).toBeGreaterThanOrEqual(calls[0].fraction)
  })

  it('decorates the label', () => {
    const { calls, fn } = collect()
    scopeProgress(fn, { start: 0, end: 1, decorate: (l) => `Secondary 1: ${l}` })(0, 1, 'Bundle', 0.5)
    expect(calls[0].label).toBe('Secondary 1: Bundle')
  })

  it('forwards no fraction when the child reports none', () => {
    const { calls, fn } = collect()
    scopeProgress(fn, { start: 0.2, end: 0.4 })(1, 2, 'x', undefined)
    expect(calls[0].fraction).toBeUndefined()
  })
})

describe('sliceRange', () => {
  it('splits into consecutive equal slices covering the range', () => {
    expect(sliceRange([0, 1], 4, 0)).toEqual([0, 0.25])
    expect(sliceRange([0, 1], 4, 3)).toEqual([0.75, 1])
  })

  it('returns the whole range for a zero count', () => {
    expect(sliceRange([0.2, 0.8], 0, 0)).toEqual([0.2, 0.8])
  })
})
