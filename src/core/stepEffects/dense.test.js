import { describe, it, expect } from 'vitest'
import { denseEffects } from './dense.js'
import { DENSE_FUSE_DEFAULTS } from '../defaults.user.js'

describe('denseEffects', () => {
  it("states Auto's thresholds as fusion picks them", () => {
    const e = denseEffects(DENSE_FUSE_DEFAULTS, { maps: 42 })
    expect(e.sample).toMatch(/^Every pixel of the 42 depth maps/)
    expect(e.agree).toMatch(/at least 2 other depth maps .* cost of 0\.8 or less \(Auto\)/)
    expect(denseEffects(DENSE_FUSE_DEFAULTS, { maps: 2 }).agree).toMatch(/at least 1 other depth map put/)
    expect(denseEffects({ ...DENSE_FUSE_DEFAULTS, step: 2 }, { maps: 42 }).sample).toMatch(/about 1 in 4/)
  })

  it('says what is off', () => {
    const off = denseEffects(
      { ...DENSE_FUSE_DEFAULTS, minTriAngleDeg: 0, maxIncidenceDeg: 90, removeIsolated: false },
      { maps: 42 },
    )
    expect(off.gates).toMatch(/^Off/)
    expect(off.isolated).toMatch(/^Off/)
    expect(denseEffects(DENSE_FUSE_DEFAULTS).sample).toMatch(/^Compute depth maps first/)
    expect(denseEffects(DENSE_FUSE_DEFAULTS).agree).toMatch(/at least 2 other depth maps \(1 when there are only two\)/)
  })
})
