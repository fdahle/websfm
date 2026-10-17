import { describe, it, expect } from 'vitest'
import { MAX_FLOAT64_XYZ_POINTS, isBufferAllocationFailure, tooManyPointsMessage } from './bufferLimit.js'
import { stageDemPoints } from './products/dem.js'

describe('the 2 GiB buffer wall', () => {
  it('recognises the engine refusing a buffer, and nothing else', () => {
    expect(isBufferAllocationFailure(new RangeError('Array buffer allocation failed'))).toBe(true)
    expect(isBufferAllocationFailure(new RangeError('Invalid typed array length: 4294967296'))).toBe(true)
    expect(isBufferAllocationFailure(new Error('Array buffer allocation failed'))).toBe(false)
    expect(isBufferAllocationFailure(new RangeError('Maximum call stack size exceeded'))).toBe(false)
  })

  it('says how large is too large', () => {
    expect(MAX_FLOAT64_XYZ_POINTS).toBe(89391104)
    expect(tooManyPointsMessage('This file', 95561841)).toMatch(/^This file \(95,561,841 points\) is too large to hold at once: .* about 89 million points/)
  })

  it('refuses a DEM copy past the wall before allocating it', () => {
    const cloud = { count: MAX_FLOAT64_XYZ_POINTS + 1, pos: new Float32Array(3) }
    expect(() => stageDemPoints(cloud, { budgetBytes: Infinity })).toThrow(/too large to hold at once/)
  })
})
