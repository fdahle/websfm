import { describe, it, expect } from 'vitest'
import { SparsePoints } from './sparsePoints.js'

// Three points: p0 seen by a, b (pixels); p1 by b, c (c without a pixel); p2 by a only,
// no colour.
const records = () => [
  { x: 1, y: 2, z: 3, color: [10, 20, 30], views: [['a', 5, 100, 200], ['b', 7, 110, 210]] },
  { x: 4, y: 5, z: 6, color: [0, 0, 0], views: new Map([['b', 8], ['c', 9]]), viewsPx: new Map([['b', [120, 220]]]) },
  { x: 7, y: 8, z: 9, views: [['a', 1, 130, 230]] },
]

describe('SparsePoints', () => {
  it('reads positions, colour and tracks from columns', () => {
    const p = SparsePoints.fromRecords(records())
    expect(p.length).toBe(3)
    expect(p.viewTotal).toBe(5)
    expect(p.xyz(1)).toEqual([4, 5, 6])
    // One scratch record per iterator: read it during iteration.
    const zs = []
    for (const q of p) zs.push(q.z)
    expect(zs).toEqual([3, 6, 9])
    // Black is a colour; a point without one is null, not black.
    expect(p.colorAt(1)).toEqual([0, 0, 0])
    expect(p.colorAt(2)).toBeNull()
    expect(p.hasColorAt(2)).toBe(false)
    const views = []
    p.forEachView(1, (u, kp, x, y) => views.push([u, kp, x, y]))
    expect(views).toEqual([['b', 8, 120, 220], ['c', 9, NaN, NaN]])
    expect(p.pixelCount(1)).toBe(1)
    expect(p.kpOf(0, 'b')).toBe(7)
    expect(p.pixelOf(1, 'c')).toBeUndefined()
    expect(p.pixelOf(0, 'a')).toEqual([100, 200])
    expect(p.hasPixels).toBe(true)
  })

  it('indexes the views per camera in point order', () => {
    const p = SparsePoints.fromRecords(records())
    const seen = []
    p.forEachPointOf('a', (i, k) => seen.push([i, p.vkp[k]]))
    expect(seen).toEqual([[0, 5], [2, 1]])
    p.forEachPointOf('nobody', () => { throw new Error('no views expected') })
  })

  it('selects points with new positions and moved pixels, leaving the source untouched', () => {
    const p = SparsePoints.fromRecords(records())
    const q = p.select(Uint32Array.of(2, 0), {
      pos: Float64Array.of(70, 80, 90, 10, 20, 30),
      pixel: (u, x, y) => (u === 'a' ? [x + 1, y + 1] : null),
    })
    expect(q.length).toBe(2)
    expect(q.xyz(0)).toEqual([70, 80, 90])
    expect(q.colorAt(0)).toBeNull()
    expect(q.colorAt(1)).toEqual([10, 20, 30])
    expect(q.pixelOf(0, 'a')).toEqual([131, 231])
    expect(q.pixelOf(1, 'b')).toEqual([110, 210])
    expect(p.pixelOf(2, 'a')).toEqual([130, 230])
    expect(p.xyz(0)).toEqual([1, 2, 3])
  })

  it('concatenates clouds onto one camera list', () => {
    const p = SparsePoints.fromRecords(records())
    const other = SparsePoints.fromRecords([{ x: 0, y: 0, z: 1, views: [['d', 3], ['a', 4]] }])
    const all = SparsePoints.concat([p, other])
    expect(all.length).toBe(4)
    expect(all.viewUuids).toEqual(['a', 'b', 'c', 'd'])
    const views = []
    all.forEachView(3, (u, kp, x) => views.push([u, kp, x]))
    expect(views).toEqual([['d', 3, NaN], ['a', 4, NaN]])
    expect(all.colorAt(3)).toBeNull()
    expect(all.colorAt(0)).toEqual([10, 20, 30])
  })

  it('gives the writers a flat copy with colourless points grey', () => {
    const p = SparsePoints.fromRecords(records())
    const flat = p.flatCopy()
    expect(flat.count).toBe(3)
    expect(Array.from(flat.col)).toEqual([10, 20, 30, 0, 0, 0, 200, 200, 200])
    flat.pos[0] = 99
    expect(p.x(0)).toBe(1)
  })

  it('handles an empty cloud', () => {
    const p = SparsePoints.empty()
    expect(p.length).toBe(0)
    expect(p.hasColor).toBe(false)
    expect(p.hasPixels).toBe(false)
    expect([...p]).toEqual([])
    expect(SparsePoints.concat([p, p]).length).toBe(0)
  })
})
