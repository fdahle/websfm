import { describe, it, expect } from 'vitest'

import { capOrder, capBoundary } from './keypointCap.js'

const kp = (scale, response) => ({ scale, response })

describe('capOrder', () => {
  const items = [
    kp(1.6, 0.90), // 0 fine, strongest
    kp(12.0, 0.02), // 1 coarse, weak
    kp(3.0, 0.50), // 2
    kp(25.0, 0.05), // 3 coarsest
    kp(1.8, 0.70), // 4 fine, strong
  ]

  it("'response' keeps the strongest, as the crate's own cap did", () => {
    expect(capOrder(items, 3, 'response')).toEqual([0, 4, 2])
  })

  it("'coarse-first' keeps the largest scales, returned strongest-first", () => {
    // Largest three scales are 3, 1, 2; best-first by response → 2, 3, 1.
    expect(capOrder(items, 3, 'coarse-first')).toEqual([2, 3, 1])
  })

  it('breaks a scale tie by response, so the cut octave keeps its strongest', () => {
    const tie = [kp(4, 0.1), kp(4, 0.3), kp(4, 0.2), kp(8, 0.01)]
    expect(capOrder(tie, 2, 'coarse-first')).toEqual([1, 3])
  })

  it('keeps everything, strongest-first, when the cap does not bind or is 0', () => {
    expect(capOrder(items, 0, 'coarse-first')).toEqual([0, 4, 2, 3, 1])
    expect(capOrder(items, 99, 'coarse-first')).toEqual([0, 4, 2, 3, 1])
  })

  it('keeps orientation siblings adjacent and in input order', () => {
    const sib = [kp(5, 0.4), kp(5, 0.4), kp(2, 0.9)]
    expect(capOrder(sib, 2, 'coarse-first')).toEqual([0, 1])
    expect(capOrder(sib, 3, 'coarse-first')).toEqual([2, 0, 1])
  })

  it('defaults to the response rule', () => {
    expect(capOrder(items, 2)).toEqual([0, 4])
  })
})

describe('capBoundary', () => {
  it('reports the weakest kept response and the smallest kept scale', () => {
    const items = [kp(1.6, 0.9), kp(12, 0.02), kp(3, 0.5)]
    expect(capBoundary(items, [1, 2])).toEqual({ minResponse: 0.02, minScale: 3 })
    expect(capBoundary(items, [])).toEqual({ minResponse: 0, minScale: 0 })
  })
})
