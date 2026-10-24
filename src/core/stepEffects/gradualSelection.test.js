import { describe, it, expect } from 'vitest'
import { gradualSelectionEffects } from './gradualSelection.js'

describe('gradualSelectionEffects', () => {
  it('words the selection while statistics load and after', () => {
    expect(gradualSelectionEffects({ metric: 'error', threshold: 3 }).select).toMatch(/^Computing/)
    const e = gradualSelectionEffects({ metric: 'track', threshold: 3 }, { selected: 100, total: 1000 })
    expect(e.select).toBe('100 points seen in fewer than 3 views are selected; 900 remain.')
    expect(gradualSelectionEffects({ metric: 'angle', threshold: 2 }, { selected: 998, total: 1000 }).refine).toMatch(
      /^Too few points/,
    )
  })
})
