import { describe, it, expect } from 'vitest'
import { demEffects, orthoEffects, gridEffect, frameText } from './raster.js'
import { DEM_DEFAULTS, ORTHO_DEFAULTS } from '../defaults.user.js'

const estimate = { width: 2000, height: 1000, gsd: 0.05 }
const frame = frameText('project', { projectCrs: 'EPSG:32632' })

describe('gridEffect', () => {
  it('reads the size estimate, the frame and the extent', () => {
    expect(gridEffect({ estimate, unit: 'm/px', frame, extent: 'core' })).toBe(
      '2,000 × 1,000 px at 0.05 m/px in EPSG:32632, over the dense core.',
    )
    expect(gridEffect({ estimate: 'loading', unit: 'm/px', frame })).toMatch(/^Estimating/)
    expect(frameText('local', { hasScale: true })).toBe('the local frame (metres)')
  })
})

describe('demEffects', () => {
  const source = { kind: 'dense', name: 'Dense cloud', count: 6_000_000, streamed: false }
  it('names the points, the points per cell and what the fill does', () => {
    const e = demEffects(DEM_DEFAULTS, { source, estimate, unit: 'm/px', frame })
    expect(e.points).toMatch(/^6,000,000 points of the dense cloud "Dense cloud" go into the grid: every point/)
    expect(e.cell).toMatch(/^About 3 points per cell; each cell takes the median/)
    expect(e.fill).toMatch(/within 2 cells of a measured one are filled by inverse distance/)
    const sparse = demEffects(DEM_DEFAULTS, { source: { ...source, count: 1000 }, estimate, unit: 'm/px', frame })
    expect(sparse.cell).toMatch(/^About one point per 2,000 cells, so most cells are filled in step 4/)
    const even = demEffects(DEM_DEFAULTS, { source: { ...source, count: 1_900_000 }, estimate, unit: 'm/px', frame })
    expect(even.cell).toMatch(/^About 1 point per cell/)
    const ground = demEffects({ ...DEM_DEFAULTS, points: 'ground', fillMethod: 'none', fillHoles: true }, { source })
    expect(ground.points).toMatch(/ground class only/)
    expect(ground.fill).toMatch(/^Off: .*except the enclosed gaps/)
  })
})

describe('orthoEffects', () => {
  const surface = { id: 'dem', label: 'DEM', available: true, detail: '2000×1000 · EPSG:32632' }
  it('describes visibility, the mosaic and a cost limit the depth maps already applied', () => {
    const e = orthoEffects(ORTHO_DEFAULTS, { surface, estimate, unit: 'm/px', frame: null })
    expect(e.surface).toMatch(/^Every orthophoto cell takes its height from the DEM \(2000×1000/)
    expect(e.grid).toMatch(/on the DEM's frame\.$/)
    expect(e.visibility).toMatch(/within 2 % .*every matched pixel/)
    expect(e.blend).toMatch(/seams where neighbouring photos agree.*blended by frequency/)
    const capped = orthoEffects({ ...ORTHO_DEFAULTS, maxCost: 1 }, { surface, costCeiling: 0.9 })
    expect(capped.visibility).toMatch(/changes nothing: the depth maps already dropped every pixel above 0.9/)
    expect(orthoEffects(ORTHO_DEFAULTS, {}).surface).toMatch(/^No surface yet/)
  })
})
