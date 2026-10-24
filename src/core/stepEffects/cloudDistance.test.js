import { describe, it, expect } from 'vitest'
import { cloudDistanceEffects } from './cloudDistance.js'
import { DISTANCE_DEFAULTS } from '../defaults.user.js'

describe('cloudDistanceEffects', () => {
  it('words the reference, the limit and the sign', () => {
    const e = cloudDistanceEffects(DISTANCE_DEFAULTS, { count: 10, mesh: true, signable: true })
    expect(e.nearest).toBe('Each of the 10 points gets its distance to the nearest triangle of the mesh.')
    expect(e.sign).toMatch(/^Positive above/)
    const far = cloudDistanceEffects({ ...DISTANCE_DEFAULTS, maxDistance: 2 }, { unit: 'm' })
    expect(far.nearest).toMatch(/nearest reference point; farther than 2 m it gets none/)
    expect(far.sign).toMatch(/^Unsigned/)
  })
})
