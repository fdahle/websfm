import { describe, it, expect } from 'vitest'
import { contoursEffects } from './contours.js'
import { CONTOUR_DEFAULTS } from '../defaults.user.js'

describe('contoursEffects', () => {
  const project = { interval: 5, levels: 22, max: 2000, zMin: 12.3, zMax: 120, unit: 'm', onMap: true, gsd: 0.5 }
  it('words the levels, the shape and where the lines go', () => {
    const e = contoursEffects(CONTOUR_DEFAULTS, project)
    expect(e.levels).toBe('22 levels every 5 m, between 12.3 and 120 m; one line in 5 is an index contour.')
    expect(e.shape).toBe(
      'Heights smoothed over about 2 cells first, so noise traces no rings; lines smoothed with 1 pass; ' +
        'lines shorter than 20 cells (10 m) are dropped.',
    )
    expect(contoursEffects({ ...CONTOUR_DEFAULTS, generalize: 0, minCells: 0, smooth: 0 }, project).shape).toBe(
      'Heights traced as they are, noise included; exact grid crossings; no line is dropped for length.',
    )
    expect(e.result).toBe('The lines go on the 2D map as a layer under Products.')
    expect(contoursEffects({ ...CONTOUR_DEFAULTS, format: 'dxf' }, { ...project, onMap: false }).result).toMatch(
      /downloaded as DXF\.$/,
    )
    expect(contoursEffects(CONTOUR_DEFAULTS, { ...project, levels: Infinity }).levels).toMatch(/too many levels/)
  })
})
