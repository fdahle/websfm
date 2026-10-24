import { describe, it, expect } from 'vitest'
import { normalsEffects } from './normals.js'
import { NORMALS_DEFAULTS } from '../defaults.user.js'

describe('normalsEffects', () => {
  it('words the fit and the resolved orientation', () => {
    const e = normalsEffects(NORMALS_DEFAULTS, { count: 2000, orient: 'cameras' })
    expect(e.fit).toMatch(/^Each of the 2,000 points .* its 16 nearest neighbours/)
    expect(e.orient).toMatch(/^Automatic: Each normal is turned to face the nearest camera/)
    expect(normalsEffects({ ...NORMALS_DEFAULTS, orient: 'up' }, { orient: 'up' }).orient).toMatch(
      /^Each normal .* upward/,
    )
  })
})
