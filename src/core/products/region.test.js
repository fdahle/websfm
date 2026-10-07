import { describe, it, expect } from 'vitest'
import { normalizeRegion, regionStatus, regionContains, regionMask, pointsInRegion, regionFromPositions } from './region.js'

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
    expect(regionStatus({ min: [0, 0, 0], max: [0, 1, 1], sourceStamp: box.sourceStamp }, { id: 's', createdAt: 7 }).reason).toBe('invalid')
  })

  it('tests containment inclusively and masks flat buffers and point objects', () => {
    expect(regionContains(box, 10, 5, 2)).toBe(true)
    expect(regionContains(box, 10.01, 5, 2)).toBe(false)
    const pos = Float64Array.from([1, 1, 1, 20, 1, 1, 5, 4, 0])
    const { keep, kept } = regionMask(pos, 3, box)
    expect([...keep]).toEqual([1, 0, 1])
    expect(kept).toBe(2)
    expect(pointsInRegion([{ x: 1, y: 1, z: 1 }, { x: -1, y: 0, z: 0 }], box)).toHaveLength(1)
  })

  it('fits a robust box that ignores a few strays', () => {
    const n = 1000, pos = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) { pos[i * 3] = i % 100; pos[i * 3 + 1] = (i * 7) % 50; pos[i * 3 + 2] = (i % 10) / 10 }
    pos.set([1e6, 1e6, 1e6], 0) // one far stray
    const r = regionFromPositions(pos, { quantile: 0.01, margin: 0 })
    expect(r.max[0]).toBeLessThan(100)
    expect(r.min[0]).toBeGreaterThanOrEqual(0)
    expect(r.max[2]).toBeLessThan(1)
  })
})
