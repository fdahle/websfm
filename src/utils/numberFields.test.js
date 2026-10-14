import { describe, it, expect } from 'vitest'
import { numberFieldError, checkNumberFields } from './numberFields.js'

describe('numberFieldError', () => {
  // What v-model.number hands back for a cleared <input type="number">.
  it('rejects a cleared field unless it is optional', () => {
    expect(numberFieldError('', { min: 1 })).toBe('enter a value')
    expect(numberFieldError(null, { min: 1 })).toBe('enter a value')
    expect(numberFieldError(undefined, {})).toBe('enter a value')
    expect(numberFieldError('', { min: 1, optional: true })).toBe('')
    expect(numberFieldError(null, { optional: true })).toBe('')
  })

  it('rejects non-numbers and non-finite numbers', () => {
    expect(numberFieldError('1e', {})).toBe('enter a number')
    expect(numberFieldError(NaN, {})).toBe('enter a number')
    expect(numberFieldError(Infinity, {})).toBe('enter a number')
    // An optional field may be blank, but not garbage.
    expect(numberFieldError('abc', { optional: true })).toBe('enter a number')
  })

  it('enforces inclusive bounds', () => {
    const r = { min: 0.1, max: 10 }
    expect(numberFieldError(0.1, r)).toBe('')
    expect(numberFieldError(10, r)).toBe('')
    expect(numberFieldError(0.05, r)).toBe('must be between 0.1 and 10')
    expect(numberFieldError(10.5, r)).toBe('must be between 0.1 and 10')
    expect(numberFieldError(-1, { min: 0 })).toBe('must be at least 0')
    expect(numberFieldError(91, { max: 90 })).toBe('must be at most 90')
    expect(numberFieldError(-1e9, {})).toBe('')
  })

  it('enforces whole numbers, and formats large bounds readably', () => {
    expect(numberFieldError(2.5, { integer: true, min: 1 })).toBe('must be a whole number')
    expect(numberFieldError(3, { integer: true, min: 1 })).toBe('')
    expect(numberFieldError(50, { min: 100, max: 50000 })).toBe('must be between 100 and 50,000')
  })
})

describe('checkNumberFields', () => {
  const rules = {
    minViews: { label: 'Min consistent views', min: 1, max: 8, integer: true },
    depthTolPct: { label: 'Depth agreement tolerance', min: 0.1, max: 10 },
    maxDim: { label: 'Working resolution override', min: 200, integer: true, optional: true },
  }

  it('passes valid settings', () => {
    const r = checkNumberFields({ minViews: 2, depthTolPct: 1, maxDim: null }, rules)
    expect(r.valid).toBe(true)
    expect(r.invalid).toEqual([])
    expect(r.reason).toBe('')
    expect(r.bad).toEqual({ minViews: false, depthTolPct: false, maxDim: false })
  })

  it('names every invalid field in the reason, in rule order', () => {
    const r = checkNumberFields({ minViews: '', depthTolPct: 20, maxDim: 2000 }, rules)
    expect(r.valid).toBe(false)
    expect(r.invalid.map((f) => f.key)).toEqual(['minViews', 'depthTolPct'])
    expect(r.bad).toEqual({ minViews: true, depthTolPct: true, maxDim: false })
    expect(r.reason).toBe('Min consistent views: enter a value; Depth agreement tolerance: must be between 0.1 and 10')
  })

  // A hidden field (e.g. min views while Auto is on) is not sent, so it cannot block the run.
  it('skips fields whose `when` is false', () => {
    const r = checkNumberFields({ minViews: '', depthTolPct: 1 }, {
      ...rules, minViews: { ...rules.minViews, when: false },
    })
    expect(r.valid).toBe(true)
    expect('minViews' in r.bad).toBe(false)
  })

  it('falls back to the key when a rule has no label', () => {
    expect(checkNumberFields({ x: '' }, { x: {} }).reason).toBe('x: enter a value')
  })
})
