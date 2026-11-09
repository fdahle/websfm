import { describe, it, expect } from 'vitest'
import { meshEffects, meshShorts, fmtTriangles } from './mesh.js'
import { MESH_DEFAULTS, MESH_PRESETS } from '../defaults.user.js'
import { autoMeshDepth } from '../products/mesh.js'
import { SHORT_MAX } from './format.js'

const source = { name: 'Dense cloud', count: 2_500_000 }

describe('meshEffects', () => {
  it('follows the cleanup order and what each switch leaves', () => {
    const e = meshEffects(MESH_DEFAULTS, { source })
    expect(e.solve).toMatch(
      /^Screened Poisson over the 2,500,000 points of "Dense cloud", at the octree depth for leaves of about 8/,
    )
    expect(e.trim).toMatch(/^Surface no points support is removed/)
    const off = meshEffects({ ...MESH_DEFAULTS, trim: 'off', distanceTrim: 3, removeFloaters: false }, { source })
    expect(off.trim).toMatch(/^Off: .*except triangles farther than 3 sample spacings/)
    expect(off.holes).toMatch(/^Not used/)
    expect(off.floaters).toMatch(/^Off/)
    expect(meshEffects(MESH_DEFAULTS).solve).toMatch(/^No dense cloud/)
    expect(e.solve).toMatch(/In tiles, welded at their seams, if one solve would not fit/)
    expect(meshEffects({ ...MESH_DEFAULTS, tiles: 'off' }, { source }).solve).toMatch(/Always in one piece/)
  })
})

describe('mesh depth in the effect line', () => {
  // 4096 / (8 · 1) = 512 = 2^9 wanted; the triangle limit decides from there.
  const basis = { count: 4096 ** 2, spacing: 1, extent: 4096 }
  it('names the depth Auto picks and why, as the run picks it', () => {
    const auto = autoMeshDepth(basis, MESH_DEFAULTS)
    const e = meshEffects(MESH_DEFAULTS, { source, basis })
    expect(e.solve).toContain(`at octree depth ${auto.depth} (`)
    expect(e.solve).toContain(`about ${fmtTriangles(auto.triangles)} triangles`)
    expect(e.solve).toMatch(auto.limit === 'triangles' ? /the most detail within 1 M triangles/ : /leaves of about 8/)
    expect(meshShorts(MESH_DEFAULTS, { source, basis }).solve).toBe(
      `depth ${auto.depth} (auto) · ≈ ${fmtTriangles(auto.triangles)} triangles`,
    )
  })
  it('says the run picks it when the spacing is unknown (an imported cloud)', () => {
    const e = meshEffects(MESH_DEFAULTS, { source, basis: { ...basis, spacing: 0 } })
    expect(e.solve).toMatch(/picked from the cloud when it runs/)
    expect(meshShorts(MESH_DEFAULTS, { source }).solve).toBe('auto depth · ≤ 1 M triangles')
  })
  it('warns of the memory a large fixed depth needs', () => {
    const e = meshEffects({ ...MESH_DEFAULTS, depth: 12 }, { source, basis })
    expect(e.solve).toMatch(/^Screened Poisson .* at octree depth 12 \(/)
    expect(e.solve).toMatch(/more memory than a browser tab has/)
    expect(meshEffects({ ...MESH_DEFAULTS, depth: 7 }, { source, basis }).solve).not.toMatch(/memory than/)
  })
  it("keeps every card's short fact within SHORT_MAX", () => {
    for (const p of Object.values(MESH_PRESETS)) {
      for (const b of [basis, null]) {
        expect(meshShorts({ ...MESH_DEFAULTS, ...p }, { source, basis: b }).solve.length).toBeLessThanOrEqual(SHORT_MAX)
      }
    }
  })
  it('formats triangle counts as people say them', () => {
    expect(fmtTriangles(650_400)).toBe('650 k')
    expect(fmtTriangles(2_812_358)).toBe('2.8 M')
    expect(fmtTriangles(1_000_000)).toBe('1 M')
    expect(fmtTriangles(512)).toBe('512')
  })
})
