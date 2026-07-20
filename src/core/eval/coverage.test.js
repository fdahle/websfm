import { describe, it, expect } from 'vitest'
import { coverageGrid } from './coverage.js'

const mv = (n) => ({ size: n })   // stand-in for a `views` Map with n entries

describe('coverageGrid', () => {
  it('handles the empty case without dividing by zero', () => {
    const g = coverageGrid([], [{ x: 1, y: 2 }])
    expect(g.cols).toBe(0)
    expect(g.rows).toBe(0)
    expect(g.maxCount).toBe(0)
    expect(g.cams).toEqual([{ x: 1, y: 2 }])
  })

  it('bins points into a grid and tracks count + max views per cell', () => {
    // A 2-cell strip: cluster near x=0 and near x=10.
    const pts = [
      { x: 0, y: 0, views: mv(2) },
      { x: 0.1, y: 0.1, views: mv(4) },
      { x: 10, y: 0, views: mv(3) },
    ]
    const g = coverageGrid(pts, [{ x: 5, y: 0 }], { targetCells: 10 })
    expect(g.cols).toBeGreaterThan(1)
    // Total binned points == input count.
    let total = 0
    for (const c of g.count) total += c
    expect(total).toBe(3)
    // The densest cell holds the two clustered points; its max view count is 4.
    expect(g.maxCount).toBe(2)
    expect(Math.max(...g.maxViews)).toBe(4)
    expect(g.bbox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0.1 })
  })

  it('clamps edge points into the last cell (no out-of-range index)', () => {
    const g = coverageGrid([{ x: 0, y: 0 }, { x: 1, y: 1 }], [], { targetCells: 4 })
    let total = 0
    for (const c of g.count) total += c
    expect(total).toBe(2)
  })
})
