import { describe, it, expect } from 'vitest'
import { decimateMeshEffects } from './decimateMesh.js'
import { DECIMATE_MESH_DEFAULTS } from '../defaults.user.js'

describe('decimateMeshEffects', () => {
  it('words the reduction', () => {
    expect(decimateMeshEffects(DECIMATE_MESH_DEFAULTS, { triangles: 2e6, target: 5e5 }).collapse).toMatch(
      /^2,000,000 → about 500,000 triangles \(25 %\).*boundary is kept/,
    )
    expect(decimateMeshEffects(DECIMATE_MESH_DEFAULTS, { triangles: 100, target: 100 }).collapse).toMatch(
      /^The target must be below/,
    )
  })
})
