import { describe, it, expect } from 'vitest'
import { cleanMeshEffects } from './cleanMesh.js'
import { CLEAN_MESH_DEFAULTS } from '../defaults.user.js'

describe('cleanMeshEffects', () => {
  it('words every step of the chain', () => {
    const e = cleanMeshEffects(CLEAN_MESH_DEFAULTS)
    expect(e.pieces).toMatch(/fewer than 0\.01 × the largest piece’s triangles, or fewer than 50/)
    expect(e.bridges).toMatch(/longer than 6 × the median edge/)
    expect(e.holes).toBe('Holes ringed by up to 64 edges are closed.')
    expect(cleanMeshEffects({ ...CLEAN_MESH_DEFAULTS, maxHoleEdges: 0 }, { textured: true }).holes).toMatch(
      /watertight; the result has no texture/,
    )
    expect(cleanMeshEffects({ ...CLEAN_MESH_DEFAULTS, methods: [] }).weld).toMatch(/^Off/)
  })
})
