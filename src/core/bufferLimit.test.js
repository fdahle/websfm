import { describe, it, expect } from 'vitest'
import {
  MAX_FLOAT64_XYZ_POINTS,
  isBufferAllocationFailure,
  bufferFailureText,
  rasterTooLargeMessage,
  tooManyPointsMessage,
} from './bufferLimit.js'
import { stageDemPoints } from './products/dem.js'

describe('the 2 GiB buffer wall', () => {
  it('recognises the engine refusing a buffer, and nothing else', () => {
    expect(isBufferAllocationFailure(new RangeError('Array buffer allocation failed'))).toBe(true)
    expect(isBufferAllocationFailure(new RangeError('Invalid typed array length: 4294967296'))).toBe(true)
    expect(isBufferAllocationFailure(new Error('Array buffer allocation failed'))).toBe(false)
    expect(isBufferAllocationFailure(new RangeError('Maximum call stack size exceeded'))).toBe(false)
  })

  it('explains a refused buffer, also when Chrome reports it as an unreadable file', () => {
    const remedy = 'Lower the memory budget'
    expect(bufferFailureText('Array buffer allocation failed', remedy)).toMatch(
      /^Array buffer allocation failed — the browser tab ran out of buffer memory .* Lower the memory budget$/,
    )
    // The message a Blob/File read gets on a full pool (Chrome's NotReadableError).
    const notReadable =
      'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.'
    expect(bufferFailureText(notReadable, remedy)).toMatch(
      /acquired\. — almost certainly not a permission problem: the browser tab ran out of buffer memory/,
    )
    expect(bufferFailureText('Corrupt depth map abc; recompute depth maps', remedy)).toBe(
      'Corrupt depth map abc; recompute depth maps',
    )
  })

  it('says how large is too large', () => {
    expect(MAX_FLOAT64_XYZ_POINTS).toBe(89391104)
    expect(tooManyPointsMessage('This file', 95561841)).toMatch(
      /^This file \(95,561,841 points\) is too large to hold at once: .* about 89 million points/,
    )
  })

  it('names the size and the way out for a raster past the wall (a REMA 2 m tile)', () => {
    expect(rasterTooLargeMessage('09_38_2m.tif', 25100, 25100)).toMatch(
      /^09_38_2m\.tif is 25,100 × 25,100 cells: .* needs 2\.52 GB in one buffer, .*\(about 23,159 × 23,159 cells\)\. Import a coarser or cropped copy/,
    )
  })

  it('refuses a DEM copy past the wall before allocating it', () => {
    const cloud = { count: MAX_FLOAT64_XYZ_POINTS + 1, pos: new Float32Array(3) }
    expect(() => stageDemPoints(cloud, { budgetBytes: Infinity })).toThrow(/too large to hold at once/)
  })
})
