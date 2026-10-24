import { describe, it, expect } from 'vitest'
import { filterCloudEffects } from './filterCloud.js'
import { FILTER_CLOUD_DEFAULTS } from '../defaults.user.js'

describe('filterCloudEffects', () => {
  it('describes each enabled filter, and says Off for the rest', () => {
    const e = filterCloudEffects(FILTER_CLOUD_DEFAULTS)
    expect(e.sor).toMatch(/its 12 nearest neighbours is more than 1\.5 σ/)
    expect(e.range).toMatch(/^Off/)
    expect(e.voxel).toMatch(/^Off/)
    expect(e.isolated).toMatch(/^Off/)
  })
  it('words the range bounds and the auto cells', () => {
    const s = { ...FILTER_CLOUD_DEFAULTS, methods: ['range', 'voxel', 'isolated'], zMin: 10, lumaMax: 200 }
    const e = filterCloudEffects(s, { mergeCell: 0.05 })
    expect(e.range).toBe('Points are kept with elevation at least 10 and brightness at most 200; the rest are removed.')
    expect(e.voxel).toMatch(/cell of 0\.05 units, the dense run’s merge cell/)
    expect(e.isolated).toMatch(/^On a grid of about 4 point spacings/)
    expect(filterCloudEffects({ ...s, zMin: null, lumaMax: null }).range).toMatch(/^No limit entered yet/)
  })
})
