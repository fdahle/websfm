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
  it('says how large the cloth is over this cloud', () => {
    const small = classifyGroundEffects(GROUND_DEFAULTS, { extent: [400, 300] })
    expect(small.cloth).toMatch(/Over the cloud's 400 m × 300 m: about 120,701 cloth cells\.$/)
    // In memory: one cloth, coarsened past the cap.
    const big = classifyGroundEffects(GROUND_DEFAULTS, { extent: [10_000, 8_000] })
    expect(big.cloth).toMatch(
      /would need 80,018,001 cells, more than one cloth holds \(4,000,000\): it is coarsened to 4\.\d+ m\.$/,
    )
    // Streamed: in tiles, each coarsening its own past the cap.
    const tiled = classifyGroundEffects(GROUND_DEFAULTS, { extent: [10_000, 8_000], streamed: true })
    expect(tiled.cloth).toMatch(
      /about 80,018,001 cloth cells, in tiles; a tile that needs more than 4,000,000 uses a coarser cloth\.$/,
    )
  })
  it('says why without a metric scale', () => {
    expect(classifyGroundEffects(GROUND_DEFAULTS, { noScale: true }).cloth).toMatch(/^Needs real-world scale/)
  })
})
