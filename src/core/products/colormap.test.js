import { describe, it, expect } from 'vitest'
import { depthColor } from './colormap.js'

describe('depthColor', () => {
  it('is blue-dominant at t=0', () => {
    const [r, g, b] = depthColor(0)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('is green-dominant in the middle', () => {
    const [r, g, b] = depthColor(0.5)
    expect(g).toBe(255)
    expect(g).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(b)
  })

  it('is red-dominant at t=1', () => {
    const [r, g, b] = depthColor(1)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })

  it('keeps every channel within [0,255]', () => {
    for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      for (const c of depthColor(t)) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })

  it('moves red up and blue down across the ramp', () => {
    const lo = depthColor(0.1)
    const hi = depthColor(0.9)
    expect(hi[0]).toBeGreaterThan(lo[0]) // red increases
    expect(hi[2]).toBeLessThan(lo[2])    // blue decreases
  })
})
