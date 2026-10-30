import { describe, it, expect } from 'vitest'

import { reduceOverlapEffects } from './reduceOverlap.js'

const s = { maxAngle: 60, coverage: 3 }

describe('reduceOverlapEffects', () => {
  it('says what is kept and disabled', () => {
    const e = reduceOverlapEffects(s, { enabled: 347, disabled: 2, points: 20000, kept: 120 })
    expect(e.visibility).toContain('20,000 sparse points')
    expect(e.visibility).toContain('60°')
    expect(e.coverage).toContain('Keeps 120 of the 347 enabled photos')
    expect(e.coverage).toContain('227 photos are disabled')
    expect(e.coverage).toContain('2 photos already disabled stay so')
  })

  it('says when nothing goes, while it counts, and without a model', () => {
    expect(reduceOverlapEffects(s, { enabled: 10, points: 50, kept: 10 }).coverage).toContain('none is disabled')
    expect(reduceOverlapEffects(s, { enabled: 10, points: 50 }).coverage).toBe('Counting…')
    expect(reduceOverlapEffects(s, {}).coverage).toContain('Build the sparse model first')
  })
})
