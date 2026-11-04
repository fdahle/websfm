import { describe, it, expect } from 'vitest'
import { demHoldExtent, buildDemHoldGrid, demHoldSampler } from './demHoldGrid.js'

describe('demHoldGrid', () => {
  it('covers the places the run knows, with a margin', () => {
    const e = demHoldExtent([
      [100, 200],
      [500, 300],
      [NaN, 0],
    ])
    expect(e).toEqual({ x0: -100, y0: 0, x1: 700, y1: 500 })
    expect(demHoldExtent([[10, 10]], { minMargin: 30 })).toEqual({ x0: -20, y0: -20, x1: 40, y1: 40 })
    expect(demHoldExtent([])).toBeNull()
  })

  it('samples a plane exactly and leaves holes out', () => {
    const plane = (x, y) => 100 + 0.1 * x - 0.05 * y
    const grid = buildDemHoldGrid({ x0: 0, y0: 0, x1: 200, y1: 100 }, (x, y) => (x > 150 ? NaN : plane(x, y)), {
      maxSide: 41,
    })
    expect(grid.dx).toBe(5)
    expect(grid.w).toBe(41)
    expect(grid.h).toBe(21)
    const at = demHoldSampler(grid)
    expect(at(37.3, 61.9)).toBeCloseTo(plane(37.3, 61.9), 4)
    expect(at(0, 0)).toBeCloseTo(100, 6)
    // Next to the hole, outside the grid.
    expect(at(152, 50)).toBeNaN()
    expect(at(-1, 50)).toBeNaN()
    expect(at(50, 101)).toBeNaN()
    expect(grid.valid).toBe(31 * 21)
  })
})
