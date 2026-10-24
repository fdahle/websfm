import { describe, it, expect } from 'vitest'
import { sampleMeshEffects } from './sampleMesh.js'
import { SAMPLE_MESH_DEFAULTS } from '../defaults.user.js'

describe('sampleMeshEffects', () => {
  it('words the sample count', () => {
    expect(sampleMeshEffects(SAMPLE_MESH_DEFAULTS, { triangles: 2 }).sample).toMatch(
      /^1,000,000 points, spread by area over the 2 triangles/,
    )
  })
})
