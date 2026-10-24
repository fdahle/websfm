import { describe, it, expect } from 'vitest'
import { contoursEffects } from './contours.js'
import { CONTOUR_DEFAULTS } from '../defaults.user.js'

describe('contoursEffects', () => {
  const project = { interval: 5, levels: 22, max: 2000, zMin: 12.3, zMax: 120, unit: 'm', onMap: true }
  it('words the levels, the shape and where the lines go', () => {
    const e = contoursEffects(CONTOUR_DEFAULTS, project)
    expect(e.levels).toBe('22 levels every 5 m, between 12.3 and 120 m; one line in 5 is an index contour.')
    expect(e.shape).toBe('Smoothed with 1 pass; no line is dropped for length.')
    expect(e.result).toBe('The lines go on the 2D map as a layer under Products.')
    expect(contoursEffects({ ...CONTOUR_DEFAULTS, format: 'dxf' }, { ...project, onMap: false }).result).toMatch(
      /downloaded as DXF\.$/,
    )
    expect(contoursEffects(CONTOUR_DEFAULTS, { ...project, levels: Infinity }).levels).toMatch(/too many levels/)
  })
})
