import { describe, it, expect } from 'vitest'
import { normalizeRegion, regionStatus, regionContains, regionMask, regionFromPositions } from './region.js'
import { positionsInRegion } from '../dense/sparseInput.js'

const box = { min: [0, 0, 0], max: [10, 5, 2], sourceStamp: { id: 's', createdAt: 7 } }

describe('region', () => {
  it('normalizes only a finite box with positive extent on every axis', () => {
    expect(normalizeRegion(box)).toMatchObject({ min: [0, 0, 0], max: [10, 5, 2] })
    expect(normalizeRegion({ min: [0, 0, 0], max: [1, 1, 0] })).toBeNull()
    expect(normalizeRegion({ min: [0, NaN, 0], max: [1, 1, 1] })).toBeNull()
    expect(normalizeRegion(null)).toBeNull()
  })

  it('is active only against the model it was drawn on (stamp = id + createdAt)', () => {
    expect(regionStatus(box, { id: 's', createdAt: 7 })).toEqual({ active: true, reason: null })
    expect(regionStatus(box, { id: 's', createdAt: 8 }).reason).toBe('stale')
    expect(regionStatus(box, null).reason).toBe('no-model')
    expect(regionStatus(null, { id: 's' }).reason).toBe('none')
    expect(
      regionStatus({ min: [0, 0, 0], max: [0, 1, 1], sourceStamp: box.sourceStamp }, { id: 's', createdAt: 7 }).reason,
    ).toBe('invalid')
  })

  it('tests containment inclusively and masks flat buffers and point objects', () => {
    expect(regionContains(box, 10, 5, 2)).toBe(true)
    expect(regionContains(box, 10.01, 5, 2)).toBe(false)
    const pos = Float64Array.from([1, 1, 1, 20, 1, 1, 5, 4, 0])
    const { keep, kept } = regionMask(pos, 3, box)
    expect([...keep]).toEqual([1, 0, 1])
    expect(kept).toBe(2)
    expect(positionsInRegion(Float64Array.from([1, 1, 1, -1, 0, 0]), box)).toEqual(Float64Array.from([1, 1, 1]))
  })

  it('fits a robust box that ignores a few strays', () => {
    const n = 1000,
      pos = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      pos[i * 3] = i % 100
      pos[i * 3 + 1] = (i * 7) % 50
      pos[i * 3 + 2] = (i % 10) / 10
    }
    pos.set([1e6, 1e6, 1e6], 0) // one far stray
    const r = regionFromPositions(pos, { quantile: 0.01, margin: 0 })
    expect(r.max[0]).toBeLessThan(100)
    expect(r.min[0]).toBeGreaterThanOrEqual(-1e-6)
    expect(r.max[2]).toBeLessThan(1)
  })

  it('keeps a tower above the 98th percentile of heights, not a lone stray', () => {
    // Ground 100 × 100 at z ≈ 0, a 60 m tower of 3 % of the points, one stray at 400.
    const pts = []
    for (let i = 0; i < 9700; i++) pts.push((i % 100) + 0.5, Math.floor(i / 100) + 0.5, (i % 7) * 0.01)
    for (let i = 0; i < 300; i++) pts.push(50, 50, (60 * i) / 299)
    pts.push(50, 50, 400)
    const r = regionFromPositions(Float64Array.from(pts), { margin: 0 })
    expect(r.max[2]).toBeCloseTo(60, 6)
    expect(r.min[0]).toBeLessThan(1)
    expect(r.max[0]).toBeGreaterThan(99)
  })
})
