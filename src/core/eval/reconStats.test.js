import { describe, it, expect } from 'vitest'
import { trackLengthHistogram, reprojectionStats } from './reconStats.js'

// Identity camera at the origin looking down +z, K = { fx, fy, cx, cy }.
const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const cam = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K }

function makePoint(x, y, z, viewsMap, viewsPxMap) {
  return { x, y, z, views: viewsMap, viewsPx: viewsPxMap }
}

describe('trackLengthHistogram', () => {
  it('bins by view count with a stable 2..7 + 8+ axis', () => {
    const pts = [
      makePoint(0, 0, 1, new Map([['a', 0]])),                       // 1 view — ignored
      makePoint(0, 0, 1, new Map([['a', 0], ['b', 1]])),             // 2
      makePoint(0, 0, 1, new Map([['a', 0], ['b', 1], ['c', 2]])),   // 3
      makePoint(0, 0, 1, new Map(Array.from({ length: 9 }, (_, i) => [String(i), i]))), // 9 → 8+
    ]
    const h = trackLengthHistogram(pts)
    expect(h.map((b) => b.views)).toEqual([2, 3, 4, 5, 6, 7, '8+'])
    expect(h.find((b) => b.views === 2).count).toBe(1)
    expect(h.find((b) => b.views === 3).count).toBe(1)
    expect(h.find((b) => b.views === '8+').count).toBe(1)
    // Percentages over 3 tracked points (the 1-view point excluded).
    const total = h.reduce((a, b) => a + b.count, 0)
    expect(total).toBe(3)
    expect(h.find((b) => b.views === 2).pct).toBeCloseTo(100 / 3, 5)
  })

  it('handles empty input', () => {
    const h = trackLengthHistogram([])
    expect(h.every((b) => b.count === 0)).toBe(true)
    expect(h.every((b) => b.pct === 0)).toBe(true)
  })
})

describe('reprojectionStats', () => {
  it('measures a known residual', () => {
    // Point at (0,0,10) projects to (cx, cy) = (500, 400). Store an observation 3px off.
    const cams = new Map([['a', cam]])
    const pts = [makePoint(0, 0, 10, new Map([['a', 0]]), new Map([['a', [503, 404]]]))]
    const s = reprojectionStats(cams, pts)
    expect(s.n).toBe(1)
    expect(s.median).toBeCloseTo(5, 6) // hypot(3, 4)
    expect(s.max).toBeCloseTo(5, 6)
  })

  it('skips observations for absent cameras and points without viewsPx', () => {
    const cams = new Map([['a', cam]])
    const pts = [
      makePoint(0, 0, 10, new Map([['a', 0], ['ghost', 1]]),
        new Map([['a', [500, 400]], ['ghost', [0, 0]]])),   // ghost cam skipped
      makePoint(0, 0, 10, new Map([['a', 0]]), undefined),   // no viewsPx → skipped
    ]
    const s = reprojectionStats(cams, pts)
    expect(s.n).toBe(1)
    expect(s.median).toBeCloseTo(0, 6)
  })

  it('reports zeros/nulls on empty', () => {
    const s = reprojectionStats(new Map(), [])
    expect(s).toEqual({ n: 0, mean: null, median: null, p95: null, max: null })
  })
})
