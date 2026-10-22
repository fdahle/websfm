import { describe, it, expect } from 'vitest'
import { meshEffects } from './mesh.js'
import { MESH_DEFAULTS } from '../defaults.user.js'

const source = { name: 'Dense cloud', count: 2_500_000 }

describe('meshEffects', () => {
  it('follows the cleanup order and what each switch leaves', () => {
    const e = meshEffects(MESH_DEFAULTS, { source })
    expect(e.solve).toMatch(/^Screened Poisson over the 2,500,000 points of "Dense cloud", at octree depth/)
    expect(e.trim).toMatch(/^Surface no points support is removed/)
    const off = meshEffects({ ...MESH_DEFAULTS, trim: 'off', distanceTrim: 3, removeFloaters: false }, { source })
    expect(off.trim).toMatch(/^Off: .*except triangles farther than 3 sample spacings/)
    expect(off.holes).toMatch(/^Not used/)
    expect(off.floaters).toMatch(/^Off/)
    expect(meshEffects(MESH_DEFAULTS).solve).toMatch(/^No dense cloud/)
  })
})
