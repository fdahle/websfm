import { describe, it, expect } from 'vitest'
import { orthoNodataByte, rgbaToRgb, fillUncovered } from './orthoBands.js'

// Two pixels: covered (with a band equal to the NODATA value), then uncovered.
const rgba = () => new Uint8Array([0, 120, 255, 255, 9, 9, 9, 0])

describe('orthoNodataByte', () => {
  it('rounds and clamps to a byte', () => {
    expect(orthoNodataByte(12.6)).toBe(13)
    expect(orthoNodataByte(-5)).toBe(0)
    expect(orthoNodataByte(300)).toBe(255)
    expect(orthoNodataByte('')).toBe(0)
  })
})

describe('rgbaToRgb', () => {
  it('drops alpha, fills holes and keeps covered pixels off the NODATA value', () => {
    expect([...rgbaToRgb(rgba(), 0)]).toEqual([1, 120, 255, 0, 0, 0])
    expect([...rgbaToRgb(rgba(), 255)]).toEqual([0, 120, 254, 255, 255, 255])
  })
})

describe('fillUncovered', () => {
  it('fills holes with the NODATA value and makes every pixel opaque', () => {
    expect([...fillUncovered(rgba(), 0)]).toEqual([1, 120, 255, 255, 0, 0, 0, 255])
  })
})
