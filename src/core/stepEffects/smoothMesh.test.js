import { describe, it, expect } from 'vitest'
import { smoothMeshEffects } from './smoothMesh.js'
import { SMOOTH_MESH_DEFAULTS } from '../defaults.user.js'

describe('smoothMeshEffects', () => {
  it('words the passes and weights', () => {
    expect(smoothMeshEffects(SMOOTH_MESH_DEFAULTS, { triangles: 1000 }).smooth).toMatch(
      /^10 passes over the 1,000 triangles, each smoothing \(λ 0\.5\) then re-inflating \(μ -0\.53\).*boundary stays/,
    )
    expect(smoothMeshEffects({ ...SMOOTH_MESH_DEFAULTS, mu: -0.2 }).smooth).toMatch(/^μ must be more negative/)
  })
})
