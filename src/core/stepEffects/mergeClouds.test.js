import { describe, it, expect } from 'vitest'
import { mergeCloudsEffects } from './mergeClouds.js'

describe('mergeCloudsEffects', () => {
  it('counts the clouds and words the overlap cell', () => {
    const chosen = [{ count: 1000 }, { count: 2500 }]
    expect(mergeCloudsEffects({ cell: 0 }, { chosen }).join).toMatch(/^2 clouds, 3,500 points/)
    expect(mergeCloudsEffects({ cell: 0 }, { chosen, mergeCell: 0.05 }).overlap).toMatch(/^Off \(0\).*0\.05 units/)
    expect(mergeCloudsEffects({ cell: 0.1 }, { chosen }).overlap).toMatch(/per cell of 0\.1 units/)
    expect(mergeCloudsEffects({ cell: 0 }, { chosen: [{ count: 1 }] }).join).toMatch(/^Pick at least two/)
  })
})
