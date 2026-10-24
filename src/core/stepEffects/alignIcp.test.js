import { describe, it, expect } from 'vitest'
import { alignIcpEffects } from './alignIcp.js'
import { ICP_DEFAULTS } from '../defaults.user.js'

describe('alignIcpEffects', () => {
  it('words the pairing radius and the solver', () => {
    const e = alignIcpEffects(ICP_DEFAULTS, { sourceName: 'A', autoRadius: 0.42, unit: 'model units', planar: true })
    expect(e.pair).toMatch(/^50,000 points of "A" .* within 0\.42 model units \(auto\)/)
    expect(e.solve).toMatch(/^Rotation, translation are solved point-to-plane, up to 100 iterations/)
    const s = { ...ICP_DEFAULTS, maxDistance: 2, estimateScale: true }
    expect(alignIcpEffects(s, { unit: 'm' }).pair).toMatch(/within 2 m;/)
    expect(alignIcpEffects(s).solve).toMatch(/and scale are solved point-to-point/)
  })
})
