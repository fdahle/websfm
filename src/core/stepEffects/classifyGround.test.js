import { describe, it, expect } from 'vitest'
import { classifyGroundEffects } from './classifyGround.js'
import { GROUND_DEFAULTS } from '../defaults.user.js'

describe('classifyGroundEffects', () => {
  it('words the cloth and the labels', () => {
    const e = classifyGroundEffects(GROUND_DEFAULTS)
    expect(e.cloth).toMatch(/^A cloth of 1 m cells, medium for rolling relief, .*slope smoothing/)
    expect(e.label).toMatch(/^Points within 0\.5 m of the cloth are ground.*dense core/)
    expect(classifyGroundEffects({ ...GROUND_DEFAULTS, extent: 'all' }).label).toMatch(/whole cloud/)
  })
  it('says why without a metric scale', () => {
    expect(classifyGroundEffects(GROUND_DEFAULTS, { noScale: true }).cloth).toMatch(/^Needs real-world scale/)
  })
})
