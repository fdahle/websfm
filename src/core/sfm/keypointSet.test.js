import { describe, it, expect } from 'vitest'
import {
  keypointSetFrom, isKeypointSet, kpX, kpY, hasKp, kpColor, mapPositions, keypointSetTransfer,
} from './keypointSet.js'

describe('keypointSet', () => {
  it('packs positions and colours, and passes a set through unchanged', () => {
    const set = keypointSetFrom([{ x: 1.5, y: 2.25, color: [10, 20, 30] }, { x: 3, y: 4 }])
    expect(isKeypointSet(set)).toBe(true)
    expect(set.n).toBe(2)
    expect([kpX(set, 0), kpY(set, 0), kpX(set, 1), kpY(set, 1)]).toEqual([1.5, 2.25, 3, 4])
    expect(kpColor(set, 0)).toEqual([10, 20, 30])
    expect(kpColor(set, 1)).toBeNull() // no colour on that keypoint
    expect(keypointSetFrom(set)).toBe(set)
  })

  it('keeps full double precision', () => {
    const x = 1234.5678901234567
    expect(kpX(keypointSetFrom([{ x, y: 0 }]), 0)).toBe(x)
  })

  it('has no colour arrays when no keypoint has a colour', () => {
    const set = keypointSetFrom([{ x: 0, y: 0 }])
    expect(set.rgb).toBeNull()
    expect(set.hasColor).toBeNull()
    expect(kpColor(set, 0)).toBeNull()
    expect(keypointSetTransfer(set)).toEqual([set.xy.buffer])
  })

  it('treats missing slots and out-of-range indices as absent', () => {
    const set = keypointSetFrom([{ x: 1, y: 1 }, null])
    expect(hasKp(set, 0)).toBe(true)
    expect(hasKp(set, 1)).toBe(false)
    expect(hasKp(set, 2)).toBe(false)
    expect(hasKp(null, 0)).toBe(false)
  })

  it('maps positions into a NEW set, sharing colours and never writing the source', () => {
    const src = keypointSetFrom([{ x: 1, y: 2, color: [1, 2, 3] }, null])
    const before = Array.from(src.xy)
    const out = mapPositions(src, (x, y, k) => ({ x: x + 10 * (k + 1), y: -y }))
    expect(out).not.toBe(src)
    expect(out.xy).not.toBe(src.xy)
    expect(out.rgb).toBe(src.rgb)
    expect([kpX(out, 0), kpY(out, 0)]).toEqual([11, -2])
    expect(hasKp(out, 1)).toBe(false) // a missing keypoint stays missing
    expect(Array.from(src.xy)).toEqual(before)
  })
})
