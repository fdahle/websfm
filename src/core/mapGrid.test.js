import { describe, it, expect } from 'vitest'
import { computeGrid, formatGridLabel, gridUnitFor, gridViewKey, niceGridSpacing, GRID_MAX_LINES } from './mapGrid.js'

describe('niceGridSpacing', () => {
  it('rounds up to 1/2/5 × 10ⁿ', () => {
    expect(niceGridSpacing(1)).toBe(1)
    expect(niceGridSpacing(1.2)).toBe(2)
    expect(niceGridSpacing(3)).toBe(5)
    expect(niceGridSpacing(7)).toBe(10)
    expect(niceGridSpacing(150)).toBe(200)
    expect(niceGridSpacing(15000)).toBe(20000)
    expect(niceGridSpacing(0.03)).toBeCloseTo(0.05, 12)
  })

  it('falls back to 1 for a non-positive or missing target', () => {
    expect(niceGridSpacing(0)).toBe(1)
    expect(niceGridSpacing(-5)).toBe(1)
    expect(niceGridSpacing(NaN)).toBe(1)
    expect(niceGridSpacing(undefined)).toBe(1)
  })
})

describe('formatGridLabel', () => {
  it('prints the full coordinate in the CRS unit, grouped, no decimals at ≥ 1 unit spacing', () => {
    expect(formatGridLabel(-1300000, 10000, 'E', 'm')).toBe('E -1,300,000 m')
    expect(formatGridLabel(2500, 500, 'N', 'ft')).toBe('N 2,500 ft')
  })

  it('adds just enough decimals for a sub-unit spacing (max 3)', () => {
    expect(formatGridLabel(1.5, 0.5, 'X', 'm')).toBe('X 1.5 m')
    expect(formatGridLabel(0.25, 0.05, 'Y', 'm')).toBe('Y 0.25 m')
    expect(formatGridLabel(0.0002, 0.0001, 'X', 'm')).toBe('X 0.000 m')
  })
})

describe('gridUnitFor', () => {
  it("prefers the frame's own unit (the model frame)", () => {
    expect(gridUnitFor({ gridUnit: 'model units' }, 'm')).toBe('model units')
  })
  it("uses the projection's unit, US feet as 'ft', metres by default", () => {
    expect(gridUnitFor({}, 'm')).toBe('m')
    expect(gridUnitFor({}, 'us-ft')).toBe('ft')
    expect(gridUnitFor({}, 'ft')).toBe('ft')
    expect(gridUnitFor({}, undefined)).toBe('m')
  })
})

describe('gridViewKey', () => {
  it('changes with centre, resolution and size', () => {
    const k = gridViewKey([1, 2], 10, [800, 600])
    expect(gridViewKey([1, 2], 10, [800, 600])).toBe(k)
    expect(gridViewKey([1, 3], 10, [800, 600])).not.toBe(k)
    expect(gridViewKey([1, 2], 11, [800, 600])).not.toBe(k)
    expect(gridViewKey([1, 2], 10, [800, 601])).not.toBe(k)
  })
})

describe('computeGrid', () => {
  // 1000 × 500 px view at 100 m/px → 100 km × 50 km, spacing ≥ 15 km → 20 km.
  const view = { viewExtent: [0, 0, 100000, 50000], resolution: 100, size: [1000, 500], validExtent: null }

  it('draws round lines across the 10 %-buffered view', () => {
    const g = computeGrid(view)
    expect(g.spacing).toBe(20000)
    // Buffer = max(1000, 500) px × 100 m × 0.1 = 10 km on every side.
    expect(g.bounds).toEqual([-10000, -10000, 110000, 60000])
    // ceil(-0.5) is -0; the origin line must still read "E 0 m".
    expect(Object.is(g.xs[0], 0)).toBe(true)
    expect(formatGridLabel(g.xs[0], g.spacing, 'E', 'm')).toBe('E 0 m')
    expect(g.xs).toEqual([0, 20000, 40000, 60000, 80000, 100000])
    expect(g.ys).toEqual([0, 20000, 40000, 60000])
  })

  it('pins labels to the visible edge, two pixels in — not the buffered one', () => {
    const g = computeGrid(view)
    expect(g.labelX).toBe(200)
    expect(g.labelY).toBe(200)
  })

  it('clips to the CRS validity extent and keeps labels inside it', () => {
    const g = computeGrid({ ...view, validExtent: [30000, 10000, 70000, 40000] })
    expect(g.bounds).toEqual([30000, 10000, 70000, 40000])
    expect(g.xs).toEqual([40000, 60000])
    expect(g.ys).toEqual([20000, 40000])
    expect(g.labelX).toBe(30200)
    expect(g.labelY).toBe(10200)
  })

  it('returns null when the view lies outside the validity extent', () => {
    expect(computeGrid({ ...view, validExtent: [500000, 500000, 600000, 600000] })).toBeNull()
  })

  it('caps the line count per axis', () => {
    // A resolution that disagrees wildly with the extent (stale) would otherwise
    // ask for millions of lines.
    const g = computeGrid({ viewExtent: [0, 0, 1e9, 1e9], resolution: 0.01, size: [100, 100], validExtent: null })
    expect(g.xs).toHaveLength(GRID_MAX_LINES)
    expect(g.ys).toHaveLength(GRID_MAX_LINES)
  })

  it('accumulates line positions (the values the map always drew)', () => {
    const g = computeGrid({ viewExtent: [0, 0, 1, 1], resolution: 0.001, size: [1000, 1000], validExtent: null })
    expect(g.spacing).toBeCloseTo(0.2, 12)
    let x = Math.ceil(g.bounds[0] / g.spacing) * g.spacing + 0
    for (const v of g.xs) {
      expect(v).toBe(x)
      x += g.spacing
    }
  })
})
