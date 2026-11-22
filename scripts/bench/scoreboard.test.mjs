import { describe, it, expect } from 'vitest'
import { medianScore } from './scoreboard.mjs'

describe('medianScore (--repeat)', () => {
  it('takes the median of every number, keeping the shape', () => {
    const run = (h, v, cams) => ({ cameras: [cams, 347], checkpoints: { h, v, meanU: null, n: 3 }, dem: null })
    expect(medianScore([run(0.05, 0.2, 346), run(0.04, 0.3, 347), run(0.06, 0.1, 347)])).toEqual({
      cameras: [347, 347],
      checkpoints: { h: 0.05, v: 0.2, meanU: null, n: 3 },
      dem: null,
    })
    // An even count: the mean of the middle two.
    expect(medianScore([run(0.04, 0.2, 346), run(0.06, 0.4, 347)]).checkpoints.v).toBeCloseTo(0.3, 12)
  })

  it('is the run itself for one run, and null for none', () => {
    const one = { cameras: [1, 2] }
    expect(medianScore([one])).toBe(one)
    expect(medianScore([])).toBeNull()
  })
})
