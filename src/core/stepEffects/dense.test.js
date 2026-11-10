import { describe, it, expect } from 'vitest'
import { denseEffects, denseShorts } from './dense.js'
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

  it('says where a point sits, and what Auto chose by scene type', () => {
    const d = DENSE_FUSE_DEFAULTS
    expect(denseEffects(d, { maps: 42, sceneType: 'aerial' }).agree).toMatch(
      /mean depth of its own map and the agreeing ones.*\(Auto, an aerial \/ mapping project\)\.$/,
    )
    expect(denseEffects(d, { maps: 42, sceneType: 'object' }).agree).toMatch(
      /keeps its own depth map's depth \(Auto, an object capture project\)\.$/,
    )
    expect(denseEffects({ ...d, position: 'mean' }, { maps: 42, sceneType: 'object' }).agree).toMatch(/noise\.$/)
    expect(denseShorts(d, { maps: 42, sceneType: 'aerial' }).agree).toBe('≥ 2 views · 1 % · mean')
    expect(denseShorts(d, { maps: 42, sceneType: 'object' }).agree).toBe('≥ 2 views · 1 % · own depth')
  })
})
